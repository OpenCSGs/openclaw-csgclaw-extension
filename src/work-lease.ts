import type { ResolvedCsgclawAccount } from "./config.js";
import { workLeaseUrl } from "./config.js";

const DEFAULT_TTL_SECONDS = 15;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;
const LEGACY_SERVER_PAUSE_MS = 5 * 60_000;
const DEFAULT_STATUS_INTERVAL_MS = 250;
const MAX_THINKING_BYTES = 16 * 1024;
const WORK_CAPABILITIES = ["thinking_status_v1", "turn_stop_v1"] as const;
const WORK_STAGE_CAPABILITY = "work_stage_v1" as const;

type WorkLeaseLog = {
  debug?: (message: string) => void;
  error?: (message: string) => void;
  warn?: (message: string) => void;
};

export type CsgclawWorkLeaseReporterOptions = {
  account: ResolvedCsgclawAccount;
  fetchImpl?: typeof fetch;
  leaseId: string;
  log?: WorkLeaseLog;
  now?: () => number;
  participantId: string;
  requestTimeoutMs?: number;
  statusIntervalMs?: number;
  requestId: string;
  roomId: string;
  threadRootId?: string;
  ttlSeconds?: number;
};

export type WorkLeaseStage =
  | "preparing_reply"
  | "thinking"
  | "running_tool"
  | "processing_tool_result"
  | "generating_reply";

export type WorkLeaseStatus =
  | { phase: "working"; stage?: "running_tool" | "generating_reply" }
  | {
      phase: "thinking";
      stage?: "preparing_reply" | "thinking" | "processing_tool_result";
      thinking?: {
        format?: "plain_text";
        text: string;
        truncated?: boolean;
      };
    };

export type WorkLeaseCompletionOutcome = "released" | "stopped";

export type CsgclawWorkLeaseReporter = {
  startOrRenew: () => Promise<void>;
  updateStatus: (status: WorkLeaseStatus) => Promise<void>;
  stop: (outcome?: WorkLeaseCompletionOutcome) => Promise<void>;
  onStopRequested: (listener: () => void) => () => void;
};

export type CsgclawWorkLeaseDispatchOptions<T> = {
  dispatch: () => Promise<T>;
  log?: WorkLeaseLog;
  renewIntervalMs?: number;
  reporter: CsgclawWorkLeaseReporter;
  completionOutcome?: () => WorkLeaseCompletionOutcome;
};

const unsupportedUntilByAccount = new Map<string, number>();
const unsupportedStatusUntilByAccount = new Map<string, number>();
const unsupportedStageUntilByAccount = new Map<string, number>();

type WorkLeaseHTTPResponse = {
  body?: Record<string, unknown>;
  ok: boolean;
  status: number;
};

export function createCsgclawWorkLeaseReporter(options: CsgclawWorkLeaseReporterOptions): CsgclawWorkLeaseReporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const statusIntervalMs = Math.max(1, options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const breakerKey = workLeaseAccountKey(options.account, options.participantId);
  let closed = false;
  let leaseStarted = false;
  let putController: AbortController | undefined;
  let putInFlight = false;
  let patchController: AbortController | undefined;
  let patchInFlight = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let statusVersion = 0;
  let attemptedStatusVersion = 0;
  let statusSequence = 0;
  let latestStatus: WorkLeaseStatus | undefined;
  let lastPatchStartedAt = 0;
  let stageCapabilityAdvertised = false;
  let stopNotified = false;
  const stopListeners = new Set<() => void>();

  const pauseForUnsupportedServer = (status: number) => {
    const currentPause = unsupportedUntilByAccount.get(breakerKey) ?? 0;
    if (currentPause <= now()) {
      options.log?.warn?.(
        `csgclaw: work lease API unavailable; pausing reporter for 5 minutes status=${status} account=${options.account.accountId} participant_id=${options.participantId}`,
      );
    }
    unsupportedUntilByAccount.set(breakerKey, now() + LEGACY_SERVER_PAUSE_MS);
  };

  const request = async (
    method: "PUT" | "PATCH" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<WorkLeaseHTTPResponse | null> => {
    const controller = new AbortController();
    if (method === "PUT") {
      putController = controller;
    } else if (method === "PATCH") {
      patchController = controller;
    }
    const timeout = setTimeout(() => controller.abort(new Error("work lease request timed out")), requestTimeoutMs);
    const headers: Record<string, string> = {};
    if (body) {
      headers["Content-Type"] = "application/json";
    }
    if (options.account.accessToken) {
      headers.Authorization = `Bearer ${options.account.accessToken}`;
    }
    try {
      const response = await fetchImpl(workLeaseUrl(options.account, options.leaseId), {
        body: body ? JSON.stringify(body) : undefined,
        headers,
        method,
        signal: controller.signal,
      });
      const responseText = await response.text().catch(() => "");
      let responseBody: Record<string, unknown> | undefined;
      if (responseText.trim()) {
        try {
          const parsed = JSON.parse(responseText) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            responseBody = parsed as Record<string, unknown>;
          }
        } catch {
          // Work status responses are optional for old servers.
        }
      }
      return { body: responseBody, ok: response.ok, status: response.status };
    } catch (error) {
      if (!(closed && method !== "DELETE" && controller.signal.aborted)) {
        options.log?.warn?.(
          `csgclaw: work lease request failed method=${method} lease_id=${options.leaseId} error=${formatWorkLeaseError(error)}`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
      if (method === "PUT" && putController === controller) {
        putController = undefined;
      } else if (method === "PATCH" && patchController === controller) {
        patchController = undefined;
      }
    }
  };

  const notifyStopRequested = (response: WorkLeaseHTTPResponse) => {
    const stopState = response.body?.stop_state ?? response.body?.state;
    if (
      stopNotified ||
      typeof response.body?.stop_requested_at !== "string" ||
      (stopState !== undefined && stopState !== "stop_requested")
    ) {
      return;
    }
    stopNotified = true;
    for (const listener of stopListeners) {
      try {
        listener();
      } catch (error) {
        options.log?.warn?.(
          `csgclaw: work lease stop listener failed lease_id=${options.leaseId} error=${formatWorkLeaseError(error)}`,
        );
      }
    }
  };

  const pauseStatusForUnsupportedServer = (status: number) => {
    const currentPause = unsupportedStatusUntilByAccount.get(breakerKey) ?? 0;
    if (currentPause <= now()) {
      options.log?.warn?.(
        `csgclaw: work status API unavailable; pausing status updates for 5 minutes status=${status} account=${options.account.accountId} participant_id=${options.participantId}`,
      );
    }
    unsupportedStatusUntilByAccount.set(breakerKey, now() + LEGACY_SERVER_PAUSE_MS);
  };

  const pauseStageForUnsupportedServer = () => {
    const currentPause = unsupportedStageUntilByAccount.get(breakerKey) ?? 0;
    if (currentPause <= now()) {
      options.log?.debug?.(
        `csgclaw: work stage unsupported; falling back to legacy work status account=${options.account.accountId} participant_id=${options.participantId}`,
      );
    }
    unsupportedStageUntilByAccount.set(breakerKey, now() + LEGACY_SERVER_PAUSE_MS);
    stageCapabilityAdvertised = false;
  };

  const scheduleStatus = (delay?: number) => {
    if (
      closed ||
      !leaseStarted ||
      patchInFlight ||
      statusTimer ||
      !latestStatus ||
      accountStatusReporterPaused(breakerKey, now())
    ) {
      return;
    }
    const elapsed = now() - lastPatchStartedAt;
    const wait = delay ?? Math.max(0, statusIntervalMs - elapsed);
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      void flushStatus();
    }, wait);
  };

  const flushStatus = async () => {
    if (closed || !leaseStarted || patchInFlight || !latestStatus || accountStatusReporterPaused(breakerKey, now())) {
      return;
    }
    patchInFlight = true;
    lastPatchStartedAt = now();
    const sendingVersion = statusVersion;
    const sendingStatus = latestStatus;
    const sequence = ++statusSequence;
    const stageSupported = !accountStageReporterPaused(breakerKey, now());
    const includeStageCapability = stageSupported && (stageCapabilityAdvertised || Boolean(sendingStatus.stage));
    attemptedStatusVersion = Math.max(attemptedStatusVersion, sendingVersion);
    try {
      let response = await request("PATCH", statusPatchBody(sequence, sendingStatus, includeStageCapability));
      if (!response) {
        return;
      }
      if (response.status === 400 && includeStageCapability && !stageCapabilityAdvertised) {
        pauseStageForUnsupportedServer();
        response = await request("PATCH", statusPatchBody(sequence, sendingStatus, false));
        if (!response) {
          return;
        }
      }
      if (isUnsupportedStatus(response.status)) {
        pauseStatusForUnsupportedServer(response.status);
        return;
      }
      if (response.status === 410) {
        closed = true;
        return;
      }
      notifyStopRequested(response);
      if (!response.ok) {
        options.log?.warn?.(`csgclaw: work lease PATCH failed status=${response.status} lease_id=${options.leaseId}`);
        return;
      }
      if (includeStageCapability && !accountStageReporterPaused(breakerKey, now())) {
        stageCapabilityAdvertised = true;
      }
      unsupportedStatusUntilByAccount.delete(breakerKey);
    } finally {
      patchInFlight = false;
      if (!closed && statusVersion > sendingVersion) {
        scheduleStatus();
      }
    }
  };

  const queueStatus = (status: WorkLeaseStatus) => {
    if (closed) {
      return;
    }
    latestStatus = normalizeWorkLeaseStatus(status);
    statusVersion++;
    scheduleStatus();
  };

  const put = async () => {
    if (closed || putInFlight || accountReporterPaused(breakerKey, now())) {
      return;
    }
    putInFlight = true;
    try {
      const response = await request("PUT", {
        kind: "agent_turn",
        request_id: options.requestId,
        room_id: options.roomId,
        thread_root_id: options.threadRootId || undefined,
        ttl_seconds: ttlSeconds,
      });
      if (!response) {
        return;
      }
      if (isUnsupportedStatus(response.status)) {
        pauseForUnsupportedServer(response.status);
        return;
      }
      if (response.status === 410) {
        closed = true;
        options.log?.debug?.(
          `csgclaw: work lease already closed lease_id=${options.leaseId} participant_id=${options.participantId}`,
        );
        return;
      }
      if (!response.ok) {
        options.log?.warn?.(`csgclaw: work lease PUT failed status=${response.status} lease_id=${options.leaseId}`);
        return;
      }
      unsupportedUntilByAccount.delete(breakerKey);
      leaseStarted = true;
      notifyStopRequested(response);
      if (!latestStatus) {
        queueStatus({ phase: "thinking", stage: "preparing_reply" });
      } else if (statusVersion > attemptedStatusVersion) {
        scheduleStatus(0);
      }
    } finally {
      putInFlight = false;
    }
  };

  return {
    async startOrRenew() {
      await put();
    },
    async updateStatus(status) {
      queueStatus(status);
    },
    onStopRequested(listener) {
      if (closed || typeof listener !== "function") {
        return () => {};
      }
      stopListeners.add(listener);
      if (stopNotified) {
        try {
          listener();
        } catch (error) {
          options.log?.warn?.(
            `csgclaw: work lease stop listener failed lease_id=${options.leaseId} error=${formatWorkLeaseError(error)}`,
          );
        }
      }
      return () => stopListeners.delete(listener);
    },
    async stop(outcome = "released") {
      if (closed) {
        return;
      }
      closed = true;
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = undefined;
      }
      putController?.abort(new Error("work lease reporter stopped"));
      putController = undefined;
      patchController?.abort(new Error("work lease reporter stopped"));
      patchController = undefined;
      stopListeners.clear();
      if (accountReporterPaused(breakerKey, now())) {
        return;
      }
      const response = await request("DELETE", { outcome });
      if (!response) {
        return;
      }
      if (isUnsupportedStatus(response.status)) {
        pauseForUnsupportedServer(response.status);
        return;
      }
      if (!response.ok) {
        options.log?.warn?.(`csgclaw: work lease DELETE failed status=${response.status} lease_id=${options.leaseId}`);
      }
    },
  };
}

/**
 * Covers one admitted OpenClaw reply dispatch with a work lease.
 *
 * Reporting is deliberately best-effort: starting or renewing the lease must
 * never delay or fail the reply itself. The final stop is awaited so the lease
 * remains active through normal delivery, visible failure delivery, and abort
 * cleanup.
 */
export async function dispatchWithCsgclawWorkLease<T>(options: CsgclawWorkLeaseDispatchOptions<T>): Promise<T> {
  const renewIntervalMs = Math.max(1, options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS);
  const startOrRenew = (phase: "start" | "renew") => {
    try {
      void options.reporter.startOrRenew().catch((error) => {
        options.log?.warn?.(`csgclaw: work lease dispatch ${phase} failed: ${formatWorkLeaseError(error)}`);
      });
    } catch (error) {
      options.log?.warn?.(`csgclaw: work lease dispatch ${phase} failed: ${formatWorkLeaseError(error)}`);
    }
  };

  startOrRenew("start");
  const renewTimer = setInterval(() => startOrRenew("renew"), renewIntervalMs);
  try {
    return await options.dispatch();
  } finally {
    clearInterval(renewTimer);
    try {
      await options.reporter.stop(options.completionOutcome?.() ?? "released");
    } catch (error) {
      options.log?.warn?.(`csgclaw: work lease dispatch stop failed: ${formatWorkLeaseError(error)}`);
    }
  }
}

function accountReporterPaused(key: string, now: number): boolean {
  const until = unsupportedUntilByAccount.get(key) ?? 0;
  if (until <= now) {
    unsupportedUntilByAccount.delete(key);
    return false;
  }
  return true;
}

function accountStatusReporterPaused(key: string, now: number): boolean {
  const until = unsupportedStatusUntilByAccount.get(key) ?? 0;
  if (until <= now) {
    unsupportedStatusUntilByAccount.delete(key);
    return false;
  }
  return true;
}

function accountStageReporterPaused(key: string, now: number): boolean {
  const until = unsupportedStageUntilByAccount.get(key) ?? 0;
  if (until <= now) {
    unsupportedStageUntilByAccount.delete(key);
    return false;
  }
  return true;
}

function isUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function workLeaseAccountKey(account: ResolvedCsgclawAccount, participantId: string): string {
  let baseUrl = account.baseUrl.trim().replace(/\/+$/, "");
  try {
    baseUrl = new URL(baseUrl).toString().replace(/\/+$/, "");
  } catch {
    // Keep the normalized raw value for legacy or test URLs.
  }
  return `${baseUrl}\u0000${account.accountId.trim()}\u0000${participantId.trim()}`;
}

function formatWorkLeaseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetWorkLeaseCompatibilityBreakersForTest(): void {
  unsupportedUntilByAccount.clear();
  unsupportedStatusUntilByAccount.clear();
  unsupportedStageUntilByAccount.clear();
}

function normalizeWorkLeaseStatus(status: WorkLeaseStatus): WorkLeaseStatus {
  if (status.phase === "working") {
    return { phase: "working", stage: status.stage };
  }
  if (!status.thinking) {
    return { phase: "thinking", stage: status.stage };
  }
  const normalizedText = status.thinking.text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  let text = normalizedText;
  let truncated = status.thinking.truncated === true;
  if (Buffer.byteLength(text, "utf8") > MAX_THINKING_BYTES) {
    const bytes = Buffer.from(text, "utf8");
    text = bytes.subarray(bytes.length - MAX_THINKING_BYTES).toString("utf8");
    while (Buffer.byteLength(text, "utf8") > MAX_THINKING_BYTES) {
      text = text.slice(1);
    }
    truncated = true;
  }
  return {
    phase: "thinking",
    stage: status.stage,
    thinking: {
      format: "plain_text",
      text,
      truncated,
    },
  };
}

function statusPatchBody(
  sequence: number,
  status: WorkLeaseStatus,
  includeStageCapability: boolean,
): Record<string, unknown> {
  return {
    capabilities: includeStageCapability ? [...WORK_CAPABILITIES, WORK_STAGE_CAPABILITY] : [...WORK_CAPABILITIES],
    sequence,
    phase: status.phase,
    stage: includeStageCapability ? status.stage : undefined,
    thinking:
      status.phase === "thinking" && status.thinking
        ? {
            format: "plain_text",
            text: status.thinking.text,
            truncated: status.thinking.truncated === true,
          }
        : undefined,
  };
}

export type CsgclawTurnStatusTracker = {
  onAssistantMessageStart: () => void;
  onFinalText: (payload: { text?: string }) => void;
  onReasoningEnd: () => void;
  onReasoningStream: (payload: { text?: string }) => void;
  onToolEnd: () => void;
  onToolStart: () => void;
};

export function createCsgclawTurnStatusTracker(
  reporter: Pick<CsgclawWorkLeaseReporter, "updateStatus">,
): CsgclawTurnStatusTracker {
  let completedTool = false;
  let generatingReply = false;
  let currentStage: WorkLeaseStage | undefined;
  const update = (status: WorkLeaseStatus) => {
    currentStage = status.stage;
    void reporter.updateStatus(status);
  };
  const waitingForModel = () => {
    if (generatingReply || currentStage === "thinking") {
      return;
    }
    const nextStage = completedTool ? "processing_tool_result" : "preparing_reply";
    if (currentStage !== nextStage) {
      update({ phase: "thinking", stage: nextStage });
    }
  };

  return {
    onAssistantMessageStart: waitingForModel,
    onFinalText(payload) {
      if (!String(payload.text || "").trim()) {
        return;
      }
      generatingReply = true;
      update({ phase: "working", stage: "generating_reply" });
    },
    // Keep the final reasoning snapshot visible until a later observable event
    // moves the turn into tool execution or final-answer generation. Clearing
    // it here can coalesce a short reasoning stream away before it is reported.
    onReasoningEnd() {},
    onReasoningStream(payload) {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) {
        return;
      }
      generatingReply = false;
      update({
        phase: "thinking",
        stage: "thinking",
        thinking: { text },
      });
    },
    onToolEnd() {
      completedTool = true;
      generatingReply = false;
      update({ phase: "thinking", stage: "processing_tool_result" });
    },
    onToolStart() {
      generatingReply = false;
      update({ phase: "working", stage: "running_tool" });
    },
  };
}

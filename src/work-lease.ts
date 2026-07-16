import type { ResolvedCsgclawAccount } from "./config.js";
import { workLeaseUrl } from "./config.js";

const DEFAULT_TTL_SECONDS = 15;
const REQUEST_TIMEOUT_MS = 2_000;
const LEGACY_SERVER_PAUSE_MS = 5 * 60_000;

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
  requestId: string;
  roomId: string;
  threadRootId?: string;
  ttlSeconds?: number;
};

export type CsgclawWorkLeaseReporter = {
  startOrRenew: () => Promise<void>;
  stop: () => Promise<void>;
};

const unsupportedUntilByAccount = new Map<string, number>();

type WorkLeaseHTTPResponse = {
  ok: boolean;
  status: number;
};

export function createCsgclawWorkLeaseReporter(
  options: CsgclawWorkLeaseReporterOptions,
): CsgclawWorkLeaseReporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const breakerKey = workLeaseAccountKey(options.account, options.participantId);
  let closed = false;
  let putController: AbortController | undefined;
  let putInFlight = false;

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
    method: "PUT" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<WorkLeaseHTTPResponse | null> => {
    const controller = new AbortController();
    if (method === "PUT") {
      putController = controller;
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
      await response.body?.cancel().catch(() => {});
      return { ok: response.ok, status: response.status };
    } catch (error) {
      if (!(closed && method === "PUT" && controller.signal.aborted)) {
        options.log?.warn?.(
          `csgclaw: work lease request failed method=${method} lease_id=${options.leaseId} error=${formatWorkLeaseError(error)}`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
      if (method === "PUT" && putController === controller) {
        putController = undefined;
      }
    }
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
        options.log?.warn?.(
          `csgclaw: work lease PUT failed status=${response.status} lease_id=${options.leaseId}`,
        );
        return;
      }
      unsupportedUntilByAccount.delete(breakerKey);
    } finally {
      putInFlight = false;
    }
  };

  return {
    async startOrRenew() {
      await put();
    },
    async stop() {
      if (closed) {
        return;
      }
      closed = true;
      putController?.abort(new Error("work lease reporter stopped"));
      putController = undefined;
      if (accountReporterPaused(breakerKey, now())) {
        return;
      }
      const response = await request("DELETE");
      if (!response) {
        return;
      }
      if (isUnsupportedStatus(response.status)) {
        pauseForUnsupportedServer(response.status);
        return;
      }
      if (!response.ok) {
        options.log?.warn?.(
          `csgclaw: work lease DELETE failed status=${response.status} lease_id=${options.leaseId}`,
        );
      }
    },
  };
}

function accountReporterPaused(key: string, now: number): boolean {
  const until = unsupportedUntilByAccount.get(key) ?? 0;
  if (until <= now) {
    unsupportedUntilByAccount.delete(key);
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
}

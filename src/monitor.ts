import { randomUUID } from "node:crypto";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedCsgclawAccount } from "./config.js";
import {
  eventsUrl,
  feishuEventsUrl,
  feishuMessagesUrl,
  messagesUrl,
  resolveFeishuAccountId,
} from "./config.js";
import { consumeSseStream } from "./sse.js";
import {
  createCsgclawWorkLeaseReporter,
  dispatchWithCsgclawWorkLease,
} from "./work-lease.js";

type CsgclawEventContext = {
  channel?: string;
  account?: string;
  chat_id?: string;
  chat_type?: string;
  topic_id?: string;
};

type CsgclawSsePayload = {
  message_id?: string;
  room_id?: string;
  chat_id?: string;
  chat_type?: string;
  thread_root_id?: string;
  sender?: { id?: string; username?: string; display_name?: string };
  text?: string;
  timestamp?: string;
  mentions?: string[];
  context?: CsgclawEventContext;
};

type CsgclawFeishuSsePayload = {
  type?: string;
  room_id?: string;
  sender_bot_id?: string;
  mention_bot_id?: string;
  message?: {
    id?: string;
    sender_id?: string;
    kind?: string;
    content?: string;
    created_at?: string | number;
    mentions?: Array<{ id?: string; name?: string }>;
  };
};

type ChannelRuntimeCore = PluginRuntime["channel"];
type ChannelLog = NonNullable<ChannelGatewayContext<ResolvedCsgclawAccount>["log"]>;

type ReplyDeliveryInfo = Record<string, unknown> & {
  kind?: "tool" | "block" | "final" | string;
};

type OpenClawItemEventPayload = {
  itemId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
  meta?: string;
  approvalId?: string;
  approvalSlug?: string;
};

type OpenClawCommandOutputPayload = {
  itemId?: string;
  phase?: string;
  title?: string;
  toolCallId?: string;
  name?: string;
  output?: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

const csgclawAgentActivityType = "com.opencsg.csgclaw.agent.activity";
const csgclawAgentToolMsgType = "com.opencsg.csgclaw.agent.tool";
const maxFailureReplyDetailLength = 1200;
const maxMetadataDepth = 8;
const workLeaseRenewIntervalMs = 5_000;

function readBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function readRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function metadataValue(v: unknown, seen = new WeakSet<object>(), depth = maxMetadataDepth): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === "bigint") {
    return v.toString();
  }
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString() : undefined;
  }
  if (typeof v !== "object" || depth <= 0) {
    return undefined;
  }
  if (seen.has(v)) {
    return undefined;
  }
  seen.add(v);
  if (Array.isArray(v)) {
    const values = v
      .map((item) => metadataValue(item, seen, depth - 1))
      .filter((item) => item !== undefined);
    return values;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    const serialized = metadataValue(value, seen, depth - 1);
    if (serialized !== undefined) {
      out[key] = serialized;
    }
  }
  return out;
}

function metadataRecord(v: unknown): Record<string, unknown> | undefined {
  const serialized = metadataValue(v);
  return readRecord(serialized);
}

function parseTimestampMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v !== "string") {
    return undefined;
  }
  const trimmed = v.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatFailureReplyDetail(err: unknown): string {
  const message = formatErrorMessage(err).trim() || "unknown error";
  if (message.length <= maxFailureReplyDetailLength) {
    return message;
  }
  return `${message.slice(0, maxFailureReplyDetailLength)}...`;
}

function formatRuntimeFailureReply(err: unknown): string {
  return `OpenClaw runtime failed before reply: ${formatFailureReplyDetail(err)}`;
}

function openclawDeliveryMetadata(params: {
  channel: "csgclaw" | "feishu";
  info?: ReplyDeliveryInfo;
  payload?: Pick<
    ReplyPayload,
    | "isCompactionNotice"
    | "isError"
    | "isFallbackNotice"
    | "isReasoning"
    | "isStatusNotice"
    | "mediaUrl"
    | "mediaUrls"
    | "replyToId"
  >;
  requestId?: string;
  sessionKey?: string;
}): Record<string, unknown> {
  const openclaw: Record<string, unknown> = {
    channel: params.channel,
  };
  const deliveryInfo = metadataRecord(params.info);
  if (deliveryInfo && Object.keys(deliveryInfo).length > 0) {
    openclaw.delivery_info = deliveryInfo;
  }
  const kind = readString(deliveryInfo?.kind ?? params.info?.kind);
  if (kind) {
    openclaw.delivery_kind = kind;
  }
  const toolCallId = readString(deliveryInfo?.toolCallId ?? deliveryInfo?.tool_call_id);
  if (toolCallId) {
    openclaw.tool_call_id = toolCallId;
  }
  const toolStatus = readString(deliveryInfo?.toolStatus ?? deliveryInfo?.tool_status);
  if (toolStatus) {
    openclaw.tool_status = toolStatus;
  }
  const tag = readString(deliveryInfo?.tag);
  if (tag) {
    openclaw.delivery_tag = tag;
  }
  const allowEdit = readBoolean(deliveryInfo?.allowEdit ?? deliveryInfo?.allow_edit);
  if (allowEdit !== undefined) {
    openclaw.allow_edit = allowEdit;
  }
  const requestId = readString(params.requestId);
  if (requestId) {
    openclaw.request_id = requestId;
    openclaw.source_message_id = requestId;
  }
  const sessionKey = readString(params.sessionKey);
  if (sessionKey) {
    openclaw.session_key = sessionKey;
  }
  const replyToId = readString(params.payload?.replyToId);
  if (replyToId) {
    openclaw.reply_to_id = replyToId;
  }
  const flags: Record<string, boolean> = {};
  if (params.payload?.isError === true) {
    flags.error = true;
  }
  if (params.payload?.isReasoning === true) {
    flags.reasoning = true;
  }
  if (params.payload?.isCompactionNotice === true) {
    flags.compaction_notice = true;
  }
  if (params.payload?.isFallbackNotice === true) {
    flags.fallback_notice = true;
  }
  if (params.payload?.isStatusNotice === true) {
    flags.status_notice = true;
  }
  if (readString(params.payload?.mediaUrl) || params.payload?.mediaUrls?.some((url) => readString(url))) {
    flags.has_media = true;
  }
  if (Object.keys(flags).length > 0) {
    openclaw.payload_flags = flags;
  }
  return { openclaw };
}

function openclawActivityMetadata(params: {
  eventKind: string;
  info?: ReplyDeliveryInfo;
  requestId?: string;
  sessionKey?: string;
}): Record<string, unknown> {
  const metadata = openclawDeliveryMetadata({
    channel: "csgclaw",
    info: { kind: "tool", ...(params.info ?? {}) },
    requestId: params.requestId,
    sessionKey: params.sessionKey,
  });
  const openclaw = readRecord(metadata.openclaw);
  if (openclaw) {
    openclaw.activity_kind = params.eventKind;
  }
  return metadata;
}

function createAgentActivityPayload(params: {
  body: string;
  chatId: string;
  eventId: string;
  tool: Record<string, unknown>;
}): string {
  return JSON.stringify({
    channel: "openclaw",
    content: {
      body: params.body,
      msgtype: csgclawAgentToolMsgType,
      tool: params.tool,
    },
    event_id: params.eventId,
    origin_server_ts: Date.now(),
    room_id: splitTopicChatId(params.chatId).roomId,
    sender: "openclaw",
    type: csgclawAgentActivityType,
    version: 1,
  });
}

function toolEventId(params: { prefix: string; requestId?: string; itemId?: string; phase?: string }): string {
  return [
    "openclaw",
    params.prefix,
    readString(params.requestId) || "request",
    readString(params.itemId) || String(Date.now()),
    readString(params.phase) || "event",
  ].join(":");
}

function commandOutputSummary(payload: OpenClawCommandOutputPayload): string {
  const parts: string[] = [];
  const status = readString(payload.status);
  if (status) {
    parts.push(`status=${status}`);
  }
  if (payload.exitCode !== undefined) {
    parts.push(`exitCode=${payload.exitCode === null ? "null" : payload.exitCode}`);
  }
  if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
    parts.push(`durationMs=${payload.durationMs}`);
  }
  const cwd = readString(payload.cwd);
  if (cwd) {
    parts.push(`cwd=${cwd}`);
  }
  return parts.join(" ");
}

function createCsgclawActivityReplyOptions(params: {
  account: ResolvedCsgclawAccount;
  chatId: string;
  log?: ChannelLog;
  requestId?: string;
  sessionKey?: string;
}) {
  const sendActivity = async (
    eventKind: string,
    eventId: string,
    body: string,
    tool: Record<string, unknown>,
    info?: ReplyDeliveryInfo,
  ) => {
    try {
      await postSend(
        params.account,
        params.chatId,
        createAgentActivityPayload({
          body,
          chatId: params.chatId,
          eventId,
          tool,
        }),
        openclawActivityMetadata({
          eventKind,
          info,
          requestId: params.requestId,
          sessionKey: params.sessionKey,
        }),
      );
    } catch (err) {
      params.log?.warn?.(`csgclaw: failed to send OpenClaw activity: ${formatErrorMessage(err)}`);
    }
  };

  return {
    allowProgressCallbacksWhenSourceDeliverySuppressed: true,
    onCommandOutput: async (payload: OpenClawCommandOutputPayload) => {
      const id = readString(payload.itemId) || readString(payload.toolCallId);
      const title = readString(payload.title) || readString(payload.name) || "Command";
      const output = readString(payload.output);
      const statusSummary = commandOutputSummary(payload);
      const body = output || statusSummary || title;
      const tool: Record<string, unknown> = {
        id: id || toolEventId({ prefix: "command", requestId: params.requestId, phase: payload.phase }),
        kind: readString(payload.name) || "command",
        phase: readString(payload.phase) || undefined,
        status: readString(payload.status) || "completed",
        title,
        command: title,
        output: output || undefined,
        output_summary: output || statusSummary || undefined,
        exit_code: payload.exitCode,
        duration_ms: payload.durationMs,
        cwd: readString(payload.cwd) || undefined,
        item_id: readString(payload.itemId) || undefined,
        tool_call_id: readString(payload.toolCallId) || undefined,
      };
      await sendActivity(
        "command_output",
        toolEventId({
          prefix: "command_output",
          requestId: params.requestId,
          itemId: id || readString(payload.itemId),
          phase: payload.phase,
        }),
        body,
        tool,
        {
          kind: "tool",
          toolCallId: readString(payload.toolCallId) || undefined,
          toolStatus: readString(payload.status) || undefined,
          tag: "command_output",
        },
      );
    },
    onItemEvent: async (payload: OpenClawItemEventPayload) => {
      const id = readString(payload.itemId);
      const kind = readString(payload.kind);
      const title = readString(payload.title) || readString(payload.name) || kind || "Tool";
      const status = readString(payload.status) || (readString(payload.phase) === "end" ? "completed" : "running");
      const summary = readString(payload.progressText) || readString(payload.summary);
      const body = summary || `${title} · ${status}`;
      const tool: Record<string, unknown> = {
        id: id || toolEventId({ prefix: "item", requestId: params.requestId, phase: payload.phase }),
        kind: readString(payload.name) || kind || "tool",
        phase: readString(payload.phase) || undefined,
        status,
        title,
        command: kind === "command" ? title : undefined,
        input_summary: readString(payload.meta) || undefined,
        output_summary: summary || undefined,
        item_id: id || undefined,
        approval_id: readString(payload.approvalId) || undefined,
        approval_slug: readString(payload.approvalSlug) || undefined,
      };
      await sendActivity(
        "item",
        toolEventId({
          prefix: "item",
          requestId: params.requestId,
          itemId: id,
          phase: payload.phase,
        }),
        body,
        tool,
        {
          kind: "tool",
          toolStatus: status,
          tag: "item",
        },
      );
    },
  };
}

async function dispatchReplyWithVisibleFailure(params: {
  label: string;
  abortSignal: AbortSignal;
  log?: ChannelLog;
  dispatch: () => Promise<void>;
  deliverFailure: (text: string) => Promise<void>;
}): Promise<void> {
  try {
    await params.dispatch();
  } catch (err) {
    if (params.abortSignal.aborted) {
      throw err;
    }
    const failureReply = formatRuntimeFailureReply(err);
    params.log?.warn?.(`${params.label}: reply dispatch failed: ${formatFailureReplyDetail(err)}`);
    try {
      await params.deliverFailure(failureReply);
    } catch (sendErr) {
      params.log?.error?.(
        `${params.label}: failed to send visible reply failure: ${formatErrorMessage(sendErr)}`,
      );
    }
  }
}

export function isCsgclawFeishuBridgeConfigured(cfg: OpenClawConfig, participantId: string): boolean {
  const channels = readRecord(cfg.channels);
  const feishu = readRecord(channels?.feishu);
  if (!feishu || feishu.enabled === false) {
    return false;
  }

  const feishuAccountId = resolveFeishuAccountId(cfg, participantId);
  if (!feishuAccountId) {
    return false;
  }

  const accounts = readRecord(feishu.accounts);
  const account = readRecord(accounts?.[feishuAccountId]);
  if (account) {
    return account.enabled !== false;
  }

  return readString(feishu.defaultAccount) === feishuAccountId;
}

function feishuBodyForAgent(params: {
  messageId: string;
  senderId: string;
  content: string;
}): string {
  const prefix = params.messageId ? `[message_id: ${params.messageId}]\n` : "";
  return `${prefix}${params.senderId}: ${params.content}`;
}

function resolveCsgclawGroupRequireMention(cfg: OpenClawConfig, roomId: string): boolean {
  const channels = readRecord(cfg.channels);
  const csgclaw = readRecord(channels?.csgclaw);
  if (!csgclaw) {
    return true;
  }

  const groups = readRecord(csgclaw.groups);
  const roomGroup = readRecord(groups?.[roomId]);
  const defaultGroup = readRecord(groups?.["*"]);
  const configured =
    readBoolean(roomGroup?.requireMention) ?? readBoolean(defaultGroup?.requireMention);
  if (typeof configured === "boolean") {
    return configured;
  }

  const camelTrigger = readRecord(csgclaw.groupTrigger);
  const snakeTrigger = readRecord(csgclaw.group_trigger);
  return (
    readBoolean(camelTrigger?.mentionOnly) ??
    readBoolean(camelTrigger?.mention_only) ??
    readBoolean(snakeTrigger?.mentionOnly) ??
    readBoolean(snakeTrigger?.mention_only) ??
    true
  );
}

export function shouldDispatchCsgclawInbound(params: {
  cfg: OpenClawConfig;
  chatType: "direct" | "group";
  roomId: string;
  wasMentioned: boolean;
}): boolean {
  if (params.chatType !== "group") {
    return true;
  }
  if (!resolveCsgclawGroupRequireMention(params.cfg, params.roomId)) {
    return true;
  }
  return params.wasMentioned;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
    };
    const onResolve = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    t = setTimeout(onResolve, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolvedRoomId(payload: CsgclawSsePayload): string {
  const roomId = readString(payload.room_id);
  if (roomId) {
    return roomId;
  }
  const chatId = readString(payload.chat_id);
  if (chatId) {
    return chatId;
  }
  return readString(payload.context?.chat_id);
}

function resolvedTopicId(payload: CsgclawSsePayload): string {
  const topicId = readString(payload.context?.topic_id);
  if (topicId) {
    return topicId;
  }
  return readString(payload.thread_root_id);
}

function topicChatId(roomId: string, topicId: string): string {
  if (!roomId || !topicId) {
    return roomId;
  }
  return `${roomId}/${topicId}`;
}

export function splitTopicChatId(chatId: string): { roomId: string; topicId: string } {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return { roomId: "", topicId: "" };
  }
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0 || idx === trimmed.length - 1) {
    return { roomId: trimmed, topicId: "" };
  }
  return {
    roomId: trimmed.slice(0, idx).trim(),
    topicId: trimmed.slice(idx + 1).trim(),
  };
}

export function roomIdFromOutboundTo(to: string): string {
  const t = to.trim();
  const m = /^csgclaw:room:(.+)$/i.exec(t);
  if (m) {
    return m[1];
  }
  return t;
}

function inboundMentionIds(payload: CsgclawSsePayload, participantId: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (id: string) => {
    const normalized = id.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ids.push(normalized);
  };
  add(participantId);
  add(readString(payload.context?.account));
  for (const mention of payload.mentions ?? []) {
    add(mention);
  }
  return ids;
}

function hasInboundBotAtMention(content: string, botId: string): boolean {
  const normalizedContent = content.trim();
  const normalizedBotId = botId.trim();
  if (!normalizedContent || !normalizedBotId) {
    return false;
  }

  const prefix = `<at user_id="`;
  let searchFrom = 0;
  while (true) {
    const start = normalizedContent.indexOf(prefix, searchFrom);
    if (start < 0) {
      return false;
    }
    const valueStart = start + prefix.length;
    const end = normalizedContent.indexOf('"', valueStart);
    if (end < 0) {
      return false;
    }
    if (normalizedContent.slice(valueStart, end).trim() === normalizedBotId) {
      return true;
    }
    searchFrom = end + 1;
  }
}

function hasInboundAtMention(content: string): boolean {
  return content.trim().includes(`<at user_id="`);
}

function normalizeInboundAtMentions(content: string): string {
  if (!content) {
    return content;
  }

  const openTag = "<at";
  const closeTag = "</at>";
  let searchFrom = 0;
  let normalized = "";

  while (searchFrom < content.length) {
    const start = content.indexOf(openTag, searchFrom);
    if (start < 0) {
      normalized += content.slice(searchFrom);
      break;
    }
    normalized += content.slice(searchFrom, start);

    const tagEnd = content.indexOf(">", start);
    if (tagEnd < 0) {
      normalized += content.slice(start);
      break;
    }

    const closeStart = content.indexOf(closeTag, tagEnd + 1);
    if (closeStart < 0) {
      normalized += content.slice(start);
      break;
    }

    const mentionName = content.slice(tagEnd + 1, closeStart).trim();
    normalized += mentionName ? `@${mentionName}` : content.slice(start, closeStart + closeTag.length);
    searchFrom = closeStart + closeTag.length;
  }

  return normalized;
}

function isInboundBotMentioned(
  payload: CsgclawSsePayload,
  participantId: string,
  content: string,
): boolean {
  for (const id of inboundMentionIds(payload, participantId)) {
    if (hasInboundBotAtMention(content, id)) {
      return true;
    }
  }
  return Array.isArray(payload.mentions) && payload.mentions.length > 0;
}

export async function postSend(
  account: ResolvedCsgclawAccount,
  chatId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const { roomId, topicId } = splitTopicChatId(chatId);
  const url = messagesUrl(account);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const body: Record<string, unknown> = {
    room_id: roomId,
    text,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }
  if (topicId) {
    body.topic_id = topicId;
    body.context = {
      channel: "csgclaw",
      chat_id: roomId,
      topic_id: topicId,
    };
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(`csgclaw send: HTTP ${res.status} ${responseBody}`);
  }
  const json = (await res.json()) as { message_id?: string };
  return json.message_id ?? "";
}

export async function postFeishuSend(
  account: ResolvedCsgclawAccount,
  cfg: OpenClawConfig,
  roomId: string,
  text: string,
  mentionBotId?: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const feishuAccountId = resolveFeishuAccountId(cfg, account.participantId);
  const mentionId = mentionBotId?.trim();
  const body: Record<string, unknown> = {
    room_id: roomId,
    sender_id: feishuAccountId,
    content: text,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }
  if (mentionId && mentionId !== feishuAccountId) {
    body.mention_id = mentionId;
  }
  const res = await fetch(feishuMessagesUrl(account), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(`csgclaw feishu send: HTTP ${res.status} ${responseBody}`);
  }
  const json = (await res.json()) as { id?: string; message_id?: string };
  return json.id ?? json.message_id ?? "";
}

export async function monitorCsgclawProvider(ctx: ChannelGatewayContext<ResolvedCsgclawAccount>) {
  const account = ctx.account;
  if (!ctx.channelRuntime) {
    ctx.log?.warn?.("csgclaw: channelRuntime missing; cannot dispatch inbound replies");
    return;
  }
  const core = ctx.channelRuntime as ChannelRuntimeCore;

  const url = eventsUrl(account);
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }

  const cfg = ctx.cfg as OpenClawConfig;

  while (!ctx.abortSignal.aborted) {
    try {
      await consumeSseStream({
        url,
        headers,
        signal: ctx.abortSignal,
        onEvent: async (eventName, data) => {
          if (eventName !== "message") {
            return;
          }
          let payload: CsgclawSsePayload;
          try {
            payload = JSON.parse(data) as CsgclawSsePayload;
          } catch {
            return;
          }

          const roomId = resolvedRoomId(payload);
          const topicId = resolvedTopicId(payload);
          const chatId = topicChatId(roomId, topicId);
          const senderId = payload.sender?.id?.trim() ?? "";
          if (!roomId || !senderId) {
            return;
          }

          let rawBody = payload.text ?? "";
          const chatType =
            payload.chat_type === "direct" || payload.chat_type === "group"
              ? payload.chat_type
              : "group";

          let wasMentioned = isInboundBotMentioned(payload, account.participantId, rawBody);
          if (chatType === "group") {
            if (!wasMentioned && hasInboundAtMention(rawBody)) {
              ctx.log?.debug?.("csgclaw: skipped group message with unrelated @ mention");
              return;
            }
            rawBody = normalizeInboundAtMentions(rawBody);
            wasMentioned = isInboundBotMentioned(payload, account.participantId, rawBody);
          }

          if (
            !shouldDispatchCsgclawInbound({
              cfg,
              chatType,
              roomId,
              wasMentioned,
            })
          ) {
            ctx.log?.debug?.("csgclaw: skipped unmentioned group message");
            return;
          }

          const route = core.routing.resolveAgentRoute({
            cfg,
            channel: "csgclaw",
            accountId: ctx.accountId,
            peer: { kind: chatType, id: chatId },
          });

          const body = core.reply.formatAgentEnvelope({
            channel: "CSGClaw",
            from: payload.sender?.display_name || payload.sender?.username || senderId,
            timestamp: parseTimestampMs(payload.timestamp),
            envelope: core.reply.resolveEnvelopeFormatOptions(cfg),
            body: rawBody,
          });

          const ctxPayload = core.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: rawBody,
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `csgclaw:user:${senderId}`,
            To: `csgclaw:room:${chatId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: chatType,
            ConversationLabel: chatId,
            SenderName: payload.sender?.display_name ?? payload.sender?.username ?? senderId,
            SenderId: senderId,
            SenderUsername: payload.sender?.username ?? senderId,
            Provider: "csgclaw",
            Surface: "csgclaw",
            MessageSid: payload.message_id ?? "",
            OriginatingChannel: "csgclaw",
            OriginatingTo: `csgclaw:room:${chatId}`,
            CommandAuthorized: true,
            WasMentioned: wasMentioned,
          });

          const storePath = core.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });

          await core.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error?.(`csgclaw: recordInboundSession: ${String(err)}`);
            },
          });

          const work = createCsgclawWorkLeaseReporter({
            account,
            participantId: account.participantId,
            roomId,
            threadRootId: topicId || payload.thread_root_id,
            requestId: ctxPayload.MessageSid,
            leaseId: randomUUID(),
            log: ctx.log,
          });
          const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
            cfg,
            agentId: route.agentId,
            channel: "csgclaw",
            accountId: ctx.accountId,
          });
          const activityReplyOptions = createCsgclawActivityReplyOptions({
            account,
            chatId,
            log: ctx.log,
            requestId: ctxPayload.MessageSid,
            sessionKey: ctxPayload.SessionKey,
          });

          await dispatchWithCsgclawWorkLease({
            dispatch: async () => {
              await dispatchReplyWithVisibleFailure({
                label: "csgclaw",
                abortSignal: ctx.abortSignal,
                log: ctx.log,
                dispatch: async () => {
                  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
                    ctx: ctxPayload,
                    cfg,
                    dispatcherOptions: {
                      ...replyPipeline,
                      deliver: async (payload: ReplyPayload, info: ReplyDeliveryInfo) => {
                        const out = (payload.text ?? "").trim();
                        if (!out) {
                          return;
                        }
                        await postSend(
                          account,
                          chatId,
                          out,
                          openclawDeliveryMetadata({
                            channel: "csgclaw",
                            info,
                            payload,
                            requestId: ctxPayload.MessageSid,
                            sessionKey: ctxPayload.SessionKey,
                          }),
                        );
                      },
                    },
                    replyOptions: {
                      onModelSelected,
                      suppressDefaultToolProgressMessages: true,
                      ...activityReplyOptions,
                    },
                  });
                },
                deliverFailure: async (text) => {
                  await postSend(
                    account,
                    chatId,
                    text,
                    openclawDeliveryMetadata({
                      channel: "csgclaw",
                      info: { kind: "final" },
                      payload: { isError: true },
                      requestId: ctxPayload.MessageSid,
                      sessionKey: ctxPayload.SessionKey,
                    }),
                  );
                },
              });
            },
            log: ctx.log,
            renewIntervalMs: workLeaseRenewIntervalMs,
            reporter: work,
          });
        },
      });
    } catch (err) {
      if (ctx.abortSignal.aborted) {
        break;
      }
      ctx.log?.warn?.(`csgclaw: SSE disconnected (${String(err)}), reconnecting…`);
      try {
        await sleep(2000, ctx.abortSignal);
      } catch {
        break;
      }
    }
  }
}

export async function monitorCsgclawFeishuProvider(
  ctx: ChannelGatewayContext<ResolvedCsgclawAccount>,
) {
  const account = ctx.account;
  if (!ctx.channelRuntime) {
    ctx.log?.warn?.("csgclaw-feishu: channelRuntime missing; cannot dispatch inbound replies");
    return;
  }
  const core = ctx.channelRuntime as ChannelRuntimeCore;

  const cfg = ctx.cfg as OpenClawConfig;
  if (!isCsgclawFeishuBridgeConfigured(cfg, account.participantId)) {
    ctx.log?.debug?.("csgclaw-feishu: channels.feishu not configured for this participant; skip bridge");
    return;
  }

  const feishuAccountId = resolveFeishuAccountId(cfg, account.participantId);
  const url = feishuEventsUrl(account);
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }

  while (!ctx.abortSignal.aborted) {
    try {
      await consumeSseStream({
        url,
        headers,
        signal: ctx.abortSignal,
        onEvent: async (eventName, data) => {
          if (eventName !== "message" && eventName !== "message.created") {
            return;
          }
          let payload: CsgclawFeishuSsePayload;
          try {
            payload = JSON.parse(data) as CsgclawFeishuSsePayload;
          } catch {
            return;
          }
          if (payload.type && payload.type !== "message.created") {
            return;
          }

          const roomId = payload.room_id?.trim();
          const message = payload.message;
          const senderId = message?.sender_id?.trim() ?? "";
          const rawBody = message?.content ?? "";
          if (!roomId || !senderId) {
            return;
          }

          const route = core.routing.resolveAgentRoute({
            cfg,
            channel: "feishu",
            accountId: feishuAccountId,
            peer: { kind: "group", id: roomId },
          });

          const timestamp = parseTimestampMs(message?.created_at);
          const body = core.reply.formatAgentEnvelope({
            channel: "Feishu",
            from: senderId,
            timestamp,
            envelope: core.reply.resolveEnvelopeFormatOptions(cfg),
            body: rawBody,
          });
          const messageId = message?.id?.trim() ?? "";
          const to = `chat:${roomId}`;
          const replyMentionBotId = payload.sender_bot_id?.trim() ?? "";

          const ctxPayload = core.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: feishuBodyForAgent({ messageId, senderId, content: rawBody }),
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `feishu:${senderId}`,
            To: to,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "group",
            GroupSubject: roomId,
            ConversationLabel: roomId,
            SenderName: senderId,
            SenderId: senderId,
            SenderUsername: senderId,
            Provider: "feishu",
            Surface: "feishu",
            MessageSid: messageId,
            Timestamp: timestamp,
            OriginatingChannel: "feishu",
            OriginatingTo: to,
            CommandAuthorized: true,
            WasMentioned: true,
          });

          const storePath = core.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });

          await core.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error?.(`csgclaw-feishu: recordInboundSession: ${String(err)}`);
            },
          });

          const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
            cfg,
            agentId: route.agentId,
            channel: "feishu",
            accountId: feishuAccountId,
          });

          await dispatchReplyWithVisibleFailure({
            label: "csgclaw-feishu",
            abortSignal: ctx.abortSignal,
            log: ctx.log,
            dispatch: async () => {
              await core.reply.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  ...replyPipeline,
                  deliver: async (reply: ReplyPayload, info: ReplyDeliveryInfo) => {
                    const out = (reply.text ?? "").trim();
                    if (!out) {
                      return;
                    }
                    await postFeishuSend(
                      account,
                      cfg,
                      roomId,
                      out,
                      replyMentionBotId,
                      openclawDeliveryMetadata({
                        channel: "feishu",
                        info,
                        payload: reply,
                        requestId: ctxPayload.MessageSid,
                        sessionKey: ctxPayload.SessionKey,
                      }),
                    );
                  },
                },
                replyOptions: { onModelSelected },
              });
            },
            deliverFailure: async (text) => {
              await postFeishuSend(
                account,
                cfg,
                roomId,
                text,
                replyMentionBotId,
                openclawDeliveryMetadata({
                  channel: "feishu",
                  info: { kind: "final" },
                  payload: { isError: true },
                  requestId: ctxPayload.MessageSid,
                  sessionKey: ctxPayload.SessionKey,
                }),
              );
            },
          });
        },
      });
    } catch (err) {
      if (ctx.abortSignal.aborted) {
        break;
      }
      ctx.log?.warn?.(`csgclaw-feishu: SSE disconnected (${String(err)}), reconnecting...`);
      try {
        await sleep(2000, ctx.abortSignal);
      } catch {
        break;
      }
    }
  }
}

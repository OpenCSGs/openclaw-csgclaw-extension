import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
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
): Promise<string> {
  const { roomId, topicId } = splitTopicChatId(chatId);
  const url = messagesUrl(account);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const body: Record<string, string | Record<string, string>> = {
    room_id: roomId,
    text,
  };
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
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const feishuAccountId = resolveFeishuAccountId(cfg, account.participantId);
  const mentionId = mentionBotId?.trim();
  const body: Record<string, string> = {
    room_id: roomId,
    sender_id: feishuAccountId,
    content: text,
  };
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

          const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
            cfg,
            agentId: route.agentId,
            channel: "csgclaw",
            accountId: ctx.accountId,
          });

          await core.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              ...replyPipeline,
              deliver: async (payload: ReplyPayload) => {
                const out = (payload.text ?? "").trim();
                if (!out) {
                  return;
                }
                await postSend(account, chatId, out);
              },
            },
            replyOptions: { onModelSelected },
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

          const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
            cfg,
            agentId: route.agentId,
            channel: "feishu",
            accountId: feishuAccountId,
          });

          await core.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              ...replyPipeline,
              deliver: async (reply: ReplyPayload) => {
                const out = (reply.text ?? "").trim();
                if (!out) {
                  return;
                }
                await postFeishuSend(account, cfg, roomId, out, replyMentionBotId);
              },
            },
            replyOptions: { onModelSelected },
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

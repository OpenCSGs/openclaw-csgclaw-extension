import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedCsgclawAccount } from "./config.js";
import { eventsUrl, feishuEventsUrl, feishuMessagesUrl } from "./config.js";
import { consumeSseStream } from "./sse.js";

type CsgclawSsePayload = {
  message_id?: string;
  room_id?: string;
  chat_type?: string;
  sender?: { id?: string; username?: string; display_name?: string };
  text?: string;
  timestamp?: string;
  mentions?: string[];
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

export function isCsgclawFeishuBridgeConfigured(cfg: OpenClawConfig, botId: string): boolean {
  const channels = readRecord(cfg.channels);
  const feishu = readRecord(channels?.feishu);
  if (!feishu || feishu.enabled === false) {
    return false;
  }

  const normalizedBotId = botId.trim();
  if (!normalizedBotId) {
    return false;
  }

  const accounts = readRecord(feishu.accounts);
  const account = readRecord(accounts?.[normalizedBotId]);
  if (account) {
    return account.enabled !== false;
  }

  return readString(feishu.defaultAccount) === normalizedBotId;
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

export function roomIdFromOutboundTo(to: string): string {
  const t = to.trim();
  const m = /^csgclaw:room:(.+)$/i.exec(t);
  if (m) {
    return m[1];
  }
  return t;
}

export async function postSend(
  account: ResolvedCsgclawAccount,
  roomId: string,
  text: string,
): Promise<string> {
  const url = `${account.baseUrl}/api/bots/${encodeURIComponent(account.botId)}/messages/send`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ room_id: roomId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`csgclaw send: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { message_id?: string };
  return json.message_id ?? "";
}

export async function postFeishuSend(
  account: ResolvedCsgclawAccount,
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
  const mentionId = mentionBotId?.trim();
  const body: Record<string, string> = {
    room_id: roomId,
    sender_id: account.botId,
    content: text,
  };
  if (mentionId && mentionId !== account.botId) {
    body.mention_id = mentionId;
  }
  const res = await fetch(feishuMessagesUrl(account), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`csgclaw feishu send: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { id?: string; message_id?: string };
  return json.id ?? json.message_id ?? "";
}

export async function monitorCsgclawProvider(ctx: ChannelGatewayContext<ResolvedCsgclawAccount>) {
  const account = ctx.account;
  const core = ctx.channelRuntime;
  if (!core) {
    ctx.log?.warn?.("csgclaw: channelRuntime missing; cannot dispatch inbound replies");
    return;
  }

  const url = eventsUrl(account);
  const headers: Record<string, string> = {};
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
          const roomId = payload.room_id?.trim();
          const text = payload.text ?? "";
          const senderId = payload.sender?.id?.trim() ?? "";
          if (!roomId || !senderId) {
            return;
          }

          const chatType =
            payload.chat_type === "direct" || payload.chat_type === "group"
              ? payload.chat_type
              : "group";
          const wasMentioned = Array.isArray(payload.mentions) && payload.mentions.length > 0;

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
            peer: { kind: chatType, id: roomId },
          });

          const rawBody = text;
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
            To: `csgclaw:room:${roomId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: chatType,
            ConversationLabel: roomId,
            SenderName: payload.sender?.display_name ?? payload.sender?.username ?? senderId,
            SenderId: senderId,
            SenderUsername: payload.sender?.username ?? senderId,
            Provider: "csgclaw",
            Surface: "csgclaw",
            MessageSid: payload.message_id ?? "",
            OriginatingChannel: "csgclaw",
            OriginatingTo: `csgclaw:room:${roomId}`,
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
                await postSend(account, roomId, out);
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
  const core = ctx.channelRuntime;
  if (!core) {
    ctx.log?.warn?.("csgclaw-feishu: channelRuntime missing; cannot dispatch inbound replies");
    return;
  }

  const cfg = ctx.cfg as OpenClawConfig;
  if (!isCsgclawFeishuBridgeConfigured(cfg, account.botId)) {
    ctx.log?.debug?.("csgclaw-feishu: channels.feishu not configured for this bot; skip bridge");
    return;
  }

  const url = feishuEventsUrl(account);
  const headers: Record<string, string> = {};
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
            accountId: account.botId,
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
            accountId: account.botId,
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
                await postFeishuSend(account, roomId, out, replyMentionBotId);
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

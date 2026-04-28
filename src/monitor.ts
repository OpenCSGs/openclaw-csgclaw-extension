import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedCsgclawAccount } from "./config.js";
import { eventsUrl } from "./config.js";
import { consumeSseStream } from "./sse.js";

type PicoClawSsePayload = {
  message_id?: string;
  room_id?: string;
  chat_type?: string;
  sender?: { id?: string; username?: string; display_name?: string };
  text?: string;
  timestamp?: string;
  mentions?: string[];
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
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
          let payload: PicoClawSsePayload;
          try {
            payload = JSON.parse(data) as PicoClawSsePayload;
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
            timestamp: payload.timestamp ? Number(payload.timestamp) : undefined,
            envelope: core.reply.resolveEnvelopeFormatOptions(cfg),
            body: rawBody,
          });

          const wasMentioned = Array.isArray(payload.mentions) && payload.mentions.length > 0;

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

import { createRawChannelSendResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import type { ChannelCapabilities, ChannelPlugin } from "openclaw/plugin-sdk";
import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  listCsgclawAccountIds,
  resolveCsgclawAccount,
  type ResolvedCsgclawAccount,
} from "./config.js";
import {
  monitorCsgclawFeishuProvider,
  monitorCsgclawProvider,
  postSend,
  roomIdFromOutboundTo,
} from "./monitor.js";

const rawOutbound = createRawChannelSendResultAdapter({
  channel: "csgclaw",
  sendText: async ({ to, text, cfg }) => {
    const c = cfg as OpenClawConfig;
    const account = resolveCsgclawAccount(c, "default");
    const roomId = roomIdFromOutboundTo(to);
    const mid = await postSend(account, roomId, text);
    return { ok: true, messageId: mid };
  },
});

const csgclawCapabilities: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  media: false,
  reactions: false,
  threads: false,
  polls: false,
  nativeCommands: false,
  blockStreaming: false,
};

const pluginBase = createChannelPluginBase<ResolvedCsgclawAccount>({
  id: "csgclaw",
  capabilities: csgclawCapabilities,
  reload: { configPrefixes: ["channels.csgclaw", "channels.feishu"] },
  config: {
    listAccountIds: listCsgclawAccountIds,
    resolveAccount: resolveCsgclawAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.baseUrl && account.participantId),
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

/** Room targets from CSGClaw IM: explicit bridge form or bare id from csgclaw-cli room list. */
function isCsgclawRoomTarget(raw: string): boolean {
  const t = raw.trim();
  return /^csgclaw:room:/i.test(t) || /^room-[-\w]+$/i.test(t);
}

export const csgclawPlugin: ChannelPlugin<ResolvedCsgclawAccount> = createChatChannelPlugin({
  base: {
    ...pluginBase,
    capabilities: csgclawCapabilities,
    config: pluginBase.config!,
    messaging: {
      inferTargetChatType: ({ to }) => (isCsgclawRoomTarget(to) ? "group" : undefined),
      targetResolver: {
        looksLikeId: (raw) => isCsgclawRoomTarget(raw),
        hint: "Use csgclaw:room:<room_id> or a bare room id from csgclaw-cli room list (e.g. room-...).",
        async resolveTarget({ input }) {
          const t = input.trim();
          if (/^csgclaw:room:/i.test(t)) {
            const display = roomIdFromOutboundTo(t);
            return {
              to: t,
              kind: "group",
              display,
              source: "normalized",
            };
          }
          if (/^room-[-\w]+$/i.test(t)) {
            return {
              to: `csgclaw:room:${t}`,
              kind: "group",
              display: t,
              source: "normalized",
            };
          }
          return null;
        },
      },
    },
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.account.enabled) {
          ctx.log?.info?.("csgclaw: account disabled, skip startAccount");
          return;
        }
        await Promise.all([monitorCsgclawProvider(ctx), monitorCsgclawFeishuProvider(ctx)]);
      },
    },
  },
  security: {
    dm: {
      channelKey: "csgclaw",
      resolvePolicy: () => "open",
      resolveAllowFrom: () => ["*"],
      defaultPolicy: "open",
    },
  },
  threading: {
    resolveReplyToMode: createStaticReplyToModeResolver("off"),
  },
  outbound: {
    deliveryMode: "direct",
    ...rawOutbound,
  },
});

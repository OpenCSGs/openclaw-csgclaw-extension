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
import { monitorCsgclawProvider, postSend, roomIdFromOutboundTo } from "./monitor.js";

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
  reload: { configPrefixes: ["channels.csgclaw"] },
  config: {
    listAccountIds: listCsgclawAccountIds,
    resolveAccount: resolveCsgclawAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => Boolean(account.baseUrl && account.botId),
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

export const csgclawPlugin: ChannelPlugin<ResolvedCsgclawAccount> = createChatChannelPlugin({
  base: {
    ...pluginBase,
    capabilities: csgclawCapabilities,
    config: pluginBase.config!,
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.account.enabled) {
          ctx.log?.info?.("csgclaw: account disabled, skip startAccount");
          return;
        }
        await monitorCsgclawProvider(ctx);
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

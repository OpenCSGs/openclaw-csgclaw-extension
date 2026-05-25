import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type ResolvedCsgclawAccount = {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  botId: string;
  accessToken: string;
};

function pickStr(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return "";
}

function csgclawSection(cfg: OpenClawConfig): Record<string, unknown> | null {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.csgclaw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

export function listCsgclawAccountIds(cfg: OpenClawConfig): string[] {
  if (!csgclawSection(cfg)) {
    return [];
  }
  return ["default"];
}

export function resolveCsgclawAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCsgclawAccount {
  const id = (accountId && String(accountId).trim()) || "default";
  const s = csgclawSection(cfg);
  if (!s) {
    throw new Error("csgclaw: missing channels.csgclaw in openclaw.json");
  }
  const enabled = s.enabled !== false;
  const baseUrl = pickStr(
    s.baseUrl,
    s.base_url,
    process.env.CSGCLAW_BASE_URL,
    process.env.PICOCLAW_CHANNELS_CSGCLAW_BASE_URL,
  );
  const botId = pickStr(
    s.botId,
    s.bot_id,
    process.env.CSGCLAW_BOT_ID,
    process.env.PICOCLAW_CHANNELS_CSGCLAW_BOT_ID,
  );
  const accessToken = pickStr(
    s.accessToken,
    s.access_token,
    process.env.CSGCLAW_ACCESS_TOKEN,
    process.env.PICOCLAW_CHANNELS_CSGCLAW_ACCESS_TOKEN,
  );
  if (!baseUrl) {
    throw new Error("csgclaw: baseUrl (or base_url) is required");
  }
  if (!botId) {
    throw new Error("csgclaw: botId (or bot_id) is required");
  }
  return {
    accountId: id,
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    botId,
    accessToken,
  };
}

export function eventsUrl(account: ResolvedCsgclawAccount): string {
  return `${account.baseUrl}/api/bots/${encodeURIComponent(account.botId)}/events`;
}

export function feishuEventsUrl(account: ResolvedCsgclawAccount): string {
  return `${account.baseUrl}/api/v1/channels/feishu/bots/${encodeURIComponent(account.botId)}/events`;
}

export function feishuMessagesUrl(account: ResolvedCsgclawAccount): string {
  return `${account.baseUrl}/api/v1/channels/feishu/messages`;
}

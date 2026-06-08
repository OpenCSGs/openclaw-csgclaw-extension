import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type ResolvedCsgclawAccount = {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  /** CSGClaw participant id for bridge API routes. */
  participantId: string;
  /** @deprecated Use participantId. Kept for callers that still read botId. */
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
  const baseUrl = pickStr(s.baseUrl, s.base_url, process.env.CSGCLAW_BASE_URL);
  const participantId = pickStr(
    s.participantId,
    s.participant_id,
    s.botId,
    s.bot_id,
    process.env.CSGCLAW_PARTICIPANT_ID,
    process.env.CSGCLAW_BOT_ID,
  );
  const accessToken = pickStr(s.accessToken, s.access_token, process.env.CSGCLAW_ACCESS_TOKEN);
  if (!baseUrl) {
    throw new Error("csgclaw: baseUrl (or base_url) is required");
  }
  if (!participantId) {
    throw new Error("csgclaw: participantId (or participant_id / botId / bot_id) is required");
  }
  return {
    accountId: id,
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    participantId,
    botId: participantId,
    accessToken,
  };
}

/** Build participant bridge URL, preserving any base path/query on baseUrl. */
export function participantAPIUrl(account: ResolvedCsgclawAccount, suffix: string): string {
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  let base: URL;
  try {
    base = new URL(account.baseUrl);
  } catch {
    const trimmed = account.baseUrl.replace(/\/+$/, "");
    return `${trimmed}/api/v1/channels/csgclaw/participants/${encodeURIComponent(account.participantId)}${normalizedSuffix}`;
  }

  const pathParts = [
    ...base.pathname.split("/").filter(Boolean),
    "api",
    "v1",
    "channels",
    "csgclaw",
    "participants",
    account.participantId,
    ...normalizedSuffix.split("/").filter(Boolean),
  ];
  base.pathname = `/${pathParts.join("/")}`;
  return base.toString();
}

export function eventsUrl(account: ResolvedCsgclawAccount): string {
  return participantAPIUrl(account, "/events");
}

export function messagesUrl(account: ResolvedCsgclawAccount): string {
  return participantAPIUrl(account, "/messages");
}

export function feishuEventsUrl(account: ResolvedCsgclawAccount): string {
  return `${account.baseUrl}/api/v1/channels/feishu/participants/${encodeURIComponent(account.participantId)}/events`;
}

export function feishuMessagesUrl(account: ResolvedCsgclawAccount): string {
  return `${account.baseUrl}/api/v1/channels/feishu/messages`;
}

export function resolveFeishuAccountId(cfg: OpenClawConfig, participantId: string): string {
  const channels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
  const feishu = channels.feishu;
  if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) {
    return participantId;
  }
  const section = feishu as Record<string, unknown>;
  const accounts =
    section.accounts && typeof section.accounts === "object" && !Array.isArray(section.accounts)
      ? (section.accounts as Record<string, unknown>)
      : undefined;
  const normalizedParticipantId = participantId.trim();
  if (accounts?.[normalizedParticipantId] && (accounts[normalizedParticipantId] as Record<string, unknown>).enabled !== false) {
    return normalizedParticipantId;
  }
  const defaultAccount = pickStr(section.defaultAccount, section.default_account);
  if (defaultAccount && accounts?.[defaultAccount] && (accounts[defaultAccount] as Record<string, unknown>).enabled !== false) {
    return defaultAccount;
  }
  return normalizedParticipantId;
}

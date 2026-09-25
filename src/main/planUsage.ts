import path from 'node:path';
import type { LimitWindow, Profile, ProfileLimits } from '../shared/types';
import { decodeJwtPayload, readJsonFile } from './util';
import { windowLabel } from './telemetry/codexRollout';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** The endpoints rate-limit eagerly; the CLIs themselves poll about this often. */
const MIN_INTERVAL = 5 * 60_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const LEGACY: Array<[string, string]> = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly Opus'],
  ['seven_day_sonnet', 'Weekly Sonnet']
];

/**
 * Plan usage as Claude Code's /usage shows it: the 5-hour and weekly windows
 * of a subscription, and the monthly spend cap of a Team/Enterprise seat.
 */
export function parseClaudeUsage(value: unknown, observedAt: string): ProfileLimits | null {
  const body = object(value);
  if (!body) return null;
  const windows: LimitWindow[] = [];
  const limits = Array.isArray(body.limits) ? body.limits.map(object).filter((l): l is Record<string, any> => l !== null) : null;
  if (limits) {
    for (const limit of limits) {
      if (typeof limit.percent !== 'number') continue;
      const label = limitLabel(limit);
      if (!label) continue;
      windows.push({ id: limitId(limit), label, usedPercent: clamp(limit.percent), resetsAt: text(limit.resets_at) });
    }
  } else {
    for (const [id, label] of LEGACY) {
      const entry = object(body[id]);
      if (entry && typeof entry.utilization === 'number') windows.push({ id, label, usedPercent: clamp(entry.utilization), resetsAt: text(entry.resets_at) });
    }
  }
  const spend = spendWindow(object(body.spend));
  if (spend) windows.push(spend);
  return windows.length ? { windows, observedAt, planType: null } : null;
}

function limitLabel(limit: Record<string, any>): string | null {
  switch (limit.kind) {
    case 'session':
      return '5-hour';
    case 'weekly_all':
      return 'Weekly';
    case 'weekly_scoped': {
      const scope = text(limit.scope?.model?.display_name) ?? text(limit.scope?.surface?.display_name);
      return scope ? `Weekly ${scope}` : 'Weekly (scoped)';
    }
    default:
      return null;
  }
}

function limitId(limit: Record<string, any>): string {
  if (limit.kind === 'session') return 'five_hour';
  if (limit.kind === 'weekly_all') return 'seven_day';
  const scope = text(limit.scope?.model?.display_name) ?? text(limit.scope?.surface?.display_name) ?? 'scoped';
  return `seven_day_${scope.toLowerCase().replace(/\W+/g, '_')}`;
}

/** The per-seat monthly spend cap; only present when the organization sets one. */
function spendWindow(spend: Record<string, any> | null): LimitWindow | null {
  if (!spend?.enabled) return null;
  const used = money(spend.used);
  const limit = money(spend.limit);
  if (used === null || limit === null || limit <= 0) return null;
  const currency = text(spend.used?.currency) ?? text(spend.limit?.currency) ?? 'USD';
  const format = (amount: number) => amount.toLocaleString('en-US', { style: 'currency', currency });
  return {
    id: 'monthly_spend',
    label: 'Monthly spend',
    usedPercent: clamp(typeof spend.percent === 'number' ? spend.percent : (used / limit) * 100),
    resetsAt: null,
    detail: `${format(used)} / ${format(limit)}`
  };
}

function money(value: unknown): number | null {
  const amount = object(value);
  if (!amount || typeof amount.amount_minor !== 'number') return null;
  const exponent = typeof amount.exponent === 'number' ? amount.exponent : 2;
  return amount.amount_minor / 10 ** exponent;
}

/**
 * Plan usage as Codex's /status shows it: the rate-limit windows of a ChatGPT
 * plan, and the per-seat credit allowance of a Business/Enterprise workspace.
 * Window ids match the rollout files' (primary/secondary) so a live session's
 * report replaces them rather than adding duplicates.
 */
export function parseCodexUsage(value: unknown, observedAt: string): ProfileLimits | null {
  const body = object(value);
  if (!body) return null;
  const windows: LimitWindow[] = [];
  const rateLimit = object(body.rate_limit);
  for (const [id, key] of [['primary', 'primary_window'], ['secondary', 'secondary_window']] as const) {
    const entry = object(rateLimit?.[key]);
    if (!entry || typeof entry.used_percent !== 'number') continue;
    const seconds = Number(entry.limit_window_seconds);
    windows.push({
      id,
      label: seconds > 0 ? windowLabel(Math.round(seconds / 60)) : id,
      usedPercent: clamp(entry.used_percent),
      resetsAt: epoch(entry.reset_at)
    });
  }
  const credits = creditWindow(object(object(body.spend_control)?.individual_limit));
  if (credits) windows.push(credits);
  return windows.length ? { windows, observedAt, planType: text(body.plan_type) } : null;
}

/** The workspace's per-member allowance; amounts arrive as decimal strings. */
function creditWindow(limit: Record<string, any> | null): LimitWindow | null {
  if (!limit) return null;
  const used = Number(limit.used);
  const total = Number(limit.limit);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const unit = text(limit.unit) ?? 'credit';
  const format = (amount: number) => amount.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return {
    id: 'credits',
    label: unit === 'credit' ? 'Credits' : unit,
    usedPercent: clamp((used / total) * 100),
    resetsAt: epoch(limit.reset_at),
    detail: `${format(used)} / ${format(total)}`
  };
}

function epoch(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

interface UsageRequest {
  url: string;
  headers: Record<string, string>;
  parse: (body: unknown, observedAt: string) => ProfileLimits | null;
  planType: string | null;
}

/**
 * Asks each tool's usage endpoint with the account's stored access token.
 * Never refreshes an expired token: refresh tokens rotate, and using one here
 * would sign the CLI out. An expired token just means "no fresh numbers" until
 * the CLI next runs for that account.
 */
export class PlanUsageClient {
  private lastAttempt = new Map<string, number>();

  constructor(private readonly fetch: Fetch) {}

  /** undefined: not asked this time (throttled), keep what we have. */
  async load(profile: Profile, force = false): Promise<ProfileLimits | null | undefined> {
    const request = profile.provider === 'claude' ? claudeRequest(profile) : codexRequest(profile);
    if (!request) return null;
    const last = this.lastAttempt.get(profile.id) ?? 0;
    if (!force && Date.now() - last < MIN_INTERVAL) return undefined;
    this.lastAttempt.set(profile.id, Date.now());
    const response = await this.fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const limits = request.parse(await response.json(), new Date().toISOString());
    return limits ? { ...limits, planType: limits.planType ?? request.planType } : null;
  }
}

function claudeRequest(profile: Profile): UsageRequest | null {
  const oauth = readJsonFile<any>(path.join(profile.configDir, '.credentials.json'))?.claudeAiOauth;
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : null;
  if (!token || expired(typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null)) return null;
  return {
    url: CLAUDE_USAGE_URL,
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    parse: parseClaudeUsage,
    planType: text(oauth.subscriptionType)
  };
}

function codexRequest(profile: Profile): UsageRequest | null {
  const tokens = readJsonFile<any>(path.join(profile.configDir, 'auth.json'))?.tokens;
  const token = text(tokens?.access_token);
  if (!token) return null;
  const exp = Number(decodeJwtPayload(token)?.exp);
  if (expired(Number.isFinite(exp) ? exp * 1000 : null)) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex_cli_rs' };
  if (text(tokens.account_id)) headers['ChatGPT-Account-Id'] = tokens.account_id;
  return { url: CODEX_USAGE_URL, headers, parse: parseCodexUsage, planType: null };
}

function expired(expiresAtMs: number | null) {
  return expiresAtMs !== null && expiresAtMs < Date.now() + 60_000;
}

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

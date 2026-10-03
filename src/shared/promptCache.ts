import type { AgentInfo } from './types';

export const PROMPT_CACHE_TTL_MS = 60 * 60_000;

/** Neither CLI exposes live server cache validity. This is an inactivity estimate. */
export function promptCacheEstimate(agent: Pick<AgentInfo, 'status' | 'endedAt' | 'lastModelActivityAt' | 'telemetry'>, now = Date.now()) {
  if (!agent.endedAt && (agent.status === 'working' || agent.status === 'starting')) {
    return { status: 'active' as const, minutes: null, expiresAt: null };
  }
  const stamps = [agent.lastModelActivityAt, agent.telemetry?.requests ? agent.telemetry.updatedAt : null];
  const last = Math.max(...stamps.map((stamp) => Date.parse(stamp ?? '')).filter(Number.isFinite));
  if (!Number.isFinite(last)) return { status: 'unknown' as const, minutes: null, expiresAt: null };
  const expiresAt = last + PROMPT_CACHE_TTL_MS;
  const remaining = Math.max(0, Math.min(PROMPT_CACHE_TTL_MS, expiresAt - now));
  return remaining > 0
    ? { status: 'warm' as const, minutes: Math.ceil(remaining / 60_000), expiresAt }
    : { status: 'expired' as const, minutes: 0, expiresAt };
}

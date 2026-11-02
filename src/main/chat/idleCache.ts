// Keeping an idle Claude chat's prompt cache warm. The cache lives an hour from the last
// request that read it, side questions included, so a tiny side question every
// KEEPALIVE_AFTER_MS keeps it for the chat's keep-warm hours after its last reply.
import type { AgentInfo } from '../../shared/types';
import { PROMPT_CACHE_TTL_MS } from '../../shared/promptCache';
import { LONG_CONTEXT_THRESHOLD, rateForModel, type Rate } from '../telemetry/pricing';

/** A refresh this long after the cache was last read: well inside the hour, should one be late or fail. */
export const KEEPALIVE_AFTER_MS = 40 * 60_000;
/** Too close to expiry: the request might arrive after the cache is gone and cost full price. */
const LATEST_MS = PROMPT_CACHE_TTL_MS - 2 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Only there to read the cache: the shortest answer will do. */
export const KEEPALIVE_PROMPT = 'Reply with only the word "ok".';

type IdleAgent = Pick<AgentInfo, 'provider' | 'mode' | 'status' | 'endedAt' | 'lastModelActivityAt' | 'telemetry'>
  & Pick<Partial<AgentInfo>, 'idleMode' | 'keepWarmHours' | 'cacheKeepalive'>;

/** Keep-warm needs idle compaction off: Claude Code would otherwise compact the chat being kept warm. */
export function keepWarmAllowed(agent: Pick<Partial<AgentInfo>, 'idleMode' | 'mode'>) {
  return agent.mode === 'chat' && agent.idleMode === 'off';
}

/** This turn's keep-warm record, if any (an older turn's doesn't count). */
function keepaliveForTurn(agent: IdleAgent) {
  const k = agent.cacheKeepalive;
  return k && k.forActivityAt === agent.lastModelActivityAt ? k : null;
}

/** When the prompt cache was last read: the last turn, or a refresh since. */
export function cacheReadAt(agent: IdleAgent): number {
  const stamps = [agent.lastModelActivityAt, keepaliveForTurn(agent)?.lastAt];
  return Math.max(...stamps.map((stamp) => Date.parse(stamp ?? '')).filter(Number.isFinite));
}

/**
 * Whether to refresh the cache now: an idle, live Claude chat kept warm, within its hours since the
 * last reply, whose cache is getting old but not yet gone, and whose refreshes haven't failed.
 */
export function keepaliveDue(agent: IdleAgent, now = Date.now()): boolean {
  if (agent.provider !== 'claude' || agent.endedAt || agent.status !== 'idle' || !keepWarmAllowed(agent)) return false;
  const hours = agent.keepWarmHours ?? 0;
  const turn = Date.parse(agent.lastModelActivityAt ?? '');
  if (!(hours > 0) || !Number.isFinite(turn) || now >= turn + hours * HOUR_MS) return false;
  const current = keepaliveForTurn(agent);
  if (current?.error || current?.pending) return false;
  const age = now - cacheReadAt(agent);
  return age >= KEEPALIVE_AFTER_MS && age <= LATEST_MS;
}

/** List-price estimates for the chat's context: one refresh (a cache read) and one rebuild (a 1-hour cache write). */
export function keepaliveCosts(agent: IdleAgent, rateFor: (model: string | null | undefined) => Rate | null = rateForModel) {
  const t = agent.telemetry;
  const rate = rateFor(t?.model);
  const tokens = t?.contextUsedTokens ?? 0;
  if (!rate || tokens <= 0) return { refreshUsd: null, rebuildUsd: null };
  const multiplier = rate.longContext && tokens > LONG_CONTEXT_THRESHOLD ? 2 : 1;
  const usd = (perMillion: number) => (tokens * perMillion * multiplier) / 1_000_000;
  return {
    refreshUsd: usd(rate.cachedInput ?? rate.input),
    rebuildUsd: usd(rate.cacheWriteLong ?? rate.cacheWrite ?? rate.input)
  };
}

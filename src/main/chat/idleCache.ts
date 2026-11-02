// Keeping an idle Claude chat's prompt cache warm. The cache lives an hour from the last
// request that read it, side questions included, so a tiny side question every
// KEEPALIVE_AFTER_MS keeps it for the chat's keep-warm hours after its last reply.
// With idle compaction on too, Claude Code's own (54 minutes after the reply) is held off
// and the app compacts instead, as long after the last refresh: the warm hours come first.
import type { AgentInfo } from '../../shared/types';
import { PROMPT_CACHE_TTL_MS } from '../../shared/promptCache';
import { LONG_CONTEXT_THRESHOLD, rateForModel, type Rate } from '../telemetry/pricing';

/**
 * A refresh this long after the cache was last read: as late as is safe (fewer refreshes), leaving the
 * minutes until LATEST_MS for one delayed by a busy app. A failed refresh isn't retried either way.
 */
export const KEEPALIVE_AFTER_MS = 55 * 60_000;
/** Too close to expiry: the request might arrive after the cache is gone and cost full price. */
const LATEST_MS = PROMPT_CACHE_TTL_MS - 2 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Only there to read the cache: the shortest answer will do. */
export const KEEPALIVE_PROMPT = 'Reply with only the word "ok".';

type IdleAgent = Pick<AgentInfo, 'provider' | 'mode' | 'status' | 'endedAt' | 'lastModelActivityAt' | 'telemetry'>
  & Pick<Partial<AgentInfo>, 'idleMode' | 'keepWarmHours' | 'cacheKeepalive'>;

/** When Claude Code compacts an idle conversation: shortly before the cache it last read expires. */
export const IDLE_COMPACT_AFTER_MS = 54 * 60_000;

/** Only chats keep their cache warm. */
export function keepWarmAllowed(agent: Pick<Partial<AgentInfo>, 'mode'>) {
  return agent.mode === 'chat';
}

/** Whether Claude Code's own idle compaction runs: not while the chat is kept warm (the app compacts it after). */
export function claudeCompactsIdle(agent: Pick<Partial<AgentInfo>, 'idleMode' | 'keepWarmHours'>) {
  return agent.idleMode === 'compact' && !((agent.keepWarmHours ?? 0) > 0);
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
 * Conversations under `floor` tokens (the idle compaction threshold) aren't worth it: cheap to rebuild.
 */
export function keepaliveDue(agent: IdleAgent, floor: number, now = Date.now()): boolean {
  if (agent.provider !== 'claude' || agent.endedAt || agent.status !== 'idle' || !keepWarmAllowed(agent)) return false;
  if ((agent.telemetry?.contextUsedTokens ?? 0) < floor) return false;
  const hours = agent.keepWarmHours ?? 0;
  const turn = Date.parse(agent.lastModelActivityAt ?? '');
  if (!(hours > 0) || !Number.isFinite(turn) || now >= turn + hours * HOUR_MS) return false;
  const current = keepaliveForTurn(agent);
  if (current?.error || current?.pending) return false;
  const age = now - cacheReadAt(agent);
  return age >= KEEPALIVE_AFTER_MS && age <= LATEST_MS;
}

/**
 * Whether the app should compact now, in place of Claude Code: a chat kept warm with idle compaction
 * on, its warm hours over, its cache as old as Claude Code would let it get, and large enough
 * (`floor` tokens). Once per reply.
 */
export function idleCompactDue(agent: IdleAgent, floor: number, now = Date.now()): boolean {
  if (agent.provider !== 'claude' || agent.endedAt || agent.status !== 'idle' || !keepWarmAllowed(agent)) return false;
  if (agent.idleMode !== 'compact' || claudeCompactsIdle(agent)) return false;
  const turn = Date.parse(agent.lastModelActivityAt ?? '');
  if (!Number.isFinite(turn) || now < turn + (agent.keepWarmHours ?? 0) * HOUR_MS) return false;
  const current = keepaliveForTurn(agent);
  if (current?.compactedAt || current?.pending) return false;
  if ((agent.telemetry?.contextUsedTokens ?? 0) < floor) return false;
  const age = now - cacheReadAt(agent);
  return age >= IDLE_COMPACT_AFTER_MS && age <= LATEST_MS;
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

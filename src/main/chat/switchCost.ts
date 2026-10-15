import type { AgentInfo, SettingsChange, SwitchCost } from '../../shared/types';
import { promptCacheEstimate } from '../../shared/promptCache';
import { LONG_CONTEXT_THRESHOLD, normalizeModelId, rateForModel, type Rate } from '../telemetry/pricing';

const PER_MILLION = 1_000_000;

type Agent = Pick<AgentInfo, 'provider' | 'model' | 'effort' | 'status' | 'endedAt' | 'lastModelActivityAt' | 'telemetry' | 'cacheRebuild'>;

/**
 * Prices the next request's input if `change` is made now, against making no
 * change, both measured from what the cache was built with (the last request).
 * Prompt caches belong to one model, so a new model writes the whole prompt
 * again. Claude also drops its cached conversation when the effort changes
 * (tools and system prompt may survive; counting them as rebuilt makes it an
 * upper bound). Codex keeps its cache across effort levels.
 * `change.model` must be a model id, not an alias the CLI resolves.
 */
export function estimateSwitchCost(agent: Agent, change: SettingsChange, now = Date.now(), rateFor: (model: string | null | undefined) => Rate | null = rateForModel): SwitchCost | null {
  const t = agent.telemetry;
  const last = t?.lastUsage;
  if (!t || !last) return null;
  // Reasoning isn't sent back with the conversation.
  const contextTokens = last.inputTokens + Math.max(0, last.outputTokens - last.reasoningOutputTokens);
  if (contextTokens <= 0) return null;

  const fromModel = t.model ?? agent.model;
  // A pending effort change already replaced agent.effort; the cache was built at the one before.
  const cachedEffort = t.effort ?? (agent.cacheRebuild?.effort !== undefined ? null : agent.effort ?? null);
  const modelChanged = change.model !== undefined && normalizeModelId(change.model) !== normalizeModelId(fromModel);
  const effortChanged = change.effort !== undefined && change.effort !== cachedEffort;
  const rebuild = modelChanged ? 'full' : effortChanged && agent.provider === 'claude' ? 'messages' : 'none';
  const status = promptCacheEstimate(agent, now).status;
  const cacheWarm = status === 'warm' || status === 'active';

  const longWrites = (t.totalUsage?.cacheWriteLongInputTokens ?? 0) > 0;
  const input = (rate: Rate | null, cached: boolean) => {
    if (!rate) return null;
    const perToken = cached
      ? rate.cachedInput ?? rate.input
      : (longWrites ? rate.cacheWriteLong ?? rate.cacheWrite : rate.cacheWrite) ?? rate.input;
    const multiplier = rate.longContext && last.inputTokens > LONG_CONTEXT_THRESHOLD ? 2 : 1;
    return (contextTokens * perToken * multiplier) / PER_MILLION;
  };
  const fromRate = rateFor(fromModel);
  const stayUsd = input(fromRate, cacheWarm);
  const switchUsd = rebuild === 'full' ? input(rateFor(change.model), false) : rebuild === 'messages' ? input(fromRate, false) : stayUsd;
  return {
    contextTokens,
    cacheWarm,
    rebuild,
    stayUsd,
    switchUsd,
    extraUsd: stayUsd !== null && switchUsd !== null ? switchUsd - stayUsd : null
  };
}

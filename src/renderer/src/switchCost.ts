import { useEffect, useReducer, useState } from 'react';
import type { AgentInfo, SettingsChange, SwitchCost } from '@shared/types';
import { promptCacheEstimate } from '@shared/promptCache';
import { call } from './api';
import { compact, modelLabel, usd } from './format';

/** Prices `changes` against the agent's current settings; refreshed as its usage, settings or cache state change. */
export function useSwitchCosts(agent: AgentInfo, changes: SettingsChange[]): Array<SwitchCost | null> {
  const [costs, setCosts] = useState<Array<SwitchCost | null>>([]);
  const [, expire] = useReducer((n: number) => n + 1, 0);
  const cache = promptCacheEstimate(agent);
  const key = JSON.stringify(changes);
  const priced = Boolean(agent.telemetry?.lastUsage) && changes.length > 0;
  useEffect(() => {
    if (!priced) return setCosts([]);
    let current = true;
    call('chat.switchCost', agent.id, changes).then(
      (result) => current && setCosts(result),
      () => current && setCosts([])
    );
    return () => { current = false; };
  }, [agent.id, key, priced, agent.telemetry?.updatedAt, agent.model, agent.effort, agent.cacheRebuild?.at, cache.status]);
  // A warm cache that expires changes every price.
  useEffect(() => {
    if (cache.status !== 'warm' || cache.expiresAt === null) return;
    const timer = setTimeout(expire, Math.max(0, cache.expiresAt - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [cache.status, cache.expiresAt]);
  return costs;
}

function signed(value: number) {
  return `${value < 0 ? '−' : '+'}${usd(Math.abs(value))}`;
}

/** One line for a model or effort menu: what choosing it adds to the next message. */
export function switchCostHint(cost: SwitchCost | null | undefined): string | undefined {
  if (!cost || cost.extraUsd === null) return undefined;
  if (cost.rebuild === 'none') return cost.cacheWarm ? 'Keeps the prompt cache' : undefined;
  const tokens = compact(cost.contextTokens);
  if (!cost.cacheWarm) return `Cache expired · ${signed(cost.extraUsd)} to rebuild ${tokens} tokens here`;
  return `${signed(cost.extraUsd)} next message · re-caches ${cost.rebuild === 'full' ? '' : 'up to '}${tokens} tokens`;
}

/** The notice for a change already made: what the next message's input costs because of it. */
export function switchCostNotice(cost: SwitchCost, model: string | null | undefined): string {
  const tokens = compact(cost.contextTokens);
  const switchUsd = usd(cost.switchUsd);
  const extra = cost.extraUsd === null ? '' : ` (${signed(cost.extraUsd)})`;
  const target = cost.rebuild === 'full' && model ? ` for ${modelLabel(model)}` : '';
  if (!cost.cacheWarm) {
    return `The prompt cache has expired, so the next message rebuilds it${target} anyway: ≈${switchUsd} for ${tokens} tokens of input${extra} against the old settings.`;
  }
  const stay = cost.stayUsd === null ? '' : ` instead of ≈${usd(cost.stayUsd)} read from cache`;
  return cost.rebuild === 'full'
    ? `Next message rebuilds the prompt cache${target}: ≈${switchUsd} for ${tokens} tokens of input${stay}${extra}.`
    : `The effort change makes Claude re-write its cached conversation: up to ≈${switchUsd} for ${tokens} tokens of input${stay}${extra}.`;
}

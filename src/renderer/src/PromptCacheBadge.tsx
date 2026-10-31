import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import type { AgentInfo } from '@shared/types';
import { promptCacheEstimate } from '@shared/promptCache';

/** `iconOnly` keeps just the clock, coloured by state; the label moves to the tooltip. */
export function PromptCacheBadge({ agent, iconOnly = false }: { agent: AgentInfo; iconOnly?: boolean }) {
  const [, tick] = useState(0);
  const cache = promptCacheEstimate(agent);
  // Only warm, inactive sessions need a timer. Read wall time again after sleep or tab changes.
  useEffect(() => {
    if (cache.status !== 'warm') return;
    const refresh = () => tick((value) => value + 1);
    const timer = setInterval(refresh, 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [cache.status, cache.expiresAt]);
  if (cache.status === 'unknown') return null;

  // A model or effort change made since the last request: that request starts from a cold cache.
  const rebuild = Boolean(agent.cacheRebuild) && cache.status !== 'active';
  const status = rebuild ? 'expired' : cache.status;
  const label = rebuild ? 'Rebuilds' : cache.status === 'warm' ? `Warm · ${cache.minutes}m`
    : cache.status === 'expired' ? 'Expired' : 'Cache active';
  const detail = rebuild ? `The ${agent.cacheRebuild?.model !== undefined ? 'model' : 'effort'} changed since the last request, so the next one rebuilds the prompt cache.`
    : cache.status === 'warm' ? `Prompt cache estimated warm: ${cache.minutes} minute${cache.minutes === 1 ? '' : 's'} remaining.`
    : cache.status === 'expired' ? 'Prompt cache estimated expired.'
      : 'Session active. The cache countdown appears when it becomes inactive.';
  const tooltip = `${iconOnly ? `${label}. ` : ''}${detail} Uses a 1-hour inactivity estimate, not live server cache status. Model or prompt changes can invalidate cached content sooner.`;
  return <span className={`prompt-cache ${status}${iconOnly ? ' icon-only' : ''}`} title={tooltip} aria-label={tooltip} tabIndex={0}>
    <Clock size={12} aria-hidden="true" />{iconOnly ? null : <span>{label}</span>}
  </span>;
}

import { describe, expect, it } from 'vitest';
import { estimateSwitchCost } from '../src/main/chat/switchCost';
import { PROMPT_CACHE_TTL_MS } from '../src/shared/promptCache';
import type { AgentInfo, SessionTelemetry, TokenUsage } from '../src/shared/types';

const now = Date.parse('2026-10-14T12:00:00Z');

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWriteLongInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, ...partial };
}

/** An idle session whose last request read a 100K prompt and replied with 10K tokens (2K of them reasoning). */
function agent(provider: 'claude' | 'codex', model: string, extra: { effort?: string; last?: Partial<TokenUsage>; total?: Partial<TokenUsage>; idleMs?: number } = {}) {
  const lastUsage = usage({ inputTokens: 100_000, outputTokens: 10_000, reasoningOutputTokens: 2_000, ...extra.last });
  const telemetry = { model, effort: extra.effort ?? 'high', lastUsage, totalUsage: usage(extra.total ?? {}) } as SessionTelemetry;
  return {
    provider,
    model,
    effort: extra.effort ?? 'high',
    status: 'idle',
    endedAt: null,
    lastModelActivityAt: new Date(now - (extra.idleMs ?? 60_000)).toISOString(),
    telemetry,
    cacheRebuild: null
  } satisfies Partial<AgentInfo> as Parameters<typeof estimateSwitchCost>[0];
}

describe('switch cost estimate', () => {
  it('prices a model switch as writing the whole prompt on the new model instead of reading it from cache', () => {
    const cost = estimateSwitchCost(agent('claude', 'claude-opus-5-5'), { model: 'claude-sonnet-5-5' }, now)!;
    expect(cost).toMatchObject({ contextTokens: 108_000, cacheWarm: true, rebuild: 'full' });
    expect(cost.stayUsd).toBeCloseTo(108_000 * 0.2 / 1e6);
    expect(cost.switchUsd).toBeCloseTo(108_000 * 2.5 / 1e6);
    expect(cost.extraUsd).toBeCloseTo(108_000 * 2.3 / 1e6);
  });

  it('uses the 1-hour write rate when the session writes 1-hour cache entries', () => {
    const cost = estimateSwitchCost(agent('claude', 'claude-opus-5-5', { total: { cacheWriteLongInputTokens: 5_000 } }), { model: 'claude-sonnet-5-5' }, now)!;
    expect(cost.switchUsd).toBeCloseTo(108_000 * 4 / 1e6);
  });

  it('counts a Claude effort change as re-writing the conversation, and a Codex one as free', () => {
    const claude = estimateSwitchCost(agent('claude', 'claude-opus-5-5'), { effort: 'max' }, now)!;
    expect(claude.rebuild).toBe('messages');
    expect(claude.switchUsd).toBeCloseTo(108_000 * 5 / 1e6);
    const codex = estimateSwitchCost(agent('codex', 'gpt-6-sol'), { effort: 'xhigh' }, now)!;
    expect(codex).toMatchObject({ rebuild: 'none', extraUsd: 0 });
  });

  it('treats the same model under another spelling, or the same effort, as no change', () => {
    expect(estimateSwitchCost(agent('claude', 'claude-opus-5-5'), { model: 'claude-opus-5-5[1m]' }, now)).toMatchObject({ rebuild: 'none', extraUsd: 0 });
    expect(estimateSwitchCost(agent('claude', 'claude-opus-5-5'), { effort: 'high' }, now)).toMatchObject({ rebuild: 'none', extraUsd: 0 });
  });

  it('compares against rebuilding anyway once the cache has expired', () => {
    const cost = estimateSwitchCost(agent('claude', 'claude-opus-5-5', { idleMs: PROMPT_CACHE_TTL_MS + 1 }), { model: 'claude-sonnet-5-5' }, now)!;
    expect(cost.cacheWarm).toBe(false);
    expect(cost.stayUsd).toBeCloseTo(108_000 * 5 / 1e6);
    expect(cost.extraUsd).toBeCloseTo(-108_000 * 2.5 / 1e6);
    expect(estimateSwitchCost(agent('claude', 'claude-opus-5-5', { idleMs: PROMPT_CACHE_TTL_MS + 1 }), { effort: 'low' }, now)!.extraUsd).toBe(0);
  });

  it("applies OpenAI's long-context rate above 272K input tokens", () => {
    const cost = estimateSwitchCost(agent('codex', 'gpt-6-sol', { last: { inputTokens: 300_000, outputTokens: 0, reasoningOutputTokens: 0 } }), { model: 'gpt-6-luna' }, now)!;
    expect(cost.switchUsd).toBeCloseTo(300_000 * 0.125 * 2 / 1e6);
  });

  it('measures a further change from what the cache was built with, not a pending change', () => {
    const pending = { ...agent('claude', 'claude-opus-5-5'), model: 'claude-sonnet-5-5', cacheRebuild: { model: 'claude-sonnet-5-5', at: new Date(now).toISOString() } };
    expect(estimateSwitchCost(pending, { model: 'claude-opus-5-5' }, now)).toMatchObject({ rebuild: 'none' });
  });

  it('has nothing to price before the first request, or for a model without a list price', () => {
    expect(estimateSwitchCost({ ...agent('claude', 'claude-opus-5-5'), telemetry: null }, { model: 'claude-sonnet-5-5' }, now)).toBeNull();
    expect(estimateSwitchCost(agent('claude', 'claude-opus-5-5'), { model: 'claude-opus-9' }, now)).toMatchObject({ switchUsd: null, extraUsd: null });
  });
});

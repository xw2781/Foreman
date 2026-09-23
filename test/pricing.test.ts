import { describe, expect, it } from 'vitest';
import { billableTokens, costFromModels, normalizeModelId, priceUsage, rateForModel, recordRequest, type ModelAccumulator } from '../src/main/telemetry/pricing';
import type { TokenUsage } from '../src/shared/types';

function usage(partial: Partial<TokenUsage>): TokenUsage {
  const base = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWriteLongInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const merged = { ...base, ...partial };
  merged.totalTokens = merged.totalTokens || merged.inputTokens + merged.outputTokens;
  return merged;
}

describe('model ids', () => {
  it('strips context tags and date snapshots', () => {
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('GPT-6-Astra')).toBe('gpt-6-astra');
    expect(rateForModel('gpt-5.6')?.model).toBe('gpt-5.6-sol');
  });

  it('never borrows a rate for an unknown model', () => {
    expect(rateForModel('claude-opus-9')).toBeNull();
    expect(rateForModel('')).toBeNull();
  });
});

describe('pricing', () => {
  it("matches Claude Code's own cost for a real Opus 5.5 session", () => {
    // modelUsage from a real cost-state transcript record: Claude Code reported $4.6846498.
    // Claude Code writes 1-hour cache entries, so every cache write is the 2x rate.
    const rate = rateForModel('claude-opus-5-5[1m]')!;
    const cost = priceUsage(
      rate,
      usage({
        inputTokens: 120 + 8_641_509 + 201_346,
        cachedInputTokens: 8_641_509,
        cacheWriteInputTokens: 201_346,
        cacheWriteLongInputTokens: 201_346,
        outputTokens: 67_255
      })
    );
    expect(cost).toBeCloseTo(4.6846498, 6);
  });

  it('prices Fable 5.1 cache reads at its own published rate', () => {
    const rate = rateForModel('claude-fable-5-1')!;
    expect(priceUsage(rate, usage({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }))).toBeCloseTo(0.25, 6);
  });

  it('splits input into uncached, cache read and cache write buckets', () => {
    const t = billableTokens(usage({ inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 300, cacheWriteLongInputTokens: 100, outputTokens: 50 }));
    expect(t).toEqual({ uncachedInput: 100, cachedInput: 600, cacheWriteInput: 200, cacheWriteLongInput: 100, output: 50 });
  });

  it('doubles long-context requests only for models that publish a long-context rate', () => {
    const astra = rateForModel('gpt-6-astra')!;
    const u = usage({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(priceUsage(astra, u, true)).toBeCloseTo(2 * priceUsage(astra, u, false), 9);
    const legacy = rateForModel('gpt-5.4')!;
    expect(priceUsage(legacy, u, true)).toBeCloseTo(priceUsage(legacy, u, false), 9);
  });

  it('reports unpriced models instead of dropping them', () => {
    const byModel = new Map<string, ModelAccumulator>();
    recordRequest(byModel, 'claude-sonnet-5', usage({ inputTokens: 1_000_000 }));
    recordRequest(byModel, 'mystery-model', usage({ inputTokens: 10 }));
    const cost = costFromModels(byModel);
    expect(cost.totalUsd).toBeCloseTo(2, 6);
    expect(cost.unpricedModels).toEqual(['mystery-model']);
  });
});

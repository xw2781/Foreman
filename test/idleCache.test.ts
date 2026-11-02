import { describe, expect, it } from 'vitest';
import { keepaliveCosts, keepaliveDue } from '../src/main/chat/idleCache';
import { promptCacheEstimate } from '../src/shared/promptCache';
import type { Rate } from '../src/main/telemetry/pricing';
import type { AgentInfo, SessionTelemetry } from '../src/shared/types';

const last = Date.parse('2026-11-01T09:00:00Z');
const minutes = (n: number) => last + n * 60_000;
const warm = {
  provider: 'claude' as const,
  mode: 'chat' as const,
  status: 'idle' as const,
  endedAt: null,
  lastModelActivityAt: new Date(last).toISOString(),
  idleMode: 'off' as const,
  keepWarmHours: 3,
  telemetry: { contextUsedTokens: 450_000 } as SessionTelemetry
};
const refreshed = (at: number, count = 1) => ({
  forActivityAt: warm.lastModelActivityAt, lastAt: new Date(at).toISOString(), count, pending: false, error: null, refreshUsd: null, rebuildUsd: null
});

describe('keeping the prompt cache warm', () => {
  it('refreshes 40 minutes after the cache was last read, until the hours run out', () => {
    expect(keepaliveDue(warm, minutes(39))).toBe(false);
    expect(keepaliveDue(warm, minutes(40))).toBe(true);
    // Read again at 40: the next refresh is due at 80, not before.
    const once = { ...warm, cacheKeepalive: refreshed(minutes(40)) };
    expect(keepaliveDue(once, minutes(70))).toBe(false);
    expect(keepaliveDue(once, minutes(80))).toBe(true);
    // Past the 3 hours: no more refreshes.
    expect(keepaliveDue({ ...warm, cacheKeepalive: refreshed(minutes(160), 4) }, minutes(200))).toBe(false);
  });

  it('never refreshes a cache that has probably expired, or after a failure or while one runs', () => {
    expect(keepaliveDue(warm, minutes(59))).toBe(false);
    expect(keepaliveDue({ ...warm, cacheKeepalive: { ...refreshed(minutes(40)), error: 'boom' } }, minutes(80))).toBe(false);
    expect(keepaliveDue({ ...warm, cacheKeepalive: { ...refreshed(minutes(40)), pending: true } }, minutes(80))).toBe(false);
  });

  it('needs an idle, live Claude chat with idle compaction off', () => {
    expect(keepaliveDue({ ...warm, idleMode: 'compact' }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, idleMode: undefined }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, mode: 'interactive' }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, provider: 'codex' }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, status: 'needs-input' }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, endedAt: new Date(minutes(10)).toISOString() }, minutes(40))).toBe(false);
    expect(keepaliveDue({ ...warm, keepWarmHours: 0 }, minutes(40))).toBe(false);
  });

  it('ignores refreshes made for an earlier turn', () => {
    const stale = { ...refreshed(minutes(30)), forActivityAt: new Date(minutes(-200)).toISOString() };
    expect(keepaliveDue({ ...warm, cacheKeepalive: stale }, minutes(40))).toBe(true);
  });

  it('prices a refresh as a cache read and a rebuild as a 1-hour cache write', () => {
    const rate = { input: 4, cachedInput: 0.2, cacheWrite: 5, cacheWriteLong: 8, longContext: false } as Rate;
    const costs = keepaliveCosts({ ...warm, telemetry: { contextUsedTokens: 500_000, model: 'claude-opus-5-5' } as SessionTelemetry }, () => rate);
    expect(costs.refreshUsd).toBeCloseTo(0.1);
    expect(costs.rebuildUsd).toBeCloseTo(4);
  });

  it('counts a refresh as cache activity in the cache estimate', () => {
    const agent = { status: 'idle', endedAt: null, lastModelActivityAt: warm.lastModelActivityAt, telemetry: null } as Pick<AgentInfo, 'status' | 'endedAt' | 'lastModelActivityAt' | 'telemetry'>;
    expect(promptCacheEstimate(agent, minutes(70)).status).toBe('expired');
    expect(promptCacheEstimate({ ...agent, cacheKeepalive: refreshed(minutes(40)) }, minutes(70))).toMatchObject({ status: 'warm', minutes: 30 });
  });
});

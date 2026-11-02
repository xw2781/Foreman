import { describe, expect, it } from 'vitest';
import { claudeCompactsIdle, idleCompactDue, keepaliveCosts, keepaliveDue } from '../src/main/chat/idleCache';
import { promptCacheEstimate } from '../src/shared/promptCache';
import type { Rate } from '../src/main/telemetry/pricing';
import type { AgentInfo, SessionTelemetry } from '../src/shared/types';

const FLOOR = 200_000;
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
  it('refreshes 55 minutes after the cache was last read, until the hours run out', () => {
    expect(keepaliveDue(warm, FLOOR, minutes(54))).toBe(false);
    expect(keepaliveDue(warm, FLOOR, minutes(55))).toBe(true);
    // Read again at 55: the next refresh is due at 110, not before.
    const once = { ...warm, cacheKeepalive: refreshed(minutes(55)) };
    expect(keepaliveDue(once, FLOOR, minutes(100))).toBe(false);
    expect(keepaliveDue(once, FLOOR, minutes(110))).toBe(true);
    // Past the 3 hours: no more refreshes.
    expect(keepaliveDue({ ...warm, cacheKeepalive: refreshed(minutes(165), 3) }, FLOOR, minutes(220))).toBe(false);
  });

  it('never refreshes a cache that has probably expired, or after a failure or while one runs', () => {
    expect(keepaliveDue(warm, FLOOR, minutes(59))).toBe(false);
    expect(keepaliveDue({ ...warm, cacheKeepalive: { ...refreshed(minutes(55)), error: 'boom' } }, FLOOR, minutes(110))).toBe(false);
    expect(keepaliveDue({ ...warm, cacheKeepalive: { ...refreshed(minutes(55)), pending: true } }, FLOOR, minutes(110))).toBe(false);
  });

  it('needs an idle, live Claude chat at least as large as the idle compaction threshold', () => {
    expect(keepaliveDue({ ...warm, idleMode: 'compact' }, FLOOR, minutes(55))).toBe(true);
    expect(keepaliveDue({ ...warm, telemetry: { contextUsedTokens: 150_000 } as SessionTelemetry }, FLOOR, minutes(55))).toBe(false);
    expect(keepaliveDue({ ...warm, mode: 'interactive' }, FLOOR, minutes(55))).toBe(false);
    expect(keepaliveDue({ ...warm, provider: 'codex' }, FLOOR, minutes(55))).toBe(false);
    expect(keepaliveDue({ ...warm, status: 'needs-input' }, FLOOR, minutes(55))).toBe(false);
    expect(keepaliveDue({ ...warm, endedAt: new Date(minutes(10)).toISOString() }, FLOOR, minutes(55))).toBe(false);
    expect(keepaliveDue({ ...warm, keepWarmHours: 0 }, FLOOR, minutes(55))).toBe(false);
  });

  it('holds Claude Code idle compaction off while kept warm, and compacts 54 minutes after the last refresh', () => {
    const compacting = { ...warm, idleMode: 'compact' as const };
    expect(claudeCompactsIdle(compacting)).toBe(false);
    expect(claudeCompactsIdle({ ...compacting, keepWarmHours: 0 })).toBe(true);
    // Last refresh at 160 (the 3 hours end at 180): compaction at 214, before the cache expires.
    const done = { ...compacting, cacheKeepalive: refreshed(minutes(160), 4) };
    expect(idleCompactDue(done, FLOOR, minutes(170))).toBe(false);
    expect(idleCompactDue(done, FLOOR, minutes(213))).toBe(false);
    expect(idleCompactDue(done, FLOOR, minutes(214))).toBe(true);
    expect(idleCompactDue(done, FLOOR, minutes(219))).toBe(false);
    expect(idleCompactDue({ ...done, idleMode: 'off' }, FLOOR, minutes(214))).toBe(false);
    expect(idleCompactDue({ ...done, cacheKeepalive: { ...done.cacheKeepalive, compactedAt: new Date(minutes(214)).toISOString() } }, FLOOR, minutes(215))).toBe(false);
    expect(idleCompactDue(done, 500_000, minutes(214))).toBe(false);
  });

  it('ignores refreshes made for an earlier turn', () => {
    const stale = { ...refreshed(minutes(30)), forActivityAt: new Date(minutes(-200)).toISOString() };
    expect(keepaliveDue({ ...warm, cacheKeepalive: stale }, FLOOR, minutes(55))).toBe(true);
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

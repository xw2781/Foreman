import { describe, expect, it } from 'vitest';
import { claudeIdleCompaction, idleCompactFloor, splitArgs } from '../src/main/commands';
import { parseStatusPayload } from '../src/main/statusLine';

describe('idle compaction', () => {
  it('leaves Claude Code alone by default', () => {
    expect(claudeIdleCompaction('compact', { claudeIdleCompactMinTokens: 0 })).toEqual({ settings: {}, env: {} });
  });

  it('turns it off through the settings file and passes a raised floor as env', () => {
    expect(claudeIdleCompaction('off', { claudeIdleCompactMinTokens: 400_000 })).toEqual({ settings: { idleCompaction: false }, env: {} });
    expect(claudeIdleCompaction('compact', { claudeIdleCompactMinTokens: 400_000 }).env).toEqual({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '400000' });
    expect(claudeIdleCompaction('compact', { claudeIdleCompactMinTokens: 50_000 }).env).toEqual({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '100000' });
  });

  it('holds it off for a chat kept warm, keeping the floor for when it comes back', () => {
    expect(claudeIdleCompaction('compact', { claudeIdleCompactMinTokens: 400_000 }, true)).toEqual({ settings: { idleCompaction: false }, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '400000' } });
    expect(idleCompactFloor({ claudeIdleCompactMinTokens: 0 })).toBe(200_000);
    expect(idleCompactFloor({ claudeIdleCompactMinTokens: 50_000 })).toBe(100_000);
  });
});

describe('command lines', () => {
  it('splits extra arguments like a shell', () => {
    expect(splitArgs('--add-dir "C:\\My Folder" --search \'a b\'')).toEqual(['--add-dir', 'C:\\My Folder', '--search', 'a b']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('status payload', () => {
  it('reads context, cost and plan limits', () => {
    const snapshot = parseStatusPayload(
      {
        model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
        context_window: { context_window_size: 1_000_000, used_percentage: 29.4, total_input_tokens: 294_000 },
        cost: { total_cost_usd: 8.67 },
        rate_limits: { five_hour: { used_percentage: 63, resets_at: 1790000000 }, seven_day: { used_percentage: 36, resets_at: '2026-09-30T11:00:00Z' } }
      },
      Date.parse('2026-09-23T15:00:00Z')
    );
    expect(snapshot.contextWindow).toBe(1_000_000);
    expect(snapshot.costUsd).toBe(8.67);
    expect(snapshot.limits?.windows).toEqual([
      { id: 'five_hour', label: '5-hour', usedPercent: 63, resetsAt: new Date(1790000000 * 1000).toISOString() },
      { id: 'seven_day', label: 'Weekly', usedPercent: 36, resetsAt: '2026-09-30T11:00:00.000Z' }
    ]);
  });
});

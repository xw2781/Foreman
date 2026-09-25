import { describe, expect, it } from 'vitest';
import { parseClaudeUsage, parseCodexUsage } from '../src/main/planUsage';

const AT = '2026-09-25T19:24:06.000Z';

describe('Claude usage endpoint', () => {
  it('reads the 5-hour and weekly windows of a subscription', () => {
    const limits = parseClaudeUsage(
      {
        five_hour: { utilization: 5, resets_at: '2026-09-25T22:40:00.449414+00:00' },
        seven_day: { utilization: 35, resets_at: '2026-09-30T11:00:00.449434+00:00' },
        limits: [
          { kind: 'session', group: 'session', percent: 5, resets_at: '2026-09-25T22:40:00.449414+00:00', scope: null },
          { kind: 'weekly_all', group: 'weekly', percent: 35, resets_at: '2026-09-30T11:00:00.449434+00:00', scope: null },
          { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-09-30T11:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
          { kind: 'something_new', percent: 50 }
        ],
        spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false }
      },
      AT
    );
    expect(limits).toEqual({
      observedAt: AT,
      planType: null,
      windows: [
        { id: 'five_hour', label: '5-hour', usedPercent: 5, resetsAt: '2026-09-25T22:40:00.449414+00:00' },
        { id: 'seven_day', label: 'Weekly', usedPercent: 35, resetsAt: '2026-09-30T11:00:00.449434+00:00' },
        { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 0, resetsAt: '2026-09-30T11:00:00+00:00' }
      ]
    });
  });

  it('reads the monthly spend cap of an Enterprise seat', () => {
    const limits = parseClaudeUsage(
      {
        extra_usage: { is_enabled: true, monthly_limit: 13000, used_credits: 12817, utilization: 98.59, currency: 'USD' },
        limits: [],
        spend: {
          used: { amount_minor: 12817, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 13000, currency: 'USD', exponent: 2 },
          percent: 99,
          severity: 'critical',
          enabled: true
        }
      },
      AT
    );
    expect(limits?.windows).toEqual([{ id: 'monthly_spend', label: 'Monthly spend', usedPercent: 99, resetsAt: null, detail: '$128.17 / $130.00' }]);
  });

  it('falls back to the older per-window fields', () => {
    const limits = parseClaudeUsage({ five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 40, resets_at: null }, seven_day_opus: null }, AT);
    expect(limits?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 12],
      ['Weekly', 40]
    ]);
  });

  it('reports nothing for an empty or unexpected body', () => {
    expect(parseClaudeUsage({ limits: [], spend: { enabled: false } }, AT)).toBeNull();
    expect(parseClaudeUsage('nope', AT)).toBeNull();
  });
});

describe('Codex usage endpoint', () => {
  it('reads the rate-limit windows of a ChatGPT plan under the rollout ids', () => {
    const limits = parseCodexUsage(
      {
        plan_type: 'prolite',
        rate_limit: { allowed: true, primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_after_seconds: 194023, reset_at: 1790559287 }, secondary_window: null },
        credits: { has_credits: false, balance: '0' },
        spend_control: { reached: false, individual_limit: null }
      },
      AT
    );
    expect(limits).toEqual({
      observedAt: AT,
      planType: 'prolite',
      windows: [{ id: 'primary', label: 'Weekly', usedPercent: 8, resetsAt: new Date(1790559287 * 1000).toISOString() }]
    });
  });

  it('reads the per-seat credit allowance of a Business workspace', () => {
    const limits = parseCodexUsage(
      {
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          reached: false,
          individual_limit: { source: 'group_based_spend_controls', unit: 'credit', limit: '500', used: '226.64161503314972', remaining: '273.3583849668503', used_percent: 45, reset_at: 1790812800 }
        }
      },
      AT
    );
    expect(limits?.planType).toBe('business');
    expect(limits?.windows).toHaveLength(1);
    expect(limits?.windows[0]).toMatchObject({ id: 'credits', label: 'Credits', resetsAt: '2026-10-01T00:00:00.000Z', detail: '226.6 / 500' });
    expect(limits?.windows[0].usedPercent).toBeCloseTo(45.33, 2);
  });

  it('reports nothing without windows or an allowance', () => {
    expect(parseCodexUsage({ rate_limit: null, spend_control: { individual_limit: null } }, AT)).toBeNull();
  });
});

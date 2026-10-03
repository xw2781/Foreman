import { describe, expect, it } from 'vitest';
import { promptCacheEstimate, PROMPT_CACHE_TTL_MS } from '../src/shared/promptCache';
import type { AgentInfo, SessionTelemetry } from '../src/shared/types';

const start = Date.parse('2026-10-02T12:00:00Z');
const session = { status: 'idle' as const, endedAt: null, lastModelActivityAt: new Date(start).toISOString(), telemetry: null };

describe('prompt cache inactivity estimate', () => {
  it('counts down rounded-up minutes and expires exactly at one hour', () => {
    expect(promptCacheEstimate(session, start)).toMatchObject({ status: 'warm', minutes: 60 });
    expect(promptCacheEstimate(session, start + 60_000)).toMatchObject({ status: 'warm', minutes: 59 });
    expect(promptCacheEstimate(session, start + PROMPT_CACHE_TTL_MS - 1)).toMatchObject({ status: 'warm', minutes: 1 });
    expect(promptCacheEstimate(session, start + PROMPT_CACHE_TTL_MS)).toMatchObject({ status: 'expired', minutes: 0 });
    expect(promptCacheEstimate(session, start + 3 * PROMPT_CACHE_TTL_MS)).toMatchObject({ status: 'expired', minutes: 0 });
  });

  it('only shows a countdown when inactive, including approval waits and stopped sessions', () => {
    for (const status of ['starting', 'working'] as const) {
      expect(promptCacheEstimate({ ...session, status }, start)).toMatchObject({ status: 'active', minutes: null });
    }
    for (const status of ['idle', 'needs-input', 'stopped', 'done', 'failed'] as const) {
      expect(promptCacheEstimate({ ...session, status }, start + 120_000)).toMatchObject({ status: 'warm', minutes: 58 });
    }
    expect(promptCacheEstimate({ ...session, status: 'working', endedAt: new Date(start).toISOString() }, start + PROMPT_CACHE_TTL_MS).status).toBe('expired');
  });

  it('does not warm a new session or reset an old session just because it was opened', () => {
    expect(promptCacheEstimate({ ...session, lastModelActivityAt: null }, start).status).toBe('unknown');
    const reopened = { ...session, lastActivityAt: new Date(start + PROMPT_CACHE_TTL_MS).toISOString(), lastOutputAt: new Date(start + PROMPT_CACHE_TTL_MS).toISOString() };
    expect(promptCacheEstimate(reopened, start + PROMPT_CACHE_TTL_MS).status).toBe('expired');
    expect(promptCacheEstimate({ ...session, lastModelActivityAt: 'invalid' }, start).status).toBe('unknown');
    expect(promptCacheEstimate(session, start - 60_000).minutes).toBe(60);
  });

  it('uses persisted telemetry for either provider and picks newer model activity', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const telemetry = { provider, requests: 2, updatedAt: new Date(start + 300_000).toISOString() } as SessionTelemetry;
      const agent = { ...session, provider, telemetry } as AgentInfo;
      expect(promptCacheEstimate(agent, start + 600_000)).toMatchObject({ status: 'warm', minutes: 55 });
      expect(promptCacheEstimate({ ...agent, lastModelActivityAt: undefined }, start + 600_000).minutes).toBe(55);
      expect(promptCacheEstimate({ ...agent, lastModelActivityAt: null, telemetry: { ...telemetry, requests: 0 } }, start).status).toBe('unknown');
    }
  });
});

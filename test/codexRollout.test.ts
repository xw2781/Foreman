import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexRolloutParser, parseCodexRateLimits } from '../src/main/telemetry/codexRollout';
import { priceUsage, rateForModel } from '../src/main/telemetry/pricing';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-codex-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ID = '019f904e-b62d-7bc3-ae58-f64b11530186';

function tokenCount(total: { input: number; cached: number; output: number }, last: { input: number; cached: number; output: number }, timestamp: string) {
  const u = (v: { input: number; cached: number; output: number }) => ({ input_tokens: v.input, cached_input_tokens: v.cached, output_tokens: v.output, reasoning_output_tokens: 0, total_tokens: v.input + v.output });
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: u(total), last_token_usage: u(last), model_context_window: 400_000 },
      rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1790559287 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1790959287 }, plan_type: 'pro' }
    }
  });
}

describe('Codex rollout parser', () => {
  it('prices each usage delta, applying the long-context rate only where it applies', async () => {
    const file = path.join(dir, `rollout-2026-09-23T10-00-00-${ID}.jsonl`);
    const lines = [
      JSON.stringify({ timestamp: '2026-09-23T14:00:00.000Z', type: 'session_meta', payload: { id: ID, cwd: 'C:\\work\\repo', originator: 'codex_cli_rs', thread_source: 'user' } }),
      JSON.stringify({ timestamp: '2026-09-23T14:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high', cwd: 'C:\\work\\repo' } }),
      JSON.stringify({ timestamp: '2026-09-23T14:00:02.000Z', type: 'event_msg', payload: { type: 'task_started', model_context_window: 400_000 } }),
      JSON.stringify({ timestamp: '2026-09-23T14:00:02.500Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add a changelog entry' } }),
      JSON.stringify({ timestamp: '2026-09-23T14:00:03.000Z', type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(100) }] } }),
      tokenCount({ input: 100_000, cached: 0, output: 1_000 }, { input: 100_000, cached: 0, output: 1_000 }, '2026-09-23T14:00:04.000Z'),
      // Same totals re-reported: no new request.
      tokenCount({ input: 100_000, cached: 0, output: 1_000 }, { input: 100_000, cached: 0, output: 1_000 }, '2026-09-23T14:00:05.000Z'),
      tokenCount({ input: 400_000, cached: 50_000, output: 2_000 }, { input: 300_000, cached: 50_000, output: 1_000 }, '2026-09-23T14:00:06.000Z'),
      JSON.stringify({ timestamp: '2026-09-23T14:00:07.000Z', type: 'event_msg', payload: { type: 'task_complete' } })
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const state = await new CodexRolloutParser(file).update();
    expect(state.sessionId).toBe(ID);
    expect(state.model).toBe('gpt-6-astra');
    expect(state.taskActive).toBe(false);
    expect(state.requests).toBe(2);
    expect(state.firstPrompt).toBe('Add a changelog entry');
    const rate = rateForModel('gpt-6-astra')!;
    const first = priceUsage(rate, { inputTokens: 100_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheWriteLongInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 0, totalTokens: 101_000 });
    const second = priceUsage(rate, { inputTokens: 300_000, cachedInputTokens: 50_000, cacheWriteInputTokens: 0, cacheWriteLongInputTokens: 0, outputTokens: 1_000, reasoningOutputTokens: 0, totalTokens: 301_000 }, true);
    expect(state.byModel.get('gpt-6-astra')?.usd).toBeCloseTo(first + second, 9);
    expect(state.limits?.windows.map((w) => w.label)).toEqual(['5-hour', 'Weekly']);
    expect(state.limits?.planType).toBe('pro');
  });

  it('turns rate-limit epochs into ISO reset times', () => {
    const limits = parseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 10080, resets_at: 1790559287 } }, '2026-09-22T17:09:30.994Z');
    expect(limits?.windows[0]).toEqual({ id: 'primary', label: 'Weekly', usedPercent: 5, resetsAt: new Date(1790559287 * 1000).toISOString() });
  });
});

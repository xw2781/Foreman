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
  it('recovers a migrated child turn even when every record has the fork timestamp', () => {
    const parser = new CodexRolloutParser('migrated-child.jsonl');
    const stamp = '2026-07-25T14:56:05.457Z';
    const childId = '019f99c6-b6d0-7032-92e1-c9d3ac2d3241';
    const turnId = '019f99c6-b9b8-7872-9e92-9342922e008c';
    parser.consume(JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { id: childId, forked_from_id: 'parent', history_mode: 'paginated' } }));
    parser.consume(JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }));
    // Real counters from a migrated July 25 child: only last request belongs
    // to the child on the first observation, not the 124M inherited baseline.
    parser.consume(tokenCount({ input: 123946900, cached: 120568064, output: 370912 }, { input: 27942, cached: 13056, output: 185 }, stamp));
    const next = tokenCount({ input: 123977667, cached: 120595456, output: 370979 }, { input: 30767, cached: 27392, output: 67 }, stamp);
    parser.consume(next);
    parser.consume(next); // duplicate status notification
    expect(parser.state.requests).toBe(2);
    expect(parser.state.totalUsage?.totalTokens).toBe(28127 + 30834);
    expect([...parser.state.byDay.values()].reduce((sum, day) => sum + day.tokens, 0)).toBe(58961);
  });

  it('skips inherited and synthetic turns before the child begins its own migrated turn', () => {
    const parser = new CodexRolloutParser('mixed-history.jsonl');
    const stamp = '2026-07-25T16:38:06.341Z';
    const childId = '019f9a24-1c78-7da2-aadc-e637e7739404';
    const start = (turn_id: string) => parser.consume(JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'task_started', turn_id } }));
    parser.consume(JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { id: childId, forked_from_id: 'parent' } }));
    start('019f9a1b-bf42-7460-bb53-1961ab149967'); // older parent's turn
    parser.consume(tokenCount({ input: 1000000, cached: 0, output: 100 }, { input: 10000, cached: 0, output: 10 }, stamp));
    start('rollout-4'); // synthesized history, not evidence of new child work
    parser.consume(tokenCount({ input: 1100000, cached: 0, output: 200 }, { input: 100000, cached: 0, output: 100 }, stamp));
    expect(parser.state.requests).toBe(0);
    start('019f9a24-1f94-7a82-9be6-c18876a0e79e');
    parser.consume(tokenCount({ input: 1120000, cached: 0, output: 400 }, { input: 20000, cached: 0, output: 200 }, stamp));
    expect(parser.state.totalUsage?.totalTokens).toBe(20200);
    expect(parser.state.requests).toBe(1);
  });

  it('excludes a fork baseline and replayed requests, including incremental updates', async () => {
    const file = path.join(dir, 'fork.jsonl');
    const stamp = '2026-07-25T16:38:06.341Z';
    const baseline = { input: 159_921_065, cached: 155_784_960, output: 475_967 };
    const replayed = { input: baseline.input + 10_000, cached: baseline.cached + 8_000, output: baseline.output + 100 };
    const request = { input: 20_000, cached: 15_000, output: 200 };
    fs.writeFileSync(file, [
      JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { id: ID, forked_from_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } }),
      JSON.stringify({ timestamp: stamp, type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
      tokenCount(baseline, { input: 0, cached: 0, output: 0 }, stamp),
      tokenCount(replayed, { input: 10_000, cached: 8_000, output: 100 }, stamp)
    ].join('\n') + '\n');
    const parser = new CodexRolloutParser(file);
    expect((await parser.update()).requests).toBe(0);
    expect(parser.state.totalUsage?.totalTokens).toBe(0);
    const next = { input: replayed.input + request.input, cached: replayed.cached + request.cached, output: replayed.output + request.output };
    fs.appendFileSync(file, tokenCount(next, request, '2026-07-25T16:39:00Z') + '\n' + tokenCount(next, request, '2026-07-25T16:39:01Z') + '\n');
    const state = await parser.update();
    expect(state.requests).toBe(1);
    expect(state.totalUsage?.totalTokens).toBe(20_200);
    expect([...state.byDay.values()].reduce((sum, day) => sum + day.tokens, 0)).toBe(20_200);
    expect(state.byModel.get('gpt-6-astra')?.usage.totalTokens).toBe(20_200);
    // File replacement must clear the inherited baseline as well.
    fs.writeFileSync(file, tokenCount(request, request, '2026-07-25T17:00:00Z') + '\n');
    expect((await parser.update()).totalUsage?.totalTokens).toBe(20_200);
  });

  it('counts fresh subagent usage and counter resets without losing previous usage', () => {
    const parser = new CodexRolloutParser('fresh.jsonl');
    parser.consume(JSON.stringify({ timestamp: '2026-07-25T12:00:00Z', type: 'session_meta', payload: { source: { subagent: {} } } }));
    parser.consume(tokenCount({ input: 100, cached: 0, output: 10 }, { input: 100, cached: 0, output: 10 }, '2026-07-25T12:00:01Z'));
    parser.consume(tokenCount({ input: 20, cached: 0, output: 2 }, { input: 20, cached: 0, output: 2 }, '2026-07-25T12:00:02Z'));
    expect(parser.state.totalUsage?.totalTokens).toBe(132);
    expect(parser.state.requests).toBe(2);
  });

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

  it('takes the title from a UserMessage item when there is no user_message event', () => {
    const parser = new CodexRolloutParser('fresh.jsonl');
    parser.consume(JSON.stringify({ timestamp: '2026-10-06T15:07:47.453Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'create an exe' }] } } }));
    parser.consume(JSON.stringify({ timestamp: '2026-10-06T15:07:50.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'ok' }] } } }));
    expect(parser.state.firstPrompt).toBe('create an exe');
  });

  it('turns rate-limit epochs into ISO reset times', () => {
    const limits = parseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 10080, resets_at: 1790559287 } }, '2026-09-22T17:09:30.994Z');
    expect(limits?.windows[0]).toEqual({ id: 'primary', label: 'Weekly', usedPercent: 5, resetsAt: new Date(1790559287 * 1000).toISOString() });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeTranscriptParser, claudeContextWindow, claudeTitle, sessionIdForTranscript } from '../src/main/telemetry/claudeTranscript';
import { claudeContextUsed } from '../src/main/telemetry/engine';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-claude-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = '11111111-2222-3333-4444-555555555555';

function assistant(requestId: string, stop: string | null, u: Record<string, number>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    cwd: 'C:\\work\\repo',
    version: '2.1.280',
    requestId,
    timestamp: '2026-09-23T10:00:00.000Z',
    message: { id: `msg_${requestId}`, model: 'claude-opus-5-5', stop_reason: stop, usage: u },
    ...extra
  });
}

function user(text: string) {
  return JSON.stringify({ type: 'user', isSidechain: false, cwd: 'C:\\work\\repo', sessionId: SESSION, timestamp: '2026-09-23T09:59:00.000Z', message: { role: 'user', content: text } });
}

describe('Claude transcript parser', () => {
  it('bills each request once, skips synthetic turns, and tracks turn state', async () => {
    const file = path.join(dir, 'projects', 'C--work-repo', `${SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      user('fix the failing test'),
      // One response written as two content-block lines repeating the same usage.
      assistant('req_1', 'tool_use', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 }),
      assistant('req_1', 'tool_use', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 }),
      assistant('synthetic', null, { input_tokens: 0, output_tokens: 0 })
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const parser = new ClaudeTranscriptParser(file);
    let state = await parser.update();
    expect(state.requests).toBe(1);
    expect(state.totals.inputTokens).toBe(6010);
    expect(state.totals.cachedInputTokens).toBe(5000);
    expect(state.turn).toBe('working');
    expect(state.cwd).toBe('C:\\work\\repo');

    // Appended lines are the only ones parsed on the next update.
    fs.appendFileSync(file, `${assistant('req_2', 'end_turn', { input_tokens: 5, cache_read_input_tokens: 6000, output_tokens: 50 })}\n`);
    state = await parser.update();
    expect(state.requests).toBe(2);
    expect(state.turn).toBe('done');
    expect(state.lastUsage?.inputTokens).toBe(6005);
    expect(state.byModel.get('claude-opus-5-5')?.requests).toBe(2);
    expect(state.byDay.size).toBe(1);
  });

  it('counts a compaction boundary and its summary once', async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-09-23T11:00:00.000Z' }),
      JSON.stringify({ type: 'user', isCompactSummary: true, parentUuid: 'b1', timestamp: '2026-09-23T11:00:01.000Z', message: { content: 'summary' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, parentUuid: 'other', timestamp: '2026-09-23T12:00:01.000Z', message: { content: 'summary' } })
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const state = await new ClaudeTranscriptParser(file).update();
    expect(state.compactions).toBe(2);
    expect(state.lastCompactionAt).toBe('2026-09-23T12:00:01.000Z');
  });

  it('takes the context size from a compaction until the next request runs', async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    const big = { input_tokens: 5, cache_read_input_tokens: 480_000, output_tokens: 100 };
    const lines = [
      assistant('req_1', 'end_turn', big),
      // An idle compaction: nothing is sent after it until the person comes back.
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-09-23T11:00:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 480_005, postTokens: 11_585 } })
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const parser = new ClaudeTranscriptParser(file);
    let state = await parser.update();
    expect(claudeContextUsed(state)).toBe(11_585);
    expect(state.lastUsage?.inputTokens).toBe(480_005);

    fs.appendFileSync(file, `${assistant('req_2', 'end_turn', { input_tokens: 20, cache_creation_input_tokens: 12_000, output_tokens: 50 })}\n`);
    state = await parser.update();
    expect(state.contextAfterCompaction).toBeNull();
    expect(claudeContextUsed(state)).toBe(12_020);
  });

  it('prefers a custom title, then the AI title, then the first prompt', async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'last-prompt', lastPrompt: 'please refactor the parser\nand more', sessionId: SESSION }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Refactor parser', sessionId: SESSION })
      ].join('\n') + '\n'
    );
    const parser = new ClaudeTranscriptParser(file);
    let state = await parser.update();
    expect(claudeTitle({ ...state, aiTitle: null })).toBe(claudeTitle({ ...state, aiTitle: null, lastPrompt: 'a later prompt' }));
    expect(claudeTitle(state)).toBe('Refactor parser');
    fs.appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'My rename', sessionId: SESSION })}\n`);
    state = await parser.update();
    expect(claudeTitle(state)).toBe('My rename');
  });

  it("reads Claude Code's own cost and context tag from cost-state records", async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(
      file,
      [
        assistant('req_1', 'end_turn', { input_tokens: 10, output_tokens: 5 }),
        JSON.stringify({ type: 'cost-state', totalCostUSD: 4.68, modelUsage: { 'claude-opus-5-5[1m]': { costUSD: 4.68 } } })
      ].join('\n') + '\n'
    );
    const state = await new ClaudeTranscriptParser(file).update();
    expect(state.reportedCostUsd).toBe(4.68);
    expect(claudeContextWindow(state, 200_000, 500_000, {})).toEqual({ window: 1_000_000, assumed: false });
    expect(claudeContextWindow(state, 200_000, 500_000, { 'claude-opus-5-5': 300_000 })).toEqual({ window: 300_000, assumed: true });
  });

  it("keeps the latest cost-state record's tokens and cost per model", async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    const record = (modelUsage: Record<string, unknown>) => JSON.stringify({ type: 'cost-state', totalCostUSD: 1, modelUsage });
    fs.writeFileSync(
      file,
      [
        record({ 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, costUSD: 0.5 } }),
        record({
          'claude-sonnet-5-5[1m]': { inputTokens: 80, outputTokens: 29_885, thinkingTokens: 5_663, cacheReadInputTokens: 3_340_077, cacheCreationInputTokens: 95_078, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 95_078, webSearchRequests: 0, costUSD: 1.0133297 },
          'claude-haiku-5-5': { inputTokens: 24_922, outputTokens: 1_707, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, webSearchRequests: 2, costUSD: 0.0233457 },
          'claude-haiku-4-5-20251001': { inputTokens: 971, outputTokens: 13, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.001036 }
        })
      ].join('\n') + '\n'
    );
    const { reportedByModel } = await new ClaudeTranscriptParser(file).update();
    expect(Object.keys(reportedByModel).sort()).toEqual(['claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(reportedByModel['claude-sonnet-5-5']).toEqual({
      usage: { inputTokens: 80 + 3_340_077 + 95_078, cachedInputTokens: 3_340_077, cacheWriteInputTokens: 95_078, cacheWriteLongInputTokens: 95_078, outputTokens: 29_885, reasoningOutputTokens: 5_663, totalTokens: 80 + 3_340_077 + 95_078 + 29_885 },
      usd: 1.0133297,
      exact: true
    });
    // Web searches are billed per request, and older records don't say how long cache writes last.
    expect(reportedByModel['claude-haiku-5-5'].exact).toBe(false);
    expect(reportedByModel['claude-haiku-4-5'].exact).toBe(false);
  });

  it('attributes subagent transcripts to their parent session', () => {
    expect(sessionIdForTranscript(path.join('C:', 'u', '.claude', 'projects', 'C--repo', SESSION, 'subagents', 'agent-abc.jsonl'))).toBe(SESSION);
    expect(sessionIdForTranscript(path.join('C:', 'u', '.claude', 'projects', 'C--repo', `${SESSION}.jsonl`))).toBe(SESSION);
  });
});

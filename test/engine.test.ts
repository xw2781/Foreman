import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetryEngine } from '../src/main/telemetry/engine';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-engine-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CODEX_ID = '019f904e-b62d-7bc3-ae58-f64b11530186';

function write(file: string, lines: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('usage report', () => {
  it('merges subagent spend into its session and groups spend by day, tool and account', async () => {
    const now = new Date();
    const stamp = now.toISOString();
    const claudeDir = path.join(root, 'claude');
    const codexDir = path.join(root, 'codex');
    const project = path.join(claudeDir, 'projects', 'C--work');
    const assistant = (id: string, input: number, output: number) => ({
      type: 'assistant', cwd: 'C:\\work', sessionId: SESSION, requestId: id, timestamp: stamp,
      message: { id, model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: output } }
    });
    write(path.join(project, `${SESSION}.jsonl`), [{ type: 'ai-title', aiTitle: 'Main work' }, assistant('r1', 1_000_000, 0)]);
    write(path.join(project, SESSION, 'subagents', 'agent-1.jsonl'), [{ ...assistant('r2', 0, 100_000), isSidechain: true }]);
    const day = path.join(codexDir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    write(path.join(day, `rollout-x-${CODEX_ID}.jsonl`), [
      { timestamp: stamp, type: 'session_meta', payload: { id: CODEX_ID, cwd: 'C:\\work' } },
      { timestamp: stamp, type: 'turn_context', payload: { model: 'gpt-5.4' } },
      { timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000_000, output_tokens: 0 }, last_token_usage: { input_tokens: 1_000_000, output_tokens: 0 }, model_context_window: 272000 } } }
    ]);

    const engine = new TelemetryEngine(null);
    engine.configure(
      [
        { id: 'claude-a', provider: 'claude', configDir: claudeDir },
        { id: 'codex-a', provider: 'codex', configDir: codexDir }
      ],
      { usageDays: 7 }
    );
    const report = await engine.usageReport(true);
    // Sonnet 5: $2/M input + $10/M output = 2 + 1; GPT-5.4: $2.50/M input.
    expect(report.totals.today).toBeCloseTo(5.5, 6);
    const today = report.days[report.days.length - 1];
    expect(today.byProvider.claude).toBeCloseTo(3, 6);
    expect(today.byProvider.codex).toBeCloseTo(2.5, 6);
    expect(today.byProfile['claude-a']).toBeCloseTo(3, 6);
    const claudeSession = report.sessions.find((s) => s.provider === 'claude');
    expect(claudeSession?.title).toBe('Main work');
    expect(claudeSession?.costUsd).toBeCloseTo(3, 6);
    expect(claudeSession?.requests).toBe(2);
    expect(report.sessions.filter((s) => s.provider === 'claude')).toHaveLength(1);
  });

  it('finds the rollout a freshly launched Codex agent wrote', async () => {
    const codexDir = path.join(root, 'codex');
    const now = new Date();
    const day = path.join(codexDir, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    const since = Date.now() - 1000;
    write(path.join(day, `rollout-a-${CODEX_ID}.jsonl`), [{ timestamp: now.toISOString(), type: 'session_meta', payload: { id: CODEX_ID, cwd: 'C:\\Work\\Repo' } }]);
    const engine = new TelemetryEngine(null);
    expect(await engine.findCodexRollout(codexDir, 'c:\\work\\repo', since, [])).toContain(CODEX_ID);
    expect(await engine.findCodexRollout(codexDir, 'C:\\other', since, [])).toBeNull();
    expect(await engine.findCodexRolloutById(codexDir, CODEX_ID)).toContain(CODEX_ID);
  });
});

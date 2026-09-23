import { describe, expect, it } from 'vitest';
import { claudeCommand, codexCommand, splitArgs } from '../src/main/commands';
import { parseStatusPayload, defaultStatusText } from '../src/main/statusLine';
import { ClaudeStreamFormatter } from '../src/main/streamFormat';
import type { Profile } from '../src/shared/types';

const isolated: Profile = { id: 'codex-work', provider: 'codex', label: 'Work', color: 'slot-5', configDir: 'C:\\p', builtin: false, createdAt: '' };
const builtin: Profile = { ...isolated, id: 'codex-default', builtin: true };

describe('command lines', () => {
  it('pins a Claude session id and injects the hook settings file', () => {
    const { args, headless } = claudeCommand({ provider: 'claude', profileId: 'x', cwd: 'C:\\r', mode: 'interactive', prompt: 'hello there', model: 'opus', permission: 'acceptEdits', title: 'Fix' }, 'uuid-1', 'C:\\s.json');
    expect(headless).toBe(false);
    expect(args).toEqual(['--session-id', 'uuid-1', '--model', 'opus', '--permission-mode', 'acceptEdits', '--name', 'Fix', '--settings', 'C:\\s.json', 'hello there']);
  });

  it('runs background Claude tasks headless with stream-json', () => {
    const { args, headless } = claudeCommand({ provider: 'claude', profileId: 'x', cwd: 'C:\\r', mode: 'task', prompt: 'do it' }, 'uuid-2', null);
    expect(headless).toBe(true);
    expect(args.slice(-5)).toEqual(['--print', '--output-format', 'stream-json', '--verbose', 'do it']);
  });

  it('resumes instead of pinning a new id', () => {
    const { args } = claudeCommand({ provider: 'claude', profileId: 'x', cwd: 'C:\\r', mode: 'interactive', resumeSessionId: 'old' }, 'new', null);
    expect(args.slice(0, 2)).toEqual(['--resume', 'old']);
    expect(args).not.toContain('--session-id');
  });

  it('maps Codex permissions and isolates second accounts from the shared daemon', () => {
    expect(codexCommand({ provider: 'codex', profileId: 'x', cwd: 'C:\\r', mode: 'interactive', permission: 'auto' }, isolated, true).args).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--no-daemon']);
    expect(codexCommand({ provider: 'codex', profileId: 'x', cwd: 'C:\\r', mode: 'interactive' }, builtin, true).args).toEqual([]);
    expect(codexCommand({ provider: 'codex', profileId: 'x', cwd: 'C:\\r', mode: 'task', prompt: 'p', effort: 'high' }, isolated, true).args).toEqual(['exec', '--skip-git-repo-check', '--color', 'always', '-c', 'model_reasoning_effort="high"', 'p']);
  });

  it('splits extra arguments like a shell', () => {
    expect(splitArgs('--add-dir "C:\\My Folder" --search \'a b\'')).toEqual(['--add-dir', 'C:\\My Folder', '--search', 'a b']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('status line capture', () => {
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
    expect(defaultStatusText(snapshot, 'Work')).toBe('Opus 5.5 · ctx 29% · $8.67 · 5h 63% · Work');
  });
});

describe('background task log', () => {
  it('renders stream-json events as a readable log', () => {
    const formatter = new ClaudeStreamFormatter();
    const out = formatter.push(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', cwd: 'C:\\r' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1234, duration_ms: 4200, num_turns: 3, result: 'All green.' })
      ].join('\n') + '\n'
    );
    expect(out).toContain('Bash');
    expect(out).toContain('npm test');
    expect(out).toContain('Task complete');
    expect(out).toContain('All green.');
    expect(formatter.result).toEqual({ subtype: 'success', isError: false, costUsd: 0.1234, sessionId: 's1' });
  });
});

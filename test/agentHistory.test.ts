import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, SessionTelemetry } from '../src/shared/types';
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
import { AgentManager, type AgentManagerDeps } from '../src/main/agents';

const dirs: string[] = [];
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(extra: Partial<AgentInfo> = {}) {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-history-'));
  dirs.push(dir);
  const saved = {
    id: 'a', runId: 'r', provider: 'claude', profileId: 'work', mode: 'chat', title: 'ArcRho', titleCustom: false,
    cwd: 'C:/Repos/ArcRho', sessionId: 's', transcriptPath: null, telemetry: null,
    status: 'stopped', endedAt: '2026-10-22T10:00:00Z', startedAt: '2026-10-22T09:00:00Z', ...extra
  } as AgentInfo;
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify({ agents: [saved] }));
  const telemetry = { sessionId: 's', title: 'Fix workbook export', model: 'claude-sonnet-5-5',
    contextPercent: 12, contextUsedTokens: 24_000, filePath: 'C:/transcripts/s.jsonl', cost: { totalUsd: 0.25, reportedUsd: null } } as SessionTelemetry;
  const loader = vi.fn(async () => telemetry);
  const finder = vi.fn(async () => 'C:/transcripts/s.jsonl');
  const manager = new AgentManager({
    userDataDir: dir, hooks: {}, profiles: { list: () => [{ id: 'work', provider: 'claude', configDir: 'C:/claude' }] },
    telemetry: { sessionTelemetry: loader, findClaudeTranscript: finder }
  } as unknown as AgentManagerDeps);
  return { manager, dir, loader, finder, telemetry };
}

describe('saved session metadata', () => {
  it('checkpoints live title and context updates before the application exits', async () => {
    const { manager, dir } = setup({ transcriptPath: 'C:/transcripts/s.jsonl' });
    const info = { ...manager.get('a')!, endedAt: null, status: 'working' };
    const session = { info, profile: { provider: 'claude', id: 'work' }, statusLine: null, titleLocked: false, lastTelemetryKey: '' };
    (manager as any).sessions.set('a', session);
    await (manager as any).refreshTelemetry(session);
    await vi.runOnlyPendingTimersAsync();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).agents[0];
    expect(saved).toMatchObject({ title: 'Fix workbook export', telemetry: { contextPercent: 12 } });
  });
  it('recovers missing title, transcript and context at startup and persists the repaired card', async () => {
    const { manager, dir, finder } = setup();
    await manager.restoreHistory();
    expect(finder).toHaveBeenCalledWith('C:/claude', 's');
    expect(manager.get('a')).toMatchObject({ title: 'Fix workbook export', transcriptPath: 'C:/transcripts/s.jsonl', telemetry: { contextPercent: 12 } });
    await vi.runOnlyPendingTimersAsync();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).agents[0]).toMatchObject({ title: 'Fix workbook export', telemetry: { contextPercent: 12 } });
  });
  it('preserves custom titles and saved metadata when a transcript is unavailable', async () => {
    const { manager, loader } = setup({ title: 'My title', titleCustom: true });
    await manager.restoreHistory();
    expect(manager.get('a')?.title).toBe('My title');
    loader.mockRejectedValueOnce(new Error('missing transcript'));
    await manager.restoreHistory();
    expect(manager.get('a')?.telemetry?.contextPercent).toBe(12);
  });
  it('does not resurrect a card removed while its transcript is loading', async () => {
    const { manager, loader, telemetry } = setup({ transcriptPath: 'C:/transcripts/s.jsonl' });
    let reply!: (value: SessionTelemetry) => void;
    loader.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    const restoring = manager.restoreHistory();
    manager.remove('a');
    reply(telemetry);
    await restoring;
    expect(manager.get('a')).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetryEngine } from '../src/main/telemetry/engine';
import { mergeMachine, parseUsageFile, type ExportedSession, type MachineUsage } from '../src/main/telemetry/usageTransfer';
import { GitHubSync } from '../src/main/githubSync';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-transfer-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, lines: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** A computer with one Claude session today: `input` tokens of Sonnet 5 input ($2/M). */
function computer(name: string, sessionId: string, input: number, email: string | null) {
  const claudeDir = path.join(root, name, 'claude');
  const stamp = new Date().toISOString();
  write(path.join(claudeDir, 'projects', 'C--work', `${sessionId}.jsonl`), [
    { type: 'ai-title', aiTitle: `Work on ${name}` },
    {
      type: 'assistant', cwd: 'C:\\work', sessionId, requestId: 'r1', timestamp: stamp,
      message: { id: 'r1', model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: 0 } }
    }
  ]);
  const engine = new TelemetryEngine(null, () => {}, {
    importedPath: path.join(root, name, 'imported.json'),
    machine: { id: `${name}-id`, name }
  });
  engine.configure([{ id: 'claude-default', provider: 'claude', configDir: claudeDir, label: 'Default', email }], { usageDays: 7 });
  return engine;
}

const A_SESSION = 'aaaaaaaa-0000-0000-0000-000000000001';
const B_SESSION = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('usage from other computers', () => {
  it('adds an imported computer to the report and matches its accounts by email', async () => {
    const laptop = computer('laptop', A_SESSION, 1_000_000, 'me@example.com');
    const desktop = computer('desktop', B_SESSION, 500_000, 'me@example.com');
    const fromLaptop = (await laptop.localUsage(null)).content;

    expect(desktop.importUsage([fromLaptop])).toEqual({ machines: 1, added: 1, updated: 0, ownOnly: 0 });
    const report = await desktop.usageReport(true);
    const today = report.days[report.days.length - 1];
    expect(report.totals.today).toBeCloseTo(3, 6);
    expect(today.byMachine['laptop-id']).toBeCloseTo(2, 6);
    expect(today.byMachine['desktop-id']).toBeCloseTo(1, 6);
    // Same email on both computers: one account.
    expect(today.byProfile['claude-default']).toBeCloseTo(3, 6);
    expect(report.remoteAccounts).toEqual([]);
    expect(report.machines.map((m) => [m.name, m.local])).toEqual([['desktop', true], ['laptop', false]]);
    expect(report.facts.find((f) => f.machineId === 'laptop-id')).toMatchObject({ model: 'claude-sonnet-5', profileId: 'claude-default', usd: expect.closeTo(2, 6) });
    const remote = report.sessions.find((s) => s.sessionId === A_SESSION);
    expect(remote).toMatchObject({ machineName: 'laptop', title: 'Work on laptop', filePath: '', costUsd: 2 });

    // Importing the same file again changes nothing; the desktop's own file is skipped.
    expect(desktop.importUsage([fromLaptop])).toMatchObject({ added: 0, updated: 0 });
    expect(desktop.importUsage([(await desktop.localUsage(null)).content])).toMatchObject({ machines: 0, ownOnly: 1 });
  });

  it('lists accounts it cannot match, keeps imports across restarts, and exports them onward', async () => {
    const laptop = computer('laptop', A_SESSION, 1_000_000, 'other@example.com');
    const desktop = computer('desktop', B_SESSION, 500_000, 'me@example.com');
    desktop.importUsage([(await laptop.localUsage(null)).content]);

    const restarted = computer('desktop', B_SESSION, 500_000, 'me@example.com');
    const report = await restarted.usageReport(true);
    expect(report.remoteAccounts).toEqual([{ id: 'remote:claude:other@example.com', provider: 'claude', label: 'other@example.com' }]);
    expect(report.days[report.days.length - 1].byProfile['remote:claude:other@example.com']).toBeCloseTo(2, 6);

    // One file carries both computers to a third.
    const file = path.join(root, 'export.json');
    expect(await restarted.exportUsage(file)).toMatchObject({ machines: 2, sessions: 2 });
    const third = computer('tablet', 'cccccccc-0000-0000-0000-000000000003', 0, null);
    expect(third.importUsage([fs.readFileSync(file, 'utf8')])).toMatchObject({ machines: 2, added: 2 });

    restarted.forgetMachine('laptop-id');
    expect((await restarted.usageReport(true)).machines).toHaveLength(1);
  });

  it('splits days from older builds, which have no per-model days, by the session’s models', async () => {
    const desktop = computer('desktop', B_SESSION, 0, null);
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const file = {
      format: 'foreman-usage', version: 1, exportedAt: '', exportedBy: { id: 'old-id', name: 'Old', appVersion: '0.1.0' },
      machines: [{
        id: 'old-id', name: 'Old', dataAt: new Date().toISOString(), pricingDate: '', accounts: [{ id: 'a', provider: 'claude', label: 'A', email: null }],
        sessions: [{
          provider: 'claude', accountId: 'a', sessionId: 's', title: null, cwd: null, model: 'claude-sonnet-5', startedAt: null, updatedAt: new Date().toISOString(),
          tokens: 40, requests: 4,
          byDay: { [today]: { usd: 4, tokens: 40, requests: 4 } },
          byModel: { 'claude-sonnet-5': { usd: 3, tokens: 10, requests: 1 }, 'claude-opus-5': { usd: 1, tokens: 30, requests: 3 } }
        }]
      }]
    };
    desktop.importUsage([JSON.stringify(file)]);
    const facts = (await desktop.usageReport(true)).facts.filter((f) => f.machineId === 'old-id');
    expect(Object.fromEntries(facts.map((f) => [f.model, [f.usd, f.tokens, f.requests]]))).toEqual({
      'claude-sonnet-5': [3, 10, 1],
      'claude-opus-5': [1, 30, 3]
    });
  });

  it('keeps the newer reading of a session and the sessions only one side still has', () => {
    const session = (id: string, requests: number, updatedAt: string): ExportedSession => ({
      provider: 'claude', accountId: 'a', sessionId: id, title: null, cwd: null, model: null, startedAt: null, updatedAt,
      tokens: requests, requests, byDay: {}, byModel: {}
    });
    const machine = (sessions: ExportedSession[], dataAt: string): MachineUsage => ({ id: 'm', name: 'M', dataAt, pricingDate: '', accounts: [], sessions });
    const older = machine([session('s1', 1, '2026-09-01T00:00:00Z'), session('gone', 4, '2026-08-01T00:00:00Z')], '2026-09-01T00:00:00Z');
    const newer = machine([session('s1', 3, '2026-09-02T00:00:00Z')], '2026-09-02T00:00:00Z');
    const merged = mergeMachine(older, newer);
    expect(merged).toMatchObject({ added: 0, updated: 1 });
    expect(merged.machine.sessions.map((s) => [s.sessionId, s.requests]).sort()).toEqual([['gone', 4], ['s1', 3]]);
    // An older reading never overwrites a newer one.
    expect(mergeMachine(merged.machine, older).updated).toBe(0);
  });

  it('rejects files that are not usage files', () => {
    expect(() => parseUsageFile('{}')).toThrow('Not a Foreman usage file');
    expect(() => parseUsageFile('nope')).toThrow('invalid JSON');
    expect(() => parseUsageFile(JSON.stringify({ format: 'foreman-usage', version: 99 }))).toThrow('newer Foreman');
  });
});

/** Just enough of the GitHub REST API for the sync: a contents directory of blobs. */
function fakeGitHub() {
  const files = new Map<string, { content: string; sha: string }>();
  let version = 0;
  const calls: string[] = [];
  const reply = (status: number, body: unknown) => ({
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const fetch = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const method = init.method ?? 'GET';
    const route = url.replace('https://api.github.com', '');
    calls.push(`${method} ${route}`);
    if (route === '/repos/me/foreman-usage/contents/machines') {
      if (files.size === 0) return reply(404, { message: 'Not Found' });
      return reply(200, [...files].map(([p, f]) => ({ type: 'file', name: path.basename(p), path: p, sha: f.sha })));
    }
    const filePath = route.replace('/repos/me/foreman-usage/contents/', '');
    if (method === 'GET') {
      const file = files.get(filePath);
      return file ? reply(200, file.content) : reply(404, { message: 'Not Found' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body!);
      if (files.has(filePath) && files.get(filePath)!.sha !== body.sha) return reply(409, { message: 'sha mismatch' });
      const sha = `sha${++version}`;
      files.set(filePath, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return reply(200, { content: { sha } });
    }
    return reply(404, { message: 'Not Found' });
  };
  return { files, calls, fetch };
}

function syncFor(name: string, engine: TelemetryEngine, github: ReturnType<typeof fakeGitHub>) {
  const store = path.join(root, name, 'github.json');
  fs.writeFileSync(store, JSON.stringify({ login: 'me', repo: 'me/foreman-usage', token: 'secret' }));
  return new GitHubSync(store, {
    fetch: github.fetch,
    secrets: { available: () => true, encrypt: (v) => v, decrypt: (v) => v },
    telemetry: { localUsage: (p) => engine.localUsage(p), importUsage: async (c, n) => engine.importUsage(c, n) },
    machineId: `${name}-id`,
    machineName: name,
    openExternal: () => {}
  });
}

describe('GitHub sync', () => {
  it('uploads each computer’s own file and imports the others’, downloading only what changed', async () => {
    const github = fakeGitHub();
    const laptop = computer('laptop', A_SESSION, 1_000_000, 'me@example.com');
    const desktop = computer('desktop', B_SESSION, 500_000, 'me@example.com');
    const laptopSync = syncFor('laptop', laptop, github);
    const desktopSync = syncFor('desktop', desktop, github);

    await laptopSync.sync();
    await desktopSync.sync();
    expect([...github.files.keys()].sort()).toEqual(['machines/desktop-id.json', 'machines/laptop-id.json']);
    expect((await desktop.usageReport(true)).totals.today).toBeCloseTo(3, 6);

    await laptopSync.sync();
    expect((await laptop.usageReport(true)).totals.today).toBeCloseTo(3, 6);
    expect(laptopSync.status()).toMatchObject({ login: 'me', repo: 'me/foreman-usage', lastError: null, syncing: false });

    // Nothing changed: no download of the other computer's file and no new commit.
    github.calls.length = 0;
    await laptopSync.sync();
    expect(github.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    expect(github.calls).not.toContain('GET /repos/me/foreman-usage/contents/machines/desktop-id.json');
  });

  it('forgets the token when GitHub rejects it', async () => {
    const github = fakeGitHub();
    const laptop = computer('laptop', A_SESSION, 1_000_000, null);
    const sync = syncFor('laptop', laptop, {
      ...github,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }), text: async () => '' })
    });
    await expect(sync.sync()).rejects.toThrow('Bad credentials');
    expect(sync.status()).toMatchObject({ login: null, lastError: expect.stringContaining('Connect again') });
  });
});

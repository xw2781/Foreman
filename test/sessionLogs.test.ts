import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Profile } from '../src/shared/types';
import {
  checkLogsRoot,
  currentLocation,
  mergeMove,
  placeSessionLogs,
  readClaudeRetention,
  retentionDays,
  writeClaudeRetention
} from '../src/main/sessionLogs';

describe('session logs', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-logs-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const account = (root: string, id: string, provider: 'claude' | 'codex' = 'claude'): Profile => {
    const configDir = path.join(root, id);
    fs.mkdirSync(configDir, { recursive: true });
    return { id, provider, label: id, color: 'slot-3', configDir, builtin: false, createdAt: '' };
  };

  it('keeps retention a whole number of days, never 0', () => {
    expect(retentionDays(120.4)).toBe(120);
    expect(retentionDays(0)).toBe(90);
    expect(retentionDays('x')).toBe(90);
    expect(retentionDays(1e9)).toBe(36_500);
  });

  it('writes cleanupPeriodDays and keeps the other settings', () => {
    const profile = account(tempDir(), 'claude-a');
    const file = path.join(profile.configDir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }));
    expect(readClaudeRetention(profile)).toBeNull();
    expect(writeClaudeRetention(profile, 90)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'opus', hooks: { Stop: [] }, cleanupPeriodDays: 90 });
    expect(writeClaudeRetention(profile, 90)).toBe(false);
    expect(readClaudeRetention(profile)).toBe(90);
  });

  it('creates settings.json when missing but never replaces an unreadable one', () => {
    const profile = account(tempDir(), 'claude-a');
    const file = path.join(profile.configDir, 'settings.json');
    writeClaudeRetention(profile, 30);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ cleanupPeriodDays: 30 });
    fs.writeFileSync(file, '{ broken');
    expect(() => writeClaudeRetention(profile, 90)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('moves transcripts out behind a junction and back again', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    const codex = account(root, 'codex-a', 'codex');
    fs.mkdirSync(path.join(claude.configDir, 'projects', 'E--repo'), { recursive: true });
    fs.writeFileSync(path.join(claude.configDir, 'projects', 'E--repo', 's1.jsonl'), '{}\n');
    fs.mkdirSync(path.join(codex.configDir, 'sessions', '2026', '11'), { recursive: true });
    fs.writeFileSync(path.join(codex.configDir, 'sessions', '2026', '11', 'r.jsonl'), '{}\n');
    const logs = path.join(root, 'logs');

    expect(await placeSessionLogs([claude, codex], logs)).toEqual({ leftovers: [], errors: [] });
    const home = path.join(claude.configDir, 'projects');
    expect(fs.lstatSync(home).isSymbolicLink()).toBe(true);
    expect(currentLocation(home)?.toLowerCase()).toBe(path.join(logs, 'claude-a', 'projects').toLowerCase());
    expect(fs.readFileSync(path.join(home, 'E--repo', 's1.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(logs, 'codex-a', 'sessions', '2026', '11', 'r.jsonl'))).toBe(true);
    // archived_sessions didn't exist: linked to an empty folder so new files land there too
    expect(fs.existsSync(path.join(logs, 'codex-a', 'archived_sessions'))).toBe(true);

    // a second run changes nothing
    expect(await placeSessionLogs([claude, codex], logs)).toEqual({ leftovers: [], errors: [] });

    await placeSessionLogs([claude, codex], '');
    expect(fs.lstatSync(home).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, 'E--repo', 's1.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.readdirSync(logs)).toEqual([]);
    expect(fs.readdirSync(claude.configDir).filter((n) => n.includes('foreman-move'))).toEqual([]);
  });

  it('moves between two chosen folders', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    fs.mkdirSync(path.join(claude.configDir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(claude.configDir, 'projects', 'p', 's.jsonl'), 'x');
    await placeSessionLogs([claude], path.join(root, 'one'));
    await placeSessionLogs([claude], path.join(root, 'two'));
    expect(fs.readFileSync(path.join(root, 'two', 'claude-a', 'projects', 'p', 's.jsonl'), 'utf8')).toBe('x');
    expect(fs.readdirSync(path.join(root, 'one'))).toEqual([]);
  });

  it('merges into an existing folder and keeps junctions as junctions', async () => {
    const root = tempDir();
    const from = path.join(root, 'from');
    const to = path.join(root, 'to');
    const shared = path.join(root, 'shared-memory');
    fs.mkdirSync(path.join(from, 'p'), { recursive: true });
    fs.mkdirSync(path.join(to, 'p'), { recursive: true });
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'MEMORY.md'), 'note');
    fs.symlinkSync(shared, path.join(from, 'p', 'memory'), 'junction');
    fs.writeFileSync(path.join(from, 'p', 'a.jsonl'), 'old');
    fs.writeFileSync(path.join(from, 'p', 'b.jsonl'), 'b');
    fs.writeFileSync(path.join(to, 'p', 'a.jsonl'), 'new');

    expect(await mergeMove(from, to)).toBe(false);
    expect(fs.readFileSync(path.join(to, 'p', 'a.jsonl'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(from, 'p', 'a.jsonl'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(to, 'p', 'b.jsonl'), 'utf8')).toBe('b');
    expect(fs.lstatSync(path.join(to, 'p', 'memory')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(shared, 'MEMORY.md'), 'utf8')).toBe('note');
  });

  it('refuses a folder inside the transcripts it would receive', () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    fs.mkdirSync(path.join(claude.configDir, 'projects'));
    expect(() => checkLogsRoot(path.join(claude.configDir, 'projects', 'x'), [claude])).toThrow(/inside/);
    expect(() => checkLogsRoot('relative', [claude])).toThrow(/full folder path/);
    expect(() => checkLogsRoot(path.join(root, 'elsewhere'), [claude])).not.toThrow();
  });
});

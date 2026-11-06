import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Profile } from '../src/shared/types';
import {
  checkDataRoot,
  currentLocation,
  mergeMove,
  placeDataFolders,
  placeFolder,
  readClaudeRetention,
  retentionDays,
  writeClaudeRetention
} from '../src/main/dataFolder';
import { removeTree } from '../src/main/util';

describe('data folder', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-data-'));
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
  const isLink = (file: string) => fs.lstatSync(file).isSymbolicLink();

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

  it('moves whole account folders and the computer-use folder out behind junctions, and back', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    const codex = account(root, 'codex-a', 'codex');
    fs.mkdirSync(path.join(claude.configDir, 'projects', 'E--repo'), { recursive: true });
    fs.writeFileSync(path.join(claude.configDir, 'projects', 'E--repo', 's1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(claude.configDir, '.credentials.json'), '{"t":1}');
    fs.mkdirSync(path.join(codex.configDir, 'sessions', '2026', '11'), { recursive: true });
    fs.writeFileSync(path.join(codex.configDir, 'sessions', '2026', '11', 'r.jsonl'), '{}\n');
    const cu = path.join(root, 'AppData', 'computer-use');
    fs.mkdirSync(path.join(cu, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(cu, 'shots', 'state-1.png'), 'png');
    const data = path.join(root, 'data');

    expect(await placeDataFolders([claude, codex], data, cu)).toEqual({ leftovers: [], errors: [] });
    expect(isLink(claude.configDir)).toBe(true);
    expect(currentLocation(claude.configDir)?.toLowerCase()).toBe(path.join(data, 'claude-a').toLowerCase());
    expect(fs.readFileSync(path.join(claude.configDir, 'projects', 'E--repo', 's1.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(data, 'claude-a', '.credentials.json'), 'utf8')).toBe('{"t":1}');
    expect(fs.existsSync(path.join(data, 'codex-a', 'sessions', '2026', '11', 'r.jsonl'))).toBe(true);
    expect(isLink(cu)).toBe(true);
    expect(fs.readFileSync(path.join(data, 'computer-use', 'shots', 'state-1.png'), 'utf8')).toBe('png');

    // a second run changes nothing
    expect(await placeDataFolders([claude, codex], data, cu)).toEqual({ leftovers: [], errors: [] });

    expect(await placeDataFolders([claude, codex], '', cu)).toEqual({ leftovers: [], errors: [] });
    expect(isLink(claude.configDir)).toBe(false);
    expect(isLink(cu)).toBe(false);
    expect(fs.readFileSync(path.join(claude.configDir, 'projects', 'E--repo', 's1.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(cu, 'shots', 'state-1.png'), 'utf8')).toBe('png');
    expect(fs.readdirSync(data)).toEqual([]);
    expect(fs.readdirSync(root).filter((n) => n.includes('foreman-move'))).toEqual([]);
  });

  it('moves between two chosen folders', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    fs.mkdirSync(path.join(claude.configDir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(claude.configDir, 'projects', 'p', 's.jsonl'), 'x');
    await placeDataFolders([claude], path.join(root, 'one'));
    await placeDataFolders([claude], path.join(root, 'two'));
    expect(fs.readFileSync(path.join(root, 'two', 'claude-a', 'projects', 'p', 's.jsonl'), 'utf8')).toBe('x');
    expect(fs.readdirSync(path.join(root, 'one'))).toEqual([]);
  });

  it('folds transcripts an earlier version moved on their own into the moved account folder', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    const codex = account(root, 'codex-a', 'codex');
    fs.writeFileSync(path.join(claude.configDir, 'settings.json'), '{}');
    for (const [p, name] of [[claude, 'projects'], [codex, 'sessions']] as const) {
      fs.mkdirSync(path.join(p.configDir, name, 'x'), { recursive: true });
      fs.writeFileSync(path.join(p.configDir, name, 'x', 'log.jsonl'), name);
    }
    const data = path.join(root, 'data');
    const other = path.join(root, 'old-logs');
    // The old layout: Claude's transcripts already in the chosen folder, Codex's in another one.
    await placeFolder(path.join(claude.configDir, 'projects'), path.join(data, 'claude-a', 'projects'));
    await placeFolder(path.join(codex.configDir, 'sessions'), path.join(other, 'codex-a', 'sessions'));

    expect(await placeDataFolders([claude, codex], data)).toEqual({ leftovers: [], errors: [] });
    expect(isLink(path.join(data, 'claude-a', 'projects'))).toBe(false);
    expect(fs.readFileSync(path.join(data, 'claude-a', 'projects', 'x', 'log.jsonl'), 'utf8')).toBe('projects');
    expect(fs.existsSync(path.join(data, 'claude-a', 'settings.json'))).toBe(true);
    expect(isLink(path.join(data, 'codex-a', 'sessions'))).toBe(false);
    expect(fs.readFileSync(path.join(data, 'codex-a', 'sessions', 'x', 'log.jsonl'), 'utf8')).toBe('sessions');
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it('brings separately moved transcripts home when the data goes back', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    fs.mkdirSync(path.join(claude.configDir, 'projects', 'x'), { recursive: true });
    fs.writeFileSync(path.join(claude.configDir, 'projects', 'x', 'log.jsonl'), 'p');
    const old = path.join(root, 'old-logs');
    await placeFolder(path.join(claude.configDir, 'projects'), path.join(old, 'claude-a', 'projects'));
    expect(await placeDataFolders([claude], '')).toEqual({ leftovers: [], errors: [] });
    expect(isLink(path.join(claude.configDir, 'projects'))).toBe(false);
    expect(fs.readFileSync(path.join(claude.configDir, 'projects', 'x', 'log.jsonl'), 'utf8')).toBe('p');
    expect(fs.readdirSync(old)).toEqual([]);
  });

  it('removing a moved account folder unlinks it and leaves the data to its own deletion', async () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    fs.writeFileSync(path.join(claude.configDir, 'a.json'), '{}');
    await placeDataFolders([claude], path.join(root, 'data'));
    removeTree(claude.configDir);
    expect(fs.existsSync(claude.configDir)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'data', 'claude-a', 'a.json'), 'utf8')).toBe('{}');
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

  it('refuses a folder inside one it would receive', () => {
    const root = tempDir();
    const claude = account(root, 'claude-a');
    const cu = path.join(root, 'cu');
    fs.mkdirSync(cu);
    expect(() => checkDataRoot(path.join(claude.configDir, 'projects'), [claude])).toThrow(/inside/);
    expect(() => checkDataRoot(path.join(cu, 'x'), [claude], cu)).toThrow(/inside/);
    expect(() => checkDataRoot('relative', [claude])).toThrow(/full folder path/);
    expect(() => checkDataRoot(path.join(root, 'elsewhere'), [claude], cu)).not.toThrow();
  });
});

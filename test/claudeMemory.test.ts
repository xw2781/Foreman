import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeProjectDirName, memoryProjectRoot, shareClaudeMemory } from '../src/main/claudeMemory';

describe('shared Claude memory', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-memory-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names project folders the way Claude Code does', () => {
    expect(claudeProjectDirName('E:\\XWSpace\\Repos\\ArcRho')).toBe('E--XWSpace-Repos-ArcRho');
    expect(claudeProjectDirName(`C:\\${'x'.repeat(250)}`)).toBeNull();
  });

  it('files a worktree under its main checkout', () => {
    const root = tempDir();
    const main = path.join(root, 'repo');
    const tree = path.join(root, 'repo-feature');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);
    expect(memoryProjectRoot(path.join(tree, 'src'))).toBe(main);
    expect(memoryProjectRoot(path.join(main))).toBe(main);
  });

  it('moves the account notes to the primary folder and links it', () => {
    const root = tempDir();
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const name = claudeProjectDirName(cwd)!;
    const primary = path.join(root, 'primary');
    const account = path.join(root, 'account');
    const target = path.join(primary, 'projects', name, 'memory');
    const own = path.join(account, 'projects', name, 'memory');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(target, 'MEMORY.md'), '- [A](a.md) — a\n');
    fs.writeFileSync(path.join(own, 'MEMORY.md'), '- [A](a.md) — a\n- [B](b.md) — b\n');
    fs.writeFileSync(path.join(own, 'b.md'), 'b');

    expect(shareClaudeMemory(primary, account, cwd)).toBe(true);
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'MEMORY.md'), 'utf8')).toBe('- [A](a.md) — a\n- [B](b.md) — b\n');
    expect(fs.readFileSync(path.join(own, 'b.md'), 'utf8')).toBe('b');
    expect(shareClaudeMemory(primary, account, cwd)).toBe(true);
  });

  it('leaves the account folder alone when a note would be overwritten', () => {
    const root = tempDir();
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const name = claudeProjectDirName(cwd)!;
    const target = path.join(root, 'primary', 'projects', name, 'memory');
    const own = path.join(root, 'account', 'projects', name, 'memory');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.md'), 'primary');
    fs.writeFileSync(path.join(own, 'a.md'), 'account');

    expect(shareClaudeMemory(path.join(root, 'primary'), path.join(root, 'account'), cwd)).toBe(false);
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(target, 'a.md'), 'utf8')).toBe('primary');
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { additionDiff, gitCommit, gitDiff, gitStatus, parseNumstat, parseStatus, parseWorktrees } from '../src/main/gitStatus';
import { parseDiff, splitPath, worktreeOf } from '../src/renderer/src/gitDiff';

describe('git output parsing', () => {
  it('reads porcelain v2 status with renames, conflicts and untracked files', () => {
    const out = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '# stash 3',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc both.ts',
      '? notes.md',
      ''
    ].join('\0');
    const status = parseStatus(out);
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, hasAheadBehind: true, stashes: 3 });
    expect(status.files).toEqual([
      { path: 'src/a file.ts', index: '.', worktree: 'M', conflict: false },
      { path: 'new.ts', origPath: 'old.ts', index: 'R', worktree: '.', conflict: false },
      { path: 'both.ts', index: 'U', worktree: 'U', conflict: true },
      { path: 'notes.md', index: '?', worktree: '?', conflict: false }
    ]);
  });

  it('notices a detached HEAD, an empty repository and a gone upstream', () => {
    const status = parseStatus(['# branch.oid (initial)', '# branch.head (detached)', '# branch.upstream origin/x', ''].join('\0'));
    expect(status).toMatchObject({ oid: null, branch: null, upstream: 'origin/x', hasAheadBehind: false });
  });

  it('reads numstat with renames and binary files', () => {
    expect(parseNumstat(['3\t1\tsrc/a.ts', '-\t-\timg.png', '0\t0\t', 'old.ts', 'new.ts', ''].join('\0'))).toEqual([
      { path: 'src/a.ts', stats: { added: 3, removed: 1 } },
      { path: 'img.png', stats: null },
      { path: 'new.ts', origPath: 'old.ts', stats: { added: 0, removed: 0 } }
    ]);
  });

  it('reads worktrees, main first', () => {
    const root = path.resolve('/repo');
    const trees = parseWorktrees(
      ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /repo/.claude/worktrees/x', 'HEAD def', 'detached', 'locked in use', ''].join('\n'),
      root
    );
    expect(trees).toMatchObject([
      { branch: 'main', main: true, current: true, locked: null },
      { branch: null, head: 'def', main: false, current: false, locked: 'in use' }
    ]);
  });

  it('shows a new file as all added lines', () => {
    expect(additionDiff('a.txt', new TextEncoder().encode('one\r\ntwo')).text).toBe(
      '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n'
    );
    expect(additionDiff('b.bin', new Uint8Array([1, 0, 2])).binary).toBe(true);
  });
});

describe('diff rows', () => {
  it('numbers lines and keeps removed lines that look like headers', () => {
    const rows = parseDiff(['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@ fn', ' keep', '--- dashes', '+new', ' end', '\\ No newline at end of file', ''].join('\n'));
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@ fn' },
      { kind: 'context', text: 'keep', old: 1, new: 1 },
      { kind: 'remove', text: '-- dashes', old: 2 },
      { kind: 'add', text: 'new', new: 2 },
      { kind: 'context', text: 'end', old: 3, new: 3 },
      { kind: 'note', text: 'No newline at end of file' }
    ]);
  });

  it('splits paths and finds the deepest worktree', () => {
    expect(splitPath('src/main/a.ts')).toEqual({ name: 'a.ts', dir: 'src/main' });
    expect(splitPath('dir/')).toEqual({ name: 'dir', dir: '' });
    const trees = ['E:\\repo', 'E:\\repo\\.claude\\worktrees\\x'];
    expect(worktreeOf('e:/repo/.claude/worktrees/x/src', trees)).toBe(trees[1]);
    expect(worktreeOf('E:\\repo\\src', trees)).toBe(trees[0]);
    expect(worktreeOf('E:\\repository', trees)).toBeNull();
  });
});

describe('git status of a real repository', () => {
  let root: string;
  let tree: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-git-')));
    tree = path.join(root, 'repo');
    fs.mkdirSync(tree);
    git(tree, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(tree, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(tree, 'old.txt'), 'rename me\n'.repeat(5));
    git(tree, 'add', '.');
    git(tree, 'commit', '-q', '-m', 'First\n\nThe body.');
    fs.writeFileSync(path.join(tree, 'a.txt'), 'one\n2\nthree\n');
    git(tree, 'mv', 'old.txt', 'new.txt');
    fs.writeFileSync(path.join(tree, 'new file.md'), '# hi\n');
    git(tree, 'worktree', 'add', '-q', '-b', 'side', path.join(root, 'side'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists branch, changes, commits and worktrees', async () => {
    const status = await gitStatus(path.join(tree));
    if (!status.repo) throw new Error(status.reason);
    expect(status.branch).toBe('main');
    expect(status.remotes).toBe(0);
    expect(status.unpushed).toBe(1);
    expect(status.commits).toMatchObject([{ subject: 'First', pushed: false }]);
    expect(status.head?.subject).toBe('First');
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'a.txt', index: '.', worktree: 'M', unstaged: { added: 2, removed: 1 } }),
      expect.objectContaining({ path: 'new.txt', origPath: 'old.txt', index: 'R' }),
      expect.objectContaining({ path: 'new file.md', index: '?' })
    ]));
    expect(status.worktrees.map((w) => [path.basename(w.path), w.branch, w.main, w.current])).toEqual([
      ['repo', 'main', true, true],
      ['side', 'side', false, false]
    ]);
  });

  it('knows a linked worktree is current from inside it', async () => {
    const status = await gitStatus(path.join(root, 'side'));
    if (!status.repo) throw new Error(status.reason);
    expect(status.branch).toBe('side');
    expect(status.worktrees.find((w) => w.current)?.main).toBe(false);
  });

  it('diffs unstaged, untracked and committed files', async () => {
    expect((await gitDiff(tree, { kind: 'unstaged', path: 'a.txt' })).text).toContain('+three');
    expect((await gitDiff(tree, { kind: 'untracked', path: 'new file.md' })).text).toContain('+# hi');
    const staged = await gitDiff(tree, { kind: 'staged', path: 'new.txt', origPath: 'old.txt' });
    expect(staged.text).toContain('rename from old.txt');
    const head = (await gitStatus(tree)) as Extract<Awaited<ReturnType<typeof gitStatus>>, { repo: true }>;
    const commit = await gitCommit(tree, head.head!.hash);
    expect(commit.message).toBe('First\n\nThe body.');
    expect(commit.files.map((f) => f.path).sort()).toEqual(['a.txt', 'old.txt']);
    expect((await gitDiff(tree, { kind: 'commit', hash: head.head!.hash, path: 'a.txt' })).text).toContain('+two');
  });

  it('refuses paths outside the repository and bad hashes', async () => {
    await expect(gitDiff(tree, { kind: 'unstaged', path: '../side/x' })).rejects.toThrow();
    await expect(gitDiff(tree, { kind: 'commit', hash: '--output=x', path: 'a.txt' })).rejects.toThrow('Invalid commit');
  });

  it('says when a folder is not a repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-nogit-'));
    try {
      expect(await gitStatus(outside)).toMatchObject({ repo: false });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

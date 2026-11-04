import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitCommit, GitCommitDetails, GitDiff, GitDiffTarget, GitFileChange, GitLineStats, GitOperation, GitStatus, GitWorktree } from '../shared/types';
import { looksBinary, resolveInside } from './projectFiles';
import { cleanEnv } from './util';

/** More changed files than this are counted, not listed. */
export const MAX_FILES = 2000;
/** Commits shown in the Git tab's history. */
export const LOG_LENGTH = 50;
/** Diffs are shown up to this many characters. */
export const MAX_DIFF_CHARS = 400 * 1024;

class GitError extends Error {
  constructor(message: string, readonly missing = false) {
    super(message);
  }
}

/**
 * Runs git read-only. Optional locks are off so that a refresh never takes `index.lock` while an agent
 * is committing, and pathspecs are literal so a file named `*` means that file.
 */
function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const env = { ...cleanEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args],
      { cwd, env, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError("Git isn't installed, or isn't on PATH.", true));
        reject(new GitError(String(stderr).trim().split('\n')[0] || error.message));
      });
  });
}

/** `git status --porcelain=v2 --branch --show-stash -z`, parsed. */
export function parseStatus(out: string) {
  const parts = out.split('\0');
  const result = {
    oid: null as string | null,
    branch: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    hasAheadBehind: false,
    stashes: 0,
    files: [] as GitFileChange[]
  };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [, key, ...rest] = entry.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) Object.assign(result, { ahead: Number(match[1]), behind: Number(match[2]), hasAheadBehind: true });
      } else if (key === 'stash') result.stashes = Number(value) || 0;
      continue;
    }
    const kind = entry[0];
    if (kind === '?') {
      result.files.push({ path: entry.slice(2), index: '?', worktree: '?', conflict: false });
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      // Fields before the path: 1 → 8, 2 → 9 (with the rename score), u → 10.
      const fields = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const pieces = entry.split(' ');
      const xy = pieces[1] ?? '..';
      const file: GitFileChange = { path: pieces.slice(fields).join(' '), index: xy[0], worktree: xy[1], conflict: kind === 'u' };
      if (kind === '2') file.origPath = parts[++i];
      result.files.push(file);
    }
  }
  return result;
}

/** `--numstat -z` output: renames come as an empty path followed by the old and new paths. */
export function parseNumstat(out: string): Array<{ path: string; origPath?: string; stats: GitLineStats }> {
  const parts = out.split('\0');
  const files: Array<{ path: string; origPath?: string; stats: GitLineStats }> = [];
  for (let i = 0; i < parts.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i].replace(/^\n+/, ''));
    if (!match) continue;
    const stats = match[1] === '-' ? null : { added: Number(match[1]), removed: Number(match[2]) };
    if (match[3]) files.push({ path: match[3], stats });
    else {
      const origPath = parts[++i];
      files.push({ path: parts[++i], origPath, stats });
    }
  }
  return files;
}

/** `git log` with fields split by \x1f and records by \x1e. */
export function parseLog(out: string, unpushed: Set<string>): GitCommit[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, short, subject, author, date] = record.split('\x1f');
      return { hash, short, subject: subject ?? '', author: author ?? '', date: (date ?? '').trim(), pushed: !unpushed.has(hash) };
    });
}

function samePath(a: string, b: string) {
  const norm = (p: string) => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** `git worktree list --porcelain`: blocks of `key value` lines, the main working tree first. */
export function parseWorktrees(out: string, currentRoot: string): GitWorktree[] {
  return out
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length && lines[0].startsWith('worktree '))
    .map((lines, index) => {
      const value = (key: string) => {
        const line = lines.find((l) => l === key || l.startsWith(`${key} `));
        return line === undefined ? undefined : line.slice(key.length + 1);
      };
      const where = path.resolve(value('worktree') ?? '');
      const branch = value('branch');
      return {
        path: where,
        branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
        head: value('HEAD') ?? '',
        main: index === 0,
        current: samePath(where, currentRoot),
        bare: value('bare') !== undefined,
        locked: value('locked') ?? null,
        prunable: value('prunable') ?? null
      };
    });
}

function operationIn(gitDir: string): GitOperation | null {
  const has = (name: string) => fs.existsSync(path.join(gitDir, name));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

/** The working tree root and the git folder of the worktree containing `cwd`, or why there's none. */
async function locate(cwd: string): Promise<{ root: string; gitDir: string } | { reason: string }> {
  if (!cwd || !fs.existsSync(cwd)) return { reason: "This session's folder doesn't exist." };
  try {
    const [root, gitDir] = (await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])).split(/\r?\n/);
    if (!root) return { reason: 'This folder is inside a git folder, not a working tree.' };
    return { root: path.resolve(root), gitDir: path.resolve(gitDir) };
  } catch (error) {
    if (error instanceof GitError && error.missing) return { reason: error.message };
    return { reason: "This session's folder isn't in a git repository." };
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const where = await locate(cwd);
  if ('reason' in where) return { repo: false, reason: where.reason };
  const { root, gitDir } = where;
  const optional = (promise: Promise<string>) => promise.catch(() => '');
  const [statusOut, stagedOut, unstagedOut, worktreeOut, remotesOut] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=all']),
    optional(git(root, ['diff', '--cached', '--numstat', '-z', '-M'])),
    optional(git(root, ['diff', '--numstat', '-z'])),
    optional(git(root, ['worktree', 'list', '--porcelain'])),
    optional(git(root, ['remote']))
  ]);
  const status = parseStatus(statusOut);
  const remotes = remotesOut.split(/\r?\n/).filter(Boolean).length;
  let commits: GitCommit[] = [];
  let unpushed = 0;
  let subject = '';
  if (status.oid) {
    const [logOut, unpushedOut, countOut] = await Promise.all([
      optional(git(root, ['log', '-n', String(LOG_LENGTH), '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e', 'HEAD'])),
      remotes ? optional(git(root, ['rev-list', '-n', String(LOG_LENGTH * 4), 'HEAD', '--not', '--remotes'])) : Promise.resolve(''),
      remotes ? optional(git(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) : optional(git(root, ['rev-list', '--count', 'HEAD']))
    ]);
    // With no remote nothing is pushed: every commit is local.
    const local = new Set(unpushedOut.split(/\s+/).filter(Boolean));
    commits = parseLog(logOut, local).map((c) => (remotes ? c : { ...c, pushed: false }));
    unpushed = Number(countOut.trim()) || 0;
    subject = commits[0]?.hash === status.oid ? commits[0].subject : '';
  }
  const stats = (out: string) => new Map(parseNumstat(out).map((f) => [f.path, f.stats]));
  const staged = stats(stagedOut);
  const unstaged = stats(unstagedOut);
  const files = status.files.map((file) => ({
    ...file,
    ...(file.index !== '.' && file.index !== '?' && staged.has(file.path) ? { staged: staged.get(file.path) } : {}),
    ...(file.worktree !== '.' && file.worktree !== '?' && unstaged.has(file.path) ? { unstaged: unstaged.get(file.path) } : {})
  }));
  return {
    repo: true,
    root,
    branch: status.branch,
    head: status.oid ? { hash: status.oid, short: status.oid.slice(0, 7), subject } : null,
    upstream: status.upstream,
    upstreamGone: Boolean(status.upstream) && !status.hasAheadBehind,
    ahead: status.ahead,
    behind: status.behind,
    operation: operationIn(gitDir),
    stashes: status.stashes,
    files: files.slice(0, MAX_FILES),
    omittedFiles: Math.max(0, files.length - MAX_FILES),
    commits,
    remotes,
    unpushed,
    worktrees: parseWorktrees(worktreeOut, root)
  };
}

async function repoRoot(cwd: string) {
  const where = await locate(cwd);
  if ('reason' in where) throw new Error(where.reason);
  return where.root;
}

function checkHash(hash: string) {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('Invalid commit.');
  return hash;
}

function checkPaths(root: string, target: { path: string; origPath?: string }) {
  const paths = [target.path, ...(target.origPath ? [target.origPath] : [])];
  for (const p of paths) resolveInside(root, p);
  return paths;
}

function finishDiff(text: string): GitDiff {
  const binary = /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text);
  if (text.length <= MAX_DIFF_CHARS) return { text, binary, truncated: false };
  const cut = text.lastIndexOf('\n', MAX_DIFF_CHARS);
  return { text: text.slice(0, cut > 0 ? cut + 1 : MAX_DIFF_CHARS), binary, truncated: true };
}

/** A new file, shown as a diff that adds every line. */
export function additionDiff(file: string, bytes: Uint8Array): GitDiff {
  if (looksBinary(bytes)) return { text: '', binary: true, truncated: false };
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  if (!text) return { text: '', binary: false, truncated: false };
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const body = lines.map((line) => `+${line.replace(/\r$/, '')}`).join('\n');
  return finishDiff(`--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`);
}

export async function gitDiff(cwd: string, target: GitDiffTarget): Promise<GitDiff> {
  const root = await repoRoot(cwd);
  const paths = checkPaths(root, target);
  const base = ['--no-ext-diff', '--no-color', '-M'];
  if (target.kind === 'untracked') {
    const file = resolveInside(root, target.path);
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_DIFF_CHARS);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const diff = additionDiff(target.path, buffer.subarray(0, bytesRead));
      return size > bytesRead ? { ...diff, truncated: true } : diff;
    } finally {
      await handle.close();
    }
  }
  if (target.kind === 'commit') {
    return finishDiff(await git(root, ['show', '--format=', '--diff-merges=first-parent', ...base, checkHash(target.hash), '--', ...paths]));
  }
  return finishDiff(await git(root, ['diff', ...(target.kind === 'staged' ? ['--cached'] : []), ...base, '--', ...paths]));
}

export async function gitCommit(cwd: string, hash: string): Promise<GitCommitDetails> {
  const root = await repoRoot(cwd);
  checkHash(hash);
  const [meta, numstat] = await Promise.all([
    git(root, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B', hash]),
    git(root, ['show', '--format=', '--numstat', '-z', '-M', '--diff-merges=first-parent', hash])
  ]);
  const [full, author, email, date, ...message] = meta.split('\x1f');
  return { hash: full.trim(), author, email, date, message: message.join('\x1f').trim(), files: parseNumstat(numstat) };
}

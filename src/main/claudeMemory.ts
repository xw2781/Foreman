import fs from 'node:fs';
import path from 'node:path';
import { exists, linkDirectory } from './util';

// Claude Code keeps auto memory per project inside its config folder
// (<config>/projects/<project>/memory). An isolated account would start each
// project with no memory and keep its own; linking its folder to the primary
// account's gives every account the same notes, and whatever the primary
// folder itself points at (a repo's memory folder, say) applies to all.

/** Claude Code's folder name for a path: every non-alphanumeric becomes '-'. */
export function claudeProjectDirName(dir: string): string | null {
  const name = dir.replace(/[^a-zA-Z0-9]/g, '-');
  // Longer names get a hash suffix we can't reproduce reliably; leave those alone.
  return name.length <= 200 ? name : null;
}

/**
 * The folder Claude Code files a project's memory under: the main checkout of
 * the git repository containing `cwd` (worktrees share it), else `cwd`.
 */
export function memoryProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dir;
      // A worktree: `.git` is a file naming <main>/.git/worktrees/<name>.
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!match) return dir;
      const gitDir = path.resolve(dir, match[1].trim());
      let common = gitDir;
      try {
        common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      } catch {
        // not a linked worktree (a submodule, say): its own folder
        return dir;
      }
      return path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : dir;
    } catch {
      // no .git here
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/**
 * Points an account's memory folder for `cwd` at the primary account's. Notes
 * the account already wrote move to the primary folder first (a note with the
 * same name already there stays behind, and so does the account's folder).
 * Returns whether the account's folder is now linked.
 */
export function shareClaudeMemory(primaryDir: string, accountDir: string, cwd: string): boolean {
  const name = claudeProjectDirName(memoryProjectRoot(cwd));
  if (!name) return false;
  const target = path.join(primaryDir, 'projects', name, 'memory');
  const link = path.join(accountDir, 'projects', name, 'memory');
  if (path.resolve(target).toLowerCase() === path.resolve(link).toLowerCase()) return false;
  try {
    if (fs.lstatSync(link).isSymbolicLink()) return true;
    if (!moveNotes(link, target)) return false;
    fs.rmdirSync(link);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') return false;
  }
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  return linkDirectory(target, link);
}

/** Moves the notes in `from` into `to`, merging MEMORY.md; false when something had to stay. */
function moveNotes(from: string, to: string): boolean {
  fs.mkdirSync(to, { recursive: true });
  let complete = true;
  for (const entry of fs.readdirSync(from)) {
    const source = path.join(from, entry);
    const dest = path.join(to, entry);
    if (entry === 'MEMORY.md' && exists(dest)) {
      appendNewLines(source, dest);
      fs.rmSync(source);
    } else if (!exists(dest)) {
      fs.renameSync(source, dest);
    } else {
      complete = false;
    }
  }
  return complete;
}

/** Appends the lines of `source` that `dest` doesn't have yet (index entries). */
function appendNewLines(source: string, dest: string) {
  const current = fs.readFileSync(dest, 'utf8');
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const added = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !have.has(l.trim()));
  if (!added.length) return;
  fs.writeFileSync(dest, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${added.join('\n')}\n`);
}

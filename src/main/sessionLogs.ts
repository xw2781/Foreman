import fs from 'node:fs';
import path from 'node:path';
import type { Profile, Provider } from '../shared/types';
import { readJsonFile, samePath, writeJsonFileAtomic } from './util';

// Where session transcripts live, and how long Claude Code keeps them.
//
// Neither CLI can be told to write transcripts elsewhere: Claude Code always
// uses <config>/projects, Codex <CODEX_HOME>/sessions and archived_sessions.
// To store them in another folder, the folder moves to
// <chosen>/<account id>/<name> and a directory junction is left in its place,
// so the CLIs, `--resume` and the telemetry worker all keep the same paths.

/** The folders of an account that hold its session transcripts. */
export const LOG_FOLDERS: Record<Provider, string[]> = {
  claude: ['projects'],
  codex: ['sessions', 'archived_sessions']
};

export const DEFAULT_RETENTION_DAYS = 90;
export const MAX_RETENTION_DAYS = 36_500;

/** Days Claude Code keeps transcripts: a whole number of at least 1 (0 would make it delete them all). */
export function retentionDays(value: unknown): number {
  const days = Math.round(Number(value));
  return Number.isFinite(days) && days >= 1 ? Math.min(MAX_RETENTION_DAYS, days) : DEFAULT_RETENTION_DAYS;
}

function claudeSettingsFile(profile: Profile) {
  return path.join(profile.configDir, 'settings.json');
}

/** The account's own `cleanupPeriodDays`, if it sets one. */
export function readClaudeRetention(profile: Profile): number | null {
  const value = readJsonFile<any>(claudeSettingsFile(profile))?.cleanupPeriodDays;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Writes `cleanupPeriodDays` into the account's settings.json, keeping
 * everything else. It goes there rather than into the per-agent --settings
 * file because Claude Code prunes at startup with whatever settings it runs
 * with, including sessions started outside Foreman. Returns whether it changed.
 */
export function writeClaudeRetention(profile: Profile, days: number): boolean {
  const file = claudeSettingsFile(profile);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = readJsonFile<unknown>(file);
    // Unreadable: leave it for the person to fix rather than replace it.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not valid JSON.`);
    settings = parsed as Record<string, unknown>;
  }
  if (settings.cleanupPeriodDays === days) return false;
  writeJsonFileAtomic(file, { ...settings, cleanupPeriodDays: days });
  return true;
}

/** Where a log folder belongs: inside the account folder, or `<root>/<account id>/<name>`. */
export function wantedLocation(profile: Profile, name: string, root: string): string {
  return root ? path.join(root, profile.id, name) : path.join(profile.configDir, name);
}

function isLink(file: string) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where the folder's files really are: itself, a junction's target, or null when it doesn't exist. */
export function currentLocation(home: string): string | null {
  try {
    const stat = fs.lstatSync(home);
    if (stat.isSymbolicLink()) return path.resolve(path.dirname(home), fs.readlinkSync(home));
    return stat.isDirectory() ? home : null;
  } catch {
    return null;
  }
}

function unlinkJunction(file: string) {
  try {
    fs.unlinkSync(file);
  } catch {
    fs.rmdirSync(file);
  }
}

function freeSibling(dir: string) {
  for (let n = 0; ; n++) {
    const candidate = `${dir}.foreman-move${n ? `-${n}` : ''}`;
    if (!fs.existsSync(candidate) && !isLink(candidate)) return candidate;
  }
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Moves `from`'s contents into `to`, renaming where it can and copying across drives. Returns whether `from` emptied. */
export async function mergeMove(from: string, to: string): Promise<boolean> {
  await fs.promises.mkdir(to, { recursive: true });
  let complete = true;
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    const taken = fs.existsSync(dest) || isLink(dest);
    if (taken && entry.isDirectory() && !isLink(dest) && fs.statSync(dest).isDirectory()) {
      if (await mergeMove(source, dest)) await fs.promises.rmdir(source);
      else complete = false;
      continue;
    }
    if (taken) {
      // Written at the new place during the move; the older copy stays behind.
      complete = false;
      continue;
    }
    try {
      await fs.promises.rename(source, dest);
    } catch (error: any) {
      if (error?.code !== 'EXDEV') throw error;
      if (entry.isSymbolicLink()) {
        // A junction (an account's shared memory): recreate it, never follow it.
        fs.symlinkSync(fs.readlinkSync(source), dest, 'junction');
        unlinkJunction(source);
      } else if (entry.isDirectory()) {
        if (await mergeMove(source, dest)) await fs.promises.rmdir(source);
        else complete = false;
      } else {
        await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
        const stat = await fs.promises.stat(source);
        await fs.promises.utimes(dest, stat.atime, stat.mtime);
        await fs.promises.rm(source);
      }
    }
  }
  return complete;
}

/**
 * Puts a log folder's files at `wanted`, leaving a junction at `home` when
 * they're elsewhere. The files first move aside by a rename in place, which
 * fails while a running CLI holds one open, so nothing is half-moved then;
 * the junction is in place before the (possibly slow) move across drives
 * starts, so anything written meanwhile lands at the new place.
 * Returns a folder that kept files it couldn't move (null when none did).
 */
export async function placeFolder(home: string, wanted: string): Promise<string | null> {
  const current = currentLocation(home);
  if (current && samePath(current, wanted)) return null;
  const parked: string[] = [];
  if (current) {
    const aside = freeSibling(current);
    try {
      await fs.promises.rename(current, aside);
      parked.push(aside);
    } catch (error: any) {
      if (BUSY.has(error?.code)) throw new Error(`${current} is in use. Close Claude Code and Codex sessions (including ones outside Foreman) and try again.`);
      if (error?.code !== 'ENOENT') throw error;
      // A junction to a folder that is gone: nothing to move.
    }
  }
  if (isLink(home)) unlinkJunction(home);
  await fs.promises.mkdir(wanted, { recursive: true });
  if (!samePath(home, wanted)) {
    // A CLI may have started a fresh folder in the moment between.
    if (fs.existsSync(home)) {
      const stray = freeSibling(home);
      await fs.promises.rename(home, stray);
      parked.push(stray);
    }
    await fs.promises.mkdir(path.dirname(home), { recursive: true });
    fs.symlinkSync(wanted, home, 'junction');
  }
  let leftover: string | null = null;
  for (const dir of parked) {
    if (await mergeMove(dir, wanted)) await fs.promises.rmdir(dir);
    else leftover = dir;
  }
  return leftover;
}

/** A chosen folder can't sit inside a log folder it would receive. */
export function checkLogsRoot(root: string, profiles: Profile[]) {
  if (!root) return;
  if (!path.isAbsolute(root)) throw new Error('Choose a full folder path.');
  const inside = (dir: string, parent: string) => samePath(dir, parent) || path.resolve(dir).toLowerCase().startsWith(`${path.resolve(parent).toLowerCase()}${path.sep}`);
  for (const profile of profiles) {
    for (const name of LOG_FOLDERS[profile.provider]) {
      const home = path.join(profile.configDir, name);
      const current = currentLocation(home);
      if (inside(root, home) || (current && inside(root, current))) throw new Error(`The folder can't be inside ${current ?? home}.`);
    }
  }
}

/**
 * Moves every account's log folders to `root` ('' puts them back inside each
 * account folder). A folder that can't move now (in use) doesn't stop the
 * others; moving again later finishes it.
 */
export async function placeSessionLogs(profiles: Profile[], root: string): Promise<{ leftovers: string[]; errors: string[] }> {
  checkLogsRoot(root, profiles);
  const leftovers: string[] = [];
  const errors: string[] = [];
  for (const profile of profiles) {
    const vacated = new Set<string>();
    for (const name of LOG_FOLDERS[profile.provider]) {
      const home = path.join(profile.configDir, name);
      const previous = currentLocation(home);
      try {
        const leftover = await placeFolder(home, wantedLocation(profile, name, root));
        if (leftover) leftovers.push(leftover);
        if (previous && !samePath(previous, home)) vacated.add(path.dirname(previous));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    // The account's folder under the previous chosen folder, once empty.
    for (const dir of vacated) {
      if (samePath(dir, profile.configDir)) continue;
      try {
        await fs.promises.rmdir(dir);
      } catch {
        // not empty, or already gone
      }
    }
  }
  return { leftovers, errors };
}

/** The moved logs of an account, deleted with its data (`removeTree` only unlinks the junctions). */
export function movedLogsDir(profile: Profile, root: string): string | null {
  return root ? path.join(root, profile.id) : null;
}

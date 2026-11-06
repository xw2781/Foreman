import fs from 'node:fs';
import path from 'node:path';
import type { Profile, Provider } from '../shared/types';
import { readJsonFile, samePath, writeJsonFileAtomic } from './util';

// Where Foreman's data lives, and how long Claude Code keeps transcripts.
//
// One data folder (Settings -> Data storage) holds everything that grows:
// every account folder at <chosen>/<account id> (transcripts, file history,
// credentials and all) and the computer-use working folder (screenshots, the
// action log) at <chosen>/computer-use. Each moves there and leaves a
// directory junction at its usual path, so the CLIs, `--resume`, the skill
// and the telemetry worker all keep using the same paths.
//
// Earlier versions moved only the transcript folders, to
// <chosen>/<account id>/<name>: exactly where they belong inside a moved
// account folder, so that layout folds into this one without copying.

/** The folders of an account that hold its session transcripts (moved on their own by earlier versions). */
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

/** The computer-use folder's name inside the data folder (account ids start with their provider). */
export const COMPUTER_USE_FOLDER = 'computer-use';

/** Where an account's folder belongs: where the CLI keeps it, or `<root>/<account id>`. */
export function accountLocation(profile: Profile, root: string): string {
  return root ? path.join(root, profile.id) : profile.configDir;
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
const CLI_BUSY = 'Close Claude Code and Codex everywhere (VS Code, terminals, desktop apps), then try again.';

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
export async function placeFolder(home: string, wanted: string, busyHint = CLI_BUSY): Promise<string | null> {
  const current = currentLocation(home);
  if (current && samePath(current, wanted)) return null;
  const parked: string[] = [];
  if (current) {
    const aside = freeSibling(current);
    try {
      await fs.promises.rename(current, aside);
      parked.push(aside);
    } catch (error: any) {
      if (BUSY.has(error?.code)) throw new Error(`${current} is in use. ${busyHint}`);
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

const inside = (dir: string, parent: string) =>
  samePath(dir, parent) || path.resolve(dir).toLowerCase().startsWith(`${path.resolve(parent).toLowerCase()}${path.sep}`);

/** A chosen folder can't sit inside a folder it would receive. */
export function checkDataRoot(root: string, profiles: Profile[], computerUseHome: string | null = null) {
  if (!root) return;
  if (!path.isAbsolute(root)) throw new Error('Choose a full folder path.');
  const homes = [...profiles.map((p) => p.configDir), ...(computerUseHome ? [computerUseHome] : [])];
  for (const home of homes) {
    const current = currentLocation(home);
    if (inside(root, home) || (current && inside(root, current))) throw new Error(`The folder can't be inside ${current ?? home}.`);
  }
}

/**
 * Puts one account's folder at `accountLocation`. Transcript folders an earlier
 * version moved on their own come back inside it: unlinked when they already
 * sit where the moved account folder puts them, moved in otherwise.
 */
async function placeAccount(profile: Profile, root: string): Promise<string[]> {
  const wanted = accountLocation(profile, root);
  const leftovers: string[] = [];
  const separate: string[] = [];
  for (const name of LOG_FOLDERS[profile.provider]) {
    const home = path.join(profile.configDir, name);
    if (!isLink(home)) continue;
    if (samePath(currentLocation(home), path.join(wanted, name))) unlinkJunction(home);
    else separate.push(name);
  }
  const leftover = await placeFolder(profile.configDir, wanted);
  if (leftover) leftovers.push(leftover);
  for (const name of separate) {
    const home = path.join(profile.configDir, name);
    const target = currentLocation(home);
    if (!isLink(home)) continue;
    unlinkJunction(home);
    if (!target || !fs.existsSync(target)) continue;
    if (await mergeMove(target, home)) {
      await fs.promises.rmdir(target);
      // The account's folder under the old transcript folder, once empty.
      await fs.promises.rmdir(path.dirname(target)).catch(() => {});
    } else leftovers.push(target);
  }
  return leftovers;
}

/**
 * Moves every account folder, and the computer-use folder when given, to
 * `root` ('' puts each back where it belongs). A folder that can't move now
 * (in use) doesn't stop the others; moving again later finishes it.
 */
export async function placeDataFolders(profiles: Profile[], root: string, computerUseHome: string | null = null): Promise<{ leftovers: string[]; errors: string[] }> {
  checkDataRoot(root, profiles, computerUseHome);
  const leftovers: string[] = [];
  const errors: string[] = [];
  for (const profile of profiles) {
    try {
      leftovers.push(...(await placeAccount(profile, root)));
    } catch (error) {
      errors.push(`${profile.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (computerUseHome) {
    try {
      const leftover = await placeFolder(computerUseHome, root ? path.join(root, COMPUTER_USE_FOLDER) : computerUseHome, 'Turn off the computer-use overlay (Computer Use page), then try again.');
      if (leftover) leftovers.push(leftover);
    } catch (error) {
      errors.push(`Computer use: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { leftovers, errors };
}

/** A moved account folder, deleted with the account's data (`removeTree` only unlinks the junction). */
export function movedAccountDir(profile: Profile, root: string): string | null {
  return root ? path.join(root, profile.id) : null;
}

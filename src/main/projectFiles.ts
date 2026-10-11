import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFileEntry, ProjectFilePreview } from '../shared/types';

/** More than this many entries in one folder are left out of the listing (and counted). */
export const MAX_ENTRIES = 3000;
/** Text files are shown up to this many bytes. */
export const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
};

function pathsFor(root: string) {
  return /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') ? path.win32 : path.posix;
}

/** The absolute path of `relative` inside `root`; anything that leaves the folder is refused. */
export function resolveInside(root: string, relative: string): string {
  const paths = pathsFor(root);
  if (/[\u0000-\u001f]/.test(relative)) throw new Error('Invalid path.');
  const base = paths.resolve(root);
  const target = paths.resolve(base, relative || '.');
  const rest = paths.relative(base, target);
  if (rest === '..' || rest.startsWith(`..${paths.sep}`) || paths.isAbsolute(rest)) throw new Error('That path is outside the project folder.');
  return target;
}

function relativeOf(root: string, target: string) {
  const paths = pathsFor(root);
  return paths.relative(paths.resolve(root), target).split(paths.sep).join('/');
}

/** Folders first, then files, each in natural order (file2 before file10). */
export function sortEntries<T extends { name: string; dir: boolean }>(entries: T[]): T[] {
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
}

export async function listProjectDirectory(root: string, relative: string): Promise<{ entries: ProjectFileEntry[]; omitted: number }> {
  const dir = resolveInside(root, relative);
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<ProjectFileEntry> => {
      const full = path.join(dir, dirent.name);
      let isDir = dirent.isDirectory();
      let size = 0;
      let modifiedMs = 0;
      try {
        // Follows links and junctions, so a linked folder opens like any other.
        const stat = await fs.promises.stat(full);
        isDir = stat.isDirectory();
        size = isDir ? 0 : stat.size;
        modifiedMs = stat.mtimeMs;
      } catch {
        // A broken link or a file in use is still listed.
      }
      return { name: dirent.name, path: relativeOf(root, full), dir: isDir, size, modifiedMs };
    })
  );
  const sorted = sortEntries(entries);
  return { entries: sorted.slice(0, MAX_ENTRIES), omitted: Math.max(0, sorted.length - MAX_ENTRIES) };
}

/** A NUL byte near the start means the file isn't text. */
export function looksBinary(bytes: Uint8Array) {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export async function readProjectFile(root: string, relative: string): Promise<ProjectFilePreview> {
  const file = resolveInside(root, relative);
  const stat = await fs.promises.stat(file);
  if (stat.isDirectory()) throw new Error('That is a folder.');
  const base = { path: relativeOf(root, file), size: stat.size, modifiedMs: stat.mtimeMs };
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (type) {
    if (stat.size > MAX_IMAGE_BYTES) return { kind: 'too-large', ...base };
    const data = await fs.promises.readFile(file);
    return { kind: 'image', ...base, dataUrl: `data:${type};base64,${data.toString('base64')}` };
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    const length = Math.min(stat.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (looksBinary(bytes)) return { kind: 'binary', ...base };
    // A cut can split a multi-byte character; the decoder replaces the partial one.
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    return { kind: 'text', ...base, text, truncated: stat.size > bytesRead };
  } finally {
    await handle.close();
  }
}

// The picture behind a Codex "Viewed image" step. Codex reports only the path
// of the file it looked at, so the step's picture is read from disk here.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEntry } from '../../shared/types';

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Larger files stay a path: the picture travels to the renderer as a data URL. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * A "Viewed image" step with its picture attached, when the file is still there to read.
 * `cwd` resolves a relative path. `at` is when the step happened (history): a file changed
 * since then is no longer what the agent saw, so it is left out.
 */
export function withViewedImage<T extends ChatEntry>(entry: T, options: { cwd?: string; at?: string | null } = {}): T {
  if (entry.kind !== 'tool' || entry.tool !== 'view_image' || !entry.input || entry.images?.length) return entry;
  const type = TYPES[path.extname(entry.input).toLowerCase()];
  if (!type || (!path.isAbsolute(entry.input) && !options.cwd)) return entry;
  try {
    const file = path.resolve(options.cwd ?? '', entry.input);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) return entry;
    const seen = options.at ? Date.parse(options.at) : NaN;
    if (Number.isFinite(seen) && stat.mtimeMs > seen + 2000) return entry;
    const dataUrl = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
    return { ...entry, images: [{ name: path.basename(file), dataUrl }] };
  } catch {
    return entry;
  }
}

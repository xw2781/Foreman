/**
 * Referencing project files in a chat message, from the Files and Git panels:
 * paths for the clipboard, the `@path` mention put into the composer, and the drag payload.
 */

/** Drag type for a file row: JSON `{ agentId, full }`. Rows also set text/plain to the mention. */
export const FILE_REF_TYPE = 'application/x-foreman-file';

const windowsLike = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\') || p.includes('\\');

/** `base` joined with a `/`-separated relative path, using `base`'s separator. */
export function joinPath(base: string, relative: string): string {
  if (!relative) return base;
  const sep = windowsLike(base) ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${relative.split('/').join(sep)}`;
}

/**
 * `full` relative to `cwd`, with `/`, or null when it lies outside `cwd`
 * (a `../` chain reads worse than the full path). '' is `cwd` itself.
 */
export function relativeTo(cwd: string, full: string): string | null {
  const win = windowsLike(cwd) || windowsLike(full);
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return win ? s.toLowerCase() : s;
  };
  const base = norm(cwd);
  const target = norm(full);
  if (target === base) return '';
  if (!target.startsWith(`${base}/`)) return null;
  return full.replace(/\\/g, '/').replace(/\/+$/, '').slice(base.length + 1);
}

export interface FileRef {
  /** Absolute path, with the platform's separator. */
  full: string;
  /** Relative to the agent's folder with `/`, or the full path when outside it. */
  relative: string;
  name: string;
}

export function fileRef(cwd: string, full: string): FileRef {
  const relative = relativeTo(cwd, full);
  const trimmed = full.replace(/[\\/]+$/, '');
  return { full, relative: relative || (relative === '' ? '.' : full), name: trimmed.split(/[\\/]/).pop() || trimmed };
}

/** The mention put into a message: `@path`, or ``@`path` `` when the path has spaces or other punctuation. */
export function formatRef(path: string): string {
  if (/^[\w./\\:@+~-]+$/.test(path)) return `@${path}`;
  const ticks = path.includes('`') ? '``' : '`';
  const pad = path.startsWith('`') || path.endsWith('`') ? ' ' : '';
  return `@${ticks}${pad}${path}${pad}${ticks}`;
}

/** `text` with `insert` put at `caret`, spaced from the words around it; returns the caret after it. */
export function insertAt(text: string, caret: number, insert: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const head = before + (before && !/\s$/.test(before) ? ' ' : '') + insert;
  const tail = after && !/^\s/.test(after) ? ` ${after}` : after || ' ';
  return { text: head + tail, caret: head.length + 1 };
}

/**
 * Where a native drop put `inserted` into `previous`, giving `next`: the text with the
 * mention spaced from its neighbours. Null when `next` isn't `previous` plus `inserted`.
 */
export function spaceDrop(previous: string, next: string, inserted: string): { text: string; caret: number } | null {
  if (next.length !== previous.length + inserted.length) return null;
  let at = 0;
  while (at < previous.length && previous[at] === next[at]) at++;
  // The common prefix can run into the insertion when they share characters; walk back to where it fits.
  for (let start = at; start >= 0; start--) {
    if (next.slice(start, start + inserted.length) === inserted && next.slice(0, start) + next.slice(start + inserted.length) === previous) {
      return insertAt(previous, start, inserted.trim());
    }
  }
  return null;
}

/** Each open composer's way to put text at its caret, by agent id. */
export const composerInsert = new Map<string, (text: string) => void>();

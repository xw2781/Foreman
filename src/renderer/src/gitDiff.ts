/** One line of a unified diff as the Git tab shows it. */
export interface DiffRow {
  kind: 'meta' | 'hunk' | 'context' | 'add' | 'remove' | 'note';
  text: string;
  /** Line numbers in the old and new file (context lines have both). */
  old?: number;
  new?: number;
}

/** Headers git always prints, which the panel's own title already covers. */
const SKIP = /^(diff --git |index [0-9a-f]|--- |\+\+\+ )/;

/**
 * Splits unified diff text into rows with line numbers. Hunk lengths come from the `@@` header, so a
 * removed line that starts with `--` isn't mistaken for a file header.
 */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (oldLeft > 0 || newLeft > 0) {
      const sign = line[0];
      const body = line.slice(1);
      if (sign === '+') {
        rows.push({ kind: 'add', text: body, new: newLine++ });
        newLeft--;
        continue;
      }
      if (sign === '-') {
        rows.push({ kind: 'remove', text: body, old: oldLine++ });
        oldLeft--;
        continue;
      }
      if (sign === ' ' || line === '') {
        rows.push({ kind: 'context', text: body, old: oldLine++, new: newLine++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (sign === '\\') {
        rows.push({ kind: 'note', text: line.slice(2) });
        continue;
      }
      // Malformed: leave the hunk and read the line as a header.
      oldLeft = newLeft = 0;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(2) });
    else if (!SKIP.test(line)) rows.push({ kind: 'meta', text: line });
  }
  return rows;
}

/** A path split into its file name and the folder it's in ('' at the top). */
export function splitPath(file: string) {
  const trimmed = file.replace(/\/$/, '');
  const cut = trimmed.lastIndexOf('/');
  return { name: trimmed.slice(cut + 1), dir: cut < 0 ? '' : trimmed.slice(0, cut) };
}

function normalize(value: string) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The worktree each folder belongs to: the deepest one containing it (worktrees can nest inside the main one). */
export function worktreeOf(folder: string, worktrees: string[]): string | null {
  const target = normalize(folder);
  let best: string | null = null;
  for (const tree of worktrees) {
    const root = normalize(tree);
    if ((target === root || target.startsWith(`${root}/`)) && (!best || root.length > normalize(best).length)) best = tree;
  }
  return best;
}

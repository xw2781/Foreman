const FENCE = /^\s*(`{3,}|~{3,})/;
const ONE_LINE = /^(\s*)\$\$((?:(?!\$\$).)+)\$\$\s*$/;

/**
 * Puts display-math `$$` fences on lines of their own. remark-math treats `$$` like a code
 * fence: text after an opening `$$` is dropped as its info string, and only a bare `$$` line
 * closes the block, so `$$a\nb$$` hides `a` and runs on through the prose that follows.
 * A whole-line `$$a$$` becomes a display block too, instead of inline math.
 */
export function normalizeDisplayMath(text: string): string {
  if (!text.includes('$$')) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let indent: string | null = null;
  for (const line of text.split('\n')) {
    if (indent === null) {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        out.push(line);
        continue;
      }
      if (marker) {
        fence = marker;
        out.push(line);
        continue;
      }
      const single = ONE_LINE.exec(line);
      if (single) {
        out.push(`${single[1]}$$`, `${single[1]}${single[2].trim()}`, `${single[1]}$$`);
        continue;
      }
      const open = /^(\s*)\$\$(.*)$/.exec(line);
      if (!open) {
        out.push(line);
        continue;
      }
      indent = open[1];
      out.push(`${indent}$$`);
      if (open[2].trim()) out.push(`${indent}${open[2].trim()}`);
      continue;
    }
    const close = line.indexOf('$$');
    if (close < 0) {
      out.push(line);
      continue;
    }
    const before = line.slice(0, close);
    const after = line.slice(close + 2);
    if (before.trim()) out.push(before);
    out.push(`${indent}$$`);
    if (after.trim()) out.push(`${indent}${after.trim()}`);
    indent = null;
  }
  return out.join('\n');
}

const DISPLAY_FENCE = /^\s*\$\$\s*$/;

/**
 * Escapes `$` signs that aren't inline math, so prices survive remark-math, which pairs any two
 * single dollars: "the $8.02 row … about $5.5" would otherwise render as one run of math.
 * Uses Pandoc's rule: an opening `$` is followed by a non-space, a closing `$` follows a
 * non-space and isn't followed by a digit. An opener whose next `$` can't close it is a price.
 * Code fences, display-math blocks and code spans are left alone. Run after
 * normalizeDisplayMath, which puts display `$$` fences on their own lines.
 */
export function escapeCurrencyDollars(text: string): string {
  if (!text.includes('$')) return text;
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push(escapeInline(para.join('\n')));
    para = [];
  };
  let fence: string | null = null;
  let math = false;
  for (const line of text.split('\n')) {
    if (fence) {
      const marker = FENCE.exec(line)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (math) {
      if (DISPLAY_FENCE.test(line)) math = false;
      out.push(line);
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker || DISPLAY_FENCE.test(line) || !line.trim()) {
      flush();
      if (marker) fence = marker;
      else if (line.trim()) math = true;
      out.push(line);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/** One paragraph: inline math can't span a blank line. */
function escapeInline(s: string): string {
  const escape: number[] = [];
  let opener = -1;
  const runAt = (i: number, ch: string): number => {
    let n = 0;
    while (s[i + n] === ch) n++;
    return n;
  };
  /** Index just past the next run of exactly `n` × `ch` after `from`, or -1. */
  const closingRun = (from: number, ch: string, n: number): number => {
    for (let j = from; j < s.length; ) {
      const m = runAt(j, ch);
      if (m === n) return j + n;
      j += m || 1;
    }
    return -1;
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (opener < 0 && c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`' || (c === '$' && runAt(i, '$') > 1)) {
      const n = runAt(i, c);
      // Inside inline math, backticks and $$ are just content.
      const end = opener < 0 ? closingRun(i + n, c, n) : -1;
      i = end < 0 ? i + n : end;
      continue;
    }
    if (c !== '$') {
      i++;
      continue;
    }
    const prev = s[i - 1];
    const next = s[i + 1];
    if (opener >= 0) {
      if (prev !== undefined && !/\s/.test(prev) && !(next !== undefined && /\d/.test(next))) {
        opener = -1;
        i++;
        continue;
      }
      escape.push(opener);
      opener = -1;
    }
    if (next !== undefined && !/\s/.test(next)) opener = i;
    else escape.push(i);
    i++;
  }
  if (opener >= 0) escape.push(opener);
  if (!escape.length) return s;
  escape.sort((a, b) => a - b);
  let out = '';
  let last = 0;
  for (const at of escape) {
    out += s.slice(last, at) + '\\';
    last = at;
  }
  return out + s.slice(last);
}

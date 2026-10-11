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

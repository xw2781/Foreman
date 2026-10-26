import type { IBuffer, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';

// ConPTY can emit explicit line breaks at the right edge. xterm then marks
// those rows as unwrapped, so WebLinksAddon only opens the first row of a URL.
// Supply these links before the addon; ordinary links still use its detector.
export function wrappedLinkProvider(
  buffer: () => IBuffer,
  columns: () => number,
  open: (url: string) => void
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const active = buffer();
      const links: ILink[] = [];
      for (let row = Math.max(0, y - 32); row < y; row++) {
        const first = active.getLine(row);
        if (!first) continue;
        const text = first.translateToString(true);
        for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
          let url = match[0];
          let endRow = row;
          let endColumn = columnAt(first, match.index + url.length);
          let hardWrap = false;
          while (url.length < 8192 && endRow - row < 32) {
            const next = active.getLine(endRow + 1);
            if (!next) break;
            const continuation = next.translateToString(true);
            // A hard break is ambiguous: require a full preceding row and a
            // continuation made entirely of URL characters, never prompt text.
            if (!next.isWrapped && (endColumn !== columns() || !/^[^\s"'<>`]+$/.test(continuation))) break;
            if (/^https?:\/\//i.test(continuation)) break;
            const part = continuation.match(/^[^\s"'<>`]+/)?.[0];
            if (!part) break;
            hardWrap ||= !next.isWrapped;
            url += part;
            endRow++;
            endColumn = columnAt(next, part.length);
            if (part.length !== continuation.length) break;
          }
          if (!hardWrap || endRow < y - 1) continue;
          try { new URL(url); } catch { continue; }
          links.push({
            text: url,
            range: {
              start: { x: columnAt(first, match.index) + 1, y: row + 1 },
              end: { x: endColumn, y: endRow + 1 }
            },
            activate: () => open(url)
          });
        }
      }
      callback(links.length ? links : undefined);
    }
  };
}

/** Translate string offsets to terminal columns (prefixes can contain wide characters). */
function columnAt(line: IBufferLine, offset: number): number {
  let length = 0;
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    if (length >= offset) return column;
    length += (cell.getChars() || ' ').length;
  }
  return line.length;
}

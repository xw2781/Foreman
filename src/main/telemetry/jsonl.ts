import fs from 'node:fs';

const CHUNK_BYTES = 1024 * 1024;

/**
 * Reads a growing JSONL file incrementally: every call parses only the bytes
 * appended since the previous call. A file that shrank is treated as a new
 * file and re-read from the start (the caller is told so it can reset state).
 */
export class IncrementalLineReader {
  offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(readonly filePath: string) {}

  /** Returns false when the file was truncated/replaced and the caller must reset its state. */
  async read(onLine: (line: string) => void): Promise<boolean> {
    const stat = await fs.promises.stat(this.filePath);
    let continuous = true;
    if (stat.size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      continuous = false;
    }
    if (stat.size === this.offset) return continuous;

    const handle = await fs.promises.open(this.filePath, 'r');
    try {
      while (this.offset < stat.size) {
        const length = Math.min(CHUNK_BYTES, stat.size - this.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        const chunk = this.pending.length > 0
          ? Buffer.concat([this.pending, buffer.subarray(0, bytesRead)])
          : buffer.subarray(0, bytesRead);
        // Split on the byte, not on decoded text: a chunk edge can fall mid-character.
        const lastBreak = chunk.lastIndexOf(0x0a);
        if (lastBreak < 0) {
          this.pending = Buffer.from(chunk);
          continue;
        }
        this.pending = Buffer.from(chunk.subarray(lastBreak + 1));
        const text = chunk.subarray(0, lastBreak).toString('utf8');
        let start = 0;
        while (start <= text.length) {
          let end = text.indexOf('\n', start);
          if (end < 0) end = text.length;
          let line = text.slice(start, end);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line) onLine(line);
          start = end + 1;
        }
      }
    } finally {
      await handle.close();
    }
    return continuous;
  }
}

export function tryParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function object(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

export function parseTime(value: unknown): number {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Local calendar day, YYYY-MM-DD. Spend is grouped by the user's own days. */
export function localDay(timestamp: string | number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface DayAccumulator {
  usd: number;
  tokens: number;
  requests: number;
}

export function addToDay(byDay: Map<string, DayAccumulator>, day: string | null, usd: number | null, tokens: number) {
  if (!day) return;
  let entry = byDay.get(day);
  if (!entry) {
    entry = { usd: 0, tokens: 0, requests: 0 };
    byDay.set(day, entry);
  }
  entry.usd += usd ?? 0;
  entry.tokens += tokens;
  entry.requests += 1;
}

const TITLE_MAX = 60;

export function promptTitle(value: string | null): string | null {
  const firstLine = String(value ?? '').split(/\r?\n/).find((line) => line.trim());
  const trimmed = firstLine ? firstLine.trim().replace(/\s+/g, ' ') : '';
  if (!trimmed) return null;
  if (trimmed.length <= TITLE_MAX) return trimmed;
  const clipped = trimmed.slice(0, TITLE_MAX - 3);
  const lastSpace = clipped.lastIndexOf(' ');
  const head = lastSpace > TITLE_MAX / 2 ? clipped.slice(0, lastSpace) : clipped;
  return `${head.trimEnd()}...`;
}

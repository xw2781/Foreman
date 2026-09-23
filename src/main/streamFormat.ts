// Renders `claude --print --output-format stream-json` events as a readable,
// colored log for the terminal view of a background task.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

function crlf(text: string) {
  return text.replace(/\r?\n/g, '\r\n');
}

function clip(text: string, max: number) {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function describeToolInput(name: string, input: Record<string, any> | null | undefined): string {
  if (!input) return '';
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof pick === 'string') return clip(pick, 90);
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return '';
}

export interface StreamResult {
  subtype: string | null;
  isError: boolean;
  costUsd: number | null;
  sessionId: string | null;
}

export class ClaudeStreamFormatter {
  private pending = '';
  sessionId: string | null = null;
  model: string | null = null;
  result: StreamResult | null = null;
  lastTool: string | null = null;

  /** Feeds raw stdout; returns terminal-ready text. */
  push(chunk: string): string {
    this.pending += chunk;
    let out = '';
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (line) out += this.formatLine(line);
      newline = this.pending.indexOf('\n');
    }
    return out;
  }

  flush(): string {
    const rest = this.pending.trim();
    this.pending = '';
    return rest ? this.formatLine(rest) : '';
  }

  private formatLine(line: string): string {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return `${crlf(line)}\r\n`;
    }
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.sessionId = event.session_id ?? this.sessionId;
          this.model = event.model ?? this.model;
          return `${DIM}● session ${event.session_id ?? ''} · ${event.model ?? ''} · ${event.cwd ?? ''}${RESET}\r\n\r\n`;
        }
        if (event.subtype === 'compact_boundary') return `${YELLOW}● context compacted${RESET}\r\n`;
        return '';
      case 'assistant': {
        let out = '';
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            out += `${crlf(block.text.trim())}\r\n\r\n`;
          } else if (block.type === 'tool_use') {
            this.lastTool = block.name;
            const detail = describeToolInput(block.name, block.input);
            out += `${CYAN}● ${BOLD}${block.name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}\r\n`;
          }
        }
        return out;
      }
      case 'user': {
        let out = '';
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const content = Array.isArray(block.content)
            ? block.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
            : String(block.content ?? '');
          const color = block.is_error ? RED : DIM;
          const summary = clip(content, 110);
          out += `  ${color}⎿ ${summary || (block.is_error ? 'error' : 'done')}${RESET}\r\n`;
        }
        return out;
      }
      case 'result': {
        const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
        this.result = {
          subtype: event.subtype ?? null,
          isError: Boolean(event.is_error) || (event.subtype && event.subtype !== 'success'),
          costUsd: cost,
          sessionId: event.session_id ?? this.sessionId
        };
        const color = this.result.isError ? RED : GREEN;
        const seconds = typeof event.duration_ms === 'number' ? `${(event.duration_ms / 1000).toFixed(1)}s` : '';
        const stats = [seconds, event.num_turns ? `${event.num_turns} turns` : '', cost !== null ? `$${cost.toFixed(4)}` : '']
          .filter(Boolean)
          .join(' · ');
        let out = `\r\n${color}${BOLD}${this.result.isError ? '✗ Task failed' : '✓ Task complete'}${RESET} ${DIM}${stats}${RESET}\r\n`;
        if (typeof event.result === 'string' && event.result.trim()) {
          out += `\r\n${MAGENTA}Result${RESET}\r\n${crlf(event.result.trim())}\r\n`;
        }
        return out;
      }
      default:
        return '';
    }
  }
}

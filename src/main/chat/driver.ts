import type { ChatAnswer, ChatSettingsPatch, ProfileLimits } from '../../shared/types';
import type { ChatLog } from './log';

/** What a chat driver tells the agent manager. */
export interface ChatHost {
  log: ChatLog;
  /** Items changed; schedule a flush to the renderer. */
  changed(): void;
  status(status: 'working' | 'idle' | 'needs-input', detail?: string | null): void;
  session(info: { sessionId?: string; transcriptPath?: string; model?: string; permission?: string; title?: string }): void;
  turnComplete(): void;
  limits(limits: ProfileLimits): void;
}

/** One CLI's structured protocol, driven over the child's stdin/stdout. */
export interface ChatDriver {
  /** Begins the session; sends `prompt` as the first message when given. */
  start(prompt?: string): Promise<void>;
  /** One line of the child's stdout. */
  receive(line: string): void;
  send(text: string): void;
  interrupt(): void;
  respond(itemId: string, answer: ChatAnswer): void;
  configure(patch: ChatSettingsPatch): void;
  readonly busy: boolean;
}

/** Splits a byte stream into complete lines. */
export class LineSplitter {
  private pending = '';
  constructor(private onLine: (line: string) => void) {}

  push(chunk: string) {
    this.pending += chunk;
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.pending.indexOf('\n');
    }
  }

  end() {
    const rest = this.pending.trim();
    this.pending = '';
    if (rest) this.onLine(rest);
  }
}

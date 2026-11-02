import type { ChatImage } from '../../shared/types';
import type { ChatAnswer, ChatCommand, ChatConnector, ChatSettingsPatch, ContextUsage, ProfileLimits } from '../../shared/types';
import type { ChatLog } from './log';
import type { SubagentTracker } from '../subagents';

/** What a chat driver tells the agent manager. */
export interface ChatHost {
  log: ChatLog;
  /** The agent map: drivers report every event to it, the subagents' own included. */
  subagents?: SubagentTracker;
  /** Items changed; schedule a flush to the renderer. */
  changed(): void;
  status(status: 'working' | 'idle' | 'needs-input', detail?: string | null): void;
  session(info: { sessionId?: string; transcriptPath?: string; model?: string; permission?: string; title?: string }): void;
  turnComplete(): void;
  limits(limits: ProfileLimits): void;
  /** A message meant for the running turn couldn't go in; hold it for the next one. */
  requeue(itemId: string): void;
}

/** One CLI's structured protocol, driven over the child's stdin/stdout. */
export interface ChatDriver {
  /** Begins the session; sends `prompt` as the first message when given. */
  start(prompt?: string, images?: ChatImage[]): Promise<void>;
  /** One line of the child's stdout. */
  receive(line: string): void;
  /**
   * Starts a turn with the message, or steers the running one with it when
   * `busy`. `itemId` names the chat item to use (a queued message's); it's a
   * UUID, as Claude Code wants for its message ids.
   */
  send(text: string, itemId?: string, images?: ChatImage[]): void;
  /** Whether `text` can go into the running turn (commands can't; they wait for it to end). */
  canSteer(text: string): boolean;
  interrupt(): void;
  respond(itemId: string, answer: ChatAnswer): void;
  configure(patch: ChatSettingsPatch): void;
  /** Saves a title the person chose into the CLI's own session record. */
  rename?(title: string): void;
  /** Asks the CLI to name the session from `description` (and remember it); null when it can't. */
  generateTitle?(description: string): Promise<string | null>;
  /** The slash commands and skills the session accepts. */
  commands?(): Promise<ChatCommand[]>;
  /** The session's MCP servers and connectors with their state; null when the CLI didn't answer. */
  connectors?(): Promise<ChatConnector[] | null>;
  /** Starts sign-in for a connector: the page to open in the browser (null: nothing to open, or it failed). */
  connectorSignIn?(name: string): Promise<{ url: string | null; error: string | null }>;
  /** Connects a connector again (after signing in); the error when it still can't. */
  connectorReconnect?(name: string): Promise<string | null>;
  /** What the context window holds, by part; null when the CLI didn't answer. */
  contextUsage?(): Promise<ContextUsage | null>;
  /**
   * Asks a one-off question about the conversation without adding to it (Claude Code's
   * side question: no tools, not written to the transcript, read from the prompt cache).
   */
  sideQuestion?(question: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Lets Claude Code compact the conversation while it sits idle, or stops it (flag settings, from now on). */
  setIdleCompaction?(on: boolean): void;
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

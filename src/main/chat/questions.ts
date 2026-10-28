import type { ChatLog } from './log';

export const OPTIONAL_QUESTION_MS = 30_000;

/** Session-local guidance: never modifies a project's instructions or account settings. */
export function questionInstructions(tool: string) {
  return `You are chatting with a person in Foreman, an interactive desktop app. Foreman displays ${tool} calls as clickable question cards and returns the person's answers. When you need a preference or clarification, use ${tool} instead of asking in plain chat. Keep routine implementation choices autonomous. For a low-stakes optional question, append " (optional)" to EVERY question header; Foreman gives the user 30 seconds, then returns no answer so you can continue with your stated reasonable assumption. For a required decision or consent, append " (required)" to its header; Foreman waits indefinitely. Never mark required decisions, consent, or permission requests optional. Use the normal permission approval mechanism for tool permissions. Do not assume an unanswered question is consent.`;
}

export function optionalHeaders(questions: Array<{ header: string }>) {
  return questions.length > 0 && questions.every((q) => /\(optional\)\s*$/i.test(q.header));
}

/** Only the visible question gets a deadline. Timers live in main, even if the UI closes. */
export class QuestionQueue {
  private entries = new Map<string, { optional: boolean; duration: number; expire: () => void }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: string | null = null;

  constructor(private log: ChatLog, private changed: () => void) {}

  add(id: string, optional: boolean, expire: () => void, duration = OPTIONAL_QUESTION_MS) {
    this.entries.set(id, { optional, duration, expire });
    this.activate();
  }

  hold(id: string) {
    const entry = this.entries.get(id);
    if (!entry || id !== this.active || !entry.optional) return;
    entry.optional = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.log.update(id, 'approval', () => ({ questionTimeoutAt: null }));
    this.changed();
  }

  remove(id: string) {
    this.entries.delete(id);
    if (id !== this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.activate();
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.entries.clear();
  }

  private activate() {
    if (this.active) return;
    const next = this.entries.entries().next().value;
    if (!next) return;
    const [id, entry] = next;
    this.active = id;
    if (!entry.optional) return;
    this.log.update(id, 'approval', () => ({ questionTimeoutAt: Date.now() + entry.duration }));
    this.timer = setTimeout(() => {
      this.timer = null;
      entry.expire();
    }, entry.duration);
    this.changed();
  }
}

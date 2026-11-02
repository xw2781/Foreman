// Forking a conversation: where to cut it, what the new chat shows, and the
// point each CLI copies through. Claude Code resumes a copy up to a transcript
// entry (`--fork-session --resume-session-at`); Codex forks a thread through a
// turn (`thread/fork` with `lastTurnId`).
import { contentImages } from '../../shared/chatImages';
import type { ChatItem, ForkPoint } from '../../shared/types';
import { codexItemEntry } from './codexItems';
import { claudeUserText } from './history';

type UserItem = Extract<ChatItem, { kind: 'user' }>;

/** Messages rebuilt from a Claude transcript are `user-<uuid>`; live ones are the bare uuid. */
function sameMessage(a: string, b: string) {
  return a.replace(/^user-/, '') === b.replace(/^user-/, '');
}

/** The person's messages in the conversation: queued ones aren't in it yet. */
function sent(items: ChatItem[]): UserItem[] {
  return items.filter((i): i is UserItem => i.kind === 'user' && i.delivery !== 'queued');
}

/** The first of `candidates` that is the point's message: by id, else the same text at the same occurrence. */
function locate<T>(candidates: T[], point: ForkPoint, id: (c: T) => string, text: (c: T) => string): T | undefined {
  return candidates.find((c) => sameMessage(id(c), point.itemId)) ?? candidates.filter((c) => text(c) === point.text)[point.occurrence];
}

/** The point a fork before `itemId` stops at; null when it isn't a message of the person's. */
export function forkPoint(items: ChatItem[], itemId: string): ForkPoint | null {
  const messages = sent(items);
  const index = messages.findIndex((m) => m.id === itemId);
  if (index < 0) return null;
  const { text } = messages[index];
  return { itemId, text, occurrence: messages.slice(0, index).filter((m) => m.text === text).length };
}

/**
 * What a fork's chat starts with: the conversation, or what came before `point`
 * (null when the point isn't in it). Queued messages stay with the original.
 */
export function forkItems(items: ChatItem[], point?: ForkPoint): ChatItem[] | null {
  const kept = items.filter((i) => !(i.kind === 'user' && i.delivery === 'queued'));
  if (!point) return kept;
  const target = locate(sent(items), point, (m) => m.id, (m) => m.text);
  return target ? kept.filter((i) => i.seq < target.seq) : null;
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * The Claude Code transcript entry a fork before `point` keeps up to: the one the message follows.
 * null: the message opens the conversation, so nothing is copied; undefined: it isn't in the transcript.
 */
export function claudeForkThrough(lines: Iterable<string>, point: ForkPoint): string | null | undefined {
  const prompts: Array<{ uuid: string; parent: string | null; text: string }> = [];
  let previous: string | null = null;
  for (const line of lines) {
    const record = parse(line);
    if (!record || record.isSidechain || typeof record.uuid !== 'string') continue;
    if (record.type === 'user' && !record.isCompactSummary && !record.isMeta) {
      const content = record.message?.content;
      const text = claudeUserText(content);
      if (text || contentImages(content).length) prompts.push({ uuid: record.uuid, parent: typeof record.parentUuid === 'string' ? record.parentUuid : previous, text });
    }
    previous = record.uuid;
  }
  const match = locate(prompts, point, (p) => p.uuid, (p) => p.text);
  if (!match) return undefined;
  return match === prompts[0] ? null : match.parent;
}

/**
 * The last Codex turn a fork before `point` keeps (`thread/turns/list` turns, oldest first).
 * null: the message opens the thread; undefined: no turn has it.
 */
export function codexForkTurn(turns: Array<{ id: string; items?: unknown[] }>, point: ForkPoint): string | null | undefined {
  const prompts: Array<{ turn: number; id: string; text: string }> = [];
  turns.forEach((turn, index) => {
    for (const item of turn.items ?? []) {
      const entry = codexItemEntry(item);
      if (entry?.kind === 'user') prompts.push({ turn: index, id: entry.id, text: entry.text });
    }
  });
  const match = locate(prompts, point, (p) => p.id, (p) => p.text);
  if (!match) return undefined;
  return match.turn === 0 ? null : turns[match.turn - 1].id;
}

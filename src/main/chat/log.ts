import type { ChatEntry, ChatItem } from '../../shared/types';

/** Longest tool output or input kept per item; the chat shows a head/tail excerpt beyond that. */
export const TEXT_LIMIT = 24_000;
const ITEM_LIMIT = 4000;

export function clipText(value: string | null | undefined, limit = TEXT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${value.slice(0, head)}\n… ${value.length - limit} characters omitted …\n${value.slice(-tail)}`;
}

/**
 * The items of one conversation. Every change bumps the item's `rev`, so the
 * renderer can merge a snapshot and live updates in any order; `seq` fixes
 * each item's place in the conversation.
 */
export class ChatLog {
  private items = new Map<string, ChatItem>();
  private dirty = new Set<string>();
  private seq = 0;
  private rev = 0;
  /** Set when the whole conversation was replaced; the next flush tells the renderer to drop what it has. */
  reset = false;

  constructor(entries: ChatEntry[] = []) {
    for (const entry of entries) this.upsert(entry);
    this.dirty.clear();
  }

  get(id: string): ChatItem | undefined {
    return this.items.get(id);
  }

  upsert(entry: ChatEntry, at?: string): ChatItem {
    const existing = this.items.get(entry.id);
    const item = {
      ...entry,
      seq: existing?.seq ?? ++this.seq,
      rev: ++this.rev,
      at: existing?.at ?? at ?? new Date().toISOString()
    } as ChatItem;
    this.items.set(entry.id, item);
    this.dirty.add(entry.id);
    if (!existing && this.items.size > ITEM_LIMIT) this.dropOldest();
    return item;
  }

  /** Applies `change` to an existing item of the given kind; no-op when it doesn't exist. */
  update<K extends ChatEntry['kind']>(id: string, kind: K, change: (item: Extract<ChatItem, { kind: K }>) => Partial<Extract<ChatEntry, { kind: K }>>) {
    const item = this.items.get(id);
    if (!item || item.kind !== kind) return undefined;
    return this.upsert({ ...item, ...change(item as Extract<ChatItem, { kind: K }>) } as ChatEntry);
  }

  list(): ChatItem[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq);
  }

  get size() {
    return this.items.size;
  }

  /** Items changed since the last call. */
  takeDirty(): ChatItem[] {
    const changed: ChatItem[] = [];
    for (const id of this.dirty) {
      const item = this.items.get(id);
      if (item) changed.push(item);
    }
    this.dirty.clear();
    return changed;
  }

  get hasChanges() {
    return this.dirty.size > 0 || this.reset;
  }

  /** Ends everything still in flight: streaming text, running tools, open approvals. */
  settle(reason: string) {
    for (const item of this.items.values()) {
      if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) this.upsert({ ...item, streaming: false });
      else if (item.kind === 'tool' && item.status === 'running') this.upsert({ ...item, status: 'error', output: item.output ?? reason });
      else if (item.kind === 'approval' && item.state === 'pending') this.upsert({ ...item, state: 'cancelled', resolution: reason });
    }
  }

  private dropOldest() {
    const oldest = this.list().slice(0, this.items.size - ITEM_LIMIT);
    for (const item of oldest) this.items.delete(item.id);
  }
}

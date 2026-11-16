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
 * Most picture data (data-URL characters) kept across one conversation's tool
 * steps. An agent taking screenshots all day would otherwise hold gigabytes;
 * past this, the oldest steps give up their pictures.
 */
export const TOOL_IMAGE_LIMIT = 48 * 1024 * 1024;

export function toolImageSize(entry: ChatEntry): number {
  return entry.kind === 'tool' && entry.images ? entry.images.reduce((sum, image) => sum + image.dataUrl.length, 0) : 0;
}

/** A tool step without its pictures, with a line saying they were there. */
export function withoutToolImages<T extends ChatEntry>(entry: T): T {
  if (entry.kind !== 'tool' || !entry.images?.length) return entry;
  const { images, ...rest } = entry;
  const note = images.length === 1 ? '[image no longer kept]' : `[${images.length} images no longer kept]`;
  return { ...rest, output: [entry.output, note].filter(Boolean).join('\n') } as unknown as T;
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

  constructor(entries: ChatEntry[] = [], private imageLimit = TOOL_IMAGE_LIMIT) {
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
    if (toolImageSize(entry)) this.trimImages(entry.id);
    return item;
  }

  /** Keeps the newest steps' pictures within the limit; the step just written always keeps its own. */
  private trimImages(keep: string) {
    let total = 0;
    for (const item of this.list().reverse()) {
      const size = toolImageSize(item);
      if (!size) continue;
      total += size;
      if (total > this.imageLimit && item.id !== keep) this.upsert(withoutToolImages(item));
    }
  }

  /** Applies `change` to an existing item of the given kind; no-op when it doesn't exist. */
  update<K extends ChatEntry['kind']>(id: string, kind: K, change: (item: Extract<ChatItem, { kind: K }>) => Partial<Extract<ChatEntry, { kind: K }>>) {
    const item = this.items.get(id);
    if (!item || item.kind !== kind) return undefined;
    return this.upsert({ ...item, ...change(item as Extract<ChatItem, { kind: K }>) } as ChatEntry);
  }

  /** Puts an item last in the conversation (a queued message, when it's finally sent). */
  moveToEnd(id: string) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, { ...item, seq: ++this.seq, rev: ++this.rev });
    this.dirty.add(id);
  }

  /** Deletes an item; the renderer only learns of that from a full reset. */
  remove(id: string) {
    if (!this.items.delete(id)) return;
    this.dirty.delete(id);
    this.reset = true;
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

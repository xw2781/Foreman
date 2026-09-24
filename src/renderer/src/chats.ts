import { create } from 'zustand';
import type { ChatItem } from '@shared/types';
import { call, errorMessage, listen } from './api';

interface ChatState {
  items: ChatItem[];
  loading: boolean;
  error: string | null;
}

/**
 * Conversations by agent id. The main process sends changed items with a
 * per-item revision, so a snapshot (`chat.items`) and live updates can land
 * in any order: the higher revision wins, and `seq` orders the conversation.
 */
export const useChats = create<{ chats: Record<string, ChatState> }>(() => ({ chats: {} }));

function merge(current: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing || existing.rev <= item.rev) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function patch(id: string, change: (state: ChatState) => ChatState) {
  const chats = useChats.getState().chats;
  const state = chats[id] ?? { items: [], loading: false, error: null };
  useChats.setState({ chats: { ...chats, [id]: change(state) } });
}

listen('chat', ({ id, items, reset }) => {
  patch(id, (state) => ({ ...state, items: reset ? [...items].sort((a, b) => a.seq - b.seq) : merge(state.items, items), error: null }));
});

const inFlight = new Set<string>();

/** Fetches a conversation (live, or rebuilt from its session file). */
export async function loadChat(id: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  patch(id, (state) => ({ ...state, loading: true }));
  try {
    const items = await call('chat.items', id);
    patch(id, (state) => ({ items: merge(state.items, items), loading: false, error: null }));
  } catch (error) {
    patch(id, (state) => ({ ...state, loading: false, error: errorMessage(error) }));
  } finally {
    inFlight.delete(id);
  }
}

export function forgetChat(id: string) {
  const { [id]: _removed, ...rest } = useChats.getState().chats;
  useChats.setState({ chats: rest });
}

/** Unsent composer text per agent, so switching agents doesn't lose it. */
export const drafts = new Map<string, string>();

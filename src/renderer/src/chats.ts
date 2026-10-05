import { create } from 'zustand';
import type { ChatImage, ChatCommand, ChatItem, ChatSendMode } from '@shared/types';
import { call, errorMessage, listen } from './api';
import { setAnnotations } from './annotations';

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
  imageDrafts.delete(id);
  setAnnotations(id, []);
  const { [id]: _removed, ...rest } = useChats.getState().chats;
  useChats.setState({ chats: rest });
}

/** Each agent's last known slash commands and skills, so the menu opens with them while a fresh list loads. */
export const imageDrafts = new Map<string, ChatImage[]>();

export const commandLists = new Map<string, ChatCommand[]>();

export async function loadCommands(id: string): Promise<ChatCommand[]> {
  const list = await call('chat.commands', id);
  if (list.length || !commandLists.has(id)) commandLists.set(id, list);
  return commandLists.get(id)!;
}

/** Unsent composer text per agent, so switching agents doesn't lose it. */
export const drafts = new Map<string, string>();

/** Chats whose composer was switched away from the default send mode (Settings → Chat). */
export const sendModes = new Map<string, ChatSendMode>();

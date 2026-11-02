import { create } from 'zustand';
import type { AgentInfo, ChatImage } from '@shared/types';
import { call, errorMessage } from './api';
import { drafts, imageDrafts } from './chats';
import { useApp } from './store';

/** One question of a side chat; `answer` and `error` are both null while it waits. */
export interface SideMessage {
  id: number;
  question: string;
  answer: string | null;
  error: string | null;
}

/**
 * Side chats by agent: questions about a conversation that aren't added to it.
 * Like the CLIs' own asides they last for the app run, not on disk.
 */
export const useSideChats = create<{ chats: Record<string, SideMessage[]> }>(() => ({ chats: {} }));

export const NO_SIDE_MESSAGES: SideMessage[] = [];
let counter = 0;

function change(agentId: string, update: (list: SideMessage[]) => SideMessage[]) {
  const chats = useSideChats.getState().chats;
  useSideChats.setState({ chats: { ...chats, [agentId]: update(chats[agentId] ?? []) } });
}

export function sidePending(list: SideMessage[]) {
  return list.some((m) => m.answer === null && m.error === null);
}

export async function askSide(agentId: string, question: string) {
  const text = question.trim();
  const list = useSideChats.getState().chats[agentId] ?? [];
  if (!text || sidePending(list)) return;
  const earlier = list.filter((m) => m.answer !== null).map((m) => ({ question: m.question, answer: m.answer! }));
  const id = ++counter;
  change(agentId, (current) => [...current, { id, question: text, answer: null, error: null }]);
  const settle = (patch: Partial<SideMessage>) => change(agentId, (current) => current.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  try {
    settle({ answer: await call('chat.side', agentId, text, earlier) });
  } catch (error) {
    settle({ error: errorMessage(error) });
  }
}

/** Asks a question that failed again, in its place. */
export function retrySide(agentId: string, messageId: number) {
  const list = useSideChats.getState().chats[agentId] ?? [];
  const message = list.find((m) => m.id === messageId);
  if (!message) return;
  change(agentId, (current) => current.filter((m) => m.id !== messageId));
  return askSide(agentId, message.question);
}

export function clearSide(agentId: string) {
  change(agentId, () => []);
  call('chat.sideReset', agentId).catch(() => {});
}

/**
 * Forks a conversation into a new chat and opens it. Forking from one of the person's
 * messages copies what came before it and puts the message in the new chat's box to edit.
 */
export async function forkAgent(agent: AgentInfo, from?: { id: string; text: string; images?: ChatImage[] }) {
  const { toast } = useApp.getState();
  try {
    const next = await call('agents.fork', agent.id, from?.id);
    if (from?.text) drafts.set(next.id, from.text);
    if (from?.images?.length) imageDrafts.set(next.id, from.images);
    useApp.setState({ selectedAgentId: next.id, view: 'agents' });
  } catch (error) {
    toast('error', errorMessage(error));
  }
}

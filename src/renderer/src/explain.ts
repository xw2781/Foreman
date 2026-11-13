import { create } from 'zustand';
import type { StepExplanation } from '@shared/types';
import { call, errorMessage } from './api';

/** A step's explanation: being written, written, or why it couldn't be. */
export type Explanation = { state: 'pending' } | ({ state: 'done' } & StepExplanation) | { state: 'error'; error: string };

/**
 * Explanations by agent and step, asked for one at a time from the step's row.
 * Kept here so a row scrolled away and back still shows its own; like side chats
 * they last for the app run, not on disk.
 */
export const useExplanations = create<{ steps: Record<string, Explanation> }>(() => ({ steps: {} }));

export function explanationKey(agentId: string, itemId: string) {
  return `${agentId}:${itemId}`;
}

function set(key: string, value: Explanation) {
  useExplanations.setState({ steps: { ...useExplanations.getState().steps, [key]: value } });
}

/** Asks for a step's explanation; asking again replaces one that failed. */
export async function explainStep(agentId: string, itemId: string) {
  const key = explanationKey(agentId, itemId);
  const current = useExplanations.getState().steps[key];
  if (current && current.state !== 'error') return;
  set(key, { state: 'pending' });
  try {
    set(key, { state: 'done', ...(await call('chat.explain', agentId, itemId)) });
  } catch (error) {
    set(key, { state: 'error', error: errorMessage(error) });
  }
}

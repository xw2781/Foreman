import { create } from 'zustand';

export interface ChatAnnotation {
  id: string;
  text: string;
  comment: string;
}

export const NO_ANNOTATIONS: ChatAnnotation[] = [];
export const useAnnotations = create<{ drafts: Record<string, ChatAnnotation[]> }>(() => ({ drafts: {} }));

export function setAnnotations(agentId: string, annotations: ChatAnnotation[]) {
  const drafts = { ...useAnnotations.getState().drafts };
  if (annotations.length) drafts[agentId] = annotations;
  else delete drafts[agentId];
  useAnnotations.setState({ drafts });
}

export function restoreAnnotations(agentId: string, annotations: ChatAnnotation[]) {
  const current = useAnnotations.getState().drafts[agentId] ?? [];
  setAnnotations(agentId, [...annotations, ...current.filter((item) => !annotations.some((old) => old.id === item.id))]);
}

/** Quote every selected line so the follow-up is distinct from its source text. */
export function annotatedMessage(text: string, annotations: ChatAnnotation[]): string {
  if (!annotations.length) return text;
  const quotes = annotations.map((item, index) => {
    const quote = item.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    return `${index + 1}. Selected text:\n${quote}${item.comment.trim() ? `\n\nComment: ${item.comment.trim()}` : ''}`;
  });
  return `Selected text from this conversation:\n\n${quotes.join('\n\n')}${text.trim() ? `\n\nFollow-up:\n${text.trim()}` : ''}`;
}

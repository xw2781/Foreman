import { create } from 'zustand';

export interface ChatAnnotation {
  id: string;
  text: string;
  comment: string;
  /** The words around the selection, kept only when the same text appears more than once in the chat. */
  context?: string;
}

/** Quotes waiting in an agent's side-chat box live beside its composer's, under this key. */
export const sideQuotesKey = (agentId: string) => `side:${agentId}`;

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

const HEADER = 'Selected text from this conversation:\n\n';
const FOLLOW_UP = '\n\nFollow-up:\n';
const CONTEXT = '\nThis text appears more than once in the conversation; the one meant is marked [[here]]: ';

/** Reads a message written by `annotatedMessage` back into its quotes and follow-up; null for any other text. */
export function parseAnnotatedMessage(message: string): { quotes: Array<{ text: string; comment: string; context?: string }>; text: string } | null {
  const normalized = message.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(HEADER)) return null;
  const body = normalized.slice(HEADER.length);
  const split = body.indexOf(FOLLOW_UP);
  const section = split < 0 ? body : body.slice(0, split);
  const quotes: Array<{ text: string; comment: string; context?: string }> = [];
  for (const block of section.split(/\n\n(?=\d+\. Selected text:\n)/)) {
    const lines = block.split('\n');
    if (!/^\d+\. Selected text:$/.test(lines[0] ?? '')) return null;
    let end = 1;
    while (end < lines.length && lines[end].startsWith('> ')) end++;
    if (end === 1) return null;
    let rest = lines.slice(end).join('\n');
    let context: string | undefined;
    if (rest.startsWith(CONTEXT)) {
      const next = rest.indexOf('\n\nComment: ');
      context = rest.slice(CONTEXT.length, next < 0 ? undefined : next);
      rest = next < 0 ? '' : rest.slice(next + 1);
    }
    if (rest && !rest.startsWith('\nComment: ')) return null;
    quotes.push({ text: lines.slice(1, end).map((line) => line.slice(2)).join('\n'), comment: rest.slice('\nComment: '.length), ...(context ? { context } : {}) });
  }
  return { quotes, text: split < 0 ? '' : body.slice(split + FOLLOW_UP.length) };
}

/** Quote every selected line so the follow-up is distinct from its source text. */
export function annotatedMessage(text: string, annotations: ChatAnnotation[]): string {
  if (!annotations.length) return text;
  const quotes = annotations.map((item, index) => {
    const quote = item.text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    const context = item.context ? `\n${CONTEXT}${item.context.replace(/\s+/g, ' ')}` : '';
    return `${index + 1}. Selected text:\n${quote}${context}${item.comment.trim() ? `\n\nComment: ${item.comment.trim()}` : ''}`;
  });
  return `${HEADER}${quotes.join('\n\n')}${text.trim() ? `${FOLLOW_UP}${text.trim()}` : ''}`;
}

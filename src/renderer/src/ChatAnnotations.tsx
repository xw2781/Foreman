import { useEffect, useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MessageSquareDashed, MessageSquareQuote, Pencil, Quote, X } from 'lucide-react';
import { NO_ANNOTATIONS, parseAnnotatedMessage, setAnnotations, sideQuotesKey, useAnnotations, type ChatAnnotation } from './annotations';
import { useApp } from './store';

const squash = (text: string) => text.replace(/\s+/g, '');
const occurrences = (haystack: string, needle: string) => {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && count < 2; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
};

/**
 * The words around a selection whose text appears more than once in the chat, with the selection marked [[like this]],
 * widened until that passage is itself unique (or ~300 characters a side). The model only sees text, so this is what
 * tells it which occurrence was meant.
 */
function selectionContext(container: HTMLElement, source: Element, range: Range, text: string): string | undefined {
  const all = squash(Array.from(container.querySelectorAll('[data-annotation-source]'), (el) => el.textContent ?? '').join(''));
  if (occurrences(all, squash(text)) < 2) return undefined;
  const side = (start: boolean) => {
    const part = document.createRange();
    part.selectNodeContents(source);
    if (start) part.setEnd(range.startContainer, range.startOffset);
    else part.setStart(range.endContainer, range.endOffset);
    return part.toString().replace(/\s+/g, ' ');
  };
  const before = side(true);
  const after = side(false);
  const middle = text.replace(/\s+/g, ' ');
  for (let width = 40; ; width += 40) {
    const head = before.slice(-width);
    const tail = after.slice(0, width);
    const done = width >= 300 || (head.length === before.length && tail.length === after.length);
    if (done || occurrences(all, squash(head + text + tail)) < 2) {
      return `${head.length < before.length ? '…' : ''}${head}[[${middle}]]${tail}${tail.length < after.length ? '…' : ''}`;
    }
  }
}

export function AnnotationSelection({ agentId, container }: { agentId: string; container: RefObject<HTMLDivElement | null> }) {
  const [selected, setSelected] = useState<{ text: string; context?: string; left: number; top: number } | null>(null);
  useEffect(() => {
    const inspect = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !container.current) { setSelected(null); return; }
      const range = selection.getRangeAt(0);
      const parent = (node: Node) => node instanceof Element ? node : node.parentElement;
      const source = parent(range.startContainer)?.closest('[data-annotation-source]');
      if (!source || !container.current.contains(source) || !source.contains(range.endContainer)) { setSelected(null); return; }
      const text = selection.toString().trim();
      const rect = range.getBoundingClientRect();
      const bounds = container.current.getBoundingClientRect();
      if (!text || rect.bottom < bounds.top || rect.top > bounds.bottom) { setSelected(null); return; }
      setSelected({ text, context: selectionContext(container.current, source, range, text), left: Math.max(8, Math.min(rect.left, window.innerWidth - 270)), top: Math.max(8, Math.min(rect.top - 36, window.innerHeight - 40)) });
    };
    const dismiss = () => setSelected(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && window.getSelection()?.toString()) { dismiss(); }
    };
    document.addEventListener('selectionchange', inspect);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('selectionchange', inspect);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', key);
    };
  }, [agentId, container]);
  if (!selected) return null;
  const quote = (target: string, focus: () => void) => {
    const current = useAnnotations.getState().drafts[target] ?? [];
    setAnnotations(target, [...current, { id: crypto.randomUUID(), text: selected.text, comment: '', ...(selected.context ? { context: selected.context } : {}) }]);
    setSelected(null);
    window.getSelection()?.removeAllRanges();
    focus();
  };
  return createPortal(<div className="annotation-selection" style={{ left: selected.left, top: selected.top }} onMouseDown={(event) => event.preventDefault()}>
    <button type="button" className="btn ghost sm" title="Quote this in your next message"
      onClick={() => quote(agentId, () => container.current?.closest('.chat')?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus())}>
      <MessageSquareQuote size={13} /> Add to chat
    </button>
    <button type="button" className="btn ghost sm" title="Ask about this in the side chat, without adding to the conversation"
      onClick={() => quote(sideQuotesKey(agentId), () => {
        useApp.getState().showPanel(agentId, 'side');
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.side-chat-input textarea')?.focus());
      })}>
      <MessageSquareDashed size={13} /> Ask on the side
    </button>
  </div>, document.body);
}

function AnnotationCard({ item, index, onChange, onRemove }: {
  item: ChatAnnotation; index: number; onChange: (next: ChatAnnotation) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  // Hand-edited text no longer matches what the context marks, so the context goes with the edit.
  const save = () => { if (draft.trim() && draft.trim() !== item.text) onChange({ ...item, text: draft.trim(), context: undefined }); setEditing(false); };
  return <div className="annotation-card">
    <div className="annotation-quote">
      {editing ? <textarea className="input annotation-edit" aria-label="Selected text" value={draft} autoFocus
        onChange={(event) => setDraft(event.target.value)} onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setDraft(item.text); setEditing(false); }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
        }} />
        : <blockquote className="selectable" title={item.text}>{item.text}</blockquote>}
      <div className="annotation-card-actions">
        <button type="button" className="btn ghost sm icon" aria-label={editing ? 'Save selected text' : 'Edit selected text'}
          disabled={editing && !draft.trim()} onMouseDown={(event) => { if (editing) event.preventDefault(); }}
          onClick={() => { if (editing) save(); else { setDraft(item.text); setEditing(true); } }}>{editing ? <Check size={13} /> : <Pencil size={13} />}</button>
        <button type="button" className="btn ghost sm icon" aria-label="Remove quote" onClick={onRemove}><X size={13} /></button>
      </div>
    </div>
    <textarea className="annotation-comment" aria-label={`Comment on quote ${index + 1}`} placeholder="Add a comment…" rows={1}
      value={item.comment} onChange={(event) => onChange({ ...item, comment: event.target.value })} />
  </div>;
}

/** One quote in a sent message: a single line until clicked open. */
function SentQuote({ text, comment }: { text: string; comment: string }) {
  const [open, setOpen] = useState(false);
  return <div className={`sent-quote ${open ? 'open' : ''}`}>
    <button type="button" className="sent-quote-text" aria-expanded={open} title={open ? 'Collapse' : 'Show the full quote'}
      onClick={() => { if (!window.getSelection()?.toString()) setOpen(!open); }}>
      <Quote size={12} className="sent-quote-icon" />
      <span>{text}</span>
      <ChevronDown size={12} className="sent-quote-chevron" />
    </button>
    {comment ? <div className="sent-quote-comment">{comment}</div> : null}
  </div>;
}

/** A user message's text, with any quoted selections folded into compact lines above the follow-up. */
export function UserMessageText({ text }: { text: string }) {
  const parsed = useMemo(() => parseAnnotatedMessage(text), [text]);
  if (!parsed) return <>{text}</>;
  return <>
    <div className="sent-quotes">{parsed.quotes.map((quote, index) => <SentQuote key={index} {...quote} />)}</div>
    {parsed.text ? <div className="sent-follow-up">{parsed.text}</div> : null}
  </>;
}

export function AnnotationTray({ agentId }: { agentId: string }) {
  const items = useAnnotations((state) => state.drafts[agentId] ?? NO_ANNOTATIONS);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (items.length) setOpen(true); }, [items.length]);
  if (!items.length) return null;
  return <div className="annotation-tray">
    {open ? <div className="annotation-cards">
      {items.map((item, index) => <AnnotationCard key={item.id} item={item} index={index}
        onChange={(next) => setAnnotations(agentId, (useAnnotations.getState().drafts[agentId] ?? []).map((old) => old.id === item.id ? next : old))}
        onRemove={() => setAnnotations(agentId, (useAnnotations.getState().drafts[agentId] ?? []).filter((old) => old.id !== item.id))} />)}
    </div> : null}
    <div className="annotation-chip">
      <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MessageSquareQuote size={13} /> {items.length} {items.length === 1 ? 'quote' : 'quotes'}
      </button>
      <button type="button" className="btn ghost sm icon" aria-label="Clear quotes" onClick={() => setAnnotations(agentId, [])}><X size={13} /></button>
    </div>
  </div>;
}

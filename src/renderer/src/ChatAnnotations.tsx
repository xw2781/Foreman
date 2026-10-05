import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, MessageSquareQuote, Pencil, Trash2, X } from 'lucide-react';
import { NO_ANNOTATIONS, setAnnotations, useAnnotations, type ChatAnnotation } from './annotations';

export function AnnotationSelection({ agentId, container }: { agentId: string; container: RefObject<HTMLDivElement | null> }) {
  const [selected, setSelected] = useState<{ text: string; left: number; top: number } | null>(null);
  const action = useRef<HTMLButtonElement>(null);
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
      setSelected({ text, left: Math.max(8, Math.min(rect.left, window.innerWidth - 130)), top: Math.max(8, Math.min(rect.top - 36, window.innerHeight - 40)) });
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
  return createPortal(<button ref={action} type="button" className="btn sm annotation-selection"
    style={{ left: selected.left, top: selected.top }} onMouseDown={(event) => event.preventDefault()}
    onClick={() => {
      const current = useAnnotations.getState().drafts[agentId] ?? [];
      setAnnotations(agentId, [...current, { id: crypto.randomUUID(), text: selected.text, comment: '' }]);
      setSelected(null);
      window.getSelection()?.removeAllRanges();
      container.current?.closest('.chat')?.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
    }}><MessageSquareQuote size={13} /> Add to chat</button>, document.body);
}

function AnnotationCard({ item, index, onChange, onRemove }: {
  item: ChatAnnotation; index: number; onChange: (next: ChatAnnotation) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  return <div className="annotation-card">
    <div className="annotation-card-heading">
      <span>{index + 1}. Selected text</span>
      <button type="button" className="btn ghost sm icon" aria-label={editing ? 'Save selected text' : 'Edit selected text'}
        disabled={editing && !draft.trim()}
        onClick={() => {
          if (editing) onChange({ ...item, text: draft.trim() });
          else setDraft(item.text);
          setEditing(!editing);
        }}>{editing ? <Check size={13} /> : <Pencil size={13} />}</button>
      <button type="button" className="btn ghost sm icon" aria-label="Remove annotation" onClick={onRemove}><Trash2 size={13} /></button>
    </div>
    {editing ? <textarea className="input annotation-edit" aria-label="Selected text" value={draft} autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft.trim()) onChange({ ...item, text: draft.trim() }); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setDraft(item.text); setEditing(false); } }} />
      : <blockquote className="selectable">{item.text}</blockquote>}
    <textarea className="input annotation-comment" aria-label={`Comment on annotation ${index + 1}`} placeholder="Add a comment (optional)" rows={1}
      value={item.comment} onChange={(event) => onChange({ ...item, comment: event.target.value })} />
  </div>;
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
        <MessageSquareQuote size={13} /> {items.length} {items.length === 1 ? 'annotation' : 'annotations'}
      </button>
      <button type="button" className="btn ghost sm icon" aria-label="Clear annotations" onClick={() => setAnnotations(agentId, [])}><X size={13} /></button>
    </div>
  </div>;
}

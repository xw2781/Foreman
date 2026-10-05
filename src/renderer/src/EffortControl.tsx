import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Brain, ChevronDown, RotateCcw, Zap } from 'lucide-react';
import { modelLabel } from './format';
import type { SelectOption } from './ui';

/** A discrete effort slider; dragging previews a level and releasing applies it. */
export function EffortControl({ value, model, options, onChange }: {
  value: string;
  model: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [original, setOriginal] = useState(value);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const index = Math.max(0, options.findIndex((option) => option.value === draft));
  const label = options.find((option) => option.value === (open ? draft : value))?.label ?? value;
  const progress = options.length > 1 ? index / (options.length - 1) * 100 : 0;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const apply = (next: string) => {
    setDraft(next);
    if (next && next !== value) onChange(next);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    const above = anchor.top >= box.height + 12;
    setPlace({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)),
      ...(above ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 })
    });
    slider.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const moved = () => setOpen(false);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', moved);
    window.addEventListener('blur', moved);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', moved);
      window.removeEventListener('blur', moved);
    };
  }, [open]);

  return <>
    <button type="button" ref={trigger} className={`sel ghost sm ${open ? 'open' : ''}`}
      title="Reasoning effort" aria-label="Reasoning effort" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        setDraft(value);
        setOriginal(value);
        setPlace({ visibility: 'hidden' });
        setOpen(!open);
      }}>
      <Brain size={13} /><span className="sel-value">{label}</span><ChevronDown size={12} />
    </button>
    {open && createPortal(
      <div ref={panel} className="effort-popover" style={place} role="dialog" aria-label="Reasoning effort"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}>
        <div className="effort-heading">
          <Zap size={16} className="muted" />
          <div><strong>{label}</strong><span>{modelLabel(model)}</span></div>
          <button type="button" className="btn ghost icon" title="Restore previous effort" aria-label="Restore previous effort"
            disabled={!original || draft === original} onClick={() => apply(original)}><RotateCcw size={15} /></button>
        </div>
        <div className="effort-track" style={{ ['--effort-progress' as string]: `${progress}%` }}>
          <div className="effort-stops" aria-hidden="true">
            {options.map((option) => <span key={option.value} />)}
          </div>
          <input ref={slider} type="range" min={0} max={Math.max(0, options.length - 1)} step={1} value={index}
            aria-label="Reasoning effort" aria-valuetext={typeof label === 'string' ? label : draft}
            onChange={(event) => setDraft(options[Number(event.currentTarget.value)].value)}
            onPointerUp={(event) => apply(options[Number(event.currentTarget.value)].value)}
            onPointerCancel={() => setDraft(value)}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                apply(options[Number(event.currentTarget.value)].value);
              }
            }} />
        </div>
        <div className="effort-labels">
          {options.map((option) => <button key={option.value} type="button" className={draft === option.value ? 'on' : ''}
            onClick={() => apply(option.value)}>{option.label}</button>)}
        </div>
      </div>, document.body
    )}
  </>;
}

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Zap } from 'lucide-react';
import { modelLabel } from './format';
import type { SelectOption } from './ui';

/**
 * A discrete effort slider; dragging previews a level and releasing applies it. With `models`, the
 * model name in the popover opens a model list, so a narrow toolbar can fold both into the brain icon.
 */
export function EffortControl({ value, model, options, onChange, models, onModelChange }: {
  value: string;
  model: string;
  models?: SelectOption[];
  onModelChange?: (model: string) => void;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [original, setOriginal] = useState(value);
  const [picking, setPicking] = useState(false);
  const canPick = Boolean(models?.length && onModelChange);
  // Like the model dropdown: older models wait behind a disclosure, and a model typed in by id is
  // listed first so the current one is always marked.
  const [showOlder, setShowOlder] = useState(false);
  const older = (models ?? []).filter((option) => option.collapsedGroup && option.value !== model);
  const modelList = [
    ...(models?.some((option) => option.value === model) ? [] : [{ value: model, label: modelLabel(model) }]),
    ...(models ?? []).filter((option) => !older.includes(option)),
    ...(showOlder ? older : [])
  ];
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const index = Math.max(0, options.findIndex((option) => option.value === draft));
  const label = options.find((option) => option.value === (open ? draft : value))?.label ?? value;
  const fraction = options.length > 1 ? index / (options.length - 1) : 0;
  const labelOf = (key: string) => options.find((option) => option.value === key)?.label ?? key;
  const originalLabel = String(labelOf(original));
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
    // Swapping views unmounts the focused control; move focus in so the popover's blur check keeps it open.
    if (picking) panel.current.querySelector<HTMLElement>('.effort-model.on, .effort-model')?.focus();
    else slider.current?.focus();
  }, [open, picking]);

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
    <button type="button" ref={trigger} className={`sel ghost sm effort-trigger ${open ? 'open' : ''}`}
      title={`${canPick ? `${modelLabel(model)} · ` : ''}${typeof label === 'string' ? label : value} reasoning effort`}
      aria-label={canPick ? 'Model and reasoning effort' : 'Reasoning effort'} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        setDraft(value);
        setOriginal(value);
        setPicking(false);
        setShowOlder(false);
        setPlace({ visibility: 'hidden' });
        setOpen(!open);
      }}>
      <Brain size={13} /><span className="sel-value">{label}</span><ChevronDown size={12} className="sel-chev" />
    </button>
    {open && createPortal(
      <div ref={panel} className="effort-popover" style={place} role="dialog" aria-label="Reasoning effort"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (picking) setPicking(false); else close();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}>
        {picking && models ? <>
          <div className="effort-heading">
            <button type="button" className="btn ghost icon" title="Back to effort" aria-label="Back to effort"
              onClick={() => setPicking(false)}><ChevronLeft size={16} /></button>
            <div><strong>Model</strong><span>{label} effort</span></div>
          </div>
          <div className="effort-models" role="listbox" aria-label="Model">
            {modelList.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === model}
              className={`effort-model ${option.value === model ? 'on' : ''}`}
              onClick={() => { if (option.value !== model) onModelChange?.(option.value); setPicking(false); }}>
              <span><span>{option.label}</span>{option.hint ? <small>{option.hint}</small> : null}</span>
              {option.value === model ? <Check size={14} aria-hidden="true" /> : null}
            </button>)}
            {older.length && !showOlder ? <button type="button" className="effort-model more" onClick={() => setShowOlder(true)}>
              <span>{older[0].collapsedGroup}</span><ChevronDown size={14} aria-hidden="true" />
            </button> : null}
          </div>
        </> : <>
        <div className="effort-heading">
          <Zap size={16} aria-hidden="true" />
          <div>
            <strong>{label}</strong>
            {canPick
              ? <button type="button" className="effort-model-link" title="Change model" onClick={() => setPicking(true)}>
                  {modelLabel(model)}<ChevronRight size={12} aria-hidden="true" />
                </button>
              : <span>{modelLabel(model)}</span>}
          </div>
          <button type="button" className="btn ghost icon" title={`Restore ${originalLabel}`} aria-label={`Restore ${originalLabel}`}
            disabled={!original || draft === original} onClick={() => apply(original)}><RotateCcw size={15} /></button>
        </div>
        <div className="effort-track" style={{ ['--effort-fraction' as string]: fraction }}>
          <div className="effort-stops" aria-hidden="true">
            {options.map((option, i) => <span key={option.value} className={i < index ? 'on' : ''} />)}
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
        </>}
      </div>, document.body
    )}
  </>;
}

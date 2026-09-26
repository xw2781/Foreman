import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AlertCircle, AlertTriangle, Check, CheckCircle2, ChevronDown, Info, X, XCircle } from 'lucide-react';
import type { AgentStatus, LimitWindow, Provider } from '@shared/types';
import { PROVIDER_LABEL } from '@shared/types';
import { STATUS_LABEL, colorVar, isStale, percent, resetIn, severity } from './format';
import { useApp } from './store';
import codexIcon from './assets/codex.png';

// ------------------------------------------------------------------ marks

// Claude Code's mark as its VS Code extension ships it (anthropic.claude-code resources/claude-logo.svg);
// Codex uses its app icon (assets/codex.png).
const CLAUDE_MARK =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

/** Claude Code's ivory spark on coral, Codex's cloud tile: the products' own app icons. */
export function ProviderIcon({ provider, size = 22 }: { provider: Provider; size?: number }) {
  if (provider === 'codex') {
    return <img className="provider-icon codex" src={codexIcon} width={size} height={size} alt="" title={PROVIDER_LABEL.codex} draggable={false} />;
  }
  const inner = Math.round(size * 0.68);
  return (
    <span className={`provider-icon ${provider}`} style={{ width: size, height: size, borderRadius: Math.round(size / 3.2) }} title={PROVIDER_LABEL[provider]}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" aria-hidden="true">
        <path d={CLAUDE_MARK} fill="currentColor" />
      </svg>
    </span>
  );
}

export function StatusPill({ status, detail }: { status: AgentStatus; detail?: string | null }) {
  return (
    <span className={`status ${status}`} title={detail ?? undefined}>
      <span className="dot" />
      <span className="label">{STATUS_LABEL[status]}</span>
    </span>
  );
}

export function AccountChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="account-chip">
      <span className="swatch" style={{ background: colorVar(color) }} />
      <span className="ellipsis">{label}</span>
    </span>
  );
}

// ----------------------------------------------------------------- meters

export function Meter({
  label,
  value,
  valueText,
  foot,
  title
}: {
  label: ReactNode;
  value: number | null;
  valueText?: string;
  foot?: ReactNode;
  title?: string;
}) {
  const sev = severity(value);
  const width = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={`meter ${sev}`} title={title}>
      <div className="meter-top">
        {sev === 'crit' ? <AlertCircle size={12} color="var(--warning)" /> : sev === 'warn' ? <AlertTriangle size={12} color="var(--warning)" /> : null}
        <span>{label}</span>
        <span className="value">{valueText ?? percent(value)}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${width}%` }} />
      </div>
      {foot ? <div className="meter-foot">{foot}</div> : null}
    </div>
  );
}

export function MiniMeter({ value, title }: { value: number | null; title?: string }) {
  const sev = severity(value);
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return (
    <div className={`mini-meter meter ${sev}`} title={title}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="value">{percent(value)}</span>
    </div>
  );
}

export function LimitMeters({ windows, compact = false }: { windows: LimitWindow[] | undefined | null; compact?: boolean }) {
  if (!windows || windows.length === 0) return <span className="muted" style={{ fontSize: 12 }}>No plan usage reported yet</span>;
  return (
    <>
      {windows.slice(0, compact ? 2 : 4).map((w) =>
        isStale(w) ? (
          <Meter key={w.id} label={w.label} value={null} valueText="—" foot={compact ? undefined : 'Reset since last report'} title="This window has reset since the CLI last reported it" />
        ) : (
          <Meter key={w.id} label={w.label} value={w.usedPercent} valueText={w.detail} foot={compact ? undefined : resetIn(w.resetsAt)} title={w.detail ? `${w.detail} (${Math.round(w.usedPercent)}%)` : resetIn(w.resetsAt)} />
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------- inputs

export function Switch({ on, onChange, title }: { on: boolean; onChange: (next: boolean) => void; title?: string }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={title} aria-pressed={on} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button type="button" key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <button className="btn ghost icon close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  checkbox?: string;
  resolve: (result: { ok: boolean; checked: boolean }) => void;
}

const useConfirmStore = create<{ request: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({
  request: null,
  set: (request) => set({ request })
}));

export function confirmDialog(options: Omit<ConfirmRequest, 'resolve'>): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...options, resolve }));
}

export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const setRequest = useConfirmStore((s) => s.set);
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [request]);
  if (!request) return null;
  const finish = (ok: boolean) => {
    request.resolve({ ok, checked });
    setRequest(null);
  };
  return (
    <Modal
      title={request.title}
      icon={request.danger ? <AlertTriangle size={18} color="var(--critical)" /> : <Info size={18} color="var(--accent)" />}
      onClose={() => finish(false)}
      footer={
        <>
          <button className="btn" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className={`btn ${request.danger ? 'danger' : 'primary'}`} onClick={() => finish(true)} autoFocus>
            {request.confirmLabel ?? 'Continue'}
          </button>
        </>
      }
    >
      <div className="secondary" style={{ lineHeight: 1.6 }}>
        {request.message}
      </div>
      {request.checkbox ? (
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{request.checkbox}</span>
        </label>
      ) : null}
    </Modal>
  );
}

// ----------------------------------------------------------------- misc

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <XCircle size={17} /> : t.kind === 'success' ? <CheckCircle2 size={17} /> : <Info size={17} color="var(--accent)" />}
          <div className="msg">{t.message}</div>
          <button className="btn ghost sm icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Re-renders every `ms` so relative times ("3m ago") stay fresh. */
export function useTicker(ms = 15_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

// ------------------------------------------------------------------ select

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** A second, muted line in the menu. */
  hint?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown before the chosen label in the trigger, e.g. "Model". */
  prefix?: string;
  icon?: ReactNode;
  /** 'field' looks like an input; 'ghost' is borderless, for toolbars. */
  variant?: 'field' | 'ghost';
  size?: 'md' | 'sm';
  /** Menu heading. */
  heading?: string;
  /** Lets the person type a value that isn't listed (e.g. a model id). */
  custom?: { placeholder: string };
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The app's dropdown. Native <select> menus are drawn by Windows and can't
 * follow the theme; this one can, and adds hints, custom values and keys.
 */
export function Select({ value, options, onChange, prefix, icon, variant = 'field', size = 'md', heading, custom, disabled, title, className, style, ...rest }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState('');
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listed = options.some((o) => o.value === value);
  // A custom value stays choosable once set.
  const items: SelectOption[] = listed || !value ? options : [...options, { value, label: value }];
  const selected = items.find((o) => o.value === value);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (next: string) => {
    close();
    if (next !== value) onChange(next);
  };
  const show = () => {
    if (disabled) return;
    setActive(Math.max(0, items.findIndex((o) => o.value === value)));
    setDraft(listed ? '' : value);
    setPlace({ visibility: 'hidden' });
    setOpen(true);
  };

  // Placed against the trigger, flipping up when there's more room above; the
  // menu lives in <body> so cards and dialogs with overflow can't clip it.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const wanted = Math.min(480, menu.current.scrollHeight + 2);
    const up = below < wanted && above > below;
    const width = Math.max(rect.width, menu.current.offsetWidth);
    setPlace({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      minWidth: rect.width,
      maxHeight: Math.max(120, Math.min(480, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    const moved = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(false);
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    window.addEventListener('blur', moved);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('blur', moved);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, place]);

  const onKey = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : items.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (items[active]) choose(items[active].value);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead: the next option whose text starts with the key.
      const key = event.key.toLowerCase();
      const text = (o: SelectOption) => (typeof o.label === 'string' ? o.label : o.value).toLowerCase();
      const next = items.findIndex((o, i) => i > active && text(o).startsWith(key));
      const first = items.findIndex((o) => text(o).startsWith(key));
      if (next >= 0 || first >= 0) setActive(next >= 0 ? next : first);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`sel ${variant} ${size} ${open ? 'open' : ''} ${className ?? ''}`}
        style={style}
        disabled={disabled}
        title={title}
        aria-label={rest['aria-label']}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        {icon ? <span className="sel-icon">{icon}</span> : null}
        <span className="sel-value">
          {prefix ? <span className="sel-prefix">{prefix}</span> : null}
          {selected?.label ?? value}
        </span>
        <ChevronDown size={size === 'sm' ? 13 : 14} className="sel-chev" />
      </button>
      {open
        ? createPortal(
            <div ref={menu} className="sel-menu" role="listbox" style={place} onKeyDown={onKey}>
              {heading ? <div className="sel-heading">{heading}</div> : null}
              {items.map((option, index) => (
                <div
                  key={option.value}
                  data-index={index}
                  role="option"
                  aria-selected={option.value === value}
                  className={`sel-option ${option.value === value ? 'on' : ''} ${index === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(option.value)}
                >
                  <span className="sel-check">{option.value === value ? <Check size={13} /> : null}</span>
                  <span className="sel-text">
                    <span className="sel-label">{option.label}</span>
                    {option.hint ? <span className="sel-hint">{option.hint}</span> : null}
                  </span>
                </div>
              ))}
              {custom ? (
                <div className="sel-custom">
                  <input
                    className="input mono"
                    value={draft}
                    placeholder={custom.placeholder}
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') choose(draft.trim());
                      if (e.key === 'Escape') close();
                    }}
                  />
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

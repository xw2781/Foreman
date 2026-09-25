import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { AgentStatus, LimitWindow, Provider } from '@shared/types';
import { PROVIDER_LABEL } from '@shared/types';
import { STATUS_LABEL, colorVar, isStale, percent, resetIn, severity } from './format';
import { useApp } from './store';

// ------------------------------------------------------------------ marks

/** Simple geometric marks, not vendor logos: an eight-ray spark and a prompt chevron. */
export function ProviderIcon({ provider, size = 22 }: { provider: Provider; size?: number }) {
  const inner = Math.round(size * 0.62);
  return (
    <span className={`provider-icon ${provider}`} style={{ width: size, height: size, borderRadius: Math.round(size / 3.2) }} title={PROVIDER_LABEL[provider]}>
      {provider === 'claude' ? (
        <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
        </svg>
      ) : (
        <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 7 5 5-5 5M12.5 17H19" />
        </svg>
      )}
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

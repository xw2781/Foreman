import type { AgentStatus, LimitWindow, Provider } from '@shared/types';

export function usd(value: number | null | undefined, precise = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return precise ? `$${value.toFixed(4)}` : '<$0.01';
  if (value < 0.1) return `$${value.toFixed(3)}`;
  if (value >= 10_000) return `$${(value / 1000).toFixed(1)}K`;
  if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toFixed(2)}`;
}

export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function duration(fromIso: string | null | undefined, toIso?: string | null): string {
  if (!fromIso) return '—';
  const end = toIso ? Date.parse(toIso) : Date.now();
  const ms = Math.max(0, end - Date.parse(fromIso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 45_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function resetIn(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h}h ${m % 60}m`;
  const date = new Date(iso);
  return `resets ${date.toLocaleDateString(undefined, { weekday: 'short' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function shortPath(value: string | null | undefined, keep = 2): string {
  if (!value) return '—';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep + 1) return value;
  return `…\\${parts.slice(-keep).join('\\')}`;
}

export function folderName(value: string | null | undefined): string {
  if (!value) return '—';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  'needs-input': 'Needs input',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
};

/** Severity of a utilisation value: accent under 70%, warning to 90%, critical above. */
export function severity(value: number | null | undefined): '' | 'warn' | 'crit' {
  if (value === null || value === undefined) return '';
  if (value >= 90) return 'crit';
  if (value >= 70) return 'warn';
  return '';
}

/** Account colours are palette slots ("slot-3"); a raw hex still works. */
export function colorVar(color: string | null | undefined): string {
  if (!color) return 'var(--text-muted)';
  const slot = /^slot-(\d)$/.exec(color);
  return slot ? `var(--series-${slot[1]})` : color;
}

export const PROVIDER_COLOR: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)'
};

/** A window whose reset time has passed: the reported percentage no longer applies. */
export function isStale(window: LimitWindow): boolean {
  if (!window.resetsAt) return false;
  const reset = Date.parse(window.resetsAt);
  return Number.isFinite(reset) && reset < Date.now();
}

export function limitSummary(windows: LimitWindow[] | undefined | null): string {
  const fresh = (windows ?? []).filter((w) => !isStale(w));
  if (fresh.length === 0) return '';
  return fresh
    .slice(0, 2)
    .map((w) => `${w.label} ${w.detail ?? `${Math.round(w.usedPercent)}%`}`)
    .join(' · ');
}

export function initials(label: string): string {
  const words = label.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
}

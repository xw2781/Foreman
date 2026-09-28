import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Boxes, CloudSync, Copy, Download, ExternalLink, FolderOpen, History, Loader2, Monitor, RefreshCw, Table2, Upload, UserRound, X } from 'lucide-react';
import { PROVIDER_LABEL, type Provider, type UsageFact, type UsageMachine, type UsageSessionRow } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago, colorVar, compact, folderName, usd, PROVIDER_COLOR } from '../format';
import { AccountChip, Empty, MiniMeter, ProviderIcon, Segmented, Select, useTicker } from '../ui';

/** One day of the filtered usage, spend split by the chart's series keys. */
interface DayRow {
  date: string;
  by: Record<string, number>;
  usd: number;
  tokens: number;
  requests: number;
}

interface Series {
  key: string;
  label: string;
  color: string;
  /** Spend over the whole range, shown in the legend. */
  total: number;
}

type Split = 'provider' | 'account' | 'machine' | 'model';

/** Page filters: `all`, or a computer id; an account id or `tool:<provider>`; a `<provider>:<model>` key. */
interface Filter {
  machine: string;
  account: string;
  model: string;
}

const ALL: Filter = { machine: 'all', account: 'all', model: 'all' };
/** The most-used models take the account slots; the rest share one neutral "Other" series. */
const MODEL_SLOTS = 6;
const OTHER_MODELS = 'other';
const OTHER_COLOR = 'var(--text-muted)';

const modelKey = (row: { provider: Provider; model: string }) => `${row.provider}:${row.model}`;

function modelLabel(provider: Provider, model: string) {
  return model === 'unknown' ? `Unnamed ${PROVIDER_LABEL[provider]} model` : model;
}

function niceStep(max: number, ticks = 4) {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

function dayLabel(date: string, withWeekday = false) {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(y, m - 1, d);
  return value.toLocaleDateString(undefined, withWeekday ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Stacked daily columns: <=24px bars, 4px rounded caps, 2px surface gaps, hairline grid. */
function StackedColumns({ days, series }: { days: DayRow[]; series: Series[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 230;
  const pad = { top: 10, right: 8, bottom: 26, left: 48 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const totals = days.map((d) => d.usd);
  const max = Math.max(0, ...totals);
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const band = plotW / Math.max(1, days.length);
  const barW = Math.max(3, Math.min(24, band * 0.62));
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 64))));
  const GAP = 2;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg height={height} role="img" aria-label="Daily spend by series">
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'baseline' : 'gridline'} x1={pad.left} x2={pad.left + plotW} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
            <text className="tick" x={pad.left - 8} y={y(t) + 4} textAnchor="end">
              {t === 0 ? '$0' : top < 1 ? `$${t.toFixed(2)}` : `$${compact(t)}`}
            </text>
          </g>
        ))}
        {days.map((day, i) => {
          const cx = pad.left + band * i + band / 2;
          let cursor = y(0);
          const segments = series
            .map((s) => ({ s, v: day.by[s.key] ?? 0 }))
            .filter((seg) => seg.v > 0);
          const lastIndex = segments.length - 1;
          return (
            <g key={day.date}>
              <rect
                className={`hover-band ${hover === i ? 'on' : ''}`}
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={plotH}
                onMouseEnter={() => setHover(i)}
              />
              {segments.map((seg, index) => {
                const h = Math.max(1, (seg.v / top) * plotH);
                const topY = cursor - h;
                // The surface gap sits between stacked segments, never below the baseline.
                const gapped = index > 0 ? GAP : 0;
                const drawH = Math.max(1, h - gapped);
                const rectY = topY;
                cursor = topY;
                const isTop = index === lastIndex;
                const r = isTop ? Math.min(4, barW / 2, drawH) : 0;
                const x0 = cx - barW / 2;
                const path = r
                  ? `M${x0},${rectY + drawH} L${x0},${rectY + r} Q${x0},${rectY} ${x0 + r},${rectY} L${x0 + barW - r},${rectY} Q${x0 + barW},${rectY} ${x0 + barW},${rectY + r} L${x0 + barW},${rectY + drawH} Z`
                  : `M${x0},${rectY + drawH} L${x0},${rectY} L${x0 + barW},${rectY} L${x0 + barW},${rectY + drawH} Z`;
                return <path key={seg.s.key} d={path} fill={seg.s.color} pointerEvents="none" />;
              })}
              {/* "Today" always shows; a regular label too close to it would run into it. */}
              {(i % labelEvery === 0 && days.length - 1 - i >= labelEvery) || i === days.length - 1 ? (
                <text className="tick" x={cx} y={height - 8} textAnchor="middle">
                  {i === days.length - 1 ? 'Today' : dayLabel(day.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hover !== null && days[hover] ? (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(8, pad.left + band * hover + band / 2 - 90 + 18), width - 190),
            top: 6
          }}
        >
          <div className="tt-title">{dayLabel(days[hover].date, true)}</div>
          {/* Top of the stack first, as the bar reads; series with no spend that day are left out. */}
          {[...series]
            .reverse()
            .filter((s) => (days[hover].by[s.key] ?? 0) > 0)
            .map((s) => (
              <div className="tt-row" key={s.key}>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
                <span className="v">{usd(days[hover].by[s.key])}</span>
              </div>
            ))}
          <div className="tt-row" style={{ borderTop: '1px solid var(--border)', paddingTop: 5 }}>
            Total
            <span className="v">{usd(totals[hover])}</span>
          </div>
          <div className="tt-row">
            Tokens
            <span className="v">{compact(days[hover].tokens)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SpendTable({ days, series }: { days: DayRow[]; series: Series[] }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 300 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.key} className="r">
                <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  <span className="swatch" style={{ background: s.color }} />
                  {s.label}
                </span>
              </th>
            ))}
            <th className="r">Total</th>
            <th className="r">Tokens</th>
            <th className="r">Requests</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.date}>
              <td>{dayLabel(d.date, true)}</td>
              {series.map((s) => (
                <td key={s.key} className="r num">
                  {usd(d.by[s.key] ?? 0)}
                </td>
              ))}
              <td className="r num">{usd(d.usd)}</td>
              <td className="r num">{compact(d.tokens)}</td>
              <td className="r num">{compact(d.requests)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Delta({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null || previous <= 0) return null;
  const change = ((current - previous) / previous) * 100;
  if (!Number.isFinite(change)) return null;
  // Spending more is the direction to watch, so up reads as the warning color.
  return (
    <span className={change > 0 ? 'delta-up' : 'delta-down'}>
      {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(0)}%
    </span>
  );
}

interface AccountEntry {
  id: string;
  provider: Provider;
  label: string;
  sub: string;
  color: string | null;
}

/** Computers take the account slots in order; only one split shows at a time. */
function machineColor(index: number) {
  return `var(--series-${3 + (index % 6)})`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** This computer and every other one whose usage was imported or synced through GitHub. */
function Computers({ machines, spend }: { machines: UsageMachine[]; spend: Record<string, number> }) {
  const github = useApp((s) => s.github);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const exportFile = () =>
    run('export', async () => {
      const result = await call('usage.export');
      if (result) toast('success', `Exported ${plural(result.sessions, 'session')} from ${plural(result.machines, 'computer')}.`);
    });
  const importFile = () =>
    run('import', async () => {
      const result = await call('usage.import');
      if (!result) return;
      if (result.machines === 0) toast('info', 'Those files only hold this computer’s own usage.');
      else toast('success', `Imported ${plural(result.machines, 'computer')}: ${plural(result.added, 'new session')}, ${result.updated} updated.`);
    });
  const sync = () =>
    run('sync', async () => {
      await call('github.sync');
    });
  const connect = () =>
    run('connect', async () => {
      useApp.setState({ github: await call('github.connect') });
    });
  const forget = (id: string) =>
    run(`forget:${id}`, async () => {
      useApp.setState({ usage: await call('usage.forgetMachine', id) });
    });

  const rows = machines.map((machine, i) => ({ machine, color: machineColor(i), value: spend[machine.id] ?? 0 }));
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  const connected = Boolean(github?.login && github.repo);
  const syncing = busy === 'sync' || Boolean(github?.syncing);

  return (
    <>
      <div className="section-title">
        <h2>Computers</h2>
        <span className="sub">
          {connected ? (
            <>
              Synced through GitHub · {github!.repo}
              {github!.lastSyncAt ? ` · ${ago(github!.lastSyncAt)}` : ''}
            </>
          ) : (
            'Usage from your other computers, combined here'
          )}
        </span>
        <div className="actions">
          {connected ? (
            <>
              <button className="btn sm" onClick={sync} disabled={syncing}>
                <CloudSync size={13} className={syncing ? 'spin' : ''} /> Sync now
              </button>
              <button className="btn ghost sm" title="Stop syncing on this computer (the repo stays)" onClick={() => call('github.disconnect').then((github) => useApp.setState({ github }))}>
                Disconnect
              </button>
            </>
          ) : github?.available && !github.pending ? (
            <button className="btn sm primary" onClick={connect} disabled={busy === 'connect'}>
              <CloudSync size={13} /> Connect GitHub
            </button>
          ) : null}
          <button className="btn sm" onClick={importFile} disabled={busy === 'import'} title="Merge usage files exported on other computers">
            <Upload size={13} /> Import file
          </button>
          <button className="btn sm" onClick={exportFile} disabled={busy === 'export'} title="Save this computer's usage, and every imported computer's, to a file">
            {busy === 'export' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Export file
          </button>
        </div>
      </div>
      <div className="card">
        {github?.pending ? (
          <div className="device-code">
            <div>
              Enter <span className="code mono">{github.pending.userCode}</span> at{' '}
              <span className="mono">{github.pending.verificationUri.replace(/^https?:\/\//, '')}</span> to let Foreman keep usage in a private repo on your GitHub account.
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => navigator.clipboard.writeText(github.pending!.userCode).then(() => toast('success', 'Code copied.'))}>
                <Copy size={13} /> Copy code
              </button>
              <button className="btn sm" onClick={() => call('shell.openExternal', github.pending!.verificationUri)}>
                <ExternalLink size={13} /> Open GitHub
              </button>
              <button className="btn ghost sm" onClick={() => call('github.cancel').then((github) => useApp.setState({ github }))}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {github?.lastError ? <div className="device-code error">{github.lastError}</div> : null}
        <div className="card-pad">
          {rows.map(({ machine, color, value }) => (
            <div className="hbar-row with-action" key={machine.id}>
              <div className="label">
                <Monitor size={16} style={{ color, flex: 'none' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{machine.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {machine.local ? 'This computer' : machine.dataAt ? `Read ${ago(machine.dataAt)}` : 'Imported'}
                  </div>
                </div>
              </div>
              <div className="hbar-track">
                <div className="hbar-fill" style={{ width: `${(value / max) * 100}%`, background: color }} />
              </div>
              <div className="value">{usd(value)}</div>
              {machine.local ? (
                <span />
              ) : (
                <button
                  className="btn ghost sm icon"
                  title={connected ? 'Remove this computer’s usage here (it returns at the next sync while its file is in the repo)' : 'Remove this computer’s usage here'}
                  disabled={busy === `forget:${machine.id}`}
                  onClick={() => forget(machine.id)}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {rows.length === 1 ? (
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0', lineHeight: 1.6 }}>
              {github?.available
                ? 'Connect GitHub on each computer to combine their usage automatically, or export a file here and import it on another computer.'
                : 'Export a file here and import it on another computer; each export also carries the computers it has imported, so one file can travel between them.'}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function UsageView() {
  useTicker(30_000);
  const usage = useApp((s) => s.usage);
  const progress = useApp((s) => s.usageProgress);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.agents);
  const toast = useApp((s) => s.toast);
  const [split, setSplit] = useState<Split>('provider');
  const [asTable, setAsTable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>(ALL);

  const refresh = async (force: boolean) => {
    setLoading(true);
    try {
      useApp.setState({ usage: await call('usage.report', force) });
    } catch (error) {
      toast('error', errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!usage) refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRange = async (days: number) => {
    const next = await call('settings.update', { usageDays: days });
    useApp.setState({ settings: next });
    refresh(true);
  };

  const remoteAccounts = usage?.remoteAccounts;
  const accounts: AccountEntry[] = useMemo(() => {
    // Accounts only known from other computers take the slots no account here uses.
    const used = new Set(profiles.map((p) => p.color));
    const free = [3, 4, 5, 6, 7, 8].map((n) => `slot-${n}`).filter((slot) => !used.has(slot));
    return [
      ...profiles.map((p) => ({ id: p.id, provider: p.provider, label: p.label, sub: p.identity?.email ?? PROVIDER_LABEL[p.provider], color: p.color })),
      ...(remoteAccounts ?? []).map((a, i) => ({ id: a.id, provider: a.provider, label: a.label, sub: 'On another computer', color: free[i] ?? null }))
    ];
  }, [profiles, remoteAccounts]);

  // Models rank by spend over the whole range, unfiltered, so a filter never repaints one.
  const facts = usage?.facts;
  const modelRank = useMemo(() => {
    const spend = new Map<string, { provider: Provider; model: string; usd: number; tokens: number }>();
    for (const fact of facts ?? []) {
      const key = modelKey(fact);
      const row = spend.get(key) ?? { provider: fact.provider, model: fact.model, usd: 0, tokens: 0 };
      row.usd += fact.usd ?? 0;
      row.tokens += fact.tokens;
      spend.set(key, row);
    }
    return [...spend.entries()].sort(([, a], [, b]) => b.usd - a.usd || b.tokens - a.tokens);
  }, [facts]);
  const modelColor = useMemo(() => new Map(modelRank.slice(0, MODEL_SLOTS).map(([key], i) => [key, `var(--series-${3 + i})`])), [modelRank]);

  if (!usage) {
    return (
      <div className="page">
        <Empty icon={<Loader2 className="spin" size={22} />} title="Reading session history…">
          Scanning Claude Code transcripts and Codex rollouts for every account. The first scan reads everything once; later updates only read what changed.
          {progress ? ` ${progress} files so far.` : ''}
        </Empty>
      </div>
    );
  }

  // A choice that no longer exists (a forgotten computer, a model out of range) reads as "all".
  const active: Filter = {
    machine: usage.machines.some((m) => m.id === filter.machine) ? filter.machine : 'all',
    account: filter.account.startsWith('tool:') || accounts.some((a) => a.id === filter.account) ? filter.account : 'all',
    model: modelRank.some(([key]) => key === filter.model) ? filter.model : 'all'
  };
  const filtering = active.machine !== 'all' || active.account !== 'all' || active.model !== 'all';
  const localId = usage.machines.find((m) => m.local)?.id;
  const accountMatches = (provider: Provider, profileId: string) =>
    active.account === 'all' || active.account === `tool:${provider}` || active.account === profileId;
  const factMatches = (fact: UsageFact) =>
    (active.machine === 'all' || fact.machineId === active.machine) && accountMatches(fact.provider, fact.profileId) && (active.model === 'all' || modelKey(fact) === active.model);

  const seriesKey = (fact: UsageFact) => {
    if (split === 'provider') return fact.provider;
    if (split === 'account') return fact.profileId;
    if (split === 'machine') return fact.machineId;
    return modelColor.has(modelKey(fact)) ? modelKey(fact) : OTHER_MODELS;
  };
  const dayIndex = new Map(usage.days.map((d): [string, DayRow] => [d.date, { date: d.date, by: {}, usd: 0, tokens: 0, requests: 0 }]));
  const accountSpend = new Map<string, number>();
  const machineSpend: Record<string, number> = {};
  const modelRows = new Map<string, { provider: Provider; model: string; usd: number | null; tokens: number; requests: number }>();
  for (const fact of usage.facts) {
    if (!factMatches(fact)) continue;
    const spend = fact.usd ?? 0;
    const day = dayIndex.get(fact.date);
    if (day) {
      const key = seriesKey(fact);
      day.by[key] = (day.by[key] ?? 0) + spend;
      day.usd += spend;
      day.tokens += fact.tokens;
      day.requests += fact.requests;
    }
    accountSpend.set(fact.profileId, (accountSpend.get(fact.profileId) ?? 0) + spend);
    machineSpend[fact.machineId] = (machineSpend[fact.machineId] ?? 0) + spend;
    const row = modelRows.get(modelKey(fact)) ?? { provider: fact.provider, model: fact.model, usd: null, tokens: 0, requests: 0 };
    if (fact.usd !== null) row.usd = (row.usd ?? 0) + fact.usd;
    row.tokens += fact.tokens;
    row.requests += fact.requests;
    modelRows.set(modelKey(fact), row);
  }
  const days = [...dayIndex.values()];

  const candidates: Array<Omit<Series, 'total'>> =
    split === 'provider'
      ? // Codex takes slot 1 and Claude slot 2; stacked Codex-first from the baseline.
        (['codex', 'claude'] as Provider[]).map((p) => ({ key: p, label: PROVIDER_LABEL[p], color: PROVIDER_COLOR[p] }))
      : split === 'account'
        ? accounts.map((a) => ({ key: a.id, label: `${a.label} · ${a.provider === 'claude' ? 'Claude' : 'Codex'}`, color: colorVar(a.color) }))
        : split === 'machine'
          ? usage.machines.map((m, i) => ({ key: m.id, label: m.name, color: machineColor(i) }))
          : [
              ...modelRank.slice(0, MODEL_SLOTS).map(([key, m]) => ({ key, label: modelLabel(m.provider, m.model), color: modelColor.get(key)! })),
              { key: OTHER_MODELS, label: 'Other models', color: OTHER_COLOR }
            ];
  const series: Series[] = candidates
    .map((c) => ({ ...c, total: days.reduce((sum, d) => sum + (d.by[c.key] ?? 0), 0) }))
    .filter((s) => s.total > 0);

  const sum = (list: DayRow[]) => list.reduce((total, d) => total + d.usd, 0);
  const today = sum(days.slice(-1));
  const week = sum(days.slice(-7));
  const range = sum(days);
  const yesterday = days.length >= 2 ? sum(days.slice(-2, -1)) : null;
  const prevWeek = days.length >= 14 ? sum(days.slice(-14, -7)) : null;
  const rangeTokens = days.reduce((t, d) => t + d.tokens, 0);
  const rangeRequests = days.reduce((t, d) => t + d.requests, 0);
  const byProfile = accounts
    .filter((a) => accountSpend.has(a.id) || !filtering)
    .map((a) => ({ account: a, value: accountSpend.get(a.id) ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const otherComputers = usage.machines.length - 1;
  const maxProfile = Math.max(0.0001, ...byProfile.map((p) => p.value));
  const models = [...modelRows.values()]
    .filter((m) => m.requests > 0)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.tokens - a.tokens)
    .slice(0, 12);
  const maxModel = Math.max(0.0001, ...models.map((m) => m.usd ?? 0));
  const sessions = usage.sessions
    .filter(
      (row) =>
        (active.machine === 'all' || (row.machineId ?? localId) === active.machine) &&
        accountMatches(row.provider, row.profileId) &&
        (active.model === 'all' || row.models.some((m) => `${row.provider}:${m}` === active.model))
    )
    .slice(0, 60);
  const liveSessionIds = new Set(agents.filter((a) => !a.endedAt).map((a) => a.telemetry?.sessionId ?? a.sessionId));

  const resume = (row: UsageSessionRow) => {
    useApp.getState().openLauncher({ provider: row.provider, profileId: row.profileId, cwd: row.cwd ?? settings?.defaultCwd, mode: 'chat', resumeSessionId: row.sessionId });
  };
  const setFilterPart = (part: keyof Filter) => (value: string) => setFilter({ ...active, [part]: value });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Usage & Cost</h1>
          <p>
            API-equivalent cost of every Claude Code and Codex session on this computer
            {otherComputers > 0 ? ` and ${plural(otherComputers, 'other computer')}` : ''}, across all accounts.
          </p>
        </div>
        <div className="actions">
          {/* Filters and the period wrap as two groups, never one control at a time. */}
          <div className="action-group">
            <Select
              className={`filter ${active.machine !== 'all' ? 'on' : ''}`}
              aria-label="Computer"
              heading="Computer"
              icon={<Monitor size={14} />}
              value={active.machine}
              onChange={setFilterPart('machine')}
              options={[
                { value: 'all', label: 'All computers' },
                ...usage.machines.map((m) => ({ value: m.id, label: m.name, hint: m.local ? 'This computer' : m.dataAt ? `Read ${ago(m.dataAt)}` : 'Imported' }))
              ]}
            />
            <Select
              className={`filter ${active.account !== 'all' ? 'on' : ''}`}
              aria-label="Account"
              heading="Account"
              icon={<UserRound size={14} />}
              value={active.account}
              onChange={setFilterPart('account')}
              options={[
                { value: 'all', label: 'All accounts' },
                { value: 'tool:claude', label: 'Claude', hint: 'Every Claude account' },
                { value: 'tool:codex', label: 'Codex', hint: 'Every Codex account' },
                ...accounts.map((a) => ({ value: a.id, label: `${a.label} · ${a.provider === 'claude' ? 'Claude' : 'Codex'}`, hint: a.sub }))
              ]}
            />
            <Select
              className={`filter ${active.model !== 'all' ? 'on' : ''}`}
              aria-label="Model"
              heading="Model"
              icon={<Boxes size={14} />}
              value={active.model}
              onChange={setFilterPart('model')}
              options={[
                { value: 'all', label: 'All models' },
                ...modelRank.map(([key, m]) => ({ value: key, label: modelLabel(m.provider, m.model), hint: `${PROVIDER_LABEL[m.provider]} · ${usd(m.usd)}` }))
              ]}
            />
            {filtering ? (
              <button className="btn ghost" onClick={() => setFilter(ALL)} title="Show all computers, accounts and models">
                <X size={14} /> Clear
              </button>
            ) : null}
          </div>
          <div className="action-group">
            <Segmented
              value={String(settings?.usageDays ?? 30)}
              onChange={(v) => setRange(Number(v))}
              options={[
                { value: '7', label: '7 days' },
                { value: '14', label: '14 days' },
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' }
              ]}
            />
            <button className="btn" onClick={() => refresh(true)} disabled={loading || usage.scanning}>
              <RefreshCw size={14} className={loading || usage.scanning ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="section-title"><h2>Usage from session logs</h2><span className="sub">Local and imported records · API-equivalent cost estimates</span></div>
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Today</span>
          <span className="tile-value">{usd(today)}</span>
          <span className="tile-foot">
            <Delta current={today} previous={yesterday} /> vs yesterday {yesterday !== null ? usd(yesterday) : ''}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Last 7 days</span>
          <span className="tile-value">{usd(week)}</span>
          <span className="tile-foot">
            {prevWeek !== null ? (
              <>
                <Delta current={week} previous={prevWeek} /> vs previous 7 days
              </>
            ) : (
              `${usd(week / 7)} per day`
            )}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Last {days.length} days</span>
          <span className="tile-value">{usd(range)}</span>
          <span className="tile-foot">{usd(range / Math.max(1, days.length))} per day on average</span>
        </div>
        <div className="tile">
          <span className="tile-label">Tokens in session logs</span>
          <span className="tile-value">{compact(rangeTokens)}</span>
          <span className="tile-foot">{compact(rangeRequests)} requests in range</span>
        </div>
      </div>

      <div className="card section">
        <div className="card-header wrap">
          <h2>Daily spend</h2>
          <span className="sub">
            {usage.scanning ? `Scanning… ${usage.scannedFiles} files` : `Updated ${ago(usage.generatedAt)} · list prices as of ${usage.pricingDate}`}
          </span>
          <div className="actions">
            <Select
              aria-label="Split spend by"
              heading="Split spend by"
              prefix="Split by"
              style={{ width: 'auto' }}
              value={split}
              onChange={(v) => setSplit(v as Split)}
              options={[
                { value: 'provider', label: 'Tool', hint: 'Claude Code and Codex' },
                { value: 'account', label: 'Account', hint: 'Each account, here or on other computers' },
                { value: 'machine', label: 'Computer', hint: 'This computer and the ones synced or imported' },
                { value: 'model', label: 'Model', hint: `The ${MODEL_SLOTS} costliest models; the rest as Other` }
              ]}
            />
            <Segmented
              value={asTable ? 'table' : 'chart'}
              onChange={(v) => setAsTable(v === 'table')}
              options={[
                { value: 'chart', label: <BarChart3 size={13} /> },
                { value: 'table', label: <Table2 size={13} /> }
              ]}
            />
          </div>
        </div>
        <div className="legend" style={{ padding: '10px 18px 0' }}>
          {series.map((s) => (
            <span className="item" key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label}
              <span className="legend-value">{usd(s.total)}</span>
            </span>
          ))}
          {series.length === 0 ? <span className="muted">{filtering ? 'No spend matches these filters.' : 'No spend in this period.'}</span> : null}
        </div>
        {asTable ? <SpendTable days={days} series={series} /> : <StackedColumns days={days} series={series} />}
      </div>

      <div className="grid-2 section">
        <div className="card">
          <div className="card-header">
            <h2>By account</h2>
            <span className="sub">Last {days.length} days</span>
          </div>
          <div className="card-pad">
            {byProfile.map(({ account, value }) => (
              <div className="hbar-row" key={account.id}>
                <div className="label">
                  <ProviderIcon provider={account.provider} size={18} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{account.label}</div>
                    <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                      {account.sub}
                    </div>
                  </div>
                </div>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(value / maxProfile) * 100}%`, background: colorVar(account.color) }} />
                </div>
                <div className="value">{usd(value)}</div>
              </div>
            ))}
            {byProfile.length === 0 ? <p className="muted" style={{ margin: 0 }}>No usage matches these filters.</p> : null}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>By model</h2>
            <span className="sub">Last {days.length} days</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="r">Requests</th>
                  <th className="r">Tokens</th>
                  <th style={{ width: '30%' }} />
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const color = modelColor.get(modelKey(m)) ?? OTHER_COLOR;
                  return (
                    <tr key={modelKey(m)}>
                      <td>
                        <div className="row">
                          <span className="swatch" style={{ background: color }} />
                          <span className="ellipsis" title={`${PROVIDER_LABEL[m.provider]} · ${m.model}`}>
                            {modelLabel(m.provider, m.model)}
                          </span>
                        </div>
                      </td>
                      <td className="r num">{compact(m.requests)}</td>
                      <td className="r num">{compact(m.tokens)}</td>
                      <td>
                        <div className="hbar-track" style={{ height: 8 }}>
                          <div className="hbar-fill" style={{ width: `${((m.usd ?? 0) / maxModel) * 100}%`, background: color, borderRadius: '0 3px 3px 0' }} />
                        </div>
                      </td>
                      <td className="r num">{m.usd === null ? <span className="muted" title="No list price for this model">unpriced</span> : usd(m.usd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Computers machines={usage.machines} spend={machineSpend} />

      <div className="section-title">
        <h2>Sessions</h2>
        <span className="sub">
          {filtering ? 'Sessions matching the filters above' : 'Every Claude Code and Codex session, including ones started in VS Code or the desktop apps'}
        </span>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Account</th>
                <th>Model</th>
                <th>Context</th>
                <th className="r">Requests</th>
                <th className="r">Cost</th>
                <th>Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((row) => {
                const account = accounts.find((a) => a.id === row.profileId);
                const running = liveSessionIds.has(row.sessionId);
                const remote = row.machineId !== null;
                return (
                  <tr key={`${row.machineId ?? ''}:${row.profileId}:${row.sessionId}`}>
                    <td style={{ maxWidth: 380 }}>
                      <div className="row">
                        <ProviderIcon provider={row.provider} size={20} />
                        <div style={{ minWidth: 0 }}>
                          <div className="title ellipsis" title={row.title ?? ''}>
                            {row.title ?? <span className="muted">Untitled session</span>}
                            {row.active ? <span className="badge accent" style={{ marginLeft: 6 }}>active</span> : null}
                          </div>
                          <div className="subtitle ellipsis mono" title={remote ? `${row.cwd ?? ''} on ${row.machineName}` : row.cwd ?? ''}>
                            {folderName(row.cwd)}
                            {remote ? ` · ${row.machineName}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>{account ? <AccountChip label={account.label} color={account.color} /> : <span className="muted">—</span>}</td>
                    <td className="secondary ellipsis" style={{ maxWidth: 150 }}>
                      {row.model ?? '—'}
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <MiniMeter value={row.contextPercent} />
                    </td>
                    <td className="r num">{compact(row.requests)}</td>
                    <td className="r num">{usd(row.costUsd)}</td>
                    <td className="secondary">{ago(row.updatedAt)}</td>
                    <td className="actions-cell">
                      {!running && !remote && row.cwd ? (
                        <button className="btn sm" title="Continue this conversation in the app" onClick={() => resume(row)}>
                          <History size={12} /> Resume
                        </button>
                      ) : null}
                      {remote ? null : (
                        <button className="btn ghost sm icon" title="Show session file" onClick={() => call('shell.showItem', row.filePath)}>
                          <FolderOpen size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
        Costs price every request at public API list rates (Anthropic and OpenAI Standard tier, {usage.pricingDate}), including cache reads and writes, and OpenAI's long-context rate above 272K input tokens. Subscription plans are billed differently; treat these as the API-equivalent value of what you used. Other computers’ costs are priced there, at their own rates.
        Nothing is sent anywhere unless you connect GitHub, which keeps per-session totals and titles (never conversations) in a private repo of yours.
      </p>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, FolderOpen, History, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type ProfileView, type Provider, type UsageDay, type UsageSessionRow } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago, colorVar, compact, folderName, usd, PROVIDER_COLOR } from '../format';
import { AccountChip, Empty, MiniMeter, ProviderIcon, Segmented, useTicker } from '../ui';

interface Series {
  key: string;
  label: string;
  color: string;
  value: (day: UsageDay) => number;
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
function StackedColumns({ days, series }: { days: UsageDay[]; series: Series[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 230;
  const pad = { top: 10, right: 8, bottom: 26, left: 48 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const totals = days.map((d) => series.reduce((sum, s) => sum + s.value(d), 0));
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
            .map((s) => ({ s, v: s.value(day) }))
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
              {i % labelEvery === 0 || i === days.length - 1 ? (
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
          {series.map((s) => (
            <div className="tt-row" key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label}
              <span className="v">{usd(s.value(days[hover]))}</span>
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

function SpendTable({ days, series }: { days: UsageDay[]; series: Series[] }) {
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
                  {usd(s.value(d))}
                </td>
              ))}
              <td className="r num">{usd(series.reduce((sum, s) => sum + s.value(d), 0))}</td>
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

function sessionAccount(profiles: ProfileView[], row: UsageSessionRow) {
  return profiles.find((p) => p.id === row.profileId);
}

export function UsageView() {
  useTicker(30_000);
  const usage = useApp((s) => s.usage);
  const progress = useApp((s) => s.usageProgress);
  const profiles = useApp((s) => s.profiles);
  const settings = useApp((s) => s.settings);
  const agents = useApp((s) => s.agents);
  const toast = useApp((s) => s.toast);
  const [split, setSplit] = useState<'provider' | 'account'>('provider');
  const [asTable, setAsTable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionProvider, setSessionProvider] = useState<'all' | Provider>('all');

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

  const series: Series[] = useMemo(() => {
    if (split === 'provider') {
      // Codex takes slot 1 and Claude slot 2; stacked Codex-first from the baseline.
      return (['codex', 'claude'] as Provider[]).map((p) => ({ key: p, label: PROVIDER_LABEL[p], color: PROVIDER_COLOR[p], value: (d: UsageDay) => d.byProvider[p] ?? 0 }));
    }
    return profiles.map((p) => ({
      key: p.id,
      label: `${p.label} · ${p.provider === 'claude' ? 'Claude' : 'Codex'}`,
      color: colorVar(p.color),
      value: (d: UsageDay) => d.byProfile[p.id] ?? 0
    }));
  }, [split, profiles]);

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

  const days = usage.days;
  const sum = (list: UsageDay[]) => list.reduce((total, d) => total + d.byProvider.claude + d.byProvider.codex, 0);
  const yesterday = days.length >= 2 ? sum(days.slice(-2, -1)) : null;
  const prevWeek = days.length >= 14 ? sum(days.slice(-14, -7)) : null;
  const rangeTokens = days.reduce((t, d) => t + d.tokens, 0);
  const rangeRequests = days.reduce((t, d) => t + d.requests, 0);
  const byProfile = profiles
    .map((p) => ({ profile: p, value: days.reduce((t, d) => t + (d.byProfile[p.id] ?? 0), 0) }))
    .sort((a, b) => b.value - a.value);
  const maxProfile = Math.max(0.0001, ...byProfile.map((p) => p.value));
  const models = usage.models.filter((m) => m.requests > 0).slice(0, 12);
  const maxModel = Math.max(0.0001, ...models.map((m) => m.usd ?? 0));
  const sessions = usage.sessions.filter((s) => sessionProvider === 'all' || s.provider === sessionProvider).slice(0, 60);
  const liveSessionIds = new Set(agents.filter((a) => !a.endedAt).map((a) => a.telemetry?.sessionId ?? a.sessionId));

  const resume = (row: UsageSessionRow) => {
    useApp.getState().openLauncher({ provider: row.provider, profileId: row.profileId, cwd: row.cwd ?? settings?.defaultCwd, mode: 'chat', resumeSessionId: row.sessionId });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Usage & Cost</h1>
          <p>API-equivalent cost of every Claude Code and Codex session on this computer, across all accounts.</p>
        </div>
        <div className="actions">
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

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Today</span>
          <span className="tile-value">{usd(usage.totals.today)}</span>
          <span className="tile-foot">
            <Delta current={usage.totals.today} previous={yesterday} /> vs yesterday {yesterday !== null ? usd(yesterday) : ''}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Last 7 days</span>
          <span className="tile-value">{usd(usage.totals.week)}</span>
          <span className="tile-foot">
            {prevWeek !== null ? (
              <>
                <Delta current={usage.totals.week} previous={prevWeek} /> vs previous 7 days
              </>
            ) : (
              `${usd(usage.totals.week / 7)} per day`
            )}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Last {days.length} days</span>
          <span className="tile-value">{usd(usage.totals.range)}</span>
          <span className="tile-foot">{usd(usage.totals.range / Math.max(1, days.length))} per day on average</span>
        </div>
        <div className="tile">
          <span className="tile-label">Tokens</span>
          <span className="tile-value">{compact(rangeTokens)}</span>
          <span className="tile-foot">{compact(rangeRequests)} requests in range</span>
        </div>
      </div>

      <div className="card section">
        <div className="card-header">
          <h2>Daily spend</h2>
          <span className="sub">
            {usage.scanning ? `Scanning… ${usage.scannedFiles} files` : `Updated ${ago(usage.generatedAt)} · list prices as of ${usage.pricingDate}`}
          </span>
          <div className="actions">
            <Segmented
              value={split}
              onChange={setSplit}
              options={[
                { value: 'provider', label: 'By tool' },
                { value: 'account', label: 'By account' }
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
            </span>
          ))}
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
            {byProfile.map(({ profile, value }) => (
              <div className="hbar-row" key={profile.id}>
                <div className="label">
                  <ProviderIcon provider={profile.provider} size={18} />
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 500 }}>
                      {profile.label}
                    </div>
                    <div className="muted ellipsis" style={{ fontSize: 11 }}>
                      {profile.identity?.email ?? PROVIDER_LABEL[profile.provider]}
                    </div>
                  </div>
                </div>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(value / maxProfile) * 100}%`, background: colorVar(profile.color) }} />
                </div>
                <div className="value">{usd(value)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>By model</h2>
            <span className="sub">Sessions active in range</span>
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
                {models.map((m) => (
                  <tr key={`${m.provider}:${m.model}`}>
                    <td>
                      <div className="row">
                        <span className="swatch" style={{ background: PROVIDER_COLOR[m.provider] }} />
                        <span className="ellipsis">{m.model}</span>
                      </div>
                    </td>
                    <td className="r num">{compact(m.requests)}</td>
                    <td className="r num">{compact(m.tokens)}</td>
                    <td>
                      <div className="hbar-track" style={{ height: 8 }}>
                        <div className="hbar-fill" style={{ width: `${((m.usd ?? 0) / maxModel) * 100}%`, background: PROVIDER_COLOR[m.provider], borderRadius: '0 3px 3px 0' }} />
                      </div>
                    </td>
                    <td className="r num">{m.usd === null ? <span className="muted" title="No list price for this model">unpriced</span> : usd(m.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="section-title">
        <h2>Sessions</h2>
        <span className="sub">Every Claude Code and Codex session, including ones started in VS Code or the desktop apps</span>
        <div className="actions">
          <Segmented
            value={sessionProvider}
            onChange={setSessionProvider}
            options={[{ value: 'all', label: 'All' }, ...PROVIDERS.map((p) => ({ value: p, label: p === 'claude' ? 'Claude' : 'Codex' }))]}
          />
        </div>
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
                const account = sessionAccount(profiles, row);
                const running = liveSessionIds.has(row.sessionId);
                return (
                  <tr key={`${row.profileId}:${row.sessionId}`}>
                    <td style={{ maxWidth: 380 }}>
                      <div className="row">
                        <ProviderIcon provider={row.provider} size={20} />
                        <div style={{ minWidth: 0 }}>
                          <div className="title ellipsis" title={row.title ?? ''}>
                            {row.title ?? <span className="muted">Untitled session</span>}
                            {row.active ? <span className="badge accent" style={{ marginLeft: 6 }}>active</span> : null}
                          </div>
                          <div className="subtitle ellipsis mono" title={row.cwd ?? ''}>
                            {folderName(row.cwd)}
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
                      {!running && row.cwd ? (
                        <button className="btn sm" title="Continue this conversation in the app" onClick={() => resume(row)}>
                          <History size={12} /> Resume
                        </button>
                      ) : null}
                      <button className="btn ghost sm icon" title="Show session file" onClick={() => call('shell.showItem', row.filePath)}>
                        <FolderOpen size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
        Costs price every request at public API list rates (Anthropic and OpenAI Standard tier, {usage.pricingDate}), including cache reads and writes, and OpenAI's long-context rate above 272K input tokens. Subscription plans are billed differently; treat these as the API-equivalent value of what you used. Nothing is sent anywhere — the app only reads local session files.
      </p>
    </div>
  );
}

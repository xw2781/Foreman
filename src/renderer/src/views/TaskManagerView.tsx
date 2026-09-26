import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Cpu, History, LayoutGrid, MonitorDot, Plus, Search, Square, SquareTerminal, Trash2, XCircle } from 'lucide-react';
import { AGENT_MODES, LIVE_STATUSES, PROVIDER_LABEL, type AgentInfo, type ExternalAgentProcess, type Provider } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { STATUS_LABEL, ago, compact, duration, folderName, modelLabel, usd } from '../format';
import { AccountChip, Empty, MiniMeter, ProviderIcon, Segmented, StatusPill, confirmDialog, useTicker } from '../ui';
import { canResume, resumeAgent, stopAgent } from './AgentsView';

type SortKey = 'status' | 'title' | 'account' | 'context' | 'cost' | 'cpu' | 'memory' | 'started';
type Filter = 'live' | 'all' | 'attention';

const STATUS_ORDER = ['needs-input', 'working', 'starting', 'idle', 'failed', 'done', 'stopped'];

function sortValue(agent: AgentInfo, key: SortKey): number | string {
  switch (key) {
    case 'status':
      return STATUS_ORDER.indexOf(agent.status);
    case 'title':
      return agent.title.toLowerCase();
    case 'account':
      return `${agent.provider}${agent.profileLabel}`;
    case 'context':
      return agent.telemetry?.contextPercent ?? -1;
    case 'cost':
      return agent.telemetry?.cost.reportedUsd ?? agent.telemetry?.cost.totalUsd ?? -1;
    case 'cpu':
      return agent.resources?.cpuPercent ?? -1;
    case 'memory':
      return agent.resources?.memoryMB ?? -1;
    case 'started':
      return agent.startedAt;
    default:
      return 0;
  }
}

function SummaryTiles({ agents }: { agents: AgentInfo[] }) {
  const usage = useApp((s) => s.usage);
  const live = agents.filter((a) => LIVE_STATUSES.includes(a.status) && !a.endedAt);
  const count = (status: string) => live.filter((a) => a.status === status).length;
  const cpu = live.reduce((sum, a) => sum + (a.resources?.cpuPercent ?? 0), 0);
  const memory = live.reduce((sum, a) => sum + (a.resources?.memoryMB ?? 0), 0);
  const sessionCost = live.reduce((sum, a) => sum + (a.telemetry?.cost.reportedUsd ?? a.telemetry?.cost.totalUsd ?? 0), 0);
  return (
    <div className="tiles">
      <div className="tile">
        <span className="tile-label">Running agents</span>
        <span className="tile-value">{live.filter((a) => AGENT_MODES.includes(a.mode)).length}</span>
        <span className="tile-foot">
          {count('working')} working · {count('idle')} idle
        </span>
      </div>
      <div className="tile">
        <span className="tile-label">Need your input</span>
        <span className="tile-value" style={{ color: count('needs-input') ? 'var(--warning)' : undefined }}>
          {count('needs-input')}
        </span>
        <span className="tile-foot">{count('needs-input') ? 'Waiting on an approval or answer' : 'Nothing waiting'}</span>
      </div>
      <div className="tile">
        <span className="tile-label">CPU · memory</span>
        <span className="tile-value">{cpu.toFixed(1)}%</span>
        <span className="tile-foot">{memory >= 1024 ? `${(memory / 1024).toFixed(1)} GB` : `${Math.round(memory)} MB`} across agent processes</span>
      </div>
      <div className="tile">
        <span className="tile-label">Running sessions' cost</span>
        <span className="tile-value">{usd(sessionCost)}</span>
        <span className="tile-foot">Today overall {usd(usage?.totals.today ?? null)}</span>
      </div>
    </div>
  );
}

function HeaderCell({ label, sortKey, sort, setSort, right }: { label: string; sortKey: SortKey; sort: { key: SortKey; desc: boolean }; setSort: (s: { key: SortKey; desc: boolean }) => void; right?: boolean }) {
  const on = sort.key === sortKey;
  return (
    <th className={right ? 'r' : ''} style={{ cursor: 'pointer' }} onClick={() => setSort({ key: sortKey, desc: on ? !sort.desc : true })}>
      <span className="row" style={{ gap: 4, justifyContent: right ? 'flex-end' : 'flex-start' }}>
        {label}
        {on ? sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} /> : null}
      </span>
    </th>
  );
}

function ExternalSection() {
  const externals = useApp((s) => s.externals);
  const toast = useApp((s) => s.toast);
  const end = async (process: ExternalAgentProcess) => {
    const { ok } = await confirmDialog({
      title: `End ${process.name}?`,
      message: (
        <>
          This ends process {process.pid} and everything it started ({process.host}). Unsaved work in that session may be lost.
        </>
      ),
      confirmLabel: 'End task',
      danger: true
    });
    if (!ok) return;
    try {
      await call('processes.kill', process.pid);
      toast('success', `Ended ${process.name} (${process.pid}).`);
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };
  return (
    <>
      <div className="section-title">
        <MonitorDot size={16} className="muted" />
        <h2>Other agents on this computer</h2>
        <span className="sub">Started outside this app — VS Code, desktop apps, terminals</span>
      </div>
      <div className="card">
        {externals === null ? (
          <div className="muted" style={{ padding: 16 }}>
            Looking for other agents…
          </div>
        ) : externals.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>
            No other Claude Code or Codex processes are running.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Started from</th>
                  <th className="r">PID</th>
                  <th className="r">CPU</th>
                  <th className="r">Memory</th>
                  <th className="r">Processes</th>
                  <th>Running for</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {externals.map((p) => (
                  <tr key={p.pid}>
                    <td>
                      <div className="row">
                        {p.provider === 'other' ? <Cpu size={18} /> : <ProviderIcon provider={p.provider as Provider} size={22} />}
                        <div style={{ minWidth: 0 }}>
                          <div className="title">{p.name}</div>
                          <div className="subtitle ellipsis mono" style={{ maxWidth: 420 }} title={p.commandLine}>
                            {p.commandLine}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge">{p.host}</span>
                    </td>
                    <td className="r num">{p.pid}</td>
                    <td className="r num">{p.cpuPercent.toFixed(1)}%</td>
                    <td className="r num">{Math.round(p.memoryMB)} MB</td>
                    <td className="r num">{p.processCount}</td>
                    <td className="num">{duration(p.startedAt)}</td>
                    <td className="actions-cell">
                      <button className="btn danger sm" onClick={() => end(p)}>
                        <XCircle size={13} /> End task
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function TaskManagerView() {
  useTicker(5000);
  const agents = useApp((s) => s.agents).filter((a) => AGENT_MODES.includes(a.mode));
  const openLauncher = useApp((s) => s.openLauncher);
  const [filter, setFilter] = useState<Filter>('all');
  const [provider, setProvider] = useState<'all' | Provider>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'started', desc: true });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = agents.filter((a) => {
      if (filter === 'live' && (a.endedAt || !LIVE_STATUSES.includes(a.status))) return false;
      if (filter === 'attention' && a.status !== 'needs-input') return false;
      if (provider !== 'all' && a.provider !== provider) return false;
      if (q && !`${a.title} ${a.cwd} ${a.profileLabel} ${a.model ?? ''} ${STATUS_LABEL[a.status]}`.toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
    // Live agents first regardless of the sort, like a task manager.
    return [...list.filter((a) => !a.endedAt), ...list.filter((a) => a.endedAt)];
  }, [agents, filter, provider, query, sort]);

  const open = (agent: AgentInfo) => useApp.setState({ selectedAgentId: agent.id, view: 'agents' });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Task Manager</h1>
          <p>Every agent this app has started, with live status, context, cost and resource use.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => openLauncher()}>
            <Plus size={15} /> New agent
          </button>
        </div>
      </div>
      <SummaryTiles agents={agents} />

      <div className="section-title">
        <LayoutGrid size={16} className="muted" />
        <h2>Agents</h2>
        <div className="actions">
          <div className="row" style={{ position: 'relative' }}>
            <Search size={14} className="muted" style={{ position: 'absolute', left: 10 }} />
            <input className="input" style={{ paddingLeft: 30, height: 30, width: 220 }} placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Segmented
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'all', label: 'All tools' },
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' }
            ]}
          />
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'live', label: 'Running' },
              { value: 'attention', label: 'Needs input' }
            ]}
          />
        </div>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <Empty icon={<SquareTerminal size={22} />} title={agents.length ? 'No agents match these filters' : 'No agents yet'}>
            {agents.length ? 'Try a different filter.' : 'Start a Claude Code or Codex agent and it shows up here.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <HeaderCell label="Status" sortKey="status" sort={sort} setSort={setSort} />
                  <HeaderCell label="Agent" sortKey="title" sort={sort} setSort={setSort} />
                  <HeaderCell label="Account" sortKey="account" sort={sort} setSort={setSort} />
                  <th>Model</th>
                  <HeaderCell label="Context" sortKey="context" sort={sort} setSort={setSort} />
                  <HeaderCell label="Cost" sortKey="cost" sort={sort} setSort={setSort} right />
                  <HeaderCell label="CPU" sortKey="cpu" sort={sort} setSort={setSort} right />
                  <HeaderCell label="Memory" sortKey="memory" sort={sort} setSort={setSort} right />
                  <HeaderCell label="Uptime" sortKey="started" sort={sort} setSort={setSort} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const t = a.telemetry;
                  const live = !a.endedAt;
                  return (
                    <tr key={a.id} className="clickable" onClick={() => open(a)}>
                      <td>
                        <StatusPill status={a.status} detail={a.statusDetail} />
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        <div className="row">
                          <ProviderIcon provider={a.provider} size={22} />
                          <div style={{ minWidth: 0 }}>
                            <div className="title ellipsis" title={a.title}>
                              {a.title}
                              {a.mode === 'task' ? <span className="badge" style={{ marginLeft: 6 }}>task</span> : null}
                            </div>
                            <div className="subtitle ellipsis" title={a.statusDetail ?? a.cwd}>
                              {live && a.statusDetail ? a.statusDetail : `${folderName(a.cwd)} · ${live ? `active ${ago(a.lastActivityAt)}` : `ended ${ago(a.endedAt)}`}`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <AccountChip label={a.profileLabel} color={a.profileColor} />
                      </td>
                      <td className="secondary ellipsis" style={{ maxWidth: 150 }}>
                        {modelLabel(t?.model ?? a.model) || <span className="muted">default</span>}
                      </td>
                      <td style={{ minWidth: 130 }}>
                        <MiniMeter value={t?.contextPercent ?? null} title={t ? `${compact(t.contextUsedTokens)} of ${compact(t.contextWindow)} tokens` : undefined} />
                      </td>
                      <td className="r num">{usd(t?.cost.reportedUsd ?? t?.cost.totalUsd ?? null)}</td>
                      <td className="r num">{a.resources ? `${a.resources.cpuPercent.toFixed(1)}%` : <span className="muted">—</span>}</td>
                      <td className="r num">{a.resources ? `${Math.round(a.resources.memoryMB)} MB` : <span className="muted">—</span>}</td>
                      <td className="num secondary">{duration(a.startedAt, a.endedAt)}</td>
                      <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                        {live ? (
                          <button className="btn danger sm" onClick={() => stopAgent(a)}>
                            <Square size={11} /> Stop
                          </button>
                        ) : (
                          <>
                            {canResume(a) ? (
                              <button className="btn sm" onClick={() => resumeAgent(a)}>
                                <History size={12} /> Resume
                              </button>
                            ) : null}
                            <button className="btn ghost sm icon" title="Remove" onClick={() => call('agents.remove', a.id)}>
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ExternalSection />
      <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
        {PROVIDER_LABEL.claude} status comes from hooks the app passes to each session it starts; {PROVIDER_LABEL.codex} status comes from its session log and on-screen approval prompts.
      </p>
    </div>
  );
}

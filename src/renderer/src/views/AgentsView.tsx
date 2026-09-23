import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  History,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react';
import { LIVE_STATUSES, PROVIDER_LABEL, type AgentInfo } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago, compact, duration, folderName, percent, shortPath, usd } from '../format';
import { AccountChip, Empty, Meter, MiniMeter, ProviderIcon, StatusPill, confirmDialog, useTicker } from '../ui';
import { mountTerminal, terminalBackground } from '../terminals';

export async function stopAgent(agent: AgentInfo) {
  const settings = useApp.getState().settings;
  if (settings?.confirmBeforeStop && (agent.mode === 'interactive' || agent.mode === 'task')) {
    const { ok } = await confirmDialog({
      title: `Stop "${agent.title}"?`,
      message: agent.mode === 'interactive' ? 'The process is ended. The conversation is kept and can be resumed later.' : 'The background task is ended before it finishes.',
      confirmLabel: 'Stop agent',
      danger: true
    });
    if (!ok) return;
  }
  try {
    await call('agents.stop', agent.id);
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
  }
}

/** A conversation exists once the CLI wrote a session file for it. */
export function canResume(agent: AgentInfo) {
  return agent.mode === 'interactive' && Boolean(agent.transcriptPath || agent.telemetry?.sessionId);
}

export async function resumeAgent(agent: AgentInfo) {
  try {
    const next = await call('agents.resume', agent.id);
    useApp.setState({ selectedAgentId: next.id, view: 'agents' });
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
  }
}

function AgentListItem({ agent, selected, onSelect }: { agent: AgentInfo; selected: boolean; onSelect: () => void }) {
  const t = agent.telemetry;
  const detail =
    agent.status === 'needs-input'
      ? agent.statusDetail ?? 'Waiting for your input'
      : agent.status === 'working'
        ? agent.statusDetail ?? 'Working…'
        : agent.endedAt
          ? `${agent.statusDetail ?? 'Ended'} · ${ago(agent.endedAt)}`
          : `Idle · ${ago(agent.lastActivityAt)}`;
  return (
    <div className={`agent-item ${selected ? 'on' : ''} ${agent.status === 'needs-input' ? 'attention' : ''}`} onClick={onSelect}>
      <ProviderIcon provider={agent.provider} size={24} />
      <div className="ai-title" title={agent.title}>
        {agent.title}
      </div>
      <div className="ai-meta">
        <StatusPill status={agent.status} />
        {agent.usesScreen ? <MousePointer2 size={12} color="var(--warning)" /> : null}
        <span className="ellipsis">{agent.mode === 'task' ? 'task' : agent.mode === 'interactive' ? agent.profileLabel : agent.mode}</span>
        {t?.cost.totalUsd != null ? <span style={{ marginLeft: 'auto' }} className="num">{usd(t.cost.reportedUsd ?? t.cost.totalUsd)}</span> : null}
      </div>
      <div className="ai-detail" title={detail}>
        {detail}
      </div>
      {t && t.contextPercent !== null && agent.mode !== 'shell' ? (
        <div style={{ gridColumn: 2 }}>
          <MiniMeter value={t.contextPercent} title={`Context ${compact(t.contextUsedTokens)} / ${compact(t.contextWindow)}`} />
        </div>
      ) : null}
    </div>
  );
}

function TerminalHost({ agent }: { agent: AgentInfo }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    return mountTerminal(agent.id, agent.provider, hostRef.current);
  }, [agent.id, agent.provider]);
  return <div className="term-host" ref={hostRef} style={{ ['--term-bg' as any]: terminalBackground() }} />;
}

function AgentHeader({ agent }: { agent: AgentInfo }) {
  const toggleDetails = useApp((s) => s.toggleDetails);
  const showDetails = useApp((s) => s.showDetails);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.title);
  useEffect(() => setName(agent.title), [agent.title]);
  const live = !agent.endedAt;
  const t = agent.telemetry;
  const rename = async () => {
    setEditing(false);
    if (name.trim() && name !== agent.title) await call('agents.rename', agent.id, name.trim());
  };
  return (
    <div className="term-header">
      <ProviderIcon provider={agent.provider} size={30} />
      <div className="th-title">
        {editing ? (
          <input
            className="input"
            style={{ height: 28 }}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <div className="name" title={agent.title} onDoubleClick={() => setEditing(true)}>
            {agent.title}
          </div>
        )}
        <div className="meta">
          <StatusPill status={agent.status} detail={agent.statusDetail} />
          <AccountChip label={agent.profileLabel} color={agent.profileColor} />
          <span className="ellipsis mono" title={agent.cwd}>
            {shortPath(agent.cwd)}
          </span>
          {agent.model || t?.model ? <span className="badge">{t?.model ?? agent.model}</span> : null}
        </div>
      </div>
      <div className="th-actions">
        {t && t.contextPercent !== null ? (
          <div className="th-context">
            <Meter label="Context" value={t.contextPercent} valueText={`${percent(t.contextPercent)} of ${compact(t.contextWindow)}`} title={`${compact(t.contextUsedTokens)} tokens in context${t.contextWindowAssumed ? ' (window size assumed)' : ''}`} />
          </div>
        ) : null}
        {t ? (
          <div style={{ textAlign: 'right', minWidth: 70 }} title={t.cost.reportedUsd != null ? "Claude Code's own estimate" : 'Estimated at API list prices'}>
            <div className="num" style={{ fontWeight: 600 }}>
              {usd(t.cost.reportedUsd ?? t.cost.totalUsd)}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {compact(t.totalUsage?.totalTokens ?? 0)} tokens
            </div>
          </div>
        ) : null}
        <button className="btn ghost icon" title="Rename" onClick={() => setEditing(true)}>
          <Pencil size={15} />
        </button>
        <button className="btn ghost icon" title="Open folder" onClick={() => call('shell.openPath', agent.cwd)}>
          <FolderOpen size={15} />
        </button>
        {live ? (
          <button className="btn danger sm" onClick={() => stopAgent(agent)}>
            <Square size={12} /> Stop
          </button>
        ) : canResume(agent) ? (
          <button className="btn sm" onClick={() => resumeAgent(agent)}>
            <History size={13} /> Resume
          </button>
        ) : null}
        {!live ? (
          <button className="btn ghost icon" title="Remove from list" onClick={() => call('agents.remove', agent.id)}>
            <Trash2 size={15} />
          </button>
        ) : null}
        <button className="btn ghost icon" title={showDetails ? 'Hide details' : 'Show details'} onClick={toggleDetails}>
          {showDetails ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
    </div>
  );
}

function TokenRow({ label, value }: { label: string; value: number | undefined }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value === undefined ? '—' : compact(value)}</dd>
    </>
  );
}

function AgentDetails({ agent }: { agent: AgentInfo }) {
  useTicker(5000);
  const t = agent.telemetry;
  const total = t?.totalUsage;
  return (
    <aside className="details">
      <section>
        <h3>Cost</h3>
        <div className="big-number">{usd(t?.cost.reportedUsd ?? t?.cost.totalUsd ?? null)}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {t?.cost.reportedUsd != null
            ? `Claude Code's estimate · list-price estimate ${usd(t.cost.totalUsd)}`
            : t
              ? 'Estimated at API list prices; subscriptions are billed differently'
              : 'Appears after the first response'}
        </div>
        {t?.cost.byModel.length ? (
          <dl className="kv" style={{ marginTop: 10 }}>
            {t.cost.byModel.map((m) => (
              <FragmentRow key={m.model} label={m.model} value={m.usd === null ? 'unpriced' : usd(m.usd, true)} />
            ))}
          </dl>
        ) : null}
      </section>
      {t ? (
        <section>
          <h3>Context window</h3>
          <Meter
            label={`${compact(t.contextUsedTokens)} of ${compact(t.contextWindow)} tokens`}
            value={t.contextPercent}
            foot={t.contextWindowAssumed ? 'Window size assumed from the model; adjust in Settings' : t.source === 'status-line' ? 'Reported by Claude Code' : 'Reported by the CLI'}
          />
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Compactions</dt>
            <dd>
              {t.compactions}
              {t.lastCompactionAt ? ` · ${ago(t.lastCompactionAt)}` : ''}
            </dd>
            <dt>Requests</dt>
            <dd>{compact(t.requests)}</dd>
          </dl>
        </section>
      ) : null}
      {total ? (
        <section>
          <h3>Tokens (session total)</h3>
          <dl className="kv">
            <TokenRow label="Input (uncached)" value={Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens)} />
            <TokenRow label="Cache reads" value={total.cachedInputTokens} />
            <TokenRow label="Cache writes" value={total.cacheWriteInputTokens} />
            <TokenRow label="Output" value={total.outputTokens} />
            {total.reasoningOutputTokens ? <TokenRow label="  of which reasoning" value={total.reasoningOutputTokens} /> : null}
            <TokenRow label="Total" value={total.totalTokens} />
          </dl>
        </section>
      ) : null}
      {t?.limits?.windows.length ? (
        <section>
          <h3>Plan usage</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            {t.limits.windows.map((w) => (
              <Meter key={w.id} label={w.label} value={w.usedPercent} />
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <h3>Session</h3>
        <dl className="kv">
          <dt>Tool</dt>
          <dd>{PROVIDER_LABEL[agent.provider]}</dd>
          <dt>Mode</dt>
          <dd>{agent.mode}</dd>
          <dt>Running</dt>
          <dd>{duration(agent.startedAt, agent.endedAt)}</dd>
          {agent.permission ? (
            <>
              <dt>Permissions</dt>
              <dd>{agent.permission}</dd>
            </>
          ) : null}
          {t?.effort ? (
            <>
              <dt>Effort</dt>
              <dd>{t.effort}</dd>
            </>
          ) : null}
          <dt>Session id</dt>
          <dd className="mono" title={t?.sessionId ?? agent.sessionId ?? ''}>
            {(t?.sessionId ?? agent.sessionId ?? '—').slice(0, 13)}
          </dd>
          {agent.resources ? (
            <>
              <dt>CPU / memory</dt>
              <dd>
                {agent.resources.cpuPercent.toFixed(1)}% · {Math.round(agent.resources.memoryMB)} MB
              </dd>
              <dt>Processes</dt>
              <dd>{agent.resources.processCount}</dd>
            </>
          ) : null}
          {agent.exitCode !== null ? (
            <>
              <dt>Exit code</dt>
              <dd>{agent.exitCode}</dd>
            </>
          ) : null}
        </dl>
        {agent.transcriptPath ? (
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => call('shell.showItem', agent.transcriptPath!)}>
            <FolderOpen size={13} /> Show session file
          </button>
        ) : null}
      </section>
      <section>
        <h3>Command</h3>
        <div className="mono selectable muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
          {agent.commandLine}
        </div>
      </section>
    </aside>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="ellipsis" title={label}>
        {label}
      </dt>
      <dd>{value}</dd>
    </>
  );
}

export function AgentsView() {
  useTicker(15_000);
  const agents = useApp((s) => s.agents);
  const selectedId = useApp((s) => s.selectedAgentId);
  const showDetails = useApp((s) => s.showDetails);
  const openLauncher = useApp((s) => s.openLauncher);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => !q || `${a.title} ${a.cwd} ${a.profileLabel} ${a.model ?? ''}`.toLowerCase().includes(q));
  }, [agents, query]);
  const live = filtered.filter((a) => !a.endedAt);
  const ended = filtered.filter((a) => a.endedAt);
  const selected = agents.find((a) => a.id === selectedId) ?? live[0] ?? null;

  useEffect(() => {
    if (!selectedId && selected) useApp.setState({ selectedAgentId: selected.id });
  }, [selectedId, selected]);

  return (
    <div className={`agents-layout ${selected && showDetails ? 'with-details' : ''}`}>
      <div className="agent-list">
        <div className="agent-list-head">
          <button className="btn primary" onClick={() => openLauncher()}>
            <Plus size={15} /> New agent
          </button>
          <div className="row" style={{ position: 'relative' }}>
            <Search size={14} className="muted" style={{ position: 'absolute', left: 10 }} />
            <input className="input" style={{ paddingLeft: 30, height: 30 }} placeholder="Filter agents" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query ? (
              <button className="btn ghost sm icon" style={{ position: 'absolute', right: 3 }} onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="agent-list-scroll">
          {agents.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 12.5 }}>
              No agents yet. Start one with <span className="kbd">Ctrl</span>+<span className="kbd">N</span>.
            </div>
          ) : null}
          {live.length ? (
            <div className="agent-group">
              <span>Running</span>
              <span>{live.length}</span>
            </div>
          ) : null}
          {live.map((a) => (
            <AgentListItem key={a.id} agent={a} selected={selected?.id === a.id} onSelect={() => useApp.setState({ selectedAgentId: a.id })} />
          ))}
          {ended.length ? (
            <div className="agent-group">
              <span>Recent</span>
              <button className="btn ghost sm" style={{ height: 18, fontSize: 11 }} onClick={() => call('agents.clearFinished')}>
                Clear
              </button>
            </div>
          ) : null}
          {ended.slice(0, 40).map((a) => (
            <AgentListItem key={a.id} agent={a} selected={selected?.id === a.id} onSelect={() => useApp.setState({ selectedAgentId: a.id })} />
          ))}
        </div>
      </div>

      {selected ? (
        <section className="term-panel">
          <AgentHeader agent={selected} />
          {selected.status === 'needs-input' ? (
            <div className="attention-banner">
              <AlertTriangle size={15} color="var(--warning)" />
              <span>
                <strong>Needs your input.</strong> {selected.statusDetail ?? 'Answer the prompt in the terminal below.'}
              </span>
            </div>
          ) : null}
          {selected.usesScreen ? (
            <div className="screen-banner">
              <MousePointer2 size={15} color="var(--warning)" />
              <span>This agent is controlling the mouse and keyboard.</span>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => call('computerUse.command', 'release')}>
                Take back control
              </button>
            </div>
          ) : null}
          {selected.attached ? (
            <TerminalHost key={selected.id} agent={selected} />
          ) : (
            <div className="term-host" style={{ display: 'grid', placeItems: 'center', background: 'var(--surface-1)' }}>
              <Empty
                icon={<History size={22} />}
                title="This agent ran in an earlier session of the app"
                action={
                  canResume(selected) ? (
                    <button className="btn primary" onClick={() => resumeAgent(selected)}>
                      <History size={14} /> Resume conversation
                    </button>
                  ) : undefined
                }
              >
                Its terminal output isn't kept between runs, but the conversation is. Resume it to continue where it left off.
              </Empty>
            </div>
          )}
        </section>
      ) : (
        <section className="term-panel" style={{ display: 'grid', placeItems: 'center' }}>
          <Empty
            icon={<SquareTerminal size={22} />}
            title="Run Claude Code and Codex side by side"
            action={
              <button className="btn primary" onClick={() => openLauncher()}>
                <Plus size={15} /> New agent
              </button>
            }
          >
            Each agent runs in its own terminal with the account you choose. Status, context usage and cost update live, and the task manager shows everything that's running.
          </Empty>
        </section>
      )}
      {selected && showDetails ? <AgentDetails agent={selected} /> : null}
    </div>
  );
}

export function folderLabel(agent: AgentInfo) {
  return folderName(agent.cwd);
}

export function isLive(agent: AgentInfo) {
  return LIVE_STATUSES.includes(agent.status) && !agent.endedAt;
}

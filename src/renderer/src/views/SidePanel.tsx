import { useLayoutEffect, useRef, useState } from 'react';
import { FolderTree, FolderOpen, Gauge, Globe, Loader2, Maximize2, Minimize2, Network, X, type LucideIcon } from 'lucide-react';
import { AGENT_MODES, CONVERSATION_MODES, PROVIDER_LABEL, type AgentInfo } from '@shared/types';
import { runningSubagents } from '@shared/subagents';
import { call } from '../api';
import { useApp, type PanelTab } from '../store';
import { ago, compact, duration, usd } from '../format';
import { Meter, useTicker } from '../ui';
import { BrowserPanel } from './BrowserPanel';
import { FilesPanel } from './FilesPanel';
import { SubagentMapPane } from './SubagentMap';

const TABS: Array<{ id: PanelTab; label: string; icon: LucideIcon; title: string }> = [
  { id: 'subagents', label: 'Subagents', icon: Network, title: 'The subagents this agent started' },
  { id: 'browser', label: 'Browser', icon: Globe, title: "The agent's browser" },
  { id: 'files', label: 'Files', icon: FolderTree, title: 'Project files' },
  { id: 'details', label: 'Details', icon: Gauge, title: 'Cost, context and session details' }
];

function available(agent: AgentInfo, tab: PanelTab) {
  if (tab === 'subagents') return CONVERSATION_MODES.includes(agent.mode) || Boolean(agent.subagents?.length);
  if (tab === 'browser') return AGENT_MODES.includes(agent.mode);
  return true;
}

/** The tab the agent's panel shows: the one last chosen, else what the agent is doing (browsing, running subagents). */
export function usePanelTab(agent: AgentInfo): PanelTab {
  const chosen = useApp((s) => s.panelTab[agent.id]);
  const browsing = useApp((s) => Boolean(s.browsers[agent.id]));
  const tab = chosen ?? (browsing ? 'browser' : runningSubagents(agent) ? 'subagents' : 'details');
  return available(agent, tab) ? tab : 'details';
}

/**
 * Whether the tabs drop their labels: only when the labelled strip doesn't fit, so no label is ever cut off.
 * `deps` are what changes the strip's natural width (which tabs show, their badges).
 */
function useCompactTabs(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  /** The labelled strip's width, measured while it showed. */
  const full = useRef(0);
  useLayoutEffect(() => setCompact(false), deps);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => {
      if (!element.classList.contains('compact')) {
        full.current = element.scrollWidth;
        if (element.scrollWidth > element.clientWidth) setCompact(true);
      } else if (element.clientWidth >= full.current) setCompact(false);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, ...deps]);
  return { ref, compact };
}

/** Beside the conversation: the subagent map, the agent's browser, project files and session details, as tabs. */
export function SidePanel({ agent, expanded, onExpand }: { agent: AgentInfo; expanded: boolean; onExpand?: () => void }) {
  const tab = usePanelTab(agent);
  const browser = useApp((s) => s.browsers[agent.id] ?? null);
  const running = runningSubagents(agent);
  const choose = (id: PanelTab) => useApp.setState({ panelTab: { ...useApp.getState().panelTab, [agent.id]: id } });
  const strip = useCompactTabs([agent.mode, running > 0, Boolean(browser)]);
  return (
    <aside className="side-panel" aria-label="Agent side panel">
      <div className={`sp-tabs ${strip.compact ? 'compact' : ''}`} role="tablist" ref={strip.ref}>
        {TABS.filter((t) => available(agent, t.id)).map(({ id, label, icon: Icon, title }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`sp-tab ${tab === id ? 'on' : ''}`}
            title={title}
            onClick={() => choose(id)}
          >
            {id === 'browser' && browser?.busy ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}
            <span className="sp-tab-label">{label}</span>
            {id === 'subagents' && running ? <span className="sp-badge">{running}</span> : null}
            {id === 'browser' && browser ? <span className="sp-live" title="Open" /> : null}
          </button>
        ))}
        <div className="sp-tabs-end">
          {onExpand ? (
            <button className="btn ghost icon sm" title={expanded ? 'Show the conversation too' : 'Fill the panel'} onClick={onExpand}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          ) : null}
          <button className="btn ghost icon sm" title="Hide the panel" onClick={() => useApp.getState().togglePanel(agent.id)}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="sp-body" role="tabpanel">
        {tab === 'subagents' ? (
          <SubagentMapPane agent={agent} />
        ) : tab === 'browser' ? (
          <BrowserPanel agent={agent} state={browser} />
        ) : tab === 'files' ? (
          <FilesPanel key={agent.id} agent={agent} expanded={expanded} onExpand={onExpand} />
        ) : (
          <AgentDetails agent={agent} />
        )}
      </div>
    </aside>
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
    <div className="sp-pane details" aria-label="Agent details">
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
              <Meter left key={w.id} label={w.label} value={w.usedPercent} />
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
    </div>
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


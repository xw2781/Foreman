import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import type { AgentInfo, SubagentInfo, SubagentStatus } from '@shared/types';
import { runningSubagents, subagentTree, type SubagentBranch as Branch } from '@shared/subagents';
import { isPanelOpen, useApp } from '../store';
import { compact, duration, elapsed, modelLabel } from '../format';
import { ProviderIcon, StatusPill, Switch, useTicker } from '../ui';

/** Subagent statuses drawn with the agent status dots. */
const DOT: Record<SubagentStatus, string> = { running: 'working', done: 'done', failed: 'failed', stopped: 'stopped' };
const LABEL: Record<SubagentStatus, string> = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Composer pill: how many subagents are active; opens the map in the side panel. Absent until the agent starts one. */
export function SubagentPill({ agent }: { agent: AgentInfo }) {
  const open = useApp((s) => isPanelOpen(s, agent.id) && s.panelTab[agent.id] === 'subagents');
  const total = agent.subagents?.length ?? 0;
  if (!total) return null;
  const running = runningSubagents(agent);
  const tooltip = `${running ? `${plural(running, 'subagent')} running, ` : ''}${total} in this conversation. ${open ? 'Hide' : 'Show'} the subagent map.`;
  return (
    <button
      type="button"
      className={`subagent-pill ${running ? 'active' : ''} ${open ? 'on' : ''}`}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => useApp.getState().togglePanel(agent.id, 'subagents')}
    >
      <Network size={12} aria-hidden="true" />
      <span>{running ? `${running} active` : plural(total, 'subagent')}</span>
    </button>
  );
}

function readFinished() {
  try {
    return localStorage.getItem('mapFinished') !== '0';
  } catch {
    return true;
  }
}

/** The agent's subagents as a map: the side panel's Subagents tab. */
export function SubagentMapPane({ agent }: { agent: AgentInfo }) {
  useTicker(1000);
  const [finished, setFinished] = useState(readFinished);
  const nodes = agent.subagents ?? [];
  const running = runningSubagents(agent);
  const toggleFinished = (next: boolean) => {
    setFinished(next);
    try {
      localStorage.setItem('mapFinished', next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="sp-pane subagent-pane">
      <div className="sp-bar">
        <span className="sp-bar-text">{running ? `${running} running · ${nodes.length} total` : plural(nodes.length, 'subagent')}</span>
        <label className="subagent-pane-switch" title="Show subagents that have finished">
          <Switch on={finished} onChange={toggleFinished} />
          <span className="secondary">Finished</span>
        </label>
      </div>
      <div className="subagent-pane-body">
        <AgentTree agent={agent} showFinished={finished} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** Card widths and gaps from chat.css: what a tree needs to lay out side by side. */
const ROOT_CARD = 220;
const SUB_CARD = 260;
const INDENT = 40;

function depth(branches: Branch[]): number {
  return branches.reduce((most, b) => Math.max(most, 1 + depth(b.children)), 0);
}

function AgentTree({ agent, showFinished }: { agent: AgentInfo; showFinished: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const nodes = agent.subagents ?? [];
  const tree = useMemo(() => subagentTree(nodes, (n) => showFinished || n.status === 'running'), [nodes, showFinished]);
  const hidden = showFinished ? 0 : nodes.filter((n) => n.status !== 'running').length;
  // Too deep to fit side by side: children go under their parent instead, so no card is cut off.
  const stacked = width > 0 && width < ROOT_CARD + depth(tree) * (INDENT + SUB_CARD);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`map-tree ${stacked ? 'stacked' : ''}`} ref={ref}>
      <div className="map-branch">
        <div className="map-card agent">
          <div className="map-card-head">
            <ProviderIcon provider={agent.provider} size={18} />
            <span className="map-agent-title">{agent.title}</span>
          </div>
          <StatusPill status={agent.status} detail={agent.statusDetail} />
        </div>
        {tree.length ? <Children branches={tree} /> : null}
      </div>
      {tree.length === 0 ? (
        <div className="map-empty muted">{hidden ? `No subagent is running. ${plural(hidden, 'finished one')} hidden.` : 'No subagents yet.'}</div>
      ) : hidden ? (
        <div className="map-empty muted">{plural(hidden, 'finished subagent')} hidden.</div>
      ) : null}
    </div>
  );
}

function Children({ branches }: { branches: Branch[] }) {
  return (
    <ul className="map-children">
      {branches.map((branch) => (
        <li key={branch.node.id} className={branch.node.status === 'running' ? 'running' : ''}>
          <div className="map-branch">
            <SubagentCard node={branch.node} />
            {branch.children.length ? <Children branches={branch.children} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SubagentCard({ node }: { node: SubagentInfo }) {
  const [open, setOpen] = useState(false);
  const live = node.status === 'running';
  const time = live ? duration(node.startedAt) : node.durationMs !== null ? elapsed(node.durationMs) : duration(node.startedAt, node.endedAt);
  const stats = [
    node.background ? 'background' : null,
    node.toolUses ? plural(node.toolUses, 'tool use') : null,
    node.tokens ? `${compact(node.tokens)} tokens` : null,
    node.model ? modelLabel(node.model) : null
  ].filter(Boolean);
  return (
    <div className={`map-card sub ${node.status}`}>
      <button className="map-card-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the prompt and result' : 'Show the prompt and result'}>
        <span className="map-card-head">
          <span className={`status ${DOT[node.status]}`} title={LABEL[node.status]}>
            <span className="dot" />
          </span>
          <span className="map-kind">{node.kind}</span>
          <span className="map-time num">{time}</span>
          {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
        </span>
        {node.description ? <span className="map-desc">{node.description}</span> : null}
        {live ? <span className="map-activity">{node.activity ?? 'Starting…'}</span> : <span className={`map-outcome ${node.status}`}>{LABEL[node.status]}</span>}
        {stats.length ? <span className="map-card-foot">{stats.join(' · ')}</span> : null}
      </button>
      {open ? (
        <div className="map-card-more">
          {node.prompt ? (
            <>
              <div className="map-more-label">Prompt</div>
              <pre className="map-more-text">{node.prompt}</pre>
            </>
          ) : null}
          {node.result ? (
            <>
              <div className="map-more-label">Result</div>
              <pre className="map-more-text">{node.result}</pre>
            </>
          ) : null}
          {!node.prompt && !node.result ? <div className="muted">Nothing more was reported.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

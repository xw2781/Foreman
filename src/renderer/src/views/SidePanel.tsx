import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeftRight, FolderTree, Gauge, Globe, Loader2, MessageSquareDashed, Network, Plug, X, type LucideIcon } from 'lucide-react';
import { AGENT_MODES, CONVERSATION_MODES, type AgentInfo } from '@shared/types';
import { runningSubagents } from '@shared/subagents';
import { useApp, type PanelTab } from '../store';
import { BrowserPanel } from './BrowserPanel';
import { AgentDetails } from './DetailsPanel';
import { ConnectorsPane, hasConnectors, useConnectorAlerts, useConnectorWatch } from './ConnectorsPanel';
import { FilesPanel } from './FilesPanel';
import { SubagentMapPane } from './SubagentMap';
import { SideChatPane } from './SideChatPanel';
import { sidePending, useSideChats } from '../sideChat';

const TABS: Array<{ id: PanelTab; label: string; icon: LucideIcon; title: string }> = [
  { id: 'subagents', label: 'Subagents', icon: Network, title: 'The subagents this agent started' },
  { id: 'side', label: 'Side chat', icon: MessageSquareDashed, title: "Ask about the conversation without adding to it: the agent isn't interrupted or steered" },
  { id: 'browser', label: 'Browser', icon: Globe, title: "The agent's browser" },
  { id: 'files', label: 'Files', icon: FolderTree, title: 'Project files' },
  { id: 'connectors', label: 'Connectors', icon: Plug, title: 'Connectors this session can use (Microsoft 365, Gmail, Google Drive…) and their sign-in' },
  { id: 'details', label: 'Details', icon: Gauge, title: 'Cost, context and session details' }
];

function available(agent: AgentInfo, tab: PanelTab) {
  if (tab === 'subagents') return CONVERSATION_MODES.includes(agent.mode) || Boolean(agent.subagents?.length);
  if (tab === 'browser') return AGENT_MODES.includes(agent.mode);
  if (tab === 'side') return agent.mode === 'chat';
  if (tab === 'connectors') return hasConnectors(agent);
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

/** Beside the conversation: the subagent map, the agent's browser, project files, connectors and session details, as tabs. */
export function SidePanel({ agent, expanded, onExpand }: { agent: AgentInfo; expanded: boolean; onExpand?: () => void }) {
  const tab = usePanelTab(agent);
  const browser = useApp((s) => s.browsers[agent.id] ?? null);
  const running = runningSubagents(agent);
  const choose = (id: PanelTab) => useApp.setState({ panelTab: { ...useApp.getState().panelTab, [agent.id]: id } });
  const signIn = useConnectorAlerts(agent.id);
  const asking = useSideChats((s) => sidePending(s.chats[agent.id] ?? []));
  useConnectorWatch(agent);
  const strip = useCompactTabs([agent.mode, running > 0, Boolean(browser), signIn > 0]);
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
            {(id === 'browser' && browser?.busy) || (id === 'side' && asking) ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}
            <span className="sp-tab-label">{label}</span>
            {id === 'subagents' && running ? <span className="sp-badge">{running}</span> : null}
            {id === 'browser' && browser ? <span className="sp-live" title="Open" /> : null}
            {id === 'connectors' && signIn ? <span className="sp-badge attention" title={`${signIn} need${signIn === 1 ? 's' : ''} sign-in`}>{signIn}</span> : null}
          </button>
        ))}
        <div className="sp-tabs-end">
          {onExpand ? (
            <button className="btn ghost icon sm" title={expanded ? 'Swap widths back: the conversation gets its column again' : 'Swap widths with the conversation'} aria-label="Swap widths with the conversation" aria-pressed={expanded} onClick={onExpand}>
              <ArrowLeftRight size={14} />
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
        ) : tab === 'side' ? (
          <SideChatPane agent={agent} />
        ) : tab === 'browser' ? (
          <BrowserPanel agent={agent} state={browser} />
        ) : tab === 'connectors' ? (
          <ConnectorsPane agent={agent} />
        ) : tab === 'files' ? (
          <FilesPanel key={agent.id} agent={agent} expanded={expanded} onExpand={onExpand} />
        ) : (
          <AgentDetails agent={agent} />
        )}
      </div>
    </aside>
  );
}

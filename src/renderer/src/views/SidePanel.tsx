import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, Check, Eye, FolderTree, Gauge, GitBranch, Globe, Loader2, MessageSquareDashed, Network, Plug, X, type LucideIcon } from 'lucide-react';
import { AGENT_MODES, CONVERSATION_MODES, type AgentInfo } from '@shared/types';
import { runningSubagents } from '@shared/subagents';
import { useApp, type PanelTab } from '../store';
import { BrowserPanel } from './BrowserPanel';
import { AgentDetails } from './DetailsPanel';
import { ConnectorsPane, hasConnectors, useConnectorAlerts, useConnectorWatch } from './ConnectorsPanel';
import { FilesPanel } from './FilesPanel';
import { GitPanel, useGitChangeCount } from './GitPanel';
import { SubagentMapPane } from './SubagentMap';
import { SideChatPane } from './SideChatPanel';
import { sidePending, useSideChats } from '../sideChat';
import { useWheelStep } from '../ui';

/** `note` is the second line of each tab's hover card. */
const TABS: Array<{ id: PanelTab; label: string; icon: LucideIcon; note: string }> = [
  { id: 'subagents', label: 'Subagents', icon: Network, note: 'Map of the subagents this agent started, and what each is doing' },
  { id: 'side', label: 'Side chat', icon: MessageSquareDashed, note: "Ask about the conversation without adding to it. The agent isn't interrupted or steered" },
  { id: 'browser', label: 'Browser', icon: Globe, note: "The agent's own browser, live. You can take control at any time" },
  { id: 'files', label: 'Files', icon: FolderTree, note: 'The project folder, with a preview of each file' },
  { id: 'git', label: 'Git', icon: GitBranch, note: 'Branch, uncommitted changes, commits not pushed yet, and worktrees' },
  { id: 'connectors', label: 'Connectors', icon: Plug, note: 'Microsoft 365, Gmail, Google Drive and the other connectors this session can use, with their sign-in' },
  { id: 'details', label: 'Details', icon: Gauge, note: 'Cost, context window, tokens and session info' }
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function available(agent: AgentInfo, tab: PanelTab) {
  if (tab === 'subagents') return CONVERSATION_MODES.includes(agent.mode) || Boolean(agent.subagents?.length);
  if (tab === 'browser') return AGENT_MODES.includes(agent.mode);
  if (tab === 'side') return agent.mode === 'chat';
  if (tab === 'connectors') return hasConnectors(agent);
  if (tab === 'git') return !agent.projectless;
  return true;
}

/** A tab that's in the strip: offered for this agent and not hidden by the person. */
function shown(agent: AgentInfo, tab: PanelTab, hidden: PanelTab[]) {
  return available(agent, tab) && !hidden.includes(tab);
}

/**
 * The tab the agent's panel shows: the one last chosen (even a hidden one, when something opened it on
 * purpose), else what the agent is doing (browsing, running subagents), else the first tab in the strip.
 */
export function usePanelTab(agent: AgentInfo): PanelTab {
  const chosen = useApp((s) => s.panelTab[agent.id]);
  const browsing = useApp((s) => Boolean(s.browsers[agent.id]));
  const hidden = useApp((s) => s.panelHiddenTabs);
  if (chosen && available(agent, chosen)) return chosen;
  const preferred: PanelTab[] = [...(browsing ? ['browser' as const] : []), ...(runningSubagents(agent) ? ['subagents' as const] : []), 'details'];
  return preferred.find((t) => shown(agent, t, hidden)) ?? TABS.find((t) => shown(agent, t.id, hidden))?.id ?? 'details';
}

/** Right-click on the tab strip: which tabs it shows. Saved on this computer. */
function TabsMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const hidden = useApp((s) => s.panelHiddenTabs);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPlace({ left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)) });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [at]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const visible = TABS.filter((t) => !hidden.includes(t.id)).length;
  const toggle = (id: PanelTab) => useApp.getState().setPanelTabHidden(id, !hidden.includes(id));
  return createPortal(
    <div ref={menu} className="popover sp-tabs-menu" role="menu" aria-label="Side panel tabs" style={place}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
      <div className="pop-title">Show in the panel</div>
      {TABS.map(({ id, label, icon: Icon }) => {
        const on = !hidden.includes(id);
        const last = on && visible === 1;
        return (
          <button key={id} type="button" className="pop-item sp-tabs-menu-item" role="menuitemcheckbox" aria-checked={on} disabled={last}
            title={last ? 'At least one tab stays in the strip' : undefined} onClick={() => toggle(id)}>
            <span className="sp-tabs-menu-check">{on ? <Check size={13} /> : null}</span>
            <Icon size={14} />
            <span>{label}</span>
          </button>
        );
      })}
      {hidden.length ? (
        <>
          <div className="sp-tabs-menu-sep" role="separator" />
          <button type="button" className="pop-item sp-tabs-menu-item" role="menuitem"
            onClick={() => { for (const id of hidden) useApp.getState().setPanelTabHidden(id, false); onClose(); }}>
            <span className="sp-tabs-menu-check" />
            <Eye size={14} />
            <span>Show all tabs</span>
          </button>
        </>
      ) : null}
    </div>,
    document.body
  );
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
  const changes = useGitChangeCount(agent.id);
  const hidden = useApp((s) => s.panelHiddenTabs);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useConnectorWatch(agent);
  const tabs = TABS.filter((t) => available(agent, t.id) && (!hidden.includes(t.id) || t.id === tab));
  const strip = useCompactTabs([agent.mode, running > 0, Boolean(browser), signIn > 0, changes > 0, tabs.map((t) => t.id).join()]);
  // The wheel over the strip steps through its tabs, like the nav rail steps through pages.
  const onWheel = useWheelStep((step) => {
    const index = tabs.findIndex((t) => t.id === tab);
    const next = tabs[index + step];
    if (next) choose(next.id);
  });
  /** What the tab is doing right now, shown after its name in the hover card. */
  const state = (id: PanelTab): string | null => {
    if (id === 'subagents' && running) return `${running} running`;
    if (id === 'side' && asking) return 'answering';
    if (id === 'browser' && browser) return browser.paused ? 'you have control' : browser.busy ? 'working' : `open, ${plural(browser.tabs.length, 'tab')}`;
    if (id === 'git' && changes) return plural(changes, 'changed file');
    if (id === 'connectors' && signIn) return `${signIn} need${signIn === 1 ? 's' : ''} sign-in`;
    return null;
  };
  return (
    <aside className="side-panel" aria-label="Agent side panel">
      <div className={`sp-tabs ${strip.compact ? 'compact' : ''}`} role="tablist" ref={strip.ref} onWheel={onWheel}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
        {tabs.map(({ id, label, icon: Icon, note }) => {
          const now = state(id);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-label={now ? `${label}, ${now}` : label}
              className={`sp-tab ${tab === id ? 'on' : ''}`}
              data-tip={now ? `${label} · ${now}` : label}
              data-tip-note={note}
              onClick={() => choose(id)}
            >
              {(id === 'browser' && browser?.busy) || (id === 'side' && asking) ? <Loader2 size={14} className="spin" /> : <Icon size={14} />}
              <span className="sp-tab-label">{label}</span>
              {id === 'subagents' && running ? <span className="sp-badge">{running}</span> : null}
              {id === 'browser' && browser ? <span className="sp-live" /> : null}
              {id === 'git' && changes ? <span className="sp-badge">{changes > 99 ? '99+' : changes}</span> : null}
              {id === 'connectors' && signIn ? <span className="sp-badge attention">{signIn}</span> : null}
            </button>
          );
        })}
        <div className="sp-tabs-end">
          {onExpand ? (
            <button className="btn ghost icon sm" aria-label="Swap widths with the conversation" aria-pressed={expanded} onClick={onExpand}
              data-tip={expanded ? 'Swap widths back' : 'Swap widths'}
              data-tip-note={expanded ? 'The conversation gets its wide column again' : 'Give the panel the wide column and the conversation the narrow one'}>
              <ArrowLeftRight size={14} />
            </button>
          ) : null}
          <button className="btn ghost icon sm" aria-label="Hide the panel" data-tip="Hide the panel" onClick={() => useApp.getState().togglePanel(agent.id)}>
            <X size={15} />
          </button>
        </div>
      </div>
      {menu ? <TabsMenu at={menu} onClose={() => setMenu(null)} /> : null}
      <div className="sp-body" role="tabpanel">
        {tab === 'subagents' ? (
          <SubagentMapPane agent={agent} />
        ) : tab === 'side' ? (
          <SideChatPane agent={agent} />
        ) : tab === 'browser' ? (
          <BrowserPanel agent={agent} state={browser} />
        ) : tab === 'connectors' ? (
          <ConnectorsPane agent={agent} />
        ) : tab === 'git' ? (
          <GitPanel agent={agent} expanded={expanded} onExpand={onExpand} />
        ) : tab === 'files' ? (
          <FilesPanel key={agent.id} agent={agent} expanded={expanded} onExpand={onExpand} />
        ) : (
          <AgentDetails agent={agent} />
        )}
      </div>
    </aside>
  );
}

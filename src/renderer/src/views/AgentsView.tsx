import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FolderPlus,
  List,
  PanelLeftClose,
  Rows3,
  FolderOpen,
  GitFork,
  Globe,
  MessageSquareDashed,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Network,
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
import { LIVE_STATUSES, type AgentInfo } from '@shared/types';
import { ChatView } from './ChatView';
import { PromptCacheBadge } from '../PromptCacheBadge';
import { SidePanel, usePanelTab } from './SidePanel';
import { backgroundWork, describeSubagents, runningSubagents } from '@shared/subagents';
import { call, errorMessage } from '../api';
import { isPanelOpen, useApp } from '../store';
import { compact, folderName, modelLabel, usd } from '../format';
import { AccountChip, AgentStatusPill, ContextMenu, Empty, MiniMeter, ProviderIcon, RunningSpinner, confirmDialog, fitRow, unfitRow, useTicker } from '../ui';
import { mountTerminal, terminalBackground } from '../terminals';
import { groupAgentsByProject, projectKey } from '../agentProjects';
import { hasUnreadCompletion } from '../sessionUnread';
import { forkAgent } from '../sideChat';

export async function stopAgent(agent: AgentInfo) {
  const settings = useApp.getState().settings;
  if (settings?.confirmBeforeStop && agent.mode === 'chat') {
    const { ok } = await confirmDialog({
      title: `Stop "${agent.title}"?`,
      message: 'The process is ended. The conversation is kept; send a message to continue it.',
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
  return agent.mode === 'chat' && Boolean(agent.transcriptPath || agent.telemetry?.sessionId);
}

export async function resumeAgent(agent: AgentInfo) {
  try {
    const next = await call('agents.resume', agent.id);
    useApp.setState({ selectedAgentId: next.id, view: 'agents' });
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
  }
}

type Display = 'chat' | 'terminal';

/** Agents are chats; a sign-in or an account shell is a terminal. */
function displayOf(agent: AgentInfo): Display {
  return agent.mode === 'chat' ? 'chat' : 'terminal';
}

/** A simple archive box, using the same outline weight as the toolbar icons. */
function SessionArchiveIcon({ restore = false }: { restore?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      {restore ? <path d="M12 17v-6m-3 3 3-3 3 3" /> : <path d="M10 12h4" />}
    </svg>
  );
}

function AgentListItem({ agent, selected, onSelect, archived = false, onToggleArchived }: { agent: AgentInfo; selected: boolean; onSelect: () => void; archived?: boolean; onToggleArchived: () => void }) {
  const t = agent.telemetry;
  const browser = useApp((s) => s.browsers[agent.id]);
  const unread = useApp((state) => hasUnreadCompletion(agent, state.readCompletions));
  const subagents = runningSubagents(agent);
  const compactRow = useApp((s) => s.agentListCompact);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.title);
  const rename = async () => {
    setEditing(false);
    if (name.trim() && name.trim() !== agent.title) await call('agents.rename', agent.id, name.trim());
  };
  return (
    <div className={`agent-item ${compactRow ? 'compact' : ''} ${selected ? 'on' : ''} ${unread ? 'unread' : ''} ${agent.status === 'needs-input' ? 'attention' : ''}`} onClick={onSelect}>
      {unread ? <span className="ai-unread" role="status" aria-label="Completed, unread" title="Completed, unread" /> : null}
      {compactRow
        ? (agent.status === 'working' && !agent.endedAt) || backgroundWork(agent) ? <RunningSpinner size={13} className="ai-spinner" /> : null
        : <ProviderIcon provider={agent.provider} size={24} />}
      {editing ? (
        <input
          className="input ai-rename"
          value={name}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <div
          className="ai-title"
          title={`${agent.title}\nDouble-click to rename`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setName(agent.title);
            setEditing(true);
          }}
        >
          {agent.title}
        </div>
      )}
      <button
        type="button"
        className="btn ghost icon ai-archive"
        title={archived ? 'Unarchive session' : 'Archive session'}
        aria-label={archived ? `Unarchive ${agent.title}` : `Archive ${agent.title}`}
        onClick={(e) => { e.stopPropagation(); onToggleArchived(); }}
      >
        <SessionArchiveIcon restore={archived} />
      </button>
      {compactRow ? null : <div className="ai-meta">
        {/* A stopped session says nothing: most of the list is stopped, so only live states are marked. */}
        {agent.status === 'stopped' && !backgroundWork(agent) ? null : (
          <AgentStatusPill agent={agent} detail={false} spinner label={agent.status === 'working' && !agent.endedAt ? 'Running' : undefined} />
        )}
        {agent.mode === 'chat' ? <PromptCacheBadge agent={agent} iconOnly /> : null}
        {agent.usesScreen ? <MousePointer2 size={12} color="var(--warning)" /> : null}
        {browser ? <Globe size={12} color={browser.busy ? 'var(--accent-strong)' : 'var(--text-muted)'} aria-label="Has a browser open" /> : null}
        {subagents ? (
          <span className="ai-subagents" title={`${describeSubagents(agent)} running`}>
            <Network size={12} /> {subagents}
          </span>
        ) : null}
        <span className="ellipsis">{agent.mode === 'chat' ? agent.profileLabel : agent.mode}</span>
        {t?.cost.totalUsd != null ? <span style={{ marginLeft: 'auto' }} className="num ai-cost">{usd(t.cost.reportedUsd ?? t.cost.totalUsd)}</span> : null}
      </div>}
      {!compactRow && t && t.contextPercent !== null && agent.mode !== 'shell' ? (
        <div className={agent.status === 'working' && !agent.endedAt ? 'ai-context running' : 'ai-context'} style={{ gridColumn: 2 }}>
          <MiniMeter value={t.contextPercent} title={`Context ${compact(t.contextUsedTokens)} / ${compact(t.contextWindow)}`} />
        </div>
      ) : null}
    </div>
  );
}

/** Right-click on the session list: how it shows sessions. Saved on this computer. */
function ListMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const compactRows = useApp((s) => s.agentListCompact);
  const choose = (compact: boolean) => {
    useApp.getState().setAgentListCompact(compact);
    onClose();
  };
  return (
    <ContextMenu at={at} label="Session list" onClose={onClose} className="agent-list-menu">
      <div className="pop-title">Session list</div>
      <button type="button" className="pop-item menu-item" role="menuitemradio" aria-checked={!compactRows} onClick={() => choose(false)}
        title="Status, account, cost and context for each session">
        <span className="menu-check">{compactRows ? null : <Check size={13} />}</span>
        <Rows3 size={14} />
        <span>Detailed</span>
      </button>
      <button type="button" className="pop-item menu-item" role="menuitemradio" aria-checked={compactRows} onClick={() => choose(true)}
        title="One line per session">
        <span className="menu-check">{compactRows ? <Check size={13} /> : null}</span>
        <List size={14} />
        <span>Compact</span>
      </button>
      <div className="menu-sep" role="separator" />
      <button type="button" className="pop-item menu-item" role="menuitem" onClick={() => { useApp.getState().toggleAgentList(); onClose(); }}>
        <span className="menu-check" />
        <PanelLeftClose size={14} />
        <span>Hide session list</span>
        <span className="kbd">Ctrl 1</span>
      </button>
    </ContextMenu>
  );
}

function ProjectMenu({ path, label, onRemove }: { path: string; label: string; onRemove: (path: string) => void }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const close = () => setPosition(null);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position]);
  return (
    <>
      <button ref={trigger} type="button" className="btn ghost sm icon agent-project-menu"
        aria-label={`Project options for ${label}`} title="Project options" aria-haspopup="menu" aria-expanded={!!position}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition(position ? null : { top: Math.min(rect.bottom + 4, window.innerHeight - 64), left: Math.max(8, rect.right - 200) });
        }}>
        <MoreHorizontal size={14} />
      </button>
      {position ? createPortal(
        <div ref={menu} className="popover agent-project-popover" role="menu" aria-label={`Options for ${label}`} style={position}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault();
              event.stopPropagation();
              setPosition(null);
              trigger.current?.focus();
            }
          }}>
          <button type="button" className="pop-item" role="menuitem" onClick={() => { setPosition(null); onRemove(path); }}>
            <Trash2 size={14} /><span>Remove project</span>
          </button>
        </div>, document.body
      ) : null}
    </>
  );
}

function ProjectSessions({ agents, selectedId, archived = false, projectFolders = [], hiddenProjectFolders = [], onToggleArchived, onRemoveProject }: {
  agents: AgentInfo[]; selectedId?: string; archived?: boolean; projectFolders?: string[]; onToggleArchived: (id: string) => void;
  hiddenProjectFolders?: string[]; onRemoveProject?: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const openLauncher = useApp((state) => state.openLauncher);
  const projects = groupAgentsByProject(agents, projectFolders, hiddenProjectFolders);
  if (!archived && !projects.some((project) => project.key === 'no-project')) {
    projects.push({ key: 'no-project', path: '', label: 'This Computer', agents: [] });
  }
  return projects.map((project) => (
    <Fragment key={project.key}>
      <details className="agent-project" open={!collapsed.has(project.key)} onToggle={(event) => {
        const open = event.currentTarget.open;
        setCollapsed((previous) => {
          if (previous.has(project.key) === !open) return previous;
          const next = new Set(previous);
          if (open) next.delete(project.key);
          else next.add(project.key);
          return next;
        });
      }}>
        <summary className="agent-project-heading" title={project.path || 'Standalone conversations'}>
          {project.key === 'no-project' ? <Monitor size={12} /> : <FolderOpen size={12} />}
          <span className="ellipsis">{project.label}</span>
          <ChevronRight size={13} className="agent-project-chevron" aria-hidden="true" />
          <button
            type="button"
            className="btn ghost sm icon agent-project-add"
            aria-label={project.path ? `New session in ${project.label}` : 'New session without a project'}
            title={project.path ? `New session in ${project.label}` : 'New session without a project'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openLauncher({ cwd: project.path, projectless: !project.path });
            }}
          >
            <Plus size={14} />
          </button>
          {project.path && onRemoveProject ? <ProjectMenu path={project.path} label={project.label} onRemove={onRemoveProject} /> : null}
        </summary>
        {project.path && !project.agents.length ? <div className="agent-project-empty">No sessions yet</div> : null}
        {project.agents.map((agent) => (
          <AgentListItem key={agent.id} agent={agent} archived={archived} selected={selectedId === agent.id}
            onSelect={() => useApp.setState({ selectedAgentId: agent.id })} onToggleArchived={() => onToggleArchived(agent.id)} />
        ))}
      </details>
    </Fragment>
  ));
}

function TerminalHost({ agent }: { agent: AgentInfo }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    return mountTerminal(agent.id, agent.provider, hostRef.current);
  }, [agent.id, agent.provider]);
  return <div className="term-host" ref={hostRef} style={{ ['--term-bg' as any]: terminalBackground() }} />;
}

/**
 * Puts the title and its details on one line when both fit there whole, otherwise stacks them;
 * then leaves out what still doesn't fit, as useFit does, in the header row and in the details.
 */
function useHeaderLayout(deps: unknown[]) {
  const row = useRef<HTMLDivElement>(null);
  const meta = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const header = row.current;
    const details = meta.current;
    if (!header || !details) return;
    const fits = (el: Element | null) => !el || el.scrollWidth <= el.clientWidth;
    let width = -1;
    const layout = () => {
      header.dataset.layout = 'inline';
      unfitRow(header);
      unfitRow(details);
      if (!fits(details) || !fits(header.querySelector('.th-title > .name'))) header.dataset.layout = 'stacked';
      fitRow(header);
      fitRow(details);
    };
    layout();
    // Switching layouts changes only the height, so reacting to width alone can't loop.
    const observer = new ResizeObserver(() => {
      if (header.clientWidth === width) return;
      width = header.clientWidth;
      layout();
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, deps);
  return { row, meta };
}

function AgentHeader({ agent, display }: { agent: AgentInfo; display: Display }) {
  const panelOpen = useApp((s) => isPanelOpen(s, agent.id));
  const panelTab = usePanelTab(agent);
  const forkSource = useApp((s) => (agent.forkedFrom ? s.agents.find((a) => a.id === agent.forkedFrom!.agentId) ?? null : null));
  const [forking, setForking] = useState(false);
  const fork = async () => {
    setForking(true);
    await forkAgent(agent);
    setForking(false);
  };
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.title);
  useEffect(() => setName(agent.title), [agent.title]);
  const live = !agent.endedAt;
  const t = agent.telemetry;
  const model = t?.model ?? agent.model;
  const { row, meta } = useHeaderLayout([agent.id, agent.title, agent.profileLabel, agent.cwd, agent.forkedFrom, forkSource?.title, model, display, panelOpen, live, editing, t?.contextPercent != null]);
  const rename = async () => {
    setEditing(false);
    if (name.trim() && name !== agent.title) await call('agents.rename', agent.id, name.trim());
  };
  return (
    <div className="term-header" ref={row}>
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
          <div className="name" title={`${agent.title}\nDouble-click to rename`} onDoubleClick={() => setEditing(true)}>
            {agent.title}
          </div>
        )}
        <div className="meta" ref={meta}>
          <span data-fit="2">
            <AccountChip label={agent.profileLabel} color={agent.profileColor} />
          </span>
          {model ? (
            <span className="badge" data-fit="1" title={model}>
              {modelLabel(model)}
            </span>
          ) : null}
          <span
            className="mono"
            data-fit="3"
            data-tip={agent.projectless ? 'Standalone conversation' : 'Project folder'}
            data-tip-note={agent.projectless ? undefined : agent.cwd}
            data-tip-note-path={agent.projectless ? undefined : 'true'}
            tabIndex={0}
          >
            {agent.projectless ? 'No project' : folderName(agent.cwd)}
          </span>
          {agent.forkedFrom ? (
            <button
              type="button"
              className="th-forked"
              data-fit="2"
              data-tip={forkSource ? 'Open the chat this was forked from' : 'Forked from a chat no longer in the list'}
              disabled={!forkSource}
              onClick={() => forkSource && useApp.getState().selectAgent(forkSource.id)}
            >
              <GitFork size={12} />
              <span className="ellipsis">{forkSource?.title ?? agent.forkedFrom.title}</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="th-actions">
        {agent.mode === 'chat' ? (
          <button
            className="btn ghost icon"
            data-fit="1"
            data-tip="Fork"
            data-tip-note="A new chat that continues from a copy of this conversation. To fork from an earlier point, use the button beside one of your messages"
            aria-label="Fork this conversation"
            disabled={forking}
            onClick={() => void fork()}
          >
            <GitFork size={15} />
          </button>
        ) : null}
        {agent.mode === 'chat' ? (
          <button
            className={`btn ghost icon ${panelOpen && panelTab === 'side' ? 'on' : ''}`}
            data-fit="1"
            data-tip="Side chat"
            data-tip-note="Ask about the conversation without adding to it (or type /btw in the message box)"
            aria-label="Side chat"
            onClick={() => useApp.getState().togglePanel(agent.id, 'side')}
          >
            <MessageSquareDashed size={15} />
          </button>
        ) : null}
        <button className="btn ghost icon" data-fit="2" data-tip="Rename" aria-label="Rename" onClick={() => setEditing(true)}>
          <Pencil size={15} />
        </button>
        <button
          className="btn ghost icon"
          data-fit="1"
          data-tip={agent.projectless ? 'Open chat files' : 'Open folder'}
          data-tip-note={agent.projectless ? undefined : agent.cwd}
          aria-label={agent.projectless ? 'Open chat files' : 'Open folder'}
          onClick={() => call('shell.openPath', agent.cwd)}
        >
          <FolderOpen size={15} />
        </button>
        {/* A chat stops from its composer; a sign-in or shell has none. */}
        {live && display !== 'chat' ? (
          <button className="btn danger sm" onClick={() => stopAgent(agent)}>
            <Square size={12} /> Stop
          </button>
        ) : null}
        {!live ? (
          <button className="btn ghost icon" data-tip="Remove from list" data-tip-note="Its transcript stays on disk" aria-label="Remove from list" onClick={() => call('agents.remove', agent.id)}>
            <Trash2 size={15} />
          </button>
        ) : null}
        <button
          className={`btn ghost icon ${panelOpen ? 'on' : ''}`}
          data-tip={panelOpen ? 'Hide side panel' : 'Show side panel'}
          data-tip-note={panelOpen ? undefined : 'Subagents, browser, files and details'}
          aria-label={panelOpen ? 'Hide side panel' : 'Show side panel'}
          aria-pressed={panelOpen}
          onClick={() => useApp.getState().togglePanel(agent.id)}
        >
          {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>
    </div>
  );
}

/**
 * The conversation beside the side panel, with a divider to drag; "expanded" swaps their widths so the panel
 * gets the conversation's share. In a narrow window the panel takes it all.
 */
function AgentWork({ agent, children }: { agent: AgentInfo; children: React.ReactNode }) {
  const shown = useApp((s) => isPanelOpen(s, agent.id));
  const expanded = useApp((s) => s.panelExpanded);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [share, setShare] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('sidePanelShare') ?? localStorage.getItem('browserShare'));
      return saved > 0.2 && saved < 0.8 ? saved : 0.42;
    } catch {
      return 0.42;
    }
  });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const narrow = width > 0 && width < 760;
  const full = shown && narrow;
  const swapped = shown && expanded && !narrow;
  /** The panel's share of the width (`share` is its share when not swapped). */
  const side = swapped ? 1 - share : share;
  const drag = (event: React.PointerEvent) => {
    const element = box.current;
    if (!element) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const panel = Math.min(0.75, Math.max(0.25, (bounds.right - e.clientX) / bounds.width));
      const next = swapped ? 1 - panel : panel;
      setShare(next);
      try {
        localStorage.setItem('sidePanelShare', String(next));
      } catch {
        /* storage unavailable */
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging-split');
    };
    document.body.classList.add('dragging-split');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="agent-work" ref={box}>
      <div className="agent-main" hidden={full}>
        {children}
      </div>
      {shown && !full ? <div className="split-handle" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown={drag} /> : null}
      {shown ? (
        <div className="agent-side" style={full ? { flex: 1 } : { width: `${side * 100}%` }}>
          <SidePanel agent={agent} expanded={full || swapped} onExpand={narrow ? undefined : () => useApp.setState({ panelExpanded: !expanded })} />
        </div>
      ) : null}
    </div>
  );
}

export function AgentsView() {
  useTicker(15_000);
  const agents = useApp((s) => s.agents);
  const selectedId = useApp((s) => s.selectedAgentId);
  const openLauncher = useApp((s) => s.openLauncher);
  const projectFolders = useApp((state) => state.settings?.projectFolders);
  const hiddenProjectFolders = useApp((state) => state.settings?.hiddenProjectFolders);
  const [addingProject, setAddingProject] = useState(false);
  const addProject = async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      const folder = await call('dialog.pickDirectory');
      if (!folder) return;
      const previous = useApp.getState().settings?.projectFolders ?? [];
      const next = [folder, ...previous.filter((item) => projectKey(item) !== projectKey(folder))];
      const hidden = useApp.getState().settings?.hiddenProjectFolders ?? [];
      const settings = await call('settings.update', {
        projectFolders: next,
        hiddenProjectFolders: hidden.filter((item) => projectKey(item) !== projectKey(folder))
      });
      useApp.setState({ settings });
      setQuery('');
    } catch (error) {
      useApp.getState().toast('error', errorMessage(error));
    } finally {
      setAddingProject(false);
    }
  };
  const removeProject = async (folder: string) => {
    try {
      const current = useApp.getState();
      const key = projectKey(folder);
      const hidden = current.settings?.hiddenProjectFolders ?? [];
      const settings = await call('settings.update', {
        projectFolders: (current.settings?.projectFolders ?? []).filter((item) => projectKey(item) !== key),
        hiddenProjectFolders: [...hidden.filter((item) => projectKey(item) !== key), folder]
      });
      const selected = useApp.getState().agents.find((agent) => agent.id === useApp.getState().selectedAgentId);
      useApp.setState({ settings, ...(selected && !selected.projectless && projectKey(selected.cwd) === key ? { selectedAgentId: null } : {}) });
    } catch (error) {
      useApp.getState().toast('error', errorMessage(error));
    }
  };
  const [query, setQuery] = useState('');
  const [archivedIds, setArchivedIds] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('archivedAgentIds') ?? localStorage.getItem('hiddenAgentIds') ?? '[]');
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const [listWidth, setListWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('agentListWidth'));
      return saved >= 220 && saved <= 480 ? saved : 290;
    } catch { return 290; }
  });
  const listRef = useRef<HTMLDivElement>(null);
  const listCollapsed = useApp((s) => s.agentListCollapsed);
  const [listMenu, setListMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('archivedAgentIds', JSON.stringify(archivedIds));
      localStorage.removeItem('hiddenAgentIds');
    } catch { /* Storage unavailable. */ }
    // Keep-warm only refreshes chats still in the list.
    call('agents.setArchived', archivedIds).catch(() => {});
  }, [archivedIds]);
  useEffect(() => {
    try { localStorage.setItem('agentListWidth', String(listWidth)); } catch { /* Storage unavailable. */ }
  }, [listWidth]);
  const toggleArchived = (id: string) => setArchivedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const resizeList = (width: number) => setListWidth(Math.min(480, Math.max(220, width)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hidden = new Set((hiddenProjectFolders ?? []).map(projectKey));
    return agents.filter((a) => (a.projectless || !hidden.has(projectKey(a.cwd))) && (!q || `${a.title} ${a.cwd} ${a.profileLabel} ${a.model ?? ''}`.toLowerCase().includes(q)));
  }, [agents, query, hiddenProjectFolders]);
  const live = filtered.filter((a) => !a.endedAt && !archivedIds.includes(a.id));
  const visible = filtered.filter((a) => !archivedIds.includes(a.id));
  const archived = filtered.filter((a) => archivedIds.includes(a.id));
  const selected = agents.find((a) => a.id === selectedId) ?? live[0] ?? null;
  const display = selected ? displayOf(selected) : 'terminal';

  useEffect(() => {
    if (!selectedId && selected) useApp.setState({ selectedAgentId: selected.id });
  }, [selectedId, selected]);

  return (
    <div className={`agents-layout ${listCollapsed ? 'list-collapsed' : ''}`} style={{ ['--agent-list-width' as string]: `${listWidth}px` }}>
      <div className="agent-list" ref={listRef} hidden={listCollapsed}
        onContextMenu={(event) => {
          // Text fields keep their own menu.
          if ((event.target as HTMLElement).closest('input, textarea')) return;
          event.preventDefault();
          setListMenu({ x: event.clientX, y: event.clientY });
        }}>
        {listMenu ? <ListMenu at={listMenu} onClose={() => setListMenu(null)} /> : null}
        <div className="agent-list-head">
          <div className="al-search-row">
            <label className="al-search">
              <Search size={16} />
              <input placeholder="Search" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} />
              {query ? (
                <button type="button" className="btn ghost sm icon" aria-label="Clear search" onClick={() => setQuery('')}>
                  <X size={13} />
                </button>
              ) : null}
            </label>
            <button type="button" className="btn ghost icon al-hide" aria-label="Hide session list" title="Hide session list (Ctrl+1)"
              onClick={() => useApp.getState().toggleAgentList()}>
              <PanelLeftClose size={16} />
            </button>
          </div>
          <button type="button" className="al-action" onClick={() => openLauncher()}>
            <Plus size={16} />
            <span>New session</span>
            <span className="kbd">Ctrl N</span>
          </button>
          <button type="button" className="al-action" disabled={addingProject} onClick={addProject}>
            <FolderPlus size={16} />
            <span>New project</span>
          </button>
        </div>
        <div className="agent-list-scroll">
          {agents.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 12.5 }}>
              No agents yet. Start one with <span className="kbd">Ctrl</span>+<span className="kbd">N</span>.
            </div>
          ) : null}
          <ProjectSessions agents={visible} selectedId={selected?.id}
            projectFolders={(projectFolders ?? []).filter((folder) => !query.trim() || folder.toLowerCase().includes(query.trim().toLowerCase()))}
            hiddenProjectFolders={hiddenProjectFolders} onRemoveProject={removeProject}
            onToggleArchived={toggleArchived} />
          {archived.length ? (
            <details className="archived-agents">
              <summary>Archived ({archived.length})</summary>
              <ProjectSessions agents={archived} archived selectedId={selected?.id} hiddenProjectFolders={hiddenProjectFolders}
                onRemoveProject={removeProject} onToggleArchived={toggleArchived} />
            </details>
          ) : null}
        </div>
        <div
          className="agent-list-resize"
          role="separator"
          aria-label="Resize session list"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={480}
          aria-valuenow={listWidth}
          tabIndex={0}
          title="Drag to resize; double-click to reset"
          onDoubleClick={() => setListWidth(290)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId) && listRef.current) {
              resizeList(e.clientX - listRef.current.getBoundingClientRect().left);
            }
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              resizeList(listWidth + (e.key === 'ArrowRight' ? 10 : -10));
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              resizeList(e.key === 'Home' ? 220 : 480);
            }
          }}
        />
      </div>

      {selected ? (
        <section className="term-panel">
          <AgentHeader agent={selected} display={display} />
          {selected.status === 'needs-input' && display === 'terminal' ? (
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
          <AgentWork agent={selected}>
          {display === 'chat' ? (
            <ChatView key={selected.id} agent={selected} />
          ) : (
            <TerminalHost key={`${selected.id}:${selected.runId}`} agent={selected} />
          )}
          </AgentWork>
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
            Chat with an agent under the account you choose. Status, context usage and cost update live, and the task manager shows everything that's running.
          </Empty>
        </section>
      )}
    </div>
  );
}

export function folderLabel(agent: AgentInfo) {
  return agent.projectless ? 'No project' : folderName(agent.cwd);
}

export function isLive(agent: AgentInfo) {
  return LIVE_STATUSES.includes(agent.status) && !agent.endedAt;
}

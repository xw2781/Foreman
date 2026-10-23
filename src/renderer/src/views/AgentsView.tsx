import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  FolderPlus,
  Globe,
  History,
  MessagesSquare,
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
import { create } from 'zustand';
import { AGENT_MODES, CONVERSATION_MODES, LIVE_STATUSES, type AgentInfo, type AgentMode } from '@shared/types';
import { ChatView } from './ChatView';
import { PromptCacheBadge } from '../PromptCacheBadge';
import { SidePanel, usePanelTab } from './SidePanel';
import { runningSubagents } from '@shared/subagents';
import { call, errorMessage } from '../api';
import { isPanelOpen, useApp } from '../store';
import { compact, folderName, modelLabel, percent, shortPath, usd } from '../format';
import { AccountChip, Empty, Meter, MiniMeter, ProviderIcon, StatusPill, confirmDialog, useFit, useTicker } from '../ui';
import { mountTerminal, terminalBackground } from '../terminals';
import { groupAgentsByProject, projectKey } from '../agentProjects';
import { hasUnreadCompletion } from '../sessionUnread';

export async function stopAgent(agent: AgentInfo) {
  const settings = useApp.getState().settings;
  if (settings?.confirmBeforeStop && AGENT_MODES.includes(agent.mode)) {
    const { ok } = await confirmDialog({
      title: `Stop "${agent.title}"?`,
      message: agent.mode === 'chat'
        ? 'The process is ended. The conversation is kept; send a message to continue it.'
        : agent.mode === 'interactive'
          ? 'The process is ended. The conversation is kept and can be resumed later.'
          : 'The background task is ended before it finishes.',
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
  return CONVERSATION_MODES.includes(agent.mode) && Boolean(agent.transcriptPath || agent.telemetry?.sessionId);
}

export async function resumeAgent(agent: AgentInfo, mode?: AgentMode) {
  try {
    const next = await call('agents.resume', agent.id, mode);
    useApp.setState({ selectedAgentId: next.id, view: 'agents' });
  } catch (error) {
    useApp.getState().toast('error', errorMessage(error));
  }
}

type Display = 'chat' | 'terminal';

/** How a finished conversation is shown; a running one always shows the kind of process it is. */
const useDisplay = create<Record<string, Display>>(() => ({}));

function displayOf(agent: AgentInfo, preferred: Display | undefined): Display {
  if (!CONVERSATION_MODES.includes(agent.mode)) return 'terminal';
  if (!agent.endedAt) return agent.mode === 'chat' ? 'chat' : 'terminal';
  // Without a terminal buffer (earlier app run) the chat rebuilds the conversation from its session file.
  return preferred ?? (agent.mode === 'chat' || !agent.attached ? 'chat' : 'terminal');
}

function DisplayToggle({ agent, display }: { agent: AgentInfo; display: Display }) {
  const choose = async (next: Display) => {
    if (next === display) return;
    if (agent.endedAt) {
      useDisplay.setState({ [agent.id]: next });
      return;
    }
    if (agent.status === 'working') {
      const { ok } = await confirmDialog({
        title: next === 'chat' ? 'Continue as a chat?' : 'Open in the terminal?',
        message: 'The conversation moves to a new process; the turn in progress is interrupted.',
        confirmLabel: 'Switch'
      });
      if (!ok) return;
    }
    useDisplay.setState({ [agent.id]: next });
    await resumeAgent(agent, next === 'chat' ? 'chat' : 'interactive');
  };
  return (
    <div className="segmented display-toggle" title="Show this conversation as a chat or in the CLI's terminal UI">
      <button type="button" className={display === 'chat' ? 'on' : ''} onClick={() => choose('chat')}>
        <MessagesSquare size={13} /> Chat
      </button>
      <button type="button" className={display === 'terminal' ? 'on' : ''} onClick={() => choose('terminal')}>
        <SquareTerminal size={13} /> Terminal
      </button>
    </div>
  );
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
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.title);
  const rename = async () => {
    setEditing(false);
    if (name.trim() && name.trim() !== agent.title) await call('agents.rename', agent.id, name.trim());
  };
  return (
    <div className={`agent-item ${selected ? 'on' : ''} ${unread ? 'unread' : ''} ${agent.status === 'needs-input' ? 'attention' : ''}`} onClick={onSelect}>
      {unread ? <span className="ai-unread" role="status" aria-label="Completed, unread" title="Completed, unread" /> : null}
      <ProviderIcon provider={agent.provider} size={24} />
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
      <div className="ai-meta">
        <StatusPill status={agent.status} label={agent.status === 'working' && !agent.endedAt ? 'Running' : undefined} />
        {AGENT_MODES.includes(agent.mode) ? <PromptCacheBadge agent={agent} iconOnly /> : null}
        {agent.usesScreen ? <MousePointer2 size={12} color="var(--warning)" /> : null}
        {browser ? <Globe size={12} color={browser.busy ? 'var(--accent-strong)' : 'var(--text-muted)'} aria-label="Has a browser open" /> : null}
        {subagents ? (
          <span className="ai-subagents" title={`${subagents} subagent${subagents === 1 ? '' : 's'} running`}>
            <Network size={12} /> {subagents}
          </span>
        ) : null}
        <span className="ellipsis">{agent.mode === 'task' ? 'task' : CONVERSATION_MODES.includes(agent.mode) ? agent.profileLabel : agent.mode}</span>
        {t?.cost.totalUsd != null ? <span style={{ marginLeft: 'auto' }} className="num ai-cost">{usd(t.cost.reportedUsd ?? t.cost.totalUsd)}</span> : null}
      </div>
      {t && t.contextPercent !== null && agent.mode !== 'shell' ? (
        <div className={agent.status === 'working' && !agent.endedAt ? 'ai-context running' : 'ai-context'} style={{ gridColumn: 2 }}>
          <MiniMeter value={t.contextPercent} title={`Context ${compact(t.contextUsedTokens)} / ${compact(t.contextWindow)}`} />
        </div>
      ) : null}
    </div>
  );
}

function ProjectSessions({ agents, selectedId, archived = false, projectFolders = [], onToggleArchived }: {
  agents: AgentInfo[]; selectedId?: string; archived?: boolean; projectFolders?: string[]; onToggleArchived: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const openLauncher = useApp((state) => state.openLauncher);
  const projects = groupAgentsByProject(agents, projectFolders);
  if (!archived && !projects.some((project) => project.key === 'no-project')) {
    projects.push({ key: 'no-project', path: '', label: 'This Computer', agents: [] });
  }
  return projects.map((project) => (
    <details className="agent-project" key={project.key} open={!collapsed.has(project.key)} onToggle={(event) => {
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
        <FolderOpen size={12} />
        <span className="ellipsis">{project.label}</span>
        <button
          type="button"
          className="btn ghost sm icon agent-project-add"
          aria-label={project.path ? `New session in ${project.label}` : 'New session without a project'}
          title={project.path ? `New session in ${project.label}` : 'New session without a project'}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openLauncher({ cwd: project.path, projectless: !project.path, mode: 'chat' });
          }}
        >
          <Plus size={14} />
        </button>
      </summary>
      {project.path && !project.agents.length ? <div className="agent-project-empty">No sessions yet</div> : null}
      {project.agents.map((agent) => (
        <AgentListItem key={agent.id} agent={agent} archived={archived} selected={selectedId === agent.id}
          onSelect={() => useApp.setState({ selectedAgentId: agent.id })} onToggleArchived={() => onToggleArchived(agent.id)} />
      ))}
    </details>
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

function AgentHeader({ agent, display }: { agent: AgentInfo; display: Display }) {
  const panelOpen = useApp((s) => isPanelOpen(s, agent.id));
  const panelTab = usePanelTab(agent);
  // The cost shows here unless the panel's Details tab already does.
  const costShown = panelOpen && panelTab === 'details';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.title);
  useEffect(() => setName(agent.title), [agent.title]);
  const live = !agent.endedAt;
  const t = agent.telemetry;
  const model = t?.model ?? agent.model;
  // What doesn't fit is left out whole: the cost first (the details have it), then shortcuts the title offers too.
  const row = useFit<HTMLDivElement>([agent.id, agent.title, agent.status, display, costShown, panelOpen, live, editing]);
  const meta = useFit<HTMLDivElement>([agent.id, agent.status, agent.statusDetail, agent.profileLabel, agent.cwd, model]);
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
          <StatusPill status={agent.status} detail={agent.statusDetail} />
          <span data-fit="2">
            <AccountChip label={agent.profileLabel} color={agent.profileColor} />
          </span>
          <span className="mono" data-fit="3" title={agent.projectless ? 'Standalone conversation' : agent.cwd}>
            {agent.projectless ? 'No project' : shortPath(agent.cwd)}
          </span>
          {model ? (
            <span className="badge" data-fit="1" title={model}>
              {modelLabel(model)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="th-actions">
        {CONVERSATION_MODES.includes(agent.mode) ? <DisplayToggle agent={agent} display={display} /> : null}
        {t && t.contextPercent !== null && display === 'terminal' ? (
          <div className="th-context">
            <Meter label="Context" value={t.contextPercent} valueText={`${percent(t.contextPercent)} of ${compact(t.contextWindow)}`} title={`${compact(t.contextUsedTokens)} tokens in context${t.contextWindowAssumed ? ' (window size assumed)' : ''}`} />
          </div>
        ) : null}
        {t && !costShown ? (
          <div data-fit="3" style={{ textAlign: 'right', minWidth: 70 }} title={t.cost.reportedUsd != null ? "Claude Code's own estimate" : 'Estimated at API list prices'}>
            <div className="num" style={{ fontWeight: 600 }}>
              {usd(t.cost.reportedUsd ?? t.cost.totalUsd)}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {compact(t.totalUsage?.totalTokens ?? 0)} tokens
            </div>
          </div>
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
        {/* A chat stops from its composer; terminal agents have no composer. */}
        {live && display !== 'chat' ? (
          <button className="btn danger sm" onClick={() => stopAgent(agent)}>
            <Square size={12} /> Stop
          </button>
        ) : canResume(agent) && display === 'terminal' ? (
          <button className="btn sm" onClick={() => resumeAgent(agent, 'interactive')}>
            <History size={13} /> Resume
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

/** The conversation beside the side panel, with a divider to drag; in a narrow window the panel takes it all. */
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
  const full = shown && (expanded || narrow);
  const drag = (event: React.PointerEvent) => {
    const element = box.current;
    if (!element) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const next = Math.min(0.75, Math.max(0.25, (bounds.right - e.clientX) / bounds.width));
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
        <div className="agent-side" style={full ? { flex: 1 } : { width: `${share * 100}%` }}>
          <SidePanel agent={agent} expanded={full} onExpand={narrow ? undefined : () => useApp.setState({ panelExpanded: !expanded })} />
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
  const [addingProject, setAddingProject] = useState(false);
  const addProject = async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      const folder = await call('dialog.pickDirectory');
      if (!folder) return;
      const previous = useApp.getState().settings?.projectFolders ?? [];
      const next = [folder, ...previous.filter((item) => projectKey(item) !== projectKey(folder))];
      const settings = await call('settings.update', { projectFolders: next });
      useApp.setState({ settings });
      setQuery('');
    } catch (error) {
      useApp.getState().toast('error', errorMessage(error));
    } finally {
      setAddingProject(false);
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
  useEffect(() => {
    try {
      localStorage.setItem('archivedAgentIds', JSON.stringify(archivedIds));
      localStorage.removeItem('hiddenAgentIds');
    } catch { /* Storage unavailable. */ }
  }, [archivedIds]);
  useEffect(() => {
    try { localStorage.setItem('agentListWidth', String(listWidth)); } catch { /* Storage unavailable. */ }
  }, [listWidth]);
  const toggleArchived = (id: string) => setArchivedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const resizeList = (width: number) => setListWidth(Math.min(480, Math.max(220, width)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => !q || `${a.title} ${a.cwd} ${a.profileLabel} ${a.model ?? ''}`.toLowerCase().includes(q));
  }, [agents, query]);
  const live = filtered.filter((a) => !a.endedAt && !archivedIds.includes(a.id));
  const ended = filtered.filter((a) => a.endedAt && !archivedIds.includes(a.id));
  const visible = filtered.filter((a) => !archivedIds.includes(a.id));
  const archived = filtered.filter((a) => archivedIds.includes(a.id));
  const selected = agents.find((a) => a.id === selectedId) ?? live[0] ?? null;
  const preferred = useDisplay((s) => (selected ? s[selected.id] : undefined));
  const display = selected ? displayOf(selected, preferred) : 'terminal';

  useEffect(() => {
    if (!selectedId && selected) useApp.setState({ selectedAgentId: selected.id });
  }, [selectedId, selected]);

  return (
    <div className="agents-layout" style={{ ['--agent-list-width' as string]: `${listWidth}px` }}>
      <div className="agent-list" ref={listRef}>
        <div className="agent-list-head">
          <div className="agent-list-toolbar">
            <span>Projects</span>
            <button type="button" className="btn ghost sm" disabled={addingProject} onClick={addProject}>
              <FolderPlus size={14} /> New project
            </button>
          </div>
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
          {ended.length ? (
            <div className="agent-list-actions">
              <button className="btn ghost sm" style={{ height: 18, fontSize: 11 }} onClick={() => call('agents.clearFinished')}>
                Clear finished
              </button>
            </div>
          ) : null}
          <ProjectSessions agents={visible} selectedId={selected?.id}
            projectFolders={(projectFolders ?? []).filter((folder) => !query.trim() || folder.toLowerCase().includes(query.trim().toLowerCase()))}
            onToggleArchived={toggleArchived} />
          {archived.length ? (
            <details className="archived-agents">
              <summary>Archived ({archived.length})</summary>
              <ProjectSessions agents={archived} archived selectedId={selected?.id} onToggleArchived={toggleArchived} />
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
          ) : selected.attached && selected.mode !== 'chat' ? (
            <TerminalHost key={`${selected.id}:${selected.runId}`} agent={selected} />
          ) : (
            <div className="term-host" style={{ display: 'grid', placeItems: 'center', background: 'var(--surface-1)' }}>
              <Empty
                icon={<History size={22} />}
                title={selected.mode === 'chat' ? 'This conversation ran as a chat' : 'This agent ran in an earlier session of the app'}
                action={
                  canResume(selected) ? (
                    <button className="btn primary" onClick={() => resumeAgent(selected, 'interactive')}>
                      <History size={14} /> Resume in terminal
                    </button>
                  ) : undefined
                }
              >
                There's no terminal output to show, but the conversation is kept. Resume it in the terminal, or switch to Chat to read and continue it.
              </Empty>
            </div>
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
            Chat with an agent, or use the CLI's own terminal UI, with the account you choose. Status, context usage and cost update live, and the task manager shows everything that's running.
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

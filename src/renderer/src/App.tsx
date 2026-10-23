import { prepareVoiceModel } from './voice/engine';
import { chatFontSize } from '@shared/appearance';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  Download,
  LayoutGrid,
  MousePointer2,
  Settings as SettingsIcon,
  SquareTerminal,
  Users
} from 'lucide-react';
import { AGENT_MODES, LIVE_STATUSES, PROVIDERS, PROVIDER_LABEL, type Provider } from '@shared/types';
import { call, errorMessage, listen, pageTheme } from './api';
import { useApp, type View } from './store';
import { colorVar, limitSummary, signedOutLabel } from './format';
import { ConfirmHost, LimitMeters, ProviderIcon, TipHost, Toasts } from './ui';
import { configureTerminals, disposeTerminal } from './terminals';
import { forgetChat } from './chats';
import { AgentsView } from './views/AgentsView';
import { TaskManagerView } from './views/TaskManagerView';
import { UsageView } from './views/UsageView';
import { AccountsView } from './views/AccountsView';
import { ComputerUseView } from './views/ComputerUseView';
import { SettingsView } from './views/SettingsView';
import { LaunchDialog } from './views/LaunchDialog';

// In on-screen order, top to bottom: `foot` items sit at the bottom of the nav, so they come last
// and the Ctrl shortcuts count down the sidebar.
const NAV: Array<{ view: View; label: string; icon: typeof LayoutGrid; key: string; foot?: boolean }> = [
  { view: 'agents', label: 'Agents', icon: SquareTerminal, key: '1' },
  { view: 'tasks', label: 'Task Manager', icon: LayoutGrid, key: '2' },
  { view: 'usage', label: 'Usage & Cost', icon: BarChart3, key: '3' },
  { view: 'computer', label: 'Computer Use', icon: MousePointer2, key: '4' },
  { view: 'accounts', label: 'Accounts', icon: Users, key: '5', foot: true },
  { view: 'settings', label: 'Settings', icon: SettingsIcon, key: '6', foot: true }
];

function useBootstrap() {
  useEffect(() => {
    const store = useApp.getState;
    const set = useApp.setState;
    const load = async () => {
      try {
        const [env, settings, profiles, agents, computerUse] = await Promise.all([
          call('env.get'),
          call('settings.get'),
          call('profiles.list'),
          call('agents.list'),
          call('computerUse.status')
        ]);
        set({ env, settings, profiles, agents, computerUse });
        // Fetch and load the speech model now, so voice input is ready when a chat needs it.
        setTimeout(() => prepareVoiceModel(settings.voiceModel), 1500);
        // Reopen the chat the person left; otherwise the first live agent.
        let last: string | null = null;
        try { last = localStorage.getItem('lastAgentId'); } catch { /* storage unavailable */ }
        const resume = agents.find((a) => a.id === last) ?? agents.find((a) => LIVE_STATUSES.includes(a.status));
        if (resume) set({ selectedAgentId: resume.id });
        call('processes.external').then((externals) => set({ externals })).catch(() => {});
        call('usage.report').then((usage) => set({ usage })).catch(() => {});
        call('update.status').then((update) => set({ update })).catch(() => {});
        call('github.status').then((github) => set({ github })).catch(() => {});
        call('browser.list').then((list) => set({ browsers: Object.fromEntries(list.map((b) => [b.agentId, b])) })).catch(() => {});
      } catch (error) {
        store().toast('error', errorMessage(error));
      }
    };
    load();
    const markVisibleRead = () => {
      const state = store();
      if (state.view === 'agents' && !state.launcher && !state.panelExpanded && state.selectedAgentId && document.hasFocus() && document.visibilityState === 'visible') {
        state.markSessionRead(state.selectedAgentId);
      }
    };
    window.addEventListener('focus', markVisibleRead);
    document.addEventListener('visibilitychange', markVisibleRead);
    const stopTrackingRead = useApp.subscribe(markVisibleRead);
    const stopRemembering = useApp.subscribe((state, prev) => {
      if (state.selectedAgentId === prev.selectedAgentId || !state.selectedAgentId) return;
      try { localStorage.setItem('lastAgentId', state.selectedAgentId); } catch { /* storage unavailable */ }
    });
    const offs = [
      stopTrackingRead,
      () => window.removeEventListener('focus', markVisibleRead),
      () => document.removeEventListener('visibilitychange', markVisibleRead),
      stopRemembering,
      listen('agents', (agents) => {
        const runs = new Map(agents.map((a) => [a.id, a.runId]));
        // A subagent that just started brings the side panel up at the map.
        const known = new Map(store().agents.map((a) => [a.id, new Set((a.subagents ?? []).map((n) => n.id))]));
        for (const agent of agents) {
          const before = known.get(agent.id);
          if (before && agent.subagents?.some((n) => n.status === 'running' && !before.has(n.id))) store().showPanel(agent.id, 'subagents');
        }
        for (const old of store().agents) {
          const run = runs.get(old.id);
          // A new process for the same agent (resume, hand-off) starts a fresh terminal.
          if (run !== old.runId) disposeTerminal(old.id);
          if (run === undefined) forgetChat(old.id);
        }
        set({ agents });
        const selected = store().selectedAgentId;
        if (selected && !agents.some((a) => a.id === selected)) set({ selectedAgentId: agents[0]?.id ?? null });
      }),
      listen('profiles', (profiles) => set({ profiles })),
      listen('usage', (usage) => set({ usage })),
      listen('usage-progress', (usageProgress) => set({ usageProgress })),
      listen('computer-use', (computerUse) => set({ computerUse })),
      listen('externals', (externals) => set({ externals })),
      listen('settings', (settings) => set({ settings })),
      listen('update', (update) => set({ update })),
      listen('github', (github) => set({ github })),
      listen('browser', ({ agentId, state }) => {
        const { browsers, settings } = store();
        const next = { ...browsers };
        if (state) next[agentId] = state;
        else delete next[agentId];
        set({ browsers: next });
        // A browser that just opened, or that the agent comes back to after a pause, comes up in the side panel.
        // Not on every tool call: that would keep pulling the panel away from another tab.
        const previous = browsers[agentId];
        const lastUse = previous?.actions.findLast((a) => a.source === 'agent');
        const resumed = previous && state?.busy && !previous.busy && !state.paused && (!lastUse || Date.now() - Date.parse(lastUse.at) > 60_000);
        const started = state && (!previous || resumed);
        if (started && settings?.browserAutoOpen !== false) store().showPanel(agentId, 'browser');
      }),
      listen('toast', (t) => store().toast(t.kind, t.message)),
      listen('navigate', ({ view, agentId }) => {
        set({ view: view as View });
        if (agentId) set({ selectedAgentId: agentId });
      })
    ];
    return () => offs.forEach((off) => off());
  }, []);
}

function useTheme() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${chatFontSize(settings?.chatFontSize)}px`);
  }, [settings?.chatFontSize]);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const theme = pageTheme(settings ?? window.atc.initialTheme, systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (!settings) return;
    configureTerminals({ fontSize: settings.terminalFontSize, fontFamily: settings.terminalFontFamily, theme });
  }, [settings?.terminalFontSize, settings?.terminalFontFamily, theme]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      const state = useApp.getState();
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault();
        state.openLauncher();
        return;
      }
      const nav = NAV.find((n) => n.key === event.key);
      if (nav && !event.shiftKey) {
        event.preventDefault();
        state.setView(nav.view);
        return;
      }
      if (event.key === 'Tab') {
        const live = state.agents.filter((a) => LIVE_STATUSES.includes(a.status));
        if (live.length === 0) return;
        event.preventDefault();
        const index = live.findIndex((a) => a.id === state.selectedAgentId);
        const next = live[(index + (event.shiftKey ? -1 : 1) + live.length) % live.length];
        useApp.setState({ selectedAgentId: next.id, view: 'agents' });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function AccountSwitcher({ provider }: { provider: Provider }) {
  const profiles = useApp((s) => s.profiles).filter((p) => p.provider === provider);
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = profiles.find((p) => p.isActive) ?? profiles[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!active) return null;
  const email = active.identity?.email ?? null;
  // The plan names the account at a glance; the email stays in the tooltip.
  const detail = active.planTier ?? email;
  const choose = async (id: string) => {
    setOpen(false);
    try {
      const profiles = await call('profiles.setActive', provider, id);
      useApp.setState({ profiles });
      const chosen = profiles.find((p) => p.id === id);
      toast('success', `New ${PROVIDER_LABEL[provider]} agents will use "${chosen?.label}"${chosen?.identity?.email ? ` (${chosen.identity.email})` : ''}.`);
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };
  return (
    <div className="switcher" ref={ref}>
      <button className="switcher-button" onClick={() => setOpen(!open)} title={`${PROVIDER_LABEL[provider]} account for new agents${email ? `\n${email}` : ''}`}>
        <ProviderIcon provider={provider} size={20} />
        <span className="who">
          <span className="name ellipsis">
            {active.label}
            {detail ? <span className="muted"> · {detail}</span> : null}
          </span>
          <span className="limit ellipsis">{limitSummary(active.limits?.windows) || (active.identity?.loggedIn ? active.planTier ?? 'Signed in' : signedOutLabel(active.identity))}</span>
        </span>
        <ChevronDown size={14} className="muted" />
      </button>
      {open ? (
        <div className="popover">
          <div className="pop-title">{PROVIDER_LABEL[provider]} account for new agents</div>
          {profiles.map((p) => (
            <button key={p.id} className={`pop-item ${p.isActive ? 'on' : ''}`} onClick={() => choose(p.id)}>
              <span className="swatch" style={{ background: colorVar(p.color), width: 12, height: 12, borderRadius: 4 }} />
              <span style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 500 }}>
                  {p.label}
                  {p.planTier ? <span className="badge" style={{ marginLeft: 6 }}>{p.planTier}</span> : null}
                </div>
                <div className="muted ellipsis" style={{ fontSize: 11.5 }}>
                  {p.identity?.email ?? (p.identity?.loggedIn ? 'Signed in' : signedOutLabel(p.identity))}
                </div>
              </span>
              <span>{p.isActive ? <Check size={15} color="var(--accent-strong)" /> : null}</span>
              {p.limits?.windows?.length ? (
                <span className="limits">
                  <LimitMeters windows={p.limits.windows} compact />
                </span>
              ) : null}
            </button>
          ))}
          <div className="pop-sep" />
          <button
            className="pop-item"
            onClick={() => {
              setOpen(false);
              useApp.setState({ view: 'accounts' });
            }}
          >
            <Users size={14} className="muted" />
            <span className="secondary">Manage accounts…</span>
            <span />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One click installs a downloaded update and restarts into it. */
function UpdateButton() {
  const update = useApp((s) => s.update);
  const toast = useApp((s) => s.toast);
  if (update?.state !== 'ready') return null;
  const install = async () => {
    try {
      await call('update.install');
    } catch (error) {
      toast('error', errorMessage(error));
    }
  };
  return (
    <button className="btn sm no-drag" onClick={install} title={`Foreman ${update.version} is downloaded. Restart to install it.`}>
      <Download size={14} /> Restart to update
    </button>
  );
}

function TitleBar() {
  return (
    <header className="titlebar">
      <div className="brand">
        {/* resources/icon.svg, cropped to its plate */}
        <svg className="brand-mark" viewBox="32 32 448 448" aria-hidden="true">
          <defs>
            <linearGradient id="brand-plate" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#232650" />
              <stop offset="1" stopColor="#15172e" />
            </linearGradient>
          </defs>
          <rect x="32" y="32" width="448" height="448" rx="100" fill="url(#brand-plate)" />
          <rect x="118" y="136" width="56" height="240" rx="28" fill="#fff" />
          <rect x="118" y="136" width="210" height="56" rx="28" fill="#fff" />
          <rect x="118" y="236" width="150" height="56" rx="28" fill="#fff" />
          <circle cx="370" cy="164" r="28" fill="#e8662f" />
          <circle cx="310" cy="264" r="28" fill="#3d8ff0" />
        </svg>
        Foreman
      </div>
      {PROVIDERS.map((p) => (
        <AccountSwitcher key={p} provider={p} />
      ))}
      <div className="spacer" />
      <UpdateButton />
    </header>
  );
}

function Nav() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const agents = useApp((s) => s.agents);
  const computerUse = useApp((s) => s.computerUse);
  const needsInput = agents.filter((a) => a.status === 'needs-input').length;
  const live = agents.filter((a) => LIVE_STATUSES.includes(a.status) && AGENT_MODES.includes(a.mode)).length;
  const badges: Partial<Record<View, React.ReactNode>> = {
    agents: needsInput ? <span className="badge count">{needsInput}</span> : live ? <span className="badge">{live}</span> : null,
    computer: computerUse?.active && computerUse.overlayRunning ? <span className="badge dot warning" /> : null
  };
  const badgeNote: Partial<Record<View, string>> = {
    agents: needsInput ? `${needsInput} waiting for input` : live ? `${live} running` : '',
    computer: badges.computer ? 'Controlling the screen' : ''
  };
  const item = (item: (typeof NAV)[number]) => (
    <button
      key={item.view}
      className={`nav-item ${view === item.view ? 'active' : ''}`}
      onClick={() => setView(item.view)}
      aria-label={item.label}
      aria-keyshortcuts={`Control+${item.key}`}
    >
      <item.icon size={18} />
      {badges[item.view]}
      <span className="hover-tip" role="tooltip">
        <span className="hover-tip-head">
          {item.label}
          <span className="kbd">Ctrl {item.key}</span>
        </span>
        {badgeNote[item.view] ? <span className="hover-tip-note">{badgeNote[item.view]}</span> : null}
      </span>
    </button>
  );
  // The wheel steps through the pages. Deltas add up to one notch before a step, and a step
  // is held off briefly so a touchpad's stream of small deltas doesn't race through them.
  const wheel = useRef({ sum: 0, last: 0, seen: 0 });
  const onWheel = (event: React.WheelEvent) => {
    const w = wheel.current;
    const now = performance.now();
    if (now - w.seen > 400) w.sum = 0;
    w.seen = now;
    w.sum += event.deltaY;
    if (Math.abs(w.sum) < 50 || now - w.last < 150) return;
    const step = Math.sign(w.sum);
    w.sum = 0;
    w.last = now;
    const index = NAV.findIndex((n) => n.view === useApp.getState().view);
    const next = NAV[index + step];
    if (next) setView(next.view);
  };
  return (
    <nav className="nav" onWheel={onWheel}>
      {NAV.filter((n) => !n.foot).map(item)}
      <div className="nav-footer">{NAV.filter((n) => n.foot).map(item)}</div>
    </nav>
  );
}

// Development hook used by the main process's ATC_CAPTURE_DIR screenshot mode.
(window as any).__atcDev = (view: string) => {
  const state = useApp.getState();
  if (view.startsWith('select:')) useApp.setState({ selectedAgentId: view.slice(7), view: 'agents', launcher: null });
  else if (view === 'launcher') state.openLauncher();
  else {
    state.closeLauncher();
    state.setView(view as View);
  }
};

export function App() {
  useBootstrap();
  useTheme();
  useShortcuts();
  const view = useApp((s) => s.view);
  const launcher = useApp((s) => s.launcher);
  const ready = useApp((s) => s.settings !== null);
  const content = useMemo(() => {
    switch (view) {
      case 'agents':
        return <AgentsView />;
      case 'tasks':
        return <TaskManagerView />;
      case 'usage':
        return <UsageView />;
      case 'accounts':
        return <AccountsView />;
      case 'computer':
        return <ComputerUseView />;
      case 'settings':
        return <SettingsView />;
      default:
        return null;
    }
  }, [view]);
  return (
    <div className="app">
      <TitleBar />
      <Nav />
      <main className="main">{ready ? content : null}</main>
      {launcher ? <LaunchDialog preset={launcher} /> : null}
      <ConfirmHost />
      <TipHost />
      <Toasts />
    </div>
  );
}

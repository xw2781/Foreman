import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Check,
  ChevronDown,
  LayoutGrid,
  MonitorSmartphone,
  MousePointer2,
  Plus,
  Settings as SettingsIcon,
  SquareTerminal,
  Users
} from 'lucide-react';
import { AGENT_MODES, LIVE_STATUSES, PROVIDERS, PROVIDER_LABEL, type Provider } from '@shared/types';
import { call, errorMessage, listen } from './api';
import { useApp, type View } from './store';
import { colorVar, limitSummary, usd } from './format';
import { ConfirmHost, LimitMeters, ProviderIcon, Toasts } from './ui';
import { configureTerminals, disposeTerminal } from './terminals';
import { forgetChat } from './chats';
import { AgentsView } from './views/AgentsView';
import { TaskManagerView } from './views/TaskManagerView';
import { UsageView } from './views/UsageView';
import { AccountsView } from './views/AccountsView';
import { ComputerUseView } from './views/ComputerUseView';
import { SettingsView } from './views/SettingsView';
import { LaunchDialog } from './views/LaunchDialog';

const NAV: Array<{ view: View; label: string; icon: typeof LayoutGrid; key: string }> = [
  { view: 'agents', label: 'Agents', icon: SquareTerminal, key: '1' },
  { view: 'tasks', label: 'Task Manager', icon: LayoutGrid, key: '2' },
  { view: 'usage', label: 'Usage & Cost', icon: BarChart3, key: '3' },
  { view: 'accounts', label: 'Accounts', icon: Users, key: '4' },
  { view: 'computer', label: 'Computer Use', icon: MousePointer2, key: '5' },
  { view: 'settings', label: 'Settings', icon: SettingsIcon, key: '6' }
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
        const firstLive = agents.find((a) => LIVE_STATUSES.includes(a.status));
        if (firstLive) set({ selectedAgentId: firstLive.id });
        call('processes.external').then((externals) => set({ externals })).catch(() => {});
        call('usage.report').then((usage) => set({ usage })).catch(() => {});
      } catch (error) {
        store().toast('error', errorMessage(error));
      }
    };
    load();
    const offs = [
      listen('agents', (agents) => {
        const runs = new Map(agents.map((a) => [a.id, a.runId]));
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
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const mode = settings?.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings?.theme ?? 'dark';
  const theme = mode === 'dark' ? 'dark' : settings?.lightPalette ?? 'cream';
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
      <button className="switcher-button" onClick={() => setOpen(!open)} title={`${PROVIDER_LABEL[provider]} account for new agents`}>
        <ProviderIcon provider={provider} size={20} />
        <span className="who">
          <span className="name ellipsis">
            {active.label}
            {active.identity?.email ? <span className="muted"> · {active.identity.email}</span> : null}
          </span>
          <span className="limit ellipsis">{limitSummary(active.limits?.windows) || (active.identity?.loggedIn ? active.identity.plan ?? 'Signed in' : 'Not signed in')}</span>
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
                  {p.identity?.plan ? <span className="badge" style={{ marginLeft: 6 }}>{p.identity.plan}</span> : null}
                </div>
                <div className="muted ellipsis" style={{ fontSize: 11.5 }}>
                  {p.identity?.email ?? (p.identity?.loggedIn ? 'Signed in' : 'Not signed in')}
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

function TitleBar() {
  const openLauncher = useApp((s) => s.openLauncher);
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">
          <MonitorSmartphone size={13} />
        </span>
        Foreman
      </div>
      {PROVIDERS.map((p) => (
        <AccountSwitcher key={p} provider={p} />
      ))}
      <div className="spacer" />
      <button className="btn primary sm no-drag" onClick={() => openLauncher()} title="New agent (Ctrl+N)">
        <Plus size={14} /> New agent
      </button>
    </header>
  );
}

function Nav() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const agents = useApp((s) => s.agents);
  const usage = useApp((s) => s.usage);
  const computerUse = useApp((s) => s.computerUse);
  const env = useApp((s) => s.env);
  const needsInput = agents.filter((a) => a.status === 'needs-input').length;
  const live = agents.filter((a) => LIVE_STATUSES.includes(a.status) && AGENT_MODES.includes(a.mode)).length;
  const badges: Partial<Record<View, React.ReactNode>> = {
    agents: needsInput ? <span className="badge count">{needsInput}</span> : live ? <span className="badge">{live}</span> : null,
    computer: computerUse?.active && computerUse.overlayRunning ? <span className="badge warning">Live</span> : null
  };
  return (
    <nav className="nav">
      {NAV.map((item) => (
        <button key={item.view} className={`nav-item ${view === item.view ? 'active' : ''}`} onClick={() => setView(item.view)} title={`Ctrl+${item.key}`}>
          <item.icon size={16} />
          <span>{item.label}</span>
          {badges[item.view] ? <span className="badge-wrap" style={{ marginLeft: 'auto' }}>{badges[item.view]}</span> : null}
        </button>
      ))}
      <div className="nav-footer">
        {usage ? (
          <div className="row">
            <span>Today</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-primary)' }} className="num">
              {usd(usage.totals.today)}
            </span>
          </div>
        ) : null}
        {env?.clis.map((cli) => (
          <div className="row" key={cli.provider} title={cli.path ?? cli.error ?? ''}>
            <span className="swatch" style={{ background: cli.path ? 'var(--good)' : 'var(--critical)', borderRadius: '50%', width: 7, height: 7 }} />
            <span>{PROVIDER_LABEL[cli.provider]}</span>
            <span className="ellipsis" style={{ marginLeft: 'auto', maxWidth: 110 }}>
              {cli.version?.replace(/\s*\(.*\)$/, '').replace(/^codex-cli\s*/, '') ?? 'missing'}
            </span>
          </div>
        ))}
      </div>
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
      <Toasts />
    </div>
  );
}

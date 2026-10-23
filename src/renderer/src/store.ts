import { create } from 'zustand';
import { completionStamp, hasUnreadCompletion } from './sessionUnread';
import type {
  AgentInfo,
  AppSettings,
  BrowserState,
  ComputerUseStatus,
  EnvironmentInfo,
  ExternalAgentProcess,
  LaunchOptions,
  ProfileView,
  Toast,
  GitHubSyncStatus,
  UpdateStatus,
  UsageReport
} from '@shared/types';

/** The tabs of the side panel beside an agent. */
export type PanelTab = 'subagents' | 'browser' | 'files' | 'details';

export type View = 'agents' | 'tasks' | 'usage' | 'accounts' | 'computer' | 'settings';

export interface ToastItem extends Toast {
  id: number;
}

interface AppState {
  view: View;
  env: EnvironmentInfo | null;
  settings: AppSettings | null;
  profiles: ProfileView[];
  agents: AgentInfo[];
  selectedAgentId: string | null;
  readCompletions: Record<string, string>;
  markSessionRead: (id: string) => void;
  /** null until the first process snapshot arrives. */
  externals: ExternalAgentProcess[] | null;
  usage: UsageReport | null;
  usageProgress: number;
  computerUse: ComputerUseStatus | null;
  update: UpdateStatus | null;
  github: GitHubSyncStatus | null;
  toasts: ToastItem[];
  launcher: Partial<LaunchOptions> | null;
  /** Each agent's browser, while it is open. */
  browsers: Record<string, BrowserState>;
  /** Whether the side panel shows beside each agent; unset follows `panelDefault`. */
  panelOpen: Record<string, boolean>;
  /** The side panel for agents the person hasn't opened or closed it for: their last choice. */
  panelDefault: boolean;
  /** The tab each agent's side panel shows. */
  panelTab: Record<string, PanelTab>;
  /** The side panel fills the agent panel, hiding the conversation. */
  panelExpanded: boolean;
  setView: (view: View) => void;
  selectAgent: (id: string | null) => void;
  openLauncher: (preset?: Partial<LaunchOptions>) => void;
  closeLauncher: () => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  /** Opens the agent's side panel at a tab. */
  showPanel: (agentId: string, tab: PanelTab) => void;
  /** Opens or closes the agent's side panel; with a tab, a panel showing another tab switches to it instead of closing. */
  togglePanel: (agentId: string, tab?: PanelTab) => void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  view: 'agents',
  env: null,
  settings: null,
  profiles: [],
  agents: [],
  selectedAgentId: null,
  readCompletions: readCompletionState(),
  markSessionRead: (id) => {
    const agent = get().agents.find((agent) => agent.id === id);
    if (!agent || !hasUnreadCompletion(agent, get().readCompletions)) return;
    const readCompletions = { ...get().readCompletions, [id]: completionStamp(agent)! };
    try { localStorage.setItem('readSessionCompletions', JSON.stringify(readCompletions)); } catch { /* storage unavailable */ }
    set({ readCompletions });
  },
  externals: null,
  usage: null,
  usageProgress: 0,
  computerUse: null,
  update: null,
  github: null,
  toasts: [],
  launcher: null,
  browsers: {},
  panelOpen: {},
  panelDefault: readPanelDefault(),
  panelTab: {},
  panelExpanded: false,
  setView: (view) => set({ view }),
  selectAgent: (id) => set({ selectedAgentId: id }),
  openLauncher: (preset = {}) => set({ launcher: preset }),
  closeLauncher: () => set({ launcher: null }),
  toast: (kind, message) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, message }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 5000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  showPanel: (agentId, tab) => set({ panelOpen: { ...get().panelOpen, [agentId]: true }, panelTab: { ...get().panelTab, [agentId]: tab } }),
  togglePanel: (agentId, tab) => {
    const { panelOpen, panelTab } = get();
    const open = isPanelOpen(get(), agentId);
    if (tab && open && panelTab[agentId] !== tab) return get().showPanel(agentId, tab);
    rememberPanelDefault(!open);
    set({
      panelOpen: { ...panelOpen, [agentId]: !open },
      panelDefault: !open,
      ...(tab ? { panelTab: { ...panelTab, [agentId]: tab } } : {}),
      ...(open ? { panelExpanded: false } : {})
    });
  }
}));

export function isPanelOpen(state: Pick<AppState, 'panelOpen' | 'panelDefault'>, agentId: string) {
  return state.panelOpen[agentId] ?? state.panelDefault;
}

function readPanelDefault() {
  try {
    return localStorage.getItem('sidePanelOpen') === '1';
  } catch {
    return false;
  }
}

function readCompletionState(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem('readSessionCompletions') ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

function rememberPanelDefault(open: boolean) {
  try {
    localStorage.setItem('sidePanelOpen', open ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

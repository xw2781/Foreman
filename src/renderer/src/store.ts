import { create } from 'zustand';
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
  /** null until the first process snapshot arrives. */
  externals: ExternalAgentProcess[] | null;
  usage: UsageReport | null;
  usageProgress: number;
  computerUse: ComputerUseStatus | null;
  update: UpdateStatus | null;
  github: GitHubSyncStatus | null;
  toasts: ToastItem[];
  launcher: Partial<LaunchOptions> | null;
  /** The details panel beside the agent, when the window is wide enough to dock it. */
  showDetails: boolean;
  /** The details panel over the agent, in a window too narrow to dock it. */
  detailsOverlay: boolean;
  /** Each agent's browser, while it is open. */
  browsers: Record<string, BrowserState>;
  /** Whether the browser shows beside each agent (unset: not decided yet, so it opens when the agent starts browsing). */
  browserShown: Record<string, boolean>;
  /** The browser fills the agent panel, hiding the conversation. */
  browserExpanded: boolean;
  setView: (view: View) => void;
  selectAgent: (id: string | null) => void;
  openLauncher: (preset?: Partial<LaunchOptions>) => void;
  closeLauncher: () => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
  toggleDetails: () => void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  view: 'agents',
  env: null,
  settings: null,
  profiles: [],
  agents: [],
  selectedAgentId: null,
  externals: null,
  usage: null,
  usageProgress: 0,
  computerUse: null,
  update: null,
  github: null,
  toasts: [],
  launcher: null,
  showDetails: false,
  detailsOverlay: false,
  browsers: {},
  browserShown: {},
  browserExpanded: false,
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
  toggleDetails: () => set({ showDetails: !get().showDetails })
}));

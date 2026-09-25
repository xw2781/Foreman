import type {
  AgentInfo,
  AgentMode,
  AppSettings,
  ChatAnswer,
  ChatItem,
  ChatSettingsPatch,
  ComputerUseStatus,
  EnvironmentInfo,
  ExternalAgentProcess,
  LaunchOptions,
  NewProfileInput,
  ProfileView,
  Provider,
  Toast,
  UpdateStatus,
  UsageReport
} from './types';

/** Every request the renderer can make, with its arguments and result. */
export interface InvokeMap {
  'env.get': () => EnvironmentInfo;
  'env.refreshClis': () => EnvironmentInfo;
  'settings.get': () => AppSettings;
  'settings.update': (patch: Partial<AppSettings>) => AppSettings;
  'dialog.pickDirectory': (defaultPath?: string) => string | null;
  'dialog.pickFile': (title: string) => string | null;
  'shell.openPath': (target: string) => void;
  'shell.showItem': (target: string) => void;
  'shell.openExternal': (url: string) => void;

  'profiles.list': () => ProfileView[];
  'profiles.create': (input: NewProfileInput) => ProfileView[];
  'profiles.update': (id: string, patch: { label?: string; color?: string; emailHint?: string }) => ProfileView[];
  'profiles.remove': (id: string, deleteData: boolean) => ProfileView[];
  'profiles.setActive': (provider: Provider, id: string) => ProfileView[];
  'profiles.refresh': () => ProfileView[];
  'profiles.login': (id: string) => AgentInfo;
  'profiles.logout': (id: string) => ProfileView[];
  'profiles.setGlobalDefault': (id: string) => ProfileView[];
  'profiles.shareConfig': (id: string) => ProfileView[];
  'profiles.openShell': (id: string, cwd?: string) => AgentInfo;

  'agents.list': () => AgentInfo[];
  'agents.launch': (options: LaunchOptions) => AgentInfo;
  'agents.write': (id: string, data: string) => void;
  'agents.resize': (id: string, cols: number, rows: number) => void;
  'agents.stop': (id: string) => void;
  'agents.remove': (id: string) => void;
  'agents.clearFinished': () => void;
  'agents.rename': (id: string, title: string) => void;
  /** Continues the agent's conversation in place, as a chat or in the terminal (default: its current kind). */
  'agents.resume': (id: string, mode?: AgentMode) => AgentInfo;
  'agents.buffer': (id: string) => { data: string; end: number };

  'chat.items': (id: string) => ChatItem[];
  /** Sends a message; a finished chat is resumed with it. */
  'chat.send': (id: string, text: string) => AgentInfo;
  'chat.interrupt': (id: string) => void;
  'chat.respond': (id: string, itemId: string, answer: ChatAnswer) => void;
  'chat.configure': (id: string, patch: ChatSettingsPatch) => void;

  /** null until the first process snapshot has been taken. */
  'processes.external': () => ExternalAgentProcess[] | null;
  'processes.kill': (pid: number) => void;

  'usage.report': (force?: boolean) => UsageReport;

  'computerUse.status': () => ComputerUseStatus;
  'computerUse.command': (name: 'release' | 'stop' | 'demo') => { code: number; output: string };
  'computerUse.setPolicy': (policy: { allowedProcesses: string[]; deniedProcesses: string[] }) => ComputerUseStatus;
  'computerUse.install': (profileId: string, install: boolean) => ProfileView[];
  'computerUse.image': (file: string) => string | null;

  'update.status': () => UpdateStatus;
  'update.check': () => UpdateStatus;
  /** Quits (asking first if agents are running), installs the downloaded update and restarts. */
  'update.install': () => void;
}

export type InvokeChannel = keyof InvokeMap;

/** Pushed from main to renderer. */
export interface EventMap {
  agents: AgentInfo[];
  /** `end` is the running character offset after this chunk, so replay and live data can be stitched exactly. */
  'agent-data': { id: string; data: string; end: number };
  /** Changed chat items; `reset` replaces the whole conversation (history loaded, new process). */
  chat: { id: string; items: ChatItem[]; reset: boolean };
  profiles: ProfileView[];
  usage: UsageReport;
  'usage-progress': number;
  'computer-use': ComputerUseStatus;
  externals: ExternalAgentProcess[];
  navigate: { view: string; agentId?: string };
  toast: Toast;
  settings: AppSettings;
  update: UpdateStatus;
}

export type EventName = keyof EventMap;

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'env.get', 'env.refreshClis', 'settings.get', 'settings.update', 'dialog.pickDirectory', 'dialog.pickFile',
  'shell.openPath', 'shell.showItem', 'shell.openExternal',
  'profiles.list', 'profiles.create', 'profiles.update', 'profiles.remove', 'profiles.setActive', 'profiles.refresh',
  'profiles.login', 'profiles.logout', 'profiles.setGlobalDefault', 'profiles.shareConfig', 'profiles.openShell',
  'agents.list', 'agents.launch', 'agents.write', 'agents.resize', 'agents.stop', 'agents.remove', 'agents.clearFinished',
  'agents.rename', 'agents.resume', 'agents.buffer',
  'chat.items', 'chat.send', 'chat.interrupt', 'chat.respond', 'chat.configure',
  'processes.external', 'processes.kill',
  'usage.report',
  'computerUse.status', 'computerUse.command', 'computerUse.setPolicy', 'computerUse.install', 'computerUse.image',
  'update.status', 'update.check', 'update.install'
];

export const EVENT_NAMES: EventName[] = [
  'agents', 'agent-data', 'chat', 'profiles', 'usage', 'usage-progress', 'computer-use', 'externals', 'navigate', 'toast', 'settings', 'update'
];

/** Fire-and-forget channels (no reply), for the hot path of terminal I/O. */
export const SEND_CHANNELS = ['agents.write', 'agents.resize'] as const;

export interface AtcBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<InvokeMap[C]>): Promise<ReturnType<InvokeMap[C]>>;
  send(channel: (typeof SEND_CHANNELS)[number], ...args: unknown[]): void;
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void;
}

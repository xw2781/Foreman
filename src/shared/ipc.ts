import type {
  AgentInfo,
  AgentMode,
  AppSettings,
  ChatAnswer,
  ChatCommand,
  ChatItem,
  ChatSendMode,
  ChatSettingsPatch,
  ComputerUseStatus,
  EnvironmentInfo,
  ExternalAgentProcess,
  GitHubSyncStatus,
  LaunchOptions,
  PricingStatus,
  NewProfileInput,
  ProfileView,
  Provider,
  Toast,
  UpdateStatus,
  UsageExportResult,
  UsageImportResult,
  UsageReport
} from './types';

/** Every request the renderer can make, with its arguments and result. */
export interface InvokeMap {
  'env.get': () => EnvironmentInfo;
  'env.refreshClis': () => EnvironmentInfo;
  'cli.install': (provider: Provider) => EnvironmentInfo;
  'cli.rollback': (provider: Provider) => EnvironmentInfo;
  'settings.get': () => AppSettings;
  'settings.update': (patch: Partial<AppSettings>) => AppSettings;
  'dialog.pickDirectory': (defaultPath?: string) => string | null;
  'dialog.pickFile': (title: string) => string | null;
  'shell.openPath': (target: string) => void;
  'shell.showItem': (target: string) => void;
  'shell.openExternal': (url: string) => void;

  'profiles.list': () => ProfileView[];
  'profiles.create': (input: NewProfileInput) => ProfileView[];
  /** An empty defaultModel / defaultEffort clears it (back to the CLI default). */
  'profiles.update': (id: string, patch: { label?: string; color?: string; emailHint?: string; defaultModel?: string; defaultEffort?: string }) => ProfileView[];
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
  /** Sends a message; a finished chat is resumed with it. While the agent works, `mode` says whether it steers the turn or waits for it to end. */
  'chat.send': (id: string, text: string, mode: ChatSendMode) => AgentInfo;
  /** A queued message: `send` it now (into the running turn, if there is one) or `remove` it. */
  'chat.queued': (id: string, itemId: string, action: 'send' | 'remove') => AgentInfo;
  /** Stops the running turn; returns the queued messages' texts, which are taken off the queue for editing. */
  'chat.interrupt': (id: string) => string[];
  'chat.respond': (id: string, itemId: string, answer: ChatAnswer) => void;
  'chat.configure': (id: string, patch: ChatSettingsPatch) => void;
  /** The slash commands and skills the session accepts (the last known ones once it has ended). */
  'chat.commands': (id: string) => ChatCommand[];

  /** null until the first process snapshot has been taken. */
  'processes.external': () => ExternalAgentProcess[] | null;
  'processes.kill': (pid: number) => void;

  'usage.report': (force?: boolean) => UsageReport;
  /** Asks where to save; null when cancelled. Carries this computer's whole history plus every imported computer's. */
  'usage.export': () => UsageExportResult | null;
  /** Asks for usage files and merges them; null when cancelled. */
  'usage.import': () => UsageImportResult | null;
  'usage.forgetMachine': (id: string) => UsageReport;

  'github.status': () => GitHubSyncStatus;
  /** Starts device sign-in and opens github.com/login/device; progress arrives as `github` events. */
  'github.connect': () => GitHubSyncStatus;
  'github.cancel': () => GitHubSyncStatus;
  'github.disconnect': () => GitHubSyncStatus;
  'github.sync': () => GitHubSyncStatus;
  'pricing.status': () => PricingStatus;
  /** Creates the editable pricing.json if needed and opens it. */
  'pricing.edit': () => PricingStatus;

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
  pricing: PricingStatus;
  github: GitHubSyncStatus;
}

export type EventName = keyof EventMap;

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'env.get', 'env.refreshClis', 'cli.install', 'cli.rollback', 'settings.get', 'settings.update', 'dialog.pickDirectory', 'dialog.pickFile',
  'shell.openPath', 'shell.showItem', 'shell.openExternal',
  'profiles.list', 'profiles.create', 'profiles.update', 'profiles.remove', 'profiles.setActive', 'profiles.refresh',
  'profiles.login', 'profiles.logout', 'profiles.setGlobalDefault', 'profiles.shareConfig', 'profiles.openShell',
  'agents.list', 'agents.launch', 'agents.write', 'agents.resize', 'agents.stop', 'agents.remove', 'agents.clearFinished',
  'agents.rename', 'agents.resume', 'agents.buffer',
  'chat.items', 'chat.send', 'chat.interrupt', 'chat.respond', 'chat.configure', 'chat.commands', 'chat.queued',
  'processes.external', 'processes.kill',
  'usage.report', 'usage.export', 'usage.import', 'usage.forgetMachine', 'pricing.status', 'pricing.edit',
  'github.status', 'github.connect', 'github.cancel', 'github.disconnect', 'github.sync',
  'computerUse.status', 'computerUse.command', 'computerUse.setPolicy', 'computerUse.install', 'computerUse.image',
  'update.status', 'update.check', 'update.install'
];

export const EVENT_NAMES: EventName[] = [
  'agents', 'agent-data', 'chat', 'profiles', 'usage', 'usage-progress', 'computer-use', 'externals', 'navigate', 'toast', 'settings', 'update', 'pricing', 'github'
];

/** Fire-and-forget channels (no reply), for the hot path of terminal I/O. */
export const SEND_CHANNELS = ['agents.write', 'agents.resize'] as const;

/** The theme settings, read synchronously at page load so the first paint already uses them. */
export type ThemePrefs = Pick<AppSettings, 'theme' | 'lightPalette'>;

export interface AtcBridge {
  initialTheme: ThemePrefs;
  invoke<C extends InvokeChannel>(channel: C, ...args: Parameters<InvokeMap[C]>): Promise<ReturnType<InvokeMap[C]>>;
  send(channel: (typeof SEND_CHANNELS)[number], ...args: unknown[]): void;
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void;
}

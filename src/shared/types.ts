// Types shared by the main process, the preload bridge, and the renderer.

export type Provider = 'claude' | 'codex';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * One signed-in account. Each account owns a config directory; agents run with
 * CLAUDE_CONFIG_DIR / CODEX_HOME pointing at it, so two accounts of the same
 * provider can run side by side without ever copying credentials around.
 */
export interface Profile {
  id: string;
  provider: Provider;
  label: string;
  color: string;
  configDir: string;
  /** The tool's own default location (~/.claude or ~/.codex): launched with the env override removed. */
  builtin: boolean;
  createdAt: string;
  emailHint?: string;
  /** Model new agents on this account start with unless the launcher picks one (CLI default when unset). */
  defaultModel?: string;
  /** Reasoning effort new agents on this account start with unless the launcher picks one. */
  defaultEffort?: string;
}

export interface ProfileIdentity {
  loggedIn: boolean;
  email: string | null;
  name: string | null;
  plan: string | null;
  org: string | null;
  authMethod: string | null;
  checkedAt: string;
  error: string | null;
}

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Shown instead of the percentage, e.g. "$128.17 / $130.00" for a spend cap. */
  detail?: string;
}

export interface ProfileLimits {
  windows: LimitWindow[];
  /** When the CLI last observed these numbers (not when we read them). */
  observedAt: string | null;
  planType: string | null;
}

export interface ProfileView extends Profile {
  identity: ProfileIdentity | null;
  limits: ProfileLimits | null;
  /** The subscription as the vendor names it ("Max 20x", "Pro", "Plus", "Business"); null when unknown or an API key. */
  planTier: string | null;
  /** What the CLI itself uses when no model or effort is given (its settings.json / config.toml). */
  cliDefaults: CliDefaults;
  /** Default account for new agents started in this app. */
  isActive: boolean;
  /** The account other apps (VS Code, desktop apps, new terminals) pick up from the user environment. */
  isGlobalDefault: boolean;
  skillInstalled: boolean;
  runningAgents: number;
}

/** The CLI's own configuration for an account. */
export interface CliDefaults {
  model: string | null;
  effort: string | null;
  /** Claude Code's `availableModels` allowlist: other models are refused (it falls back to the default). */
  models: string[] | null;
}

export interface NewProfileInput {
  provider: Provider;
  label: string;
  color?: string;
  emailHint?: string;
  shareConfig: boolean;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * chat: the app's own conversation UI over the CLI's structured protocol.
 * interactive: the CLI's own terminal UI. task: headless run to completion.
 * login/shell: account utilities.
 */
export type AgentMode = 'chat' | 'interactive' | 'task' | 'login' | 'shell';

/** Modes that run a model session (as opposed to the account utilities). */
export const AGENT_MODES: readonly AgentMode[] = ['chat', 'interactive', 'task'];
/** Modes whose conversation can be continued and handed between chat and terminal. */
export const CONVERSATION_MODES: readonly AgentMode[] = ['chat', 'interactive'];

export type AgentStatus =
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'done'
  | 'failed'
  | 'stopped';

export const LIVE_STATUSES: readonly AgentStatus[] = ['starting', 'working', 'needs-input', 'idle'];

export type ClaudePermission = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
export type CodexPermission = 'default' | 'read-only' | 'auto' | 'approve-for-me' | 'full-access';

export interface LaunchOptions {
  provider: Provider;
  profileId: string;
  cwd: string;
  mode: AgentMode;
  prompt?: string;
  title?: string;
  model?: string;
  effort?: string;
  permission?: string;
  /** Resume an earlier session by id (interactive mode only). */
  resumeSessionId?: string;
  extraArgs?: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteLongInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CostEstimate {
  /** null when no request in the session could be priced. */
  totalUsd: number | null;
  /** Claude Code's own client-side estimate, when a status-line capture reported one. */
  reportedUsd: number | null;
  unpricedModels: string[];
  byModel: Array<{ model: string; usd: number | null; usage: TokenUsage }>;
}

export interface SessionTelemetry {
  provider: Provider;
  sessionId: string;
  filePath: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  contextWindow: number;
  contextUsedTokens: number;
  contextPercent: number | null;
  /** True when the window size came from an assumption rather than the CLI. */
  contextWindowAssumed: boolean;
  lastUsage: TokenUsage | null;
  totalUsage: TokenUsage | null;
  requests: number;
  compactions: number;
  lastCompactionAt: string | null;
  taskActive: boolean | null;
  cost: CostEstimate;
  limits: ProfileLimits | null;
  source: 'transcript' | 'status-line' | 'rollout';
}

export interface AgentResources {
  cpuPercent: number;
  memoryMB: number;
  processCount: number;
}

export interface AgentInfo {
  id: string;
  provider: Provider;
  profileId: string;
  profileLabel: string;
  profileColor: string;
  cwd: string;
  mode: AgentMode;
  title: string;
  model: string | null;
  /** Reasoning effort chosen for it; null leaves the CLI's own default. */
  effort?: string | null;
  permission: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  sessionId: string | null;
  transcriptPath: string | null;
  lastActivityAt: string;
  lastOutputAt: string | null;
  commandLine: string;
  telemetry: SessionTelemetry | null;
  resources: AgentResources | null;
  usesScreen: boolean;
  prompt: string | null;
  /** Changes whenever a new process takes over the agent (resume, chat/terminal hand-off). */
  runId: string;
  /** False for agents restored from an earlier app run: they have no terminal buffer. */
  attached?: boolean;
  /** The person named it (at launch or by renaming); automatic titles leave it alone. */
  titleCustom?: boolean;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatFileChange {
  path: string;
  kind: 'add' | 'update' | 'delete';
  /** Unified-diff-style lines: ' ' context, '+' added, '-' removed, '@@' hunk headers. */
  diff: string;
}

/** The price table in force: the shipped one, overridden by the editable pricing.json. */
export interface PricingStatus {
  path: string;
  exists: boolean;
  pricingDate: string;
  models: number;
  /** Why the file was ignored (unreadable, not JSON). */
  error: string | null;
  /** Entries that were skipped. */
  problems: string[];
}

export interface ChatQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
  /** Accepts a free-text answer besides the options. */
  allowOther: boolean;
}

export interface ChatOption {
  id: string;
  label: string;
  tone: 'primary' | 'normal' | 'danger';
}

export type ChatToolStatus = 'running' | 'done' | 'error' | 'declined';

/** One entry of a conversation, as the chat view renders it. Both CLIs' protocols are normalized to this. */
export type ChatEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      title: string;
      detail: string | null;
      /** Full input (command, JSON arguments) shown when expanded. */
      input: string | null;
      output: string | null;
      status: ChatToolStatus;
      files: ChatFileChange[] | null;
      durationMs: number | null;
    }
  | {
      kind: 'approval';
      id: string;
      tool: string;
      title: string;
      detail: string | null;
      body: string | null;
      bodyKind: 'command' | 'markdown' | 'text' | null;
      files: ChatFileChange[] | null;
      options: ChatOption[];
      questions: ChatQuestion[] | null;
      /** Deny can carry a note back to the agent ("do it this way instead"). */
      acceptsFeedback: boolean;
      state: 'pending' | 'resolved' | 'cancelled';
      resolution: string | null;
    }
  | { kind: 'notice'; id: string; tone: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'turn'; id: string; ok: boolean; durationMs: number | null; costUsd: number | null; text: string | null };

export type ChatItem = ChatEntry & {
  /** Position in the conversation. */
  seq: number;
  /** Bumped on every change; the higher one wins when updates cross. */
  rev: number;
  at: string;
};

export interface ChatAnswer {
  optionId: string;
  /** Note to the agent with a denial, or free text for a question. */
  message?: string;
  /** Question id → chosen label(s), comma-joined for multi-select. */
  answers?: Record<string, string>;
}

export interface ChatSettingsPatch {
  permission?: string;
  model?: string;
  effort?: string;
}

export interface ExternalAgentProcess {
  pid: number;
  provider: Provider | 'other';
  name: string;
  host: string;
  commandLine: string;
  startedAt: string | null;
  cpuPercent: number;
  memoryMB: number;
  processCount: number;
}

// ---------------------------------------------------------------------------
// Usage analytics
// ---------------------------------------------------------------------------

export interface UsageDay {
  date: string; // YYYY-MM-DD, local time
  byProvider: Record<Provider, number>;
  byProfile: Record<string, number>;
  tokens: number;
  requests: number;
}

export interface UsageSessionRow {
  provider: Provider;
  profileId: string;
  sessionId: string;
  filePath: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  costUsd: number | null;
  tokens: number;
  requests: number;
  contextPercent: number | null;
  compactions: number;
  active: boolean;
}

export interface UsageModelRow {
  provider: Provider;
  model: string;
  usd: number | null;
  tokens: number;
  requests: number;
}

export interface UsageReport {
  generatedAt: string;
  days: UsageDay[];
  sessions: UsageSessionRow[];
  models: UsageModelRow[];
  totals: { today: number; week: number; month: number; range: number };
  scanning: boolean;
  scannedFiles: number;
  pricingDate: string;
}

// ---------------------------------------------------------------------------
// Computer use
// ---------------------------------------------------------------------------

export interface ComputerUseAction {
  timestamp: string;
  agent: string | null;
  command: string;
  target: string | null;
  code: number | null;
  message: string | null;
}

export interface ComputerUseStatus {
  skillSource: string | null;
  stateDir: string;
  active: boolean;
  overlayRunning: boolean;
  agent: string | null;
  action: string | null;
  startedAt: string | null;
  heartbeat: string | null;
  releaseRequested: boolean;
  releasedAt: string | null;
  /** panel | escape | command | reasserted */
  releaseSource: string | null;
  recent: ComputerUseAction[];
  lastScreenshot: string | null;
  policy: { allowedProcesses: string[]; deniedProcesses: string[] };
  builtinDenied: string[];
}

// ---------------------------------------------------------------------------
// Settings & environment
// ---------------------------------------------------------------------------

export type LightPalette = 'cream' | 'grey';

export interface AppSettings {
  activeProfile: Record<Provider, string>;
  cliPath: Record<Provider, string>;
  defaultCwd: string;
  recentCwds: string[];
  theme: 'dark' | 'light' | 'system';
  /** Which palette "light" means (also used by "system" when the OS is light). */
  lightPalette: LightPalette;
  terminalFontSize: number;
  terminalFontFamily: string;
  notifyOnNeedsInput: boolean;
  notifyOnTurnComplete: boolean;
  confirmBeforeStop: boolean;
  /** Assumed context window for Claude models the pricing table doesn't know. */
  claudeContextWindow: number;
  contextWindowOverrides: Record<string, number>;
  usageDays: number;
  codexNoDaemonForIsolated: boolean;
  shellForTerminals: string;
  /** Route Claude Code's status line through the app (keeps the user's own) for exact context, cost and plan limits. */
  claudeStatusLine: boolean;
}

export interface CliInfo {
  provider: Provider;
  path: string | null;
  version: string | null;
  source: string;
  error: string | null;
}

export interface EnvironmentInfo {
  platform: string;
  appVersion: string;
  userDataDir: string;
  profilesDir: string;
  clis: CliInfo[];
  hookServer: string | null;
}

export interface UpdateStatus {
  /** `unsupported`: a development build, which has no installer to update. */
  state: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  /** The version being downloaded or ready to install. */
  version: string | null;
  /** Download progress, 0–100. */
  percent: number | null;
  error: string | null;
  checkedAt: string | null;
}

export interface Toast {
  kind: 'info' | 'success' | 'error';
  message: string;
}

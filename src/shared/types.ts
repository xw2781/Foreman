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
  /** Claude Code's configured `availableModels` allowlist takes precedence over discovery. */
  models: string[] | null;
  discoveredModels?: Array<{ id: string; label: string; resolvedModel?: string }>;
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
  /** Use a Foreman-managed workspace instead of a project folder. */
  projectless?: boolean;
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
  projectless?: boolean;
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
  /** Last completed model turn, retained across resumes for the prompt-cache estimate. */
  lastModelActivityAt?: string | null;
  /** It was running when the app closed: reopened at the next start if its prompt cache is still warm. */
  reopenOnStart?: boolean;
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

/** What a message sent while the agent works does: go into the running turn, or wait for it to end. */
export type ChatSendMode = 'steer' | 'queue';

/**
 * A message sent while the agent was working. `queued`: held by the app and
 * sent as the next turn once the running one ends. `steering`: sent into the
 * running turn; the agent reads it at its next step. `steered`: the agent has
 * taken it in.
 */
export type ChatDelivery = 'queued' | 'steering' | 'steered';

/** One entry of a conversation, as the chat view renders it. Both CLIs' protocols are normalized to this. */
export interface ChatImage {
  name: string;
  dataUrl: string;
}

export interface ChatMessage {
  text: string;
  images?: ChatImage[];
}

export type ChatEntry =
  | { kind: 'user'; id: string; text: string; images?: ChatImage[]; delivery?: ChatDelivery }
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

/** A slash command or skill the chat composer offers. */
export interface ChatCommand {
  /** What follows the trigger: "compact", "anthropic-skills:pdf". */
  name: string;
  /** How it's typed: "/" at the start of a message, or "$" anywhere in it (Codex skills). */
  trigger: '/' | '$';
  kind: 'command' | 'skill';
  description: string;
  argumentHint: string | null;
  aliases: string[];
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
  byMachine: Record<string, number>;
  tokens: number;
  requests: number;
}

/**
 * Usage of one account's model on one computer on one day: the finest split the
 * report keeps, so the Usage page can filter and regroup it any way.
 */
export interface UsageFact {
  date: string;
  provider: Provider;
  profileId: string;
  machineId: string;
  /** Normalized model id (`unknown` when the session didn't name one). */
  model: string;
  /** Null when the model has no list price. */
  usd: number | null;
  tokens: number;
  requests: number;
}

export interface UsageSessionRow {
  provider: Provider;
  profileId: string;
  sessionId: string;
  /** Empty for a session imported from another computer. */
  filePath: string;
  /** The computer the session ran on; null for this one. */
  machineId: string | null;
  machineName: string | null;
  title: string | null;
  cwd: string | null;
  model: string | null;
  /** Reasoning effort the session last ran at; null when unknown (e.g. imported). */
  effort: string | null;
  /** Every model the session used. */
  models: string[];
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
  /** Every day in range by computer, account and model. */
  facts: UsageFact[];
  sessions: UsageSessionRow[];
  models: UsageModelRow[];
  totals: { today: number; week: number; month: number; range: number };
  scanning: boolean;
  scannedFiles: number;
  pricingDate: string;
  /** This computer first, then every computer whose usage was imported or synced. */
  machines: UsageMachine[];
  /** Accounts on other computers that match no account here (by email). */
  remoteAccounts: UsageRemoteAccount[];
}

export interface UsageMachine {
  id: string;
  name: string;
  local: boolean;
  /** When the computer last read its session files. */
  dataAt: string | null;
}

export interface UsageRemoteAccount {
  /** `remote:…`, the key used in UsageDay.byProfile and UsageSessionRow.profileId. */
  id: string;
  provider: Provider;
  label: string;
}

export interface UsageImportResult {
  machines: number;
  added: number;
  updated: number;
  /** Files that held only this computer's own usage. */
  ownOnly: number;
}

export interface UsageExportResult {
  file: string;
  machines: number;
  sessions: number;
}

export interface GitHubSyncStatus {
  /** False when this build has no GitHub OAuth app client ID. */
  available: boolean;
  login: string | null;
  /** owner/name of the private repo holding one usage file per computer. */
  repo: string | null;
  /** Device sign-in waiting for the user to enter the code on github.com. */
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
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
  chatFontSize: number;
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
  /** What Enter does in a chat while the agent is working; Ctrl+Enter does the other. */
  chatSendMode: ChatSendMode;
  /** Whisper model for voice input (see shared/voiceModels). */
  voiceModel: string;
  /** Give new agents Foreman's built-in browser (an MCP server of browser tools). */
  browserEnabled: boolean;
  /** Agents use the browser tools without asking each time. */
  browserAutoApprove: boolean;
  /** One agent profile (cookies, logins) shared by every agent, or a fresh one per agent. */
  browserProfile: BrowserProfileMode;
  /** Show the browser beside the conversation when its agent starts using it. */
  browserAutoOpen: boolean;
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

// ---------------------------------------------------------------------------
// Agent browser
// ---------------------------------------------------------------------------

export type BrowserProfileMode = 'shared' | 'per-agent';

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
}

export interface BrowserActionEntry {
  id: number;
  at: string;
  source: 'agent' | 'user';
  text: string;
  ok: boolean;
}

export interface BrowserDialogInfo {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  /** What the page got back: OK, Cancel, or the prompt text. */
  answer: string;
}

export interface BrowserDownload {
  id: string;
  name: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
}

/** One agent's browser, as the UI shows it. */
export interface BrowserState {
  agentId: string;
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  /** The person has taken over: the agent's browser tools refuse until handed back. */
  paused: boolean;
  /** A browser tool call is running. */
  busy: boolean;
  viewport: { width: number; height: number };
  /** Newest last. */
  actions: BrowserActionEntry[];
  /** Where the agent last pointed, in page pixels; `at` is a timestamp (ms). */
  pointer: { x: number; y: number; at: number } | null;
  /** The last dialog a page showed (answered at once, so nothing waits on it). */
  dialog: BrowserDialogInfo | null;
  /** A page asked for files and is waiting for the agent to choose them. */
  fileChooser: boolean;
  downloads: BrowserDownload[];
  profile: BrowserProfileMode;
}

/** Input from the person, in page pixels, forwarded into the active tab. */
export type BrowserInput =
  | { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; clickCount: number; modifiers: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; modifiers: number; text: string }
  | { kind: 'text'; text: string };

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop' | 'newTab' | 'closeTab' | 'selectTab' | 'devtools' | 'pause' | 'resume' | 'close';

export interface BrowserFrame {
  agentId: string;
  tabId: string;
  width: number;
  height: number;
  /** JPEG. */
  data: Uint8Array;
}

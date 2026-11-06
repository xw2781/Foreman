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
  /** Shown in place of the detected plan tier ("Enterprise", "Max 20x"…). */
  planLabel?: string;
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
  /** Signed in before, but the CLI cleared its tokens (a refresh was rejected). */
  sessionEnded?: boolean;
}

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Shown instead of the percentage, e.g. "$128.17 / $130.00" for a spend cap. */
  detail?: string;
  /** Tooltip in place of the default, e.g. "$15.03 used (12%) · 88% left". */
  hint?: string;
  /** Label for one-line summaries, which then show the percentage left instead of `detail`. */
  shortLabel?: string;
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
  /** The tier as detected, before the account's own planLabel replaces it. */
  detectedPlanTier: string | null;
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
  /** Start as a copy of another conversation (chat mode). */
  fork?: ForkSource;
  extraArgs?: string;
}

/** A message of the copied conversation that a fork stops before. */
export interface ForkPoint {
  itemId: string;
  text: string;
  /** Which message with this text it is (0: the first), for transcripts whose ids differ from the chat's. */
  occurrence: number;
}

/** Where a forked conversation came from. */
export interface ForkSource {
  agentId: string;
  title: string;
  /** The session (Claude Code) or thread (Codex) it copies. */
  sessionId: string;
  /** Copies only what came before this message; absent: the whole conversation. */
  before?: ForkPoint;
  /** Claude Code: the transcript entry the copy ends with, resolved from `before` (null: nothing is copied). */
  through?: string | null;
}

/** One question and answer of a side chat: asked about the conversation, never added to it. */
export interface SideChatExchange {
  question: string;
  answer: string;
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
  /** Latest successful turn or task completion, used by the unread session badge. */
  completedAt?: string | null;
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
  /** Subagents it started (Claude Code's Task/Agent tool, Codex's spawn_agent), oldest first. */
  subagents?: SubagentInfo[];
  /** The conversation it was forked from. */
  forkedFrom?: ForkSource;
  /** A model or effort change made mid-session whose next request hasn't run yet: it rebuilds the prompt cache. */
  cacheRebuild?: CacheRebuild | null;
  /** Claude sessions: what happens when it sits idle (from Settings at launch; changeable per session). */
  idleMode?: IdleMode;
  /** Claude chats: keep the prompt cache warm this many hours after the last reply (0: don't). With idle mode 'compact', the app compacts once they end. */
  keepWarmHours?: number;
  /** The keep-warm refreshes since the last reply; cleared by the next turn. */
  cacheKeepalive?: CacheKeepalive | null;
}

export interface CacheKeepalive {
  /** The model turn being kept warm (`lastModelActivityAt` then). */
  forActivityAt: string;
  /** Latest refresh that worked: the cache lives an hour from here. */
  lastAt: string | null;
  count: number;
  /** A refresh in flight. */
  pending: boolean;
  /** Why the last refresh failed; refreshing stops for this turn. */
  error: string | null;
  /** List-price estimates: one refresh (a cache read), and rebuilding the cache once it has expired. */
  refreshUsd: number | null;
  rebuildUsd: number | null;
  /** When the app sent /compact for this reply, the warm hours over (idle compaction on). */
  compactedAt?: string | null;
}

/**
 * Whether Claude Code may compact a long conversation that sits idle until shortly before its
 * prompt cache expires (its own idle compaction, rolled out per account): 'compact' lets it,
 * 'off' stops it ("idleCompaction": false).
 */
export type IdleMode = 'compact' | 'off';

export interface CacheRebuild {
  /** The model switched to (null: the CLI's default), when the model changed. */
  model?: string | null;
  /** The effort switched to, when only the effort changed. */
  effort?: string;
  at: string;
}

/** What the next request's input costs if a model or effort change goes ahead, against keeping the settings. */
export interface SwitchCost {
  /** Prompt the next request re-sends: the last request's prompt and its reply. */
  contextTokens: number;
  /** Whether the current prompt cache is still estimated warm. */
  cacheWarm: boolean;
  /** `full`: nothing cached is reused (new model). `messages`: the conversation is re-written, tools and system prompt may stay cached. */
  rebuild: 'full' | 'messages' | 'none';
  /** Next request's input at the current settings; null when the model has no list price. */
  stayUsd: number | null;
  /** Next request's input after the change. */
  switchUsd: number | null;
  /** switchUsd - stayUsd. */
  extraUsd: number | null;
}

export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped';

/** One subagent on the agent map. */
export interface SubagentInfo {
  /** Claude: the agent tool call's id. Codex: the child thread's id. */
  id: string;
  /** The subagent that started this one; null when the agent itself did. */
  parentId: string | null;
  /** Claude's subagent_type (Explore, general-purpose…), Codex's role. */
  kind: string;
  description: string | null;
  prompt: string | null;
  model: string | null;
  status: SubagentStatus;
  /** Runs on while its parent carries on (Claude's run_in_background; every Codex child). */
  background: boolean;
  /** A background command (Claude's Bash, PowerShell or Monitor), not a subagent: `kind` is the tool, `prompt` the command. */
  shell?: boolean;
  startedAt: string;
  endedAt: string | null;
  /** What it's doing now, while running. */
  activity: string | null;
  toolUses: number;
  tokens: number | null;
  durationMs: number | null;
  /** The start of its answer, once finished. */
  result: string | null;
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
  isSecret?: boolean;
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
      /** Optional questions expire unanswered; permissions never do. */
      questionOptional?: boolean;
      questionTimeoutAt?: number | null;
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

/** An MCP server a Claude session can use: a claude.ai connector (Microsoft 365, Gmail…) or one configured locally. */
export interface ChatConnector {
  /** The CLI's server name, e.g. "claude.ai Microsoft 365". */
  name: string;
  /** Without the "claude.ai " prefix. */
  label: string;
  /** connected · needs-auth (sign-in required) · pending (still connecting) · failed · disabled. */
  status: 'connected' | 'needs-auth' | 'pending' | 'failed' | 'disabled';
  /** claude.ai connectors are authorized in the person's claude.ai account; local ones by the CLI itself. */
  source: 'claudeai' | 'local';
  tools: number;
  error: string | null;
}

/** The parts the context window is made of, in the order the bar shows them. */
export const CONTEXT_PARTS = ['system', 'tools', 'mcp', 'memory', 'skills', 'messages', 'other'] as const;
export type ContextPart = (typeof CONTEXT_PARTS)[number];

/** What a Claude session's context window holds, by part, as Claude Code reports it (`get_context_usage`). */
export interface ContextUsage {
  model: string;
  usedTokens: number;
  windowTokens: number;
  /** Parts with tokens in the window, in CONTEXT_PARTS order. */
  parts: Array<{ part: ContextPart; label: string; tokens: number }>;
  /** Kept free so the conversation can be compacted before the window fills; 0 when auto-compact is off. */
  bufferTokens: number;
  freeTokens: number;
  /** Tool definitions held out of the window until a search loads them. */
  deferredTokens: number;
  /** Where auto-compact starts; null when it's off. */
  autoCompactAt: number | null;
  memoryFiles: Array<{ path: string; tokens: number }>;
  mcpServers: Array<{ name: string; tools: number; tokens: number }>;
  skills: Array<{ name: string; source: string; tokens: number }>;
  agents: Array<{ name: string; source: string; tokens: number }>;
  /** The conversation's share, by what it is; null before the first message. */
  messages: Array<{ label: string; tokens: number }> | null;
  /** Set on a breakdown kept from when the session last ran: when Claude Code reported it. */
  savedAt?: string;
}

export interface ChatSettingsPatch {
  permission?: string;
  model?: string;
  effort?: string;
}

/** A model and/or effort change to price with `chat.switchCost`. */
export interface SettingsChange {
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
  /** Keep CLIs that Foreman installed on their latest release (new models often need a newer CLI). */
  autoUpdateClis: boolean;
  defaultCwd: string;
  recentCwds: string[];
  /** Project folders added to the session panel, including projects without sessions yet. */
  projectFolders?: string[];
  /** Projects removed from the panel, including folders inferred from existing sessions. */
  hiddenProjectFolders?: string[];
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
  /** What new Claude sessions do when they sit idle; each session can change its own (side panel → Details). */
  claudeIdleMode: IdleMode;
  /** Smallest context idle compaction acts on; 0 keeps Claude Code's default (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS). */
  claudeIdleCompactMinTokens: number;
  /** What Enter does in a chat while the agent is working; Ctrl+Enter does the other. */
  chatSendMode: ChatSendMode;
  /** Offer the next steps an agent suggests at the end of a task as cards to click. */
  chatNextSteps: boolean;
  /** Whisper model for voice input (see shared/voiceModels). */
  voiceModel: string;
  /** Give new agents Foreman's built-in browser (an MCP server of browser tools). */
  browserEnabled: boolean;
  /** Agents use the browser tools without asking each time. */
  browserAutoApprove: boolean;
  /** One agent profile (cookies, logins) shared by every agent, or a fresh one per agent. */
  browserProfile: BrowserProfileMode;
  /** Bring up the side panel's Browser tab when its agent starts using the browser. */
  browserAutoOpen: boolean;
  /** Claude accounts the person turned the computer-use skill off for; every other Claude account gets it automatically. */
  computerUseOptOut: string[];
  /** Refuse agents' hand-written desktop control (SendKeys, SetCursorPos, screen capture…) and point them to the skill. */
  computerUseGuard: boolean;
  /** Show the driving agent's conversation in a panel beside the overlay's action panel. */
  computerUseConversation: boolean;
  /**
   * Folder that holds every account folder (<dir>/<account id>) and the computer-use working folder
   * (<dir>/computer-use), each linked back from its usual place by a junction; '' leaves them where
   * the tools keep them. Changed with `dataDir.move`. Replaces `sessionLogsDir` (transcripts only).
   */
  dataDir: string;
  /** Days Claude Code keeps transcripts (`cleanupPeriodDays`, written to each Claude account's settings.json). */
  claudeSessionRetentionDays: number;
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

/** An entry of a project folder, for the file panel. `path` is relative to the agent's folder, with `/` separators. */
export interface ProjectFileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modifiedMs: number;
}

/** What the file panel shows for one file. */
export type ProjectFilePreview =
  | { kind: 'text'; path: string; size: number; modifiedMs: number; text: string; truncated: boolean }
  | { kind: 'image'; path: string; size: number; modifiedMs: number; dataUrl: string }
  | { kind: 'binary' | 'too-large'; path: string; size: number; modifiedMs: number };

/** Lines added and removed; null for a binary file. */
export type GitLineStats = { added: number; removed: number } | null;

/**
 * A changed file of the working tree. `index` / `worktree` are git's status letters for the
 * staged and unstaged side ('.' unchanged, M modified, A added, D deleted, R renamed, C copied,
 * T type change, U unmerged, '?' untracked). Paths are relative to the repository root, with `/`.
 */
export interface GitFileChange {
  path: string;
  /** The path before a rename or copy. */
  origPath?: string;
  index: string;
  worktree: string;
  conflict: boolean;
  staged?: GitLineStats;
  unstaged?: GitLineStats;
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** ISO time the commit was authored. */
  date: string;
  /** On a remote branch already (false: only on this computer). */
  pushed: boolean;
}

export interface GitWorktree {
  path: string;
  /** Short branch name; null when detached. */
  branch: string | null;
  head: string;
  /** The repository's main working tree (the others are linked worktrees). */
  main: boolean;
  /** The worktree the agent works in. */
  current: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/** The git side of an agent's folder, for the side panel's Git tab. */
export type GitStatus =
  | { repo: false; reason: string }
  | {
      repo: true;
      /** Root of the working tree the agent is in. */
      root: string;
      /** Short branch name; null when HEAD is detached. */
      branch: string | null;
      /** null in a repository with no commits yet. */
      head: { hash: string; short: string; subject: string } | null;
      /** e.g. origin/main; null when the branch tracks nothing. */
      upstream: string | null;
      /** The upstream branch is set but no longer exists. */
      upstreamGone: boolean;
      ahead: number;
      behind: number;
      operation: GitOperation | null;
      stashes: number;
      files: GitFileChange[];
      /** Changed files left out of `files` (very large change sets). */
      omittedFiles: number;
      commits: GitCommit[];
      /** How many remotes the repository has; with none, nothing counts as pushed. */
      remotes: number;
      /** Commits on HEAD that no remote has, counted beyond `commits` too. */
      unpushed: number;
      worktrees: GitWorktree[];
    };

/** Which version of a file a diff compares. */
export type GitDiffTarget =
  | { kind: 'staged' | 'unstaged' | 'untracked'; path: string; origPath?: string }
  | { kind: 'commit'; hash: string; path: string; origPath?: string };

export interface GitDiff {
  /** Unified diff text ('' when nothing differs). */
  text: string;
  binary: boolean;
  truncated: boolean;
}

export interface GitCommitDetails {
  hash: string;
  /** The whole message (subject and body). */
  message: string;
  author: string;
  email: string;
  date: string;
  /** Compared with the first parent for a merge. */
  files: Array<{ path: string; origPath?: string; stats: GitLineStats }>;
}

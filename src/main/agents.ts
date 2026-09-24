import crypto from 'node:crypto';
import path from 'node:path';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as pty from 'node-pty';
import {
  AGENT_MODES,
  CONVERSATION_MODES,
  LIVE_STATUSES,
  PROVIDER_LABEL,
  type AgentInfo,
  type AgentMode,
  type AgentStatus,
  type AppSettings,
  type ChatAnswer,
  type ChatItem,
  type ChatSettingsPatch,
  type LaunchOptions,
  type Profile
} from '../shared/types';
import { claudeCommand, codexCommand, loginCommand, splitArgs } from './commands';
import { ChatLog, clipText } from './chat/log';
import { ClaudeChat, claudeChatArgs } from './chat/claudeChat';
import { CodexChat } from './chat/codexChat';
import { LineSplitter, type ChatDriver, type ChatHost } from './chat/driver';
import { locateCli, spawnSpec } from './cliLocator';
import { ClaudeStreamFormatter, describeToolInput } from './streamFormat';
import type { HookEvent, HookServer } from './hookServer';
import type { ProfileService } from './profiles';
import type { TelemetryClient } from './telemetry/client';
import { killTree, type ProcessMonitor } from './processMonitor';
import { promptTitle } from './telemetry/jsonl';
import { JsonStore, cleanEnv, exists } from './util';
import { defaultStatusText, originalStatusLine, parseStatusPayload, runStatusCommand, type StatusSnapshot } from './statusLine';

const BUFFER_LIMIT = 2_500_000;
const TAIL_LIMIT = 6000;
const HISTORY_LIMIT = 150;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0e-\x1f]/g;

// Approval prompts, matched with all whitespace removed because a TUI redraw
// scatters the words across cursor moves.
const APPROVAL_PATTERNS = [
  /Wouldyouliketo(run|make|grant|send)/i, // Codex
  /Doyouwantto(proceed|make|create|allow|run|overwrite)/i, // Claude Code
  /Doyoutrust(the|this)|Itrustthisfolder/i, // either tool's folder-trust prompt
  /Choosethetextstyle|Selectloginmethod|Pressentertocontinue/i // Claude Code's first-run screens
];

interface Session {
  info: AgentInfo;
  options: LaunchOptions;
  profile: Profile;
  pty: pty.IPty | null;
  child: ChildProcess | null;
  chunks: string[];
  size: number;
  total: number;
  outbox: string;
  tail: string;
  formatter: ClaudeStreamFormatter | null;
  claudeSessionId: string | null;
  settingsFile: string | null;
  hookStatus: 'working' | 'idle' | null;
  needsInput: boolean;
  needsInputSince: number;
  titleLocked: boolean;
  stopping: boolean;
  lastTelemetryKey: string;
  discoveryAttempts: number;
  statusLine: StatusSnapshot | null;
  /** Chat mode: the conversation and the protocol driver behind it. */
  chat: ChatLog | null;
  driver: (ChatDriver & { dispose?: (reason: string) => void }) | null;
  stderrTail: string;
  /** Set when the chat protocol failed to start; the exit then counts as a failure. */
  failure: string | null;
  exitWaiters: Array<() => void>;
}

export interface AgentManagerDeps {
  profiles: ProfileService;
  telemetry: TelemetryClient;
  hooks: HookServer;
  processes: ProcessMonitor;
  settings: () => AppSettings;
  userDataDir: string;
  appVersion: string;
}

function newRunId() {
  return crypto.randomBytes(4).toString('hex');
}

export class AgentManager {
  private sessions = new Map<string, Session>();
  private history: JsonStore<{ agents: AgentInfo[] }>;
  private flushTimer: NodeJS.Timeout | null = null;
  private changed = new Set<string>();
  private changeTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private chatTimer: NodeJS.Timeout | null = null;

  onData: (id: string, data: string, end: number) => void = () => {};
  onChat: (id: string, items: ChatItem[], reset: boolean) => void = () => {};
  onChanged: (agents: AgentInfo[]) => void = () => {};
  onAttention: (info: AgentInfo, reason: 'needs-input' | 'turn-complete' | 'task-complete' | 'failed') => void = () => {};

  constructor(private deps: AgentManagerDeps) {
    this.history = new JsonStore(path.join(deps.userDataDir, 'agents.json'), { agents: [] });
    // Agents from a previous run died with the app; keep them as resumable history.
    const restored = this.history.data.agents.map((agent) => {
      const withRun = { ...agent, runId: agent.runId ?? agent.id };
      return LIVE_STATUSES.includes(agent.status)
        ? { ...withRun, status: 'stopped' as AgentStatus, statusDetail: 'App was closed', endedAt: agent.endedAt ?? agent.lastActivityAt, pid: null, resources: null }
        : withRun;
    });
    this.history.replace({ agents: restored });
    deps.hooks.onEvent = (event) => this.handleHook(event);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(): AgentInfo[] {
    const live = [...this.sessions.values()].map((s) => ({ ...s.info, attached: true }));
    const liveIds = new Set(live.map((a) => a.id));
    const past = this.history.data.agents.filter((a) => !liveIds.has(a.id)).map((a) => ({ ...a, attached: false }));
    return [...live, ...past].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): AgentInfo | undefined {
    return this.sessions.get(id)?.info ?? this.history.data.agents.find((a) => a.id === id);
  }

  buffer(id: string): { data: string; end: number } {
    const session = this.sessions.get(id);
    return session ? { data: session.chunks.join(''), end: session.total } : { data: '', end: 0 };
  }

  runningCount(profileId: string) {
    return [...this.sessions.values()].filter((s) => s.profile.id === profileId && LIVE_STATUSES.includes(s.info.status)).length;
  }

  ownedPids(): number[] {
    return [...this.sessions.values()].map((s) => s.info.pid).filter((pid): pid is number => typeof pid === 'number');
  }

  // -------------------------------------------------------------------------
  // Launching
  // -------------------------------------------------------------------------

  /**
   * Starts an agent. With `reuseId`, a finished agent is continued in place:
   * same id and list entry, a new process (resume, chat/terminal hand-off).
   */
  async launch(options: LaunchOptions, reuseId?: string): Promise<AgentInfo> {
    const profile = this.deps.profiles.require(options.profileId);
    if (profile.provider !== options.provider) throw new Error('That account belongs to a different tool.');
    if (!exists(options.cwd)) throw new Error(`Folder not found: ${options.cwd}`);
    if (options.mode === 'task' && !options.prompt?.trim()) throw new Error('A background task needs a prompt.');
    const settings = this.deps.settings();
    const cli = await locateCli(profile.provider, settings.cliPath[profile.provider]);
    if (!cli.path) throw new Error(cli.error ?? 'CLI not found');

    const previousSession = reuseId ? this.sessions.get(reuseId) : undefined;
    if (previousSession && !previousSession.info.endedAt) throw new Error('This agent is still running.');
    const previous = reuseId ? this.get(reuseId) : undefined;
    const id = reuseId ?? crypto.randomBytes(6).toString('hex');
    let claudeSessionId: string | null = null;
    let settingsFile: string | null = null;
    let args: string[];
    let headless = false;
    let chat: ChatLog | null = null;
    if (options.mode === 'chat') {
      // A chat continued in this run keeps its items; otherwise the session file has them.
      if (previousSession?.chat?.size && previousSession.info.mode === 'chat') chat = previousSession.chat;
      else {
        chat = options.resumeSessionId ? await this.historyLog(profile, options.resumeSessionId, previous?.transcriptPath ?? null) : new ChatLog();
        chat.reset = true;
      }
      if (profile.provider === 'claude') {
        claudeSessionId = options.resumeSessionId ?? crypto.randomUUID();
        args = claudeChatArgs({
          sessionId: options.resumeSessionId ? null : claudeSessionId,
          resumeSessionId: options.resumeSessionId,
          model: options.model,
          effort: options.effort,
          permission: options.permission,
          extraArgs: splitArgs(options.extraArgs)
        });
      } else {
        args = ['app-server', ...splitArgs(options.extraArgs)];
      }
    } else if (options.mode === 'login') {
      args = loginCommand(profile);
    } else if (profile.provider === 'claude') {
      claudeSessionId = options.resumeSessionId ?? crypto.randomUUID();
      settingsFile = this.deps.hooks.settingsFileFor(
        id,
        settings.claudeStatusLine && options.mode !== 'task' ? { refreshInterval: originalStatusLine(profile)?.refreshInterval } : null
      );
      ({ args, headless } = claudeCommand(options, options.resumeSessionId ? null : claudeSessionId, settingsFile));
    } else {
      ({ args, headless } = codexCommand(options, profile, settings.codexNoDaemonForIsolated));
    }

    const title = options.title?.trim()
      || previous?.title
      || (options.mode === 'login' ? `Sign in · ${profile.label}` : null)
      || promptTitle(options.prompt ?? null)
      || `${path.basename(options.cwd) || options.cwd}`;
    const now = new Date().toISOString();
    const info: AgentInfo = {
      id,
      provider: profile.provider,
      profileId: profile.id,
      profileLabel: profile.label,
      profileColor: profile.color,
      cwd: options.cwd,
      mode: options.mode,
      title,
      model: options.model || null,
      permission: options.permission || null,
      status: 'starting',
      statusDetail: null,
      pid: null,
      startedAt: previous?.startedAt ?? now,
      endedAt: null,
      exitCode: null,
      sessionId: options.resumeSessionId ?? claudeSessionId,
      transcriptPath: options.resumeSessionId ? previous?.transcriptPath ?? null : null,
      lastActivityAt: now,
      lastOutputAt: null,
      commandLine: [cli.path, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
      telemetry: null,
      resources: null,
      usesScreen: false,
      prompt: options.prompt ?? previous?.prompt ?? null,
      runId: newRunId()
    };
    const session = this.createSession(info, options, profile, {
      formatter: headless && profile.provider === 'claude' ? new ClaudeStreamFormatter() : null,
      claudeSessionId,
      settingsFile,
      chat,
      titleLocked: Boolean(options.title?.trim()) || options.mode === 'login' || Boolean(previous)
    });

    const env = this.deps.profiles.envFor(profile, cleanEnv());
    env.ATC_AGENT_ID = id;
    env.ATC_AGENT_NAME = `${PROVIDER_LABEL[profile.provider]} · ${profile.label}`;
    env.COLORTERM = 'truecolor';
    this.sessions.set(id, session);

    try {
      if (options.mode === 'chat') this.startChat(session, cli.path, args, env);
      else if (headless) this.startHeadless(session, cli.path, args, env);
      else this.startTerminal(session, cli.path, args, env);
    } catch (error) {
      this.sessions.delete(id);
      if (previousSession) this.sessions.set(id, previousSession);
      if (settingsFile) this.deps.hooks.removeSettingsFile(id);
      throw error;
    }
    this.onRememberCwd(options.cwd);
    this.markChanged(id);
    if (chat) this.scheduleChatFlush();
    return info;
  }

  private createSession(info: AgentInfo, options: LaunchOptions, profile: Profile, extra: Partial<Session> = {}): Session {
    return {
      info,
      options,
      profile,
      pty: null,
      child: null,
      chunks: [],
      size: 0,
      total: 0,
      outbox: '',
      tail: '',
      formatter: null,
      claudeSessionId: null,
      settingsFile: null,
      hookStatus: null,
      needsInput: false,
      needsInputSince: 0,
      titleLocked: false,
      stopping: false,
      lastTelemetryKey: '',
      discoveryAttempts: 0,
      statusLine: null,
      chat: null,
      driver: null,
      stderrTail: '',
      failure: null,
      exitWaiters: [],
      ...extra
    };
  }

  /** A plain shell whose environment points at one account: run anything as that account. */
  async launchShell(profileId: string, cwd: string): Promise<AgentInfo> {
    const profile = this.deps.profiles.require(profileId);
    const id = crypto.randomBytes(6).toString('hex');
    const shell = this.deps.settings().shellForTerminals || 'powershell.exe';
    const now = new Date().toISOString();
    const info: AgentInfo = {
      id,
      provider: profile.provider,
      profileId,
      profileLabel: profile.label,
      profileColor: profile.color,
      cwd,
      mode: 'shell',
      title: `Shell · ${profile.label}`,
      model: null,
      permission: null,
      status: 'starting',
      statusDetail: null,
      pid: null,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      sessionId: null,
      transcriptPath: null,
      lastActivityAt: now,
      lastOutputAt: null,
      commandLine: shell,
      telemetry: null,
      resources: null,
      usesScreen: false,
      prompt: null,
      runId: newRunId()
    };
    const session = this.createSession(info, { provider: profile.provider, profileId, cwd, mode: 'shell' }, profile, { titleLocked: true });
    const env = this.deps.profiles.envFor(profile, cleanEnv());
    env.ATC_AGENT_ID = id;
    env.ATC_AGENT_NAME = `Shell · ${profile.label}`;
    this.sessions.set(id, session);
    this.startTerminal(session, shell, ['-NoLogo'], env);
    const banner = `\x1b[2m# ${PROVIDER_LABEL[profile.provider]} account "${profile.label}" · ${profile.builtin ? 'default config folder' : `${profile.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}=${profile.configDir}`}\x1b[0m\r\n`;
    this.appendOutput(session, banner);
    this.markChanged(id);
    return info;
  }

  private startTerminal(session: Session, file: string, args: string[], env: Record<string, string>) {
    const spec = spawnSpec(file, args);
    const term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: session.info.cwd,
      env,
      useConptyDll: true
    });
    session.pty = term;
    session.info.pid = term.pid;
    term.onData((data) => this.handleOutput(session, data));
    term.onExit(({ exitCode }) => this.handleExit(session, exitCode));
  }

  private startHeadless(session: Session, file: string, args: string[], env: Record<string, string>) {
    const spec = spawnSpec(file, args);
    const child = typeof spec.args === 'string'
      ? spawnChild(spec.file, [spec.args], { cwd: session.info.cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawnChild(spec.file, spec.args, { cwd: session.info.cwd, env, windowsHide: true });
    session.child = child;
    session.info.pid = child.pid ?? null;
    session.info.status = 'working';
    // Both CLIs read piped stdin as extra prompt input; close it so they don't wait.
    child.stdin?.end();
    const decodeOut = new StringDecoder('utf8');
    const decodeErr = new StringDecoder('utf8');
    const emit = (text: string) => {
      if (!text) return;
      const formatted = session.formatter ? session.formatter.push(text) : text.replace(/\r?\n/g, '\r\n');
      if (formatted) this.handleOutput(session, formatted);
    };
    child.stdout?.on('data', (data: Buffer) => emit(decodeOut.write(data)));
    child.stderr?.on('data', (data: Buffer) => {
      const text = decodeErr.write(data);
      if (text) this.handleOutput(session, text.replace(/\r?\n/g, '\r\n'));
    });
    child.on('error', (error) => {
      this.handleOutput(session, `\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
      this.handleExit(session, 1);
    });
    child.on('close', (code) => {
      emit(decodeOut.end());
      if (session.formatter) {
        const rest = session.formatter.flush();
        if (rest) this.handleOutput(session, rest);
      }
      this.handleExit(session, code ?? 1);
    });
  }

  /** Chat mode: the CLI's structured protocol over pipes, rendered by the app's chat view. */
  private startChat(session: Session, file: string, args: string[], env: Record<string, string>) {
    const spec = spawnSpec(file, args);
    const child = typeof spec.args === 'string'
      ? spawnChild(spec.file, [spec.args], { cwd: session.info.cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawnChild(spec.file, spec.args, { cwd: session.info.cwd, env, windowsHide: true });
    session.child = child;
    session.info.pid = child.pid ?? null;
    const write = (message: object) => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const host = this.chatHost(session);
    const options = session.options;
    const driver: NonNullable<Session['driver']> = session.profile.provider === 'claude'
      ? new ClaudeChat(host, write)
      : new CodexChat(host, write, {
          cwd: session.info.cwd,
          resumeThreadId: options.resumeSessionId,
          model: options.model,
          effort: options.effort,
          permission: options.permission,
          appVersion: this.deps.appVersion
        });
    session.driver = driver;
    const decodeOut = new StringDecoder('utf8');
    const decodeErr = new StringDecoder('utf8');
    const lines = new LineSplitter((line) => {
      try {
        driver.receive(line);
      } catch (error) {
        console.error('chat protocol error', error);
      }
    });
    child.stdout?.on('data', (data: Buffer) => lines.push(decodeOut.write(data)));
    child.stderr?.on('data', (data: Buffer) => {
      session.stderrTail = (session.stderrTail + decodeErr.write(data)).slice(-6000);
    });
    // Writing to a process that just exited raises EPIPE; the exit handler reports it.
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      session.failure = error.message;
      this.handleExit(session, 1);
    });
    child.on('close', (code) => {
      lines.push(decodeOut.end());
      lines.end();
      driver.dispose?.('The process exited');
      this.handleExit(session, code ?? 1);
    });
    driver.start(options.prompt).catch((error: Error) => {
      if (session.info.endedAt) return;
      session.failure = `Couldn't start ${PROVIDER_LABEL[session.profile.provider]}: ${error.message}`;
      try {
        child.kill();
      } catch {
        // already gone
      }
    });
  }

  private chatHost(session: Session): ChatHost {
    const info = session.info;
    return {
      log: session.chat!,
      changed: () => this.scheduleChatFlush(),
      status: (status, detail) => {
        if (info.endedAt) return;
        session.needsInput = status === 'needs-input';
        if (session.needsInput) session.needsInputSince = Date.now();
        info.lastOutputAt = new Date().toISOString();
        this.updateStatus(session, status, detail);
      },
      session: (update) => {
        if (update.sessionId && update.sessionId !== info.sessionId) {
          info.sessionId = update.sessionId;
          session.claudeSessionId = session.profile.provider === 'claude' ? update.sessionId : session.claudeSessionId;
        }
        if (update.transcriptPath) info.transcriptPath = update.transcriptPath;
        if (update.model !== undefined) info.model = update.model || null;
        if (update.permission) info.permission = update.permission;
        if (update.title && !session.titleLocked) info.title = update.title;
        this.markChanged(info.id);
      },
      turnComplete: () => {
        this.refreshTelemetry(session).catch(() => {});
      },
      limits: (limits) => this.deps.profiles.applyReportedLimits(session.profile.id, limits)
    };
  }

  /** A past conversation as a chat log, from the CLI's session file. */
  private async historyLog(profile: Profile, sessionId: string | null, knownPath: string | null): Promise<ChatLog> {
    const log = new ChatLog();
    let file = knownPath;
    try {
      if (!file && sessionId) {
        file = profile.provider === 'claude'
          ? await this.deps.telemetry.findClaudeTranscript(profile.configDir, sessionId)
          : await this.deps.telemetry.findCodexRolloutById(profile.configDir, sessionId);
      }
      if (!file || !exists(file)) return log;
      for (const { entry, at } of await this.deps.telemetry.chatHistory(profile.provider, file)) log.upsert(entry, at ?? undefined);
    } catch (error) {
      log.upsert({ kind: 'notice', id: 'history-error', tone: 'warning', text: `Couldn't load earlier messages: ${error instanceof Error ? error.message : String(error)}` });
    }
    log.takeDirty();
    return log;
  }

  private scheduleChatFlush() {
    if (this.chatTimer) return;
    this.chatTimer = setTimeout(() => {
      this.chatTimer = null;
      for (const session of this.sessions.values()) {
        const chat = session.chat;
        if (!chat?.hasChanges) continue;
        const reset = chat.reset;
        chat.reset = false;
        const dirty = chat.takeDirty();
        this.onChat(session.info.id, reset ? chat.list() : dirty, reset);
      }
    }, 40);
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  async chatItems(id: string): Promise<ChatItem[]> {
    const session = this.sessions.get(id);
    if (session?.chat) return session.chat.list();
    const info = this.get(id);
    if (!info || !CONVERSATION_MODES.includes(info.mode)) return [];
    const profile = this.deps.profiles.list().find((p) => p.id === info.profileId);
    if (!profile) return [];
    const log = await this.historyLog(profile, info.telemetry?.sessionId ?? info.sessionId, info.transcriptPath);
    return log.list();
  }

  /** Sends a chat message; a chat that has ended is resumed in place with it. */
  async chatSend(id: string, text: string): Promise<AgentInfo> {
    if (!text.trim()) throw new Error('Type a message first.');
    const session = this.sessions.get(id);
    if (session && !session.info.endedAt) {
      if (!session.driver) throw new Error('This agent runs in the terminal; type your message there.');
      session.driver.send(text);
      session.info.lastActivityAt = new Date().toISOString();
      return session.info;
    }
    const info = this.get(id);
    if (!info) throw new Error('Unknown agent');
    return this.continueAgent(info, 'chat', text);
  }

  chatInterrupt(id: string) {
    this.sessions.get(id)?.driver?.interrupt();
  }

  chatRespond(id: string, itemId: string, answer: ChatAnswer) {
    const session = this.sessions.get(id);
    if (!session?.driver || session.info.endedAt) throw new Error('This conversation is no longer running.');
    session.driver.respond(itemId, answer);
  }

  chatConfigure(id: string, patch: ChatSettingsPatch) {
    const session = this.sessions.get(id);
    if (session?.driver && !session.info.endedAt) {
      session.driver.configure(patch);
      if (patch.effort) session.options = { ...session.options, effort: patch.effort };
      return;
    }
    // Not running: remembered for when the conversation continues.
    const apply = (info: AgentInfo) => ({
      ...info,
      permission: patch.permission ?? info.permission,
      model: patch.model !== undefined ? patch.model || null : info.model
    });
    if (session) {
      Object.assign(session.info, apply(session.info));
      if (patch.effort) session.options = { ...session.options, effort: patch.effort };
      this.markChanged(id);
    } else {
      this.history.replace({ agents: this.history.data.agents.map((a) => (a.id === id ? apply(a) : a)) });
      this.emitChanged();
    }
  }

  /** Relaunches a finished agent's conversation in place, as a chat or in the terminal. */
  private continueAgent(info: AgentInfo, mode: AgentMode, prompt?: string): Promise<AgentInfo> {
    const sessionId = info.telemetry?.sessionId ?? info.sessionId;
    // Only a conversation the CLI actually saved can be resumed; an empty one starts over.
    const resumable = Boolean(sessionId && (info.transcriptPath || info.telemetry));
    if (!resumable && mode !== 'chat') throw new Error('This agent never started a session that can be resumed.');
    const effort = this.sessions.get(info.id)?.options.effort;
    return this.launch(
      {
        provider: info.provider,
        profileId: info.profileId,
        cwd: info.cwd,
        mode,
        title: info.title,
        model: info.model ?? undefined,
        effort,
        permission: info.permission ?? undefined,
        resumeSessionId: resumable ? sessionId! : undefined,
        prompt
      },
      info.id
    );
  }

  private waitForExit(session: Session): Promise<void> {
    if (session.info.endedAt) return Promise.resolve();
    return new Promise((resolve) => session.exitWaiters.push(resolve));
  }

  onRememberCwd: (cwd: string) => void = () => {};
  onHookEvent: (event: HookEvent) => void = () => {};

  // -------------------------------------------------------------------------
  // Output, input, exit
  // -------------------------------------------------------------------------

  private handleOutput(session: Session, data: string) {
    this.appendOutput(session, data);
    const info = session.info;
    const now = new Date().toISOString();
    info.lastOutputAt = now;
    info.lastActivityAt = now;
    if (info.status === 'starting') {
      info.status = info.mode === 'task' || (session.options.prompt && info.mode === 'interactive') ? 'working' : 'idle';
      this.markChanged(info.id);
    }
    if (info.mode === 'interactive' || info.mode === 'login') {
      const plain = data.replace(ANSI, '');
      session.tail = (session.tail + plain).slice(-TAIL_LIMIT);
      if (!session.needsInput) {
        const compact = session.tail.slice(-2500).replace(/\s+/g, '');
        if (APPROVAL_PATTERNS.some((pattern) => pattern.test(compact))) {
          session.needsInput = true;
          session.needsInputSince = Date.now();
          this.updateStatus(session, 'needs-input', 'Waiting for your approval');
        }
      }
    }
  }

  private appendOutput(session: Session, data: string) {
    session.chunks.push(data);
    session.size += data.length;
    session.total += data.length;
    while (session.size > BUFFER_LIMIT && session.chunks.length > 1) {
      session.size -= session.chunks.shift()!.length;
    }
    session.outbox += data;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const session of this.sessions.values()) {
        if (!session.outbox) continue;
        const data = session.outbox;
        session.outbox = '';
        this.onData(session.info.id, data, session.total);
      }
    }, 12);
  }

  write(id: string, data: string) {
    const session = this.sessions.get(id);
    if (!session?.pty) return;
    session.pty.write(data);
    session.info.lastActivityAt = new Date().toISOString();
    // Any keypress answers (or dismisses) a pending approval prompt.
    if (session.needsInput) {
      session.needsInput = false;
      session.tail = '';
      this.updateStatus(session, session.info.mode === 'login' ? 'idle' : 'working', null);
    } else if (session.info.mode === 'interactive' && /[\r\n]/.test(data) && session.info.status === 'idle' && session.profile.provider === 'codex') {
      // Codex reports its turn start via the rollout a moment later; show it now.
      this.updateStatus(session, 'working', null);
    }
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.sessions.get(id);
    if (!session?.pty || cols < 2 || rows < 2) return;
    try {
      session.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // resizing a pty that just exited throws; harmless
    }
  }

  private handleExit(session: Session, exitCode: number) {
    const info = session.info;
    if (info.endedAt) return;
    info.endedAt = new Date().toISOString();
    info.exitCode = exitCode;
    info.pid = null;
    info.resources = null;
    session.needsInput = false;
    let status: AgentStatus;
    if (session.failure) status = 'failed';
    else if (session.stopping) status = 'stopped';
    else if (info.mode === 'task') {
      const failed = exitCode !== 0 || session.formatter?.result?.isError;
      status = failed ? 'failed' : 'done';
    } else status = exitCode === 0 ? 'done' : 'failed';
    info.status = status;
    info.statusDetail = session.failure ? 'Failed to start' : session.stopping ? 'Stopped' : `Exited with code ${exitCode}`;
    if (session.chat) {
      session.chat.settle(session.stopping ? 'Stopped' : 'The process exited');
      if (status === 'failed') {
        const log = session.stderrTail.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).slice(-12).join('\n');
        const text = session.failure ?? `${PROVIDER_LABEL[session.profile.provider]} exited unexpectedly (code ${exitCode}).`;
        session.chat.upsert({ kind: 'notice', id: `exit-${info.runId}`, tone: 'error', text: log ? `${text}\n\n${clipText(log, 2000)}` : text });
      }
      this.scheduleChatFlush();
    } else {
      this.handleOutput(session, `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    }
    info.status = status; // handleOutput may not revert this, but be explicit
    for (const resolve of session.exitWaiters.splice(0)) resolve();
    if (session.settingsFile) this.deps.hooks.removeSettingsFile(info.id);
    if (info.mode === 'task' && !session.stopping) this.onAttention(info, status === 'failed' ? 'failed' : 'task-complete');
    if (info.mode === 'login') this.deps.profiles.refresh([session.profile.id]).catch(() => {});
    // Pick up the final telemetry once, then archive.
    this.refreshTelemetry(session)
      .catch(() => {})
      .finally(() => {
        this.archive(info);
        this.pruneFinished();
        this.markChanged(info.id);
      });
  }

  /** Finished agents keep their terminal output for review; only the most recent few, to bound memory. */
  private pruneFinished(keep = 25) {
    const finished = [...this.sessions.values()]
      .filter((s) => s.info.endedAt)
      .sort((a, b) => (b.info.endedAt ?? '').localeCompare(a.info.endedAt ?? ''));
    for (const session of finished.slice(keep)) this.sessions.delete(session.info.id);
  }

  private archive(info: AgentInfo) {
    if (info.mode === 'shell' || info.mode === 'login') return;
    const agents = [{ ...info }, ...this.history.data.agents.filter((a) => a.id !== info.id)].slice(0, HISTORY_LIMIT);
    this.history.replace({ agents });
  }

  async stop(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.info.endedAt) return;
    session.stopping = true;
    const pid = session.info.pid;
    if (pid) await killTree(pid);
    try {
      session.pty?.kill();
      session.child?.kill();
    } catch {
      // already exited
    }
  }

  /** Removes a finished agent from the list (and its terminal buffer). */
  remove(id: string) {
    const session = this.sessions.get(id);
    if (session && !session.info.endedAt) throw new Error('Stop the agent before removing it.');
    this.sessions.delete(id);
    this.history.replace({ agents: this.history.data.agents.filter((a) => a.id !== id) });
    this.emitChanged();
  }

  clearFinished() {
    for (const [id, session] of this.sessions) {
      if (session.info.endedAt) this.sessions.delete(id);
    }
    this.history.replace({ agents: [] });
    this.emitChanged();
  }

  rename(id: string, title: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.info.title = title.trim() || session.info.title;
      session.titleLocked = true;
      this.markChanged(id);
    } else {
      this.history.replace({ agents: this.history.data.agents.map((a) => (a.id === id ? { ...a, title: title.trim() || a.title } : a)) });
      this.emitChanged();
    }
  }

  /**
   * Continues an agent's conversation in place, as a chat or in the terminal
   * (default: the way it ran). A running agent in the other mode is stopped
   * first and handed over.
   */
  async resume(id: string, mode?: AgentMode): Promise<AgentInfo> {
    let info = this.get(id);
    if (!info) throw new Error('Unknown agent');
    if (!CONVERSATION_MODES.includes(info.mode)) throw new Error('Only conversations can be resumed.');
    const target = mode ?? (info.mode === 'chat' ? 'chat' : 'interactive');
    const live = this.sessions.get(id);
    if (live && !live.info.endedAt) {
      if (live.info.mode === target) return live.info;
      if (target !== 'chat' && !(info.sessionId && (info.transcriptPath || info.telemetry))) {
        throw new Error('Send a message first: there is no conversation to open in the terminal yet.');
      }
      live.stopping = true;
      const exited = this.waitForExit(live);
      await this.stop(id);
      await exited;
      // The process is gone; pick up where its session file ended.
      await this.refreshTelemetry(live).catch(() => {});
      info = live.info;
    }
    return this.continueAgent(info, target);
  }

  async stopAll() {
    await Promise.all([...this.sessions.values()].filter((s) => !s.info.endedAt).map((s) => this.stop(s.info.id)));
    this.history.flush();
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private updateStatus(session: Session, status: AgentStatus, detail: string | null | undefined) {
    const info = session.info;
    if (info.endedAt) return;
    const previous = info.status;
    if (previous === status && (detail === undefined || detail === info.statusDetail)) return;
    info.status = status;
    if (detail !== undefined) info.statusDetail = detail;
    info.lastActivityAt = new Date().toISOString();
    this.markChanged(info.id);
    if (status === 'needs-input' && previous !== 'needs-input') this.onAttention(info, 'needs-input');
    if (status === 'idle' && previous === 'working' && CONVERSATION_MODES.includes(info.mode)) this.onAttention(info, 'turn-complete');
  }

  private handleHook(event: HookEvent) {
    const session = this.sessions.get(event.agentId);
    if (!session || session.info.endedAt) return;
    this.onHookEvent(event);
    const payload = event.payload;
    if (session.info.mode === 'task') {
      // A background task is working until its process exits; hooks only say what it's doing.
      if (event.name === 'PreToolUse') {
        const tool = String(payload.tool_name ?? 'tool');
        const detail = describeToolInput(tool, payload.tool_input);
        session.info.statusDetail = detail ? `${tool}: ${detail}` : tool;
        this.markChanged(session.info.id);
      }
      return;
    }
    if (typeof payload.session_id === 'string') {
      if (session.info.sessionId !== payload.session_id) {
        // /clear and /resume switch the conversation; follow it.
        session.info.sessionId = payload.session_id;
        session.info.transcriptPath = null;
        session.info.telemetry = null;
      }
    }
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      session.info.transcriptPath = payload.transcript_path;
    }
    switch (event.name) {
      case 'SessionStart':
        session.hookStatus = 'idle';
        if (session.info.status === 'starting') this.updateStatus(session, 'idle', null);
        break;
      case 'UserPromptSubmit':
        session.hookStatus = 'working';
        session.needsInput = false;
        this.updateStatus(session, 'working', 'Thinking');
        break;
      case 'PreToolUse': {
        session.hookStatus = 'working';
        const tool = String(payload.tool_name ?? 'tool');
        const detail = describeToolInput(tool, payload.tool_input);
        if (!session.needsInput) this.updateStatus(session, 'working', detail ? `${tool}: ${detail}` : tool);
        break;
      }
      case 'PostToolUse':
        session.hookStatus = 'working';
        if (session.needsInput) session.needsInput = false;
        this.updateStatus(session, 'working', undefined);
        break;
      case 'Notification': {
        const type = String(payload.notification_type ?? '');
        if (type === 'permission_prompt' || type === 'elicitation_dialog' || type === 'agent_needs_input') {
          session.needsInput = true;
          session.needsInputSince = Date.now();
          this.updateStatus(session, 'needs-input', typeof payload.message === 'string' ? payload.message : 'Waiting for your input');
        } else if (type === 'idle_prompt') {
          session.hookStatus = 'idle';
          if (!session.needsInput) this.updateStatus(session, 'idle', null);
        }
        break;
      }
      case 'Stop':
        session.hookStatus = 'idle';
        session.needsInput = false;
        this.updateStatus(session, 'idle', 'Turn complete');
        break;
      case 'SessionEnd':
        session.hookStatus = 'idle';
        break;
      default:
        break;
    }
  }

  /**
   * Claude Code's status-line payload for an agent: keeps the authoritative
   * context size, cost and plan limits, then answers with what the user's own
   * status line would have printed (or a compact default).
   */
  async handleStatusLine(agentId: string, payload: Record<string, any>): Promise<string> {
    const session = this.sessions.get(agentId);
    if (!session) return '';
    const snapshot = parseStatusPayload(payload);
    session.statusLine = snapshot;
    if (snapshot.limits) this.deps.profiles.applyReportedLimits(session.profile.id, snapshot.limits);
    if (session.info.telemetry) this.applyStatusLine(session);
    const original = originalStatusLine(session.profile);
    if (original) {
      const env = this.deps.profiles.envFor(session.profile, cleanEnv());
      const text = await runStatusCommand(original.command, JSON.stringify(payload), session.info.cwd, env);
      // A status line that prints nothing (e.g. a pure capture bridge) gets the app's summary instead.
      if (text !== null && text.trim()) return text;
    }
    return defaultStatusText(snapshot, session.profile.label);
  }

  private applyStatusLine(session: Session) {
    const t = session.info.telemetry;
    const s = session.statusLine;
    if (!t || !s || Date.now() - s.at > 10 * 60_000) return;
    if (s.contextWindow > 0) {
      t.contextWindow = s.contextWindow;
      t.contextWindowAssumed = false;
      t.contextUsedTokens = s.usedTokens || t.contextUsedTokens;
      t.contextPercent = s.usedPercent ?? (t.contextUsedTokens / s.contextWindow) * 100;
    }
    if (s.costUsd !== null) t.cost = { ...t.cost, reportedUsd: s.costUsd };
    t.source = 'status-line';
    this.changed.add(session.info.id);
  }

  // -------------------------------------------------------------------------
  // Periodic work: session discovery, telemetry, resources
  // -------------------------------------------------------------------------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const live = [...this.sessions.values()].filter((s) => !s.info.endedAt && AGENT_MODES.includes(s.info.mode));
      await Promise.all(live.map((session) => this.refreshTelemetry(session).catch(() => {})));
      for (const session of this.sessions.values()) {
        if (!session.info.pid) continue;
        const resources = this.deps.processes.treeResources(session.info.pid);
        if (resources) {
          session.info.resources = resources;
          this.changed.add(session.info.id);
        }
      }
      if (this.changed.size > 0) this.scheduleChanged();
    } finally {
      this.ticking = false;
    }
  }

  private async locateSessionFile(session: Session): Promise<string | null> {
    const info = session.info;
    if (info.transcriptPath) return info.transcriptPath;
    session.discoveryAttempts += 1;
    const { telemetry } = this.deps;
    const configDir = session.profile.configDir;
    let found: string | null = null;
    if (session.profile.provider === 'claude') {
      const id = info.sessionId ?? session.claudeSessionId;
      if (id) found = await telemetry.findClaudeTranscript(configDir, id);
    } else if (session.options.resumeSessionId || info.mode === 'chat') {
      // A chat knows its thread id from the app-server; no guessing by folder and time.
      const id = info.mode === 'chat' ? info.sessionId : session.options.resumeSessionId;
      if (id) found = await telemetry.findCodexRolloutById(configDir, id);
    } else {
      const claimed = [...this.sessions.values()].map((s) => s.info.transcriptPath).filter((p): p is string => Boolean(p));
      found = await telemetry.findCodexRollout(configDir, info.cwd, Date.parse(info.startedAt), claimed);
    }
    if (found) info.transcriptPath = found;
    return found;
  }

  private async refreshTelemetry(session: Session) {
    const info = session.info;
    const file = await this.locateSessionFile(session);
    if (!file) return;
    const telemetry = await this.deps.telemetry.sessionTelemetry(session.profile.provider, session.profile.id, file);
    if (!telemetry) return;
    const key = JSON.stringify([telemetry.updatedAt, telemetry.requests, telemetry.contextUsedTokens, telemetry.title, telemetry.taskActive, telemetry.cost.totalUsd, telemetry.cost.reportedUsd]);
    if (key === session.lastTelemetryKey) return;
    session.lastTelemetryKey = key;
    info.telemetry = telemetry;
    this.applyStatusLine(session);
    info.sessionId = telemetry.sessionId;
    if (telemetry.model) info.model = telemetry.model;
    if (!session.titleLocked && telemetry.title) info.title = telemetry.title;
    if (!info.endedAt && info.mode === 'interactive' && !session.needsInput) {
      // Hooks are authoritative for Claude; telemetry fills in when none arrived.
      const useTelemetry = session.profile.provider === 'codex' || session.hookStatus === null;
      if (useTelemetry && telemetry.taskActive !== null) {
        this.updateStatus(session, telemetry.taskActive ? 'working' : 'idle', telemetry.taskActive ? undefined : null);
      }
    }
    this.changed.add(info.id);
  }

  setScreenDriver(agentId: string | null) {
    for (const session of this.sessions.values()) {
      const uses = session.info.id === agentId && !session.info.endedAt;
      if (session.info.usesScreen !== uses) {
        session.info.usesScreen = uses;
        this.changed.add(session.info.id);
      }
    }
    if (this.changed.size > 0) this.scheduleChanged();
  }

  // -------------------------------------------------------------------------
  // Change notification
  // -------------------------------------------------------------------------

  private markChanged(id: string) {
    this.changed.add(id);
    this.scheduleChanged();
  }

  private scheduleChanged() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.changed.clear();
      this.emitChanged();
    }, 60);
  }

  private emitChanged() {
    this.onChanged(this.list());
  }
}

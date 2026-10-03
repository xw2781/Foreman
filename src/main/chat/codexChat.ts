import type { ChatImage } from '../../shared/types';
// Codex's app-server protocol (`codex app-server`, the one Codex's own IDE
// extension and desktop app use): newline-delimited JSON-RPC over stdio.
// We call initialize → thread/start|resume → turn/start; the server streams
// item and turn notifications and asks for approvals as server requests.
import { randomUUID } from 'node:crypto';
import type { ChatAnswer, ChatCommand, ChatOption, ChatQuestion, ChatSettingsPatch, TokenUsage } from '../../shared/types';
import { LONG_CONTEXT_THRESHOLD, priceUsage, rateForModel } from '../telemetry/pricing';
import { normalizeCodexUsage, subtractUsage } from '../telemetry/codexRollout';
import { codexItemEntry, codexPermission } from './codexItems';
import type { ChatDriver, ChatHost } from './driver';
import { clipText, TEXT_LIMIT } from './log';

interface PendingServerRequest {
  rpcId: number | string;
  method: string;
  params: any;
}

const APPROVAL_OPTIONS: ChatOption[] = [
  { id: 'allow', label: 'Allow', tone: 'primary' },
  { id: 'allow-session', label: 'Allow for this session', tone: 'normal' },
  { id: 'deny', label: 'Deny', tone: 'danger' },
  { id: 'cancel', label: 'Deny and stop', tone: 'normal' }
];

const COMMAND = /^\/(compact|review)(?:\s+([\s\S]*))?$/;

const DECISIONS: Record<string, string> = { allow: 'accept', 'allow-session': 'acceptForSession', deny: 'decline', cancel: 'cancel' };
const RESOLUTIONS: Record<string, string> = { allow: 'Allowed', 'allow-session': 'Allowed for this session', deny: 'Denied', cancel: 'Denied · turn stopped' };

/** Codex's own apps handle these client-side; here they map onto app-server calls. */
const CODEX_COMMANDS: ChatCommand[] = [
  { name: 'compact', trigger: '/', kind: 'command', description: 'Summarize the conversation to free up context', argumentHint: null, aliases: [] },
  { name: 'review', trigger: '/', kind: 'command', description: 'Review uncommitted changes, or what you describe', argumentHint: '[instructions]', aliases: [] }
];

interface CodexSkill {
  name: string;
  path: string;
  description: string;
}

/** `$name` mentions of known skills; a plugin skill ("pdf:pdf") also answers to its short name. */
export function mentionedSkills(text: string, skills: CodexSkill[]): CodexSkill[] {
  const found: CodexSkill[] = [];
  for (const match of text.matchAll(/(?:^|\s)\$([\w][\w:.-]*)/g)) {
    const name = match[1].replace(/[.:]+$/, '');
    const skill = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.split(':').pop() === name);
    if (skill && !found.includes(skill)) found.push(skill);
  }
  return found;
}

export interface CodexChatOptions {
  cwd: string;
  resumeThreadId?: string;
  model?: string;
  effort?: string;
  permission?: string;
  appVersion: string;
}

export class CodexChat implements ChatDriver {
  private nextId = 1;
  private calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private requests = new Map<string, PendingServerRequest>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  /** The running turn's id, once `turn/start` answers (null if it didn't start one). */
  private turnStarting: Promise<string | null> | null = null;
  /** Reviews and compactions don't take mid-turn input. */
  private steerable = true;
  /** Messages sent before the thread existed. */
  private early: Array<{ id: string; text: string; images: ChatImage[] }> = [];
  private overrides: Record<string, unknown> = {};
  /** The thread's model when none is chosen, and the one in use now (for pricing). */
  private defaultModel: string | null = null;
  private model: string | null = null;
  private usageTotal: TokenUsage | null = null;
  /** API-equivalent cost of the running turn; null once any request couldn't be priced. */
  private turnCost: number | null = 0;
  private initialized: Promise<unknown> | null = null;
  /** `skills/list`, fetched once and again after `skills/changed`. */
  private skills: Promise<CodexSkill[]> | null = null;
  private knownSkills: CodexSkill[] = [];
  busy = false;

  constructor(private host: ChatHost, private write: (message: object) => void, private options: CodexChatOptions) {}

  async start(prompt?: string, images?: ChatImage[]) {
    this.initialized = this.call('initialize', { clientInfo: { name: 'foreman', title: 'Foreman', version: this.options.appVersion }, capabilities: null });
    await this.initialized;
    this.write({ method: 'initialized' });
    const permission = codexPermission(this.options.permission);
    const params = {
      cwd: this.options.cwd,
      model: this.options.model || null,
      approvalPolicy: permission.approvalPolicy ?? null,
      sandbox: permission.sandbox ?? null,
      // Only sent when set: older app-servers don't know the field.
      ...(permission.approvalsReviewer ? { approvalsReviewer: permission.approvalsReviewer } : {}),
      config: this.options.effort ? { model_reasoning_effort: this.options.effort } : null
    };
    const result = this.options.resumeThreadId
      ? await this.call('thread/resume', { threadId: this.options.resumeThreadId, ...params, excludeTurns: true })
      : await this.call('thread/start', params);
    this.threadId = result.thread.id;
    this.defaultModel = typeof result.model === 'string' ? result.model : null;
    this.model = this.options.model || this.defaultModel;
    this.host.session({ sessionId: result.thread.id, transcriptPath: result.thread.path ?? undefined, model: result.model });
    this.host.status('idle', null);
    // Known skills turn `$name` mentions into skill inputs.
    this.loadSkills();
    if (prompt?.trim() || images?.length) this.send(prompt ?? '', undefined, images);
    for (const message of this.early.splice(0)) {
      if (this.busy) this.steer(message.id, message.text, message.images);
      else this.dispatch(message.id, message.text, message.images);
    }
  }

  send(text: string, itemId: string = randomUUID(), images: ChatImage[] = []) {
    const command = images.length ? null : COMMAND.exec(text.trim());
    if (command && this.busy) throw new Error(`Codex is working; /${command[1]} can run once this turn ends.`);
    if (this.busy) {
      this.steer(itemId, text, images);
      return;
    }
    this.host.log.upsert({ kind: 'user', id: itemId, text, images });
    this.host.changed();
    if (!this.threadId) this.early.push({ id: itemId, text, images });
    else this.dispatch(itemId, text, images);
  }

  canSteer(text: string) {
    return this.steerable && !COMMAND.test(text.trim());
  }

  /** Mid-turn messages steer the running turn, as in Codex's own apps. */
  private async steer(id: string, text: string, images: ChatImage[]) {
    this.host.log.upsert({ kind: 'user', id, text, images, delivery: 'steering' });
    this.host.changed();
    try {
      const turnId = this.turnId ?? (await this.turnStarting);
      if (!turnId || !this.threadId || !this.steerable) throw new Error('No turn to steer');
      await this.call('turn/steer', { threadId: this.threadId, clientUserMessageId: id, input: this.input(text, images), expectedTurnId: turnId });
      this.host.log.update(id, 'user', (item) => (item.delivery === 'steering' ? { delivery: 'steered' } : {}));
    } catch {
      // The turn ended first, or it's one that takes no input: the message waits for the next.
      this.host.requeue(id);
    }
    this.host.changed();
  }

  /** A new turn: the message, or the command it names. */
  private dispatch(id: string, text: string, images: ChatImage[]) {
    const command = images.length ? null : COMMAND.exec(text.trim());
    this.steerable = !command;
    if (command?.[1] === 'compact') {
      this.begin('Compacting', this.call('thread/compact/start', { threadId: this.threadId }));
    } else if (command?.[1] === 'review') {
      const instructions = command[2]?.trim();
      const target = instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' };
      this.begin('Reviewing', this.call('review/start', { threadId: this.threadId, target, delivery: 'inline' }));
    } else {
      const overrides = this.overrides;
      this.overrides = {};
      this.begin('Thinking', this.call('turn/start', { threadId: this.threadId, clientUserMessageId: id, input: this.input(text, images), ...overrides }));
    }
  }

  private begin(detail: string, started: Promise<any>) {
    this.busy = true;
    this.host.status('working', detail);
    this.turnStarting = started.then(
      (result) => (result?.turn?.status === 'inProgress' ? String(result.turn.id) : null),
      () => null
    );
    started
      .then((result) => {
        if (result?.turn?.id && result.turn.status === 'inProgress') this.turnId = result.turn.id;
      })
      .catch((error) => {
        this.busy = false;
        this.notice('error', error.message);
        this.host.status('idle', 'Turn failed');
      });
  }

  private input(text: string, images: ChatImage[]) {
    const skills = mentionedSkills(text, this.knownSkills).map((s) => ({ type: 'skill', name: s.name, path: s.path }));
    return [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map((image) => ({ type: 'image', url: image.dataUrl })), ...skills];
  }

  private loadSkills(): Promise<CodexSkill[]> {
    this.skills ??= this.call('skills/list', { cwds: [this.options.cwd] })
      .then((result) => {
        const seen = new Set<string>();
        this.knownSkills = (Array.isArray(result?.data) ? result.data : [])
          .flatMap((entry: any) => (Array.isArray(entry?.skills) ? entry.skills : []))
          .filter((s: any) => s?.enabled !== false && typeof s?.name === 'string' && typeof s?.path === 'string' && !seen.has(s.name) && seen.add(s.name))
          .map((s: any) => ({ name: s.name, path: s.path, description: String(s.interface?.shortDescription || s.shortDescription || s.description || '') }));
        return this.knownSkills;
      })
      .catch(() => {
        this.skills = null;
        return this.knownSkills;
      });
    return this.skills;
  }

  async commands(): Promise<ChatCommand[]> {
    try {
      if (!this.initialized) return CODEX_COMMANDS;
      await this.initialized;
    } catch {
      return CODEX_COMMANDS;
    }
    const skills = await this.loadSkills();
    return [...CODEX_COMMANDS, ...skills.map((s): ChatCommand => ({ name: s.name, trigger: '$', kind: 'skill', description: s.description, argumentHint: null, aliases: [] }))];
  }

  interrupt() {
    if (this.threadId && this.turnId) this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  configure(patch: ChatSettingsPatch) {
    if (patch.permission) {
      const permission = codexPermission(patch.permission);
      if (permission.approvalPolicy) this.overrides.approvalPolicy = permission.approvalPolicy;
      if (permission.sandboxPolicy) this.overrides.sandboxPolicy = permission.sandboxPolicy;
      if (permission.approvalsReviewer) this.overrides.approvalsReviewer = permission.approvalsReviewer;
      this.host.session({ permission: patch.permission });
    }
    if (patch.model !== undefined) {
      this.overrides.model = patch.model || null;
      this.model = patch.model || this.defaultModel;
      this.host.session({ model: patch.model });
    }
    if (patch.effort) this.overrides.effort = patch.effort;
  }

  respond(itemId: string, answer: ChatAnswer) {
    const request = this.requests.get(itemId);
    if (!request) return;
    this.requests.delete(itemId);
    let result: Record<string, unknown>;
    let resolution: string;
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        result = { decision: DECISIONS[answer.optionId] ?? 'decline' };
        resolution = RESOLUTIONS[answer.optionId] ?? 'Denied';
        break;
      case 'item/tool/requestUserInput': {
        const answers: Record<string, { answers: string[] }> = {};
        if (answer.optionId === 'answer') {
          for (const [id, value] of Object.entries(answer.answers ?? {})) if (value) answers[id] = { answers: [value] };
        }
        result = { answers };
        resolution = answer.optionId === 'answer' ? Object.values(answer.answers ?? {}).filter(Boolean).join(' · ') || 'Answered' : 'Skipped';
        break;
      }
      case 'item/permissions/requestApproval': {
        const requested = request.params?.permissions ?? {};
        const granted: Record<string, unknown> = {};
        if (answer.optionId !== 'deny') {
          if (requested.network) granted.network = requested.network;
          if (requested.fileSystem) granted.fileSystem = requested.fileSystem;
        }
        result = { permissions: granted, scope: answer.optionId === 'allow-session' ? 'session' : 'turn' };
        resolution = RESOLUTIONS[answer.optionId] ?? 'Denied';
        break;
      }
      case 'mcpServer/elicitation/request':
        result = { action: answer.optionId === 'allow' ? 'accept' : 'decline', content: answer.optionId === 'allow' ? {} : null, _meta: null };
        resolution = answer.optionId === 'allow' ? 'Accepted' : 'Declined';
        break;
      default:
        return;
    }
    this.write({ id: request.rpcId, result });
    this.host.log.update(itemId, 'approval', () => ({ state: 'resolved', resolution }));
    if (this.requests.size === 0) this.host.status('working', null);
    this.host.changed();
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  receive(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message ?? 'Codex request failed'));
      else call.resolve(message.result);
      return;
    }
    if (message.id !== undefined) this.onServerRequest(message);
    else if (message.method) this.onNotification(message.method, message.params ?? {});
    this.host.changed();
  }

  /** Fails every call still waiting (the process exited). */
  dispose(reason: string) {
    for (const call of this.calls.values()) call.reject(new Error(reason));
    this.calls.clear();
  }

  private onNotification(method: string, params: any) {
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = params.turn?.id ?? this.turnId;
        this.turnCost = 0;
        this.busy = true;
        this.host.status('working', 'Thinking');
        break;
      case 'item/started':
      case 'item/completed': {
        const entry = codexItemEntry(params.item);
        if (!entry) break;
        const existing = this.host.log.get(entry.id);
        if (entry.kind === 'assistant') {
          const text = entry.text || (existing?.kind === 'assistant' ? existing.text : '');
          if (text) this.host.log.upsert({ ...entry, text, streaming: method === 'item/started' });
        } else if (entry.kind === 'tool') {
          // Output streamed through deltas is kept until the completed item carries the full text.
          const output = entry.output ?? (existing?.kind === 'tool' ? existing.output : null);
          this.host.log.upsert({ ...entry, output });
          if (method === 'item/started') this.host.status('working', entry.detail ? `${entry.title} ${entry.detail}`.slice(0, 120) : entry.title);
        } else if (entry.kind === 'reasoning') {
          this.host.log.upsert({ ...entry, streaming: method === 'item/started' });
        } else if (entry.kind === 'user') {
          // One of ours coming back: a steer shows up here once Codex takes it in.
          if (existing?.kind === 'user' && existing.images?.length) entry.images = existing.images;
          const delivery = existing?.kind === 'user' ? existing.delivery : undefined;
          this.host.log.upsert(delivery ? { ...entry, delivery: delivery === 'steering' ? 'steered' : delivery } : entry);
        } else {
          this.host.log.upsert(entry);
        }
        break;
      }
      case 'item/agentMessage/delta':
        this.append(params.itemId, 'assistant', params.delta);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.append(params.itemId, 'reasoning', params.delta);
        break;
      case 'item/reasoning/summaryPartAdded':
        this.append(params.itemId, 'reasoning', '\n\n');
        break;
      case 'item/commandExecution/outputDelta': {
        const item = this.host.log.get(params.itemId);
        if (item?.kind === 'tool') this.host.log.upsert({ ...item, output: clipText((item.output ?? '') + String(params.delta ?? ''), TEXT_LIMIT * 2) });
        break;
      }
      case 'turn/completed':
        this.onTurnCompleted(params.turn);
        break;
      case 'error':
        if (params.willRetry) this.host.status('working', `Retrying: ${params.error?.message ?? 'error'}`.slice(0, 120));
        else this.notice('error', params.error?.message ?? 'Codex reported an error');
        break;
      case 'warning':
        if (params.message) this.notice('warning', params.message);
        break;
      case 'serverRequest/resolved':
        for (const [itemId, request] of this.requests) {
          if (request.rpcId !== params.requestId) continue;
          this.requests.delete(itemId);
          this.host.log.update(itemId, 'approval', () => ({ state: 'cancelled', resolution: 'Resolved' }));
        }
        break;
      case 'thread/tokenUsage/updated':
        this.onTokenUsage(params.tokenUsage);
        break;
      case 'thread/name/updated':
        if (params.threadName) this.host.session({ title: params.threadName });
        break;
      case 'skills/changed':
        this.skills = null;
        this.loadSkills();
        break;
      default:
        break;
    }
  }

  private append(itemId: string, kind: 'assistant' | 'reasoning', delta: unknown) {
    if (!itemId || typeof delta !== 'string') return;
    const item = this.host.log.get(itemId);
    const text = (item?.kind === kind ? item.text : '') + delta;
    if (text.trim()) this.host.log.upsert({ kind, id: itemId, text, streaming: true });
  }

  /** Prices each model request as its usage arrives, the way the rollout parser does. */
  private onTokenUsage(tokenUsage: any) {
    const snake = (value: any) =>
      value && {
        input_tokens: value.inputTokens,
        cached_input_tokens: value.cachedInputTokens,
        cache_write_input_tokens: value.cacheWriteInputTokens,
        output_tokens: value.outputTokens,
        reasoning_output_tokens: value.reasoningOutputTokens,
        total_tokens: value.totalTokens
      };
    const total = normalizeCodexUsage(snake(tokenUsage?.total));
    const last = normalizeCodexUsage(snake(tokenUsage?.last));
    // The first report of a resumed thread carries its whole history: count only its last request.
    const delta = total && this.usageTotal ? subtractUsage(total, this.usageTotal) ?? last : last;
    if (total) this.usageTotal = total;
    if (!delta || this.turnCost === null) return;
    const rate = rateForModel(this.model);
    this.turnCost = rate ? this.turnCost + priceUsage(rate, delta, (last?.inputTokens ?? 0) > LONG_CONTEXT_THRESHOLD) : null;
  }

  private onTurnCompleted(turn: any) {
    if (!turn) return;
    if (this.turnId === turn.id || !this.turnId) this.turnId = null;
    this.turnStarting = null;
    this.steerable = true;
    this.busy = false;
    const status = String(turn.status ?? 'completed');
    const ok = status === 'completed';
    const interrupted = status === 'interrupted';
    if (!ok) this.host.log.settle(interrupted ? 'Interrupted' : 'Turn failed');
    for (const [itemId] of this.requests) this.host.log.update(itemId, 'approval', () => ({ state: 'cancelled', resolution: 'Turn ended' }));
    this.requests.clear();
    this.host.log.upsert({
      kind: 'turn',
      id: `turn-${turn.id}`,
      ok: ok || interrupted,
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
      costUsd: this.turnCost || null,
      text: interrupted ? 'Interrupted' : ok ? null : turn.error?.message ?? 'Turn failed'
    });
    this.host.status('idle', interrupted ? 'Interrupted' : ok ? 'Turn complete' : 'Turn failed');
    this.host.turnComplete();
  }

  private onServerRequest(message: any) {
    const { id: rpcId, method } = message;
    const params = message.params ?? {};
    const itemId = `approval-${rpcId}`;
    let title: string;
    let detail: string | null = typeof params.reason === 'string' ? params.reason : null;
    let body: string | null = null;
    let bodyKind: 'command' | 'markdown' | 'text' | null = null;
    let files = null;
    let options = APPROVAL_OPTIONS;
    let questions: ChatQuestion[] | null = null;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const item = this.host.log.get(params.itemId);
        title = 'Allow this command?';
        body = params.command ?? (item?.kind === 'tool' ? item.input : null);
        bodyKind = 'command';
        break;
      }
      case 'item/fileChange/requestApproval': {
        const item = this.host.log.get(params.itemId);
        title = 'Apply these changes?';
        files = item?.kind === 'tool' ? item.files : null;
        if (params.grantRoot) detail = `${detail ? `${detail} · ` : ''}Write access to ${params.grantRoot}`;
        break;
      }
      case 'item/permissions/requestApproval':
        title = 'Grant additional permissions?';
        body = JSON.stringify(params.permissions ?? {}, null, 2);
        bodyKind = 'text';
        options = APPROVAL_OPTIONS.filter((o) => o.id !== 'cancel').map((o) => (o.id === 'allow' ? { ...o, label: 'Allow for this turn' } : o));
        break;
      case 'item/tool/requestUserInput':
        title = 'Codex has a question';
        questions = (Array.isArray(params.questions) ? params.questions : []).map((q: any) => ({
          id: String(q.id),
          header: String(q.header ?? ''),
          question: String(q.question ?? ''),
          multiSelect: false,
          options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ label: String(o.label), description: o.description || undefined })),
          allowOther: Boolean(q.isOther) || !Array.isArray(q.options) || q.options.length === 0
        }));
        options = [
          { id: 'answer', label: 'Submit', tone: 'primary' },
          { id: 'deny', label: 'Skip', tone: 'normal' }
        ];
        break;
      case 'mcpServer/elicitation/request':
        title = `${params.serverName ?? 'An MCP server'} asks`;
        detail = params.message ?? null;
        body = params.url ?? null;
        bodyKind = params.url ? 'text' : null;
        options = [
          { id: 'allow', label: 'Accept', tone: 'primary' },
          { id: 'deny', label: 'Decline', tone: 'normal' }
        ];
        break;
      default:
        // Auth refresh, dynamic tools, attestation: nothing the app provides.
        this.write({ id: rpcId, error: { code: -32601, message: `${method} is not supported by Foreman` } });
        return;
    }
    this.requests.set(itemId, { rpcId, method, params });
    this.host.log.upsert({
      kind: 'approval',
      id: itemId,
      tool: method,
      title,
      detail,
      body,
      bodyKind,
      files,
      options,
      questions,
      acceptsFeedback: false,
      state: 'pending',
      resolution: null
    });
    this.host.status('needs-input', title);
  }

  private notice(tone: 'info' | 'warning' | 'error', text: string) {
    this.host.log.upsert({ kind: 'notice', id: `notice-${Date.now().toString(36)}-${this.nextId++}`, tone, text });
    this.host.changed();
  }

  /** Codex keeps the name in its session index, so its own apps show it too. */
  rename(title: string) {
    if (this.threadId) this.call('thread/name/set', { threadId: this.threadId, name: title }).catch(() => {});
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
}

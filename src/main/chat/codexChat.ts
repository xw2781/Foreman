// Codex's app-server protocol (`codex app-server`, the one Codex's own IDE
// extension and desktop app use): newline-delimited JSON-RPC over stdio.
// We call initialize → thread/start|resume → turn/start; the server streams
// item and turn notifications and asks for approvals as server requests.
import type { ChatAnswer, ChatOption, ChatQuestion, ChatSettingsPatch, TokenUsage } from '../../shared/types';
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

const DECISIONS: Record<string, string> = { allow: 'accept', 'allow-session': 'acceptForSession', deny: 'decline', cancel: 'cancel' };
const RESOLUTIONS: Record<string, string> = { allow: 'Allowed', 'allow-session': 'Allowed for this session', deny: 'Denied', cancel: 'Denied · turn stopped' };

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
  private queued: Array<{ id: string; text: string }> = [];
  private overrides: Record<string, unknown> = {};
  private userCounter = 0;
  /** The thread's model when none is chosen, and the one in use now (for pricing). */
  private defaultModel: string | null = null;
  private model: string | null = null;
  private usageTotal: TokenUsage | null = null;
  /** API-equivalent cost of the running turn; null once any request couldn't be priced. */
  private turnCost: number | null = 0;
  busy = false;

  constructor(private host: ChatHost, private write: (message: object) => void, private options: CodexChatOptions) {}

  async start(prompt?: string) {
    await this.call('initialize', { clientInfo: { name: 'foreman', title: 'Foreman', version: this.options.appVersion }, capabilities: null });
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
    if (prompt?.trim()) this.send(prompt);
    for (const message of this.queued.splice(0)) this.startTurn(message.id, message.text);
  }

  send(text: string) {
    const id = `user-${Date.now().toString(36)}-${++this.userCounter}`;
    this.host.log.upsert({ kind: 'user', id, text });
    this.host.changed();
    if (!this.threadId) {
      this.queued.push({ id, text });
      return;
    }
    if (this.turnId) {
      // Mid-turn messages steer the running turn, as in Codex's own apps.
      this.call('turn/steer', { threadId: this.threadId, clientUserMessageId: id, input: this.input(text), expectedTurnId: this.turnId }).catch((error) => this.notice('error', error.message));
      return;
    }
    this.startTurn(id, text);
  }

  private startTurn(id: string, text: string) {
    this.busy = true;
    this.host.status('working', 'Thinking');
    const overrides = this.overrides;
    this.overrides = {};
    this.call('turn/start', { threadId: this.threadId, clientUserMessageId: id, input: this.input(text), ...overrides })
      .then((result) => {
        if (result?.turn?.id && result.turn.status === 'inProgress') this.turnId = result.turn.id;
      })
      .catch((error) => {
        this.busy = false;
        this.notice('error', error.message);
        this.host.status('idle', 'Turn failed');
      });
  }

  private input(text: string) {
    return [{ type: 'text', text, text_elements: [] }];
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

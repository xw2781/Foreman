// Claude Code's SDK protocol: `claude --input-format stream-json
// --output-format stream-json --permission-prompt-tool stdio`. User messages
// and control requests go in on stdin; conversation events, streaming deltas
// and permission requests (`can_use_tool`) come out on stdout.
import type { ChatAnswer, ChatOption, ChatQuestion, ChatSettingsPatch } from '../../shared/types';
import { describeToolInput } from '../streamFormat';
import { parseStatusPayload } from '../statusLine';
import { claudeFileChanges, claudeToolEntry, claudeToolTitle, toolResultText } from './claudeTools';
import type { ChatDriver, ChatHost } from './driver';
import { clipText } from './log';

interface Block {
  id: string;
  kind: 'assistant' | 'reasoning' | 'tool';
  text: string;
}

interface PendingPermission {
  requestId: string;
  tool: string;
  toolUseId: string | null;
  input: Record<string, any>;
  suggestions: unknown[];
}

export function claudeChatArgs(options: {
  sessionId: string | null;
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  permission?: string;
  extraArgs?: string[];
}): string[] {
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  else if (options.sessionId) args.push('--session-id', options.sessionId);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permission && options.permission !== 'default') args.push('--permission-mode', options.permission);
  args.push(...(options.extraArgs ?? []));
  return args;
}

function alwaysLabel(suggestions: any[]): string {
  const first = suggestions[0];
  const scope = first?.destination === 'session' ? ' this session' : '';
  if (first?.type === 'setMode' && first.mode === 'acceptEdits') return 'Allow all edits this session';
  if (first?.type === 'addRules' && Array.isArray(first.rules) && first.rules[0]) {
    const rule = first.rules[0];
    const text = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
    return `Always allow ${text}${scope}`;
  }
  if (first?.type === 'addDirectories' && Array.isArray(first.directories)) return `Always allow ${first.directories[0]}${scope}`;
  return `Always allow${scope}`;
}

function questionsFrom(input: Record<string, any>): ChatQuestion[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.map((q: any, index: number) => ({
    id: String(q?.question ?? index),
    header: String(q?.header ?? `Question ${index + 1}`),
    question: String(q?.question ?? ''),
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? o), description: typeof o?.description === 'string' ? o.description : undefined })),
    allowOther: true
  }));
}

export class ClaudeChat implements ChatDriver {
  private messageId: string | null = null;
  private blocks = new Map<number, Block>();
  private blockCounters = new Map<string, number>();
  private pending = new Map<string, PendingPermission>();
  private toolStarts = new Map<string, number>();
  private declined = new Set<string>();
  private requestCounter = 0;
  private userCounter = 0;
  private interrupting = false;
  private lastTotalCost = 0;
  busy = false;

  constructor(private host: ChatHost, private write: (message: object) => void) {}

  async start(prompt?: string) {
    // The CLI says nothing until the first message arrives.
    this.host.status('idle', null);
    if (prompt?.trim()) this.send(prompt);
  }

  send(text: string) {
    const id = `user-${Date.now().toString(36)}-${++this.userCounter}`;
    this.host.log.upsert({ kind: 'user', id, text });
    this.write({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    this.busy = true;
    this.host.status('working', 'Thinking');
    this.host.changed();
  }

  interrupt() {
    if (!this.busy) return;
    this.interrupting = true;
    this.request({ subtype: 'interrupt' });
  }

  configure(patch: ChatSettingsPatch) {
    if (patch.permission) {
      this.request({ subtype: 'set_permission_mode', mode: patch.permission });
      this.host.session({ permission: patch.permission });
    }
    if (patch.model !== undefined) {
      this.request({ subtype: 'set_model', model: patch.model || 'default' });
      this.host.session({ model: patch.model });
    }
  }

  respond(itemId: string, answer: ChatAnswer) {
    const pending = this.pending.get(itemId);
    if (!pending) return;
    this.pending.delete(itemId);
    let response: Record<string, unknown>;
    let resolution: string;
    switch (answer.optionId) {
      case 'allow':
        response = { behavior: 'allow', updatedInput: pending.input };
        resolution = 'Allowed';
        break;
      case 'allow-always':
        response = { behavior: 'allow', updatedInput: pending.input, updatedPermissions: pending.suggestions };
        resolution = 'Always allowed';
        break;
      case 'answer': {
        const answers = answer.answers ?? {};
        response = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
        resolution = Object.values(answers).filter(Boolean).join(' · ') || 'Answered';
        break;
      }
      case 'plan-accept-edits':
      case 'plan-default': {
        const mode = answer.optionId === 'plan-accept-edits' ? 'acceptEdits' : 'default';
        response = { behavior: 'allow', updatedInput: pending.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
        resolution = mode === 'acceptEdits' ? 'Plan approved · edits auto-accepted' : 'Plan approved';
        this.host.session({ permission: mode });
        break;
      }
      default: {
        const note = answer.message?.trim();
        const fallback = pending.tool === 'AskUserQuestion' ? 'The user skipped the question.' : pending.tool === 'ExitPlanMode' ? 'The user wants to keep planning.' : 'The user declined this action.';
        response = { behavior: 'deny', message: note || fallback };
        resolution = `${pending.tool === 'ExitPlanMode' ? 'Kept planning' : pending.tool === 'AskUserQuestion' ? 'Skipped' : 'Denied'}${note ? ` — ${note}` : ''}`;
        if (pending.toolUseId) this.declined.add(pending.toolUseId);
      }
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: pending.requestId, response } });
    this.host.log.update(itemId, 'approval', () => ({ state: 'resolved', resolution }));
    if (this.pending.size === 0) this.host.status('working', null);
    this.host.changed();
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  receive(line: string) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // Messages of a subagent (Task tool) belong to that tool call, not the main conversation.
    if (event.parent_tool_use_id) return;
    switch (event.type) {
      case 'stream_event':
        this.onStream(event.event);
        break;
      case 'assistant':
        this.onAssistant(event.message);
        break;
      case 'user':
        this.onUser(event);
        break;
      case 'system':
        this.onSystem(event);
        break;
      case 'result':
        this.onResult(event);
        break;
      case 'control_request':
        this.onControlRequest(event);
        break;
      case 'control_cancel_request':
        this.onCancel(event.request_id);
        break;
      case 'rate_limit_event':
        this.onRateLimit(event.rate_limit_info);
        break;
      default:
        return;
    }
    this.host.changed();
  }

  private onStream(event: any) {
    if (!event) return;
    switch (event.type) {
      case 'message_start':
        this.messageId = event.message?.id ?? `m${Date.now()}`;
        this.blocks.clear();
        break;
      case 'content_block_start': {
        const block = event.content_block ?? {};
        const id = block.type === 'tool_use' || block.type === 'server_tool_use' ? block.id : `${this.messageId}:${event.index}`;
        if (block.type === 'text') this.blocks.set(event.index, { id, kind: 'assistant', text: block.text ?? '' });
        else if (block.type === 'thinking') this.blocks.set(event.index, { id, kind: 'reasoning', text: block.thinking ?? '' });
        else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && id) {
          this.blocks.set(event.index, { id, kind: 'tool', text: '' });
          this.toolStarts.set(id, Date.now());
          if (!this.host.log.get(id)) this.host.log.upsert(claudeToolEntry(id, block.name, null));
          this.host.status('working', claudeToolTitle(block.name));
        }
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(event.index);
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'text_delta' && block.kind === 'assistant') {
          block.text += delta.text ?? '';
          if (block.text) this.host.log.upsert({ kind: 'assistant', id: block.id, text: block.text, streaming: true });
        } else if (delta.type === 'thinking_delta' && block.kind === 'reasoning') {
          block.text += delta.thinking ?? '';
          if (block.text) this.host.log.upsert({ kind: 'reasoning', id: block.id, text: block.text, streaming: true });
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(event.index);
        if (block && block.kind !== 'tool' && block.text) this.host.log.upsert({ kind: block.kind, id: block.id, text: block.text, streaming: false });
        break;
      }
      default:
        break;
    }
  }

  /** Complete content blocks; with partial messages on, each arrives right after its stream. */
  private onAssistant(message: any) {
    const messageId = message?.id ?? `m${Date.now()}`;
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      const index = this.blockCounters.get(messageId) ?? 0;
      this.blockCounters.set(messageId, index + 1);
      const id = `${messageId}:${index}`;
      if (block.type === 'text' && block.text?.trim()) {
        this.host.log.upsert({ kind: 'assistant', id, text: block.text, streaming: false });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        this.host.log.upsert({ kind: 'reasoning', id, text: block.thinking, streaming: false });
      } else if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id) {
        const existing = this.host.log.get(block.id);
        const entry = claudeToolEntry(block.id, block.name, block.input);
        if (!this.toolStarts.has(block.id)) this.toolStarts.set(block.id, Date.now());
        this.host.log.upsert(existing?.kind === 'tool' ? { ...entry, status: existing.status, output: existing.output, durationMs: existing.durationMs } : entry);
      }
    }
  }

  private onUser(event: any) {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    const declinedByRule = new Set<string>(
      (Array.isArray(event.tool_result_meta) ? event.tool_result_meta : []).filter((m: any) => m?.non_execution_kind).map((m: any) => String(m.id))
    );
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const id = String(block.tool_use_id ?? '');
      const started = this.toolStarts.get(id);
      const declined = this.declined.has(id) || (block.is_error && declinedByRule.has(id));
      this.host.log.update(id, 'tool', () => ({
        output: clipText(toolResultText(block.content)),
        status: declined ? 'declined' : block.is_error ? 'error' : 'done',
        durationMs: started ? Date.now() - started : null
      }));
    }
  }

  private onSystem(event: any) {
    if (event.subtype === 'init') {
      this.host.session({ sessionId: event.session_id, model: event.model, permission: event.permissionMode });
    } else if (event.subtype === 'compact_boundary') {
      this.host.log.upsert({ kind: 'notice', id: `compact-${event.uuid ?? Date.now()}`, tone: 'info', text: 'Context compacted' });
    }
  }

  private onResult(event: any) {
    const interrupted = this.interrupting;
    this.interrupting = false;
    this.busy = false;
    const ok = !event.is_error && event.subtype === 'success';
    const total = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
    const cost = total !== null && total >= this.lastTotalCost ? total - this.lastTotalCost : total;
    if (total !== null) this.lastTotalCost = total;
    let text: string | null = null;
    if (interrupted) text = 'Interrupted';
    else if (!ok) text = (typeof event.result === 'string' && event.result) || (Array.isArray(event.errors) ? event.errors.join('\n') : '') || String(event.subtype ?? 'Failed');
    if (!ok) this.host.log.settle(interrupted ? 'Interrupted' : 'Turn ended');
    for (const [itemId] of this.pending) this.host.log.update(itemId, 'approval', () => ({ state: 'cancelled', resolution: 'Turn ended' }));
    this.pending.clear();
    this.host.log.upsert({
      kind: 'turn',
      id: `turn-${event.uuid ?? Date.now()}`,
      ok: ok || interrupted,
      durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
      costUsd: cost,
      text
    });
    this.host.status('idle', interrupted ? 'Interrupted' : ok ? 'Turn complete' : 'Turn failed');
    this.host.turnComplete();
  }

  private onControlRequest(event: any) {
    const request = event.request ?? {};
    if (request.subtype !== 'can_use_tool') {
      // Hooks and SDK MCP servers aren't used by the app; say so rather than leave the CLI waiting.
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: `Unsupported request: ${request.subtype}` } });
      return;
    }
    const tool = String(request.tool_name ?? 'tool');
    const input: Record<string, any> = request.input && typeof request.input === 'object' ? request.input : {};
    const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
    const itemId = `approval-${event.request_id}`;
    let title: string;
    let body: string | null = null;
    let bodyKind: 'command' | 'markdown' | 'text' | null = null;
    let options: ChatOption[];
    let questions: ChatQuestion[] | null = null;
    let detail: string | null = null;
    if (tool === 'AskUserQuestion') {
      title = 'Claude has a question';
      questions = questionsFrom(input);
      options = [
        { id: 'answer', label: 'Submit', tone: 'primary' },
        { id: 'deny', label: 'Skip', tone: 'normal' }
      ];
    } else if (tool === 'ExitPlanMode') {
      title = 'Ready to start?';
      body = typeof input.plan === 'string' ? input.plan : null;
      bodyKind = 'markdown';
      options = [
        { id: 'plan-accept-edits', label: 'Yes, auto-accept edits', tone: 'primary' },
        { id: 'plan-default', label: 'Yes, ask before edits', tone: 'normal' },
        { id: 'deny', label: 'Keep planning', tone: 'normal' }
      ];
    } else {
      const file = typeof input.file_path === 'string' ? input.file_path.split(/[\\/]/).pop() : null;
      title = `Allow ${request.display_name ?? tool}?`;
      if (file && tool === 'Write') title = `Create ${file}?`;
      else if (file && ['Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) title = `Edit ${file}?`;
      if (tool === 'Bash' || tool === 'PowerShell') {
        title = `Allow ${tool === 'Bash' ? 'this command' : 'this PowerShell command'}?`;
        body = typeof input.command === 'string' ? input.command : null;
        bodyKind = 'command';
      } else if (!claudeFileChanges(tool, input)) {
        body = clipText(JSON.stringify(input, null, 2), 6000);
        bodyKind = 'text';
      }
      detail = request.decision_reason ?? request.description ?? input.description ?? (describeToolInput(tool, input) || null);
      options = [{ id: 'allow', label: 'Allow', tone: 'primary' }];
      if (suggestions.length && !request.suppress_always_allow_rule) options.push({ id: 'allow-always', label: alwaysLabel(suggestions), tone: 'normal' });
      options.push({ id: 'deny', label: 'Deny', tone: 'danger' });
    }
    this.pending.set(itemId, { requestId: event.request_id, tool, toolUseId: request.tool_use_id ?? null, input, suggestions });
    this.host.log.upsert({
      kind: 'approval',
      id: itemId,
      tool,
      title,
      detail: typeof detail === 'string' ? detail : null,
      body,
      bodyKind,
      files: claudeFileChanges(tool, input),
      options,
      questions,
      acceptsFeedback: tool !== 'AskUserQuestion',
      state: 'pending',
      resolution: null
    });
    this.host.status('needs-input', title);
  }

  private onCancel(requestId: string) {
    const itemId = `approval-${requestId}`;
    if (!this.pending.delete(itemId)) return;
    this.host.log.update(itemId, 'approval', () => ({ state: 'cancelled', resolution: 'No longer needed' }));
    if (this.pending.size === 0 && this.busy) this.host.status('working', null);
  }

  private onRateLimit(info: any) {
    const windows = info?.unifiedWindows;
    if (!windows || typeof windows !== 'object') return;
    const rateLimits: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries<any>(windows)) {
      const utilization = Number(entry?.utilization);
      if (!Number.isFinite(utilization)) continue;
      rateLimits[id] = { used_percentage: utilization <= 1 ? utilization * 100 : utilization, resets_at: entry?.resetsAt };
    }
    const { limits } = parseStatusPayload({ rate_limits: rateLimits });
    if (limits) this.host.limits(limits);
  }

  private request(request: Record<string, unknown>) {
    this.write({ type: 'control_request', request_id: `atc-${++this.requestCounter}`, request });
  }
}

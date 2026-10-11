// The subagents an agent has started, for the agent map. Three sources feed
// it: Claude Code's stream-json (chat mode: `Task`/`Agent` tool calls, the
// subagent's own messages tagged with `parent_tool_use_id`, and the
// `task_*` system events of background agents), Claude Code's hooks
// (terminal and task modes: the same tool calls, with less detail), and
// Codex's app-server (`collabAgentToolCall` items and the child threads'
// notifications). Pure apart from the clock: tested on its own.
import type { SubagentInfo, SubagentStatus } from '../shared/types';
import { claudeToolDetail, claudeToolTitle, toolResultText } from './chat/claudeTools';
import { codexItemEntry } from './chat/codexItems';
import { clipText } from './chat/log';

/** Claude Code's tools that start a subagent (renamed from Task to Agent in 2.x). */
const AGENT_TOOLS = new Set(['Task', 'Agent']);
/** Oldest finished ones go first beyond this. */
const NODE_LIMIT = 60;

function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim() ? clipText(value.trim(), limit) : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function activityOf(title: string, detail: string | null) {
  return clipText(detail ? `${title} ${detail}` : title, 160);
}

/** Running nodes left behind (by an exit or an interrupt) end as stopped; finished ones stay as they were. */
export function settleSubagents(nodes: SubagentInfo[], at = new Date().toISOString()): SubagentInfo[] {
  return nodes.map((n) => (n.status === 'running' ? { ...n, status: 'stopped', endedAt: n.endedAt ?? at, activity: null } : n));
}

export class SubagentTracker {
  private nodes = new Map<string, SubagentInfo>();
  /** Claude background agents: task id → tool_use id. */
  private tasks = new Map<string, string>();

  constructor(previous: SubagentInfo[] = [], private onChange: () => void = () => {}, private now = () => new Date().toISOString()) {
    for (const node of settleSubagents(previous)) this.nodes.set(node.id, node);
  }

  list(): SubagentInfo[] {
    return [...this.nodes.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get running() {
    let count = 0;
    for (const node of this.nodes.values()) if (node.status === 'running') count++;
    return count;
  }

  // -------------------------------------------------------------------------
  // Claude Code: stream-json events
  // -------------------------------------------------------------------------

  /** One stream-json event from `claude --output-format stream-json`, before the chat driver sees it. */
  claude(event: any) {
    if (!event || typeof event !== 'object') return;
    const parent = typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null;
    if (event.type === 'assistant') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        if (AGENT_TOOLS.has(block.name)) this.claudeStart(block.id, block.input, parent);
        else if (parent) this.claudeStep(parent, String(block.name ?? 'tool'), block.input);
      }
    } else if (event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        this.claudeResult(block.tool_use_id, Boolean(block.is_error), toolResultText(block.content), event.tool_use_result);
      }
    } else if (event.type === 'system') {
      this.claudeTask(event);
    } else if (event.type === 'result') {
      // A turn that ended (or was interrupted) has no foreground subagent left.
      this.stopForeground();
    }
  }

  private claudeStart(id: string, input: any, parent: string | null) {
    const existing = this.nodes.get(id);
    const at = this.now();
    this.put({
      id,
      parentId: parent && this.nodes.has(parent) ? parent : null,
      kind: text(input?.subagent_type, 80) ?? existing?.kind ?? 'general-purpose',
      description: text(input?.description, 200) ?? existing?.description ?? null,
      prompt: text(input?.prompt, 4000) ?? existing?.prompt ?? null,
      model: text(input?.model, 60) ?? existing?.model ?? null,
      status: existing?.status ?? 'running',
      background: input?.run_in_background === true || existing?.background === true,
      startedAt: existing?.startedAt ?? at,
      endedAt: existing?.endedAt ?? null,
      activity: existing?.activity ?? null,
      toolUses: existing?.toolUses ?? 0,
      tokens: existing?.tokens ?? null,
      durationMs: existing?.durationMs ?? null,
      result: existing?.result ?? null
    });
  }

  private claudeStep(nodeId: string, tool: string, input: any) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.put({ ...node, activity: activityOf(claudeToolTitle(tool), claudeToolDetail(tool, input)), toolUses: node.toolUses + 1 });
  }

  /** The agent tool's result: the subagent's answer, or (in the background) word that it was launched. */
  private claudeResult(id: string, isError: boolean, output: string, meta: any) {
    const node = this.nodes.get(id);
    if (!node) return;
    const launched = meta?.status === 'async_launched' || (node.background && !isError && meta?.status !== 'completed');
    const stats = {
      toolUses: number(meta?.totalToolUseCount) ?? node.toolUses,
      tokens: number(meta?.totalTokens) ?? node.tokens,
      durationMs: number(meta?.totalDurationMs) ?? node.durationMs
    };
    if (launched) {
      this.put({ ...node, ...stats, background: true });
      return;
    }
    this.finish(node, isError ? 'failed' : 'done', output, stats);
  }

  /** Background agents report through `task_started` / `task_progress` / `task_notification`. */
  private claudeTask(event: any) {
    const taskId = typeof event.task_id === 'string' ? event.task_id : null;
    if (!taskId) return;
    if (event.subtype === 'task_started' && typeof event.tool_use_id === 'string') {
      this.tasks.set(taskId, event.tool_use_id);
      const node = this.nodes.get(event.tool_use_id);
      if (node) this.put({ ...node, background: true, description: node.description ?? text(event.description, 200) });
      return;
    }
    const node = this.nodes.get(this.tasks.get(taskId) ?? (typeof event.tool_use_id === 'string' ? event.tool_use_id : ''));
    if (!node) return;
    const usage = event.usage ?? {};
    const stats = {
      toolUses: number(usage.tool_uses) ?? node.toolUses,
      tokens: number(usage.total_tokens) ?? node.tokens,
      durationMs: number(usage.duration_ms) ?? node.durationMs
    };
    if (event.subtype === 'task_progress') {
      const tool = typeof event.last_tool_name === 'string' ? event.last_tool_name : null;
      this.put({ ...node, ...stats, activity: tool ? claudeToolTitle(tool) : node.activity });
    } else if (event.subtype === 'task_notification') {
      const status: SubagentStatus = event.status === 'completed' ? 'done' : event.status === 'failed' ? 'failed' : 'stopped';
      this.finish(node, status, typeof event.summary === 'string' ? event.summary : null, stats);
    }
  }

  // -------------------------------------------------------------------------
  // Claude Code: hooks (terminal and background-task modes)
  // -------------------------------------------------------------------------

  claudeHook(name: string, payload: Record<string, any>) {
    const tool = String(payload.tool_name ?? '');
    const id = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null;
    if (name === 'PreToolUse' && AGENT_TOOLS.has(tool) && id) {
      this.claudeStart(id, payload.tool_input, null);
    } else if (name === 'PostToolUse' && AGENT_TOOLS.has(tool) && id) {
      const response = payload.tool_response;
      const output = typeof response === 'string' ? response : toolResultText(response?.content);
      this.claudeResult(id, false, output, response);
    } else if (name === 'PreToolUse' && typeof payload.agent_type === 'string') {
      // A tool call inside a subagent names only the subagent's type: credit it when that's unambiguous.
      const matches = [...this.nodes.values()].filter((n) => n.status === 'running' && n.kind === payload.agent_type);
      if (matches.length === 1) this.claudeStep(matches[0].id, tool, payload.tool_input);
    } else if (name === 'SubagentStop') {
      // Hooks can't see a background agent's result; its stop is the only word that it finished.
      // Older CLIs leave out agent_type: then only a lone running background agent can be the one.
      const running = [...this.nodes.values()].filter((n) => n.status === 'running' && n.background);
      const matches = typeof payload.agent_type === 'string' ? running.filter((n) => n.kind === payload.agent_type) : running;
      if (matches.length === 1) this.finish(matches[0], 'done', text(payload.last_assistant_message, 1200), {});
    } else if (name === 'UserPromptSubmit') {
      // A new prompt means the last turn is over, interrupted or not.
      this.stopForeground();
    }
  }

  // -------------------------------------------------------------------------
  // Codex: app-server notifications
  // -------------------------------------------------------------------------

  /** One app-server notification; `rootThreadId` is the agent's own thread. */
  codex(method: string, params: any, rootThreadId: string | null) {
    if (!params || typeof params !== 'object') return;
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (method === 'thread/started') {
      const thread = params.thread ?? {};
      const spawn = thread.source?.subagent?.thread_spawn ?? thread.source?.subAgent?.threadSpawn;
      const parent = spawn?.parent_thread_id ?? spawn?.parentThreadId;
      if (typeof thread.id === 'string' && thread.id !== rootThreadId && typeof parent === 'string') {
        this.codexSpawn(thread.id, parent, rootThreadId, { kind: text(spawn?.agent_role ?? spawn?.agentRole ?? spawn?.agent_nickname, 80) });
      }
      return;
    }
    if ((method === 'item/started' || method === 'item/completed') && params.item?.type?.toLowerCase?.() === 'collabagenttoolcall') {
      this.codexCollab(params.item, rootThreadId);
      return;
    }
    // Everything else counts only for a child thread we know.
    const node = threadId && threadId !== rootThreadId ? this.nodes.get(threadId) : undefined;
    if (!node) return;
    switch (method) {
      case 'turn/started':
        if (node.status !== 'running') this.put({ ...node, status: 'running', endedAt: null });
        break;
      case 'item/started': {
        const entry = codexItemEntry(params.item);
        if (entry?.kind === 'tool') this.put({ ...node, activity: activityOf(entry.title, entry.detail), toolUses: node.toolUses + 1 });
        else if (entry?.kind === 'reasoning') this.put({ ...node, activity: 'Thinking' });
        break;
      }
      case 'item/completed': {
        const entry = codexItemEntry(params.item);
        if (entry?.kind === 'assistant' && entry.text) this.put({ ...node, result: clipText(entry.text, 1200) });
        break;
      }
      case 'turn/completed': {
        const failed = params.turn?.status === 'failed';
        this.finish(node, failed ? 'failed' : params.turn?.status === 'interrupted' ? 'stopped' : 'done', null, {});
        break;
      }
      case 'thread/tokenUsage/updated': {
        const total = number(params.tokenUsage?.total?.totalTokens ?? params.tokenUsage?.total?.total_tokens);
        if (total !== null) this.put({ ...node, tokens: total });
        break;
      }
      default:
        break;
    }
  }

  private codexCollab(item: any, rootThreadId: string | null) {
    const tool = String(item.tool ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const sender = String(item.senderThreadId ?? item.sender_thread_id ?? rootThreadId ?? '');
    const receivers: string[] = [
      ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
      ...(Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []),
      ...[item.receiverThreadId, item.receiver_thread_id]
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (tool.includes('spawn')) {
      for (const id of receivers) this.codexSpawn(id, sender, rootThreadId, { prompt: text(item.prompt, 4000), model: text(item.model, 60), kind: text(item.agentType ?? item.agent_type ?? item.role, 80) });
    }
    const states = item.agentsStates ?? item.agents_states ?? item.agentStates ?? {};
    for (const [id, state] of Object.entries<any>(states && typeof states === 'object' ? states : {})) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const raw = String(state?.status ?? '').toLowerCase();
      const message = text(state?.message, 1200);
      if (raw === 'running' || raw === 'pendinginit' || raw === 'pending_init') {
        if (node.status !== 'running') this.put({ ...node, status: 'running', endedAt: null });
      } else if (raw === 'completed') this.finish(node, 'done', message, {});
      else if (raw === 'errored' || raw === 'failed') this.finish(node, 'failed', message, {});
      else if (raw === 'shutdown' || raw === 'notfound' || raw === 'not_found' || raw === 'interrupted') this.finish(node, 'stopped', message, {});
    }
  }

  private codexSpawn(id: string, parent: string, rootThreadId: string | null, details: { prompt?: string | null; model?: string | null; kind?: string | null }) {
    const existing = this.nodes.get(id);
    const prompt = details.prompt ?? existing?.prompt ?? null;
    this.put({
      id,
      parentId: parent !== rootThreadId && this.nodes.has(parent) ? parent : null,
      kind: details.kind ?? existing?.kind ?? 'agent',
      description: existing?.description ?? (prompt ? clipText(prompt.split('\n')[0], 120) : null),
      prompt,
      model: details.model ?? existing?.model ?? null,
      status: existing?.status ?? 'running',
      background: true,
      startedAt: existing?.startedAt ?? this.now(),
      endedAt: existing?.endedAt ?? null,
      activity: existing?.activity ?? null,
      toolUses: existing?.toolUses ?? 0,
      tokens: existing?.tokens ?? null,
      durationMs: existing?.durationMs ?? null,
      result: existing?.result ?? null
    });
  }

  // -------------------------------------------------------------------------

  /** The process ended: whatever was still running stopped with it. */
  settle() {
    let changed = false;
    for (const node of settleSubagents([...this.nodes.values()], this.now())) {
      if (node !== this.nodes.get(node.id)) {
        this.nodes.set(node.id, node);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  private stopForeground() {
    for (const node of this.nodes.values()) if (node.status === 'running' && !node.background) this.finish(node, 'stopped', null, {});
  }

  private finish(node: SubagentInfo, status: SubagentStatus, result: string | null, stats: Partial<Pick<SubagentInfo, 'toolUses' | 'tokens' | 'durationMs'>>) {
    const endedAt = node.endedAt && node.status !== 'running' ? node.endedAt : this.now();
    this.put({
      ...node,
      ...stats,
      status,
      endedAt,
      activity: null,
      result: text(result, 1200) ?? node.result,
      durationMs: stats.durationMs ?? node.durationMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(node.startedAt))
    });
  }

  private put(node: SubagentInfo) {
    const isNew = !this.nodes.has(node.id);
    this.nodes.set(node.id, node);
    if (isNew && this.nodes.size > NODE_LIMIT) {
      const oldest = this.list().find((n) => n.status !== 'running');
      if (oldest) this.nodes.delete(oldest.id);
    }
    this.onChange();
  }
}

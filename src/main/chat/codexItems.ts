// Codex thread items → chat entries. The app-server protocol sends camelCase
// items ("commandExecution", aggregatedOutput); session rollouts store the same
// items PascalCase with snake_case fields ("CommandExecution",
// aggregated_output). One normalizer reads both. Pure: shared by the live
// driver (main process) and history loading (telemetry worker).
import type { ChatEntry, ChatFileChange, ChatToolStatus } from '../../shared/types';
import { clipText } from './log';

function pick(item: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) if (item[key] !== undefined && item[key] !== null) return item[key];
  return undefined;
}

function baseName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

const SHELL = /(?:^|[\\/])(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?$/i;

/** The command the model wrote, without the shell wrapper Codex runs it in. */
export function codexCommand(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.map(String);
    const flag = parts.findIndex((p, i) => i > 0 && /^(-Command|-c|\/c|-lc)$/i.test(p));
    if (parts.length >= 2 && SHELL.test(parts[0]) && flag > 0) return parts.slice(flag + 1).join(' ');
    return parts.join(' ');
  }
  const text = String(value ?? '');
  const wrapped = /^(?:"([^"]+)"|(\S+))\s+(?:-NoLogo\s+|-NoProfile\s+)*(?:-Command|-c|\/c|-lc)\s+([\s\S]+)$/i.exec(text);
  if (wrapped && SHELL.test(wrapped[1] ?? wrapped[2])) {
    return wrapped[3].replace(/^'([\s\S]*)'$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
  }
  return text;
}

function toolStatus(value: unknown, exitCode?: unknown): ChatToolStatus {
  const status = String(value ?? '').replace(/_/g, '').toLowerCase();
  if (status === 'inprogress' || status === 'running' || status === 'pending') return 'running';
  if (status === 'declined' || status === 'rejected') return 'declined';
  if (status === 'failed' || status === 'error') return 'error';
  if (typeof exitCode === 'number' && exitCode !== 0) return 'error';
  return 'done';
}

function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      const type = String(part?.type ?? '').toLowerCase();
      if (typeof part?.text === 'string') return part.text;
      if (type.includes('image')) return '[image]';
      if (type === 'mention' || type === 'skill') return part.name ? `@${part.name}` : '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function fileChanges(changes: unknown): ChatFileChange[] {
  const out: ChatFileChange[] = [];
  const kindOf = (value: any): ChatFileChange['kind'] => {
    const type = String(value?.type ?? value ?? '').toLowerCase();
    return type === 'add' ? 'add' : type === 'delete' ? 'delete' : 'update';
  };
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!change?.path) continue;
      out.push({ path: String(change.path), kind: kindOf(change.kind), diff: clipText(String(change.diff ?? ''), 60_000) ?? '' });
    }
  } else if (changes && typeof changes === 'object') {
    for (const [path, change] of Object.entries<any>(changes)) {
      const kind = kindOf(change);
      const body = change?.unified_diff ?? change?.diff ?? (typeof change?.content === 'string' ? change.content.split('\n').map((l: string) => `${kind === 'delete' ? '-' : '+'}${l}`).join('\n') : '');
      out.push({ path, kind, diff: clipText(String(body), 60_000) ?? '' });
    }
  }
  return out;
}

function commandTitle(actions: unknown): { title: string; detail: string | null } | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const types = new Set(actions.map((a: any) => String(a?.type ?? '').toLowerCase()));
  if (types.size !== 1) return null;
  const [type] = types;
  if (type === 'read') {
    const names = actions.map((a: any) => a?.name ?? (a?.path ? baseName(String(a.path)) : null)).filter(Boolean);
    return { title: 'Read', detail: names.join(', ') || null };
  }
  if (type === 'search') {
    const first: any = actions[0];
    return { title: 'Searched', detail: first?.query ?? first?.path ?? null };
  }
  if (type === 'listfiles' || type === 'list_files') return { title: 'Listed files', detail: (actions[0] as any)?.path ?? null };
  return null;
}

function durationMs(item: Record<string, any>): number | null {
  const value = pick(item, 'durationMs', 'duration_ms');
  if (typeof value === 'number') return value;
  const duration = item.duration;
  if (duration && typeof duration === 'object' && typeof duration.secs === 'number') return duration.secs * 1000 + Math.round((duration.nanos ?? 0) / 1e6);
  return null;
}

function stringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return clipText(JSON.stringify(value, null, 2), 8000);
}

function mcpOutput(item: Record<string, any>): string | null {
  const error = item.error;
  if (error) return typeof error === 'string' ? error : String(error.message ?? JSON.stringify(error));
  const result = item.result;
  if (!result) return null;
  const content = Array.isArray(result.content) ? result.content : Array.isArray(result.Ok?.content) ? result.Ok.content : null;
  if (content) return clipText(textParts(content)) ?? null;
  return stringify(result);
}

/** A Codex thread item as a chat entry; null for items the chat doesn't show. */
export function codexItemEntry(raw: any): ChatEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawType = String(raw.type ?? '');
  const type = rawType.charAt(0).toLowerCase() + rawType.slice(1);
  const id = String(raw.id ?? '');
  switch (type) {
    case 'userMessage': {
      const text = textParts(raw.content);
      return text ? { kind: 'user', id: String(pick(raw, 'clientId', 'client_id') ?? id), text } : null;
    }
    case 'agentMessage': {
      const text = typeof raw.text === 'string' ? raw.text : textParts(raw.content);
      return { kind: 'assistant', id, text, streaming: false };
    }
    case 'plan':
      return typeof raw.text === 'string' && raw.text.trim() ? { kind: 'assistant', id, text: raw.text, streaming: false } : null;
    case 'reasoning': {
      const summary = pick(raw, 'summary', 'summary_text');
      const content = pick(raw, 'content', 'raw_content');
      const text = (Array.isArray(summary) && summary.length ? summary : Array.isArray(content) ? content : []).map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n\n').trim();
      return text ? { kind: 'reasoning', id, text, streaming: false } : null;
    }
    case 'commandExecution': {
      const command = codexCommand(raw.command);
      const exitCode = pick(raw, 'exitCode', 'exit_code');
      const named = commandTitle(pick(raw, 'commandActions', 'parsed_cmd'));
      const output = pick(raw, 'aggregatedOutput', 'aggregated_output', 'formatted_output');
      return {
        kind: 'tool',
        id,
        tool: 'shell',
        title: named?.title ?? 'Ran',
        detail: named?.detail ?? command,
        input: command,
        output: clipText(typeof output === 'string' ? output : null),
        status: toolStatus(raw.status, exitCode),
        files: null,
        durationMs: durationMs(raw)
      };
    }
    case 'fileChange': {
      const files = fileChanges(raw.changes);
      const names = files.map((f) => baseName(f.path));
      return {
        kind: 'tool',
        id,
        tool: 'apply_patch',
        title: files.every((f) => f.kind === 'add') && files.length ? 'Created' : 'Edited',
        detail: names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') || null,
        input: null,
        output: null,
        status: toolStatus(raw.status),
        files,
        durationMs: null
      };
    }
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id,
        tool: `${raw.server ?? 'mcp'}.${raw.tool ?? ''}`,
        title: `${raw.server ?? 'mcp'} · ${raw.tool ?? 'tool'}`,
        detail: typeof raw.arguments?.title === 'string' ? raw.arguments.title : null,
        input: stringify(raw.arguments),
        output: mcpOutput(raw),
        status: toolStatus(raw.status, raw.error ? 1 : undefined),
        files: null,
        durationMs: durationMs(raw)
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool',
        id,
        tool: String(raw.tool ?? 'tool'),
        title: String(raw.tool ?? 'Tool'),
        detail: null,
        input: stringify(raw.arguments),
        output: Array.isArray(pick(raw, 'contentItems', 'content_items')) ? textParts(pick(raw, 'contentItems', 'content_items')) : null,
        status: raw.success === false ? 'error' : toolStatus(raw.status),
        files: null,
        durationMs: durationMs(raw)
      };
    case 'webSearch':
    case 'extension': {
      if (type === 'extension' && !String(raw.kind ?? '').includes('search')) return null;
      const queries = raw.action?.queries;
      const query = raw.query ?? raw.action?.query ?? (Array.isArray(queries) ? queries[0] : null) ?? raw.action?.url ?? null;
      return { kind: 'tool', id, tool: 'web_search', title: 'Searched the web', detail: query, input: Array.isArray(queries) ? queries.join('\n') : query, output: null, status: 'done', files: null, durationMs: null };
    }
    case 'imageView':
      return { kind: 'tool', id, tool: 'view_image', title: 'Viewed image', detail: raw.path ? baseName(String(raw.path)) : null, input: raw.path ?? null, output: null, status: 'done', files: null, durationMs: null };
    case 'collabAgentToolCall':
      return {
        kind: 'tool',
        id,
        tool: 'agent',
        title: `Agent · ${raw.tool ?? 'call'}`,
        detail: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 120) : null,
        input: typeof raw.prompt === 'string' ? raw.prompt : null,
        output: null,
        status: toolStatus(raw.status),
        files: null,
        durationMs: null
      };
    case 'contextCompaction':
      return { kind: 'notice', id, tone: 'info', text: 'Context compacted' };
    case 'enteredReviewMode':
      return { kind: 'notice', id, tone: 'info', text: 'Review started' };
    case 'exitedReviewMode':
      return typeof raw.review === 'string' && raw.review.trim() ? { kind: 'assistant', id, text: raw.review, streaming: false } : null;
    default:
      return null;
  }
}

/** Sandbox and approval settings for the app's Codex permission choices. */
export function codexPermission(permission: string | null | undefined): {
  approvalPolicy?: 'on-request' | 'never';
  /** Who answers sandbox escalations: the person, or Codex's auto-reviewer ("Approve for me"). */
  approvalsReviewer?: 'user' | 'auto_review';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandboxPolicy?: Record<string, unknown>;
} {
  switch (permission) {
    case 'read-only':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    case 'auto':
    case 'approve-for-me':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: permission === 'auto' ? 'user' : 'auto_review',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return {};
  }
}

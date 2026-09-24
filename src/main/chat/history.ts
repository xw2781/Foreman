// Past conversations from the CLIs' own session files, for chats resumed or
// viewed after the process is gone. Runs in the telemetry worker.
import type { ChatEntry } from '../../shared/types';
import { claudeToolEntry, isSyntheticUserText, slashCommandText, toolResultText } from './claudeTools';
import { codexItemEntry } from './codexItems';
import { clipText } from './log';

export interface HistoryEntry {
  entry: ChatEntry;
  at: string | null;
}

export const HISTORY_LIMIT = 800;

class Collector {
  private entries: HistoryEntry[] = [];
  private index = new Map<string, number>();

  put(entry: ChatEntry, at: string | null) {
    const existing = this.index.get(entry.id);
    if (existing !== undefined) this.entries[existing] = { entry, at: this.entries[existing].at ?? at };
    else {
      this.index.set(entry.id, this.entries.length);
      this.entries.push({ entry, at });
    }
  }

  get(id: string): ChatEntry | undefined {
    const at = this.index.get(id);
    return at === undefined ? undefined : this.entries[at].entry;
  }

  get size() {
    return this.entries.length;
  }

  result(limit = HISTORY_LIMIT): HistoryEntry[] {
    if (this.entries.length <= limit) return this.entries;
    const kept = this.entries.slice(-limit);
    return [{ entry: { kind: 'notice', id: 'history-truncated', tone: 'info', text: `Showing the last ${limit} of ${this.entries.length} entries` }, at: kept[0].at }, ...kept];
  }
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Claude Code transcript (<config>/projects/<cwd>/<session>.jsonl). */
export function claudeHistory(lines: Iterable<string>, limit = HISTORY_LIMIT): HistoryEntry[] {
  const out = new Collector();
  for (const line of lines) {
    const record = parse(line);
    if (!record || record.isSidechain) continue;
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    const uuid = String(record.uuid ?? `${out.size}`);
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      out.put({ kind: 'notice', id: `compact-${uuid}`, tone: 'info', text: 'Context compacted' }, at);
      continue;
    }
    if (record.type === 'user') {
      if (record.isCompactSummary || record.isMeta) continue;
      const content = record.message?.content;
      const texts: string[] = [];
      const push = (text: string) => {
        if (!isSyntheticUserText(text)) texts.push(text);
        else {
          const command = slashCommandText(text);
          if (command) texts.push(command);
        }
      };
      if (typeof content === 'string') push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') push(block.text);
          else if (block?.type === 'image') texts.push('[image]');
          else if (block?.type === 'tool_result') {
            const id = String(block.tool_use_id ?? '');
            const tool = out.get(id);
            if (tool?.kind === 'tool') {
              out.put({ ...tool, output: clipText(toolResultText(block.content)), status: block.is_error ? 'error' : 'done' }, null);
            }
          }
        }
      }
      const text = texts.join('\n').trim();
      if (text) out.put({ kind: 'user', id: `user-${uuid}`, text }, at);
      continue;
    }
    if (record.type === 'assistant') {
      const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
      blocks.forEach((block: any, index: number) => {
        const id = `${uuid}:${index}`;
        if (block?.type === 'text' && block.text?.trim()) out.put({ kind: 'assistant', id, text: block.text, streaming: false }, at);
        else if (block?.type === 'thinking' && block.thinking?.trim()) out.put({ kind: 'reasoning', id, text: block.thinking, streaming: false }, at);
        else if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && block.id) out.put(claudeToolEntry(block.id, block.name, block.input, 'done'), at);
      });
    }
  }
  return out.result(limit);
}

/** Codex rollout (<CODEX_HOME>/sessions/…/rollout-*.jsonl). */
export function codexHistory(lines: Iterable<string>, limit = HISTORY_LIMIT): HistoryEntry[] {
  const items = new Collector();
  // Older rollouts only record user_message / agent_message events.
  const legacy = new Collector();
  let counter = 0;
  for (const line of lines) {
    const record = parse(line);
    if (record?.type !== 'event_msg') continue;
    const payload = record.payload ?? {};
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    switch (payload.type) {
      case 'item_completed': {
        const entry = codexItemEntry(payload.item);
        if (entry) items.put(entry, at ?? (payload.completed_at_ms ? new Date(payload.completed_at_ms).toISOString() : null));
        break;
      }
      case 'user_message':
        if (typeof payload.message === 'string' && payload.message.trim()) legacy.put({ kind: 'user', id: `legacy-user-${counter++}`, text: payload.message.trim() }, at);
        break;
      case 'agent_message':
        if (typeof payload.message === 'string' && payload.message.trim()) legacy.put({ kind: 'assistant', id: `legacy-agent-${counter++}`, text: payload.message.trim(), streaming: false }, at);
        break;
      case 'turn_aborted': {
        const notice: ChatEntry = { kind: 'notice', id: `aborted-${payload.turn_id ?? counter++}`, tone: 'info', text: 'Interrupted' };
        items.put(notice, at);
        legacy.put(notice, at);
        break;
      }
      default:
        break;
    }
  }
  const hasItems = items.result(Infinity).some((h) => h.entry.kind === 'user' || h.entry.kind === 'assistant');
  return (hasItems ? items : legacy).result(limit);
}

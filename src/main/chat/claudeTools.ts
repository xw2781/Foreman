// How Claude Code's tool calls read in the chat. Pure: shared by the live
// stream (main process) and transcript history (telemetry worker).
import type { ChatEntry, ChatFileChange, ChatToolStatus } from '../../shared/types';
import { describeToolInput } from '../streamFormat';
import { clipText } from './log';

const DIFF_LINE_LIMIT = 600;

function lines(text: unknown): string[] {
  return typeof text === 'string' && text ? text.replace(/\r\n/g, '\n').split('\n') : [];
}

function capDiff(out: string[]): string {
  if (out.length <= DIFF_LINE_LIMIT) return out.join('\n');
  return [...out.slice(0, DIFF_LINE_LIMIT), `@@ … ${out.length - DIFF_LINE_LIMIT} more lines`].join('\n');
}

/** A replace shown as removed-then-added lines; Claude's edits carry no line numbers. */
export function replaceDiff(oldText: unknown, newText: unknown): string {
  return capDiff([...lines(oldText).map((l) => `-${l}`), ...lines(newText).map((l) => `+${l}`)]);
}

export function claudeFileChanges(tool: string, input: Record<string, any> | null | undefined): ChatFileChange[] | null {
  if (!input) return null;
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (!path) return null;
  switch (tool) {
    case 'Write':
      return [{ path, kind: 'add', diff: capDiff(lines(input.content).map((l) => `+${l}`)) }];
    case 'Edit':
      return [{ path, kind: 'update', diff: replaceDiff(input.old_string, input.new_string) }];
    case 'MultiEdit':
      if (!Array.isArray(input.edits)) return null;
      return [
        {
          path,
          kind: 'update',
          diff: capDiff(input.edits.flatMap((edit: any, index: number) => [...(index ? ['@@'] : []), ...replaceDiff(edit?.old_string, edit?.new_string).split('\n')]))
        }
      ];
    case 'NotebookEdit':
      return [{ path, kind: 'update', diff: capDiff(lines(input.new_source).map((l) => `+${l}`)) }];
    default:
      return null;
  }
}

const TITLES: Record<string, string> = {
  Bash: 'Ran',
  PowerShell: 'Ran',
  Read: 'Read',
  Write: 'Wrote',
  Edit: 'Edited',
  MultiEdit: 'Edited',
  NotebookEdit: 'Edited notebook',
  Grep: 'Searched',
  Glob: 'Listed files',
  WebFetch: 'Fetched',
  WebSearch: 'Searched the web',
  Task: 'Ran agent',
  Agent: 'Ran agent',
  TodoWrite: 'Updated plan',
  Skill: 'Used skill',
  ToolSearch: 'Loaded tools',
  ExitPlanMode: 'Presented plan',
  EnterPlanMode: 'Entered plan mode',
  AskUserQuestion: 'Asked'
};

function baseName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

export function claudeToolDetail(tool: string, input: Record<string, any> | null | undefined): string | null {
  if (!input) return null;
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === 'string') return baseName(path);
  }
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const done = input.todos.filter((t: any) => t?.status === 'completed').length;
    return `${done}/${input.todos.length} done`;
  }
  if (tool === 'Skill' && typeof input.skill === 'string') return input.skill;
  if (tool.startsWith('mcp__')) return describeToolInput(tool, input) || null;
  return describeToolInput(tool, input) || null;
}

/** The full input, shown when the tool row is expanded. */
export function claudeToolInput(tool: string, input: Record<string, any> | null | undefined): string | null {
  if (!input) return null;
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') return input.command;
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const range = input.offset || input.limit ? ` (lines ${input.offset ?? 1}${input.limit ? `–${(input.offset ?? 1) + input.limit - 1}` : '+'})` : '';
    return `${input.file_path}${range}`;
  }
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.map((t: any) => `${t?.status === 'completed' ? '[x]' : t?.status === 'in_progress' ? '[~]' : '[ ]'} ${t?.content ?? ''}`).join('\n');
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return typeof input.file_path === 'string' ? input.file_path : null;
  return clipText(JSON.stringify(input, null, 2), 8000);
}

export function claudeToolTitle(tool: string): string {
  if (TITLES[tool]) return TITLES[tool];
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return `${server ?? 'mcp'} · ${name ?? tool}`;
  }
  return tool;
}

export function claudeToolEntry(id: string, tool: string, input: Record<string, any> | null | undefined, status: ChatToolStatus = 'running'): Extract<ChatEntry, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    tool,
    title: claudeToolTitle(tool),
    detail: claudeToolDetail(tool, input),
    input: claudeToolInput(tool, input),
    output: null,
    status,
    files: claudeFileChanges(tool, input),
    durationMs: null
  };
}

/** Text of a tool_result block, whose content is a string or a list of text/image parts. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : part?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === null || content === undefined ? '' : String(content);
}

/** User text that Claude Code generated rather than the person typed (slash-command echoes, caveats). */
export function isSyntheticUserText(text: string): boolean {
  return /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>/.test(text);
}

/** "/model sonnet" from Claude Code's <command-name>/<command-args> echo. */
export function slashCommandText(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

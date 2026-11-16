// How Claude Code's tool calls read in the chat. Pure: shared by the live
// stream (main process) and transcript history (telemetry worker).
import { contentImages, toolImages } from '../../shared/chatImages';
import type { ChatEntry, ChatFileChange, ChatImage, ChatQuestion, ChatToolStatus } from '../../shared/types';
import { describeToolInput } from '../streamFormat';
import { clipText } from './log';
import { browserToolDetail, browserToolTitle } from './browserTools';
import { summarizeCommand } from './shellCommand';
import { commandBody } from '../../shared/commandText';

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

function isShell(tool: string) {
  return tool === 'Bash' || tool === 'PowerShell';
}

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
  if (isShell(tool) && typeof input.command === 'string') {
    // What the command does, in words: the files it reads or edits, else the agent's own description
    // of it, else the script it runs, else the command without the `cd` it starts with.
    const described = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const summary = summarizeCommand(input.command);
    const named = summary && summary.title !== 'Ran' ? summary.detail : null;
    return named || described || summary?.detail || describeToolInput(tool, { command: commandBody(input.command) }) || null;
  }
  if (tool === 'Skill' && typeof input.skill === 'string') return input.skill;
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    if (browserToolTitle(server, name)) return browserToolDetail(name, input);
    return describeToolInput(tool, input) || null;
  }
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

/** `input` lets a shell command that only reads, searches or lists say so instead of "Ran". */
export function claudeToolTitle(tool: string, input?: Record<string, any> | null): string {
  if (isShell(tool) && typeof input?.command === 'string') return summarizeCommand(input.command)?.title ?? TITLES[tool];
  if (TITLES[tool]) return TITLES[tool];
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return browserToolTitle(server, name) ?? `${server ?? 'mcp'} · ${name ?? tool}`;
  }
  return tool;
}

export function claudeToolEntry(id: string, tool: string, input: Record<string, any> | null | undefined, status: ChatToolStatus = 'running'): Extract<ChatEntry, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    tool,
    title: claudeToolTitle(tool, input),
    detail: claudeToolDetail(tool, input),
    input: claudeToolInput(tool, input),
    output: null,
    ...(tool === 'AskUserQuestion' && input ? { questions: questionsFrom(input) } : {}),
    status,
    files: claudeFileChanges(tool, input),
    durationMs: null
  };
}

/** AskUserQuestion's input as the chat's questions; a question's text is its id, as in the answers Claude Code takes and reports. */
export function questionsFrom(input: Record<string, any>): ChatQuestion[] {
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

/**
 * What the person answered, by question id: from the result's structured copy
 * when the CLI sends one, else read out of its text (`"question"="answer", …`).
 * Null when nothing was answered (skipped, or the result isn't in yet).
 */
export function questionAnswers(questions: ChatQuestion[], text: string, structured?: unknown): Record<string, string> | null {
  const answers: Record<string, string> = {};
  const given = (structured as any)?.answers;
  if (given && typeof given === 'object') {
    for (const q of questions) if (typeof given[q.id] === 'string' && given[q.id]) answers[q.id] = given[q.id];
  } else {
    const starts = questions.map((q) => ({ q, at: text.indexOf(`"${q.question}"="`) })).filter((s) => s.at >= 0).sort((a, b) => a.at - b.at);
    starts.forEach(({ q, at }, index) => {
      const from = at + q.question.length + 4;
      // An answer runs to the next question, or to the quote that closes the list.
      const rest = text.slice(from, index + 1 < starts.length ? starts[index + 1].at : undefined);
      const end = index + 1 < starts.length ? rest.lastIndexOf('", ') : Math.max(rest.lastIndexOf('". '), rest.endsWith('"') ? rest.length - 1 : -1);
      if (end > 0) answers[q.id] = rest.slice(0, end);
    });
  }
  return Object.keys(answers).length ? answers : null;
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

/** A tool_result block as the step shows it: its text, and its pictures apart from the text. */
export function toolResult(
  content: unknown,
  tool: { tool: string; detail: string | null; questions?: ChatQuestion[] },
  /** The CLI's structured copy of the result (`tool_use_result` live, `toolUseResult` in transcripts). */
  structured?: unknown
): { output: string | null; images?: ChatImage[]; answers?: Record<string, string> } {
  const images = toolImages(content, tool.tool === 'Read' && tool.detail ? tool.detail : 'Image');
  const rest = Array.isArray(content) ? content.filter((part) => !contentImages([part]).length) : content;
  const text = toolResultText(rest);
  const answers = tool.questions?.length ? questionAnswers(tool.questions, text, structured) : null;
  return { output: clipText(text), images: images.length ? images : undefined, ...(answers ? { answers } : {}) };
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

// A shell command laid out for reading. Agents start most commands with a `cd`
// into the project and chain statements on one line; the chat shows the folder
// once and each statement on its own line. Display only: the command itself is
// kept as the agent wrote it.

const LEADING_CD = /^\s*(?:cd|chdir|pushd|set-location|sl)(?:\s+\/d)?(?:\s+-(?:literal)?path)?\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|"']+))\s*(?:;|&&|\r?\n)\s*/i;

/** The folder a command changes into before anything else, and the command without that step. */
export function leadingFolder(command: string): { folder: string; rest: string } | null {
  const match = LEADING_CD.exec(command);
  if (!match) return null;
  const rest = command.slice(match[0].length);
  const folder = match[1] ?? match[2] ?? match[3];
  return rest.trim() && folder ? { folder, rest } : null;
}

/** The command without the `cd` it starts with. */
export function commandBody(command: string): string {
  return (leadingFolder(command)?.rest ?? command).trim();
}

/**
 * One statement per line: breaks after `;` and before `&&` / `||`, outside quotes and
 * brackets. Returns the text unchanged when it can't tell where statements end (escaped
 * quotes, backticks, here-documents: these differ between bash and PowerShell).
 */
function splitStatements(text: string): string {
  if (/`|\\["';]|<</.test(text)) return text;
  const lines: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  const cut = (end: number, next: number) => {
    const line = text.slice(start, end).trim();
    if (line) lines.push(line);
    start = next;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '{') depth += 1;
    else if (c === ')' || c === '}') depth -= 1;
    else if (depth === 0 && c === ';') {
      // `;;` ends a case branch in bash; it isn't two statements.
      if (text[i + 1] === ';' || text[i - 1] === ';') continue;
      cut(i, i + 1);
    } else if (depth === 0 && (c === '&' || c === '|') && text[i + 1] === c) {
      cut(i, i);
      i += 1;
    }
    if (depth < 0) return text;
  }
  if (quote || depth) return text;
  cut(text.length, text.length);
  return lines.length > 1 ? lines.join('\n') : text;
}

export interface CommandLayout {
  /** The folder the command starts by changing into; null when it doesn't. */
  folder: string | null;
  text: string;
}

export function layoutCommand(command: string): CommandLayout {
  const lead = leadingFolder(command);
  const body = (lead?.rest ?? command).trim();
  // A command the agent already wrote over several lines keeps its own layout.
  return { folder: lead?.folder ?? null, text: body.includes('\n') ? body : splitStatements(body) };
}

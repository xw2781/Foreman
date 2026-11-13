// What a shell command does, for the chat's step line: "Read main.ts" in place
// of "Ran Get-Content src\main.ts". Only commands that plainly read, search,
// list, edit a file in place, run a script or ask for a version are named;
// anything unrecognized stays "Ran" with the command itself, so a command that
// changes something is never shown as a read. Pure: shared by the live drivers
// (main process) and history loading (telemetry worker).

export interface CommandSummary {
  /** 'Ran' names what was run ("script build.ps1", "Python code") in place of the command text. */
  title: 'Read' | 'Searched' | 'Listed files' | 'Edited' | 'Checked' | 'Ran';
  detail: string | null;
}

/** read, search, list and check change nothing; edit rewrites a file; run starts a script, which may do anything. */
type Kind = 'read' | 'search' | 'list' | 'check' | 'edit' | 'run';
type ArgKind = 'read' | 'search' | 'list';

interface Token {
  text: string;
  /** An unquoted operator: | ; && || & > < or a newline. */
  op: boolean;
}

/** Words and operators; quotes are removed, `{ … }` script blocks stay one word. Null when the command substitutes another's output. */
function tokenize(command: string): Token[] | null {
  const out: Token[] = [];
  let word = '';
  let has = false;
  const flush = () => {
    if (has) out.push({ text: word, op: false });
    word = '';
    has = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (c === '"' && /\$\(|`/.test(inner)) return null;
      word += inner;
      has = true;
      i = end;
    } else if (c === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < command.length && depth > 0; j += 1) {
        if (command[j] === '{') depth += 1;
        else if (command[j] === '}') depth -= 1;
      }
      if (depth) return null;
      word += command.slice(i, j);
      has = true;
      i = j - 1;
    } else if (c === '`' || (c === '$' && command[i + 1] === '(')) {
      return null;
    } else if (c === '\n' || c === ';') {
      flush();
      out.push({ text: ';', op: true });
    } else if (c === '|' || c === '&') {
      flush();
      const double = command[i + 1] === c;
      // PowerShell's call operator: `& "build.ps1"` runs the script, where a trailing `&` would background one.
      if (c === '&' && !double && (!out.length || out[out.length - 1].op)) continue;
      out.push({ text: double ? c + c : c, op: true });
      if (double) i += 1;
    } else if (c === '>' || c === '<') {
      // 2>$null, 2>/dev/null and 2>&1 only hide errors.
      const quiet = /^>\s*(\$null|\/dev\/null|&1)(?=\s|$|[;|&)])/.exec(command.slice(i));
      if (quiet && (word === '2' || word === '')) {
        word = '';
        has = false;
        i += quiet[0].length - 1;
      } else {
        flush();
        out.push({ text: c, op: true });
      }
    } else if (/\s/.test(c)) {
      flush();
    } else {
      word += c;
      has = true;
    }
  }
  flush();
  return out;
}

const READ = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'bat', 'nl']);
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls']);
const LIST = new Set(['ls', 'dir', 'gci', 'get-childitem', 'tree', 'find', 'fd']);
/** Change nothing the step line should mention. */
const NEUTRAL = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'echo', 'write-host', 'write-output', 'pwd', 'get-location']);
/** Safe after a pipe: they only reshape what the first command printed. */
const FILTERS = new Set([
  ...READ,
  ...SEARCH,
  'select-object', 'select', 'where-object', 'where', '?', 'sort-object', 'sort', 'measure-object', 'measure', 'group-object', 'group',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-host', 'convertfrom-json', 'convertto-json',
  'wc', 'uniq', 'cut', 'tr', 'jq', 'column', 'sed'
]);

/** Flags followed by a value, so the value isn't taken for a file or pattern. PowerShell's are matched lowercased. */
const VALUE_FLAGS: Record<ArgKind, Set<string>> = {
  read: new Set(['-n', '-c', '-totalcount', '-tail', '-first', '-last', '-head', '-skip', '-encoding', '-readcount', '-delimiter']),
  search: new Set([
    '-A', '-B', '-C', '-m', '-f', '-g', '-t', '-T', '-d', '-j', '--glob', '--type', '--include', '--exclude', '--exclude-dir', '--max-count',
    '--context', '--after-context', '--before-context', '--max-depth', '-path', '-literalpath', '-include', '-exclude', '-context', '-encoding'
  ]),
  list: new Set(['-filter', '-include', '-exclude', '-depth', '-attributes', '-L', '-I', '-maxdepth', '-mindepth', '-name', '-iname', '-type', '-path', '-newer', '-size', '-mtime', '-e', '-t', '-d'])
};

function baseName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function hasValue(kind: ArgKind, flag: string) {
  return VALUE_FLAGS[kind].has(flag) || VALUE_FLAGS[kind].has(flag.toLowerCase());
}

/** Arguments that aren't flags or a flag's value, plus the values of the flags in `named`. */
function args(kind: ArgKind, words: string[], named: string[]) {
  const positional: string[] = [];
  const byFlag: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word.startsWith('-') || word === '-') {
      positional.push(word);
      continue;
    }
    if (named.includes(word.toLowerCase())) {
      if (i + 1 < words.length) byFlag.push(words[(i += 1)]);
    } else if (hasValue(kind, word)) i += 1;
  }
  return { positional, byFlag };
}

interface Stage {
  kind: Kind;
  names: string[];
}

function head(words: string[]) {
  return (words[0] ?? '').toLowerCase().replace(/\.exe$/, '');
}

const SCRIPT_FILE = /\.(ps1|sh|bash|py|js|mjs|cjs|ts|bat|cmd|r|rb|pl|vbs|sas)$/i;
/** Programs that run a script file, with what their inline code is called (null: a shell, whose inline code is a command like any other). */
const INTERPRETERS: Record<string, string | null> = {
  python: 'Python', python3: 'Python', py: 'Python', node: 'Node.js', rscript: 'R', ruby: 'Ruby', perl: 'Perl',
  tsx: null, 'ts-node': null, cscript: null, wscript: null, bash: null, sh: null, zsh: null, pwsh: null, powershell: null
};
const INLINE_CODE = new Set(['-c', '-e', '--eval', '-p', '--print', '-command', '-encodedcommand']);
/** An interpreter's flags that take a value; `-file` names the script itself. */
const INTERPRETER_VALUE_FLAGS = new Set(['-executionpolicy', '-ep', '-windowstyle', '-workingdirectory', '-w', '-x', '-r', '--require', '--import', '--loader']);
/** Tools whose lone `-v` prints a version; elsewhere it means verbose. */
const SHORT_VERSION = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'tsc', 'ruby', 'php', 'go', 'docker', 'gh']);

/** `python build.py`, `powershell -File run.ps1`, `./run.sh`, `python -c "…"`: what gets run, in words. */
function scriptRun(words: string[]): string | null {
  if (words[0] === '.') words = words.slice(1); // dot-sourcing
  if (!words.length) return null;
  if (SCRIPT_FILE.test(words[0])) return `script ${baseName(words[0])}`;
  const name = baseName(head(words));
  if (!Object.hasOwn(INTERPRETERS, name)) return null;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const flag = word.toLowerCase();
    if (flag === '-file' || flag === '-f') return words[i + 1] ? `script ${baseName(words[i + 1])}` : null;
    if (INLINE_CODE.has(flag)) return INTERPRETERS[name] ? `${INTERPRETERS[name]} code` : null;
    if (flag === '-m' || word === '-') return null; // a module, or code from standard input
    if (INTERPRETER_VALUE_FLAGS.has(flag)) i += 1;
    else if (!word.startsWith('-')) return SCRIPT_FILE.test(word) ? `script ${baseName(word)}` : null;
  }
  return null;
}

/** The first command of a pipeline; null when it isn't one that only reads. */
function stage(words: string[]): Stage | null {
  let name = head(words);
  let rest = words.slice(1);
  if (name === 'git' && (rest[0] === 'grep' || rest[0] === 'ls-files')) {
    name = rest[0] === 'grep' ? 'grep' : 'ls';
    rest = rest.slice(1);
  }
  if (name === 'sed') {
    // `sed -n '10,20p' file` prints part of a file; -i rewrites it.
    const inPlace = rest.some((w) => /^(-i|--in-place)/.test(w));
    if (!inPlace && !rest.includes('-n')) return null;
    const { positional } = args('read', rest.filter((w) => !/^(-n|-E|-r|-i.*|--in-place.*)$/.test(w)), ['-e']);
    const files = positional.slice(rest.includes('-e') ? 0 : 1).map(baseName);
    if (inPlace) return files.length ? { kind: 'edit', names: files } : null;
    return { kind: 'read', names: files };
  }
  if (words.length === 2 && (/^(--version|-version|-V)$/.test(rest[0]) || (rest[0] === '-v' && SHORT_VERSION.has(baseName(name))))) {
    return { kind: 'check', names: [baseName(name)] };
  }
  if (READ.has(name)) {
    const { positional, byFlag } = args('read', rest, ['-path', '-literalpath']);
    return { kind: 'read', names: [...byFlag, ...positional].flatMap((p) => p.split(',')).filter(Boolean).map(baseName) };
  }
  if (SEARCH.has(name)) {
    const { positional, byFlag } = args('search', rest, ['-pattern', '-e', '--regexp']);
    const pattern = byFlag[0] ?? positional[0];
    return { kind: 'search', names: pattern ? [pattern] : [] };
  }
  if (LIST.has(name)) {
    if (name === 'find' && rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(w))) return null;
    const { positional, byFlag } = args('list', rest, name === 'find' ? [] : ['-path', '-literalpath']);
    const where = [...byFlag, ...positional].find((p) => !(name === 'dir' && /^\/[a-z]+$/i.test(p)));
    return { kind: 'list', names: where && where !== '.' ? [where] : [] };
  }
  const run = scriptRun(words);
  return run ? { kind: 'run', names: [run] } : null;
}

function isFilter(words: string[]) {
  const name = head(words);
  if (!FILTERS.has(name)) return false;
  return name !== 'sed' || !words.some((w) => /^(-i|--in-place)/.test(w));
}

const TITLES: Record<Kind, CommandSummary['title']> = { read: 'Read', search: 'Searched', list: 'Listed files', check: 'Checked', edit: 'Edited', run: 'Ran' };

function listed(names: string[]) {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/**
 * Names the command when every part of it is recognized; null otherwise. A script run or an
 * in-place edit may come with reads and searches (checking the result) and is still named
 * for the run or the edit; reads of different kinds, or an edit beside a run, stay unnamed.
 */
export function summarizeCommand(command: string | null | undefined): CommandSummary | null {
  if (!command || command.length > 4000) return null;
  const tokens = tokenize(command.trim());
  if (!tokens) return null;

  // Statements, each a pipeline of stages, each a list of words.
  const statements: string[][][] = [[[]]];
  for (const token of tokens) {
    const pipeline = statements[statements.length - 1];
    if (!token.op) pipeline[pipeline.length - 1].push(token.text);
    else if (token.text === '|') pipeline.push([]);
    else if (token.text === ';' || token.text === '&&' || token.text === '||') statements.push([[]]);
    else return null; // a redirect to a file, or `&`
  }

  const stages: Stage[] = [];
  for (const pipeline of statements) {
    if (pipeline.length === 1 && pipeline[0].length === 0) continue;
    if (pipeline.some((words) => words.length === 0)) return null;
    const [first, ...filters] = pipeline;
    if (!filters.every(isFilter)) return null;
    if (pipeline.length === 1 && NEUTRAL.has(head(first))) continue;
    const current = stage(first);
    if (!current) return null;
    // `Get-ChildItem -Recurse | Select-String x` is a search of those files.
    const search = current.kind === 'list' ? filters.find((words) => SEARCH.has(head(words))) : undefined;
    stages.push(search ? stage(search) ?? current : current);
  }
  if (!stages.length) return null;

  const kinds = new Set(stages.map((s) => s.kind));
  let kind: Kind;
  if (kinds.size === 1) kind = stages[0].kind;
  else if (kinds.has('run') !== kinds.has('edit')) kind = kinds.has('run') ? 'run' : 'edit';
  else return null;

  const names = stages.filter((s) => s.kind === kind).flatMap((s) => s.names).filter((name, index, all) => all.indexOf(name) === index);
  const detail =
    kind === 'search' || kind === 'list' ? names[0] ?? ''
    : kind === 'check' ? `${listed(names)} version${names.length > 1 ? 's' : ''}`
    : listed(names);
  return { title: TITLES[kind], detail: detail || null };
}

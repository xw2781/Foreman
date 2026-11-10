// What a shell command does, for the chat's step line: "Read main.ts" in place
// of "Ran Get-Content src\main.ts". Only commands that plainly read, search or
// list are named; anything unrecognized stays "Ran", so a command that changes
// something is never shown as a read. Pure: shared by the live drivers (main
// process) and history loading (telemetry worker).

export interface CommandSummary {
  title: 'Read' | 'Searched' | 'Listed files';
  detail: string | null;
}

type Kind = 'read' | 'search' | 'list';

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
const VALUE_FLAGS: Record<Kind, Set<string>> = {
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

function hasValue(kind: Kind, flag: string) {
  return VALUE_FLAGS[kind].has(flag) || VALUE_FLAGS[kind].has(flag.toLowerCase());
}

/** Arguments that aren't flags or a flag's value, plus the values of the flags in `named`. */
function args(kind: Kind, words: string[], named: string[]) {
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
    if (rest.some((w) => /^(-i|--in-place)/.test(w)) || !rest.includes('-n')) return null;
    const { positional } = args('read', rest.filter((w) => w !== '-n'), ['-e']);
    return { kind: 'read', names: positional.slice(rest.includes('-e') ? 0 : 1).map(baseName) };
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
  return null;
}

function isFilter(words: string[]) {
  const name = head(words);
  if (!FILTERS.has(name)) return false;
  return name !== 'sed' || !words.some((w) => /^(-i|--in-place)/.test(w));
}

const TITLES: Record<Kind, CommandSummary['title']> = { read: 'Read', search: 'Searched', list: 'Listed files' };

/** Names the command when every part of it only reads files, searches or lists; null otherwise. */
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

  let found: Stage | null = null;
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
    const resolved = search ? stage(search) ?? current : current;
    if (found && found.kind !== resolved.kind) return null;
    found = found ? { kind: found.kind, names: [...found.names, ...resolved.names] } : resolved;
  }
  if (!found) return null;

  const names = found.names.filter((name, index, all) => all.indexOf(name) === index);
  const detail = found.kind === 'read' ? (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')) : names[0] ?? '';
  return { title: TITLES[found.kind], detail: detail || null };
}

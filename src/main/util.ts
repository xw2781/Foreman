import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const HOME = os.homedir();

export function defaultClaudeDir() {
  return path.join(HOME, '.claude');
}

export function defaultCodexDir() {
  return path.join(HOME, '.codex');
}

/** Where isolated account config directories live. Kept short and visible on purpose. */
export function profilesRoot() {
  return path.join(HOME, '.agent-task-center', 'profiles');
}

export function readJsonFile<T = any>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonFileAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** A small JSON document persisted under the app's user-data folder. */
export class JsonStore<T extends object> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string, defaults: T) {
    const loaded = readJsonFile<Partial<T>>(file);
    this.value = { ...defaults, ...(loaded ?? {}) } as T;
  }

  get data(): T {
    return this.value;
  }

  update(patch: Partial<T>): T {
    this.value = { ...this.value, ...patch };
    this.scheduleSave();
    return this.value;
  }

  replace(value: T) {
    this.value = value;
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    writeJsonFileAtomic(this.file, this.value);
  }
}

// Variables inherited from a parent VS Code / Claude Code / Codex process that
// would confuse a nested agent: nested-session detection, IDE sockets, a
// forced CLAUDE_CONFIG_DIR/CODEX_HOME from another account, Electron's
// run-as-node flag.
const NOISE = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|VSCODE_.*|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CONFIG_DIR|CODEX_HOME|CODEX_THREAD_ID|CODEX_SANDBOX.*|CODEX_MANAGED_BY_.*|ATC_.*)$/i;

export function cleanEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || NOISE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export function run(
  file: string,
  args: string[],
  options: { env?: Record<string, string>; timeout?: number; cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: options.env ?? cleanEnv(), timeout: options.timeout ?? 15_000, windowsHide: true, cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

export function runPowerShell(script: string, options: { timeout?: number; env?: Record<string, string> } = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

/** Quotes a value for embedding in a PowerShell single-quoted string literal. */
export function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function exists(file: string) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Directory junctions need no admin rights on Windows, unlike symlinks. */
export function linkDirectory(target: string, linkPath: string) {
  if (!exists(target) || exists(linkPath)) return false;
  fs.symlinkSync(target, linkPath, 'junction');
  return true;
}

/** Removes a directory tree, unlinking junctions instead of following them. */
export function removeTree(dir: string) {
  if (!exists(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(full);
      } catch {
        fs.rmdirSync(full);
      }
    } else if (stat.isDirectory()) {
      removeTree(full);
    } else {
      fs.rmSync(full, { force: true });
    }
  }
  fs.rmdirSync(dir);
}

export function decodeJwtPayload(token: string): Record<string, any> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';
}

export function samePath(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

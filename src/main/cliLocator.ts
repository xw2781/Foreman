import fs from 'node:fs';
import path from 'node:path';
import type { CliInfo, Provider } from '../shared/types';
import { HOME, cleanEnv, exists, run } from './util';

interface Candidate {
  path: string;
  source: string;
}

function newestMatching(root: string, prefix: string, relative: string[]): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(root).filter((name) => name.toLowerCase().startsWith(prefix));
  } catch {
    return null;
  }
  const withTimes = entries
    .map((name) => {
      const full = path.join(root, name, ...relative);
      try {
        return { full, time: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { full: string; time: number } => entry !== null)
    .sort((a, b) => b.time - a.time);
  return withTimes[0]?.full ?? null;
}

function whereAll(name: string): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd']) {
      const full = path.join(dir, `${name}${ext}`);
      if (exists(full)) found.push(full);
    }
  }
  return found;
}

function candidates(provider: Provider): Candidate[] {
  const list: Candidate[] = [];
  const local = process.env.LOCALAPPDATA ?? path.join(HOME, 'AppData', 'Local');
  const roaming = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
  const vscodeExt = path.join(HOME, '.vscode', 'extensions');
  for (const onPath of whereAll(provider)) list.push({ path: onPath, source: 'PATH' });
  if (provider === 'claude') {
    list.push({ path: path.join(HOME, '.local', 'bin', 'claude.exe'), source: 'native installer' });
    const ext = newestMatching(vscodeExt, 'anthropic.claude-code-', ['resources', 'native-binary', 'claude.exe']);
    if (ext) list.push({ path: ext, source: 'VS Code extension' });
    list.push({ path: path.join(roaming, 'npm', 'claude.cmd'), source: 'npm global' });
  } else {
    const desktop = newestMatching(path.join(local, 'OpenAI', 'Codex', 'bin'), '', ['codex.exe']);
    if (desktop) list.push({ path: desktop, source: 'Codex desktop app' });
    const ext = newestMatching(vscodeExt, 'openai.chatgpt-', ['bin', 'windows-x86_64', 'codex.exe']);
    if (ext) list.push({ path: ext, source: 'VS Code extension' });
    list.push({ path: path.join(roaming, 'npm', 'codex.cmd'), source: 'npm global' });
  }
  return list;
}

function mtime(file: string) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const cache = new Map<Provider, { info: CliInfo; at: number }>();

/**
 * Finds the CLI to launch: the user's explicit choice, then PATH, then the
 * copies bundled with the native installer, the VS Code extensions, the Codex
 * desktop app, and npm. Prefers .exe over .cmd shims, whose cmd.exe argument
 * parsing is lossy.
 */
export async function locateCli(provider: Provider, configured: string, maxAgeMs = 60_000): Promise<CliInfo> {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < maxAgeMs && (!configured || cached.info.path === configured)) return cached.info;

  let chosen: Candidate | null = null;
  if (configured) {
    chosen = exists(configured) ? { path: configured, source: 'settings' } : null;
    if (!chosen) {
      const info: CliInfo = { provider, path: null, version: null, source: 'settings', error: `Configured path not found: ${configured}` };
      cache.set(provider, { info, at: Date.now() });
      return info;
    }
  } else {
    const all = candidates(provider).filter((c) => exists(c.path));
    const exes = all.filter((c) => c.path.toLowerCase().endsWith('.exe'));
    // PATH is the user's explicit choice; otherwise the most recently updated copy.
    const onPath = exes.find((c) => c.source === 'PATH');
    const newest = [...exes].sort((a, b) => mtime(b.path) - mtime(a.path))[0];
    chosen = onPath ?? newest ?? all[0] ?? null;
  }
  if (!chosen) {
    const info: CliInfo = {
      provider,
      path: null,
      version: null,
      source: 'not found',
      error: provider === 'claude'
        ? 'Claude Code was not found. Install it (https://code.claude.com) or set its path in Settings.'
        : 'Codex CLI was not found. Install it (npm i -g @openai/codex) or set its path in Settings.'
    };
    cache.set(provider, { info, at: Date.now() });
    return info;
  }
  const versionArgs = ['--version'];
  const result = chosen.path.toLowerCase().endsWith('.cmd')
    ? await run('cmd.exe', ['/d', '/c', chosen.path, ...versionArgs], { env: cleanEnv(), timeout: 20_000 })
    : await run(chosen.path, versionArgs, { env: cleanEnv(), timeout: 20_000 });
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
  const info: CliInfo = {
    provider,
    path: chosen.path,
    version,
    source: chosen.source,
    error: result.code === 0 ? null : `"${chosen.path} --version" failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`
  };
  cache.set(provider, { info, at: Date.now() });
  return info;
}

export function forgetCli(provider?: Provider) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

// cross-spawn's escaping for cmd.exe shims: quote per MSVCRT rules, then
// caret-escape every cmd metacharacter (twice, because npm's .cmd shims
// re-parse their arguments).
function escapeForCmdShim(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return escaped.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}

/** Turns "run this CLI with these args" into something node-pty can spawn. */
export function spawnSpec(cliPath: string, args: string[]): { file: string; args: string[] | string } {
  if (/\.(cmd|bat)$/i.test(cliPath)) {
    const line = [cliPath, ...args].map(escapeForCmdShim).join(' ');
    // A single string is passed through verbatim by node-pty on Windows.
    return { file: 'cmd.exe', args: `/d /s /c "${line}"` };
  }
  return { file: cliPath, args };
}

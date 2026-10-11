import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Provider } from '../shared/types';
import { spawnSpec } from './cliLocator';
import { decodeJwtPayload, HOME, readJsonFile, writeJsonFileAtomic } from './util';

export interface CatalogModel { id: string; label: string; resolvedModel?: string }

function catalogModels(provider: Provider, rows: unknown): CatalogModel[] {
  const ids = catalogIds(provider, rows);
  return ids.map((id) => {
    const row = (rows as any[]).find((row) => (provider === 'claude' ? row?.value : row?.model)?.trim?.() === id);
    const label = row?.displayName;
    return {
      id, label: typeof label === 'string' && label.trim() ? label.trim() : id,
      ...(typeof row?.resolvedModel === 'string' && row.resolvedModel.trim() ? { resolvedModel: row.resolvedModel.trim() } : {})
    };
  });
}

export function catalogIds(provider: Provider, rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || row.hidden === true) return [];
    const id = provider === 'claude' ? row.value : row.model;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  }))];
}

/** How long a finished discovery may take to exit on its own before it is killed. */
export const EXIT_GRACE_MS = 10_000;
/** Codex refreshes its sign-in once it is 8 days old; discovery stays clear of that. */
const CODEX_REFRESH_AGE_MS = 7 * 24 * 60 * 60_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;

/**
 * Whether starting the CLI just to list models could make it refresh its
 * sign-in. Refresh tokens rotate, so discovery leaves refreshing to real
 * agent runs. Accounts without OAuth tokens (API key, signed out) have
 * nothing to refresh.
 */
export function discoveryWouldRefresh(provider: Provider, configDir: string, now = Date.now()): boolean {
  if (provider === 'claude') {
    const oauth = readJsonFile<any>(path.join(configDir, '.credentials.json'))?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') return false;
    if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) return true;
    // No expiry: a long-lived token (`claude setup-token`).
    return typeof oauth.expiresAt === 'number' && oauth.expiresAt < now + EXPIRY_MARGIN_MS;
  }
  const auth = readJsonFile<any>(path.join(configDir, 'auth.json'));
  const token = auth?.tokens?.access_token;
  if (typeof token !== 'string' || !token) return false;
  const exp = Number(decodeJwtPayload(token)?.exp);
  if (Number.isFinite(exp) && exp * 1000 < now + EXPIRY_MARGIN_MS) return true;
  const lastRefresh = Date.parse(auth.last_refresh);
  return Number.isFinite(lastRefresh) && now - lastRefresh > CODEX_REFRESH_AGE_MS;
}

/** Metadata only: never create a Codex thread or send a Claude user message. */
export function discoverModels(provider: Provider, cli: string, env: Record<string, string>): Promise<CatalogModel[]> {
  return new Promise((resolve, reject) => {
    const args = provider === 'claude'
      ? ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
      : ['app-server'];
    const spec = spawnSpec(cli, args);
    const child = spawn(spec.file, typeof spec.args === 'string' ? [spec.args] : spec.args, {
      env, cwd: HOME, windowsHide: true, windowsVerbatimArguments: typeof spec.args === 'string'
    });
    let done = false;
    let buffer = '';
    let requestId = 1;
    const models: CatalogModel[] = [];
    const cursors = new Set<string>();
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      // Closing stdin ends both CLIs. Killing them outright could land mid token
      // refresh: the server has rotated the refresh token, the CLI hasn't saved
      // it yet, and the account is signed out on its next start.
      child.stdin.end();
      const grace = setTimeout(() => {
        // Kill the shim's descendants as well, so a hung discovery cannot linger.
        if (!child.pid || child.exitCode !== null) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
      }, EXIT_GRACE_MS);
      grace.unref?.();
      child.once('exit', () => clearTimeout(grace));
      if (error) reject(error);
      else resolve([...new Map(models.map((model) => [model.id, model])).values()]);
    };
    const timeout = setTimeout(() => finish(new Error('Model discovery timed out')), 25_000);
    const send = (message: object) => { if (!done) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.on('error', finish);
    child.on('exit', () => finish(new Error('Model discovery exited before replying')));
    child.stdin.on('error', finish);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Model discovery response too large'));
      let newline: number;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (provider === 'claude') {
          if (message?.type !== 'control_response' || message.response?.request_id !== 'models') continue;
          if (message.response.subtype === 'error') return finish(new Error('Claude model discovery refused'));
          models.push(...catalogModels(provider, message.response.response?.models));
          finish();
        } else {
          if (message?.id !== requestId) continue;
          if (message.error) return finish(new Error('Codex model discovery refused'));
          if (requestId === 1) {
            send({ method: 'initialized' });
            send({ id: ++requestId, method: 'model/list', params: { limit: 100 } });
          } else {
            models.push(...catalogModels(provider, message.result?.data));
            const cursor = message.result?.nextCursor;
            if (typeof cursor === 'string' && cursor) {
              if (cursors.has(cursor) || cursors.size >= 100) return finish(new Error('Invalid model pagination'));
              cursors.add(cursor);
              send({ id: ++requestId, method: 'model/list', params: { limit: 100, cursor } });
            } else finish();
          }
        }
      }
    });
    send(provider === 'claude'
      ? { type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }
      : { id: 1, method: 'initialize', params: { clientInfo: { name: 'foreman_models', title: 'Foreman models', version: '1.0.0' }, capabilities: null } });
  });
}

/** Last good catalogs survive failures and restarts; retries are throttled separately. */
export class ModelCatalog {
  private entries: Record<string, CatalogModel[]>;
  private attempted = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'model-catalog.json');
    const saved = readJsonFile<Record<string, unknown>>(this.file);
    this.entries = Object.fromEntries(Object.entries(saved ?? {}).filter((entry): entry is [string, CatalogModel[]] =>
      Array.isArray(entry[1]) && entry[1].every((model) => model && typeof model.id === 'string' && model.id.trim()
        && typeof model.label === 'string' && (model.resolvedModel === undefined || typeof model.resolvedModel === 'string'))));
  }

  get(key: string): CatalogModel[] | null { return this.entries[key]?.length ? this.entries[key] : null; }

  refresh(key: string, force: boolean, load: () => Promise<CatalogModel[]>): Promise<void> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (!force && this.attempted.has(key) && Date.now() - this.attempted.get(key)! < 60 * 60_000) return Promise.resolve();
    this.attempted.set(key, Date.now());
    const task = Promise.resolve().then(load).then((ids) => {
      if (!ids.length) return;
      this.entries[key] = ids;
      writeJsonFileAtomic(this.file, this.entries);
    }).catch(() => { /* Keep the last good catalog, or the bundled fallback. */ }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}

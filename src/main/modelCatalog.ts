import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Provider } from '../shared/types';
import { spawnSpec } from './cliLocator';
import { HOME, readJsonFile, writeJsonFileAtomic } from './util';

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
      child.stdin.end();
      // Kill the shim's descendants as well, so a timed-out discovery cannot linger.
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
      }
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

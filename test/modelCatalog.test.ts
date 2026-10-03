import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn } from 'node:child_process';
import { catalogIds, discoverModels, ModelCatalog } from '../src/main/modelCatalog';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-models-'));
  dirs.push(dir);
  return dir;
}
function cli() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null
  });
  vi.mocked(spawn).mockReturnValue(child as any);
  const sent: any[] = [];
  child.stdin.on('data', (data) => sent.push(JSON.parse(data.toString())));
  const reply = (data: object) => child.stdout.write(`${JSON.stringify(data)}\n`);
  return { child, sent, reply };
}

describe('CLI model discovery', () => {
  it('reads Claude initialization metadata without sending a user message', async () => {
    const { child, sent, reply } = cli();
    const result = discoverModels('claude', 'claude.exe', { CLAUDE_CONFIG_DIR: 'account' });
    child.stdout.write('not JSON\n{"type":');
    child.stdout.write('"control_response","response":{"request_id":"unrelated"}}\n');
    reply({ type: 'control_response', response: { request_id: 'models', subtype: 'success', response: { models: [{ value: 'claude-sonnet-5-5' }, { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5' }] } } });
    expect(await result).toEqual([{ id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' }, { id: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5-5' }]);
    expect(sent).toEqual([{ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }]);
    expect(spawn).toHaveBeenCalledWith('claude.exe', expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config']), expect.objectContaining({ env: { CLAUDE_CONFIG_DIR: 'account' }, windowsHide: true }));
  });

  it('paginates Codex model/list and excludes hidden models without starting a thread', async () => {
    const { sent, reply } = cli();
    const result = discoverModels('codex', 'codex.exe', {});
    reply({ id: 1, result: {} });
    reply({ id: 2, result: { data: [{ model: 'new-model' }, { model: 'hidden', hidden: true }], nextCursor: 'next' } });
    reply({ id: 3, result: { data: [{ model: 'new-model' }, { model: 'other' }], nextCursor: null } });
    expect(await result).toEqual([{ id: 'new-model', label: 'new-model' }, { id: 'other', label: 'other' }]);
    expect(sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(sent[3].params.cursor).toBe('next');
  });

  it('rejects protocol errors and timeouts', async () => {
    vi.useFakeTimers();
    let process = cli();
    const refused = discoverModels('codex', 'codex.exe', {});
    process.reply({ id: 1, error: { message: 'unsupported' } });
    await expect(refused).rejects.toThrow('refused');
    process = cli();
    const timeout = discoverModels('claude', 'claude.exe', {});
    const assertion = expect(timeout).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
  });

  it('ignores invalid and duplicate model entries', () => {
    expect(catalogIds('claude', [null, {}, { value: '' }, { value: 1 }, { value: ' sonnet ' }, { value: 'sonnet' }])).toEqual(['sonnet']);
    expect(catalogIds('codex', null)).toEqual([]);
  });
});

describe('catalog caching', () => {
  it('keeps accounts separate and persists the last good list through errors and empty replies', async () => {
    const dir = directory();
    const cache = new ModelCatalog(dir);
    await cache.refresh('a', false, async () => [{ id: 'new', label: 'New' }]);
    await cache.refresh('b', false, async () => [{ id: 'other', label: 'Other' }]);
    await cache.refresh('a', true, async () => { throw new Error('offline'); });
    await cache.refresh('a', true, async () => []);
    expect(new ModelCatalog(dir).get('a')).toEqual([{ id: 'new', label: 'New' }]);
    expect(cache.get('b')).toEqual([{ id: 'other', label: 'Other' }]);
    expect(cache.get('unknown')).toBeNull();
  });

  it('coalesces concurrent requests, throttles retries, and supports force refresh', async () => {
    vi.useFakeTimers();
    const cache = new ModelCatalog(directory());
    const loader = vi.fn(async () => [{ id: 'new', label: 'New' }]);
    await Promise.all([cache.refresh('a', false, loader), cache.refresh('a', true, loader)]);
    await cache.refresh('a', false, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    await cache.refresh('a', true, loader);
    expect(loader).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await cache.refresh('a', false, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });
});

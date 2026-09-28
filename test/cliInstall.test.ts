import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { c as pack } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contained, installCli, managedCli, rollbackCli, safeEntry, verifyArchive } from '../src/main/cliInstall';
import { run } from '../src/main/util';

vi.mock('../src/main/util', async (original) => ({ ...await original<object>(), run: vi.fn() }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cli-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('managed CLI installation', () => {
  it('rejects corrupt downloads and unsafe extraction paths', () => {
    const bytes = Buffer.from('vendor archive');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(() => verifyArchive(bytes, integrity)).not.toThrow();
    expect(() => verifyArchive(Buffer.from('changed'), integrity)).toThrow('integrity');
    expect(() => verifyArchive(bytes, 'sha1-unsupported')).toThrow('integrity');
    for (const entry of ['../outside', 'package/../../outside', 'C:/outside', 'package/a\\b']) expect(safeEntry(entry, 'File')).toBe(false);
    expect(safeEntry('package/link', 'SymbolicLink')).toBe(false);
    expect(safeEntry('package/claude.exe', 'File')).toBe(true);
    expect(() => contained(root, '../outside')).toThrow();
  });

  it.skipIf(process.platform !== 'win32')('keeps the active version on failure and supports rollback', async () => {
    const pkg = path.join(root, 'source', 'package');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'claude.exe'), 'fixture executable');
    const archive = path.join(root, 'fixture.tgz');
    await pack({ gzip: true, file: archive, cwd: path.dirname(pkg) }, ['package/claude.exe']);
    const bytes = fs.readFileSync(archive);
    let version = '1.0.0';
    let corrupt = false;
    const fetcher = vi.fn(async (url: any) => {
      if (String(url).endsWith('fixture.tgz')) return new Response(new Uint8Array(corrupt ? Buffer.from('bad') : bytes));
      if (String(url).endsWith('/latest')) return Response.json({ name: '@anthropic-ai/claude-code', version, optionalDependencies: { [`@anthropic-ai/claude-code-win32-${process.arch}`]: version } });
      return Response.json({ name: `@anthropic-ai/claude-code-win32-${process.arch}`, version, dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } });
    });
    vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: version, stderr: '' }));
    const managedRoot = path.join(root, 'tools');
    const first = await installCli('claude', fetcher, managedRoot);
    expect(managedCli('claude', managedRoot)).toBe(first);
    version = '1.0.1'; corrupt = true;
    await expect(installCli('claude', fetcher, managedRoot)).rejects.toThrow('integrity');
    expect(managedCli('claude', managedRoot)).toBe(first);
    corrupt = false;
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'bad binary' });
    await expect(installCli('claude', fetcher, managedRoot)).rejects.toThrow('version check');
    expect(managedCli('claude', managedRoot)).toBe(first);
    const second = await installCli('claude', fetcher, managedRoot);
    expect(second).not.toBe(first);
    expect(await rollbackCli('claude', managedRoot)).toBe(first);
    expect(managedCli('claude', managedRoot)).toBe(first);
  });
});

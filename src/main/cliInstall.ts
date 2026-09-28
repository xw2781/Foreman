import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { x as extract } from 'tar';
import type { Provider } from '../shared/types';
import { cleanEnv, readJsonFile, run, writeJsonFileAtomic } from './util';

export const toolsRoot = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Foreman', 'tools');
interface Release { version: string; executable: string }
interface Installation { current: Release; previous?: Release }
const registry = 'https://registry.npmjs.org/';
const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

function providerCheck(provider: Provider) {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown tool.');
}
export function contained(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  const part = path.relative(path.resolve(root), result);
  if (!part || part.startsWith('..') || path.isAbsolute(part)) throw new Error('Invalid installation path.');
  return result;
}
function manifest(provider: Provider, root: string) { providerCheck(provider); return path.join(root, provider, 'active.json'); }
export function managedCli(provider: Provider, root = toolsRoot()): string | null {
  try {
    const entry = readJsonFile<Installation>(manifest(provider, root));
    if (!entry) return null;
    const file = contained(root, entry.current.executable);
    return fs.existsSync(file) ? file : null;
  } catch { return null; }
}
export function verifyArchive(bytes: Buffer, integrity: string) {
  const expected = integrity?.split(/\s+/).find((s) => s.startsWith('sha512-'));
  if (!expected || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== expected) throw new Error('Download integrity check failed. Please retry.');
}
export function safeEntry(name: string, type: string) {
  return name.startsWith('package/') && !name.includes('\\') && !name.includes(':') && !name.split('/').includes('..') && ['File', 'Directory'].includes(type);
}
const pending = new Map<Provider, Promise<string>>();

/** Native vendor packages only: no npm runtime or package lifecycle scripts. */
export function installCli(provider: Provider, fetcher: typeof fetch = fetch, root = toolsRoot()): Promise<string> {
  providerCheck(provider);
  const existing = pending.get(provider);
  if (existing) return existing;
  const promise = install(provider, fetcher, root).finally(() => pending.delete(provider));
  pending.set(provider, promise);
  return promise;
}
async function install(provider: Provider, fetcher: typeof fetch, root: string): Promise<string> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Managed setup supports Windows x64 and ARM64.');
  async function download(url: string, maxBytes: number): Promise<Buffer> {
    if (!url.startsWith(registry)) throw new Error('Unexpected package download source.');
    const response = await fetcher(url, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). Check your connection and retry.`);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('Download exceeded the size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  const metadata = async (pkg: string, version: string) => JSON.parse((await download(`${registry}${pkg}/${encodeURIComponent(version)}`, 4 * 1024 * 1024)).toString('utf8'));
  const parent = await metadata(packages[provider], 'latest');
  if (parent.name !== packages[provider] || !/^\d+\.\d+\.\d+$/.test(parent.version)) throw new Error('Unexpected release metadata.');
  const nativeName = `${packages[provider]}-win32-${process.arch}`;
  const dep = parent.optionalDependencies?.[nativeName];
  let nativeVersion = dep;
  let nativePackage = nativeName;
  if (provider === 'codex') {
    const prefix = `npm:${packages.codex}@`;
    if (typeof dep !== 'string' || !dep.startsWith(prefix)) throw new Error('Unsupported Codex package layout.');
    nativePackage = packages.codex;
    nativeVersion = dep.slice(prefix.length);
  }
  if (typeof nativeVersion !== 'string' || !/^[\w.-]+$/.test(nativeVersion)) throw new Error('Native package unavailable for this platform.');
  const meta = await metadata(nativePackage, nativeVersion);
  if (meta.name !== nativePackage || meta.version !== nativeVersion) throw new Error('Unexpected native package metadata.');
  const old = readJsonFile<Installation>(manifest(provider, root));
  if (old?.current.version === parent.version && managedCli(provider, root)) return managedCli(provider, root)!;
  const bytes = await download(meta.dist.tarball, 350 * 1024 * 1024);
  verifyArchive(bytes, meta.dist.integrity);
  const folder = contained(root, `${provider}/${parent.version}-${randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true });
  const archive = path.join(folder, 'download.tgz');
  try {
    fs.writeFileSync(archive, bytes);
    let rejected = false;
    await extract({ file: archive, cwd: folder, strict: true, filter: (name, entry) => {
      const safe = safeEntry(name, 'type' in entry ? entry.type : '');
      if (!safe) rejected = true;
      return safe;
    } });
    if (rejected) throw new Error('Package contains unsupported archive entries.');
    const files = fs.readdirSync(folder, { recursive: true, withFileTypes: true });
    const binary = files.find((entry) => entry.isFile() && entry.name === `${provider}.exe`);
    if (!binary) throw new Error('Native executable missing from package.');
    const executable = path.join(binary.parentPath, binary.name);
    const checked = await run(executable, ['--version'], { env: { ...cleanEnv(), DISABLE_AUTOUPDATER: '1' }, timeout: 30_000 });
    if (checked.code !== 0 || !checked.stdout.includes(parent.version)) throw new Error('Downloaded CLI failed its version check. Previous installation is unchanged.');
    fs.unlinkSync(archive);
    writeJsonFileAtomic(manifest(provider, root), { current: { version: parent.version, executable: path.relative(root, executable) }, previous: old?.current });
    return executable;
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
export async function rollbackCli(provider: Provider, root = toolsRoot()): Promise<string> {
  providerCheck(provider);
  if (pending.has(provider)) throw new Error('Wait for the installation to finish.');
  const old = readJsonFile<Installation>(manifest(provider, root));
  if (!old?.previous) throw new Error('No previous managed version is available.');
  const file = contained(root, old.previous.executable);
  const checked = await run(file, ['--version'], { env: { ...cleanEnv(), DISABLE_AUTOUPDATER: '1' } });
  if (checked.code !== 0) throw new Error('Previous version could not be started.');
  writeJsonFileAtomic(manifest(provider, root), { current: old.previous, previous: old.current });
  return file;
}

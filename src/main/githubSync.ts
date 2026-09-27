import type { GitHubSyncStatus, UsageImportResult } from '../shared/types';
import { readJsonFile, writeJsonFileAtomic } from './util';

/**
 * Client ID of the GitHub OAuth app Foreman signs in with (Device Flow enabled,
 * no secret needed; client IDs are public). Empty hides the Connect button.
 */
export const GITHUB_CLIENT_ID = process.env.FOREMAN_GITHUB_CLIENT_ID || '';
/** Private repos need the `repo` scope; nothing else is requested. */
const SCOPE = 'repo';
const REPO_NAME = 'foreman-usage';
const API = 'https://api.github.com';

type Fetch = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export interface Secrets {
  available(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface SyncTelemetry {
  localUsage(previous: string | null): Promise<{ content: string; digest: string; sessions: number }>;
  importUsage(contents: string[], names?: string[]): Promise<UsageImportResult>;
}

interface Stored {
  login: string | null;
  repo: string | null;
  /** The OAuth token, encrypted with the OS keychain (DPAPI on Windows). */
  token: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Blob SHA of each other computer's file when last imported: unchanged files aren't downloaded again. */
  shas: Record<string, string>;
  ownSha: string | null;
  ownDigest: string | null;
}

const EMPTY: Stored = { login: null, repo: null, token: null, lastSyncAt: null, lastError: null, shas: {}, ownSha: null, ownDigest: null };

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Keeps usage in step across computers through a private GitHub repo holding
 * `machines/<machine id>.json` per computer. Each computer writes only its own
 * file, so there is nothing to merge on GitHub; everyone reads everyone else's.
 */
export class GitHubSync {
  private stored: Stored;
  private flow: DeviceFlow | null = null;
  private running: Promise<void> | null = null;
  onChanged: (status: GitHubSyncStatus) => void = () => {};
  /** Other computers' usage changed. */
  onImported: () => void = () => {};

  constructor(
    private storePath: string,
    private deps: { fetch: Fetch; secrets: Secrets; telemetry: SyncTelemetry; machineId: string; machineName: string; openExternal(url: string): void }
  ) {
    this.stored = { ...EMPTY, ...(readJsonFile<Partial<Stored>>(storePath) ?? {}) };
  }

  status(): GitHubSyncStatus {
    return {
      available: Boolean(GITHUB_CLIENT_ID),
      login: this.token() ? this.stored.login : null,
      repo: this.token() ? this.stored.repo : null,
      pending: this.flow
        ? { userCode: this.flow.userCode, verificationUri: this.flow.verificationUri, expiresAt: new Date(this.flow.expiresAt).toISOString() }
        : null,
      syncing: this.running !== null,
      lastSyncAt: this.stored.lastSyncAt,
      lastError: this.stored.lastError
    };
  }

  get connected() {
    return Boolean(this.token() && this.stored.repo);
  }

  /** Starts GitHub's device sign-in: the user enters the shown code on github.com. */
  async connect(): Promise<GitHubSyncStatus> {
    if (!GITHUB_CLIENT_ID) throw new Error('This build of Foreman has no GitHub app configured.');
    if (!this.deps.secrets.available()) throw new Error('Windows can’t encrypt the GitHub token on this computer, so Foreman won’t store it.');
    const response = await this.deps.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: SCOPE }).toString()
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.device_code) throw new Error(body.error_description ?? `GitHub sign-in failed (${response.status}).`);
    const flow: DeviceFlow = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri ?? 'https://github.com/login/device',
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
      interval: Number(body.interval) || 5
    };
    this.flow = flow;
    this.update({ lastError: null });
    this.deps.openExternal(flow.verificationUri);
    void this.poll(flow);
    return this.status();
  }

  cancel() {
    this.flow = null;
    this.onChanged(this.status());
  }

  /** Forgets the token here; the repo and the other computers' usage stay. */
  disconnect() {
    this.flow = null;
    this.stored = { ...EMPTY };
    this.save();
    this.onChanged(this.status());
  }

  private async poll(flow: DeviceFlow) {
    let interval = flow.interval;
    while (this.flow === flow) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      if (this.flow !== flow) return;
      if (Date.now() > flow.expiresAt) return this.failFlow(flow, 'The GitHub sign-in code expired. Connect again.');
      let body: any;
      try {
        const response = await this.deps.fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          }).toString()
        });
        body = await response.json();
      } catch {
        continue; // offline for a moment: keep waiting until the code expires
      }
      if (this.flow !== flow) return;
      if (body.access_token) {
        try {
          await this.signedIn(body.access_token);
        } catch (error) {
          this.failFlow(flow, message(error));
        }
        return;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        interval = Number(body.interval) || interval + 5;
        continue;
      }
      return this.failFlow(flow, body.error === 'access_denied' ? 'GitHub sign-in was cancelled.' : body.error_description ?? 'GitHub sign-in failed.');
    }
  }

  private failFlow(flow: DeviceFlow, error: string) {
    if (this.flow !== flow) return;
    this.flow = null;
    this.update({ lastError: error });
  }

  private async signedIn(token: string) {
    const user = await (await this.request(token, 'GET', '/user')).json();
    const repo = `${user.login}/${REPO_NAME}`;
    await this.ensureRepo(token, repo);
    this.flow = null;
    this.stored = { ...EMPTY, login: user.login, repo, token: this.deps.secrets.encrypt(token) };
    this.save();
    this.onChanged(this.status());
    await this.sync().catch(() => {});
  }

  /** Uses the repo if it exists and is private; creates it (private) otherwise. */
  private async ensureRepo(token: string, repo: string) {
    try {
      const existing = await (await this.request(token, 'GET', `/repos/${repo}`)).json();
      if (!existing.private) throw new Error(`github.com/${repo} is public. Make it private (or delete it) and connect again.`);
      return;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }
    await this.request(token, 'POST', '/user/repos', {
      name: REPO_NAME,
      private: true,
      auto_init: true,
      description: 'Claude Code and Codex usage summaries, one file per computer, synced by Foreman.'
    });
  }

  /** Downloads the other computers' changed files, then uploads this computer's. */
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
      this.onChanged(this.status());
    });
    this.onChanged(this.status());
    return this.running;
  }

  private async runSync() {
    const token = this.token();
    const repo = this.stored.repo;
    if (!token || !repo) throw new Error('Connect GitHub first.');
    const problems: string[] = [];
    try {
      const files = await this.listMachineFiles(token, repo);
      const ownPath = `machines/${this.deps.machineId}.json`;
      let imported = false;
      for (const file of files) {
        if (file.path === ownPath || this.stored.shas[file.path] === file.sha) continue;
        try {
          const result = await this.deps.telemetry.importUsage([await this.download(token, repo, file.path)], [file.name]);
          this.stored.shas[file.path] = file.sha;
          imported ||= result.machines > 0;
        } catch (error) {
          if (error instanceof GitHubError && error.status === 401) throw error;
          problems.push(message(error));
        }
      }
      if (imported) this.onImported();

      // Fold the previous upload in: sessions whose transcripts are gone since stay in the repo.
      const own = files.find((f) => f.path === ownPath) ?? null;
      const local = await this.deps.telemetry.localUsage(own ? await this.download(token, repo, ownPath) : null);
      if (!own || own.sha !== this.stored.ownSha || local.digest !== this.stored.ownDigest) {
        const response = await this.request(token, 'PUT', `/repos/${repo}/contents/${ownPath}`, {
          message: `Usage from ${this.deps.machineName}`,
          content: Buffer.from(local.content, 'utf8').toString('base64'),
          ...(own ? { sha: own.sha } : {})
        });
        const body = await response.json();
        this.stored.ownSha = body?.content?.sha ?? null;
        this.stored.ownDigest = local.digest;
      }
      this.update({ lastSyncAt: new Date().toISOString(), lastError: problems.length ? problems.join(' ') : null });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) {
        this.stored = { ...EMPTY, lastError: 'GitHub sign-in expired or was revoked. Connect again.' };
        this.save();
      } else {
        this.update({ lastError: message(error) });
      }
      throw error;
    }
  }

  private async listMachineFiles(token: string, repo: string): Promise<Array<{ name: string; path: string; sha: string }>> {
    try {
      const entries = await (await this.request(token, 'GET', `/repos/${repo}/contents/machines`)).json();
      return (Array.isArray(entries) ? entries : []).filter((e) => e?.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.json'));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return [];
      throw error;
    }
  }

  private async download(token: string, repo: string, filePath: string) {
    return (await this.request(token, 'GET', `/repos/${repo}/contents/${filePath}`, undefined, 'application/vnd.github.raw+json')).text();
  }

  private async request(token: string, method: string, route: string, body?: unknown, accept = 'application/vnd.github+json') {
    const response = await this.deps.fetch(`${API}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Foreman',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new GitHubError(`GitHub: ${detail?.message ?? `request failed (${response.status})`}`, response.status);
    }
    return response;
  }

  private token(): string | null {
    if (!this.stored.token) return null;
    try {
      return this.deps.secrets.decrypt(this.stored.token);
    } catch {
      return null;
    }
  }

  private update(patch: Partial<Stored>) {
    this.stored = { ...this.stored, ...patch };
    this.save();
    this.onChanged(this.status());
  }

  private save() {
    try {
      writeJsonFileAtomic(this.storePath, this.stored);
    } catch {
      // Keeps working from memory; the next save retries.
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

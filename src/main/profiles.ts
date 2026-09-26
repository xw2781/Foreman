import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CliDefaults,
  LimitWindow,
  NewProfileInput,
  Profile,
  ProfileIdentity,
  ProfileLimits,
  ProfileView,
  Provider
} from '../shared/types';
import {
  HOME,
  JsonStore,
  decodeJwtPayload,
  defaultClaudeDir,
  defaultCodexDir,
  exists,
  linkDirectory,
  profilesRoot,
  psQuote,
  readJsonFile,
  removeTree,
  run,
  runPowerShell,
  samePath,
  slug
} from './util';

// Categorical palette slots 3-8 (validated in this order); the renderer maps
// each slot to its light/dark hex. Slots 1-2 are reserved for the providers.
const COLORS = ['slot-3', 'slot-4', 'slot-5', 'slot-6', 'slot-7', 'slot-8'];
export const ENV_VAR: Record<Provider, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/** What a new isolated account borrows from the default one. */
const SHARED: Record<Provider, { copy: string[]; link: string[] }> = {
  claude: { copy: ['settings.json', 'CLAUDE.md', 'keybindings.json'], link: ['skills', 'agents', 'commands', 'output-styles'] },
  codex: { copy: ['config.toml', 'AGENTS.md'], link: ['skills', 'prompts', 'rules'] }
};

interface ProfilesFile {
  profiles: Profile[];
}

export interface ProfileServiceEvents {
  changed: () => void;
}

export class ProfileService {
  private store: JsonStore<ProfilesFile>;
  private identities = new Map<string, ProfileIdentity>();
  private limits = new Map<string, ProfileLimits>();
  /** Display name of each account's plan, read with its identity. */
  private tiers = new Map<string, string | null>();
  private globalDefaults: Record<Provider, string | null> = { claude: null, codex: null };
  onChanged: () => void = () => {};
  codexLimitsLoader: (profile: Profile) => Promise<ProfileLimits | null> = async () => null;
  /** Live plan usage from the tool's servers; undefined when it wasn't asked this time (throttled). */
  liveLimitsLoader: (profile: Profile, force: boolean) => Promise<ProfileLimits | null | undefined> = async () => null;
  runningCounter: (profileId: string) => number = () => 0;
  skillChecker: (profile: Profile) => boolean = () => false;

  constructor(userDataDir: string) {
    this.store = new JsonStore<ProfilesFile>(path.join(userDataDir, 'profiles.json'), { profiles: [] });
    this.ensureBuiltins();
  }

  private ensureBuiltins() {
    const profiles = [...this.store.data.profiles];
    const now = new Date().toISOString();
    if (!profiles.some((p) => p.provider === 'claude' && p.builtin)) {
      profiles.unshift({ id: 'claude-default', provider: 'claude', label: 'Primary', color: COLORS[0], configDir: defaultClaudeDir(), builtin: true, createdAt: now });
    }
    if (!profiles.some((p) => p.provider === 'codex' && p.builtin)) {
      profiles.push({ id: 'codex-default', provider: 'codex', label: 'Primary', color: COLORS[1], configDir: defaultCodexDir(), builtin: true, createdAt: now });
    }
    this.store.replace({ profiles });
  }

  list(): Profile[] {
    return this.store.data.profiles;
  }

  get(id: string): Profile | undefined {
    return this.list().find((p) => p.id === id);
  }

  require(id: string): Profile {
    const profile = this.get(id);
    if (!profile) throw new Error(`Unknown account ${id}`);
    return profile;
  }

  forProvider(provider: Provider) {
    return this.list().filter((p) => p.provider === provider);
  }

  views(active: Record<Provider, string>): ProfileView[] {
    return this.list().map((profile) => ({
      ...profile,
      identity: this.identities.get(profile.id) ?? null,
      limits: this.limits.get(profile.id) ?? null,
      planTier: this.planTier(profile),
      cliDefaults: cliDefaults(profile),
      isActive: active[profile.provider] === profile.id,
      isGlobalDefault: this.isGlobalDefault(profile),
      skillInstalled: this.skillChecker(profile),
      runningAgents: this.runningCounter(profile.id)
    }));
  }

  /**
   * Codex's usage endpoint reports the current plan_type, fresher than the
   * sign-in token's claim.
   */
  private planTier(profile: Profile): string | null {
    const reported = planTierLabel(profile.provider, this.limits.get(profile.id)?.planType);
    const signedIn = this.tiers.get(profile.id) ?? null;
    return profile.provider === 'codex' ? reported ?? signedIn : signedIn ?? reported;
  }

  private isGlobalDefault(profile: Profile) {
    const value = this.globalDefaults[profile.provider];
    if (!value) return profile.builtin;
    return samePath(value, profile.configDir);
  }

  /**
   * Environment an agent for this account runs with. The built-in account
   * must run with the override *removed*: Claude Code keeps .claude.json in
   * the home folder only when CLAUDE_CONFIG_DIR is unset.
   */
  envFor(profile: Profile, base: Record<string, string>): Record<string, string> {
    const env = { ...base };
    const name = ENV_VAR[profile.provider];
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name) delete env[key];
    }
    if (!profile.builtin) env[name] = profile.configDir;
    return env;
  }

  // -------------------------------------------------------------------------
  // Create / edit / remove
  // -------------------------------------------------------------------------

  create(input: NewProfileInput): Profile {
    const label = input.label.trim() || 'Account';
    const id = `${input.provider}-${slug(label)}-${crypto.randomBytes(2).toString('hex')}`;
    const configDir = path.join(profilesRoot(), id);
    fs.mkdirSync(configDir, { recursive: true });
    if (input.shareConfig) this.shareFromDefault(input.provider, configDir);
    const used = new Set(this.list().map((p) => p.color));
    const profile: Profile = {
      id,
      provider: input.provider,
      label,
      color: input.color ?? COLORS.find((c) => !used.has(c)) ?? COLORS[this.list().length % COLORS.length],
      configDir,
      builtin: false,
      createdAt: new Date().toISOString(),
      emailHint: input.emailHint?.trim() || undefined
    };
    this.store.replace({ profiles: [...this.list(), profile] });
    this.onChanged();
    return profile;
  }

  /** Copies settings files and links skill/agent folders from the default account. */
  shareFromDefault(provider: Provider, configDir: string) {
    const source = provider === 'claude' ? defaultClaudeDir() : defaultCodexDir();
    const shared = SHARED[provider];
    for (const file of shared.copy) {
      const from = path.join(source, file);
      if (exists(from)) fs.copyFileSync(from, path.join(configDir, file));
    }
    for (const dir of shared.link) {
      try {
        linkDirectory(path.join(source, dir), path.join(configDir, dir));
      } catch {
        // A folder that can't be linked is simply not shared.
      }
    }
  }

  update(id: string, patch: ProfilePatch) {
    const profiles = this.list().map((p) => (p.id === id ? applyProfilePatch(p, patch) : p));
    this.store.replace({ profiles });
    this.onChanged();
  }

  remove(id: string, deleteData: boolean) {
    const profile = this.require(id);
    if (profile.builtin) throw new Error('The primary account uses the tool\'s own folder and cannot be removed.');
    if (deleteData && path.resolve(profile.configDir).startsWith(path.resolve(profilesRoot()))) {
      removeTree(profile.configDir);
    }
    this.store.replace({ profiles: this.list().filter((p) => p.id !== id) });
    this.identities.delete(id);
    this.limits.delete(id);
    this.tiers.delete(id);
    this.onChanged();
  }

  // -------------------------------------------------------------------------
  // Identity and plan limits
  // -------------------------------------------------------------------------

  async refresh(ids?: string[]) {
    const targets = ids ? this.list().filter((p) => ids.includes(p.id)) : this.list();
    await Promise.all([
      this.readGlobalDefaults(),
      ...targets.map(async (profile) => {
        try {
          this.identities.set(profile.id, profile.provider === 'claude' ? this.claudeIdentity(profile) : this.codexIdentity(profile));
        } catch (error) {
          this.identities.set(profile.id, blankIdentity(String(error)));
          this.tiers.delete(profile.id);
        }
        try {
          await this.refreshLimits(profile, Boolean(ids));
        } catch {
          // Limits are best-effort.
        }
      })
    ]);
    this.onChanged();
  }

  /** Claude's global config: ~/.claude.json for the built-in account, <dir>/.claude.json otherwise. */
  private claudeGlobalConfig(profile: Profile) {
    return profile.builtin ? path.join(HOME, '.claude.json') : path.join(profile.configDir, '.claude.json');
  }

  private claudeIdentity(profile: Profile): ProfileIdentity {
    const config = readJsonFile<any>(this.claudeGlobalConfig(profile)) ?? {};
    const credentials = readJsonFile<any>(path.join(profile.configDir, '.credentials.json'));
    const oauth = credentials?.claudeAiOauth;
    const account = config.oauthAccount ?? {};
    const loggedIn = Boolean(oauth?.accessToken || oauth?.refreshToken) || Boolean(process.env.ANTHROPIC_API_KEY && profile.builtin);
    const plan = oauth?.subscriptionType ?? planFromOrg(account.organizationType) ?? null;
    this.tiers.set(profile.id, oauth ? planTierLabel('claude', plan) : null);
    return {
      loggedIn,
      email: account.emailAddress ?? null,
      name: account.displayName ?? account.fullName ?? null,
      plan,
      org: account.organizationName ?? null,
      authMethod: oauth ? 'Claude account' : loggedIn ? 'API key' : null,
      checkedAt: new Date().toISOString(),
      error: null
    };
  }

  /**
   * Asks the tool's usage endpoint, then takes whatever the CLI itself last
   * recorded (Claude's cached copy, Codex's rollout files) if that is newer.
   * With neither, the last numbers seen stay; their observedAt says how old.
   */
  private async refreshLimits(profile: Profile, force: boolean) {
    if (!this.identities.get(profile.id)?.loggedIn) {
      this.limits.delete(profile.id);
      return;
    }
    try {
      const live = await this.liveLimitsLoader(profile, force);
      if (live) this.mergeLimits(profile.id, live);
    } catch {
      // Offline or rejected: the CLI's own record below still applies.
    }
    const recorded = profile.provider === 'claude' ? this.claudeLimits(profile) : await this.codexLimitsLoader(profile);
    if (recorded) this.mergeLimits(profile.id, recorded);
  }

  private claudeLimits(profile: Profile): ProfileLimits | null {
    const config = readJsonFile<any>(this.claudeGlobalConfig(profile));
    const cached = config?.cachedUsageUtilization;
    const utilization = cached?.utilization;
    if (!utilization) return null;
    const accountUuid = config?.oauthAccount?.accountUuid;
    if (cached.accountUuid && accountUuid && cached.accountUuid !== accountUuid) return null;
    const windows: LimitWindow[] = [];
    const add = (id: string, label: string) => {
      const entry = utilization[id];
      if (!entry || typeof entry.utilization !== 'number') return;
      windows.push({ id, label, usedPercent: Math.max(0, Math.min(100, entry.utilization)), resetsAt: entry.resets_at ?? null });
    };
    add('five_hour', '5-hour');
    add('seven_day', 'Weekly');
    add('seven_day_opus', 'Weekly Opus');
    add('seven_day_sonnet', 'Weekly Sonnet');
    if (windows.length === 0) return null;
    return {
      windows,
      observedAt: cached.fetchedAtMs ? new Date(cached.fetchedAtMs).toISOString() : null,
      planType: readJsonFile<any>(path.join(profile.configDir, '.credentials.json'))?.claudeAiOauth?.subscriptionType ?? null
    };
  }

  private codexIdentity(profile: Profile): ProfileIdentity {
    const auth = readJsonFile<any>(path.join(profile.configDir, 'auth.json'));
    this.tiers.delete(profile.id);
    if (!auth) return blankIdentity(null);
    if (auth.OPENAI_API_KEY && !auth.tokens) {
      return { ...blankIdentity(null), loggedIn: true, authMethod: 'API key' };
    }
    const claims = typeof auth.tokens?.id_token === 'string' ? decodeJwtPayload(auth.tokens.id_token) : null;
    const openai = claims?.['https://api.openai.com/auth'] ?? {};
    this.tiers.set(profile.id, planTierLabel('codex', openai.chatgpt_plan_type));
    return {
      loggedIn: Boolean(auth.tokens?.refresh_token || auth.tokens?.access_token),
      email: claims?.email ?? null,
      name: claims?.name ?? null,
      plan: openai.chatgpt_plan_type ?? null,
      org: null,
      authMethod: 'ChatGPT account',
      checkedAt: new Date().toISOString(),
      error: null
    };
  }

  /**
   * Takes newer numbers, keeping windows the new report doesn't cover: the
   * status line knows the 5-hour and weekly windows but not the spend cap.
   */
  private mergeLimits(id: string, limits: ProfileLimits): boolean {
    const current = this.limits.get(id);
    const newer = !current || Date.parse(limits.observedAt ?? '') >= Date.parse(current.observedAt ?? '');
    if (!newer) return false;
    const reported = new Set(limits.windows.map((w) => w.id));
    const kept = (current?.windows ?? []).filter((w) => !reported.has(w.id));
    this.limits.set(id, { ...limits, windows: [...limits.windows, ...kept], planType: limits.planType ?? current?.planType ?? null });
    return true;
  }

  private limitsNotifyAt = 0;

  /** Plan limits reported live by a running session (Claude's status line). */
  applyReportedLimits(id: string, limits: ProfileLimits) {
    if (!this.mergeLimits(id, limits)) return;
    // Status lines refresh often; tell the UI at most every few seconds.
    if (Date.now() - this.limitsNotifyAt > 5000) {
      this.limitsNotifyAt = Date.now();
      this.onChanged();
    }
  }

  // -------------------------------------------------------------------------
  // The account other apps use
  // -------------------------------------------------------------------------

  private async readGlobalDefaults() {
    for (const provider of ['claude', 'codex'] as Provider[]) {
      const result = await run('reg.exe', ['query', 'HKCU\\Environment', '/v', ENV_VAR[provider]], { timeout: 5000 });
      const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(result.stdout);
      this.globalDefaults[provider] = result.code === 0 && match ? match[1].trim() : null;
    }
  }

  /**
   * Points other apps (VS Code extensions, the desktop apps, new terminals)
   * at this account by setting or clearing the user-level CLAUDE_CONFIG_DIR /
   * CODEX_HOME. Apps that are already running keep their old environment
   * until they restart.
   */
  async setGlobalDefault(id: string) {
    const profile = this.require(id);
    const name = ENV_VAR[profile.provider];
    const value = profile.builtin ? '$null' : psQuote(profile.configDir);
    const result = await runPowerShell(`[Environment]::SetEnvironmentVariable(${psQuote(name)}, ${value}, 'User')`, { timeout: 20_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not update ${name}`);
    await this.readGlobalDefaults();
    this.onChanged();
  }
}

/** The editable fields of an account; an empty defaultModel / defaultEffort / emailHint clears it. */
export interface ProfilePatch {
  label?: string;
  color?: string;
  emailHint?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

/** Applies an edit, taking only the editable fields; a blank label keeps the old one. */
export function applyProfilePatch(profile: Profile, patch: ProfilePatch): Profile {
  const next: Profile = { ...profile };
  if (patch.label !== undefined) next.label = patch.label.trim() || profile.label;
  if (patch.color !== undefined && patch.color) next.color = patch.color;
  for (const key of ['emailHint', 'defaultModel', 'defaultEffort'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
  }
  return next;
}

function blankIdentity(error: string | null): ProfileIdentity {
  return { loggedIn: false, email: null, name: null, plan: null, org: null, authMethod: null, checkedAt: new Date().toISOString(), error };
}

function planFromOrg(type: unknown): string | null {
  if (typeof type !== 'string') return null;
  return type.replace(/^claude_/, '') || null;
}

const TIER_NAMES: Record<Provider, Record<string, string>> = {
  claude: { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' },
  codex: {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    education: 'Edu'
  }
};

const defaultsCache = new Map<string, { mtimeMs: number; value: CliDefaults }>();

/**
 * The model and effort the CLI uses when none is given: Claude Code's
 * settings.json (`model`, `effortLevel`), Codex's config.toml (`model`,
 * `model_reasoning_effort`, top level only). Claude's `availableModels` is
 * the list of models it will run.
 */
export function cliDefaults(profile: Profile): CliDefaults {
  const file = path.join(profile.configDir, profile.provider === 'claude' ? 'settings.json' : 'config.toml');
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // no file: the CLI's built-in defaults
  }
  const cached = defaultsCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  let value: CliDefaults = { model: null, effort: null, models: null };
  if (mtimeMs >= 0) {
    if (profile.provider === 'claude') {
      const settings = readJsonFile<any>(file) ?? {};
      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const models = Array.isArray(settings.availableModels) ? settings.availableModels.map(text).filter((m: string | null): m is string => Boolean(m)) : [];
      value = { model: text(settings.model), effort: text(settings.effortLevel), models: models.length ? models : null };
    } else {
      value = { ...codexTopLevel(fs.readFileSync(file, 'utf8')), models: null };
    }
  }
  defaultsCache.set(file, { mtimeMs, value });
  return value;
}

/** `model` and `model_reasoning_effort` from config.toml's top level (before the first table). */
export function codexTopLevel(toml: string): { model: string | null; effort: string | null } {
  const values: Record<string, string> = {};
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return { model: values.model || null, effort: values.model_reasoning_effort || null };
}

/** The plan's short name ("Max", "Pro"), without its usage multiple. */
export function planTierLabel(provider: Provider, plan: unknown): string | null {
  if (typeof plan !== 'string' || !plan.trim()) return null;
  const key = plan.trim().toLowerCase().replace(/^claude_/, '');
  return TIER_NAMES[provider][key] ?? key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

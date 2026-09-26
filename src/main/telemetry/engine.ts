import fs from 'node:fs';
import path from 'node:path';
import type {
  ProfileLimits,
  Provider,
  SessionTelemetry,
  UsageDay,
  UsageModelRow,
  UsageReport,
  UsageSessionRow
} from '../../shared/types';
import { contextWindowForModel, costFromModels, currentPricing, pricingVersion, type ModelAccumulator } from './pricing';
import {
  ClaudeTranscriptParser,
  claudeContextWindow,
  claudeTitle,
  isSubagentTranscript,
  type ClaudeTranscriptState
} from './claudeTranscript';
import { CodexRolloutParser, codexTitle, type CodexRolloutState } from './codexRollout';
import { localDay, object, nonNegative, parseTime, text, type DayAccumulator } from './jsonl';

export interface EngineProfile {
  id: string;
  provider: Provider;
  configDir: string;
}

export interface EngineSettings {
  claudeContextWindow: number;
  contextWindowOverrides: Record<string, number>;
  usageDays: number;
}

/** Serializable per-file result, cached on disk between app runs. */
export interface FileSummary {
  provider: Provider;
  profileId: string;
  filePath: string;
  size: number;
  mtimeMs: number;
  sessionId: string;
  isSubagent: boolean;
  title: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  byDay: Record<string, DayAccumulator>;
  byModel: Record<string, { usd: number | null; tokens: number; requests: number }>;
  tokens: number;
  requests: number;
  contextPercent: number | null;
  compactions: number;
  working: boolean;
  limits: ProfileLimits | null;
  /** pricingVersion() the costs were computed with. */
  pricing?: string;
}

const ACTIVE_WRITE_MS = 45_000;
const CACHE_VERSION = 4;

type Parser = ClaudeTranscriptParser | CodexRolloutParser;

export class TelemetryEngine {
  private profiles: EngineProfile[] = [];
  private settings: EngineSettings = { claudeContextWindow: 1_000_000, contextWindowOverrides: {}, usageDays: 30 };
  private parsers = new Map<string, { parser: Parser; profileId: string; lastUsed: number }>();
  private summaries = new Map<string, FileSummary>();
  private cacheDirty = false;
  private scanPromise: Promise<void> | null = null;
  private lastScanAt = 0;
  scanning = false;
  scannedFiles = 0;

  constructor(private cachePath: string | null, private onProgress: (scanned: number) => void = () => {}) {
    this.loadCache();
  }

  configure(profiles: EngineProfile[], settings: Partial<EngineSettings>) {
    this.profiles = profiles;
    this.settings = { ...this.settings, ...settings };
  }

  /** Prices changed: live parsers hold costs at the old rates, and the next scan re-prices every file. */
  pricingChanged() {
    this.parsers.clear();
    this.lastScanAt = 0;
  }

  // -------------------------------------------------------------------------
  // Live session telemetry (one agent)
  // -------------------------------------------------------------------------

  private parserFor(provider: Provider, filePath: string, profileId: string): Parser {
    let entry = this.parsers.get(filePath);
    if (!entry) {
      const parser = provider === 'claude' ? new ClaudeTranscriptParser(filePath) : new CodexRolloutParser(filePath);
      entry = { parser, profileId, lastUsed: Date.now() };
      this.parsers.set(filePath, entry);
      this.evictParsers();
    }
    entry.lastUsed = Date.now();
    return entry.parser;
  }

  /** Parsers hold per-request dedup state; keep only the recently used ones in memory. */
  private evictParsers() {
    const limit = 400;
    if (this.parsers.size <= limit) return;
    const oldest = [...this.parsers.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of oldest.slice(0, this.parsers.size - limit)) this.parsers.delete(key);
  }

  async sessionTelemetry(provider: Provider, profileId: string, filePath: string): Promise<SessionTelemetry | null> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    const parser = this.parserFor(provider, filePath, profileId);
    if (provider === 'claude') {
      const state = await (parser as ClaudeTranscriptParser).update();
      // Subagent spend belongs to the session too.
      const subagents = await this.claudeSubagentFiles(filePath);
      const subStates: ClaudeTranscriptState[] = [];
      for (const sub of subagents) {
        subStates.push(await (this.parserFor('claude', sub, profileId) as ClaudeTranscriptParser).update());
      }
      this.storeSummary(this.claudeSummary(profileId, filePath, stat, state));
      const profile = this.profiles.find((p) => p.id === profileId);
      const snapshot = profile ? await readStatusLineSnapshot(profile.configDir, state.sessionId) : null;
      return this.claudeTelemetry(filePath, state, subStates, snapshot, stat.mtimeMs);
    }
    const state = await (parser as CodexRolloutParser).update();
    // Names (set in Codex's apps, or by renaming here) live in its session index, not the rollout.
    const profile = this.profiles.find((p) => p.id === profileId);
    const indexed = profile ? (await readCodexIndex(profile.configDir)).get(state.sessionId) ?? null : null;
    this.storeSummary(this.codexSummary(profileId, filePath, stat, state, indexed));
    return this.codexTelemetry(filePath, state, indexed);
  }

  private async claudeSubagentFiles(transcriptPath: string): Promise<string[]> {
    const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
    try {
      const entries = await fs.promises.readdir(dir);
      return entries.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  private claudeTelemetry(
    filePath: string,
    state: ClaudeTranscriptState,
    subStates: ClaudeTranscriptState[],
    snapshot: StatusLineSnapshot | null,
    mtimeMs: number
  ): SessionTelemetry {
    const byModel = new Map<string, ModelAccumulator>();
    for (const source of [state, ...subStates]) mergeModels(byModel, source.byModel);
    const requests = [state, ...subStates].reduce((sum, s) => sum + s.requests, 0);
    const totals = { ...state.totals };
    for (const sub of subStates) {
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += sub.totals[key];
    }
    const { window, assumed } = claudeContextWindow(
      state,
      contextWindowForModel(state.model),
      this.settings.claudeContextWindow,
      this.settings.contextWindowOverrides
    );
    let contextWindow = window;
    let contextWindowAssumed = assumed;
    let used = state.lastUsage ? state.lastUsage.inputTokens : 0;
    let percent: number | null = contextWindow > 0 && state.lastUsage ? (used / contextWindow) * 100 : null;
    const snapshotFresh = snapshot && parseTime(snapshot.capturedAt) >= parseTime(state.updatedAt) - 60_000;
    if (snapshot && snapshotFresh && snapshot.contextWindow > 0) {
      contextWindow = snapshot.contextWindow;
      contextWindowAssumed = false;
      used = snapshot.contextUsed || used;
      percent = snapshot.contextPercent ?? (used / contextWindow) * 100;
    }
    const reported = snapshot?.costUsd ?? state.reportedCostUsd;
    return {
      provider: 'claude',
      sessionId: state.sessionId,
      filePath,
      title: claudeTitle(state),
      cwd: state.cwd,
      model: state.model,
      effort: state.effort,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt ?? new Date(mtimeMs).toISOString(),
      contextWindow,
      contextUsedTokens: used,
      contextPercent: percent,
      contextWindowAssumed,
      lastUsage: state.lastUsage,
      totalUsage: requests > 0 ? totals : null,
      requests,
      compactions: state.compactions,
      lastCompactionAt: state.lastCompactionAt,
      taskActive: state.turn === null ? null : state.turn === 'working',
      cost: costFromModels(byModel, reported),
      limits: null,
      source: snapshot && snapshotFresh ? 'status-line' : 'transcript'
    };
  }

  private codexTelemetry(filePath: string, state: CodexRolloutState, indexedTitle: string | null): SessionTelemetry {
    const override = state.model ? this.settings.contextWindowOverrides[state.model] : undefined;
    const contextWindow = override ?? state.contextWindow;
    const used = state.lastUsage ? state.lastUsage.totalTokens : 0;
    return {
      provider: 'codex',
      sessionId: state.sessionId,
      filePath,
      title: codexTitle(state, indexedTitle),
      cwd: state.cwd,
      model: state.model,
      effort: state.effort,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      contextWindow,
      contextUsedTokens: used,
      contextPercent: contextWindow > 0 && state.lastUsage ? (used / contextWindow) * 100 : null,
      contextWindowAssumed: override !== undefined,
      lastUsage: state.lastUsage,
      totalUsage: state.totalUsage,
      requests: state.requests,
      compactions: state.compactions,
      lastCompactionAt: state.lastCompactionAt,
      taskActive: state.taskActive,
      cost: costFromModels(state.byModel),
      limits: state.limits,
      source: 'rollout'
    };
  }

  // -------------------------------------------------------------------------
  // Finding an agent's session file
  // -------------------------------------------------------------------------

  async findClaudeTranscript(configDir: string, sessionId: string): Promise<string | null> {
    const root = path.join(configDir, 'projects');
    let projects: string[];
    try {
      projects = await fs.promises.readdir(root);
    } catch {
      return null;
    }
    for (const project of projects) {
      const candidate = path.join(root, project, `${sessionId}.jsonl`);
      try {
        await fs.promises.access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return null;
  }

  /** Newest top-level Claude transcript for a working directory written after `sinceMs`. */
  async findLatestClaudeTranscript(configDir: string, cwd: string, sinceMs: number, exclude: string[]): Promise<string | null> {
    const root = path.join(configDir, 'projects');
    const wanted = comparablePath(cwd);
    let projects: string[];
    try {
      projects = await fs.promises.readdir(root);
    } catch {
      return null;
    }
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    let best: { file: string; mtime: number } | null = null;
    for (const project of projects) {
      if (project.toLowerCase() !== encoded && !project.toLowerCase().startsWith(encoded.slice(0, 180))) continue;
      const dir = path.join(root, project);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        if (exclude.some((other) => comparablePath(other) === comparablePath(file))) continue;
        try {
          const stat = await fs.promises.stat(file);
          if (stat.mtimeMs < sinceMs - 2000) continue;
          if (!best || stat.mtimeMs > best.mtime) best = { file, mtime: stat.mtimeMs };
        } catch {
          // ignore
        }
      }
    }
    if (best) {
      const state = await new ClaudeTranscriptParser(best.file).update();
      if (state.cwd && comparablePath(state.cwd) !== wanted) return null;
    }
    return best?.file ?? null;
  }

  /** The rollout a freshly launched Codex agent wrote: same cwd, created after launch. */
  async findCodexRollout(codexHome: string, cwd: string, sinceMs: number, exclude: string[]): Promise<string | null> {
    const wanted = comparablePath(cwd);
    const days = [new Date(sinceMs), new Date(Date.now())];
    const dirs = new Set(days.map((d) => path.join(codexHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))));
    const candidates: Array<{ file: string; birth: number }> = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        if (exclude.some((other) => comparablePath(other) === comparablePath(file))) continue;
        try {
          const stat = await fs.promises.stat(file);
          const birth = stat.birthtimeMs || stat.ctimeMs;
          if (birth >= sinceMs - 3000) candidates.push({ file, birth });
        } catch {
          // ignore
        }
      }
    }
    candidates.sort((a, b) => a.birth - b.birth);
    for (const candidate of candidates) {
      const meta = await readFirstJsonLine(candidate.file);
      const payload = object(meta?.payload);
      if (!payload || meta?.type !== 'session_meta') continue;
      if (payload.thread_source === 'subagent') continue;
      if (comparablePath(text(payload.cwd) ?? '') === wanted) return candidate.file;
    }
    return null;
  }

  /** A resumed Codex session keeps writing to its original rollout. */
  async findCodexRolloutById(codexHome: string, sessionId: string): Promise<string | null> {
    const wanted = `${sessionId.toLowerCase()}.jsonl`;
    const files = await listFiles(path.join(codexHome, 'sessions'), 0);
    const match = files.filter((f) => f.filePath.toLowerCase().endsWith(wanted)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return match?.filePath ?? null;
  }

  // -------------------------------------------------------------------------
  // Usage analytics across every account
  // -------------------------------------------------------------------------

  async usageReport(force = false): Promise<UsageReport> {
    if (force || !this.scanPromise || Date.now() - this.lastScanAt > 60_000) {
      if (!this.scanning) {
        this.scanPromise = this.scan().finally(() => {
          this.lastScanAt = Date.now();
        });
      }
    }
    await this.scanPromise;
    return this.buildReport();
  }

  /** Returns what is known right now without waiting for a scan. */
  quickReport(): UsageReport {
    return this.buildReport();
  }

  limitsFor(profileId: string): ProfileLimits | null {
    let best: ProfileLimits | null = null;
    for (const summary of this.summaries.values()) {
      if (summary.profileId !== profileId || !summary.limits) continue;
      if (!best || parseTime(summary.limits.observedAt) > parseTime(best.observedAt)) best = summary.limits;
    }
    return best;
  }

  /** Latest Codex rate limits for an account, parsing its newest rollouts if the scan hasn't yet. */
  async codexLimits(profile: EngineProfile): Promise<ProfileLimits | null> {
    const known = this.limitsFor(profile.id);
    const files = await listFiles(path.join(profile.configDir, 'sessions'), Date.now() - 14 * 86_400_000);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files.slice(0, 4)) {
      if (known && parseTime(known.observedAt) >= file.mtimeMs - 1000) break;
      const cached = this.summaries.get(file.filePath);
      if (cached && cached.size === file.size && cached.limits) {
        if (!known || parseTime(cached.limits.observedAt) > parseTime(known.observedAt)) return cached.limits;
        continue;
      }
      const state = await (this.parserFor('codex', file.filePath, profile.id) as CodexRolloutParser).update();
      this.storeSummary(this.codexSummary(profile.id, file.filePath, file, state, null));
      if (state.limits) return state.limits;
    }
    return known;
  }

  private async scan() {
    this.scanning = true;
    this.scannedFiles = 0;
    const cutoff = Date.now() - Math.max(1, this.settings.usageDays) * 86_400_000;
    try {
      for (const profile of this.profiles) {
        const roots = profile.provider === 'claude'
          ? [path.join(profile.configDir, 'projects')]
          : [path.join(profile.configDir, 'sessions'), path.join(profile.configDir, 'archived_sessions')];
        const titles = profile.provider === 'codex' ? await readCodexIndex(profile.configDir) : new Map<string, string>();
        for (const root of roots) {
          const files = await listFiles(root, cutoff);
          for (const file of files) {
            this.scannedFiles += 1;
            if (this.scannedFiles % 25 === 0) this.onProgress(this.scannedFiles);
            const cached = this.summaries.get(file.filePath);
            if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.profileId === profile.id && cached.pricing === pricingVersion()) {
              if (profile.provider === 'codex') cached.title = titles.get(cached.sessionId) ?? cached.title;
              continue;
            }
            try {
              await this.summarizeFile(profile, file, titles);
            } catch {
              // A file deleted or locked mid-scan is simply skipped.
            }
            // Yield so live session requests are served during a long scan.
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
      // Forget files that no longer exist or no longer belong to a configured account.
      const profileIds = new Set(this.profiles.map((p) => p.id));
      for (const [key, summary] of this.summaries) {
        if (!profileIds.has(summary.profileId)) this.summaries.delete(key);
      }
    } finally {
      this.scanning = false;
      this.saveCache();
    }
  }

  private async summarizeFile(profile: EngineProfile, file: { filePath: string; size: number; mtimeMs: number }, titles: Map<string, string>) {
    const existing = this.parsers.get(file.filePath);
    // A one-off parser for cold files keeps memory flat; live files reuse theirs.
    if (profile.provider === 'claude') {
      const parser = (existing?.parser as ClaudeTranscriptParser) ?? new ClaudeTranscriptParser(file.filePath);
      const state = await parser.update();
      this.storeSummary(this.claudeSummary(profile.id, file.filePath, file, state));
    } else {
      const parser = (existing?.parser as CodexRolloutParser) ?? new CodexRolloutParser(file.filePath);
      const state = await parser.update();
      this.storeSummary(this.codexSummary(profile.id, file.filePath, file, state, titles.get(state.sessionId) ?? null));
    }
  }

  private claudeSummary(profileId: string, filePath: string, stat: { size: number; mtimeMs: number }, state: ClaudeTranscriptState): FileSummary {
    const window = claudeContextWindow(state, contextWindowForModel(state.model), this.settings.claudeContextWindow, this.settings.contextWindowOverrides).window;
    return {
      provider: 'claude',
      profileId,
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionId: state.sessionId,
      isSubagent: isSubagentTranscript(filePath),
      title: claudeTitle(state),
      cwd: state.cwd,
      model: state.model,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      byDay: Object.fromEntries(state.byDay),
      byModel: modelsRecord(state.byModel),
      tokens: state.totals.totalTokens,
      requests: state.requests,
      contextPercent: state.lastUsage && window > 0 ? (state.lastUsage.inputTokens / window) * 100 : null,
      compactions: state.compactions,
      working: state.turn === 'working',
      limits: null
    };
  }

  private codexSummary(profileId: string, filePath: string, stat: { size: number; mtimeMs: number }, state: CodexRolloutState, title: string | null): FileSummary {
    return {
      provider: 'codex',
      profileId,
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionId: state.sessionId,
      isSubagent: state.isSubagent,
      title: codexTitle(state, title),
      cwd: state.cwd,
      model: state.model,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      byDay: Object.fromEntries(state.byDay),
      byModel: modelsRecord(state.byModel),
      tokens: state.totalUsage?.totalTokens ?? 0,
      requests: state.requests,
      contextPercent: state.lastUsage && state.contextWindow > 0 ? (state.lastUsage.totalTokens / state.contextWindow) * 100 : null,
      compactions: state.compactions,
      working: state.taskActive,
      limits: state.limits
    };
  }

  private storeSummary(summary: FileSummary) {
    const previous = this.summaries.get(summary.filePath);
    if (previous && summary.provider === 'codex' && !summary.title) summary.title = previous.title;
    summary.pricing = pricingVersion();
    this.summaries.set(summary.filePath, summary);
    this.cacheDirty = true;
  }

  private buildReport(): UsageReport {
    const now = Date.now();
    const rangeDays = Math.max(1, this.settings.usageDays);
    const dayKeys: string[] = [];
    for (let i = rangeDays - 1; i >= 0; i -= 1) {
      const key = localDay(now - i * 86_400_000);
      if (key) dayKeys.push(key);
    }
    const dayIndex = new Map<string, UsageDay>(
      dayKeys.map((date) => [date, { date, byProvider: { claude: 0, codex: 0 }, byProfile: {}, tokens: 0, requests: 0 }])
    );
    const sessions = new Map<string, UsageSessionRow>();
    const models = new Map<string, UsageModelRow>();
    const profileIds = new Set(this.profiles.map((p) => p.id));

    for (const summary of this.summaries.values()) {
      if (!profileIds.has(summary.profileId)) continue;
      let sessionUsd = 0;
      let sessionPriced = false;
      let rangeTokens = 0;
      let rangeRequests = 0;
      for (const [date, day] of Object.entries(summary.byDay)) {
        const bucket = dayIndex.get(date);
        if (!bucket) continue;
        bucket.byProvider[summary.provider] += day.usd;
        bucket.byProfile[summary.profileId] = (bucket.byProfile[summary.profileId] ?? 0) + day.usd;
        bucket.tokens += day.tokens;
        bucket.requests += day.requests;
        rangeTokens += day.tokens;
        rangeRequests += day.requests;
      }
      if (rangeRequests === 0 && now - summary.mtimeMs > 86_400_000 * rangeDays) continue;
      for (const [model, entry] of Object.entries(summary.byModel)) {
        const key = `${summary.provider}:${model}`;
        const row: UsageModelRow = models.get(key) ?? { provider: summary.provider, model, usd: null, tokens: 0, requests: 0 };
        row.tokens += entry.tokens;
        row.requests += entry.requests;
        if (entry.usd !== null) row.usd = (row.usd ?? 0) + entry.usd;
        models.set(key, row);
        if (entry.usd !== null) {
          sessionUsd += entry.usd;
          sessionPriced = true;
        }
      }
      const key = `${summary.profileId}:${summary.sessionId}`;
      const row = sessions.get(key);
      const active = summary.working
        ? now - summary.mtimeMs < 10 * 60_000
        : now - summary.mtimeMs < ACTIVE_WRITE_MS;
      if (!row) {
        sessions.set(key, {
          provider: summary.provider,
          profileId: summary.profileId,
          sessionId: summary.sessionId,
          filePath: summary.filePath,
          title: summary.isSubagent ? null : summary.title,
          cwd: summary.cwd,
          model: summary.isSubagent ? null : summary.model,
          startedAt: summary.startedAt,
          updatedAt: summary.updatedAt ?? new Date(summary.mtimeMs).toISOString(),
          costUsd: sessionPriced ? sessionUsd : null,
          tokens: summary.tokens,
          requests: summary.requests,
          contextPercent: summary.isSubagent ? null : summary.contextPercent,
          compactions: summary.compactions,
          active: active && !summary.isSubagent
        });
      } else {
        // Merge a subagent transcript into its parent session (or vice versa).
        if (sessionPriced) row.costUsd = (row.costUsd ?? 0) + sessionUsd;
        row.tokens += summary.tokens;
        row.requests += summary.requests;
        if (!summary.isSubagent) {
          row.title = summary.title;
          row.model = summary.model;
          row.filePath = summary.filePath;
          row.contextPercent = summary.contextPercent;
          row.compactions = summary.compactions;
          row.active = active;
          row.cwd = summary.cwd ?? row.cwd;
        }
        const updated = summary.updatedAt ?? new Date(summary.mtimeMs).toISOString();
        if (parseTime(updated) > parseTime(row.updatedAt)) row.updatedAt = updated;
      }
    }

    const days = [...dayIndex.values()];
    const sum = (list: UsageDay[]) => list.reduce((total, d) => total + d.byProvider.claude + d.byProvider.codex, 0);
    const sessionRows = [...sessions.values()]
      .filter((row) => row.requests > 0 || row.active)
      .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
      .slice(0, 300);
    return {
      generatedAt: new Date(now).toISOString(),
      days,
      sessions: sessionRows,
      models: [...models.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
      totals: {
        today: sum(days.slice(-1)),
        week: sum(days.slice(-7)),
        month: sum(days.slice(-30)),
        range: sum(days)
      },
      scanning: this.scanning,
      scannedFiles: this.scannedFiles,
      pricingDate: currentPricing().pricingDate
    };
  }

  // -------------------------------------------------------------------------
  // Disk cache
  // -------------------------------------------------------------------------

  private loadCache() {
    if (!this.cachePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (raw?.version !== CACHE_VERSION) return;
      for (const summary of raw.files as FileSummary[]) this.summaries.set(summary.filePath, summary);
    } catch {
      // No cache yet, or a stale format: the next scan rebuilds it.
    }
  }

  saveCache() {
    if (!this.cachePath || !this.cacheDirty) return;
    try {
      const payload = JSON.stringify({ version: CACHE_VERSION, files: [...this.summaries.values()] });
      const tmp = `${this.cachePath}.tmp`;
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.cachePath);
      this.cacheDirty = false;
    } catch {
      // Caching is an optimisation; failures are not fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function comparablePath(value: string): string {
  if (!value) return '';
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function mergeModels(target: Map<string, ModelAccumulator>, source: Map<string, ModelAccumulator>) {
  for (const [model, entry] of source) {
    const existing = target.get(model);
    if (!existing) {
      target.set(model, { usage: { ...entry.usage }, usd: entry.usd, priced: entry.priced, requests: entry.requests });
      continue;
    }
    for (const key of Object.keys(existing.usage) as Array<keyof typeof existing.usage>) existing.usage[key] += entry.usage[key];
    existing.usd += entry.usd;
    existing.priced = existing.priced && entry.priced;
    existing.requests += entry.requests;
  }
}

function modelsRecord(byModel: Map<string, ModelAccumulator>) {
  const record: FileSummary['byModel'] = {};
  for (const [model, entry] of byModel) {
    record[model] = { usd: entry.priced ? entry.usd : null, tokens: entry.usage.totalTokens, requests: entry.requests };
  }
  return record;
}

async function listFiles(root: string, cutoffMs: number) {
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.promises.stat(full);
          if (stat.mtimeMs >= cutoffMs) files.push({ filePath: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // vanished
        }
      }
    }
  }
  return files;
}

async function readFirstJsonLine(filePath: string): Promise<any> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const line = buffer.subarray(0, newline >= 0 ? newline : bytesRead).toString('utf8');
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readCodexIndex(codexHome: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const content = await fs.promises.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id && typeof entry.thread_name === 'string') titles.set(entry.id, entry.thread_name);
      } catch {
        // partial line while Codex appends
      }
    }
  } catch {
    // no index
  }
  return titles;
}

interface StatusLineSnapshot {
  capturedAt: string | null;
  contextWindow: number;
  contextUsed: number;
  contextPercent: number | null;
  costUsd: number | null;
}

/**
 * Snapshots written by the AI Session Monitor status-line bridge, when it is
 * installed for this config dir. They carry Claude Code's authoritative
 * context-window size and its own cost estimate.
 */
async function readStatusLineSnapshot(configDir: string, sessionId: string): Promise<StatusLineSnapshot | null> {
  const file = path.join(configDir, 'ai-session-monitor', 'state', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  try {
    const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const snapshot = object(record?.snapshot) ?? object(record) ?? {};
    const context = object(snapshot.context_window) ?? {};
    const cost = object(snapshot.cost) ?? {};
    const percent = Number(context.used_percentage);
    const costUsd = Number(cost.total_cost_usd);
    return {
      capturedAt: text(record?.capturedAt),
      contextWindow: nonNegative(context.context_window_size),
      contextUsed: nonNegative(context.total_input_tokens),
      contextPercent: Number.isFinite(percent) ? percent : null,
      costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null
    };
  } catch {
    return null;
  }
}

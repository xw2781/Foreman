import path from 'node:path';
import type { TokenUsage } from '../../shared/types';
import { emptyUsage, recordRequest, type ModelAccumulator } from './pricing';
import {
  IncrementalLineReader,
  addToDay,
  localDay,
  nonNegative,
  object,
  promptTitle,
  text,
  tryParse,
  type DayAccumulator
} from './jsonl';

/**
 * Everything the app needs from one Claude Code transcript, built by a single
 * incremental pass. Message text is never retained: only token counts, model
 * ids, timestamps, the chat title Claude Code records, and the first line of
 * the most recent prompt (as a title fallback) survive the parse.
 */
export interface ClaudeTranscriptState {
  sessionId: string;
  cwd: string | null;
  version: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  /** The first prompt: a stable name until the session has a real title. */
  firstPrompt: string | null;
  model: string | null;
  effort: string | null;
  lastUsage: TokenUsage | null;
  totals: TokenUsage;
  requests: number;
  byModel: Map<string, ModelAccumulator>;
  byDay: Map<string, DayAccumulator>;
  compactions: number;
  lastCompactionAt: string | null;
  /** 'working' while a turn is in flight, 'done' once the model ended its turn. */
  turn: 'working' | 'done' | null;
  /** Claude Code's own running estimate (the transcript's latest cost-state record). */
  reportedCostUsd: number | null;
  /** Model ids as Claude Code names them, e.g. "claude-opus-5-5[1m]". */
  reportedModels: string[];
}

function initialState(filePath: string): ClaudeTranscriptState {
  return {
    sessionId: sessionIdForTranscript(filePath),
    cwd: null,
    version: null,
    gitBranch: null,
    entrypoint: null,
    startedAt: null,
    updatedAt: null,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    firstPrompt: null,
    model: null,
    effort: null,
    lastUsage: null,
    totals: emptyUsage(),
    requests: 0,
    byModel: new Map(),
    byDay: new Map(),
    compactions: 0,
    lastCompactionAt: null,
    turn: null,
    reportedCostUsd: null,
    reportedModels: []
  };
}

/**
 * Subagent transcripts live beside their parent: projects/<project>/<session>/subagents/agent-*.jsonl.
 * Their spend belongs to the parent session, so they report the parent's id.
 */
export function sessionIdForTranscript(filePath: string): string {
  const parts = filePath.split(/[\\/]+/);
  const projectsIndex = parts.lastIndexOf('projects');
  if (projectsIndex >= 0 && parts.length - projectsIndex > 3) {
    return parts[projectsIndex + 2];
  }
  return path.basename(filePath, '.jsonl');
}

export function isSubagentTranscript(filePath: string): boolean {
  return /[\\/]subagents[\\/]/.test(filePath);
}

export class ClaudeTranscriptParser {
  private reader: IncrementalLineReader;
  private requestIds = new Set<string>();
  private compactBoundaryIds = new Set<string>();
  state: ClaudeTranscriptState;

  constructor(readonly filePath: string) {
    this.reader = new IncrementalLineReader(filePath);
    this.state = initialState(filePath);
  }

  get offset() {
    return this.reader.offset;
  }

  async update(): Promise<ClaudeTranscriptState> {
    const continuous = await this.reader.read((line) => this.consume(line));
    if (!continuous) {
      // The file was replaced: throw away what we knew and read it again.
      this.state = initialState(this.filePath);
      this.requestIds.clear();
      this.compactBoundaryIds.clear();
      await this.reader.read((line) => this.consume(line));
    }
    return this.state;
  }

  consume(line: string) {
    const s = this.state;
    const needsMeta = s.cwd === null && line.includes('"cwd"');
    // User records are mostly tool results, often megabytes each. All we need
    // from them is "a turn is in flight", which a string check answers: an
    // unescaped quote only appears at a real key boundary, never inside a value.
    if (!needsMeta && line.includes('"type":"user"') && !line.includes('isCompactSummary')) {
      if (!line.includes('"isMeta":true') && !line.includes('"isSidechain":true')) s.turn = 'working';
      return;
    }
    // Cheap pre-filters: most other lines are payloads we don't need either.
    const interesting =
      needsMeta ||
      line.includes('"usage"') ||
      line.includes('"type":"system"') ||
      line.includes('compact_boundary') ||
      line.includes('isCompactSummary') ||
      line.includes('-title"') ||
      line.includes('"last-prompt"') ||
      line.includes('"cost-state"');
    if (!interesting) {
      if (s.startedAt === null) {
        const match = /"timestamp":"([^"]+)"/.exec(line);
        if (match) s.startedAt = match[1];
      }
      return;
    }
    const record = tryParse(line);
    if (!record || typeof record !== 'object') return;

    const timestamp = text(record.timestamp);
    if (timestamp) {
      if (!s.startedAt) s.startedAt = timestamp;
      s.updatedAt = timestamp;
    }
    if (typeof record.cwd === 'string') {
      s.cwd = record.cwd;
      s.version = text(record.version) ?? s.version;
      s.gitBranch = text(record.gitBranch) ?? s.gitBranch;
      s.entrypoint = text(record.entrypoint) ?? s.entrypoint;
    }

    switch (record.type) {
      case 'custom-title':
        s.customTitle = text(record.customTitle) ?? s.customTitle;
        return;
      case 'ai-title':
        s.aiTitle = text(record.aiTitle) ?? s.aiTitle;
        return;
      case 'last-prompt':
        s.lastPrompt = promptTitle(text(record.lastPrompt)) ?? s.lastPrompt;
        s.firstPrompt = s.firstPrompt ?? s.lastPrompt;
        return;
      case 'cost-state':
        this.applyCostState(record);
        return;
      case 'assistant':
        this.applyAssistant(record, timestamp);
        return;
      case 'user':
        if (record.isCompactSummary === true) this.applyCompaction(record, false);
        else if (record.isMeta !== true && record.isSidechain !== true) s.turn = 'working';
        return;
      case 'system':
        if (record.subtype === 'compact_boundary') this.applyCompaction(record, true);
        else if (record.subtype === 'stop_hook_summary' || record.subtype === 'turn_duration') s.turn = 'done';
        return;
      default:
        return;
    }
  }

  private applyAssistant(record: any, timestamp: string | null) {
    const s = this.state;
    const message = object(record.message);
    if (!message) return;
    if (record.isSidechain !== true) {
      const stop = text(message.stop_reason);
      if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === 'refusal') s.turn = 'done';
      else if (stop === 'tool_use') s.turn = 'working';
    }
    const usage = object(message.usage);
    if (!usage) return;
    const input = nonNegative(usage.input_tokens)
      + nonNegative(usage.cache_creation_input_tokens)
      + nonNegative(usage.cache_read_input_tokens);
    const output = nonNegative(usage.output_tokens);
    // Synthetic turns (interrupts, local errors) carry zeroed usage and were never billed.
    if (input + output === 0) return;
    const model = text(message.model);
    const cacheCreation = object(usage.cache_creation) ?? {};
    const outputDetails = object(usage.output_tokens_details) ?? {};
    const delta: TokenUsage = {
      inputTokens: input,
      cachedInputTokens: nonNegative(usage.cache_read_input_tokens),
      cacheWriteInputTokens: nonNegative(usage.cache_creation_input_tokens),
      cacheWriteLongInputTokens: nonNegative(cacheCreation.ephemeral_1h_input_tokens),
      outputTokens: output,
      reasoningOutputTokens: nonNegative(outputDetails.thinking_tokens),
      totalTokens: input + output
    };
    if (record.isSidechain !== true) {
      s.model = model ?? s.model;
      s.effort = text(record.effort) ?? s.effort;
      s.lastUsage = delta;
    }
    // Claude Code writes one line per content block, each repeating the
    // response's usage; bill each API request once.
    const requestId = text(record.requestId) ?? text(message.id);
    if (requestId) {
      if (this.requestIds.has(requestId)) return;
      this.requestIds.add(requestId);
    }
    s.requests += 1;
    for (const key of Object.keys(delta) as Array<keyof TokenUsage>) s.totals[key] += delta[key];
    const usd = recordRequest(s.byModel, model, delta);
    addToDay(s.byDay, localDay(timestamp), usd, delta.totalTokens);
  }

  // A compaction leaves a compact_boundary system record and then the summary
  // user record whose parentUuid points at it. Count either, never both.
  private applyCompaction(record: any, boundary: boolean) {
    const s = this.state;
    if (boundary) {
      const uuid = text(record.uuid);
      if (uuid) this.compactBoundaryIds.add(uuid);
    } else {
      const parent = text(record.parentUuid);
      if (parent && this.compactBoundaryIds.has(parent)) return;
    }
    s.compactions += 1;
    s.lastCompactionAt = text(record.timestamp) ?? s.lastCompactionAt;
  }

  private applyCostState(record: any) {
    const s = this.state;
    const total = Number(record.totalCostUSD);
    if (Number.isFinite(total) && total >= 0) s.reportedCostUsd = total;
    const models = object(record.modelUsage);
    if (models) s.reportedModels = Object.keys(models);
  }
}

/**
 * Context window for a Claude session. Claude Code tags the model id with the
 * window it chose ("claude-opus-5-5[1m]"); without that tag we fall back to
 * the model table, then to the user's configured assumption.
 */
export function claudeContextWindow(
  state: Pick<ClaudeTranscriptState, 'model' | 'reportedModels'>,
  tableWindow: number | null,
  fallback: number,
  overrides: Record<string, number>
): { window: number; assumed: boolean } {
  const model = state.model ?? '';
  if (model && Object.prototype.hasOwnProperty.call(overrides, model)) {
    return { window: nonNegative(overrides[model]), assumed: true };
  }
  const tagged = state.reportedModels.find((id) => id.toLowerCase().startsWith(model.toLowerCase()) && /\[[^\]]+\]$/.test(id));
  if (tagged) {
    const match = /\[(\d+(?:\.\d+)?)([km])\]$/i.exec(tagged);
    if (match) {
      const size = Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
      return { window: size, assumed: false };
    }
  }
  if (tableWindow) return { window: tableWindow, assumed: true };
  return { window: fallback, assumed: true };
}

export function claudeTitle(state: ClaudeTranscriptState): string | null {
  return state.customTitle ?? state.aiTitle ?? state.firstPrompt ?? null;
}

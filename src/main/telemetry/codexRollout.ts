import path from 'node:path';
import type { LimitWindow, ProfileLimits, TokenUsage } from '../../shared/types';
import { LONG_CONTEXT_THRESHOLD, emptyUsage, recordRequest, type ModelAccumulator } from './pricing';
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

export interface CodexRolloutState {
  sessionId: string;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  isSubagent: boolean;
  cliVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  model: string | null;
  effort: string | null;
  contextWindow: number;
  lastUsage: TokenUsage | null;
  totalUsage: TokenUsage | null;
  requests: number;
  byModel: Map<string, ModelAccumulator>;
  byDay: Map<string, DayAccumulator>;
  compactions: number;
  lastCompactionAt: string | null;
  taskActive: boolean;
  firstPrompt: string | null;
  lastPrompt: string | null;
  limits: ProfileLimits | null;
}

function initialState(filePath: string): CodexRolloutState {
  return {
    sessionId: sessionIdFromRolloutName(filePath),
    cwd: null,
    originator: null,
    source: null,
    isSubagent: false,
    cliVersion: null,
    startedAt: null,
    updatedAt: null,
    model: null,
    effort: null,
    contextWindow: 0,
    lastUsage: null,
    totalUsage: null,
    requests: 0,
    byModel: new Map(),
    byDay: new Map(),
    compactions: 0,
    lastCompactionAt: null,
    taskActive: false,
    firstPrompt: null,
    lastPrompt: null,
    limits: null
  };
}

export function sessionIdFromRolloutName(filePath: string): string {
  const match = path.basename(filePath).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : path.basename(filePath, '.jsonl');
}

export function normalizeCodexUsage(value: unknown): TokenUsage | null {
  const usage = object(value);
  if (!usage) return null;
  const input = nonNegative(usage.input_tokens);
  const output = nonNegative(usage.output_tokens);
  return {
    inputTokens: input,
    cachedInputTokens: Math.min(nonNegative(usage.cached_input_tokens), input),
    cacheWriteInputTokens: Math.min(nonNegative(usage.cache_write_input_tokens), input),
    cacheWriteLongInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: Math.min(nonNegative(usage.reasoning_output_tokens), output),
    totalTokens: nonNegative(usage.total_tokens) || input + output
  };
}

function subtractUsage(current: TokenUsage, previous: TokenUsage | null): TokenUsage | null {
  if (!previous) return { ...current };
  const delta = emptyUsage();
  let negative = false;
  for (const key of Object.keys(delta) as Array<keyof TokenUsage>) {
    delta[key] = current[key] - previous[key];
    if (delta[key] < 0) negative = true;
  }
  return negative ? null : delta;
}

export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-min`;
}

export function parseCodexRateLimits(value: unknown, observedAt: string | null): ProfileLimits | null {
  const limits = object(value);
  if (!limits) return null;
  const windows: LimitWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const entry = object(limits[id]);
    if (!entry) continue;
    const minutes = nonNegative(entry.window_minutes);
    const resets = Number(entry.resets_at);
    windows.push({
      id,
      label: minutes ? windowLabel(minutes) : id,
      usedPercent: Math.max(0, Math.min(100, Number(entry.used_percent) || 0)),
      resetsAt: Number.isFinite(resets) && resets > 0 ? new Date(resets * 1000).toISOString() : null
    });
  }
  if (windows.length === 0) return null;
  return { windows, observedAt, planType: text(limits.plan_type) };
}

function sourceName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const obj = object(value);
  if (!obj) return null;
  if (obj.subagent) return 'subagent';
  return Object.keys(obj)[0] ?? null;
}

export class CodexRolloutParser {
  private reader: IncrementalLineReader;
  private previousTotal: TokenUsage | null = null;
  private compactionWindowIds = new Set<string>();
  private compactionEvents = 0;
  private compactionSnapshots = 0;
  state: CodexRolloutState;

  constructor(readonly filePath: string) {
    this.reader = new IncrementalLineReader(filePath);
    this.state = initialState(filePath);
  }

  get offset() {
    return this.reader.offset;
  }

  async update(): Promise<CodexRolloutState> {
    const continuous = await this.reader.read((line) => this.consume(line));
    if (!continuous) {
      this.state = initialState(this.filePath);
      this.previousTotal = null;
      this.compactionWindowIds.clear();
      this.compactionEvents = 0;
      this.compactionSnapshots = 0;
      await this.reader.read((line) => this.consume(line));
    }
    return this.state;
  }

  consume(line: string) {
    // Skip response items (model output, tool calls) without parsing them.
    // Records open with {"timestamp":...,"type":...}, so the head is enough.
    const head = line.slice(0, 160);
    if (head.includes('"type":"response_item"')) {
      const match = /"timestamp":"([^"]+)"/.exec(head);
      if (match) this.state.updatedAt = match[1];
      return;
    }
    const record = tryParse(line);
    if (!record || typeof record !== 'object') return;
    const s = this.state;
    const timestamp = text(record.timestamp);
    if (timestamp) {
      s.updatedAt = timestamp;
      if (!s.startedAt) s.startedAt = timestamp;
    }
    const payload = object(record.payload) ?? {};
    switch (record.type) {
      case 'session_meta':
        s.sessionId = text(payload.id) ?? text(payload.session_id) ?? s.sessionId;
        s.startedAt = text(payload.timestamp) ?? s.startedAt;
        s.cwd = text(payload.cwd) ?? s.cwd;
        s.originator = text(payload.originator) ?? s.originator;
        s.source = sourceName(payload.source) ?? s.source;
        s.cliVersion = text(payload.cli_version) ?? s.cliVersion;
        s.isSubagent = payload.thread_source === 'subagent' || Boolean(object(payload.source)?.subagent);
        return;
      case 'turn_context':
        s.cwd = text(payload.cwd) ?? s.cwd;
        s.model = text(payload.model) ?? s.model;
        s.effort = text(payload.effort) ?? s.effort;
        return;
      case 'compacted': {
        const windowId = text(payload.window_id);
        if (windowId) {
          this.compactionWindowIds.add(windowId);
          this.compactionSnapshots = this.compactionWindowIds.size;
        } else {
          this.compactionSnapshots += 1;
        }
        s.lastCompactionAt = timestamp ?? s.lastCompactionAt;
        s.compactions = Math.max(this.compactionSnapshots, this.compactionEvents);
        return;
      }
      case 'event_msg':
        this.applyEvent(payload, timestamp);
        return;
      default:
        return;
    }
  }

  private applyEvent(payload: Record<string, any>, timestamp: string | null) {
    const s = this.state;
    switch (payload.type) {
      case 'task_started':
        s.taskActive = true;
        s.contextWindow = nonNegative(payload.model_context_window) || s.contextWindow;
        return;
      case 'task_complete':
      case 'turn_aborted':
        s.taskActive = false;
        return;
      case 'user_message': {
        const prompt = promptTitle(text(payload.message));
        if (prompt) {
          s.lastPrompt = prompt;
          if (!s.firstPrompt) s.firstPrompt = prompt;
        }
        return;
      }
      case 'context_compacted':
        this.compactionEvents += 1;
        s.lastCompactionAt = timestamp ?? s.lastCompactionAt;
        s.compactions = Math.max(this.compactionSnapshots, this.compactionEvents);
        return;
      case 'thread_settings_applied': {
        const settings = object(payload.thread_settings);
        if (settings) {
          s.model = text(settings.model) ?? s.model;
          s.effort = text(settings.reasoning_effort) ?? s.effort;
          s.cwd = text(settings.cwd) ?? s.cwd;
        }
        return;
      }
      case 'token_count':
        this.applyTokenCount(payload, timestamp);
        return;
      default:
        return;
    }
  }

  private applyTokenCount(payload: Record<string, any>, timestamp: string | null) {
    const s = this.state;
    const limits = parseCodexRateLimits(payload.rate_limits, timestamp);
    if (limits) s.limits = limits;
    const info = object(payload.info);
    if (!info) return;
    s.contextWindow = nonNegative(info.model_context_window) || s.contextWindow;
    const last = normalizeCodexUsage(info.last_token_usage);
    const total = normalizeCodexUsage(info.total_token_usage);
    if (last) s.lastUsage = last;
    if (!total) return;
    s.totalUsage = total;
    // Cost is priced per usage delta so a request past the long-context
    // threshold is charged at the long-context rate and the rest are not.
    // A total that went backwards (a reset) contributes its last request.
    const delta = subtractUsage(total, this.previousTotal) ?? last;
    this.previousTotal = total;
    if (!delta || delta.totalTokens <= 0) return;
    const longContext = (last?.inputTokens ?? 0) > LONG_CONTEXT_THRESHOLD;
    s.requests += 1;
    const usd = recordRequest(s.byModel, s.model, delta, longContext);
    addToDay(s.byDay, localDay(timestamp), usd, delta.totalTokens);
  }
}

export function codexTitle(state: CodexRolloutState, indexedTitle: string | null): string | null {
  return indexedTitle ?? state.firstPrompt ?? null;
}

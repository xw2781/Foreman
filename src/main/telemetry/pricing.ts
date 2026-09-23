import type { CostEstimate, Provider, TokenUsage } from '../../shared/types';

/**
 * Public list prices in USD per 1M tokens, Standard tier. These are
 * API-equivalent estimates: a Claude or ChatGPT subscription is billed
 * differently, and tool/container fees are not included.
 *
 * Anthropic rates: Claude API model table, checked 2026-09-23. Cache writes
 * are 1.25x input (5-minute) and 2x input (1-hour); cache reads are 0.1x
 * input except where a model publishes its own rate (Fable 5.1, Opus 5.5).
 * OpenAI rates: developers.openai.com/api/docs/pricing, checked 2026-09-23.
 * Models marked longContext bill every token at 2x when a request's input
 * exceeds 272K tokens.
 */
export const PRICING_DATE = '2026-09-23';
export const LONG_CONTEXT_THRESHOLD = 272_000;
const PER_MILLION = 1_000_000;

export interface Rate {
  provider: Provider;
  model: string;
  aliases: string[];
  input: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  cacheWriteLong: number | null;
  output: number;
  longContext: boolean;
  contextWindow: number | null;
}

function openai(
  model: string,
  input: number,
  cachedInput: number | null,
  output: number,
  options: { cacheWrite?: number; longContext?: boolean; aliases?: string[]; contextWindow?: number } = {}
): Rate {
  return {
    provider: 'codex',
    model,
    aliases: options.aliases ?? [],
    input,
    cachedInput,
    cacheWrite: options.cacheWrite ?? null,
    cacheWriteLong: null,
    output,
    longContext: options.longContext === true,
    contextWindow: options.contextWindow ?? null
  };
}

function claude(
  model: string,
  input: number,
  output: number,
  options: { cacheRead?: number; contextWindow?: number; aliases?: string[] } = {}
): Rate {
  return {
    provider: 'claude',
    model,
    aliases: options.aliases ?? [],
    input,
    cachedInput: options.cacheRead ?? input * 0.1,
    cacheWrite: input * 1.25,
    cacheWriteLong: input * 2,
    output,
    longContext: false,
    contextWindow: options.contextWindow ?? 1_000_000
  };
}

export const RATES: Rate[] = [
  openai('gpt-6-astra', 10, 1, 50, { cacheWrite: 12.5, longContext: true }),
  openai('gpt-6-sol', 2, 0.2, 10, { cacheWrite: 2.5, longContext: true }),
  openai('gpt-6-luna', 0.1, 0.01, 0.5, { cacheWrite: 0.125, longContext: true }),
  openai('gpt-5.6-sol', 4, 0.4, 20, { cacheWrite: 5, longContext: true, aliases: ['gpt-5.6'] }),
  openai('gpt-5.6-terra', 2, 0.2, 12, { cacheWrite: 2.5, longContext: true }),
  openai('gpt-5.6-luna', 0.2, 0.02, 1.2, { cacheWrite: 0.25, longContext: true }),
  openai('gpt-5.5', 5, 0.5, 30),
  openai('gpt-5.5-pro', 30, null, 180),
  openai('gpt-5.4', 2.5, 0.25, 15),
  openai('gpt-5.4-mini', 0.75, 0.075, 4.5),
  openai('gpt-5.4-nano', 0.2, 0.02, 1.25),
  openai('gpt-5.4-pro', 30, null, 180),
  openai('gpt-5.3-codex', 1.75, 0.175, 14),
  openai('gpt-5.2', 1.75, 0.175, 14),
  openai('gpt-5.2-codex', 1.75, 0.175, 14),
  openai('gpt-5.2-pro', 21, null, 168),
  openai('gpt-5.1', 1.25, 0.125, 10),
  openai('gpt-5.1-codex', 1.25, 0.125, 10),
  openai('gpt-5.1-codex-max', 1.25, 0.125, 10),
  openai('gpt-5.1-codex-mini', 0.25, 0.025, 2),
  openai('gpt-5', 1.25, 0.125, 10),
  openai('gpt-5-codex', 1.25, 0.125, 10),
  openai('gpt-5-mini', 0.25, 0.025, 2),
  openai('gpt-5-nano', 0.05, 0.005, 0.4),
  openai('gpt-5-pro', 15, null, 120),

  claude('claude-fable-5-1', 10, 50, { cacheRead: 0.25 }),
  claude('claude-mythos-5-1', 10, 50, { cacheRead: 0.25 }),
  claude('claude-fable-5', 10, 50),
  claude('claude-mythos-5', 10, 50),
  claude('claude-opus-5-5', 4, 20, { cacheRead: 0.2 }),
  claude('claude-opus-5', 5, 25),
  claude('claude-opus-4-8', 5, 25),
  claude('claude-opus-4-7', 5, 25),
  claude('claude-opus-4-6', 5, 25),
  claude('claude-sonnet-5', 2, 10),
  claude('claude-sonnet-4-6', 3, 15),
  claude('claude-haiku-4-5', 1, 5, { contextWindow: 200_000 })
];

/** Strips decorations that don't change the price: case, `[1m]`, date snapshots. */
export function normalizeModelId(model: string | null | undefined): string {
  return String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

const rateIndex = new Map<string, Rate>();
for (const rate of RATES) {
  for (const id of [rate.model, ...rate.aliases]) rateIndex.set(id, rate);
}

export function rateForModel(model: string | null | undefined): Rate | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  return rateIndex.get(id) ?? null;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWriteLongInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

export function addUsage(target: TokenUsage, delta: TokenUsage): TokenUsage {
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.cacheWriteInputTokens += delta.cacheWriteInputTokens;
  target.cacheWriteLongInputTokens += delta.cacheWriteLongInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
  target.totalTokens += delta.totalTokens;
  return target;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Splits a usage block into the buckets that are billed at different rates.
 * `inputTokens` is the whole prompt: uncached + cache reads + cache writes.
 */
export function billableTokens(usage: TokenUsage) {
  const input = nonNegative(usage.inputTokens);
  const cached = Math.min(nonNegative(usage.cachedInputTokens), input);
  const writes = nonNegative(usage.cacheWriteInputTokens);
  const writesLong = Math.min(nonNegative(usage.cacheWriteLongInputTokens), writes, Math.max(0, input - cached));
  const writesShort = Math.min(writes - writesLong, Math.max(0, input - cached - writesLong));
  return {
    uncachedInput: Math.max(0, input - cached - writesShort - writesLong),
    cachedInput: cached,
    cacheWriteInput: writesShort,
    cacheWriteLongInput: writesLong,
    output: nonNegative(usage.outputTokens)
  };
}

export function priceUsage(rate: Rate, usage: TokenUsage, longContext = false): number {
  const t = billableTokens(usage);
  const multiplier = longContext && rate.longContext ? 2 : 1;
  const cachedRate = rate.cachedInput ?? rate.input;
  const writeRate = rate.cacheWrite ?? rate.input;
  const writeLongRate = rate.cacheWriteLong ?? writeRate;
  const usd =
    t.uncachedInput * rate.input +
    t.cachedInput * cachedRate +
    t.cacheWriteInput * writeRate +
    t.cacheWriteLongInput * writeLongRate +
    t.output * rate.output;
  return (usd / PER_MILLION) * multiplier;
}

export interface ModelAccumulator {
  usage: TokenUsage;
  usd: number;
  priced: boolean;
  requests: number;
}

/** Folds one billed request (or Codex usage delta) into a per-model map and returns its price. */
export function recordRequest(
  byModel: Map<string, ModelAccumulator>,
  model: string | null,
  usage: TokenUsage,
  longContext = false
): number | null {
  const key = normalizeModelId(model) || 'unknown';
  let entry = byModel.get(key);
  if (!entry) {
    entry = { usage: emptyUsage(), usd: 0, priced: true, requests: 0 };
    byModel.set(key, entry);
  }
  addUsage(entry.usage, usage);
  entry.requests += 1;
  const rate = rateForModel(key);
  if (!rate) {
    entry.priced = false;
    return null;
  }
  const usd = priceUsage(rate, usage, longContext);
  entry.usd += usd;
  return usd;
}

export function costFromModels(byModel: Map<string, ModelAccumulator>, reportedUsd: number | null = null): CostEstimate {
  const rows = [...byModel.entries()].map(([model, entry]) => ({
    model,
    usd: entry.priced ? entry.usd : null,
    usage: { ...entry.usage }
  }));
  const priced = rows.filter((row) => row.usd !== null);
  return {
    totalUsd: priced.length > 0 ? priced.reduce((sum, row) => sum + (row.usd ?? 0), 0) : null,
    reportedUsd,
    unpricedModels: rows.filter((row) => row.usd === null).map((row) => row.model),
    byModel: rows.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
  };
}

export function contextWindowForModel(model: string | null | undefined): number | null {
  return rateForModel(model)?.contextWindow ?? null;
}

import type { CostEstimate, Provider, TokenUsage } from '../../shared/types';
import defaults from './prices.json';

/**
 * Model prices, USD per 1M tokens. The table ships as prices.json (its
 * "about" notes say how to edit it); a pricing.json in the app's data folder
 * overrides it at runtime, so new models get priced without an app release.
 */
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

export interface PricingTable {
  pricingDate: string;
  rates: Rate[];
  /** Entries that were skipped, and why. */
  problems: string[];
}

function price(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A rate from one prices.json entry; omitted values take the provider's defaults. */
function parseRate(entry: any): Rate | string {
  const model = typeof entry?.model === 'string' ? normalizeModelId(entry.model) : '';
  if (!model) return 'an entry has no model id';
  const provider = entry.provider;
  if (provider !== 'claude' && provider !== 'codex') return `${model}: provider must be "claude" or "codex"`;
  const input = price(entry.input);
  const output = price(entry.output);
  if (input === null || output === null) return `${model}: input and output must be non-negative numbers`;
  const claude = provider === 'claude';
  const optional = (key: string, fallback: number | null) => (key in entry ? (entry[key] === null ? null : price(entry[key]) ?? fallback) : fallback);
  const aliases: unknown[] = Array.isArray(entry.aliases) ? entry.aliases : [];
  return {
    provider,
    model,
    aliases: aliases.filter((a): a is string => typeof a === 'string').map(normalizeModelId).filter(Boolean),
    input,
    cachedInput: optional('cachedInput', claude ? input * 0.1 : null),
    cacheWrite: optional('cacheWrite', claude ? input * 1.25 : null),
    cacheWriteLong: optional('cacheWriteLong', claude ? input * 2 : null),
    output,
    longContext: entry.longContext === true,
    contextWindow: optional('contextWindow', claude ? 1_000_000 : null)
  };
}

/** Reads a prices.json-shaped object. Throws only when it isn't one at all. */
export function parsePricingTable(raw: unknown): PricingTable {
  const data = raw as any;
  if (!data || typeof data !== 'object' || !Array.isArray(data.models)) throw new Error('expected an object with a "models" list');
  const rates: Rate[] = [];
  const problems: string[] = [];
  for (const entry of data.models) {
    const rate = parseRate(entry);
    if (typeof rate === 'string') problems.push(rate);
    else rates.push(rate);
  }
  return { pricingDate: typeof data.pricingDate === 'string' ? data.pricingDate : '', rates, problems };
}

/** Per model, the entry from the more recently checked table wins; models in only one table are kept. */
export function mergePricing(base: PricingTable, override: PricingTable | null): PricingTable {
  if (!override) return base;
  const overrideWins = override.pricingDate >= base.pricingDate;
  const [older, newer] = overrideWins ? [base, override] : [override, base];
  const byModel = new Map<string, Rate>();
  for (const rate of [...older.rates, ...newer.rates]) byModel.set(rate.model, rate);
  return { pricingDate: newer.pricingDate, rates: [...byModel.values()], problems: override.problems };
}

/** The table that ships with the app, as JSON (seeds the editable copy) and parsed. */
export const BUILTIN_PRICING_JSON = defaults;
export const BUILTIN_PRICING: PricingTable = parsePricingTable(defaults);

let table = BUILTIN_PRICING;
let fingerprint = '';
const rateIndex = new Map<string, Rate>();

function reindex() {
  rateIndex.clear();
  // Aliases first, so an id that is some model's own always resolves to that model.
  for (const rate of table.rates) for (const id of rate.aliases) rateIndex.set(id, rate);
  for (const rate of table.rates) rateIndex.set(rate.model, rate);
  const text = JSON.stringify(table.rates);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  fingerprint = `${table.pricingDate}:${(hash >>> 0).toString(36)}`;
}
reindex();

/** Applies the runtime override on top of the shipped table (null: shipped table only). */
export function setPricingOverride(override: PricingTable | null) {
  table = mergePricing(BUILTIN_PRICING, override);
  reindex();
}

export function currentPricing(): PricingTable {
  return table;
}

/** Changes whenever any rate does: costs cached under another version are stale. */
export function pricingVersion(): string {
  return fingerprint;
}

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

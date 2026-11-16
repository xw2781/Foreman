import type { LimitWindow, ProfileLimits } from '../shared/types';

/** What Claude Code's status-line JSON tells us that its transcript doesn't. */
export interface StatusSnapshot {
  at: number;
  contextWindow: number;
  usedPercent: number | null;
  usedTokens: number;
  costUsd: number | null;
  modelId: string | null;
  modelName: string | null;
  limits: ProfileLimits | null;
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  spend_limit: 'Spend limit'
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toIso(asNumber);
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return null;
}

export function parseStatusPayload(payload: Record<string, any>, now = Date.now()): StatusSnapshot {
  const context = payload.context_window ?? {};
  const model = payload.model ?? {};
  const cost = payload.cost ?? {};
  const windows: LimitWindow[] = [];
  const limits = payload.rate_limits;
  if (limits && typeof limits === 'object') {
    for (const [id, entry] of Object.entries<any>(limits)) {
      if (!entry || typeof entry !== 'object') continue;
      const used = num(entry.used_percentage ?? entry.utilization);
      if (used === null) continue;
      windows.push({
        id,
        label: LIMIT_LABELS[id] ?? id.replace(/_/g, ' '),
        usedPercent: Math.max(0, Math.min(100, used)),
        resetsAt: toIso(entry.resets_at)
      });
    }
  }
  return {
    at: now,
    contextWindow: num(context.context_window_size) ?? 0,
    usedPercent: num(context.used_percentage),
    usedTokens: num(context.total_input_tokens) ?? 0,
    costUsd: num(cost.total_cost_usd),
    modelId: typeof model.id === 'string' ? model.id : null,
    modelName: typeof model.display_name === 'string' ? model.display_name : null,
    limits: windows.length ? { windows, observedAt: new Date(now).toISOString(), planType: null } : null
  };
}

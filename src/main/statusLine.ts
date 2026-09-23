import path from 'node:path';
import { spawn } from 'node:child_process';
import type { LimitWindow, Profile, ProfileLimits } from '../shared/types';
import { HOME, exists, readJsonFile } from './util';

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

/** The user's own status line for this account, which the app's capture chains to. */
export function originalStatusLine(profile: Profile): { command: string; refreshInterval?: number } | null {
  const settings = readJsonFile<any>(path.join(profile.builtin ? path.join(HOME, '.claude') : profile.configDir, 'settings.json'));
  const statusLine = settings?.statusLine;
  if (!statusLine || statusLine.type !== 'command' || typeof statusLine.command !== 'string') return null;
  if (statusLine.command.includes('X-ATC-Token')) return null; // never chain to ourselves
  const refreshInterval = num(statusLine.refreshInterval);
  return { command: statusLine.command, ...(refreshInterval ? { refreshInterval } : {}) };
}

function gitBash(): string | null {
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
  ];
  return candidates.find((c): c is string => Boolean(c) && exists(c!)) ?? null;
}

/**
 * Runs the user's status-line command the way Claude Code would (Git Bash
 * when installed, otherwise cmd) with the same JSON on stdin.
 */
export function runStatusCommand(command: string, input: string, cwd: string | undefined, env: Record<string, string>, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    const bash = gitBash();
    const child = bash
      ? spawn(bash, ['-c', command], { cwd, env, windowsHide: true })
      : spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(out || null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      out += data;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function defaultStatusText(snapshot: StatusSnapshot, accountLabel: string): string {
  const parts = [snapshot.modelName ?? snapshot.modelId ?? 'Claude'];
  if (snapshot.usedPercent !== null) parts.push(`ctx ${Math.round(snapshot.usedPercent)}%`);
  if (snapshot.costUsd !== null) parts.push(`$${snapshot.costUsd.toFixed(2)}`);
  const fiveHour = snapshot.limits?.windows.find((w) => w.id === 'five_hour');
  if (fiveHour) parts.push(`5h ${Math.round(fiveHour.usedPercent)}%`);
  parts.push(accountLabel);
  return parts.join(' · ');
}


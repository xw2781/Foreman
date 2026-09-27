// Usage summaries that travel between computers: an export file, or one file
// per computer in the GitHub sync repo. Only per-session totals by day and
// model go in, never conversation content (apart from the session title).
import type { Provider } from '../../shared/types';
import type { FileSummary } from './engine';
import { mergeDay, nonNegative, object, parseTime, text, type DayAccumulator, type ModelDay } from './jsonl';

export const USAGE_FORMAT = 'foreman-usage';
export const USAGE_VERSION = 1;

export interface MachineInfo {
  id: string;
  name: string;
}

export interface ExportedAccount {
  id: string;
  provider: Provider;
  label: string;
  email: string | null;
}

export interface ExportedSession {
  provider: Provider;
  accountId: string;
  sessionId: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  tokens: number;
  requests: number;
  byDay: Record<string, DayAccumulator>;
  byModel: FileSummary['byModel'];
}

export interface MachineUsage extends MachineInfo {
  /** When the computer read these numbers from its session files. */
  dataAt: string;
  /** The price list its costs were computed with. */
  pricingDate: string;
  accounts: ExportedAccount[];
  sessions: ExportedSession[];
}

export interface UsageFile {
  format: typeof USAGE_FORMAT;
  version: number;
  exportedAt: string;
  exportedBy: MachineInfo & { appVersion: string };
  machines: MachineUsage[];
}

/** One record per session: subagent transcripts fold into their parent, as in the usage report. */
export function sessionsFromSummaries(summaries: Iterable<FileSummary>, profileIds: Set<string>): ExportedSession[] {
  const sessions = new Map<string, ExportedSession>();
  for (const summary of summaries) {
    if (!profileIds.has(summary.profileId) || summary.requests === 0) continue;
    const key = `${summary.profileId}:${summary.sessionId}`;
    let session = sessions.get(key);
    if (!session) {
      session = {
        provider: summary.provider,
        accountId: summary.profileId,
        sessionId: summary.sessionId,
        title: null,
        cwd: summary.cwd,
        model: null,
        startedAt: summary.startedAt,
        updatedAt: summary.updatedAt ?? new Date(summary.mtimeMs).toISOString(),
        tokens: 0,
        requests: 0,
        byDay: {},
        byModel: {}
      };
      sessions.set(key, session);
    }
    if (!summary.isSubagent) {
      session.title = summary.title;
      session.model = summary.model;
      session.cwd = summary.cwd ?? session.cwd;
    }
    session.tokens += summary.tokens;
    session.requests += summary.requests;
    const updated = summary.updatedAt ?? new Date(summary.mtimeMs).toISOString();
    if (parseTime(updated) > parseTime(session.updatedAt)) session.updatedAt = updated;
    if (summary.startedAt && (!session.startedAt || parseTime(summary.startedAt) < parseTime(session.startedAt))) session.startedAt = summary.startedAt;
    for (const [date, day] of Object.entries(summary.byDay)) mergeDay((session.byDay[date] ??= { usd: 0, tokens: 0, requests: 0 }), day);
    for (const [model, entry] of Object.entries(summary.byModel)) {
      const target = (session.byModel[model] ??= { usd: 0, tokens: 0, requests: 0 });
      target.usd = target.usd === null || entry.usd === null ? null : target.usd + entry.usd;
      target.tokens += entry.tokens;
      target.requests += entry.requests;
    }
  }
  return [...sessions.values()];
}

export function sessionKey(session: ExportedSession) {
  return `${session.provider}:${session.accountId}:${session.sessionId}`;
}

/** The later reading of a session wins; sessions only grow, so more requests break a tie. */
function newer(a: ExportedSession, b: ExportedSession) {
  const at = parseTime(a.updatedAt);
  const bt = parseTime(b.updatedAt);
  return at !== bt ? at > bt : a.requests >= b.requests;
}

/**
 * Folds `incoming` into `target` (same computer). Sessions are unioned, so
 * history survives on either side after the transcripts themselves are deleted.
 */
export function mergeMachine(target: MachineUsage | undefined, incoming: MachineUsage): { machine: MachineUsage; added: number; updated: number } {
  if (!target) return { machine: incoming, added: incoming.sessions.length, updated: 0 };
  const sessions = new Map(target.sessions.map((s) => [sessionKey(s), s]));
  let added = 0;
  let updated = 0;
  for (const session of incoming.sessions) {
    const key = sessionKey(session);
    const existing = sessions.get(key);
    if (!existing) added += 1;
    else if (!newer(session, existing)) continue;
    else if (session.requests !== existing.requests) updated += 1;
    sessions.set(key, session);
  }
  const incomingIsNewer = parseTime(incoming.dataAt) >= parseTime(target.dataAt);
  const accounts = new Map(target.accounts.map((a) => [a.id, a]));
  for (const account of incoming.accounts) {
    if (incomingIsNewer || !accounts.has(account.id)) accounts.set(account.id, account);
  }
  const latest = incomingIsNewer ? incoming : target;
  return {
    machine: {
      id: target.id,
      name: latest.name,
      dataAt: latest.dataAt,
      pricingDate: latest.pricingDate,
      accounts: [...accounts.values()],
      sessions: [...sessions.values()]
    },
    added,
    updated
  };
}

export function usageFile(machines: MachineUsage[], exportedBy: MachineInfo & { appVersion: string }): UsageFile {
  return { format: USAGE_FORMAT, version: USAGE_VERSION, exportedAt: new Date().toISOString(), exportedBy, machines };
}

/** Parses and validates a usage file; anything malformed is dropped rather than trusted. */
export function parseUsageFile(content: string): UsageFile {
  let raw: any;
  try {
    raw = JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    throw new Error('Not a Foreman usage file (invalid JSON).');
  }
  if (raw?.format !== USAGE_FORMAT) throw new Error('Not a Foreman usage file.');
  if (typeof raw.version !== 'number' || raw.version > USAGE_VERSION) {
    throw new Error('This usage file was written by a newer Foreman. Update Foreman to import it.');
  }
  const machines: MachineUsage[] = [];
  for (const entry of Array.isArray(raw.machines) ? raw.machines : []) {
    const machine = cleanMachine(entry);
    if (machine) machines.push(machine);
  }
  const by = object(raw.exportedBy) ?? {};
  return {
    format: USAGE_FORMAT,
    version: raw.version,
    exportedAt: text(raw.exportedAt) ?? '',
    exportedBy: { id: text(by.id) ?? '', name: text(by.name) ?? '', appVersion: text(by.appVersion) ?? '' },
    machines
  };
}

const provider = (value: unknown): Provider | null => (value === 'claude' || value === 'codex' ? value : null);

function cleanMachine(value: unknown): MachineUsage | null {
  const raw = object(value);
  const id = text(raw?.id);
  if (!raw || !id) return null;
  const accounts: ExportedAccount[] = [];
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    const account = object(entry);
    const accountProvider = provider(account?.provider);
    const accountId = text(account?.id);
    if (!account || !accountProvider || !accountId) continue;
    accounts.push({ id: accountId, provider: accountProvider, label: text(account.label) ?? accountId, email: text(account.email) });
  }
  const sessions: ExportedSession[] = [];
  for (const entry of Array.isArray(raw.sessions) ? raw.sessions : []) {
    const session = cleanSession(entry);
    if (session) sessions.push(session);
  }
  return {
    id,
    name: text(raw.name) ?? id.slice(0, 8),
    dataAt: text(raw.dataAt) ?? '',
    pricingDate: text(raw.pricingDate) ?? '',
    accounts,
    sessions
  };
}

function cleanSession(value: unknown): ExportedSession | null {
  const raw = object(value);
  const sessionProvider = provider(raw?.provider);
  const accountId = text(raw?.accountId);
  const sessionId = text(raw?.sessionId);
  if (!raw || !sessionProvider || !accountId || !sessionId) return null;
  const byDay: ExportedSession['byDay'] = {};
  for (const [date, entry] of Object.entries(object(raw.byDay) ?? {})) {
    const day = object(entry);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDay[date] = { usd: nonNegative(day.usd), tokens: nonNegative(day.tokens), requests: nonNegative(day.requests) };
    const models = object(day.models);
    if (!models) continue;
    byDay[date].models = {};
    for (const [model, value] of Object.entries(models)) {
      const row = object(value);
      if (row) byDay[date].models![model] = cleanModelDay(row);
    }
  }
  const byModel: ExportedSession['byModel'] = {};
  for (const [model, entry] of Object.entries(object(raw.byModel) ?? {})) {
    const row = object(entry);
    if (row) byModel[model] = cleanModelDay(row);
  }
  return {
    provider: sessionProvider,
    accountId,
    sessionId,
    title: text(raw.title),
    cwd: text(raw.cwd),
    model: text(raw.model),
    startedAt: text(raw.startedAt),
    updatedAt: text(raw.updatedAt),
    tokens: nonNegative(raw.tokens),
    requests: nonNegative(raw.requests),
    byDay,
    byModel
  };
}

function cleanModelDay(row: Record<string, unknown>): ModelDay {
  return { usd: row.usd === null ? null : nonNegative(row.usd), tokens: nonNegative(row.tokens), requests: nonNegative(row.requests) };
}

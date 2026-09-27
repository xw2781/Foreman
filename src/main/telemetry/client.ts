import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  PricingStatus,
  ProfileLimits,
  Provider,
  SessionTelemetry,
  UsageExportResult,
  UsageImportResult,
  UsageReport
} from '../../shared/types';
import type { EngineProfile, EngineSettings } from './engine';
import type { MachineInfo } from './usageTransfer';
import type { HistoryEntry } from '../chat/history';

export interface TelemetryPaths {
  cachePath: string;
  pricingPath: string;
  /** Other computers' usage, imported from files or synced from GitHub. */
  importedPath: string;
  machine: MachineInfo;
  appVersion: string;
}

/** Promise-based handle on the telemetry worker thread. */
export class TelemetryClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  onProgress: (scanned: number) => void = () => {};

  constructor(outDir: string, options: TelemetryPaths) {
    this.worker = new Worker(path.join(outDir, 'telemetryWorker.js'), { workerData: options });
    this.worker.on('message', (message: any) => {
      if (message.event === 'progress') {
        this.onProgress(message.scanned);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  configure(profiles: EngineProfile[], settings: Partial<EngineSettings>) {
    return this.call<void>('configure', profiles, settings);
  }

  sessionTelemetry(provider: Provider, profileId: string, filePath: string) {
    return this.call<SessionTelemetry | null>('sessionTelemetry', provider, profileId, filePath);
  }

  findClaudeTranscript(configDir: string, sessionId: string) {
    return this.call<string | null>('findClaudeTranscript', configDir, sessionId);
  }

  findLatestClaudeTranscript(configDir: string, cwd: string, sinceMs: number, exclude: string[]) {
    return this.call<string | null>('findLatestClaudeTranscript', configDir, cwd, sinceMs, exclude);
  }

  findCodexRollout(codexHome: string, cwd: string, sinceMs: number, exclude: string[]) {
    return this.call<string | null>('findCodexRollout', codexHome, cwd, sinceMs, exclude);
  }

  findCodexRolloutById(codexHome: string, sessionId: string) {
    return this.call<string | null>('findCodexRolloutById', codexHome, sessionId);
  }

  usageReport(force = false) {
    return this.call<UsageReport>('usageReport', force);
  }

  quickReport() {
    return this.call<UsageReport>('quickReport');
  }

  codexLimits(profile: EngineProfile) {
    return this.call<ProfileLimits | null>('codexLimits', profile);
  }

  /** A past conversation rebuilt from its session file. */
  chatHistory(provider: Provider, filePath: string) {
    return this.call<HistoryEntry[]>('chatHistory', provider, filePath);
  }

  /** This computer's whole usage history as a usage file, folded into its previous upload. */
  localUsage(previous: string | null) {
    return this.call<{ content: string; digest: string; sessions: number }>('localUsage', previous);
  }

  exportUsage(filePath: string) {
    return this.call<UsageExportResult>('exportUsage', filePath);
  }

  importUsageFiles(filePaths: string[]) {
    return this.call<UsageImportResult>('importUsageFiles', filePaths);
  }

  importUsage(contents: string[], names?: string[]) {
    return this.call<UsageImportResult>('importUsage', contents, names);
  }

  forgetMachine(id: string) {
    return this.call<void>('forgetMachine', id);
  }

  /** Re-reads pricing.json; the next usage report re-prices every session. */
  reloadPricing() {
    return this.call<PricingStatus | null>('reloadPricing');
  }

  async dispose() {
    try {
      await Promise.race([this.call('saveCache'), new Promise((resolve) => setTimeout(resolve, 1500))]);
    } finally {
      await this.worker.terminate();
    }
  }
}

// Telemetry worker thread: all JSONL parsing happens here so the main process
// (and with it every terminal) never stalls on a large transcript.
import { parentPort, workerData } from 'node:worker_threads';
import { TelemetryEngine } from './engine';

type Request = { id: number; method: string; args: any[] };

const engine = new TelemetryEngine(workerData?.cachePath ?? null, (scanned) => {
  parentPort?.postMessage({ event: 'progress', scanned });
});

const methods: Record<string, (...args: any[]) => unknown> = {
  configure: (profiles, settings) => engine.configure(profiles, settings),
  sessionTelemetry: (provider, profileId, filePath) => engine.sessionTelemetry(provider, profileId, filePath),
  findClaudeTranscript: (configDir, sessionId) => engine.findClaudeTranscript(configDir, sessionId),
  findLatestClaudeTranscript: (configDir, cwd, since, exclude) => engine.findLatestClaudeTranscript(configDir, cwd, since, exclude),
  findCodexRollout: (codexHome, cwd, since, exclude) => engine.findCodexRollout(codexHome, cwd, since, exclude),
  findCodexRolloutById: (codexHome, sessionId) => engine.findCodexRolloutById(codexHome, sessionId),
  usageReport: (force) => engine.usageReport(force),
  quickReport: () => engine.quickReport(),
  codexLimits: (profile) => engine.codexLimits(profile),
  saveCache: () => engine.saveCache()
};

parentPort?.on('message', async (request: Request) => {
  try {
    const handler = methods[request.method];
    if (!handler) throw new Error(`Unknown telemetry method ${request.method}`);
    const result = await handler(...request.args);
    parentPort?.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

// Persist the per-file cache periodically so a crash doesn't cost a full rescan.
setInterval(() => engine.saveCache(), 60_000).unref();

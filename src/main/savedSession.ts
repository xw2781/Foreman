import type { AgentInfo } from '../shared/types';

export interface SavedSession {
  sessionId: string;
  transcriptPath: string | null;
}

/**
 * The saved session an ended conversation can continue, or null when the CLI never wrote one.
 * A record saved before its transcript was found (the app died mid-run) is checked on disk:
 * starting over would drop a conversation that is still there.
 */
export async function savedSession(
  info: Pick<AgentInfo, 'sessionId' | 'transcriptPath' | 'telemetry'>,
  findTranscript: (sessionId: string) => Promise<string | null>
): Promise<SavedSession | null> {
  const sessionId = info.telemetry?.sessionId ?? info.sessionId;
  if (!sessionId) return null;
  if (info.transcriptPath || info.telemetry) return { sessionId, transcriptPath: info.transcriptPath };
  const found = await findTranscript(sessionId).catch(() => null);
  return found ? { sessionId, transcriptPath: found } : null;
}

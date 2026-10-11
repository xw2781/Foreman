import { describe, expect, it } from 'vitest';
import { savedSession } from '../src/main/savedSession';

const never = async () => {
  throw new Error('should not search');
};

describe('savedSession', () => {
  it('uses the recorded transcript without searching', async () => {
    expect(await savedSession({ sessionId: 's1', transcriptPath: 'C:/t/s1.jsonl', telemetry: null }, never)).toEqual({ sessionId: 's1', transcriptPath: 'C:/t/s1.jsonl' });
  });

  it('prefers the session telemetry last saw', async () => {
    const telemetry = { sessionId: 's2' } as any;
    expect(await savedSession({ sessionId: 's1', transcriptPath: null, telemetry }, never)).toEqual({ sessionId: 's2', transcriptPath: null });
  });

  it('finds the transcript of a record saved before the app died', async () => {
    const found = await savedSession({ sessionId: 's1', transcriptPath: null, telemetry: null }, async (id) => `C:/t/${id}.jsonl`);
    expect(found).toEqual({ sessionId: 's1', transcriptPath: 'C:/t/s1.jsonl' });
  });

  it('has nothing to resume when the CLI never wrote the session', async () => {
    expect(await savedSession({ sessionId: 's1', transcriptPath: null, telemetry: null }, async () => null)).toBeNull();
    expect(await savedSession({ sessionId: 's1', transcriptPath: null, telemetry: null }, async () => { throw new Error('worker gone'); })).toBeNull();
    expect(await savedSession({ sessionId: null, transcriptPath: null, telemetry: null }, never)).toBeNull();
  });
});

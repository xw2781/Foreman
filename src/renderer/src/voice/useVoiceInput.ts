import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareVoiceModel, transcribe, useVoiceStatus } from './engine';

export type VoiceState = 'idle' | 'recording' | 'transcribing';

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 5 * 60;

/** Decodes a recording to the 16 kHz mono samples Whisper expects. */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    return mono;
  } finally {
    void context.close();
  }
}

function micMessage(error: unknown): string {
  const name = (error as DOMException)?.name;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow it in Windows Settings → Privacy → Microphone.';
  return error instanceof Error ? error.message : String(error);
}

/** Records from the microphone and transcribes locally. `onText` gets the finished transcript. */
export function useVoiceInput(onText: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const model = useVoiceStatus();
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  };

  useEffect(() => {
    if (state !== 'recording') return;
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) recorder.current?.stop();
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => () => {
    cancelled.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      stream.current = media;
      chunks.current = [];
      cancelled.current = false;
      const rec = new MediaRecorder(media);
      recorder.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        release();
        if (cancelled.current || !blob.size) { setState('idle'); return; }
        setState('transcribing');
        try {
          const text = await transcribe(await toSamples(blob));
          if (text) callbacks.current.onText(text);
          else callbacks.current.onError('No speech was detected.');
        } catch (error) {
          callbacks.current.onError(`Voice input failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setState('idle');
        }
      };
      rec.start();
      setState('recording');
      prepareVoiceModel(); // normally already done; covers a model that wasn't ready yet
    } catch (error) {
      release();
      callbacks.current.onError(micMessage(error));
    }
  }, [state]);

  const stop = useCallback(() => { if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);
  const cancel = useCallback(() => {
    cancelled.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else release();
  }, []);

  return { state, seconds, model, start, stop, cancel };
}

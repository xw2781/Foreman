import { useSyncExternalStore } from 'react';
import { voiceModel } from '@shared/voiceModels';
import { useApp } from '../store';
import type { WorkerReply } from './whisperWorker';

/** The speech model's setup state, for the UI: downloaded and loaded ahead of time, never during a chat. */
export interface VoiceStatus {
  model: string;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Download progress; null before the first byte or once everything is on disk and being set up. */
  percent: number | null;
  error: string | null;
}

let status: VoiceStatus = { model: '', state: 'idle', percent: null, error: null };
const listeners = new Set<() => void>();
const setStatus = (next: VoiceStatus) => {
  status = next;
  listeners.forEach((fn) => fn());
};

export function useVoiceStatus(): VoiceStatus {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => status);
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    if (reply.type === 'progress' || reply.type === 'ready' || reply.type === 'failed') {
      if (reply.model !== status.model) return; // a model the person has since replaced
      if (reply.type === 'progress') setStatus({ ...status, state: 'loading', percent: reply.percent });
      else if (reply.type === 'ready') setStatus({ ...status, state: 'ready', percent: null, error: null });
      else setStatus({ ...status, state: 'failed', percent: null, error: reply.message });
      return;
    }
    const job = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.type === 'result') job?.resolve(reply.text);
    else job?.reject(new Error(reply.message));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Speech model failed to load');
    pending.forEach((job) => job.reject(error));
    pending.clear();
    worker?.terminate();
    worker = null;
    setStatus({ ...status, state: 'failed', percent: null, error: error.message });
  };
  return worker;
}

/** Downloads (once) and loads the model in the background. Safe to call again; `force` retries a failure. */
export function prepareVoiceModel(modelId = useApp.getState().settings?.voiceModel, force = false) {
  const model = voiceModel(modelId).id;
  if (!force && status.model === model && status.state !== 'failed' && status.state !== 'idle') return;
  setStatus({ model, state: 'loading', percent: null, error: null });
  getWorker().postMessage({ warm: true, model });
}

export function transcribe(audio: Float32Array): Promise<string> {
  const model = voiceModel(useApp.getState().settings?.voiceModel).id;
  if (status.model !== model || status.state === 'failed') prepareVoiceModel(model, true);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, model, audio }, [audio.buffer]);
  });
}

/** "Downloading 43%", "Setting up…", "Ready": one line for the status, or null when idle. */
export function describeVoiceStatus(s: VoiceStatus): string | null {
  if (s.state === 'loading') return s.percent !== null && s.percent < 100 ? `Downloading… ${s.percent}%` : 'Setting up…';
  if (s.state === 'ready') return 'Ready';
  if (s.state === 'failed') return `Couldn't load the model: ${s.error ?? 'unknown error'}`;
  return null;
}

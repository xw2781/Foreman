/// <reference lib="webworker" />
// Local speech-to-text: Whisper through ONNX Runtime's WASM backend, off the UI thread.
// The runtime ships inside the app; only the model weights are downloaded (once, then cached).
import { pipeline, env } from '@huggingface/transformers';
import { voiceModel } from '@shared/voiceModels';
import wasmUrl from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import gpuWasmUrl from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import gpuMjsUrl from '../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

export type WorkerRequest = { id: number; model: string; audio: Float32Array } | { warm: true; model: string };
export type WorkerReply =
  | { type: 'progress'; model: string; percent: number }
  | { type: 'ready'; model: string }
  | { type: 'failed'; model: string; message: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };


env.allowLocalModels = false;
env.useWasmCache = false;
const onnx = env.backends.onnx as any;
const abs = (url: string) => new URL(url, self.location.href).href;
const runtimes = {
  webgpu: { mjs: abs(gpuMjsUrl), wasm: abs(gpuWasmUrl) },
  wasm: { mjs: abs(mjsUrl), wasm: abs(wasmUrl) }
};
onnx.wasm.numThreads = 1;

const post = (reply: WorkerReply) => (self as DedicatedWorkerGlobalScope).postMessage(reply);

// Each model file reports its own progress; the total is what the person cares about.
const files = new Map<string, { loaded: number; total: number }>();
let current = '';
const onProgress = (p: any) => {
  if (p.status !== 'progress' || !p.total) return;
  files.set(p.file, { loaded: p.loaded, total: p.total });
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) { loaded += f.loaded; total += f.total; }
  post({ type: 'progress', model: current, percent: Math.min(100, Math.round((loaded / total) * 100)) });
};

// The graphics card is several times faster than the CPU; fall back to the CPU where WebGPU isn't usable.
async function create(modelId: string, device: 'webgpu' | 'wasm') {
  const model = voiceModel(modelId);
  onnx.wasm.wasmPaths = runtimes[device];
  const options: any = { device, progress_callback: onProgress };
  options.dtype = device === 'webgpu' ? { encoder_model: model.gpu[0], decoder_model_merged: model.gpu[1] } : 'q8';
  const run = await pipeline('automatic-speech-recognition', model.id, options);
  if (device === 'webgpu') await run(new Float32Array(16000), { task: 'transcribe' }); // compile the shaders now, not on the first recording
  return run;
}

// One model is held at a time; choosing another in Settings replaces it.
let transcriber: { model: string; run: Promise<any> } | null = null;
const load = (model: string) => {
  if (transcriber?.model === model) return transcriber.run;
  files.clear();
  current = model;
  const run = (async () => {
    let loaded: any;
    if ((self as any).navigator?.gpu) {
      try { loaded = await create(model, 'webgpu'); } catch { files.clear(); }
    }
    loaded ??= await create(model, 'wasm');
    post({ type: 'ready', model });
    return loaded;
  })().catch((error) => { if (transcriber?.run === run) transcriber = null; throw error; });
  transcriber = { model, run };
  return run;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if ('warm' in event.data) { load(event.data.model).catch((error) => post({ type: 'failed', model: event.data.model, message: error instanceof Error ? error.message : String(error) })); return; }
  const { id, model, audio } = event.data;
  try {
    const run = await load(model);
    const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' });
    post({ type: 'result', id, text: String(Array.isArray(out) ? out[0]?.text : out?.text ?? '').trim() });
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};

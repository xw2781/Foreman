/** Speech-to-text models for chat voice input (Whisper, run locally; weights download on first use). */
export interface VoiceModel {
  id: string;
  label: string;
  /** Approximate download. */
  size: string;
  hint: string;
  /** Weight precision on the GPU: [encoder, decoder]. */
  gpu: [string, string];
}

export const VOICE_MODELS: VoiceModel[] = [
  { id: 'Xenova/whisper-tiny', label: 'Tiny', size: '~85 MB', hint: 'Fastest, mishears often', gpu: ['fp32', 'q4'] },
  { id: 'Xenova/whisper-base', label: 'Base', size: '~160 MB', hint: 'Balanced (default)', gpu: ['fp32', 'q4'] },
  { id: 'Xenova/whisper-small', label: 'Small', size: '~450 MB', hint: 'Better with technical terms and accents', gpu: ['fp32', 'q4'] }
];

export const DEFAULT_VOICE_MODEL = 'Xenova/whisper-base';

export function voiceModel(id: string | undefined): VoiceModel {
  return VOICE_MODELS.find((m) => m.id === id) ?? VOICE_MODELS.find((m) => m.id === DEFAULT_VOICE_MODEL)!;
}

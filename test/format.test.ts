import { describe, expect, it } from 'vitest';
import { modelLabel } from '../src/renderer/src/format';

describe('model names', () => {
  it('names Claude models the way people say them', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5 · 1M');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('opus[1m]')).toBe('Opus (latest) · 1M');
  });

  it('names GPT models and leaves unknown ids alone', () => {
    expect(modelLabel('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelLabel('gpt-5.1-codex-max')).toBe('GPT-5.1 Codex Max');
    expect(modelLabel('gpt-5.5')).toBe('GPT-5.5');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    expect(modelLabel(null)).toBe('');
  });
});

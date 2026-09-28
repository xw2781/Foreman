import { describe, expect, it } from 'vitest';
import { defaultModel, modelChoices } from '../src/shared/models';

describe('model selection defaults', () => {
  it('uses the first listed model instead of an older CLI default', () => {
    const configured = { model: 'opus[1m]', effort: null, models: null };
    expect(defaultModel('claude', configured)).toBe('claude-opus-5-5');
    expect(defaultModel('codex')).toBe('gpt-6-astra');
    expect(modelChoices('claude', configured)).not.toContain('');
  });
  it('sorts allowed models newest first without promoting a custom selection', () => {
    const configured = { model: 'claude-haiku-4-5', effort: null, models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5'] };
    expect(modelChoices('claude', configured, 'custom')).toEqual(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'custom']);
    expect(defaultModel('claude', configured)).toBe('claude-opus-5-5');
  });
});

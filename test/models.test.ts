import { describe, expect, it } from 'vitest';
import { defaultModel, modelChoices, olderModelIds } from '../src/shared/models';

describe('model selection defaults', () => {
  it('groups older Claude versions using resolved aliases while preserving defaults and custom models', () => {
    const defaults = { model: null, effort: null, models: null, discoveredModels: [
      { id: 'default', label: 'Default', resolvedModel: 'claude-sonnet-5' },
      { id: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5' },
      { id: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5-5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8' },
      { id: 'claude-fable-5-1', label: 'Fable' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku' }
    ] };
    expect([...olderModelIds('claude', defaults, 'custom')]).toEqual(['claude-sonnet-5', 'claude-opus-4-8[1m]']);
    expect([...olderModelIds('claude', defaults, 'claude-sonnet-4-6')]).toContain('claude-sonnet-4-6');
  });
  it('compares Codex versions within each variant rather than hiding different families', () => {
    const defaults = { model: null, effort: null, models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5'] };
    expect([...olderModelIds('codex', defaults)].sort()).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-sol']);
  });
  it('respects an allowlist and compares numeric versions without mistaking date suffixes for versions', () => {
    const defaults = { model: null, effort: null, models: ['claude-sonnet-5-10', 'claude-sonnet-5-5-20261001', 'claude-haiku-4-5-20251001', 'sonnet'] };
    expect([...olderModelIds('claude', defaults)]).toEqual(['claude-sonnet-5-5-20261001']);
    expect([...olderModelIds('claude', { ...defaults, models: ['claude-sonnet-5'] })]).toEqual([]);
  });
  it('uses the discovered order, including aliases, without promoting a versioned model', () => {
    const defaults = { model: null, effort: null, models: null, discoveredModels: [
      { id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }, { id: 'claude-fable-5-1[1m]', label: 'Fable' }, { id: 'sonnet', label: 'Sonnet 5.5' }
    ] };
    expect(defaultModel('claude', defaults)).toBe('default');
    expect(modelChoices('claude', defaults, 'custom')).toEqual(['default', 'opus', 'claude-fable-5-1[1m]', 'sonnet', 'custom']);
    expect(modelChoices('claude', { ...defaults, models: ['haiku'] })).toEqual(['haiku']);
  });
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileService, applyProfilePatch } from '../src/main/profiles';
import type { Profile } from '../src/shared/types';

const base: Profile = { id: 'claude-work', provider: 'claude', label: 'Work', color: 'slot-4', configDir: 'C:\\p', builtin: false, createdAt: '' };

describe('account edits', () => {
  it('sets and trims the default model and effort', () => {
    const next = applyProfilePatch(base, { defaultModel: '  opus[1m] ', defaultEffort: 'high' });
    expect(next.defaultModel).toBe('opus[1m]');
    expect(next.defaultEffort).toBe('high');
    expect(next.label).toBe('Work');
  });

  it('clears a default with an empty string and leaves omitted fields alone', () => {
    const withDefaults = { ...base, defaultModel: 'sonnet', defaultEffort: 'low' };
    const next = applyProfilePatch(withDefaults, { defaultModel: '' });
    expect('defaultModel' in next).toBe(false);
    expect(next.defaultEffort).toBe('low');
  });

  it('keeps the old name when the new one is blank and ignores unknown keys', () => {
    const next = applyProfilePatch(base, { label: '   ', id: 'hijack', configDir: 'D:\\x' } as any);
    expect(next.label).toBe('Work');
    expect(next.id).toBe('claude-work');
    expect(next.configDir).toBe('C:\\p');
  });
});

describe('ProfileService.update', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists account defaults to profiles.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-profiles-'));
    dirs.push(dir);
    const service = new ProfileService(dir);
    // The store writes on a short debounce; flush so a fresh service reads the file.
    const flush = () => (service as any).store.flush();
    service.update('claude-default', { defaultModel: 'opus', defaultEffort: 'xhigh' });
    flush();
    const reread = new ProfileService(dir).get('claude-default');
    expect(reread?.defaultModel).toBe('opus');
    expect(reread?.defaultEffort).toBe('xhigh');
    service.update('claude-default', { defaultEffort: '' });
    flush();
    expect(new ProfileService(dir).get('claude-default')?.defaultEffort).toBeUndefined();
  });
});

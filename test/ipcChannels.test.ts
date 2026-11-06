import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS } from '../src/shared/ipc';

describe('IPC channels', () => {
  it('lets the page reach every declared invoke channel', () => {
    // The preload refuses anything not in INVOKE_CHANNELS, so a declared channel left out is a dead button.
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'shared', 'ipc.ts'), 'utf8');
    const map = /interface InvokeMap \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const declared = [...map.matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(50);
    expect(declared.filter((c) => !(INVOKE_CHANNELS as string[]).includes(c))).toEqual([]);
  });
});

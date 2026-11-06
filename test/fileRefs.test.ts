import { describe, expect, it } from 'vitest';
import { fileRef, formatRef, insertAt, joinPath, relativeTo, spaceDrop } from '../src/renderer/src/fileRefs';

describe('file references', () => {
  it('joins with the base folder separator', () => {
    expect(joinPath('E:\\Repo', 'src/main/a.ts')).toBe('E:\\Repo\\src\\main\\a.ts');
    expect(joinPath('E:\\Repo\\', 'a.ts')).toBe('E:\\Repo\\a.ts');
    expect(joinPath('/home/me/repo', 'src/a.ts')).toBe('/home/me/repo/src/a.ts');
    expect(joinPath('/repo', '')).toBe('/repo');
  });

  it('makes paths relative to the agent folder, case-insensitively on Windows', () => {
    expect(relativeTo('E:\\Repo', 'E:\\Repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeTo('e:\\repo\\', 'E:\\Repo\\src\\a.ts')).toBe('src/a.ts');
    expect(relativeTo('E:\\Repo', 'E:\\Repo')).toBe('');
    expect(relativeTo('E:\\Repo', 'E:\\Repository\\a.ts')).toBeNull();
    expect(relativeTo('E:\\Repo\\app', 'E:\\Repo\\README.md')).toBeNull();
    expect(relativeTo('/repo', '/Repo/a.ts')).toBeNull();
  });

  it('falls back to the full path outside the agent folder', () => {
    expect(fileRef('E:\\Repo\\app', 'E:\\Repo\\README.md')).toEqual({ full: 'E:\\Repo\\README.md', relative: 'E:\\Repo\\README.md', name: 'README.md' });
    expect(fileRef('E:\\Repo', 'E:\\Repo\\docs\\')).toMatchObject({ relative: 'docs', name: 'docs' });
  });

  it('quotes paths that are not plain', () => {
    expect(formatRef('src/main/agents.ts')).toBe('@src/main/agents.ts');
    expect(formatRef('Additional Reference from NY Indication Files.msg')).toBe('@`Additional Reference from NY Indication Files.msg`');
    expect(formatRef('a `b`.md')).toBe('@``a `b`.md``');
    expect(formatRef('`x`')).toBe('@`` `x` ``');
  });

  it('inserts at the caret, spaced from neighbouring words', () => {
    expect(insertAt('', 0, '@a.ts')).toEqual({ text: '@a.ts ', caret: 6 });
    expect(insertAt('look at', 7, '@a.ts')).toEqual({ text: 'look at @a.ts ', caret: 14 });
    expect(insertAt('lookat', 4, '@a.ts')).toEqual({ text: 'look @a.ts at', caret: 11 });
    expect(insertAt('look  at', 5, '@a.ts')).toEqual({ text: 'look @a.ts at', caret: 11 });
  });

  it('spaces a natively dropped mention', () => {
    expect(spaceDrop('see and', 'see@a.ts and', '@a.ts')).toEqual({ text: 'see @a.ts and', caret: 10 });
    expect(spaceDrop('aa', 'aaa', 'a')).toEqual({ text: 'aa a ', caret: 5 });
    expect(spaceDrop('abc', 'xyz', '@a')).toBeNull();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProjectDirectory, readProjectFile, resolveInside, sortEntries } from '../src/main/projectFiles';

describe('project files', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-files-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), '\uFEFFconsole.log(1);\n');
    fs.writeFileSync(path.join(root, 'file10.txt'), 'ten');
    fs.writeFileSync(path.join(root, 'file2.txt'), 'two');
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(root, 'dot.png'), Buffer.from([137, 80, 78, 71]));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('refuses paths that leave the project folder', () => {
    const base = 'E:\\Projects\\Report';
    expect(resolveInside(base, 'src/a.ts')).toBe('E:\\Projects\\Report\\src\\a.ts');
    expect(resolveInside(base, '')).toBe(base);
    expect(resolveInside(base, '..file')).toBe('E:\\Projects\\Report\\..file');
    for (const bad of ['..', '../Other/x', 'src/../../x', 'C:\\Windows\\win.ini', 'D:x']) expect(() => resolveInside(base, bad)).toThrow();
  });

  it('lists folders first in natural order', async () => {
    const { entries, omitted } = await listProjectDirectory(root, '');
    expect(entries.map((e) => e.name)).toEqual(['src', 'blob.bin', 'dot.png', 'file2.txt', 'file10.txt']);
    expect(entries[0]).toMatchObject({ dir: true, path: 'src' });
    expect(omitted).toBe(0);
    const inner = await listProjectDirectory(root, 'src');
    expect(inner.entries[0].path).toBe('src/main.ts');
    expect(sortEntries([{ name: 'b', dir: false }, { name: 'A', dir: false }]).map((e) => e.name)).toEqual(['A', 'b']);
  });

  it('previews text, images and binaries', async () => {
    expect(await readProjectFile(root, 'src/main.ts')).toMatchObject({ kind: 'text', text: 'console.log(1);\n', truncated: false });
    expect(await readProjectFile(root, 'blob.bin')).toMatchObject({ kind: 'binary', size: 4 });
    const image = await readProjectFile(root, 'dot.png');
    expect(image.kind).toBe('image');
    if (image.kind === 'image') expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    await expect(readProjectFile(root, 'src')).rejects.toThrow();
  });
});

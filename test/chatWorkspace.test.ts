import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveChatWorkspace } from '../src/main/chatWorkspace';
import type { LaunchOptions } from '../src/shared/types';

const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-chat-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const options: LaunchOptions = { provider: 'codex', profileId: 'test', mode: 'chat', cwd: '' };

describe('projectless chats', () => {
  it('creates separate persistent workspaces and reuses files on resume', () => {
    const dir = root();
    const first = resolveChatWorkspace(options, 'first', dir);
    const second = resolveChatWorkspace({ ...options, provider: 'claude' }, 'second', dir);
    expect(first.projectless).toBe(true);
    expect(first.cwd).not.toBe(second.cwd);
    expect(fs.statSync(second.cwd).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(first.cwd, 'note.txt'), 'kept');
    const resumed = resolveChatWorkspace({ ...first, mode: 'interactive' }, 'first', dir);
    expect(resumed.cwd).toBe(first.cwd);
    expect(fs.readFileSync(path.join(resumed.cwd, 'note.txt'), 'utf8')).toBe('kept');
  });
  it('keeps project launches unchanged and honors an explicit no-project choice', () => {
    const dir = root();
    const project = { ...options, cwd: dir };
    expect(resolveChatWorkspace(project, 'project', dir)).toBe(project);
    expect(resolveChatWorkspace({ ...project, projectless: true }, 'standalone', dir).cwd).toBe(path.join(dir, 'chat-workspaces', 'standalone'));
  });
  it('rejects invalid managed workspace ids and projectless task launches', () => {
    const dir = root();
    expect(() => resolveChatWorkspace(options, '../escape', dir)).toThrow('Invalid chat workspace id');
    expect(() => resolveChatWorkspace({ ...options, mode: 'task', projectless: true }, 'task', dir)).toThrow('working folder');
  });
});

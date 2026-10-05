import fs from 'node:fs';
import path from 'node:path';
import type { LaunchOptions } from '../shared/types';

/** CLI processes need a cwd even when the conversation has no project. */
export function resolveChatWorkspace(options: LaunchOptions, id: string, userDataDir: string): LaunchOptions {
  if (!options.projectless && !(options.mode === 'chat' && !options.cwd.trim())) return options;
  if (!['chat', 'interactive'].includes(options.mode)) throw new Error('This mode needs a working folder.');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid chat workspace id.');
  const cwd = path.join(userDataDir, 'chat-workspaces', id);
  fs.mkdirSync(cwd, { recursive: true });
  return { ...options, cwd, projectless: true };
}

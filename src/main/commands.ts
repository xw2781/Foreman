import type { LaunchOptions, Profile } from '../shared/types';

export interface BuiltCommand {
  args: string[];
  /** Launched as a pipe-driven child process (headless) rather than in a terminal. */
  headless: boolean;
}

/** Splits a user-typed extra-arguments string the way a shell would (quotes, no expansion). */
export function splitArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const args: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    // Backslashes are Windows path separators; only \" is an escape.
    args.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[2] ?? match[3]);
  }
  return args;
}

export function claudeCommand(
  options: LaunchOptions,
  sessionId: string | null,
  settingsFile: string | null
): BuiltCommand {
  const args: string[] = [];
  const headless = options.mode === 'task';
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  else if (sessionId) args.push('--session-id', sessionId);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permission && options.permission !== 'default') args.push('--permission-mode', options.permission);
  if (options.title && !headless) args.push('--name', options.title);
  if (settingsFile) args.push('--settings', settingsFile);
  args.push(...splitArgs(options.extraArgs));
  if (headless) {
    args.push('--print', '--output-format', 'stream-json', '--verbose');
    args.push(options.prompt ?? '');
  } else if (options.prompt) {
    args.push(options.prompt);
  }
  return { args, headless };
}

export function codexCommand(options: LaunchOptions, profile: Profile, noDaemonForIsolated: boolean): BuiltCommand {
  const headless = options.mode === 'task';
  const args: string[] = [];
  if (headless) args.push('exec', '--skip-git-repo-check', '--color', 'always');
  else if (options.resumeSessionId) args.push('resume', options.resumeSessionId);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('-c', `model_reasoning_effort="${options.effort}"`);
  switch (options.permission) {
    case 'read-only':
      args.push('--sandbox', 'read-only');
      break;
    case 'auto':
      args.push('--sandbox', 'workspace-write');
      if (!headless) args.push('--ask-for-approval', 'on-request');
      break;
    case 'approve-for-me':
      args.push('--sandbox', 'workspace-write');
      if (!headless) args.push('--ask-for-approval', 'on-request', '-c', 'approvals_reviewer="auto_review"');
      break;
    case 'full-access':
      args.push('--dangerously-bypass-approvals-and-sandbox');
      break;
    default:
      break;
  }
  // An isolated account must not attach to a background app-server that was
  // started under another account's CODEX_HOME.
  if (!headless && !profile.builtin && noDaemonForIsolated) args.push('--no-daemon');
  args.push(...splitArgs(options.extraArgs));
  if (options.prompt && !options.resumeSessionId) args.push(options.prompt);
  return { args, headless };
}

export function loginCommand(profile: Profile): string[] {
  if (profile.provider === 'claude') {
    return profile.emailHint ? ['auth', 'login', '--email', profile.emailHint] : ['auth', 'login'];
  }
  return ['login'];
}

export function logoutCommand(profile: Profile): string[] {
  return profile.provider === 'claude' ? ['auth', 'logout'] : ['logout'];
}

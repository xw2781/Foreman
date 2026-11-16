import type { AppSettings, IdleMode, Profile } from '../shared/types';
import { IDLE_COMPACT_MIN_FLOOR } from '../shared/promptCache';

export { IDLE_COMPACT_MIN_FLOOR, idleCompactFloor } from '../shared/promptCache';

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

const CODEX_SUBCOMMANDS = new Set(['app-server', 'exec', 'resume']);

/**
 * Adds the browser options to a command line. Codex reads `-c` overrides only after its
 * subcommand (`codex exec -c …`); Claude Code's go first, because `--mcp-config` and
 * `--allowedTools` take several values and must be followed by another option, not the prompt.
 */
export function withBrowserArgs(args: string[], browser: string[]): string[] {
  if (!browser.length) return args;
  if (CODEX_SUBCOMMANDS.has(args[0])) return [args[0], ...browser, ...args.slice(1)];
  return [...browser, ...args];
}


/**
 * Idle compaction: when a long conversation sits idle, Claude Code may compact it
 * shortly before the prompt cache expires (rolled out by Anthropic per account).
 * `settings` goes into the agent's --settings file (written only when it's turned off,
 * so the default launch is unchanged); `env` goes onto the child process.
 * `heldOff`: a chat kept warm, whose compaction the app runs itself once the warm hours end
 * (Claude Code's own would come 54 minutes into them).
 */
export function claudeIdleCompaction(idle: IdleMode, app: Pick<AppSettings, 'claudeIdleCompactMinTokens'>, heldOff = false) {
  const settings: Record<string, unknown> = idle !== 'compact' || heldOff ? { idleCompaction: false } : {};
  const env: Record<string, string> = {};
  const floor = app.claudeIdleCompactMinTokens;
  // Kept even while held off: the chat may stop being kept warm, and Claude Code compacts again.
  if (idle === 'compact' && Number.isFinite(floor) && floor > 0) {
    env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = String(Math.max(IDLE_COMPACT_MIN_FLOOR, Math.round(floor)));
  }
  return { settings, env };
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

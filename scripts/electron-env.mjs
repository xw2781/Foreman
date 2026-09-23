import path from 'node:path';
import { createRequire } from 'node:module';

// Variables that make Electron (or a nested agent CLI) misbehave when this app
// is launched from inside VS Code, a Claude Code session, or a Codex session.
const INHERITED_NOISE = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|VSCODE_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_VERSION$|CODEX_THREAD_ID$|CODEX_SANDBOX)/;

export function electronEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!INHERITED_NOISE.test(key)) env[key] = value;
  }
  return env;
}

export function electronBinary(root) {
  const require = createRequire(path.join(root, 'package.json'));
  return require('electron');
}

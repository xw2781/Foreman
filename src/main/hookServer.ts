import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HookEvent {
  agentId: string;
  name: string;
  payload: Record<string, any>;
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Receives Claude Code HTTP hooks on 127.0.0.1 so the app knows exactly when
 * each agent starts a turn, runs a tool, waits for permission, or finishes.
 * Hooks are injected per agent through `claude --settings <file>`, which
 * Claude Code merges with the user's own settings: nothing the user owns is
 * modified. The server always answers `{}` immediately, i.e. "no decision",
 * so a hook never changes what Claude Code would have done.
 */
export class HookServer {
  private server: http.Server | null = null;
  private token = crypto.randomBytes(24).toString('hex');
  port = 0;
  onEvent: (event: HookEvent) => void = () => {};
  /** Returns the text Claude Code shows in its status bar for this agent. */
  onStatusLine: (agentId: string, payload: Record<string, any>) => Promise<string> = async () => '';

  constructor(private settingsDir: string) {}

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    fs.mkdirSync(this.settingsDir, { recursive: true });
    // Settings files from a previous run point at a dead port.
    for (const name of fs.readdirSync(this.settingsDir)) {
      if (name.endsWith('.json')) fs.rmSync(path.join(this.settingsDir, name), { force: true });
    }
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const match = /^\/(hook|statusline)\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match || req.headers['x-atc-token'] !== this.token) {
      res.writeHead(404).end();
      return;
    }
    const [, route, agentId] = match;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Tool inputs can be large (file contents); we only need the head.
      if (size <= 512 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      let payload: Record<string, any> = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // truncated or malformed: still useful as a bare event
      }
      if (route === 'statusline') {
        this.onStatusLine(agentId, payload)
          .catch(() => '')
          .then((text) => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';
      this.onEvent({ agentId, name, payload });
    });
  }

  /**
   * Writes the per-agent settings file passed to `claude --settings`.
   * With `statusLine`, Claude Code's status-line JSON (authoritative context
   * size, its own cost estimate, plan limits) is posted here too; the app
   * answers with the text of the user's own status line so nothing changes
   * on screen. curl.exe ships with Windows 10 1803 and later.
   */
  settingsFileFor(agentId: string, statusLine: { refreshInterval?: number } | null = null): string | null {
    if (!this.url) return null;
    // Only documented keys: an invalid settings file makes Claude Code show an error dialog.
    const hook = { type: 'http', url: `${this.url}/hook/${agentId}`, headers: { 'X-ATC-Token': this.token } };
    const hooks: Record<string, unknown[]> = {};
    for (const event of EVENTS) {
      hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }];
    }
    const settings: Record<string, unknown> = { hooks };
    if (statusLine) {
      const curl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe').replace(/\\/g, '/');
      // An unquoted program path runs in bash, cmd and PowerShell alike (PowerShell
      // would need `&` before a quoted one); quote only if the path has spaces.
      const program = /\s/.test(curl) ? `"${curl}"` : curl;
      settings.statusLine = {
        type: 'command',
        command: `${program} -s -m 8 --data-binary "@-" -H "X-ATC-Token: ${this.token}" ${this.url}/statusline/${agentId}`,
        ...(statusLine.refreshInterval ? { refreshInterval: statusLine.refreshInterval } : {})
      };
    }
    const file = path.join(this.settingsDir, `${agentId}.json`);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    return file;
  }

  removeSettingsFile(agentId: string) {
    fs.rmSync(path.join(this.settingsDir, `${agentId}.json`), { force: true });
  }

  stop() {
    this.server?.close();
  }
}

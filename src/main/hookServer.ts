import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GUARDED_TOOLS } from './screenGuard';

/**
 * Answers Claude Code's PreToolUse hook on 127.0.0.1 for the tools `guard` watches
 * (hand-written desktop control, see screenGuard.ts). The hook is injected per agent
 * through `claude --settings <file>`, which Claude Code merges with the user's own
 * settings: nothing the user owns is modified. Every other reply is `{}`, "no decision".
 * Chats take their events over stdio, so this is the only hook they get.
 */
export class HookServer {
  private server: http.Server | null = null;
  private token = crypto.randomBytes(24).toString('hex');
  port = 0;
  /** A PreToolUse reply that overrides "no decision", or null. */
  guard: (agentId: string, payload: Record<string, any>) => Record<string, unknown> | null = () => null;

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
    const match = /^\/guard\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match || req.headers['x-atc-token'] !== this.token) {
      res.writeHead(404).end();
      return;
    }
    const agentId = match[1];
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
      const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';
      let reply: Record<string, unknown> | null = null;
      if (name === 'PreToolUse') {
        try {
          reply = this.guard(agentId, payload);
        } catch {
          reply = null;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply ?? {}));
    });
  }

  /** Settings that give a chat only the PreToolUse guard (its other events come over stdio). */
  guardSettings(agentId: string): Record<string, unknown> {
    if (!this.url) return {};
    const hook = { type: 'http', url: `${this.url}/guard/${agentId}`, headers: { 'X-ATC-Token': this.token } };
    return { hooks: { PreToolUse: [{ matcher: GUARDED_TOOLS, hooks: [hook] }] } };
  }

  /** Writes the per-agent settings file passed to `claude --settings`. Only documented keys: an invalid file makes Claude Code show an error dialog. */
  writeSettingsFile(agentId: string, settings: Record<string, unknown>): string {
    const file = path.join(this.settingsDir, `${agentId}.json`);
    fs.mkdirSync(this.settingsDir, { recursive: true });
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

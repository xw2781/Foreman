// The browser tools as an MCP server (Streamable HTTP, stateless: every
// request is answered with a plain JSON response) on 127.0.0.1. Each agent has
// its own URL, /mcp/<agent id>/<token>; the token is derived from a secret made
// at startup, so one agent can't reach another agent's browser and nothing
// else on the computer can guess the URL. Requests carrying an Origin header
// come from a web page and are refused, including pages in the agent browser
// itself.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_INSTRUCTIONS, TOOLS, type ToolResult } from './tools';

export const SERVER_NAME = 'foreman_browser';
const BODY_LIMIT = 4 * 1024 * 1024;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number; message: string };
}

export type ToolRunner = (agentId: string, name: string, args: Record<string, any>) => Promise<ToolResult>;

/** Answers one JSON-RPC message; null for notifications and responses, which get no reply. */
export async function dispatchMcp(message: JsonRpcMessage, agentId: string, run: ToolRunner, version: string): Promise<JsonRpcMessage | null> {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return null;
  const isRequest = message.id !== undefined && message.id !== null;
  if (!isRequest) return null;
  const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: message.id, result });
  const error = (code: number, text: string): JsonRpcMessage => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'foreman-browser', title: 'Foreman browser', version },
        instructions: SERVER_INSTRUCTIONS
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') return error(-32602, 'Missing tool name');
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      return reply(await run(agentId, name, args));
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return error(-32601, `Method not found: ${message.method}`);
  }
}

export class BrowserMcpServer {
  private server: http.Server | null = null;
  private secret = crypto.randomBytes(32);
  port = 0;

  constructor(private run: ToolRunner, private configDir: string, private version: string) {}

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    // Tool calls such as waits and page loads take a while; no idle cutoff.
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    fs.mkdirSync(this.configDir, { recursive: true });
    // Config files from a previous run point at a dead port.
    for (const name of fs.readdirSync(this.configDir)) {
      if (name.endsWith('.json')) fs.rmSync(path.join(this.configDir, name), { force: true });
    }
  }

  get running() {
    return this.port > 0;
  }

  token(agentId: string) {
    return crypto.createHmac('sha256', this.secret).update(agentId).digest('hex').slice(0, 40);
  }

  urlFor(agentId: string): string | null {
    return this.port ? `http://127.0.0.1:${this.port}/mcp/${agentId}/${this.token(agentId)}` : null;
  }

  /** Arguments that give a Claude Code agent the browser (`--mcp-config`, plus `--allowedTools` to skip the per-call prompts). */
  claudeArgs(agentId: string, autoApprove: boolean): string[] {
    const url = this.urlFor(agentId);
    if (!url) return [];
    const file = path.join(this.configDir, `${agentId}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url } } }, null, 2), 'utf8');
    // Both options take several values: they come first, so the next argument is always another option.
    return ['--mcp-config', file, ...(autoApprove ? ['--allowedTools', `mcp__${SERVER_NAME}`] : [])];
  }

  /** Config overrides that give a Codex agent the browser. */
  codexArgs(agentId: string, autoApprove: boolean): string[] {
    const url = this.urlFor(agentId);
    if (!url) return [];
    const key = `mcp_servers.${SERVER_NAME}`;
    return [
      '-c', `${key}.url="${url}"`,
      '-c', `${key}.tool_timeout_sec=120`,
      ...(autoApprove ? ['-c', `${key}.default_tools_approval_mode="approve"`] : [])
    ];
  }

  removeConfig(agentId: string) {
    fs.rmSync(path.join(this.configDir, `${agentId}.json`), { force: true });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const match = /^\/mcp\/([A-Za-z0-9_-]+)\/([a-f0-9]+)\/?$/.exec((req.url ?? '').split('?')[0]);
    const host = req.headers.host ?? '';
    const expected = match ? Buffer.from(this.token(match[1])) : null;
    const given = match ? Buffer.from(match[2]) : null;
    const tokenOk = expected && given && expected.length === given.length && crypto.timingSafeEqual(expected, given);
    if (!match || !tokenOk || req.headers.origin || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
      res.writeHead(404).end();
      return;
    }
    const agentId = match[1];
    if (req.method === 'GET') {
      // No server-to-client stream: this server never sends anything unasked.
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size > BODY_LIMIT) {
        res.writeHead(413).end();
        return;
      }
      let body: JsonRpcMessage | JsonRpcMessage[];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const replies = (await Promise.all(messages.map((m) => dispatchMcp(m, agentId, this.run, this.version).catch((error): JsonRpcMessage => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } }))))).filter(
        (r): r is JsonRpcMessage => r !== null
      );
      if (!replies.length) {
        res.writeHead(202).end();
        return;
      }
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
  }

  stop() {
    this.server?.close();
  }
}

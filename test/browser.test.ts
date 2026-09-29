import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODIFIER, parseKey } from '../src/main/browser/keys';
import { chromeUserAgent, cssCursor, normalizeUrl, schemeAllowed } from '../src/main/browser/browserUtil';
import { BrowserMcpServer, dispatchMcp, SERVER_NAME } from '../src/main/browser/mcpServer';
import { TOOLS } from '../src/main/browser/tools';
import { browserToolDetail, browserToolTitle } from '../src/main/chat/browserTools';
import { installPageAgent, pageCall } from '../src/main/browser/pageAgent';
import { withBrowserArgs } from '../src/main/commands';

describe('parseKey', () => {
  it('reads named keys, characters and combinations', () => {
    expect(parseKey('Enter')).toMatchObject({ key: 'Enter', keyCode: 13, text: '\r', modifiers: 0 });
    expect(parseKey('a')).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
    expect(parseKey('Shift+a')).toMatchObject({ key: 'A', text: 'A', modifiers: MODIFIER.Shift });
    expect(parseKey('Control+a')).toMatchObject({ key: 'a', text: '', modifiers: MODIFIER.Control });
    expect(parseKey('ctrl+shift+Tab')).toMatchObject({ key: 'Tab', modifiers: MODIFIER.Control | MODIFIER.Shift });
    expect(parseKey('ArrowDown')).toMatchObject({ key: 'ArrowDown', keyCode: 40 });
    expect(parseKey('F5')).toMatchObject({ key: 'F5', keyCode: 116 });
    expect(parseKey('+')).toMatchObject({ key: '+' });
    expect(parseKey('Control++')).toMatchObject({ key: '+', modifiers: MODIFIER.Control });
    expect(parseKey('Shift')).toMatchObject({ key: 'Shift', keyCode: 16 });
  });

  it('refuses unknown names', () => {
    expect(() => parseKey('Hyper+a')).toThrow(/modifier/);
    expect(() => parseKey('Enterr')).toThrow(/Unknown key/);
    expect(() => parseKey('')).toThrow();
  });
});

describe('URLs', () => {
  it('adds a scheme where there is none', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('http://x.test/a b')).toBe('http://x.test/a b');
    expect(normalizeUrl('C:\\site\\index.html')).toBe('file:///C:/site/index.html');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(() => normalizeUrl('just words')).toThrow();
  });

  it('allows only web and local pages', () => {
    expect(schemeAllowed('https://example.com')).toBe(true);
    expect(schemeAllowed('file:///C:/a.html')).toBe(true);
    expect(schemeAllowed('mailto:a@b.c')).toBe(false);
    expect(schemeAllowed('zoommtg://join')).toBe(false);
    expect(schemeAllowed('not a url')).toBe(false);
  });

  it('reads like Chrome, without the Electron and app tokens', () => {
    const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) agent-task-center/0.2.0 Chrome/140.0.7339.0 Electron/44.4.5 Safari/537.36';
    expect(chromeUserAgent(agent)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Safari/537.36');
  });

  it('maps Electron cursor names to CSS', () => {
    expect(cssCursor('hand')).toBe('pointer');
    expect(cssCursor('pointer')).toBe('default');
    expect(cssCursor('text')).toBe('text');
    expect(cssCursor('colResize')).toBe('col-resize');
    expect(cssCursor('something-new')).toBe('default');
  });
});

describe('page agent', () => {
  it('serializes to a self-contained script', () => {
    const code = pageCall('snapshot', { maxChars: 100 });
    expect(code).toContain('window.__foreman.snapshot({"maxChars":100})');
    // Serialized with toString: it must parse on its own (no imports, no outside names).
    expect(() => new Function(`return (${installPageAgent.toString()})`)).not.toThrow();
  });
});

describe('MCP dispatch', () => {
  const run = async (_agent: string, name: string, args: Record<string, any>) => ({ content: [{ type: 'text' as const, text: `${name} ${JSON.stringify(args)}` }] });

  it('answers the handshake with the client protocol version', async () => {
    const reply = await dispatchMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, 'a1', run, '1.0.0');
    expect(reply?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'foreman-browser' } });
  });

  it('lists tools and runs them', async () => {
    const list = await dispatchMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'a1', run, '1');
    expect((list?.result as any).tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const call = await dispatchMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { x: 1 } } }, 'a1', run, '1');
    expect(call?.result).toEqual({ content: [{ type: 'text', text: 'browser_snapshot {"x":1}' }] });
  });

  it('ignores notifications and rejects unknown methods', async () => {
    expect(await dispatchMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'a1', run, '1')).toBeNull();
    const unknown = await dispatchMcp({ jsonrpc: '2.0', id: 4, method: 'sampling/createMessage' }, 'a1', run, '1');
    expect(unknown?.error?.code).toBe(-32601);
  });

  it('gives every tool an object schema whose required fields exist', () => {
    for (const tool of TOOLS) {
      const schema = tool.inputSchema as any;
      expect(schema.type).toBe('object');
      for (const field of schema.required ?? []) expect(schema.properties).toHaveProperty(field);
      expect(tool.name).toMatch(/^browser_[a-z_]+$/);
    }
  });
});

describe('MCP server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mcp-'));
  const calls: string[] = [];
  const server = new BrowserMcpServer(async (agent, name) => {
    calls.push(`${agent}:${name}`);
    return { content: [{ type: 'text', text: 'ok' }] };
  }, dir, '1.0.0');

  beforeAll(() => server.start());
  afterAll(() => {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  it('serves each agent at its own URL', async () => {
    const url = server.urlFor('agent1')!;
    const response = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: { content: [{ text: 'ok' }] } });
    expect(calls).toEqual(['agent1:browser_snapshot']);
    expect((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await fetch(url)).status).toBe(405);
  });

  it("refuses another agent's token, and web pages", async () => {
    const other = server.urlFor('agent2')!.split('/').pop()!;
    const forged = server.urlFor('agent1')!.replace(/[a-f0-9]+$/, other);
    expect((await post(forged, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    expect((await post(server.urlFor('agent1')!, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(404);
  });

  it('writes the Claude config and builds Codex overrides', () => {
    const args = server.claudeArgs('agent1', true);
    expect(args[0]).toBe('--mcp-config');
    const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    expect(config.mcpServers[SERVER_NAME]).toEqual({ type: 'http', url: server.urlFor('agent1') });
    expect(args.slice(2)).toEqual(['--allowedTools', `mcp__${SERVER_NAME}`]);
    expect(server.claudeArgs('agent1', false)).toHaveLength(2);
    server.removeConfig('agent1');
    expect(fs.existsSync(args[1])).toBe(false);

    const codex = server.codexArgs('agent1', true);
    expect(codex).toContain(`mcp_servers.${SERVER_NAME}.url="${server.urlFor('agent1')}"`);
    expect(codex).toContain(`mcp_servers.${SERVER_NAME}.default_tools_approval_mode="approve"`);
    expect(server.codexArgs('agent1', false).join(' ')).not.toContain('approval');
  });
});

describe('chat titles', () => {
  it('names browser steps and leaves other MCP servers alone', () => {
    expect(browserToolTitle(SERVER_NAME, 'browser_click')).toBe('Browser · Clicked');
    expect(browserToolTitle('github', 'browser_click')).toBeNull();
    expect(browserToolDetail('browser_navigate', { url: 'https://example.com' })).toBe('https://example.com');
    expect(browserToolDetail('browser_type', { text: 'hello', element: 'Search box' })).toBe('"hello" into Search box');
    expect(browserToolDetail('browser_type', { text: 'hunter2', element: 'Password field' })).toBe('into Password field');
  });
});

describe('withBrowserArgs', () => {
  const browser = ['-c', 'mcp_servers.x.url="u"'];
  it('puts Codex overrides after the subcommand', () => {
    expect(withBrowserArgs(['app-server', '--foo'], browser)).toEqual(['app-server', ...browser, '--foo']);
    expect(withBrowserArgs(['exec', '--skip-git-repo-check', 'prompt'], browser)).toEqual(['exec', ...browser, '--skip-git-repo-check', 'prompt']);
    expect(withBrowserArgs(['resume', 'id'], browser)).toEqual(['resume', ...browser, 'id']);
    expect(withBrowserArgs(['do the thing'], browser)).toEqual([...browser, 'do the thing']);
  });
  it('puts Claude options first and leaves commands alone without a browser', () => {
    const claude = ['--mcp-config', 'f.json', '--allowedTools', 'mcp__x'];
    expect(withBrowserArgs(['--session-id', 's', 'prompt'], claude)).toEqual([...claude, '--session-id', 's', 'prompt']);
    expect(withBrowserArgs(['exec', 'x'], [])).toEqual(['exec', 'x']);
  });
});

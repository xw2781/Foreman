import { describe, expect, it } from 'vitest';
import { ClaudeChat } from '../src/main/chat/claudeChat';
import { parseConnectors } from '../src/main/chat/connectors';
import { ChatLog } from '../src/main/chat/log';
import type { ChatHost } from '../src/main/chat/driver';

function fakeHost() {
  const log = new ChatLog();
  const host: ChatHost = { log, changed: () => {}, status: () => {}, session: () => {}, turnComplete: () => {}, limits: () => {}, requeue: () => {} };
  return { host, log };
}

// Trimmed from a real `mcp_status` reply (Claude Code 2.1.316).
const STATUS = {
  mcpServers: [
    { name: 'claude.ai Microsoft 365', status: 'connected', config: { type: 'claudeai-proxy' }, scope: 'claudeai', source: 'claudeai', tools: [{ name: 'outlook_email_search' }, { name: 'get_me' }] },
    { name: 'claude.ai Gmail', status: 'needs-auth', config: { type: 'claudeai-proxy' }, scope: 'claudeai', source: 'claudeai' },
    { name: 'foreman_browser', status: 'connected', config: { type: 'http' }, scope: 'dynamic', tools: [{ name: 'navigate' }] },
    { name: 'local-db', status: 'failed', config: { type: 'stdio' }, scope: 'project', error: 'spawn ENOENT' },
    { name: 'odd', status: 'something-new', scope: 'user' }
  ]
};

describe('connectors', () => {
  it('lists the session\'s connectors, sign-in needed first, without the app\'s own browser server', () => {
    expect(parseConnectors(STATUS)).toEqual([
      { name: 'claude.ai Gmail', label: 'Gmail', status: 'needs-auth', source: 'claudeai', tools: 0, error: null },
      { name: 'local-db', label: 'local-db', status: 'failed', source: 'local', tools: 0, error: 'spawn ENOENT' },
      { name: 'odd', label: 'odd', status: 'failed', source: 'local', tools: 0, error: null },
      { name: 'claude.ai Microsoft 365', label: 'Microsoft 365', status: 'connected', source: 'claudeai', tools: 2, error: null }
    ]);
    expect(parseConnectors(null)).toBeNull();
  });

  it('asks the CLI for status, the sign-in page and a reconnect', async () => {
    const { host, log } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    const reply = (response: object) => chat.receive(JSON.stringify({ type: 'control_response', response: { request_id: sent.at(-1).request_id, ...response } }));

    const status = chat.connectors();
    expect(sent.at(-1).request).toEqual({ subtype: 'mcp_status' });
    reply({ subtype: 'success', response: STATUS });
    expect((await status)?.map((c) => c.label)).toEqual(['Gmail', 'local-db', 'odd', 'Microsoft 365']);

    const signIn = chat.connectorSignIn('claude.ai Gmail');
    expect(sent.at(-1).request).toEqual({ subtype: 'mcp_authenticate', serverName: 'claude.ai Gmail' });
    reply({ subtype: 'success', response: { authUrl: 'https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=sdk-cli', requiresUserAction: true, callbackExpected: false } });
    expect(await signIn).toEqual({ url: 'https://claude.ai/api/organizations/o/mcp/start-auth/s?product_surface=sdk-cli', error: null });

    const notYet = chat.connectorReconnect('claude.ai Gmail');
    expect(sent.at(-1).request).toEqual({ subtype: 'mcp_reconnect', serverName: 'claude.ai Gmail' });
    reply({ subtype: 'error', error: 'Server status: needs-auth' });
    expect(await notYet).toBe('Server status: needs-auth');
    expect(log.list()).toEqual([]);

    const done = chat.connectorReconnect('claude.ai Gmail');
    reply({ subtype: 'success' });
    expect(await done).toBeNull();
    expect(log.list().map((i) => i.kind === 'notice' && i.text)).toEqual(['Gmail connected. Its tools are available from your next message.']);
  });

  it('refuses a sign-in page that isn\'t https, and settles requests when the session ends', async () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    const signIn = chat.connectorSignIn('x');
    chat.receive(JSON.stringify({ type: 'control_response', response: { request_id: sent.at(-1).request_id, subtype: 'success', response: { authUrl: 'file:///c:/evil' } } }));
    expect(await signIn).toEqual({ url: null, error: null });
    const pending = chat.connectorReconnect('x');
    chat.dispose();
    expect(await pending).toBe('The session has ended');
  });
});

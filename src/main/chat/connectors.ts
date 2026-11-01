// MCP servers and claude.ai connectors (Microsoft 365, Gmail…) as Claude Code
// reports them to `mcp_status`. Signing in to a claude.ai connector happens on
// claude.ai: `mcp_authenticate` returns its start-auth page, and once the person
// has finished there `mcp_reconnect` picks the authorization up.
import type { ChatConnector } from '../../shared/types';
import { SERVER_NAME } from '../browser/mcpServer';

const STATUSES: ChatConnector['status'][] = ['connected', 'needs-auth', 'pending', 'failed', 'disabled'];
const CLAUDE_AI = 'claude.ai ';

export function parseConnectors(response: any): ChatConnector[] | null {
  if (!Array.isArray(response?.mcpServers)) return null;
  return response.mcpServers
    // The app's own browser tools aren't something to manage here.
    .filter((s: any) => typeof s?.name === 'string' && s.name && s.name !== SERVER_NAME)
    .map((s: any): ChatConnector => {
      const claudeai = s.source === 'claudeai' || s.scope === 'claudeai' || s.config?.type === 'claudeai-proxy';
      const name: string = s.name;
      return {
        name,
        label: claudeai && name.startsWith(CLAUDE_AI) ? name.slice(CLAUDE_AI.length) : name,
        status: STATUSES.includes(s.status) ? s.status : 'failed',
        source: claudeai ? 'claudeai' : 'local',
        tools: Array.isArray(s.tools) ? s.tools.length : 0,
        error: typeof s.error === 'string' && s.error.trim() ? s.error.trim() : null
      };
    })
    .sort((a: ChatConnector, b: ChatConnector) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The ones needing the person first, then claude.ai connectors before local servers. */
function rank(c: ChatConnector) {
  return (c.status === 'needs-auth' ? 0 : c.status === 'failed' ? 1 : 2) * 2 + (c.source === 'claudeai' ? 0 : 1);
}

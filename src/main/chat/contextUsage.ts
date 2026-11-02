// What a Claude session's context window holds, from Claude Code's
// `get_context_usage` control request: its categories (system prompt, tools,
// MCP tools, memory files, skills, messages…), folded into the few parts the
// details panel shows, plus the lists behind them.
import type { ContextPart, ContextUsage } from '../../shared/types';
import { CONTEXT_PARTS } from '../../shared/types';

/** Category ids (stable, unlike their English names) → the part they count toward. */
const PART_OF: Record<string, ContextPart> = {
  system_prompt: 'system',
  system_tools: 'tools',
  mcp_tools: 'mcp',
  mcp_instructions: 'mcp',
  memory_files: 'memory',
  skills: 'skills',
  custom_agents: 'skills',
  messages: 'messages'
};

const LABEL: Record<ContextPart, string> = {
  system: 'System prompt',
  tools: 'System tools',
  mcp: 'MCP tools',
  memory: 'Memory files',
  skills: 'Skills & agents',
  messages: 'Messages',
  other: 'Other'
};

/** Where a skill or agent comes from, as the CLI names its settings sources. */
const SOURCE: Record<string, string> = {
  syncedSkills: 'synced',
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  policySettings: 'managed',
  flagSettings: 'session'
};

const int = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const source = (value: unknown) => SOURCE[text(value)] ?? text(value);
const bySize = <T extends { tokens: number }>(a: T, b: T) => b.tokens - a.tokens;

export function parseContextUsage(response: any): ContextUsage | null {
  if (!Array.isArray(response?.categories) || !int(response.maxTokens)) return null;
  const sums = new Map<ContextPart, number>();
  let bufferTokens = 0;
  let freeTokens = 0;
  let deferredTokens = 0;
  for (const c of response.categories) {
    const tokens = int(c?.tokens);
    const kind = c?.kind ?? (c?.isDeferred ? 'deferred' : c?.id === 'free_space' ? 'free' : /buffer/.test(c?.id ?? '') ? 'buffer' : 'used');
    if (kind === 'free') freeTokens += tokens;
    else if (kind === 'buffer') bufferTokens += tokens;
    else if (kind === 'deferred') deferredTokens += tokens;
    else if (tokens) {
      const part = PART_OF[c?.id] ?? 'other';
      sums.set(part, (sums.get(part) ?? 0) + tokens);
    }
  }

  const servers = new Map<string, { name: string; tools: number; tokens: number }>();
  for (const tool of list(response.mcpTools)) {
    if (tool?.isLoaded === false) continue;
    // Tool names carry the server name normalized ("claude_ai_Claude_Docs"): show claude.ai connectors as they're named there.
    const raw = text(tool?.serverName) || 'MCP';
    const name = raw.startsWith('claude_ai_') ? raw.slice('claude_ai_'.length).replace(/_/g, ' ') : raw;
    const server = servers.get(name) ?? { name, tools: 0, tokens: 0 };
    server.tools += 1;
    server.tokens += int(tool?.tokens);
    servers.set(name, server);
  }

  const b = response.messageBreakdown;
  const messages = b
    ? [
        { label: 'Your messages', tokens: int(b.userMessageTokens) },
        { label: "Claude's replies", tokens: int(b.assistantMessageTokens) },
        { label: 'Tool calls', tokens: int(b.toolCallTokens) },
        { label: 'Tool results', tokens: int(b.toolResultTokens) },
        { label: 'Attachments', tokens: int(b.attachmentTokens) },
        { label: 'Other', tokens: int(b.redirectedContextTokens) + int(b.unattributedTokens) }
      ].filter((m) => m.tokens > 0)
    : [];

  return {
    model: text(response.model),
    usedTokens: int(response.totalTokens),
    windowTokens: int(response.maxTokens),
    parts: CONTEXT_PARTS.filter((part) => sums.get(part)).map((part) => ({ part, label: LABEL[part], tokens: sums.get(part)! })),
    bufferTokens,
    freeTokens,
    deferredTokens,
    autoCompactAt: response.isAutoCompactEnabled === false ? null : int(response.autoCompactThreshold) || null,
    memoryFiles: list(response.memoryFiles).map((f) => ({ path: text(f?.path), tokens: int(f?.tokens) })).filter((f) => f.path).sort(bySize),
    mcpServers: [...servers.values()].sort(bySize),
    skills: list(response.skills?.skillFrontmatter).map((s) => ({ name: text(s?.name), source: source(s?.source), tokens: int(s?.tokens) })).filter((s) => s.name).sort(bySize),
    agents: list(response.agents).map((a) => ({ name: text(a?.agentType), source: source(a?.source), tokens: int(a?.tokens) })).filter((a) => a.name).sort(bySize),
    messages: messages.length ? messages : null
  };
}

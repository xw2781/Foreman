import { describe, expect, it } from 'vitest';
import { parseContextUsage } from '../src/main/chat/contextUsage';

// Trimmed from a real `get_context_usage` reply (Claude Code 2.1.316, detail 'summary').
const REPLY = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 2498, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 13411, color: 'inactive', kind: 'used' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 833, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'mcp_instructions', name: 'MCP server instructions', tokens: 631, color: 'green_FOR_SUBAGENTS_ONLY', kind: 'used' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 1980, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 22218, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'skills', name: 'Skills', tokens: 5360, color: 'warning', kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 900, color: 'purple', kind: 'used' },
    { id: 'something_new', name: 'Something new', tokens: 10, color: 'x', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'inactive', kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 943357, color: 'promptBorder', kind: 'free' }
  ],
  totalTokens: 23643,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  percentage: 2,
  model: 'claude-opus-5-5',
  memoryFiles: [{ path: 'C:\repo\CLAUDE.md', type: 'Project', tokens: 1200 }],
  mcpTools: [
    { name: 'mcp__claude_ai_Claude_Docs__batch', serverName: 'claude_ai_Claude_Docs', tokens: 205, isLoaded: true },
    { name: 'mcp__claude_ai_Claude_Docs__create', serverName: 'claude_ai_Claude_Docs', tokens: 317, isLoaded: false },
    { name: 'mcp__foreman_browser__navigate', serverName: 'foreman_browser', tokens: 300 },
    { name: 'mcp__foreman_browser__click', serverName: 'foreman_browser', tokens: 328 }
  ],
  agents: [],
  skills: { totalSkills: 2, includedSkills: 2, tokens: 718, skillFrontmatter: [{ name: 'update-config', source: 'built-in', tokens: 236 }, { name: 'dataviz', source: 'syncedSkills', tokens: 482 }] },
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  messageBreakdown: { toolCallTokens: 100, toolResultTokens: 300, attachmentTokens: 0, assistantMessageTokens: 200, userMessageTokens: 250, redirectedContextTokens: 0, unattributedTokens: 50, toolCallsByType: [], attachmentsByType: [] },
  apiUsage: null
};

describe('context usage', () => {
  it('folds the categories into parts in a fixed order, apart from free, buffer and deferred', () => {
    const usage = parseContextUsage(REPLY)!;
    expect(usage.parts).toEqual([
      { part: 'system', label: 'System prompt', tokens: 2498 },
      { part: 'tools', label: 'System tools', tokens: 13411 },
      { part: 'mcp', label: 'MCP tools', tokens: 1464 },
      { part: 'skills', label: 'Skills & agents', tokens: 5360 },
      { part: 'messages', label: 'Messages', tokens: 900 },
      { part: 'other', label: 'Other', tokens: 10 }
    ]);
    expect(usage).toMatchObject({ model: 'claude-opus-5-5', usedTokens: 23643, windowTokens: 1000000, bufferTokens: 33000, freeTokens: 943357, deferredTokens: 24198, autoCompactAt: 967000 });
  });

  it('lists what is behind the parts, largest first', () => {
    const usage = parseContextUsage(REPLY)!;
    expect(usage.mcpServers).toEqual([
      { name: 'foreman_browser', tools: 2, tokens: 628 },
      { name: 'Claude Docs', tools: 1, tokens: 205 }
    ]);
    expect(usage.skills.map((s) => `${s.name} (${s.source})`)).toEqual(['dataviz (synced)', 'update-config (built-in)']);
    expect(usage.memoryFiles).toEqual([{ path: 'C:\repo\CLAUDE.md', tokens: 1200 }]);
    expect(usage.messages).toEqual([
      { label: 'Your messages', tokens: 250 },
      { label: "Claude's replies", tokens: 200 },
      { label: 'Tool calls', tokens: 100 },
      { label: 'Tool results', tokens: 300 },
      { label: 'Other', tokens: 50 }
    ]);
  });

  it('reports auto-compact off, and nothing for a reply it cannot read', () => {
    expect(parseContextUsage({ ...REPLY, isAutoCompactEnabled: false })!.autoCompactAt).toBeNull();
    expect(parseContextUsage(null)).toBeNull();
    expect(parseContextUsage({ categories: [] })).toBeNull();
  });
});

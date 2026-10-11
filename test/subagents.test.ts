import { describe, expect, it } from 'vitest';
import { SubagentTracker, settleSubagents } from '../src/main/subagents';
import { runningSubagents, subagentTree } from '../src/shared/subagents';
import type { SubagentInfo } from '../src/shared/types';

function clock() {
  let t = Date.parse('2026-10-07T10:00:00Z');
  return () => new Date((t += 1000)).toISOString();
}

function tracker() {
  let changes = 0;
  const t = new SubagentTracker([], () => changes++, clock());
  return { t, changes: () => changes };
}

const agentCall = (id: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input }] }
});

const toolCall = (parent: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: `m-${Math.random()}`, content: [{ type: 'tool_use', id: `t-${Math.random()}`, name, input }] }
});

const toolResult = (id: string, text: string, meta?: Record<string, unknown>, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] },
  ...(meta ? { tool_use_result: meta } : {})
});

describe('SubagentTracker: Claude Code stream', () => {
  it('follows a subagent from its tool call to its result', () => {
    const { t, changes } = tracker();
    t.claude(agentCall('toolu_1', { subagent_type: 'Explore', description: 'Find the parser', prompt: 'Look for JSONL parsing' }));
    expect(t.list()).toMatchObject([{ id: 'toolu_1', parentId: null, kind: 'Explore', description: 'Find the parser', status: 'running', background: false }]);
    expect(t.running).toBe(1);

    t.claude(toolCall('toolu_1', 'Grep', { pattern: 'JSON.parse' }));
    t.claude(toolCall('toolu_1', 'Read', { file_path: 'C:\\repo\\src\\main\\telemetry\\jsonl.ts' }));
    expect(t.list()[0]).toMatchObject({ toolUses: 2, activity: 'Read jsonl.ts' });

    t.claude(toolResult('toolu_1', 'It is in jsonl.ts', { status: 'completed', totalTokens: 12_345, totalToolUseCount: 2, totalDurationMs: 8000 }));
    expect(t.list()[0]).toMatchObject({ status: 'done', activity: null, tokens: 12_345, durationMs: 8000, result: 'It is in jsonl.ts' });
    expect(t.running).toBe(0);
    expect(changes()).toBeGreaterThan(0);
  });

  it('nests a subagent started by another subagent', () => {
    const { t } = tracker();
    t.claude(agentCall('outer', { subagent_type: 'general-purpose', description: 'Plan' }));
    t.claude(agentCall('inner', { subagent_type: 'Explore', description: 'Search' }, 'outer'));
    expect(t.list().map((n) => [n.id, n.parentId])).toEqual([['outer', null], ['inner', 'outer']]);
  });

  it('marks a failed subagent', () => {
    const { t } = tracker();
    t.claude(agentCall('toolu_2', { description: 'Break' }));
    t.claude(toolResult('toolu_2', 'Agent crashed', undefined, true));
    expect(t.list()[0]).toMatchObject({ status: 'failed', kind: 'general-purpose' });
  });

  it('keeps a background agent running past its launch, until its task notification', () => {
    const { t } = tracker();
    t.claude(agentCall('bg', { description: 'Watch tests', run_in_background: true }));
    t.claude(toolResult('bg', 'Async agent launched', { status: 'async_launched' }));
    t.claude({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'bg', description: 'Watch tests' });
    t.claude({ type: 'result', subtype: 'success' });
    expect(t.list()[0]).toMatchObject({ status: 'running', background: true });

    t.claude({ type: 'system', subtype: 'task_progress', task_id: 'task-1', last_tool_name: 'Bash', usage: { total_tokens: 900, tool_uses: 3, duration_ms: 4000 } });
    expect(t.list()[0]).toMatchObject({ activity: 'Ran', tokens: 900, toolUses: 3 });

    t.claude({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'All green', usage: { total_tokens: 1500, tool_uses: 5, duration_ms: 9000 } });
    expect(t.list()[0]).toMatchObject({ status: 'done', result: 'All green', tokens: 1500, durationMs: 9000 });
  });

  it('stops foreground subagents when the turn ends without their result', () => {
    const { t } = tracker();
    t.claude(agentCall('fg', { description: 'Long job' }));
    t.claude({ type: 'result', subtype: 'error_during_execution' });
    expect(t.list()[0].status).toBe('stopped');
  });
});

describe('SubagentTracker: Claude Code hooks', () => {
  it('tracks Agent tool calls from PreToolUse and PostToolUse', () => {
    const { t } = tracker();
    t.claudeHook('PreToolUse', { tool_name: 'Task', tool_use_id: 'h1', tool_input: { subagent_type: 'Explore', description: 'Scan' } });
    t.claudeHook('PreToolUse', { tool_name: 'Glob', agent_type: 'Explore', tool_input: { pattern: '**/*.ts' } });
    expect(t.list()[0]).toMatchObject({ status: 'running', toolUses: 1, activity: 'Listed files **/*.ts' });
    t.claudeHook('PostToolUse', { tool_name: 'Task', tool_use_id: 'h1', tool_response: { status: 'completed', content: [{ type: 'text', text: 'Found 3' }], totalTokens: 400 } });
    expect(t.list()[0]).toMatchObject({ status: 'done', result: 'Found 3', tokens: 400 });
  });

  it('finishes a lone background agent on SubagentStop', () => {
    const { t } = tracker();
    t.claudeHook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'h2', tool_input: { description: 'Bg', run_in_background: true } });
    t.claudeHook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'h2', tool_response: { status: 'async_launched' } });
    t.claudeHook('UserPromptSubmit', {});
    expect(t.list()[0].status).toBe('running');
    t.claudeHook('SubagentStop', { agent_id: 'a1' });
    expect(t.list()[0].status).toBe('done');
  });
});

describe('SubagentTracker: Codex', () => {
  it('maps spawned threads and follows their notifications', () => {
    const { t } = tracker();
    const item = (status: string, states: Record<string, unknown>) => ({
      item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status, senderThreadId: 'root', receiverThreadIds: ['child'], prompt: 'Check the tests\nthen report', agentsStates: states }
    });
    t.codex('item/started', item('inProgress', {}), 'root');
    t.codex('item/completed', item('completed', { child: { status: 'running', message: null } }), 'root');
    expect(t.list()).toMatchObject([{ id: 'child', parentId: null, description: 'Check the tests', status: 'running', background: true }]);

    t.codex('item/started', { threadId: 'child', item: { type: 'commandExecution', id: 'x', command: 'npm test', status: 'inProgress' } }, 'root');
    expect(t.list()[0].toolUses).toBe(1);
    expect(t.list()[0].activity).toContain('npm test');

    // Notifications of the agent's own thread aren't the child's.
    t.codex('turn/completed', { threadId: 'root', turn: { status: 'completed' } }, 'root');
    expect(t.list()[0].status).toBe('running');

    t.codex('item/completed', { threadId: 'child', item: { type: 'agentMessage', id: 'y', text: 'Tests pass' } }, 'root');
    t.codex('turn/completed', { threadId: 'child', turn: { status: 'completed' } }, 'root');
    expect(t.list()[0]).toMatchObject({ status: 'done', result: 'Tests pass' });
  });

  it('nests grandchildren and reads agent states from wait calls', () => {
    const { t } = tracker();
    const spawn = (sender: string, receiver: string) => ({ item: { type: 'collabAgentToolCall', tool: 'spawn_agent', senderThreadId: sender, receiverThreadIds: [receiver], agentsStates: {} } });
    t.codex('item/completed', spawn('root', 'a'), 'root');
    t.codex('item/completed', spawn('a', 'b'), 'root');
    expect(t.list().map((n) => [n.id, n.parentId])).toEqual([['a', null], ['b', 'a']]);
    t.codex('item/completed', { item: { type: 'collabAgentToolCall', tool: 'wait', senderThreadId: 'root', receiverThreadIds: ['a', 'b'], agentsStates: { a: { status: 'completed', message: 'ok' }, b: { status: 'errored', message: 'boom' } } } }, 'root');
    expect(t.list().map((n) => n.status)).toEqual(['done', 'failed']);
  });
});

describe('settling and the tree', () => {
  const node = (id: string, parentId: string | null, status: SubagentInfo['status']): SubagentInfo => ({
    id, parentId, kind: 'Explore', description: null, prompt: null, model: null, status, background: false,
    startedAt: '2026-10-07T10:00:00Z', endedAt: null, activity: status === 'running' ? 'Read x' : null, toolUses: 0, tokens: null, durationMs: null, result: null
  });

  it('stops whatever was still running', () => {
    const settled = settleSubagents([node('a', null, 'running'), node('b', null, 'done')], '2026-10-07T11:00:00Z');
    expect(settled.map((n) => [n.status, n.endedAt, n.activity])).toEqual([['stopped', '2026-10-07T11:00:00Z', null], ['done', null, null]]);
    // Restored history comes back settled.
    expect(new SubagentTracker([node('c', null, 'running')]).running).toBe(0);
  });

  it('lifts running children of hidden parents to the nearest visible ancestor', () => {
    const nodes = [node('a', null, 'running'), node('b', 'a', 'done'), node('c', 'b', 'running'), node('d', 'gone', 'running')];
    const all = subagentTree(nodes);
    expect(all.map((b) => b.node.id)).toEqual(['a', 'd']);
    expect(all[0].children[0].children[0].node.id).toBe('c');
    const live = subagentTree(nodes, (n) => n.status === 'running');
    expect(live.map((b) => [b.node.id, b.children.map((c) => c.node.id)])).toEqual([['a', ['c']], ['d', []]]);
    expect(runningSubagents({ subagents: nodes })).toBe(3);
  });

  it('survives a parent cycle', () => {
    const tree = subagentTree([node('a', 'b', 'running'), node('b', 'a', 'done')], (n) => n.status === 'running');
    expect(tree.map((b) => b.node.id)).toEqual(['a']);
  });
});

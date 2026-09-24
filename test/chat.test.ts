import { describe, expect, it } from 'vitest';
import { ChatLog } from '../src/main/chat/log';
import { ClaudeChat, claudeChatArgs } from '../src/main/chat/claudeChat';
import { CodexChat } from '../src/main/chat/codexChat';
import { codexCommand, codexItemEntry } from '../src/main/chat/codexItems';
import { claudeHistory, codexHistory } from '../src/main/chat/history';
import type { ChatHost } from '../src/main/chat/driver';
import type { ChatItem } from '../src/shared/types';

function fakeHost() {
  const log = new ChatLog();
  const statuses: Array<[string, string | null | undefined]> = [];
  const sessions: Array<Record<string, unknown>> = [];
  let turns = 0;
  const host: ChatHost = {
    log,
    changed: () => {},
    status: (status, detail) => statuses.push([status, detail]),
    session: (info) => sessions.push(info),
    turnComplete: () => {
      turns += 1;
    },
    limits: () => {}
  };
  return { host, log, statuses, sessions, turns: () => turns };
}

const kinds = (items: ChatItem[]) => items.map((i) => i.kind);

describe('chat log', () => {
  it('keeps each item in place and bumps its revision on change', () => {
    const log = new ChatLog();
    const first = log.upsert({ kind: 'user', id: 'u', text: 'hi' });
    log.upsert({ kind: 'assistant', id: 'a', text: 'he', streaming: true });
    const updated = log.upsert({ kind: 'assistant', id: 'a', text: 'hello', streaming: false });
    expect(log.list().map((i) => i.id)).toEqual(['u', 'a']);
    expect(updated.seq).toBe(2);
    expect(updated.rev).toBeGreaterThan(first.rev);
    expect(log.takeDirty().map((i) => i.id).sort()).toEqual(['a', 'u']);
    expect(log.takeDirty()).toEqual([]);
  });

  it('settles whatever was in flight', () => {
    const log = new ChatLog();
    log.upsert({ kind: 'assistant', id: 'a', text: 'x', streaming: true });
    log.upsert({ kind: 'tool', id: 't', tool: 'Bash', title: 'Ran', detail: null, input: null, output: null, status: 'running', files: null, durationMs: null });
    log.settle('Stopped');
    const [a, t] = log.list();
    expect(a.kind === 'assistant' && a.streaming).toBe(false);
    expect(t.kind === 'tool' && t.status).toBe('error');
  });
});

describe('Claude chat protocol', () => {
  it('builds the SDK command line', () => {
    expect(claudeChatArgs({ sessionId: 's-1', model: 'opus', permission: 'plan' })).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--session-id', 's-1', '--model', 'opus', '--permission-mode', 'plan'
    ]);
    expect(claudeChatArgs({ sessionId: null, resumeSessionId: 'old' })).toContain('--resume');
  });

  // Recorded from claude.exe 2.1.280 (trimmed).
  const turn = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku-4-5-20251001', permissionMode: 'default' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: '', signature: 'x' }] } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "echo hello"}' } } },
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hello', description: 'Print hello' } }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'hello', is_error: false }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The command' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' ran.' } } },
    { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'The command ran.' }] } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 7048, total_cost_usd: 0.022, uuid: 'r1' }
  ];

  it('turns a turn into user, tool, reply and footer items', () => {
    const { host, log, statuses, sessions, turns } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.send('run echo hello');
    expect(sent[0]).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run echo hello' }] }, parent_tool_use_id: null });
    for (const event of turn) chat.receive(JSON.stringify(event));
    const items = log.list();
    expect(kinds(items)).toEqual(['user', 'tool', 'assistant', 'turn']);
    const tool = items[1];
    expect(tool.kind === 'tool' && [tool.title, tool.detail, tool.input, tool.output, tool.status]).toEqual(['Ran', 'echo hello', 'echo hello', 'hello', 'done']);
    const reply = items[2];
    expect(reply.kind === 'assistant' && [reply.text, reply.streaming]).toEqual(['The command ran.', false]);
    const footer = items[3];
    expect(footer.kind === 'turn' && [footer.ok, footer.durationMs, footer.costUsd]).toEqual([true, 7048, 0.022]);
    expect(sessions[0]).toMatchObject({ sessionId: 'sess-1', model: 'claude-haiku-4-5-20251001' });
    expect(statuses.at(-1)).toEqual(['idle', 'Turn complete']);
    expect(turns()).toBe(1);
    expect(chat.busy).toBe(false);
  });

  it('shows streamed text before the block completes', () => {
    const { host, log } = fakeHost();
    const chat = new ClaudeChat(host, () => {});
    for (const event of turn.slice(8, 11)) chat.receive(JSON.stringify(event));
    const [item] = log.list();
    expect(item.kind === 'assistant' && [item.text, item.streaming]).toEqual(['The command', true]);
  });

  it('asks for permission and answers with the chosen decision', () => {
    const { host, log, statuses } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.receive(JSON.stringify({
      type: 'control_request',
      request_id: 'req-9',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { file_path: 'C:\\t\\a.txt', content: 'hi' },
        description: 'a.txt',
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        tool_use_id: 'toolu_9'
      }
    }));
    const approval = log.get('approval-req-9');
    expect(approval?.kind).toBe('approval');
    if (approval?.kind !== 'approval') return;
    expect(approval.options.map((o) => o.label)).toEqual(['Allow', 'Allow all edits this session', 'Deny']);
    expect(approval.files?.[0]).toMatchObject({ path: 'C:\\t\\a.txt', kind: 'add', diff: '+hi' });
    expect(statuses.at(-1)?.[0]).toBe('needs-input');

    chat.respond('approval-req-9', { optionId: 'deny', message: 'use b.txt' });
    expect(sent.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'req-9', response: { behavior: 'deny', message: 'use b.txt' } } });
    const resolved = log.get('approval-req-9');
    expect(resolved?.kind === 'approval' && [resolved.state, resolved.resolution]).toEqual(['resolved', 'Denied — use b.txt']);
  });

  it('passes the suggested rule along with "always allow"', () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
    chat.receive(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: suggestions } }));
    chat.respond('approval-r', { optionId: 'allow-always' });
    expect(sent.at(-1).response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: suggestions });
  });

  it("answers Claude's questions through the tool input", () => {
    const { host, log } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    const input = { questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] };
    chat.receive(JSON.stringify({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }));
    const item = log.get('approval-q');
    expect(item?.kind === 'approval' && item.questions?.[0].options.map((o) => o.label)).toEqual(['Postgres', 'SQLite']);
    chat.respond('approval-q', { optionId: 'answer', answers: { 'Which DB?': 'SQLite' } });
    expect(sent.at(-1).response.response).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which DB?': 'SQLite' } } });
  });

  it('refuses control requests it does not implement instead of hanging', () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    new ClaudeChat(host, (m) => sent.push(m)).receive(JSON.stringify({ type: 'control_request', request_id: 'h', request: { subtype: 'hook_callback' } }));
    expect(sent[0]).toMatchObject({ type: 'control_response', response: { subtype: 'error', request_id: 'h' } });
  });

  it('ignores subagent traffic', () => {
    const { host, log } = fakeHost();
    const chat = new ClaudeChat(host, () => {});
    chat.receive(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_task', message: { id: 'm', content: [{ type: 'text', text: 'inner' }] } }));
    expect(log.size).toBe(0);
  });
});

describe('Codex chat protocol', () => {
  function started() {
    const { host, log, statuses, sessions } = fakeHost();
    const sent: any[] = [];
    const chat = new CodexChat(host, (m) => sent.push(m), { cwd: 'C:\\r', permission: 'auto', appVersion: '0.1.0' });
    const ready = chat.start();
    return { chat, host, log, statuses, sessions, sent, ready };
  }

  it('initializes, starts a thread and runs a turn', async () => {
    const { chat, log, sent, sessions, statuses, ready } = started();
    expect(sent[0]).toMatchObject({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_task_center' } } });
    chat.receive(JSON.stringify({ id: 1, result: { userAgent: 'x' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent[1]).toEqual({ method: 'initialized' });
    expect(sent[2]).toMatchObject({ method: 'thread/start', params: { cwd: 'C:\\r', approvalPolicy: 'on-request', sandbox: 'workspace-write' } });
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: 'C:\\rollout.jsonl' }, model: 'gpt-6-astra' } }));
    await ready;
    expect(sessions[0]).toEqual({ sessionId: 'th-1', transcriptPath: 'C:\\rollout.jsonl', model: 'gpt-6-astra' });

    chat.send('list files');
    const turnStart = sent.at(-1);
    expect(turnStart).toMatchObject({ method: 'turn/start', params: { threadId: 'th-1', input: [{ type: 'text', text: 'list files' }] } });
    const userId = turnStart.params.clientUserMessageId;
    const notify = (method: string, params: object) => chat.receive(JSON.stringify({ method, params: { threadId: 'th-1', ...params } }));
    notify('turn/started', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });
    notify('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'srv-u', clientId: userId, content: [{ type: 'text', text: 'list files', text_elements: [] }] } });
    notify('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: '"C:\\pwsh.exe" -Command \'Get-ChildItem\'', cwd: 'C:\\r', status: 'inProgress', commandActions: [{ type: 'listFiles', command: 'Get-ChildItem', path: null }], aggregatedOutput: null, exitCode: null, durationMs: null } });
    notify('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'cmd-1', delta: 'a.txt\n' });
    notify('item/completed', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'Get-ChildItem', status: 'completed', commandActions: [], aggregatedOutput: 'a.txt\nb.txt\n', exitCode: 0, durationMs: 1200 } });
    notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: 'Two ' });
    notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: 'files.' });
    notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text: 'Two files.', phase: null } });
    notify('turn/completed', { turn: { id: 'turn-1', items: [], status: 'completed', durationMs: 3000 } });

    const items = log.list();
    expect(kinds(items)).toEqual(['user', 'tool', 'assistant', 'turn']);
    expect(items[0].id).toBe(userId);
    const tool = items[1];
    expect(tool.kind === 'tool' && [tool.detail, tool.output, tool.status, tool.durationMs]).toEqual(['Get-ChildItem', 'a.txt\nb.txt\n', 'done', 1200]);
    expect(items[2].kind === 'assistant' && items[2].text).toBe('Two files.');
    expect(statuses.at(-1)).toEqual(['idle', 'Turn complete']);
    expect(chat.busy).toBe(false);
  });

  it('turns an approval request into a card and replies with the decision', async () => {
    const { chat, log, sent, ready } = started();
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'm' } }));
    await ready;
    chat.receive(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', turnId: 't', itemId: 'cmd-2', command: 'rm -rf build', reason: 'Needs write access' } }));
    const card = log.get('approval-77');
    expect(card?.kind === 'approval' && [card.body, card.detail, card.options.map((o) => o.id)]).toEqual(['rm -rf build', 'Needs write access', ['allow', 'allow-session', 'deny', 'cancel']]);
    chat.respond('approval-77', { optionId: 'allow-session' });
    expect(sent.at(-1)).toEqual({ id: 77, result: { decision: 'acceptForSession' } });
  });

  it('answers unsupported server requests with an error', () => {
    const { chat, sent } = started();
    chat.receive(JSON.stringify({ id: 5, method: 'account/chatgptAuthTokens/refresh', params: {} }));
    expect(sent.at(-1)).toMatchObject({ id: 5, error: { code: -32601 } });
  });
});

describe('Codex items', () => {
  it('reads rollout (PascalCase, snake_case) and live (camelCase) shapes alike', () => {
    const rollout = codexItemEntry({
      type: 'CommandExecution',
      id: 'exec-1',
      command: ['C:\\runtime\\pwsh.exe', '-Command', 'Get-Content -LiteralPath AGENTS.md'],
      parsed_cmd: [{ type: 'read', cmd: 'Get-Content AGENTS.md', name: 'AGENTS.md', path: 'AGENTS.md' }],
      aggregated_output: '# Agents',
      exit_code: 0,
      status: 'completed'
    });
    expect(rollout).toMatchObject({ kind: 'tool', title: 'Read', detail: 'AGENTS.md', input: 'Get-Content -LiteralPath AGENTS.md', output: '# Agents', status: 'done' });
    const failed = codexItemEntry({ type: 'commandExecution', id: 'c', command: 'npm test', status: 'completed', exitCode: 1, aggregatedOutput: 'fail' });
    expect(failed).toMatchObject({ status: 'error', title: 'Ran', detail: 'npm test' });
  });

  it('turns rollout file changes into diffs', () => {
    const entry = codexItemEntry({
      type: 'FileChange',
      id: 'fc',
      changes: { 'C:\\r\\new.txt': { type: 'add', content: 'a\nb' }, 'C:\\r\\old.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y', move_path: null } },
      status: 'completed'
    });
    expect(entry).toMatchObject({ kind: 'tool', title: 'Edited', detail: 'new.txt, old.txt' });
    if (entry?.kind !== 'tool') return;
    expect(entry.files).toEqual([
      { path: 'C:\\r\\new.txt', kind: 'add', diff: '+a\n+b' },
      { path: 'C:\\r\\old.txt', kind: 'update', diff: '@@ -1 +1 @@\n-x\n+y' }
    ]);
  });

  it('strips the shell wrapper from commands', () => {
    expect(codexCommand(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status'`)).toBe('git status');
    expect(codexCommand(['bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(codexCommand('git log')).toBe('git log');
  });
});

describe('conversation history', () => {
  it('rebuilds a Claude transcript', () => {
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-23T10:00:00Z', message: { role: 'user', content: 'Fix the build' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\r\\x.ts', old_string: 'a', new_string: 'b' } }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'text', text: 'Fixed.' }] } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>sonnet</command-args>' } },
      { type: 'user', uuid: 'u4', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'assistant', uuid: 'side', isSidechain: true, message: { id: 'm3', content: [{ type: 'text', text: 'subagent' }] } }
    ].map((l) => JSON.stringify(l));
    const history = claudeHistory(lines);
    expect(history.map((h) => h.entry.kind)).toEqual(['user', 'tool', 'assistant', 'user']);
    expect(history[0]).toMatchObject({ at: '2026-09-23T10:00:00Z', entry: { text: 'Fix the build' } });
    expect(history[1].entry).toMatchObject({ title: 'Edited', detail: 'x.ts', output: 'ok', status: 'done', files: [{ diff: '-a\n+b' }] });
    expect(history[3].entry).toMatchObject({ text: '/model sonnet' });
  });

  it('rebuilds a Codex rollout, preferring item events', () => {
    const lines = [
      { type: 'event_msg', timestamp: 't0', payload: { type: 'user_message', message: 'hi' } },
      { type: 'event_msg', timestamp: 't1', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'event_msg', timestamp: 't2', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'Hello!' }] } } },
      { type: 'event_msg', timestamp: 't3', payload: { type: 'turn_aborted', turn_id: 'x' } }
    ].map((l) => JSON.stringify(l));
    const history = codexHistory(lines);
    expect(history.map((h) => [h.entry.kind, (h.entry as any).text])).toEqual([['user', 'hi'], ['assistant', 'Hello!'], ['notice', 'Interrupted']]);
    const legacy = codexHistory([JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'old' } })]);
    expect(legacy.map((h) => h.entry.kind)).toEqual(['user']);
  });

  it('keeps only the most recent entries of a long conversation', () => {
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `m${i}` } }));
    const history = claudeHistory(lines, 10);
    expect(history).toHaveLength(11);
    expect(history[0].entry.kind).toBe('notice');
    expect(history.at(-1)?.entry).toMatchObject({ text: 'm29' });
  });
});

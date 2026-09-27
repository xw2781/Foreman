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
  const requeued: string[] = [];
  const host: ChatHost = {
    log,
    changed: () => {},
    status: (status, detail) => statuses.push([status, detail]),
    session: (info) => sessions.push(info),
    turnComplete: () => {
      turns += 1;
    },
    limits: () => {},
    requeue: (id) => {
      requeued.push(id);
      log.update(id, 'user', () => ({ delivery: 'queued' }));
    }
  };
  return { host, log, statuses, sessions, requeued, turns: () => turns };
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

  // Lifecycle reports as claude.exe 2.1.280 sends them: queued on arrival, started when a turn takes the message in.
  const lifecycle = (uuid: string, state: string) => ({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `ev-${uuid}-${state}`, session_id: 'sess-1' });

  it('steers a running turn and shows when Claude takes the message in', () => {
    const { host, log, statuses } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.send('run echo hello');
    const first = sent[0].uuid;
    expect(log.get(first)).toMatchObject({ kind: 'user', text: 'run echo hello' });
    chat.receive(JSON.stringify(lifecycle(first, 'queued')));
    chat.receive(JSON.stringify(lifecycle(first, 'started')));
    for (const event of turn.slice(0, 8)) chat.receive(JSON.stringify(event));

    expect(chat.canSteer('also say banana')).toBe(true);
    chat.send('also say banana');
    const steer = sent.at(-1);
    expect(steer).toMatchObject({ type: 'user', message: { content: [{ type: 'text', text: 'also say banana' }] } });
    expect(steer.priority).toBeUndefined();
    expect(log.get(steer.uuid)).toMatchObject({ kind: 'user', delivery: 'steering' });
    chat.receive(JSON.stringify(lifecycle(steer.uuid, 'queued')));
    expect(log.get(steer.uuid)).toMatchObject({ delivery: 'steering' });
    chat.receive(JSON.stringify(lifecycle(steer.uuid, 'started')));
    expect(log.get(steer.uuid)).toMatchObject({ delivery: 'steered' });

    for (const event of turn.slice(8)) chat.receive(JSON.stringify(event));
    expect(kinds(log.list())).toEqual(['user', 'tool', 'user', 'assistant', 'turn']);
    expect(statuses.at(-1)).toEqual(['idle', 'Turn complete']);
    expect(chat.busy).toBe(false);
  });

  it('lets a steer that missed the turn start the next one', () => {
    const { host, log, statuses } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.send('run echo hello');
    chat.receive(JSON.stringify(lifecycle(sent[0].uuid, 'started')));
    chat.send('and then list files');
    const late = sent.at(-1).uuid;
    for (const event of turn) chat.receive(JSON.stringify(event));
    // The turn ended first: the CLI runs the message next, so the chat stays busy.
    expect(chat.busy).toBe(true);
    expect(statuses.at(-1)).toEqual(['working', 'Thinking']);
    chat.receive(JSON.stringify(lifecycle(late, 'started')));
    const items = log.list();
    expect(items.at(-1)).toMatchObject({ id: late, kind: 'user' });
    expect(items.at(-1)).not.toHaveProperty('delivery', 'steering');
    expect(kinds(items)).toEqual(['user', 'tool', 'assistant', 'turn', 'user']);
  });

  it('requeues a steer the CLI dropped', () => {
    const { host, log, statuses, requeued } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.send('go');
    chat.receive(JSON.stringify(lifecycle(sent[0].uuid, 'started')));
    chat.send('actually wait');
    const steer = sent.at(-1).uuid;
    chat.interrupt();
    chat.receive(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'r1' }));
    chat.receive(JSON.stringify(lifecycle(steer, 'cancelled')));
    expect(requeued).toEqual([steer]);
    expect(log.get(steer)).toMatchObject({ delivery: 'queued' });
    expect(chat.busy).toBe(false);
    expect(statuses.at(-1)).toEqual(['idle', null]);
  });

  it('assumes steers went in when the CLI reports no lifecycle', () => {
    const { host, log } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    chat.send('go');
    chat.send('more');
    for (const event of turn) chat.receive(JSON.stringify(event));
    expect(log.get(sent[1].uuid)).toMatchObject({ delivery: 'steered' });
    expect(chat.busy).toBe(false);
  });

  it('keeps slash commands out of a running turn', () => {
    const { host } = fakeHost();
    const chat = new ClaudeChat(host, () => {});
    // Before the command list arrives, anything command-like waits.
    expect(chat.canSteer('/tmp/log has it')).toBe(false);
    chat.receive(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['compact', 'review'] }));
    expect(chat.canSteer('/compact')).toBe(false);
    expect(chat.canSteer('/tmp/log has it')).toBe(true);
    expect(chat.canSteer('use the other file')).toBe(true);
  });

  it('asks the CLI to title the session and renames it', async () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    const title = chat.generateTitle('fix the flaky upload test');
    const request = sent.at(-1);
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'generate_session_title', description: 'fix the flaky upload test', persist: true } });
    chat.receive(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { title: 'Fix flaky upload test' } } }));
    await expect(title).resolves.toBe('Fix flaky upload test');

    const failed = chat.generateTitle('x');
    chat.receive(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: sent.at(-1).request_id, error: 'nope' } }));
    await expect(failed).resolves.toBeNull();

    chat.rename('Upload tests');
    expect(sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'rename_session', title: 'Upload tests' } });

    chat.configure({ effort: 'xhigh' });
    expect(sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh' } } });
  });

  it('lists slash commands and skills from the initialize reply', async () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    await chat.start('hi');
    expect(sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    expect(sent[1]).toMatchObject({ type: 'user' });
    const commands = chat.commands();
    // Recorded from claude.exe 2.1.280 (trimmed).
    chat.receive(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', skills: ['simplify', 'anthropic-skills:pdf'], terminal_slash_commands: ['color'] }));
    chat.receive(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: sent[0].request_id,
          response: {
            commands: [
              { name: 'simplify', description: 'Review the changed code', argumentHint: '[<target>]', builtin: true },
              { name: 'compact', description: 'Free up context', argumentHint: '<optional custom summarization instructions>', builtin: true },
              { name: 'usage', description: 'Show session cost', argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
              { name: 'color', description: 'Set the prompt bar color', argumentHint: '[red|blue]', builtin: true },
              { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
              { name: 'anthropic-skills:pdf', description: 'PDF files', argumentHint: '', aliases: ['pdf'] }
            ]
          }
        }
      })
    );
    expect(await commands).toEqual([
      { name: 'simplify', trigger: '/', kind: 'skill', description: 'Review the changed code', argumentHint: '[<target>]', aliases: [] },
      { name: 'compact', trigger: '/', kind: 'command', description: 'Free up context', argumentHint: '<optional custom summarization instructions>', aliases: [] },
      { name: 'usage', trigger: '/', kind: 'command', description: 'Show session cost', argumentHint: null, aliases: ['cost', 'stats'] },
      { name: 'anthropic-skills:pdf', trigger: '/', kind: 'skill', description: 'PDF files', argumentHint: null, aliases: ['pdf'] }
    ]);
  });

  it('falls back to the init event names when initialize is refused', async () => {
    const { host } = fakeHost();
    const sent: any[] = [];
    const chat = new ClaudeChat(host, (m) => sent.push(m));
    await chat.start();
    chat.receive(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: sent[0].request_id, error: 'Unknown request' } }));
    chat.receive(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['compact', 'review'], skills: ['review'] }));
    expect((await chat.commands()).map((c) => [c.name, c.kind])).toEqual([
      ['compact', 'command'],
      ['review', 'skill']
    ]);
  });

  it("shows the CLI's warnings, such as a refused model", () => {
    const { host, log } = fakeHost();
    const chat = new ClaudeChat(host, () => {});
    const text = `Model "claude-haiku-4-5" is restricted by your organization's settings. Using claude-opus-5-5[1m] instead.`;
    chat.receive(JSON.stringify({ type: 'system', subtype: 'informational', level: 'warning', content: text, uuid: 'w1' }));
    const [notice] = log.list();
    expect(notice.kind === 'notice' && [notice.tone, notice.text]).toEqual(['warning', text]);
  });

  it('says so when the CLI starts in another permission mode than asked', () => {
    const { host, log } = fakeHost();
    const chat = new ClaudeChat(host, () => {}, 'auto');
    chat.receive(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-4-5-20251001', permissionMode: 'default' }));
    chat.receive(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-4-5-20251001', permissionMode: 'default' }));
    expect(log.list().map((i) => i.kind === 'notice' && i.tone)).toEqual(['warning']);
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
    const { host, log, statuses, sessions, requeued } = fakeHost();
    const sent: any[] = [];
    const chat = new CodexChat(host, (m) => sent.push(m), { cwd: 'C:\\r', permission: 'auto', appVersion: '0.1.0' });
    const ready = chat.start();
    return { chat, host, log, statuses, sessions, sent, ready, requeued };
  }

  async function running() {
    const context = started();
    const { chat, sent, ready } = context;
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'm' } }));
    await ready;
    const notify = (method: string, params: object) => chat.receive(JSON.stringify({ method, params: { threadId: 'th-1', ...params } }));
    return { ...context, notify };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('initializes, starts a thread and runs a turn', async () => {
    const { chat, log, sent, sessions, statuses, ready } = started();
    expect(sent[0]).toMatchObject({ id: 1, method: 'initialize', params: { clientInfo: { name: 'foreman' } } });
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

  it('saves a rename into the thread', async () => {
    const { chat, sent, ready } = started();
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'm' } }));
    await ready;
    chat.rename('Release notes');
    expect(sent.at(-1)).toMatchObject({ method: 'thread/name/set', params: { threadId: 'th-1', name: 'Release notes' } });
  });

  it('lets the auto-reviewer approve, and prices each turn from its token usage', async () => {
    const { host, log } = fakeHost();
    const sent: any[] = [];
    const chat = new CodexChat(host, (m) => sent.push(m), { cwd: 'C:\\r', permission: 'approve-for-me', appVersion: '0.1.0' });
    const ready = chat.start();
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent[2]).toMatchObject({ method: 'thread/start', params: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' } });
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'gpt-6-sol' } }));
    await ready;

    const notify = (method: string, params: object) => chat.receive(JSON.stringify({ method, params: { threadId: 'th-1', ...params } }));
    const usage = (input: number, cached: number, output: number) => ({ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
    // gpt-6-sol: $2 input, $0.20 cached, $10 output per 1M tokens.
    notify('turn/started', { turn: { id: 't1' } });
    notify('thread/tokenUsage/updated', { turnId: 't1', tokenUsage: { total: usage(100_000, 0, 0), last: usage(100_000, 0, 0) } });
    notify('thread/tokenUsage/updated', { turnId: 't1', tokenUsage: { total: usage(200_000, 100_000, 10_000), last: usage(100_000, 100_000, 10_000) } });
    notify('turn/completed', { turn: { id: 't1', status: 'completed' } });
    const first = log.get('turn-t1');
    expect(first?.kind === 'turn' && first.costUsd).toBeCloseTo(0.2 + 0.02 + 0.1, 6);

    // Switching to "Ask for approval" hands escalations back to the person on the next turn.
    chat.configure({ permission: 'auto' });
    chat.send('again');
    expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { approvalPolicy: 'on-request', approvalsReviewer: 'user' } });
  });

  it('offers its skills, and passes the ones a message mentions along as skill inputs', async () => {
    const { chat, sent, ready } = started();
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'm' } }));
    await ready;
    const list = sent.at(-1);
    expect(list).toMatchObject({ method: 'skills/list', params: { cwds: ['C:\\r'] } });
    // Recorded from codex 0.155.0-alpha.16.3 (trimmed).
    chat.receive(
      JSON.stringify({
        id: list.id,
        result: {
          data: [
            {
              cwd: 'C:\\r',
              errors: [],
              skills: [
                { name: 'pdf:pdf', description: 'Read, create, inspect PDF files', interface: { shortDescription: 'Read and create PDFs' }, path: 'C:\\skills\\pdf\\SKILL.md', scope: 'user', enabled: true },
                { name: 'imagegen', description: 'Generate images', path: 'C:\\skills\\imagegen\\SKILL.md', scope: 'system', enabled: true },
                { name: 'off', description: 'Disabled', path: 'C:\\skills\\off\\SKILL.md', scope: 'user', enabled: false }
              ]
            }
          ]
        }
      })
    );
    const commands = await chat.commands();
    expect(commands.map((c) => `${c.trigger}${c.name}`)).toEqual(['/compact', '/review', '$pdf:pdf', '$imagegen']);
    expect(commands[2].description).toBe('Read and create PDFs');

    chat.send('Use $pdf to summarize report.pdf, then $imagegen.');
    expect(sent.at(-1)).toMatchObject({
      method: 'turn/start',
      params: {
        input: [
          { type: 'text', text: 'Use $pdf to summarize report.pdf, then $imagegen.' },
          { type: 'skill', name: 'pdf:pdf', path: 'C:\\skills\\pdf\\SKILL.md' },
          { type: 'skill', name: 'imagegen', path: 'C:\\skills\\imagegen\\SKILL.md' }
        ]
      }
    });
  });

  it('runs /compact and /review through their own requests', async () => {
    const { chat, sent, log, statuses, ready } = started();
    chat.receive(JSON.stringify({ id: 1, result: {} }));
    await Promise.resolve();
    await Promise.resolve();
    chat.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'th-1', path: null }, model: 'm' } }));
    await ready;

    chat.send('/compact');
    expect(sent.at(-1)).toMatchObject({ method: 'thread/compact/start', params: { threadId: 'th-1' } });
    expect(log.list().at(-1)).toMatchObject({ kind: 'user', text: '/compact' });
    expect(statuses.at(-1)).toEqual(['working', 'Compacting']);
    const notify = (method: string, params: object) => chat.receive(JSON.stringify({ method, params: { threadId: 'th-1', ...params } }));
    notify('turn/started', { turn: { id: 'c1' } });
    expect(() => chat.send('/review')).toThrow(/once this turn ends/);
    notify('turn/completed', { turn: { id: 'c1', status: 'completed' } });

    chat.send('/review focus on the parser');
    expect(sent.at(-1)).toMatchObject({ method: 'review/start', params: { threadId: 'th-1', target: { type: 'custom', instructions: 'focus on the parser' }, delivery: 'inline' } });
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { turn: { id: 'r1', status: 'inProgress' }, reviewThreadId: 'th-1' } }));
    notify('turn/completed', { turn: { id: 'r1', status: 'completed' } });
    chat.send('/review');
    expect(sent.at(-1)).toMatchObject({ method: 'review/start', params: { target: { type: 'uncommittedChanges' } } });

    // Anything else starting with a slash is an ordinary message.
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { turn: { id: 'r2', status: 'completed' } } }));
    notify('turn/completed', { turn: { id: 'r2', status: 'completed' } });
    chat.send('/tmp/build.log has the error');
    expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { input: [{ type: 'text', text: '/tmp/build.log has the error' }] } });
  });

  it('steers the running turn with mid-turn messages', async () => {
    const { chat, sent, log, notify } = await running();
    chat.send('fix the parser');
    const start = sent.at(-1);
    chat.receive(JSON.stringify({ id: start.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }));
    notify('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });

    expect(chat.canSteer('and add a test')).toBe(true);
    chat.send('and add a test');
    await settle();
    const steer = sent.at(-1);
    expect(steer).toMatchObject({ method: 'turn/steer', params: { threadId: 'th-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'and add a test' }] } });
    const id = steer.params.clientUserMessageId;
    expect(log.get(id)).toMatchObject({ kind: 'user', delivery: 'steering' });
    chat.receive(JSON.stringify({ id: steer.id, result: { turnId: 'turn-1' } }));
    await settle();
    expect(log.get(id)).toMatchObject({ delivery: 'steered' });
    // Codex's own record of the message keeps it marked as a steer.
    notify('item/completed', { turnId: 'turn-1', item: { type: 'userMessage', id: 'srv-2', clientId: id, content: [{ type: 'text', text: 'and add a test' }] } });
    expect(log.get(id)).toMatchObject({ delivery: 'steered' });
  });

  it('waits for turn/start to answer before steering', async () => {
    const { chat, sent, notify } = await running();
    chat.send('first');
    const start = sent.at(-1);
    chat.send('second');
    await settle();
    expect(sent.at(-1)).toBe(start);
    chat.receive(JSON.stringify({ id: start.id, result: { turn: { id: 'turn-9', status: 'inProgress' } } }));
    await settle();
    expect(sent.at(-1)).toMatchObject({ method: 'turn/steer', params: { expectedTurnId: 'turn-9' } });
    notify('turn/completed', { turn: { id: 'turn-9', status: 'completed' } });
  });

  it('requeues a steer that arrives too late, and keeps commands out of a turn', async () => {
    const { chat, sent, log, notify, requeued } = await running();
    chat.send('go');
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }));
    expect(chat.canSteer('/compact')).toBe(false);
    chat.send('one more thing');
    await settle();
    const steer = sent.at(-1);
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    chat.receive(JSON.stringify({ id: steer.id, error: { code: -32600, message: 'expected turn turn-1 is not active' } }));
    await settle();
    const id = steer.params.clientUserMessageId;
    expect(requeued).toEqual([id]);
    expect(log.get(id)).toMatchObject({ delivery: 'queued' });

    // Compactions and reviews take no mid-turn input.
    chat.send('/compact');
    expect(chat.canSteer('keep going')).toBe(false);
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

describe('queued messages in the log', () => {
  it('moves a message to the end when it is sent, and removes one through a reset', () => {
    const log = new ChatLog();
    log.upsert({ kind: 'user', id: 'q', text: 'later', delivery: 'queued' });
    log.upsert({ kind: 'assistant', id: 'a', text: 'working', streaming: false });
    log.upsert({ kind: 'user', id: 'r', text: 'never mind', delivery: 'queued' });
    log.takeDirty();
    log.moveToEnd('q');
    expect(log.list().map((i) => i.id)).toEqual(['a', 'r', 'q']);
    expect(log.takeDirty().map((i) => i.id)).toEqual(['q']);
    log.remove('r');
    expect(log.list().map((i) => i.id)).toEqual(['a', 'q']);
    expect(log.reset).toBe(true);
  });
});

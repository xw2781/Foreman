import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeForkThrough, codexForkTurn, forkItems, forkPoint } from '../src/main/chat/fork';
import { claudeChatArgs } from '../src/main/chat/claudeChat';
import { CodexChat } from '../src/main/chat/codexChat';
import { sideChatPrompt, type ChatHost } from '../src/main/chat/driver';
import { ChatLog } from '../src/main/chat/log';
import { resolveChatWorkspace } from '../src/main/chatWorkspace';
import type { ChatEntry, LaunchOptions } from '../src/shared/types';

function chatOf(entries: ChatEntry[]) {
  return new ChatLog(entries).list();
}

const conversation: ChatEntry[] = [
  { kind: 'user', id: 'u1', text: 'Fix the build' },
  { kind: 'assistant', id: 'a1', text: 'Done', streaming: false },
  { kind: 'turn', id: 't1', ok: true, durationMs: 1, costUsd: null, text: null },
  { kind: 'user', id: 'u2', text: 'Again' },
  { kind: 'assistant', id: 'a2', text: 'Done again', streaming: false },
  { kind: 'user', id: 'u3', text: 'Again' },
  { kind: 'user', id: 'q1', text: 'Later', delivery: 'queued' }
];

describe('fork points', () => {
  it('names a message by id, text and which occurrence of that text it is', () => {
    const items = chatOf(conversation);
    expect(forkPoint(items, 'u3')).toEqual({ itemId: 'u3', text: 'Again', occurrence: 1 });
    expect(forkPoint(items, 'a1')).toBeNull();
    // Queued messages aren't in the conversation yet.
    expect(forkPoint(items, 'q1')).toBeNull();
  });

  it('copies what came before the message, or the whole conversation without queued messages', () => {
    const items = chatOf(conversation);
    expect(forkItems(items, { itemId: 'u2', text: 'Again', occurrence: 0 })!.map((i) => i.id)).toEqual(['u1', 'a1', 't1']);
    expect(forkItems(items)!.map((i) => i.id)).toEqual(['u1', 'a1', 't1', 'u2', 'a2', 'u3']);
    expect(forkItems(items, { itemId: 'gone', text: 'Nope', occurrence: 0 })).toBeNull();
  });

  it('finds a live message in a history-rebuilt chat by its transcript uuid, else by text', () => {
    const history = chatOf([
      { kind: 'user', id: 'user-u1', text: 'Fix the build' },
      { kind: 'user', id: 'user-x2', text: 'Again' },
      { kind: 'user', id: 'user-x3', text: 'Again' }
    ]);
    expect(forkItems(history, { itemId: 'u1', text: 'Fix the build', occurrence: 0 })).toEqual([]);
    expect(forkItems(history, { itemId: 'live-id', text: 'Again', occurrence: 1 })!.map((i) => i.id)).toEqual(['user-u1', 'user-x2']);
  });
});

describe('Claude Code forks', () => {
  const line = (record: object) => JSON.stringify(record);
  const transcript = [
    line({ type: 'system', uuid: 's0', parentUuid: null, subtype: 'informational', content: 'hook' }),
    line({ type: 'user', uuid: 'p1', parentUuid: 's0', message: { role: 'user', content: 'Fix the build' } }),
    line({ type: 'assistant', uuid: 'r1', parentUuid: 'p1', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } }),
    line({ type: 'user', uuid: 'tr1', parentUuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
    line({ type: 'assistant', uuid: 'r2', parentUuid: 'tr1', message: { content: [{ type: 'text', text: 'Done' }] } }),
    line({ type: 'assistant', uuid: 'side', parentUuid: 'r2', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }),
    line({ type: 'user', uuid: 'p2', parentUuid: 'r2', message: { role: 'user', content: [{ type: 'text', text: 'Again' }] } }),
    line({ type: 'assistant', uuid: 'r3', parentUuid: 'p2', message: { content: [{ type: 'text', text: 'Done again' }] } })
  ];

  it('keeps the transcript up to the entry the message follows; tool results are not messages', () => {
    expect(claudeForkThrough(transcript, { itemId: 'p2', text: 'Again', occurrence: 0 })).toBe('r2');
    expect(claudeForkThrough(transcript, { itemId: 'user-p2', text: 'Again', occurrence: 0 })).toBe('r2');
    expect(claudeForkThrough(transcript, { itemId: 'unknown', text: 'Again', occurrence: 0 })).toBe('r2');
  });

  it('copies nothing before the first message and reports a message it cannot find', () => {
    expect(claudeForkThrough(transcript, { itemId: 'p1', text: 'Fix the build', occurrence: 0 })).toBeNull();
    expect(claudeForkThrough(transcript, { itemId: 'unknown', text: 'Again', occurrence: 1 })).toBeUndefined();
  });

  it('starts the copy under its own session id', () => {
    const args = claudeChatArgs({ sessionId: 'new', fork: { sessionId: 'old', through: 'r2' } });
    expect(args.join(' ')).toContain('--resume old --fork-session --resume-session-at r2 --session-id new');
    const whole = claudeChatArgs({ sessionId: 'new', fork: { sessionId: 'old' } });
    expect(whole).not.toContain('--resume-session-at');
    expect(whole.join(' ')).toContain('--resume old --fork-session --session-id new');
  });
});

describe('Codex forks', () => {
  const turns = [
    { id: 'turn-1', items: [{ type: 'userMessage', id: 'srv-1', clientId: 'c1', content: [{ type: 'text', text: 'Fix the build' }] }, { type: 'agentMessage', id: 'a', text: 'ok' }] },
    { id: 'turn-2', items: [{ type: 'userMessage', id: 'srv-2', content: [{ type: 'text', text: 'Again' }] }] },
    { id: 'turn-3', items: [{ type: 'userMessage', id: 'srv-3', clientId: 'c3', content: [{ type: 'text', text: 'Again' }] }] }
  ];

  it('keeps the turns before the message', () => {
    expect(codexForkTurn(turns, { itemId: 'c3', text: 'Again', occurrence: 1 })).toBe('turn-2');
    expect(codexForkTurn(turns, { itemId: 'srv-2', text: 'Again', occurrence: 0 })).toBe('turn-1');
    expect(codexForkTurn(turns, { itemId: 'other', text: 'Again', occurrence: 1 })).toBe('turn-2');
    expect(codexForkTurn(turns, { itemId: 'c1', text: 'Fix the build', occurrence: 0 })).toBeNull();
    expect(codexForkTurn(turns, { itemId: 'other', text: 'Missing', occurrence: 0 })).toBeUndefined();
  });
});

function fakeHost() {
  const log = new ChatLog();
  const sessions: Array<Record<string, unknown>> = [];
  const host: ChatHost = {
    log,
    changed: () => {},
    status: () => {},
    session: (info) => sessions.push(info),
    turnComplete: () => {},
    limits: () => {},
    requeue: () => {}
  };
  return { host, log, sessions };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Codex driver', () => {
  it('forks through the turn before the chosen message', async () => {
    const { host, sessions } = fakeHost();
    const sent: any[] = [];
    const chat = new CodexChat(host, (m) => sent.push(m), { cwd: 'C:\\r', appVersion: '0', fork: { threadId: 'src', before: { itemId: 'c3', text: 'Again', occurrence: 1 } } });
    const ready = chat.start();
    chat.receive(JSON.stringify({ id: sent[0].id, result: {} }));
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: 'thread/turns/list', params: { threadId: 'src', sortDirection: 'asc' } });
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { data: [{ id: 'turn-1', items: [] }, { id: 'turn-2', items: [{ type: 'userMessage', id: 'c3', content: [{ type: 'text', text: 'Again' }] }] }], nextCursor: null } }));
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: 'thread/fork', params: { threadId: 'src', lastTurnId: 'turn-1', excludeTurns: true } });
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { thread: { id: 'copy', path: 'C:\\copy.jsonl' }, model: 'm' } }));
    await ready;
    expect(sessions.at(-1)).toMatchObject({ sessionId: 'copy' });
  });

  it('answers side questions on an ephemeral read-only copy, apart from the conversation', async () => {
    const { host, log } = fakeHost();
    const sent: any[] = [];
    const chat = new CodexChat(host, (m) => sent.push(m), { cwd: 'C:\\r', appVersion: '0' });
    const ready = chat.start();
    chat.receive(JSON.stringify({ id: sent[0].id, result: {} }));
    await flush();
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { thread: { id: 'main', path: null }, model: 'm' } }));
    await ready;

    const answer = chat.sideChat('Why?', [{ question: 'What?', answer: 'This.' }]);
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: 'thread/fork', params: { threadId: 'main', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' } });
    chat.receive(JSON.stringify({ id: sent.at(-1).id, result: { thread: { id: 'aside', path: null } } }));
    await flush();
    const turn = sent.at(-1);
    expect(turn).toMatchObject({ method: 'turn/start', params: { threadId: 'aside' } });
    // A fresh copy hears the side chat so far.
    expect(turn.params.input[0].text).toContain('What?');
    chat.receive(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'aside', itemId: 'x' } }));
    expect(sent.at(-1)).toMatchObject({ id: 99, error: { message: 'The side chat is read-only' } });
    const notify = (method: string, params: object) => chat.receive(JSON.stringify({ method, params: { threadId: 'aside', ...params } }));
    notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Because' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Because it is.' } });
    notify('turn/completed', { turn: { id: 't', status: 'completed' } });
    expect(await answer).toEqual({ ok: true, text: 'Because it is.' });
    expect(log.size).toBe(0);

    // A follow-up goes to the same copy, without the history.
    const next = chat.sideChat('And then?', [{ question: 'Why?', answer: 'Because it is.' }]);
    await flush();
    expect(sent.at(-1)).toMatchObject({ method: 'turn/start', params: { threadId: 'aside', input: [{ text: 'And then?' }] } });
    notify('turn/completed', { turn: { id: 't2', status: 'failed', error: { message: 'quota' } } });
    expect(await next).toEqual({ ok: false, error: 'quota' });
  });
});

describe('side chat prompts', () => {
  it('carries the recent side chat along with a follow-up', () => {
    expect(sideChatPrompt('Q', [])).toBe('Q');
    const prompt = sideChatPrompt('Next', Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` })));
    expect(prompt).not.toContain('q1\n');
    expect(prompt).toContain('Question: q7');
    expect(prompt.endsWith('Follow-up: Next')).toBe(true);
  });
});

describe('fork workspaces', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('works in the workspace of the projectless chat it copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fork-'));
    roots.push(dir);
    const options: LaunchOptions = { provider: 'claude', profileId: 'p', mode: 'chat', cwd: '', projectless: true };
    const source = resolveChatWorkspace(options, 'source', dir);
    const fork = { agentId: 'source', title: 'Source', sessionId: 's' };
    expect(resolveChatWorkspace({ ...source, fork }, 'copy', dir).cwd).toBe(source.cwd);
    // Only an existing chat workspace is kept; anything else gets the fork's own.
    expect(resolveChatWorkspace({ ...options, cwd: dir, fork }, 'copy', dir).cwd).toBe(path.join(dir, 'chat-workspaces', 'copy'));
  });
});

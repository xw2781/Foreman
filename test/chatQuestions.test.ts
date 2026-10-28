import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeChat } from '../src/main/chat/claudeChat';
import { CodexChat } from '../src/main/chat/codexChat';
import { ChatLog } from '../src/main/chat/log';
import type { ChatHost } from '../src/main/chat/driver';
import { OPTIONAL_QUESTION_MS } from '../src/main/chat/questions';

afterEach(() => vi.useRealTimers());

function session(provider: 'claude' | 'codex') {
  const log = new ChatLog();
  const sent: any[] = [];
  const status = vi.fn();
  const host: ChatHost = { log, status, changed() {}, session() {}, turnComplete() {}, limits() {}, requeue() {} };
  const write = (message: object) => sent.push(message);
  const chat = provider === 'claude' ? new ClaudeChat(host, write) : new CodexChat(host, write, { cwd: 'C:\\project', appVersion: 'test' });
  const ask = (id: number, optional = true, extra: object = {}) => {
    const questions = [{ id: 'choice', header: optional ? 'Style (optional)' : 'Consent (required)', question: 'Which style?', options: [{ label: 'Compact (Recommended)', description: 'Less space' }, { label: 'Spacious', description: 'More space' }] }];
    chat.receive(JSON.stringify(provider === 'claude'
      ? { type: 'control_request', request_id: String(id), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions }, ...extra } }
      : { id, method: 'item/tool/requestUserInput', params: { questions, isBlocking: !optional, ...extra } }));
  };
  return { chat, log, sent, status, ask };
}

describe.each(['claude', 'codex'] as const)('%s question queue', (provider) => {
  it('starts only the visible optional question timer and returns no invented answer', () => {
    vi.useFakeTimers();
    const { chat, log, sent, ask } = session(provider);
    ask(1);
    vi.advanceTimersByTime(10_000);
    ask(2);
    expect(log.get('approval-1')).toMatchObject({ questionOptional: true, questionTimeoutAt: expect.any(Number) });
    expect(log.get('approval-2')).not.toHaveProperty('questionTimeoutAt');
    vi.advanceTimersByTime(20_000);
    expect(log.get('approval-1')).toMatchObject({ state: 'resolved', resolution: 'Skipped' });
    expect(log.get('approval-2')).toMatchObject({ state: 'pending', questionTimeoutAt: Date.now() + OPTIONAL_QUESTION_MS });
    expect(sent).toHaveLength(1);
    if (provider === 'codex') expect(sent[0]).toEqual({ id: 1, result: { answers: {} } });
    else expect(sent[0].response.response).toMatchObject({ behavior: 'deny', message: expect.stringContaining('no consent or permission') });
    chat.respond('approval-2', { optionId: 'answer', answers: { [provider === 'claude' ? 'Which style?' : 'choice']: 'Spacious' } });
    vi.advanceTimersByTime(100_000);
    expect(sent).toHaveLength(2);
  });

  it('lets the user keep a question open and ignores stale submissions after resolution', () => {
    vi.useFakeTimers();
    const { chat, log, sent, ask } = session(provider);
    ask(1);
    chat.respond('approval-1', { optionId: 'wait' });
    expect(log.get('approval-1')).toMatchObject({ state: 'pending', questionTimeoutAt: null });
    vi.advanceTimersByTime(100_000);
    expect(sent).toHaveLength(0);
    chat.respond('approval-1', { optionId: 'deny' });
    chat.respond('approval-1', { optionId: 'answer', answers: { choice: 'Spacious' } });
    expect(sent).toHaveLength(1);
  });

  it('never expires a required question or the questions queued behind it', () => {
    vi.useFakeTimers();
    const { chat, log, sent, status, ask } = session(provider);
    ask(1, false);
    ask(2);
    vi.advanceTimersByTime(100_000);
    expect(sent).toHaveLength(0);
    expect(status.mock.calls.at(-1)?.[0]).toBe('needs-input');
    expect(log.get('approval-1')).toMatchObject({ state: 'pending', questionOptional: false });
    expect(log.get('approval-2')).not.toHaveProperty('questionTimeoutAt');
    chat.respond('approval-1', { optionId: 'deny' });
    expect(status.mock.calls.at(-1)?.[0]).toBe('working');
    expect(log.get('approval-2')).toHaveProperty('questionTimeoutAt', Date.now() + OPTIONAL_QUESTION_MS);
    chat.dispose('Stopped');
    vi.advanceTimersByTime(100_000);
    expect(sent).toHaveLength(1);
  });

  it('never times out a tool permission', () => {
    vi.useFakeTimers();
    const { chat, log, sent } = session(provider);
    chat.receive(JSON.stringify(provider === 'claude'
      ? { type: 'control_request', request_id: '99', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git init' } } }
      : { id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'git init' } }));
    vi.advanceTimersByTime(100_000);
    expect(log.get('approval-99')).toMatchObject({ state: 'pending' });
    expect(sent).toHaveLength(0);
  });

  it('cancels the visible timer and gives the next request its full time', () => {
    vi.useFakeTimers();
    const { chat, log, sent, ask } = session(provider);
    ask(1);
    ask(2);
    vi.advanceTimersByTime(10_000);
    chat.receive(JSON.stringify(provider === 'claude'
      ? { type: 'control_cancel_request', request_id: '1' }
      : { method: 'serverRequest/resolved', params: { requestId: 1 } }));
    expect(log.get('approval-1')).toMatchObject({ state: 'cancelled' });
    expect(log.get('approval-2')).toHaveProperty('questionTimeoutAt', Date.now() + OPTIONAL_QUESTION_MS);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1);
    expect(log.get('approval-2')).toMatchObject({ state: 'resolved' });
  });
});

it('keeps an explicitly required Codex question open even in nonblocking Default mode', () => {
  vi.useFakeTimers();
  const { ask, log, sent } = session('codex');
  ask(1, false, { isBlocking: false });
  vi.advanceTimersByTime(100_000);
  expect(log.get('approval-1')).toMatchObject({ state: 'pending', questionOptional: false });
  expect(sent).toHaveLength(0);
});

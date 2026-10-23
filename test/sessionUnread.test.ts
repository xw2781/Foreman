import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../src/shared/types';
import { completionStamp, hasUnreadCompletion } from '../src/renderer/src/sessionUnread';

const completed = '2026-10-22T20:45:00.000Z';
const agent = (extra: Partial<AgentInfo> = {}) => ({ id: 'a', status: 'idle', endedAt: null, completedAt: completed, ...extra } as AgentInfo);

describe('unread session completions', () => {
  it('shows a completed turn as unread until that completion is opened', () => {
    expect(hasUnreadCompletion(agent(), {})).toBe(true);
    expect(hasUnreadCompletion(agent(), { a: completed })).toBe(false);
    expect(hasUnreadCompletion(agent({ completedAt: '2026-10-22T20:46:00.000Z' }), { a: completed })).toBe(true);
  });
  it('does not label stopped or failed processes as new successful completions', () => {
    expect(hasUnreadCompletion(agent({ completedAt: null, status: 'stopped', endedAt: completed }), {})).toBe(false);
    expect(hasUnreadCompletion(agent({ completedAt: null, status: 'failed', endedAt: completed }), {})).toBe(false);
    expect(completionStamp(agent({ completedAt: null, status: 'done', endedAt: completed }))).toBe(completed);
  });
  it('keeps an unread completion across stopping or resuming the same conversation', () => {
    expect(hasUnreadCompletion(agent({ status: 'stopped', endedAt: completed }), {})).toBe(true);
    expect(hasUnreadCompletion(agent({ status: 'working' }), { a: completed })).toBe(false);
  });
});

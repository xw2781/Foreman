import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../src/shared/types';
import { groupAgentsByProject, projectKey } from '../src/renderer/src/agentProjects';

const agent = (id: string, cwd: string, projectless = false) => ({ id, cwd, projectless } as AgentInfo);

describe('session project groups', () => {
  it('keeps added projects visible before they have sessions and merges matching folders', () => {
    const groups = groupAgentsByProject([agent('a', 'c:/repos/foreman/')], [
      'C:\\Repos\\NewApp', 'C:\\Repos\\Foreman', 'c:/repos/newapp/'
    ]);
    expect(groups.map((group) => [group.label, group.agents.map((item) => item.id)])).toEqual([
      ['NewApp', []], ['Foreman', ['a']]
    ]);
    expect(projectKey('C:\\Repos\\Foreman')).toBe(projectKey('c:/repos/foreman/'));
  });
  it('groups Windows paths across casing and slash differences while retaining recency order', () => {
    const a = agent('a', 'C:\\Repos\\Foreman');
    const b = agent('b', 'C:/Repos/ArcRho');
    const c = agent('c', 'c:/repos/foreman/');
    expect(groupAgentsByProject([a, b, c]).map((group) => [group.label, group.agents.map((item) => item.id)])).toEqual([
      ['Foreman', ['a', 'c']], ['ArcRho', ['b']]
    ]);
  });
  it('collects standalone workspaces in This Computer and distinguishes folders sharing a name', () => {
    const groups = groupAgentsByProject([
      agent('a', 'C:/chat-workspaces/a', true), agent('b', 'C:/chat-workspaces/b', true),
      agent('c', 'C:/Work/App'), agent('d', 'C:/Personal/App')
    ]);
    expect(groups[0].label).toBe('This Computer');
    expect(groups[0].agents.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups[1].key).not.toBe(groups[2].key);
    expect(groups[1].label).not.toBe(groups[2].label);
  });
});

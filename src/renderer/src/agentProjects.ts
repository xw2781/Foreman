import type { AgentInfo } from '@shared/types';
import { folderName, shortPath } from './format';

export function projectKey(folder: string): string {
  const normalized = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[a-z]:/i.test(normalized) || normalized.startsWith('//');
  return normalized ? `project:${windows ? normalized.toLowerCase() : normalized}` : 'no-project';
}

/** Retain explicitly added projects even before their first session, then group sessions in recency order. */
export function groupAgentsByProject(agents: AgentInfo[], projectFolders: string[] = []) {
  const groups = new Map<string, { key: string; path: string; label: string; agents: AgentInfo[] }>();
  for (const folder of projectFolders) {
    const key = projectKey(folder);
    if (key !== 'no-project' && !groups.has(key)) groups.set(key, { key, path: folder, label: folderName(folder), agents: [] });
  }
  for (const agent of agents) {
    const key = agent.projectless ? 'no-project' : projectKey(agent.cwd);
    if (!groups.has(key)) groups.set(key, {
      key, path: key === 'no-project' ? '' : agent.cwd,
      label: key === 'no-project' ? 'This Computer' : folderName(agent.cwd), agents: []
    });
    groups.get(key)!.agents.push(agent);
  }
  const result = [...groups.values()];
  const duplicateLabels = new Set(result.filter((group, index) => result.some((other, otherIndex) => otherIndex !== index && other.label === group.label)).map((group) => group.label));
  for (const group of result) {
    if (group.path && duplicateLabels.has(group.label)) group.label = shortPath(group.path);
  }
  return result;
}

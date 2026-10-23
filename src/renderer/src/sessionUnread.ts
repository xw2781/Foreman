import type { AgentInfo } from '@shared/types';

export function completionStamp(agent: AgentInfo): string | null {
  return agent.completedAt ?? (agent.status === 'done' ? agent.endedAt : null);
}

export function hasUnreadCompletion(agent: AgentInfo, read: Record<string, string>): boolean {
  const completed = completionStamp(agent);
  return Boolean(completed && (!read[agent.id] || completed > read[agent.id]));
}

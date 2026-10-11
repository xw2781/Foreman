import type { AgentInfo, SubagentInfo } from './types';

export interface SubagentBranch {
  node: SubagentInfo;
  children: SubagentBranch[];
}

/**
 * The visible subagents as a tree. A hidden node's children move up to its
 * nearest visible ancestor (or the agent), so a running subagent never
 * disappears because the one that started it finished.
 */
export function subagentTree(nodes: SubagentInfo[], visible: (n: SubagentInfo) => boolean = () => true): SubagentBranch[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const branches = new Map<string, SubagentBranch>();
  for (const node of nodes) if (visible(node)) branches.set(node.id, { node, children: [] });
  const roots: SubagentBranch[] = [];
  for (const branch of branches.values()) {
    let parent = branch.node.parentId;
    const seen = new Set<string>([branch.node.id]);
    while (parent && !branches.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    const home = parent && !seen.has(parent) ? branches.get(parent) : undefined;
    (home ?? { children: roots }).children.push(branch);
  }
  return roots;
}

export function runningSubagents(agent: Pick<AgentInfo, 'subagents'>) {
  return agent.subagents?.filter((s) => s.status === 'running').length ?? 0;
}

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

/** Running nodes on the map: subagents and background commands. */
export function runningSubagents(agent: Pick<AgentInfo, 'subagents'>) {
  return agent.subagents?.filter((s) => s.status === 'running').length ?? 0;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "2 subagents and 1 background command", for what's running (or for every node); empty when there's none. */
export function describeSubagents(agent: Pick<AgentInfo, 'subagents'>, onlyRunning = true) {
  const nodes = (agent.subagents ?? []).filter((n) => !onlyRunning || n.status === 'running');
  const shells = nodes.filter((n) => n.shell).length;
  const agents = nodes.length - shells;
  return [agents ? plural(agents, 'subagent') : '', shells ? plural(shells, 'background command') : ''].filter(Boolean).join(' and ');
}

/**
 * An idle agent whose subagents or background commands still run isn't finished:
 * the CLI starts a new turn when they end. It shows as working in the background.
 */
export function backgroundWork(agent: Pick<AgentInfo, 'status' | 'subagents'>) {
  return agent.status === 'idle' && runningSubagents(agent) > 0;
}

import type { CliDefaults, Provider } from './types';

/** Curated newest-first order; family aliases follow explicit versions. */
export const MODELS: Record<Provider, string[]> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5', 'opus', 'opus[1m]', 'fable', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
};

function version(id: string): number[] {
  const match = /(\d+)(?:[.-](\d{1,2}))?(?![\d])/.exec(id.replace(/-\d{8}/, ''));
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [0, 0];
}

export function modelChoices(provider: Provider, defaults?: CliDefaults | null, current = ''): string[] {
  const listed = defaults?.models?.length ? [...new Set(defaults.models)].sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    return y[0] - x[0] || y[1] - x[1];
  }) : defaults?.discoveredModels?.length
    ? [...new Set(defaults.discoveredModels.map((model) => model.id))]
    : [...MODELS[provider]];
  // A custom or older current model must not displace the default at the top.
  if (current && !listed.includes(current)) listed.push(current);
  return listed;
}

export function defaultModel(provider: Provider, defaults?: CliDefaults | null): string {
  return modelChoices(provider, defaults)[0];
}

/** Older versions within each family; aliases are compared using CLI resolution metadata. */
export function olderModelIds(provider: Provider, defaults?: CliDefaults | null, current = ''): Set<string> {
  const models = modelChoices(provider, defaults, current).map((id) => {
    const resolved = defaults?.discoveredModels?.find((model) => model.id === id)?.resolvedModel ?? id;
    const base = resolved.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
    const claude = /^claude-([a-z]+)-(\d+)(?:[.-](\d+))?$/.exec(base);
    const codex = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(base);
    return {
      id,
      family: claude ? claude[1] : codex ? `gpt-${codex[3] ?? 'base'}` : null,
      version: claude ? [Number(claude[2]), Number(claude[3] ?? 0)] : codex ? [Number(codex[1]), Number(codex[2] ?? 0)] : [0, 0]
    };
  });
  const newer = (a: number[], b: number[]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const latest = new Map<string, number[]>();
  for (const model of models) {
    if (model.family && (!latest.has(model.family) || newer(model.version, latest.get(model.family)!))) latest.set(model.family, model.version);
  }
  return new Set(models.filter((model) => model.id !== 'default' && model.family && newer(latest.get(model.family)!, model.version)).map((model) => model.id));
}

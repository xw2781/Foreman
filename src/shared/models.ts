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

function clip(text: string, max: number) {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function describeToolInput(name: string, input: Record<string, any> | null | undefined): string {
  if (!input) return '';
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof pick === 'string') return clip(pick, 90);
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return '';
}

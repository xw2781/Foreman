export const DEFAULT_CHAT_FONT_SIZE = 13.5;

export function chatFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(10, Math.min(24, value))
    : DEFAULT_CHAT_FONT_SIZE;
}

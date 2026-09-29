// Browser helpers with no Electron dependency.

/** Schemes a tab may navigate to. Others (mailto:, app protocols) would hand off to programs on the computer. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:', 'file:']);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Electron's user agent without the Electron and app tokens, so sites see an ordinary Chrome. */
export function chromeUserAgent(agent: string): string {
  const keep = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari', 'Version', 'Mobile']);
  return agent
    .split(' ')
    .filter((token) => {
      const product = /^([\w.-]+)\/[\w.]+$/.exec(token);
      return !product || keep.has(product[1]);
    })
    .join(' ');
}

/** What the person typed in the address bar or the agent passed: a URL, with https:// added where it has no scheme. */
export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('No URL given.');
  if (/^(about|data|blob|file):/i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text)) return `file:///${text.replace(/\\/g, '/')}`;
  // Another scheme (mailto:, tel:, an app's) stays as it is, for the scheme check to refuse; host:port is no scheme.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  if (/^[^\s/]+\.[^\s/]+/.test(text) || /^[^\s/]+:\d+/.test(text)) return `https://${text}`;
  throw new Error(`"${text}" isn't a URL.`);
}

export function schemeAllowed(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

const CSS_CURSORS = new Set([
  'default', 'crosshair', 'text', 'wait', 'help', 'move', 'progress', 'cell', 'copy', 'alias', 'context-menu', 'no-drop', 'not-allowed',
  'grab', 'grabbing', 'zoom-in', 'zoom-out', 'vertical-text', 'col-resize', 'row-resize', 'e-resize', 'n-resize', 'ne-resize', 'nw-resize',
  's-resize', 'se-resize', 'sw-resize', 'w-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'all-scroll', 'none'
]);

/** Electron's cursor names as CSS cursors ("hand" is a link's pointer; Electron's "pointer" is the arrow). */
export function cssCursor(type: string): string {
  if (type === 'hand') return 'pointer';
  if (type === 'pointer' || type === 'default') return 'default';
  if (type === 'ibeam') return 'text';
  if (type === 'not-allowed' || type === 'notAllowed') return 'not-allowed';
  const kebab = type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return CSS_CURSORS.has(kebab) ? kebab : 'default';
}

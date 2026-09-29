// How calls to Foreman's own browser tools read in the chat, for both CLIs.

export const BROWSER_SERVER = 'foreman_browser';

const TITLES: Record<string, string> = {
  browser_navigate: 'Opened',
  browser_navigate_back: 'Went back',
  browser_snapshot: 'Read the page',
  browser_click: 'Clicked',
  browser_type: 'Typed',
  browser_press_key: 'Pressed',
  browser_hover: 'Hovered',
  browser_select_option: 'Chose',
  browser_scroll: 'Scrolled',
  browser_drag: 'Dragged',
  browser_screenshot: 'Took a screenshot',
  browser_evaluate: 'Ran JavaScript',
  browser_wait_for: 'Waited',
  browser_tabs: 'Tabs',
  browser_console_messages: 'Read the console',
  browser_handle_dialog: 'Set the dialog answer',
  browser_file_upload: 'Uploaded',
  browser_downloads: 'Listed downloads',
  browser_resize: 'Resized'
};

export function browserToolTitle(server: string | undefined, tool: string | undefined): string | null {
  if (server !== BROWSER_SERVER || !tool) return null;
  return `Browser · ${TITLES[tool] ?? tool}`;
}

export function browserToolDetail(tool: string | undefined, input: Record<string, any> | null | undefined): string | null {
  if (!input) return null;
  const s = (key: string) => (typeof input[key] === 'string' && input[key].trim() ? String(input[key]).trim() : null);
  switch (tool) {
    case 'browser_navigate':
      return s('url');
    case 'browser_navigate_back':
      return input.forward ? 'forward' : null;
    case 'browser_click':
    case 'browser_hover':
    case 'browser_select_option':
      return s('element') ?? s('ref');
    case 'browser_type': {
      const target = s('element') ?? s('ref');
      const value = s('text');
      const typed = value && !/password/i.test(target ?? '') ? JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value) : null;
      return [typed, target ? `into ${target}` : null].filter(Boolean).join(' ') || null;
    }
    case 'browser_press_key':
      return s('key');
    case 'browser_scroll':
      return s('direction') ?? 'down';
    case 'browser_drag':
      return [s('start_element') ?? s('start_ref'), s('end_element') ?? s('end_ref')].filter(Boolean).join(' → ') || null;
    case 'browser_wait_for':
      return s('text') ?? s('text_gone') ?? (typeof input.seconds === 'number' ? `${input.seconds} s` : null);
    case 'browser_tabs':
      return s('action');
    case 'browser_evaluate': {
      const code = s('expression');
      return code ? (code.length > 60 ? `${code.slice(0, 59)}…` : code) : null;
    }
    case 'browser_resize':
      return typeof input.width === 'number' ? `${input.width}×${input.height}` : null;
    case 'browser_file_upload':
      return Array.isArray(input.paths) ? input.paths.map((p: unknown) => String(p).split(/[\\/]/).pop()).join(', ') : null;
    default:
      return null;
  }
}

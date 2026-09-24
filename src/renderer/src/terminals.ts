import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { Provider } from '@shared/types';
import { call, listen, resizeAgent, writeToAgent } from './api';

/**
 * One xterm per agent, created on first view and kept alive (detached from
 * the DOM) while hidden, so switching agents never loses scrollback or TUI
 * state. Output that arrives for a terminal that hasn't been created yet is
 * not lost: creation replays the main process's buffer, and the running
 * character offset on every chunk stitches replay and live data exactly.
 */
interface Entry {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  end: number;
  ready: boolean;
  queue: Array<{ data: string; end: number }>;
  observer: ResizeObserver | null;
  lastSize: string;
}

type TerminalTheme = 'dark' | 'cream' | 'grey';

const entries = new Map<string, Entry>();
let options = { fontSize: 13, fontFamily: "'Cascadia Mono', Consolas, monospace", theme: 'dark' as TerminalTheme };

const DARK: ITheme = {
  background: '#0b0d12',
  foreground: '#d7dce6',
  cursor: '#c9cfdb',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(123,131,255,0.35)',
  black: '#1c2029',
  red: '#f07178',
  green: '#7fd88f',
  yellow: '#f5c26b',
  blue: '#6ea8fe',
  magenta: '#c792ea',
  cyan: '#6fd3e0',
  white: '#d7dce6',
  brightBlack: '#5d6477',
  brightRed: '#ff8b92',
  brightGreen: '#9be8a8',
  brightYellow: '#ffd68a',
  brightBlue: '#8fbcff',
  brightMagenta: '#dcb0ff',
  brightCyan: '#8ce6f0',
  brightWhite: '#ffffff'
};

const CREAM: ITheme = {
  background: '#f1ede4',
  foreground: '#241f18',
  cursor: '#3d3629',
  cursorAccent: '#f1ede4',
  selectionBackground: 'rgba(90,95,240,0.22)',
  black: '#1d2130',
  red: '#c7303b',
  green: '#1f8a3b',
  yellow: '#a36a00',
  blue: '#2a63c8',
  magenta: '#8a3fb8',
  cyan: '#137a8a',
  white: '#c9ccd4',
  brightBlack: '#6b7285',
  brightRed: '#e0444f',
  brightGreen: '#2aa34d',
  brightYellow: '#c28400',
  brightBlue: '#3b7be0',
  brightMagenta: '#a355d6',
  brightCyan: '#1a95a8',
  brightWhite: '#ffffff'
};

const GREY: ITheme = { ...CREAM, background: '#e2e4e7', foreground: '#1a1d24', cursor: '#343a46', cursorAccent: '#e2e4e7' };

const THEMES: Record<TerminalTheme, ITheme> = { dark: DARK, cream: CREAM, grey: GREY };

export function terminalBackground() {
  return THEMES[options.theme].background!;
}

listen('agent-data', ({ id, data, end }) => {
  const entry = entries.get(id);
  if (!entry) return; // created later from the buffer
  if (!entry.ready) {
    entry.queue.push({ data, end });
    return;
  }
  writeChunk(entry, data, end);
});

function writeChunk(entry: Entry, data: string, end: number) {
  if (end <= entry.end) return;
  const start = end - data.length;
  const fresh = start < entry.end ? data.slice(entry.end - start) : data;
  entry.end = end;
  entry.term.write(fresh);
}

function create(id: string, provider: Provider | null): Entry {
  const term = new Terminal({
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    theme: THEMES[options.theme],
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    lineHeight: 1.12,
    drawBoldTextInBrightColors: false
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, url) => call('shell.openExternal', url)));
  const element = document.createElement('div');
  element.className = 'term-mount';
  const entry: Entry = { term, fit, element, end: 0, ready: false, queue: [], observer: null, lastSize: '' };

  term.onData((data) => writeToAgent(id, data));
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    // Ctrl+C copies when text is selected, otherwise it's an interrupt.
    if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (ctrl && event.key.toLowerCase() === 'v') {
      navigator.clipboard.readText().then((text) => text && term.paste(text)).catch(() => {});
      event.preventDefault();
      return false;
    }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'c') {
      if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    // Shift+Enter inserts a newline in the prompt instead of submitting it.
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      writeToAgent(id, provider === 'codex' ? '\n' : '\x1b\r');
      event.preventDefault();
      return false;
    }
    return true;
  });

  entries.set(id, entry);
  call('agents.buffer', id)
    .then(({ data, end }) => {
      if (data) term.write(data);
      entry.end = end;
      entry.ready = true;
      for (const chunk of entry.queue) writeChunk(entry, chunk.data, chunk.end);
      entry.queue = [];
    })
    .catch(() => {
      entry.ready = true;
    });
  return entry;
}

/** Mounts an agent's terminal into `host` (creating it on first use). Returns an unmount function. */
export function mountTerminal(id: string, provider: Provider | null, host: HTMLElement, focus = true): () => void {
  let entry = entries.get(id);
  if (!entry) entry = create(id, provider);
  const current = entry;
  host.appendChild(current.element);
  if (!current.term.element) {
    current.term.open(current.element);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      current.term.loadAddon(webgl);
    } catch {
      // DOM renderer fallback
    }
  }
  const fitNow = () => {
    if (!current.element.isConnected || current.element.clientWidth < 20 || current.element.clientHeight < 20) return;
    try {
      current.fit.fit();
    } catch {
      return;
    }
    const size = `${current.term.cols}x${current.term.rows}`;
    if (size !== current.lastSize) {
      current.lastSize = size;
      resizeAgent(id, current.term.cols, current.term.rows);
    }
  };
  current.observer = new ResizeObserver(() => requestAnimationFrame(fitNow));
  current.observer.observe(current.element);
  requestAnimationFrame(() => {
    fitNow();
    if (focus) current.term.focus();
  });
  return () => {
    current.observer?.disconnect();
    current.observer = null;
    if (current.element.parentElement === host) host.removeChild(current.element);
  };
}

export function focusTerminal(id: string) {
  entries.get(id)?.term.focus();
}

export function disposeTerminal(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entry.observer?.disconnect();
  entry.term.dispose();
  entry.element.remove();
  entries.delete(id);
}

export function configureTerminals(next: { fontSize: number; fontFamily: string; theme: TerminalTheme }) {
  options = next;
  for (const entry of entries.values()) {
    entry.term.options.fontSize = next.fontSize;
    entry.term.options.fontFamily = next.fontFamily;
    entry.term.options.theme = THEMES[next.theme];
    try {
      entry.fit.fit();
    } catch {
      // not mounted
    }
  }
}

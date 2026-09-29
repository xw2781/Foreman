// Foreman's built-in browser for agents. Each agent gets its own set of tabs;
// every tab is an off-screen Chromium page (a hidden BrowserWindow rendering
// off-screen), so it never takes the person's screen, mouse or keyboard. The
// pages live in their own session partition: cookies, storage and cache are
// separate from the person's browsers and from Foreman's own window.
//
// Agents drive the tabs through the DevTools protocol (trusted input events,
// screenshots) and a script in an isolated world (page outline with element
// refs). The UI watches the active tab as a stream of JPEG frames and can take
// over with its own mouse and keyboard input.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BrowserWindow, Menu, clipboard, dialog, session as electronSession, type DownloadItem, type NativeImage, type Session, type WebContents } from 'electron';
import type {
  AppSettings,
  BrowserActionEntry,
  BrowserCommand,
  BrowserDialogInfo,
  BrowserDownload,
  BrowserInput,
  BrowserProfileMode,
  BrowserState,
  BrowserTabInfo
} from '../../shared/types';
import type { EventMap, EventName } from '../../shared/ipc';
import { PAGE_WORLD_ID, pageCall } from './pageAgent';
import type { KeyStroke } from './keys';
import { chromeUserAgent, cssCursor, normalizeUrl, schemeAllowed, sleep, withTimeout } from './browserUtil';

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MAX_ACTIONS = 60;
const MAX_CONSOLE = 300;
/** Frames to the UI at most this often (ms). */
const FRAME_INTERVAL = 50;
const SHARED_PARTITION = 'persist:foreman-agent-browser';
const DIALOG_MARK = '⁣foreman-dialog';
/** Only these page permission requests are granted; everything else (camera, location, notifications…) is refused. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

export interface BrowserHost {
  mainWindow(): BrowserWindow | null;
  settings(): AppSettings;
  emit<E extends EventName>(event: E, payload: EventMap[E]): void;
  downloadsDir: string;
}

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  source: string;
}

// Runs in each page's main world before the page's own scripts. Dialogs would
// otherwise open native message boxes on the person's screen (they are also
// disabled in webPreferences, which alone would answer every one with Cancel).
const DIALOG_SHIM = `(() => {
  if (window.__foremanDialogAnswers) return;
  const queue = [];
  Object.defineProperty(window, '__foremanDialogAnswers', { value: queue });
  const debug = console.debug.bind(console);
  const report = (type, message, answer) => { try { debug(${JSON.stringify(DIALOG_MARK)} + JSON.stringify({ type, message: String(message ?? ''), answer })); } catch {} };
  const next = (type) => { const i = queue.findIndex((a) => !a.type || a.type === type); return i >= 0 ? queue.splice(i, 1)[0] : null; };
  window.alert = function (message) { report('alert', message, 'OK'); };
  window.confirm = function (message) { const a = next('confirm'); const ok = a ? a.accept : true; report('confirm', message, ok ? 'OK' : 'Cancel'); return ok; };
  window.prompt = function (message, value) {
    const a = next('prompt');
    const answer = a ? (a.accept ? (a.text ?? value ?? '') : null) : (value ?? '');
    report('prompt', message, answer === null ? 'Cancel' : JSON.stringify(String(answer)));
    return answer === null ? null : String(answer);
  };
  window.print = function () { report('print', '', 'not available'); };
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    if (name in window) window[name] = function () { report(name, '', 'not available'); return Promise.reject(new DOMException('Not available in this browser; use a file input.', 'AbortError')); };
  }
})();`;

export class Tab {
  readonly id = randomBytes(4).toString('hex');
  readonly win: BrowserWindow;
  readonly wc: WebContents;
  console: ConsoleEntry[] = [];
  consoleErrors = 0;
  fileChooser: { backendNodeId: number; multiple: boolean } | null = null;
  crashed = false;
  ready: Promise<void>;

  constructor(partition: string, size: { width: number; height: number }) {
    this.win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        backgroundThrottling: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false
      }
    });
    this.wc = this.win.webContents;
    this.wc.setAudioMuted(true);
    this.ready = this.init();
  }

  // DevTools commands sent before the window has a page wait for one: load a blank page, then attach.
  private async init() {
    await this.wc.loadURL('about:blank').catch(() => {});
    try {
      this.wc.debugger.attach('1.3');
    } catch {
      // already attached (DevTools reattaching after a crash)
    }
    await this.cdp('Page.enable');
    await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    await this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM, runImmediately: true }).catch(() =>
      this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM })
    );
  }

  get alive() {
    return !this.win.isDestroyed() && !this.wc.isDestroyed();
  }

  cdp<T = any>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('The tab was closed.'));
    return withTimeout(this.wc.debugger.sendCommand(method, params) as Promise<T>, timeout, `The page did not respond (${method}).`);
  }

  info(): BrowserTabInfo {
    if (!this.alive) return { id: this.id, title: 'Closed', url: '', loading: false, canGoBack: false, canGoForward: false, crashed: true };
    const history = this.wc.navigationHistory;
    return {
      id: this.id,
      title: this.wc.getTitle(),
      url: this.wc.getURL(),
      loading: this.wc.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      crashed: this.crashed
    };
  }

  close() {
    if (this.win.isDestroyed()) return;
    try {
      this.wc.debugger.detach();
    } catch {
      // not attached
    }
    this.win.destroy();
  }
}

export class AgentBrowser {
  tabs: Tab[] = [];
  activeId: string | null = null;
  paused = false;
  busy = false;
  actions: BrowserActionEntry[] = [];
  pointer: BrowserState['pointer'] = null;
  lastDialog: BrowserDialogInfo | null = null;
  downloads: BrowserDownload[] = [];
  viewport = { ...DEFAULT_VIEWPORT };
  lastUserInputAt = 0;
  lastAgentAt = 0;
  private notes: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private actionId = 0;

  constructor(readonly service: BrowserService, readonly agentId: string, readonly profile: BrowserProfileMode, readonly partition: string) {}

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  tabOf(wc: WebContents): Tab | null {
    return this.tabs.find((t) => t.alive && t.wc.id === wc.id) ?? null;
  }

  /** Runs agent work one call at a time, so two tool calls never interleave their input. */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  note(text: string) {
    this.notes.push(text);
    if (this.notes.length > 20) this.notes.shift();
  }

  takeNotes(): string[] {
    const notes = this.notes.splice(0);
    for (const tab of this.tabs) {
      if (tab.consoleErrors) {
        notes.push(`${tab.consoleErrors} console error${tab.consoleErrors === 1 ? '' : 's'}${this.tabs.length > 1 ? ` in tab ${this.tabs.indexOf(tab) + 1}` : ''} (browser_console_messages lists them).`);
        tab.consoleErrors = 0;
      }
    }
    return notes;
  }

  log(source: 'agent' | 'user', text: string, ok = true) {
    this.actions.push({ id: ++this.actionId, at: new Date().toISOString(), source, text, ok });
    if (this.actions.length > MAX_ACTIONS) this.actions.splice(0, this.actions.length - MAX_ACTIONS);
    this.changed();
  }

  changed() {
    this.service.scheduleState(this);
  }

  point(x: number, y: number) {
    this.pointer = { x: Math.round(x), y: Math.round(y), at: Date.now() };
    this.changed();
  }

  state(): BrowserState {
    return {
      agentId: this.agentId,
      tabs: this.tabs.map((t) => t.info()),
      activeTabId: this.activeId,
      paused: this.paused,
      busy: this.busy,
      viewport: this.viewport,
      actions: this.actions,
      pointer: this.pointer,
      dialog: this.lastDialog,
      fileChooser: Boolean(this.active?.fileChooser),
      downloads: this.downloads,
      profile: this.profile
    };
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  async newTab(url?: string, activate = true): Promise<Tab> {
    const tab = new Tab(this.partition, this.viewport);
    this.tabs.push(tab);
    this.service.wireTab(this, tab);
    if (activate || !this.activeId) this.activate(tab.id);
    await tab.ready.catch(() => {});
    await this.fitViewport(tab);
    if (url) await this.load(tab, url);
    this.changed();
    return tab;
  }

  activate(id: string) {
    if (!this.tabs.some((t) => t.id === id)) throw new Error('No such tab.');
    this.activeId = id;
    this.service.activeTabChanged(this);
    this.changed();
  }

  closeTab(id: string) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    tab.close();
    if (this.activeId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.service.activeTabChanged(this);
    }
    this.changed();
  }

  /** The active tab, opening one if there is none. */
  async ensureTab(): Promise<Tab> {
    const active = this.active;
    if (active?.alive && !active.crashed) return active;
    if (active) this.closeTab(active.id);
    return this.newTab();
  }

  // -------------------------------------------------------------------------
  // Page primitives
  // -------------------------------------------------------------------------

  async load(tab: Tab, url: string): Promise<string | null> {
    if (!schemeAllowed(url)) throw new Error(`Only http, https, file, data and about pages can be opened here (not ${url}).`);
    try {
      await withTimeout(tab.wc.loadURL(url), 30_000, 'timeout');
      return null;
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (message === 'timeout') return 'The page is still loading after 30 seconds.';
      // A redirect or a script replacing the navigation aborts the first one; the page still loads.
      if (/ERR_ABORTED|\(-3\)/.test(message)) return null;
      const code = /(ERR_[A-Z_]+)/.exec(message)?.[1];
      return `The page failed to load${code ? ` (${code})` : ''}.`;
    }
  }

  /** Waits for the page to take in an action: a short pause, then any navigation it started. */
  async settle(tab: Tab, quiet = 150) {
    await sleep(quiet);
    if (!tab.alive || !tab.wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (tab.alive) tab.wc.off('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, 10_000);
      tab.wc.once('did-stop-loading', done);
    });
    await sleep(100);
  }

  async page<T>(tab: Tab, fn: Parameters<typeof pageCall>[0], ...args: unknown[]): Promise<T> {
    let result: { value?: T; error?: string };
    try {
      result = await withTimeout(tab.wc.executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code: pageCall(fn, ...args) }], true), 15_000, 'The page did not respond in time.');
    } catch (error: any) {
      throw new Error(String(error?.message ?? error).replace(/^Error: /, ''));
    }
    if (result?.error) throw new Error(result.error);
    return result?.value as T;
  }

  async mouse(tab: Tab, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, options: { button?: 'left' | 'middle' | 'right' | 'none'; clickCount?: number; modifiers?: number } = {}) {
    const button = options.button ?? (type === 'mouseMoved' ? 'none' : 'left');
    const buttons = type === 'mousePressed' || (type === 'mouseMoved' && button !== 'none') ? { left: 1, right: 2, middle: 4, none: 0 }[button] : 0;
    await tab.cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: options.clickCount ?? (type === 'mouseMoved' ? 0 : 1), modifiers: options.modifiers ?? 0 });
  }

  async clickAt(tab: Tab, x: number, y: number, options: { button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: number } = {}) {
    this.point(x, y);
    await this.mouse(tab, 'mouseMoved', x, y, { modifiers: options.modifiers });
    const count = options.clickCount ?? 1;
    for (let i = 1; i <= count; i++) {
      await this.mouse(tab, 'mousePressed', x, y, { button: options.button, clickCount: i, modifiers: options.modifiers });
      await this.mouse(tab, 'mouseReleased', x, y, { button: options.button, clickCount: i, modifiers: options.modifiers });
    }
  }

  async key(tab: Tab, stroke: KeyStroke) {
    const base = { key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.keyCode, nativeVirtualKeyCode: stroke.keyCode, modifiers: stroke.modifiers };
    await tab.cdp('Input.dispatchKeyEvent', { ...base, type: stroke.text ? 'keyDown' : 'rawKeyDown', text: stroke.text, unmodifiedText: stroke.text });
    await tab.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async screenshot(tab: Tab): Promise<NativeImage> {
    return withTimeout(tab.wc.capturePage(), 15_000, 'The screenshot timed out.');
  }

  async resize(width: number, height: number) {
    this.viewport = { width, height };
    await Promise.all(this.tabs.map((tab) => this.fitViewport(tab)));
    this.changed();
  }

  /**
   * Sizes the tab to the viewport. The page's own size is set exactly through DevTools: window sizes
   * round to a pixel or two off on scaled displays, and a page must see the width the agent chose.
   */
  async fitViewport(tab: Tab) {
    if (!tab.alive) return;
    const { width, height } = this.viewport;
    tab.win.setContentSize(width, height);
    await tab.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  }


  /** The answer the page's next confirm() or prompt() gets (by default OK, with the prompt's default text). */
  async answerNextDialog(tab: Tab, accept: boolean, text?: string) {
    await tab.cdp('Runtime.evaluate', { expression: `window.__foremanDialogAnswers && window.__foremanDialogAnswers.push(${JSON.stringify({ accept, text })})` });
  }

  statusText(): string {
    const tab = this.active;
    if (!tab || !tab.alive) return 'No tab is open. browser_navigate opens one.';
    const lines = [`Page: ${tab.wc.getTitle() || '(untitled)'}`, `URL: ${tab.wc.getURL()}`];
    if (tab.crashed) lines.push('The page crashed; navigate to reload it.');
    else if (tab.wc.isLoading()) lines.push('Still loading.');
    if (this.tabs.length > 1) lines.push(`Tab ${this.tabs.indexOf(tab) + 1} of ${this.tabs.length} (browser_tabs lists them).`);
    if (tab.fileChooser) lines.push('A file chooser is open: call browser_file_upload with the files.');
    const notes = this.takeNotes();
    if (notes.length) lines.push('', 'Since the last step:', ...notes.map((n) => `- ${n}`));
    return lines.join('\n');
  }

  dispose() {
    for (const tab of this.tabs) tab.close();
    this.tabs = [];
    this.activeId = null;
  }
}

export class BrowserService {
  private browsers = new Map<string, AgentBrowser>();
  private sessions = new Map<string, Session>();
  private watchedId: string | null = null;
  private stateTimers = new Map<string, NodeJS.Timeout>();
  private frameTimer: NodeJS.Timeout | null = null;
  private pendingFrame: { browser: AgentBrowser; tab: Tab; image: NativeImage } | null = null;
  private lastFrameAt = 0;
  /** Asked when an agent's browser first opens, so the UI can show it. */
  onOpened: (agentId: string) => void = () => {};

  constructor(readonly host: BrowserHost) {}

  get(agentId: string): AgentBrowser | null {
    return this.browsers.get(agentId) ?? null;
  }

  ensure(agentId: string): AgentBrowser {
    let browser = this.browsers.get(agentId);
    if (browser) return browser;
    const profile = this.host.settings().browserProfile === 'per-agent' ? 'per-agent' : 'shared';
    const partition = profile === 'shared' ? SHARED_PARTITION : `persist:foreman-agent-${agentId}`;
    this.sessionFor(partition);
    browser = new AgentBrowser(this, agentId, profile, partition);
    this.browsers.set(agentId, browser);
    this.onOpened(agentId);
    browser.changed();
    return browser;
  }

  list(): BrowserState[] {
    return [...this.browsers.values()].map((b) => b.state());
  }

  has(agentId: string) {
    return this.browsers.has(agentId);
  }

  /** Closes the agent's browser; a profile of its own is cleared as well. */
  async close(agentId: string) {
    const browser = this.browsers.get(agentId);
    if (!browser) return;
    this.browsers.delete(agentId);
    browser.dispose();
    clearTimeout(this.stateTimers.get(agentId));
    this.stateTimers.delete(agentId);
    this.host.emit('browser', { agentId, state: null });
    if (browser.profile === 'per-agent') {
      const session = this.sessions.get(browser.partition);
      this.sessions.delete(browser.partition);
      await session?.clearStorageData().catch(() => {});
      await session?.clearCache().catch(() => {});
    }
  }

  closeAll() {
    for (const browser of this.browsers.values()) browser.dispose();
    this.browsers.clear();
  }

  async clearData() {
    const partitions = new Set([SHARED_PARTITION, ...this.sessions.keys()]);
    for (const partition of partitions) {
      const session = electronSession.fromPartition(partition);
      await session.clearStorageData().catch(() => {});
      await session.clearCache().catch(() => {});
    }
  }

  scheduleState(browser: AgentBrowser) {
    if (this.stateTimers.has(browser.agentId)) return;
    this.stateTimers.set(
      browser.agentId,
      setTimeout(() => {
        this.stateTimers.delete(browser.agentId);
        if (this.browsers.get(browser.agentId) === browser) this.host.emit('browser', { agentId: browser.agentId, state: browser.state() });
      }, 80)
    );
  }

  // -------------------------------------------------------------------------
  // Watching (frames to the UI)
  // -------------------------------------------------------------------------

  watch(agentId: string | null) {
    const previous = this.watchedId ? this.browsers.get(this.watchedId) : null;
    this.watchedId = agentId;
    if (previous && previous.agentId !== agentId) for (const tab of previous.tabs) if (tab.alive) tab.wc.setFrameRate(5);
    const browser = agentId ? this.browsers.get(agentId) : null;
    if (browser) this.activeTabChanged(browser);
  }

  activeTabChanged(browser: AgentBrowser) {
    if (browser.agentId !== this.watchedId) return;
    for (const tab of browser.tabs) {
      if (!tab.alive) continue;
      tab.wc.setFrameRate(tab.id === browser.activeId ? 30 : 5);
    }
    const tab = browser.active;
    // A full repaint sends the first frame even when the page is still.
    if (tab?.alive) tab.wc.invalidate();
  }

  private onPaint(browser: AgentBrowser, tab: Tab, image: NativeImage) {
    if (browser.agentId !== this.watchedId || browser.activeId !== tab.id) return;
    this.pendingFrame = { browser, tab, image };
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => this.flushFrame(), Math.max(0, FRAME_INTERVAL - (Date.now() - this.lastFrameAt)));
  }

  private flushFrame() {
    this.frameTimer = null;
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (!frame || frame.image.isEmpty()) return;
    this.lastFrameAt = Date.now();
    const size = frame.image.getSize();
    this.host.emit('browser-frame', { agentId: frame.browser.agentId, tabId: frame.tab.id, width: size.width, height: size.height, data: frame.image.toJPEG(82) });
  }

  // -------------------------------------------------------------------------
  // The person's input and toolbar
  // -------------------------------------------------------------------------

  input(agentId: string, input: BrowserInput) {
    const browser = this.browsers.get(agentId);
    const tab = browser?.active;
    if (!browser || !tab?.alive) return;
    browser.lastUserInputAt = Date.now();
    const ignore = () => {};
    switch (input.kind) {
      case 'mouse':
        browser.mouse(tab, input.type, input.x, input.y, { button: input.button, clickCount: input.clickCount, modifiers: input.modifiers }).catch(ignore);
        break;
      case 'wheel':
        tab.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers }).catch(ignore);
        break;
      case 'key': {
        // Clipboard and editing shortcuts run as editing commands: the page gets its paste/copy events,
        // and the system clipboard is used without the page asking for access.
        const editing = input.modifiers === 2 ? { v: 'paste', c: 'copy', x: 'cut', a: 'selectAll', z: 'undo', y: 'redo' }[input.key.toLowerCase()] : undefined;
        if (editing) {
          if (input.type === 'keyDown') (tab.wc as any)[editing]();
          break;
        }
        const base = { key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode, modifiers: input.modifiers };
        if (input.type === 'keyUp') tab.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }).catch(ignore);
        else tab.cdp('Input.dispatchKeyEvent', { ...base, type: input.text ? 'keyDown' : 'rawKeyDown', text: input.text, unmodifiedText: input.text }).catch(ignore);
        break;
      }
      case 'text':
        if (input.text) tab.cdp('Input.insertText', { text: input.text }).catch(ignore);
        break;
    }
  }

  async open(agentId: string, url?: string): Promise<BrowserState> {
    const browser = this.ensure(agentId);
    if (url) await this.navigate(agentId, url);
    else if (!browser.tabs.length) await browser.newTab();
    return browser.state();
  }

  async navigate(agentId: string, url: string) {
    const browser = this.ensure(agentId);
    const target = normalizeUrl(url);
    const tab = await browser.ensureTab();
    browser.lastUserInputAt = Date.now();
    browser.log('user', `You opened ${target}`);
    const problem = await browser.load(tab, target);
    if (problem) browser.log('user', problem, false);
    browser.note(`The person opened ${tab.wc.getURL() || target} in this tab.`);
  }

  async command(agentId: string, command: BrowserCommand, tabId?: string) {
    const browser = command === 'newTab' ? this.ensure(agentId) : this.browsers.get(agentId);
    if (!browser) return;
    const tab = tabId ? browser.tabs.find((t) => t.id === tabId) ?? null : browser.active;
    switch (command) {
      case 'back':
        if (tab?.alive && tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (tab?.alive && tab.wc.navigationHistory.canGoForward()) tab.wc.navigationHistory.goForward();
        break;
      case 'reload':
        if (tab?.alive) tab.wc.reload();
        break;
      case 'stop':
        if (tab?.alive) tab.wc.stop();
        break;
      case 'newTab':
        await browser.newTab();
        browser.note('The person opened a new tab.');
        break;
      case 'closeTab':
        if (tab) {
          browser.closeTab(tab.id);
          browser.note('The person closed a tab.');
        }
        break;
      case 'selectTab':
        if (tab) {
          browser.activate(tab.id);
          browser.note(`The person switched to tab ${browser.tabs.indexOf(tab) + 1}.`);
        }
        break;
      case 'devtools':
        if (tab?.alive) tab.wc.openDevTools({ mode: 'detach' });
        break;
      case 'pause':
        browser.paused = true;
        browser.log('user', 'You took control');
        break;
      case 'resume':
        browser.paused = false;
        browser.log('user', 'You handed control back');
        browser.note('The person used the browser and handed it back; take a new snapshot before acting.');
        break;
      case 'close':
        await this.close(agentId);
        return;
    }
    browser.lastUserInputAt = Date.now();
    browser.changed();
  }

  // -------------------------------------------------------------------------
  // Tabs and sessions
  // -------------------------------------------------------------------------

  private sessionFor(partition: string): Session {
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const session = electronSession.fromPartition(partition);
    session.setUserAgent(chromeUserAgent(session.getUserAgent()));
    session.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    session.on('will-download', (event, item, wc) => this.onDownload(event, item, wc));
    this.sessions.set(partition, session);
    return session;
  }

  private browserOf(wc: WebContents | undefined): { browser: AgentBrowser; tab: Tab } | null {
    if (!wc) return null;
    for (const browser of this.browsers.values()) {
      const tab = browser.tabOf(wc);
      if (tab) return { browser, tab };
    }
    return null;
  }

  private onDownload(event: Electron.Event, item: DownloadItem, wc: WebContents | undefined) {
    const owner = this.browserOf(wc);
    if (!owner) {
      // Every download needs a save path, or Electron asks with a Save dialog.
      event.preventDefault();
      return;
    }
    const { browser } = owner;
    const dir = path.join(this.host.downloadsDir, browser.agentId);
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(item.getFilename() || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
    let file = path.join(dir, name);
    for (let n = 1; fs.existsSync(file); n++) {
      const ext = path.extname(name);
      file = path.join(dir, `${path.basename(name, ext)} (${n})${ext}`);
    }
    item.setSavePath(file);
    const entry: BrowserDownload = { id: randomBytes(4).toString('hex'), name: path.basename(file), path: file, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    browser.downloads.push(entry);
    if (browser.downloads.length > 30) browser.downloads.shift();
    browser.note(`A download started: ${entry.name}.`);
    browser.changed();
    item.on('updated', (_e, state) => {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      if (state === 'interrupted') entry.state = 'interrupted';
      browser.changed();
    });
    item.once('done', (_e, state) => {
      entry.state = state;
      entry.receivedBytes = item.getReceivedBytes();
      browser.note(state === 'completed' ? `Download finished: ${entry.path}` : `Download ${state}: ${entry.name}.`);
      browser.log('agent', state === 'completed' ? `Downloaded ${entry.name}` : `Download ${state}: ${entry.name}`, state === 'completed');
    });
  }

  wireTab(browser: AgentBrowser, tab: Tab) {
    const wc = tab.wc;
    const changed = () => browser.changed();
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(event as any, changed);
    wc.setFrameRate(browser.agentId === this.watchedId ? 30 : 5);
    wc.on('paint', (_event, _dirty, image) => this.onPaint(browser, tab, image));
    wc.on('cursor-changed', (_event, type) => {
      if (browser.agentId === this.watchedId && browser.activeId === tab.id) this.host.emit('browser-cursor', { agentId: browser.agentId, cursor: cssCursor(type) });
    });
    wc.on('render-process-gone', (_event, details) => {
      tab.crashed = true;
      browser.note(`The page crashed (${details.reason}).`);
      browser.log('agent', 'The page crashed', false);
    });
    wc.on('did-navigate', () => {
      tab.crashed = false;
      tab.fileChooser = null;
    });
    // Leaving a page never waits on "Leave site?".
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (schemeAllowed(url) && !/^about:blank$/i.test(url)) {
        browser.newTab(url).then(() => browser.note(`The page opened a new tab (${url}); it is now the active tab.`)).catch(() => {});
      }
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string) => {
      if (schemeAllowed(url)) return;
      event.preventDefault();
      browser.note(`The page tried to open ${url.slice(0, 120)}, which would hand off to another program; it was blocked.`);
    };
    wc.on('will-navigate', (event) => guard(event, (event as any).url));
    wc.on('will-redirect', (event) => guard(event, (event as any).url));
    wc.on('console-message', (event) => {
      const message = String(event.message ?? '');
      const level = String(event.level ?? 'info');
      // Electron's own advice to app developers, printed into every page of an unpackaged build.
      if (message.startsWith('%cElectron Security Warning')) return;
      if (message.startsWith(DIALOG_MARK)) {
        try {
          const report = JSON.parse(message.slice(DIALOG_MARK.length));
          const type = ['alert', 'confirm', 'prompt'].includes(report.type) ? report.type : 'alert';
          browser.lastDialog = { type, message: String(report.message ?? ''), answer: String(report.answer ?? '') };
          browser.note(
            report.type === 'print' || String(report.type).startsWith('show')
              ? `The page called ${report.type}(), which isn't available in this browser.`
              : `The page showed a ${report.type} dialog${report.message ? `: "${String(report.message).slice(0, 300)}"` : ''}. Foreman answered ${report.answer}${report.type === 'alert' ? '' : ' (browser_handle_dialog sets the next answer)'}.`
          );
          browser.log('agent', `Page ${report.type}: ${String(report.message ?? '').slice(0, 80)} → ${report.answer}`);
        } catch {
          // not ours after all
        }
        return;
      }
      const line = event.lineNumber ?? 0;
      const source = event.sourceId ?? '';
      tab.console.push({ at: Date.now(), level, text: message.slice(0, 4000), source: source ? `${source}:${line}` : '' });
      if (tab.console.length > MAX_CONSOLE) tab.console.splice(0, tab.console.length - MAX_CONSOLE);
      if (level === 'error') tab.consoleErrors++;
    });
    wc.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.fileChooserOpened') return;
      const chooser = { backendNodeId: params.backendNodeId as number, multiple: params.mode === 'selectMultiple' };
      // The person clicked it in the live view: ask them, as a browser would.
      if (browser.lastUserInputAt > browser.lastAgentAt && Date.now() - browser.lastUserInputAt < 5000) {
        this.chooseFilesForPerson(tab, chooser);
        return;
      }
      tab.fileChooser = chooser;
      browser.note('The page opened a file chooser: call browser_file_upload with the file paths.');
      browser.changed();
    });
    wc.on('context-menu', (_event, params) => {
      if (Date.now() - browser.lastUserInputAt > 2000) return;
      const history = wc.navigationHistory;
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL) {
        template.push(
          { label: 'Open link in new tab', click: () => void browser.newTab(params.linkURL).catch(() => {}) },
          { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        );
      }
      if (params.isEditable) {
        template.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
      } else if (params.selectionText) {
        template.push({ label: 'Copy', click: () => wc.copy() }, { type: 'separator' });
      }
      template.push(
        { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
        { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) }
      );
      const window = this.host.mainWindow();
      if (window) Menu.buildFromTemplate(template).popup({ window });
    });
    wc.once('destroyed', () => {
      if (browser.tabs.includes(tab)) browser.closeTab(tab.id);
    });
  }

  private async chooseFilesForPerson(tab: Tab, chooser: { backendNodeId: number; multiple: boolean }) {
    const window = this.host.mainWindow();
    const options: Electron.OpenDialogOptions = { properties: chooser.multiple ? ['openFile', 'multiSelections'] : ['openFile'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length || !tab.alive) return;
    await tab.cdp('DOM.setFileInputFiles', { files: result.filePaths, backendNodeId: chooser.backendNodeId }).catch(() => {});
  }
}


// The browser tools an agent sees over MCP, and what each one does.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentBrowser, BrowserService, Tab } from './browserService';
import { normalizeUrl, sleep } from './browserUtil';
import { charStroke, parseKey } from './keys';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

const SNAPSHOT_CHARS = 60_000;
const EVALUATE_CHARS = 20_000;

const ref = { type: 'string', description: 'The element ref from the latest browser_snapshot, e.g. "e12".' };
const element = { type: 'string', description: 'What the element is, in a few words, e.g. "Sign in button". Shown to the person watching.' };

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    title: 'Open a URL',
    description: 'Open a URL in the active tab (a tab is opened if there is none) and return the page outline. Accepts localhost addresses and file paths.',
    inputSchema: object({ url: { type: 'string', description: 'The URL. https:// is added when there is no scheme.' } }, ['url']),
    annotations: { openWorldHint: true }
  },
  {
    name: 'browser_navigate_back',
    title: 'Go back',
    description: 'Go back (or forward) in the active tab\'s history.',
    inputSchema: object({ forward: { type: 'boolean', description: 'Go forward instead of back.' } })
  },
  {
    name: 'browser_snapshot',
    title: 'Read the page',
    description: 'The page as an outline of its content and controls (role, name, state), with a ref for each element (e.g. [ref=e12]) that other tools take. Refs stay valid until the page changes; take a new snapshot after navigating or when an element is not found. Cheaper and more exact than a screenshot.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'browser_click',
    title: 'Click',
    description: 'Click an element with the mouse (real input events, like a person).',
    inputSchema: object(
      {
        ref,
        element,
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        double_click: { type: 'boolean' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        force: { type: 'boolean', description: 'Click even when another element covers this one (the covering element gets the click).' }
      },
      ['ref', 'element']
    )
  },
  {
    name: 'browser_type',
    title: 'Type',
    description: 'Type text into a text field, replacing what it holds. Set submit to press Enter afterwards.',
    inputSchema: object(
      {
        ref,
        element,
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        slowly: { type: 'boolean', description: 'Type one key at a time (for pages that react to each keystroke, like autocomplete). Default: insert the text at once.' },
        append: { type: 'boolean', description: 'Keep the current text and add to the end.' }
      },
      ['ref', 'element', 'text']
    )
  },
  {
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Press a key or combination in the focused element: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, "a", "Control+a", "Shift+Tab".',
    inputSchema: object({ key: { type: 'string' } }, ['key'])
  },
  {
    name: 'browser_hover',
    title: 'Hover',
    description: 'Move the mouse over an element (opens hover menus and tooltips).',
    inputSchema: object({ ref, element }, ['ref', 'element'])
  },
  {
    name: 'browser_select_option',
    title: 'Choose an option',
    description: 'Choose options in a native <select> (dropdown or list), by value or visible label.',
    inputSchema: object({ ref, element, values: { type: 'array', items: { type: 'string' } } }, ['ref', 'element', 'values'])
  },
  {
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scroll the page, or the scrollable area under an element, with the mouse wheel. Returns the scroll position.',
    inputSchema: object({
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], description: 'Default down.' },
      amount: { type: 'number', description: 'Pixels; default about 80% of the viewport.' },
      ref: { type: 'string', description: 'Scroll the area under this element instead of the page.' }
    })
  },
  {
    name: 'browser_drag',
    title: 'Drag',
    description: 'Drag one element onto another with the mouse.',
    inputSchema: object({ start_ref: { type: 'string' }, end_ref: { type: 'string' }, start_element: element, end_element: element }, ['start_ref', 'end_ref'])
  },
  {
    name: 'browser_screenshot',
    title: 'Screenshot',
    description: 'A picture of the visible part of the page (or one element, or the whole page). Use browser_snapshot to find refs; screenshots are for checking layout and visuals.',
    inputSchema: object({ ref: { type: 'string', description: 'Only this element.' }, full_page: { type: 'boolean', description: 'The whole scrollable page (up to 8000 pixels tall).' } }),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    description: 'Run JavaScript in the page and return the result as JSON. Pass an expression ("document.title") or a function ("() => [...document.links].length"); promises are awaited.',
    inputSchema: object({ expression: { type: 'string' } }, ['expression'])
  },
  {
    name: 'browser_wait_for',
    title: 'Wait',
    description: 'Wait until text appears or disappears on the page, or for a number of seconds (at most 30).',
    inputSchema: object({ text: { type: 'string' }, text_gone: { type: 'string' }, seconds: { type: 'number' } })
  },
  {
    name: 'browser_tabs',
    title: 'Tabs',
    description: 'List, open, switch to or close tabs.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number', description: 'Tab number from the list (1-based); for select and close. close defaults to the active tab.' },
        url: { type: 'string', description: 'For new: the page to open.' }
      },
      ['action']
    )
  },
  {
    name: 'browser_console_messages',
    title: 'Console messages',
    description: 'The active tab\'s recent console messages (errors and warnings by default).',
    inputSchema: object({ all: { type: 'boolean', description: 'Include info and debug messages too.' } }),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'browser_handle_dialog',
    title: 'Answer dialogs',
    description: 'Set how the next confirm() or prompt() dialog is answered. Dialogs never block the page: by default confirm gets OK and prompt gets its default text, and the result of each step reports any dialog shown. Call this before the action that opens the dialog.',
    inputSchema: object({ accept: { type: 'boolean' }, prompt_text: { type: 'string' } }, ['accept'])
  },
  {
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Choose files for the file chooser a page opened (after clicking an upload button), or click the given element first to open it.',
    inputSchema: object({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' }, ref: { type: 'string', description: 'The upload button or file input to click first.' } }, ['paths'])
  },
  {
    name: 'browser_downloads',
    title: 'Downloads',
    description: 'Files this browser downloaded, with where they were saved.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'browser_resize',
    title: 'Resize',
    description: 'Change the viewport size (for checking responsive layouts). Default 1280×800.',
    inputSchema: object({ width: { type: 'number' }, height: { type: 'number' } }, ['width', 'height'])
  }
];

export const SERVER_INSTRUCTIONS = [
  "These tools drive Foreman's built-in browser: a separate Chromium browser for you, with its own cookies and logins, apart from the person's own browser. It runs off-screen, so using it never takes over their screen, mouse or keyboard.",
  'The person can watch it live in Foreman and may take control at any time; if a tool says the browser is paused, stop and wait for them.',
  'Work from browser_snapshot: it returns the page outline with element refs to click and type into. Use browser_screenshot to check visuals.',
  'Use it for web tasks: testing local dev servers, reading documentation, filling in forms. Ask before submitting anything that spends money, sends messages or changes accounts, and never type passwords or payment details the person did not give you for this.'
].join('\n');

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const fail = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true });

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function str(args: Record<string, any>, key: string, required = false): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (required) throw new Error(`"${key}" is required.`);
  return '';
}

function describeTarget(args: Record<string, any>, point: { element: string }) {
  const label = typeof args.element === 'string' && args.element.trim() ? args.element.trim() : point.element;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

async function snapshotText(browser: AgentBrowser, tab: Tab): Promise<string> {
  const result = await browser.page<{ text: string; truncated: boolean; refs: number }>(tab, 'snapshot', { maxChars: SNAPSHOT_CHARS });
  const outline = result.text || '(the page is empty)';
  return `${browser.statusText()}\n\n${outline}${result.truncated ? '\n\n(The outline was cut off here: the page is long. Scroll and snapshot again, or use browser_evaluate to look for something specific.)' : ''}`;
}

async function pointAt(browser: AgentBrowser, tab: Tab, targetRef: string) {
  return browser.page<{ x: number; y: number; covered: string | null; element: string; rect: { x: number; y: number; width: number; height: number } }>(tab, 'point', targetRef);
}

async function screenshotResult(browser: AgentBrowser, tab: Tab, args: Record<string, any>): Promise<ToolResult> {
  let data: string;
  let caption: string;
  if (args.full_page) {
    const size = await browser.page<{ width: number; height: number }>(tab, 'scrollState');
    const shot = await tab.cdp<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 8000), scale: 1 } },
      30_000
    );
    data = shot.data;
    caption = `Whole page, ${Math.min(size.width, 4000)}×${Math.min(size.height, 8000)}.`;
  } else {
    let image = await browser.screenshot(tab);
    caption = 'Visible part of the page.';
    if (args.ref) {
      const point = await pointAt(browser, tab, String(args.ref));
      await sleep(100);
      image = await browser.screenshot(tab);
      const size = image.getSize();
      const r = point.rect;
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      image = image.crop({ x, y, width: Math.max(1, Math.min(Math.ceil(r.width), size.width - x)), height: Math.max(1, Math.min(Math.ceil(r.height), size.height - y)) });
      caption = `Element ${args.ref} (${point.element}).`;
    }
    data = image.toJPEG(75).toString('base64');
  }
  browser.log('agent', args.ref ? `Took a screenshot of ${args.ref}` : 'Took a screenshot');
  return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `${caption}\n${browser.statusText()}` }] };
}

/** What each tool does. Throwing reports the message to the agent as a tool error. */
const HANDLERS: Record<string, (browser: AgentBrowser, args: Record<string, any>, service: BrowserService) => Promise<ToolResult>> = {
  async browser_navigate(browser, args) {
    const url = normalizeUrl(str(args, 'url', true));
    const tab = await browser.ensureTab();
    browser.log('agent', `Opened ${url}`);
    const problem = await browser.load(tab, url);
    await browser.settle(tab, 300);
    if (problem) browser.note(problem);
    return text(await snapshotText(browser, tab));
  },

  async browser_navigate_back(browser, args) {
    const tab = await browser.ensureTab();
    const history = tab.wc.navigationHistory;
    if (args.forward ? !history.canGoForward() : !history.canGoBack()) return fail(`There is no page to go ${args.forward ? 'forward' : 'back'} to.\n${browser.statusText()}`);
    if (args.forward) history.goForward();
    else history.goBack();
    browser.log('agent', args.forward ? 'Went forward' : 'Went back');
    await browser.settle(tab, 300);
    return text(browser.statusText());
  },

  async browser_snapshot(browser) {
    const tab = await browser.ensureTab();
    browser.log('agent', 'Read the page');
    return text(await snapshotText(browser, tab));
  },

  async browser_click(browser, args) {
    const tab = await browser.ensureTab();
    const point = await pointAt(browser, tab, str(args, 'ref', true));
    const target = describeTarget(args, point);
    if (point.covered && !args.force) {
      browser.log('agent', `Couldn't click ${target}: covered by ${point.covered}`, false);
      return fail(`${target} is covered by ${point.covered}, which would get the click. Close or scroll past it (take a snapshot to find it), or pass force: true.\n${browser.statusText()}`);
    }
    const modifiers = (Array.isArray(args.modifiers) ? args.modifiers : []).reduce((bits: number, m: string) => bits | (MODIFIER_BITS[m] ?? 0), 0);
    await browser.clickAt(tab, point.x, point.y, { button: args.button, clickCount: args.double_click ? 2 : 1, modifiers });
    browser.log('agent', `${args.double_click ? 'Double-clicked' : args.button === 'right' ? 'Right-clicked' : 'Clicked'} ${target}`);
    await browser.settle(tab);
    return text(browser.statusText());
  },

  async browser_type(browser, args) {
    const tab = await browser.ensureTab();
    const targetRef = str(args, 'ref', true);
    const value = typeof args.text === 'string' ? args.text : String(args.text ?? '');
    const point = await pointAt(browser, tab, targetRef);
    const target = describeTarget(args, point);
    await browser.clickAt(tab, point.x, point.y);
    await sleep(50);
    if (!args.append) {
      await browser.page(tab, 'selectContents', targetRef);
      if (!value) await browser.key(tab, parseKey('Delete'));
    } else {
      await browser.key(tab, parseKey('Control+End'));
    }
    if (value) {
      if (args.slowly) {
        for (const char of value) {
          await browser.key(tab, charStroke(char));
          await sleep(20);
        }
      } else {
        await tab.cdp('Input.insertText', { text: value });
      }
    }
    if (args.submit) await browser.key(tab, parseKey('Enter'));
    const shown = /password/i.test(target) ? '••••' : JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);
    browser.log('agent', `Typed ${shown} into ${target}${args.submit ? ' and pressed Enter' : ''}`);
    await browser.settle(tab, args.submit ? 300 : 100);
    return text(browser.statusText());
  },

  async browser_press_key(browser, args) {
    const tab = await browser.ensureTab();
    const combo = str(args, 'key', true);
    await browser.key(tab, parseKey(combo));
    browser.log('agent', `Pressed ${combo}`);
    await browser.settle(tab);
    return text(browser.statusText());
  },

  async browser_hover(browser, args) {
    const tab = await browser.ensureTab();
    const point = await pointAt(browser, tab, str(args, 'ref', true));
    browser.point(point.x, point.y);
    await browser.mouse(tab, 'mouseMoved', point.x, point.y);
    browser.log('agent', `Hovered over ${describeTarget(args, point)}`);
    await browser.settle(tab, 300);
    return text(browser.statusText());
  },

  async browser_select_option(browser, args) {
    const tab = await browser.ensureTab();
    const values: string[] = Array.isArray(args.values) ? args.values.map(String) : typeof args.values === 'string' ? [args.values] : [];
    if (!values.length) throw new Error('"values" is required.');
    const targetRef = str(args, 'ref', true);
    const point = await pointAt(browser, tab, targetRef);
    browser.point(point.x, point.y);
    const chosen = await browser.page<string[]>(tab, 'selectOptions', targetRef, values);
    browser.log('agent', `Chose ${chosen.map((c) => JSON.stringify(c)).join(', ')} in ${describeTarget(args, point)}`);
    await browser.settle(tab);
    return text(`Selected ${chosen.map((c) => JSON.stringify(c)).join(', ')}.\n${browser.statusText()}`);
  },

  async browser_scroll(browser, args) {
    const tab = await browser.ensureTab();
    const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down';
    const vertical = direction === 'up' || direction === 'down';
    const amount = typeof args.amount === 'number' && args.amount > 0 ? args.amount : Math.round((vertical ? browser.viewport.height : browser.viewport.width) * 0.8);
    let x = browser.viewport.width / 2;
    let y = browser.viewport.height / 2;
    if (args.ref) ({ x, y } = await pointAt(browser, tab, String(args.ref)));
    const sign = direction === 'up' || direction === 'left' ? -1 : 1;
    await browser.mouse(tab, 'mouseMoved', x, y);
    await tab.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: vertical ? 0 : sign * amount, deltaY: vertical ? sign * amount : 0 });
    await sleep(350);
    const at = await browser.page<{ x: number; y: number; width: number; height: number; viewWidth: number; viewHeight: number }>(tab, 'scrollState');
    browser.log('agent', `Scrolled ${direction}`);
    const bottom = at.y + at.viewHeight >= at.height - 2;
    return text(`Scrolled ${direction}. Page scroll position: ${at.x}, ${at.y} of ${at.width}×${at.height}${bottom ? ' (at the bottom)' : at.y === 0 ? ' (at the top)' : ''}.\n${browser.statusText()}`);
  },

  async browser_drag(browser, args) {
    const tab = await browser.ensureTab();
    const from = await pointAt(browser, tab, str(args, 'start_ref', true));
    const to = await pointAt(browser, tab, str(args, 'end_ref', true));
    browser.point(from.x, from.y);
    await browser.mouse(tab, 'mouseMoved', from.x, from.y);
    await browser.mouse(tab, 'mousePressed', from.x, from.y);
    for (let step = 1; step <= 8; step++) {
      const x = from.x + ((to.x - from.x) * step) / 8;
      const y = from.y + ((to.y - from.y) * step) / 8;
      await browser.mouse(tab, 'mouseMoved', x, y, { button: 'left' });
      await sleep(25);
    }
    await browser.mouse(tab, 'mouseReleased', to.x, to.y);
    browser.point(to.x, to.y);
    browser.log('agent', `Dragged ${args.start_element || from.element} onto ${args.end_element || to.element}`);
    await browser.settle(tab);
    return text(browser.statusText());
  },

  browser_screenshot: async (browser, args) => screenshotResult(browser, await browser.ensureTab(), args),

  async browser_evaluate(browser, args) {
    const tab = await browser.ensureTab();
    const source = str(args, 'expression', true).trim();
    const isFunction = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(source);
    const expression = isFunction ? `(${source})()` : source;
    const result = await tab.cdp<any>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true }, 30_000);
    browser.log('agent', 'Ran JavaScript in the page', !result.exceptionDetails);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      return fail(`The script threw: ${details.exception?.description ?? details.text ?? 'an error'}`);
    }
    const value = result.result;
    let shown: string;
    if (value.type === 'undefined') shown = 'undefined';
    else if ('value' in value) shown = JSON.stringify(value.value, null, 2) ?? String(value.value);
    else shown = value.description ?? value.type;
    if (shown.length > EVALUATE_CHARS) shown = `${shown.slice(0, EVALUATE_CHARS)}\n… (${shown.length - EVALUATE_CHARS} more characters)`;
    return text(shown);
  },

  async browser_wait_for(browser, args) {
    const tab = await browser.ensureTab();
    const limit = Math.min(Math.max(Number(args.seconds) || (args.text || args.text_gone ? 10 : 1), 0), 30) * 1000;
    const appear = typeof args.text === 'string' && args.text ? args.text : null;
    const gone = typeof args.text_gone === 'string' && args.text_gone ? args.text_gone : null;
    browser.log('agent', appear ? `Waited for "${appear.slice(0, 60)}"` : gone ? `Waited for "${gone.slice(0, 60)}" to go` : `Waited ${Math.round(limit / 1000)} s`);
    if (!appear && !gone) {
      await sleep(limit);
      return text(browser.statusText());
    }
    const deadline = Date.now() + limit;
    while (true) {
      const content = await browser.page<string>(tab, 'pageText').catch(() => '');
      const ok = (!appear || content.includes(appear)) && (!gone || !content.includes(gone));
      if (ok) return text(`${appear ? `"${appear}" is on the page.` : `"${gone}" is gone.`}\n${browser.statusText()}`);
      if (Date.now() > deadline) return fail(`Still waiting after ${Math.round(limit / 1000)} s: ${appear ? `"${appear}" hasn't appeared` : `"${gone}" is still there`}.\n${browser.statusText()}`);
      await sleep(250);
    }
  },

  async browser_tabs(browser, args) {
    const action = args.action ?? 'list';
    const indexed = (n: unknown) => {
      const index = Number(n) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= browser.tabs.length) throw new Error(`There is no tab ${n}; ${browser.tabs.length} are open.`);
      return browser.tabs[index];
    };
    if (action === 'new') {
      const url = args.url ? normalizeUrl(String(args.url)) : undefined;
      await browser.newTab(url);
      browser.log('agent', `Opened a new tab${url ? ` at ${url}` : ''}`);
      if (url) await browser.settle(browser.active!, 300);
    } else if (action === 'select') {
      const tab = indexed(args.index);
      browser.activate(tab.id);
      browser.log('agent', `Switched to tab ${args.index}`);
    } else if (action === 'close') {
      const tab = args.index !== undefined ? indexed(args.index) : browser.active;
      if (tab) browser.closeTab(tab.id);
      browser.log('agent', 'Closed a tab');
    }
    if (!browser.tabs.length) return text('No tabs are open.');
    const list = browser.tabs.map((t, i) => {
      const info = t.info();
      return `${i + 1}. ${t.id === browser.activeId ? '(active) ' : ''}${info.title || '(untitled)'} — ${info.url}`;
    });
    return text(`${list.join('\n')}\n\n${browser.statusText()}`);
  },

  async browser_console_messages(browser, args) {
    const tab = browser.active;
    if (!tab) return text('No tab is open.');
    const entries = tab.console.filter((e) => args.all || e.level === 'error' || e.level === 'warning').slice(-80);
    tab.consoleErrors = 0;
    if (!entries.length) return text(args.all ? 'The console is empty.' : 'No errors or warnings in the console. (all: true includes other messages.)');
    return text(entries.map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ''}`).join('\n'));
  },

  async browser_handle_dialog(browser, args) {
    const tab = await browser.ensureTab();
    await browser.answerNextDialog(tab, Boolean(args.accept), typeof args.prompt_text === 'string' ? args.prompt_text : undefined);
    browser.log('agent', `Set the next dialog's answer to ${args.accept ? 'OK' : 'Cancel'}`);
    return text(`The next confirm() or prompt() on this page will be answered ${args.accept ? `OK${args.prompt_text ? ` with ${JSON.stringify(args.prompt_text)}` : ''}` : 'Cancel'}.`);
  },

  async browser_file_upload(browser, args) {
    const tab = await browser.ensureTab();
    const paths: string[] = (Array.isArray(args.paths) ? args.paths : [args.paths]).filter((p: unknown) => typeof p === 'string' && p).map((p: string) => path.resolve(p));
    if (!paths.length) throw new Error('"paths" is required.');
    const missing = paths.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
    if (missing.length) throw new Error(`Not a file: ${missing.join(', ')}`);
    if (args.ref) {
      tab.fileChooser = null;
      const point = await pointAt(browser, tab, String(args.ref));
      await browser.clickAt(tab, point.x, point.y);
      for (let i = 0; i < 30 && !tab.fileChooser; i++) await sleep(100);
    }
    const chooser = tab.fileChooser;
    if (!chooser) return fail(`No file chooser is open. Click the page's upload button first${args.ref ? ' (clicking that element did not open one)' : ''}, or pass its ref.\n${browser.statusText()}`);
    if (!chooser.multiple && paths.length > 1) return fail('This file chooser takes a single file.');
    await tab.cdp('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
    tab.fileChooser = null;
    browser.log('agent', `Chose ${paths.map((p) => path.basename(p)).join(', ')} for upload`);
    await browser.settle(tab);
    return text(`Chose ${paths.length} file${paths.length === 1 ? '' : 's'}.\n${browser.statusText()}`);
  },

  async browser_downloads(browser) {
    if (!browser.downloads.length) return text('Nothing has been downloaded yet.');
    return text(browser.downloads.map((d) => `${d.name} — ${d.state}${d.state === 'progressing' && d.totalBytes ? ` ${Math.round((d.receivedBytes / d.totalBytes) * 100)}%` : ''} — ${d.path}`).join('\n'));
  },

  async browser_resize(browser, args) {
    const width = Math.round(Math.min(Math.max(Number(args.width) || 0, 320), 3840));
    const height = Math.round(Math.min(Math.max(Number(args.height) || 0, 240), 2400));
    await browser.resize(width, height);
    browser.log('agent', `Resized the viewport to ${width}×${height}`);
    await sleep(200);
    return text(`The viewport is ${width}×${height}.\n${browser.statusText()}`);
  }
};

const PAUSED = "The person watching in Foreman has taken control of this browser, so browser tools are paused. Don't retry: tell them what you were about to do and wait until they hand control back.";

/** Runs one tool call for an agent. Every failure comes back as a tool error, never as a protocol error. */
export async function callTool(service: BrowserService, agentId: string, name: string, args: Record<string, any>): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool ${name}.`);
  const browser = service.ensure(agentId);
  if (browser.paused) return fail(PAUSED);
  return browser.enqueue(async () => {
    if (browser.paused) return fail(PAUSED);
    browser.busy = true;
    browser.lastAgentAt = Date.now();
    browser.changed();
    try {
      return await handler(browser, args ?? {}, service);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      browser.log('agent', `${TOOLS.find((t) => t.name === name)?.title ?? name} failed: ${message.slice(0, 120)}`, false);
      let status = '';
      try {
        status = `\n${browser.statusText()}`;
      } catch {
        // no tab
      }
      return fail(`${message}${status}`);
    } finally {
      browser.busy = false;
      browser.lastAgentAt = Date.now();
      browser.changed();
    }
  });
}

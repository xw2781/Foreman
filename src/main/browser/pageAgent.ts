// The part of the agent browser that runs inside the page, in an isolated
// JavaScript world (the page's own scripts can't see or tamper with it). It
// reads the page as an accessibility-style outline with element refs, and
// turns refs back into elements and on-screen points for the input that the
// main process dispatches through the DevTools protocol.
//
// `installPageAgent` is serialized with Function.prototype.toString, so it must
// be self-contained: no imports, no references to anything outside it.

export const PAGE_WORLD_ID = 1017;

export function installPageAgent() {
  const g = window as any;
  if (g.__foreman) return;

  const refs = new Map<string, WeakRef<Element>>();
  const ids = new WeakMap<Element, string>();
  let nextRef = 1;

  const refOf = (el: Element) => {
    let ref = ids.get(el);
    if (!ref) {
      ref = `e${nextRef++}`;
      ids.set(el, ref);
    }
    refs.set(ref, new WeakRef(el));
    return ref;
  };

  const element = (ref: string): Element => {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`Element ${ref} is not on the page any more. Take a new browser_snapshot to get current refs.`);
    return el;
  };

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
  const INPUT_ROLES: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', color: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox'
  };
  // Roles whose name is their text: shown as one line, unless they contain controls.
  const FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'cell', 'columnheader',
    'rowheader', 'treeitem', 'checkbox', 'radio', 'switch', 'tooltip', 'generic', 'label', 'legend', 'caption'
  ]);
  const LEAF = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'img', 'progressbar', 'meter', 'separator']);
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';

  const clip = (text: string, max: number) => {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const quote = (text: string) => JSON.stringify(text);

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit === 'none' || explicit === 'presentation') return null;
    if (explicit && explicit !== 'generic') return explicit;
    const tag = el.localName;
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
      case 'summary':
        return 'button';
      case 'input': {
        const input = el as HTMLInputElement;
        const type = (input.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden') return null;
        if (input.list && ['text', 'search', 'email', 'tel', 'url'].includes(type)) return 'combobox';
        return INPUT_ROLES[type] ?? 'textbox';
      }
      case 'textarea':
        return 'textbox';
      case 'select': {
        const select = el as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      case 'option':
        return 'option';
      case 'img':
        return el.getAttribute('alt') === '' ? null : 'img';
      case 'svg':
        return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : null;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'header':
        return el.closest('article, aside, main, nav, section') ? null : 'banner';
      case 'footer':
        return el.closest('article, aside, main, nav, section') ? null : 'contentinfo';
      case 'form':
        return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'form' : null;
      case 'dialog':
        return 'dialog';
      case 'ul':
      case 'ol':
      case 'menu':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return 'columnheader';
      case 'fieldset':
      case 'details':
        return 'group';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      case 'hr':
        return 'separator';
      case 'iframe':
      case 'frame':
        return 'iframe';
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return 'textbox';
    return null;
  }

  const textOf = (el: Element) => clip((el as HTMLElement).innerText ?? el.textContent ?? '', 200);

  function nameOf(el: Element, role: string): string {
    const doc = el.ownerDocument;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
      if (text.trim()) return clip(text, 200);
    }
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return clip(aria, 200);
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const control = el as HTMLInputElement;
      const type = (control.getAttribute('type') || '').toLowerCase();
      if (['submit', 'reset', 'button'].includes(type)) return clip(control.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), 200);
      if (type === 'image') return clip(control.alt || control.value || 'Submit', 200);
      const labels = control.labels ? [...control.labels].map((l) => l.innerText).join(' ') : '';
      if (labels.trim()) return clip(labels, 200);
      const placeholder = control.getAttribute('placeholder');
      if (placeholder) return clip(placeholder, 200);
      if (type === 'file') return clip(el.getAttribute('title') || 'Choose file', 200);
      return clip(el.getAttribute('title') ?? '', 200);
    }
    if (tag === 'img') return clip(el.getAttribute('alt') ?? el.getAttribute('title') ?? '', 200);
    if (tag === 'svg') return clip(el.querySelector(':scope > title')?.textContent ?? '', 200);
    if (tag === 'fieldset') return clip(el.querySelector(':scope > legend')?.textContent ?? '', 200);
    if (tag === 'table') return clip((el as HTMLTableElement).caption?.textContent ?? '', 200);
    if (tag === 'iframe' || tag === 'frame') return clip(el.getAttribute('title') ?? el.getAttribute('name') ?? '', 120);
    if (FROM_CONTENT.has(role)) {
      const text = textOf(el);
      if (text) return text;
    }
    return clip(el.getAttribute('title') ?? '', 200);
  }

  function visible(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    if (style.display === 'contents') return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const check = (el as any).checkVisibility;
    return typeof check === 'function' ? check.call(el, { contentVisibilityAuto: true }) : true;
  }

  function isBlock(el: Element) {
    const display = getComputedStyle(el).display;
    return !display.startsWith('inline') && display !== 'contents';
  }

  function clickable(el: Element) {
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    const cursor = getComputedStyle(el).cursor;
    return cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
  }

  function deepActive(): Element | null {
    let active: Element | null = document.activeElement;
    while (active) {
      const inner: Element | null = (active as HTMLIFrameElement).contentDocument?.activeElement ?? active.shadowRoot?.activeElement ?? null;
      if (!inner || inner === active) break;
      active = inner;
    }
    return active;
  }

  function attributes(el: Element, role: string, focused: Element | null): string {
    const out: string[] = [];
    const html = el as HTMLInputElement;
    if (role === 'heading') {
      const level = el.getAttribute('aria-level') ?? (/^h([1-6])$/.exec(el.localName)?.[1] ?? null);
      if (level) out.push(`level=${level}`);
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const aria = el.getAttribute('aria-checked');
      const checked = aria ?? (el.localName === 'input' ? String(html.indeterminate ? 'mixed' : html.checked) : 'false');
      if (checked === 'true') out.push('checked');
      else if (checked === 'mixed') out.push('checked=mixed');
    }
    if (html.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) out.push(`expanded=${expanded}`);
    if (el.getAttribute('aria-selected') === 'true' || (el.localName === 'option' && (el as HTMLOptionElement).selected)) out.push('selected');
    const pressed = el.getAttribute('aria-pressed');
    if (pressed && pressed !== 'false') out.push(pressed === 'true' ? 'pressed' : `pressed=${pressed}`);
    if (html.required || el.getAttribute('aria-required') === 'true') out.push('required');
    if (el === focused) out.push('focused');
    return out.length ? ` [${out.join('] [')}]` : '';
  }

  function valueOf(el: Element, role: string): string | null {
    const tag = el.localName;
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const chosen = [...select.selectedOptions].map((o) => o.label || o.text).join(', ');
      return chosen ? `: ${quote(clip(chosen, 120))}` : null;
    }
    if (tag === 'input' || tag === 'textarea') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') || '').toLowerCase();
      if (['checkbox', 'radio', 'submit', 'reset', 'button', 'image'].includes(type)) return null;
      if (type === 'file') return input.files?.length ? `: ${quote([...input.files].map((f) => f.name).join(', '))}` : null;
      if (!input.value) return null;
      return `: ${quote(type === 'password' ? '•'.repeat(Math.min(input.value.length, 12)) : clip(input.value, 200))}`;
    }
    if (role === 'textbox' && (el as HTMLElement).isContentEditable) {
      const text = textOf(el);
      return text ? `: ${quote(text)}` : null;
    }
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'meter') {
      const now = el.getAttribute('aria-valuenow') ?? (el as HTMLInputElement).value;
      return now ? `: ${now}` : null;
    }
    return null;
  }

  function hrefOf(el: Element): string | null {
    const href = (el as HTMLAnchorElement).href;
    if (!href || href.startsWith('javascript:')) return null;
    try {
      const url = new URL(href);
      const here = new URL(location.href);
      const short = url.origin === here.origin ? `${url.pathname}${url.search}${url.hash}` : href;
      return clip(short, 120);
    } catch {
      return clip(href, 120);
    }
  }

  function snapshot(options: { maxChars: number }): { text: string; truncated: boolean; refs: number } {
    const lines: string[] = [];
    let chars = 0;
    let truncated = false;
    let buffer = '';
    let bufferDepth = 0;
    let count = 0;
    const focused = deepActive();

    const push = (depth: number, line: string) => {
      if (truncated) return;
      const text = `${'  '.repeat(depth)}${line}`;
      if (chars + text.length + 1 > options.maxChars) {
        truncated = true;
        return;
      }
      lines.push(text);
      chars += text.length + 1;
    };
    const flush = () => {
      const text = clip(buffer, 400);
      buffer = '';
      if (text) push(bufferDepth, `- text: ${quote(text)}`);
    };
    const addText = (text: string, depth: number) => {
      if (!text.trim()) {
        if (buffer) buffer += ' ';
        return;
      }
      if (!buffer.trim()) bufferDepth = depth;
      buffer += text;
    };

    const childrenOf = (node: Element | Document | ShadowRoot): ArrayLike<Node> => {
      if (node instanceof Element) {
        if (node.shadowRoot) return node.shadowRoot.childNodes;
        if (node.localName === 'slot') {
          const assigned = (node as HTMLSlotElement).assignedNodes({ flatten: true });
          if (assigned.length) return assigned;
        }
      }
      return node.childNodes;
    };

    const walk = (node: Element | Document | ShadowRoot, depth: number) => {
      const kids = childrenOf(node);
      for (let i = 0; i < kids.length && !truncated; i++) visit(kids[i], depth);
    };

    const visit = (node: Node, depth: number) => {
      if (node.nodeType === Node.TEXT_NODE) {
        addText((node as Text).data, depth);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (SKIP.has(el.localName) || !visible(el)) return;
      const role = roleOf(el) ?? (clickable(el) ? 'generic' : null);
      if (!role) {
        const block = isBlock(el);
        if (block) flush();
        walk(el, depth);
        if (block) flush();
        return;
      }
      flush();
      count++;
      const name = nameOf(el, role);
      let line = `- ${role}${name ? ` ${quote(name)}` : ''}${attributes(el, role, focused)}${role === 'generic' ? ' [clickable]' : ''} [ref=${refOf(el)}]`;
      const value = valueOf(el, role);
      if (role === 'link') {
        const href = hrefOf(el);
        if (href) line += ` [url=${href}]`;
      }
      if (role === 'iframe') {
        let inner: Document | null = null;
        try {
          inner = (el as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        if (!inner?.body) {
          push(depth, `${line} (another site's frame; its content isn't shown — use browser_screenshot to see it)`);
          return;
        }
        push(depth, `${line}:`);
        walk(inner.body, depth + 1);
        flush();
        return;
      }
      if (el.localName === 'select') {
        push(depth, `${line}${value ?? ''}:`);
        const options = (el as HTMLSelectElement).options;
        for (let i = 0; i < options.length && i < 60; i++) {
          const option = options[i];
          push(depth + 1, `- option ${quote(clip(option.label || option.text, 120))}${option.selected ? ' [selected]' : ''}`);
        }
        if (options.length > 60) push(depth + 1, `- … ${options.length - 60} more options`);
        return;
      }
      const leaf = LEAF.has(role) || (FROM_CONTENT.has(role) && name && !el.querySelector(INTERACTIVE));
      if (leaf) {
        push(depth, `${line}${value ?? ''}`);
        return;
      }
      const at = lines.length;
      push(depth, line);
      walk(el, depth + 1);
      flush();
      if (lines.length > at + 1 && lines[at] === `${'  '.repeat(depth)}${line}`) lines[at] += ':';
    };

    if (document.body) walk(document.body, 0);
    flush();
    return { text: lines.join('\n'), truncated, refs: count };
  }

  function describe(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const text = textOf(el);
    return `<${el.localName}${id}${cls}>${text ? ` "${clip(text, 60)}"` : ''}`;
  }

  /** Scrolls the element into view and returns its center in top-level page pixels. */
  function point(ref: string): { x: number; y: number; covered: string | null; element: string; rect: { x: number; y: number; width: number; height: number } } {
    const el = element(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const box = rects[0] ?? el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) throw new Error(`Element ${ref} (${describe(el)}) has no size on the page; it may be hidden. Take a new browser_snapshot.`);
    let x = box.left + box.width / 2;
    let y = box.top + box.height / 2;
    const doc = el.ownerDocument;
    const hit = doc.elementFromPoint(x, y);
    let covered: string | null = null;
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const labels = (el as HTMLInputElement).labels;
      const viaLabel = labels ? [...labels].some((label) => label === hit || label.contains(hit)) : false;
      if (!viaLabel) covered = describe(hit);
    }
    let offsetX = 0;
    let offsetY = 0;
    let win: Window | null = doc.defaultView;
    while (win && win.frameElement) {
      const frame = win.frameElement as HTMLElement;
      const r = frame.getBoundingClientRect();
      offsetX += r.left + frame.clientLeft;
      offsetY += r.top + frame.clientTop;
      win = win.parent;
    }
    x += offsetX;
    y += offsetY;
    return { x, y, covered, element: describe(el), rect: { x: box.left + offsetX, y: box.top + offsetY, width: box.width, height: box.height } };
  }

  /** Selects the element's current text, so typing replaces it. */
  function selectContents(ref: string): string {
    const el = element(ref) as HTMLElement;
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea') {
      const input = el as HTMLInputElement;
      input.focus();
      try {
        input.select();
      } catch {
        // types without text selection (number, email in some engines)
      }
      return 'input';
    }
    if (el.isContentEditable) {
      el.focus();
      const selection = el.ownerDocument.getSelection();
      selection?.selectAllChildren(el);
      return 'editable';
    }
    throw new Error(`Element ${ref} (${describe(el)}) isn't a text field.`);
  }

  function selectOptions(ref: string, values: string[]): string[] {
    const el = element(ref);
    if (el.localName !== 'select') throw new Error(`Element ${ref} (${describe(el)}) isn't a native <select>. Click it, then click the option in a new snapshot.`);
    const select = el as HTMLSelectElement;
    const wanted = values.map((v) => v.trim().toLowerCase());
    const chosen: string[] = [];
    const options = [...select.options];
    for (const want of wanted) {
      const option = options.find((o) => o.value.toLowerCase() === want) ?? options.find((o) => (o.label || o.text).trim().toLowerCase() === want)
        ?? options.find((o) => (o.label || o.text).trim().toLowerCase().includes(want));
      if (!option) throw new Error(`No option "${want}" in ${describe(el)}. Options: ${options.slice(0, 30).map((o) => JSON.stringify(o.label || o.text)).join(', ')}`);
      if (!chosen.includes(option.label || option.text)) chosen.push(option.label || option.text);
    }
    if (!select.multiple && chosen.length > 1) throw new Error('This list takes a single choice.');
    for (const option of options) {
      const selected = chosen.includes(option.label || option.text);
      if (select.multiple || selected) option.selected = selected;
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return chosen;
  }

  function pageText(): string {
    return document.body?.innerText ?? '';
  }

  function scrollState() {
    const root = document.scrollingElement ?? document.documentElement;
    return { x: Math.round(scrollX), y: Math.round(scrollY), width: root.scrollWidth, height: root.scrollHeight, viewWidth: innerWidth, viewHeight: innerHeight };
  }

  g.__foreman = { snapshot, point, selectContents, selectOptions, pageText, scrollState };
}

/** Code for `executeJavaScriptInIsolatedWorld`: installs the page agent (once per document) and calls one of its functions. */
export function pageCall(fn: 'snapshot' | 'point' | 'selectContents' | 'selectOptions' | 'pageText' | 'scrollState', ...args: unknown[]): string {
  // Errors thrown in an isolated world reach the main process only as "Script failed to execute": return them instead.
  return `(${installPageAgent.toString()})(); (() => { try { return { value: window.__foreman.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')}) }; } catch (error) { return { error: String((error && error.message) || error) }; } })();`;
}

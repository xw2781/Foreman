// Key names ("Enter", "Control+a", "Shift+Tab") as DevTools-protocol key events.

export const MODIFIER = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export interface KeyStroke {
  key: string;
  code: string;
  keyCode: number;
  /** Text the key types; empty for keys that type nothing (and whenever Control, Alt or Meta is held). */
  text: string;
  modifiers: number;
}

const NAMED: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
};
for (let n = 1; n <= 12; n++) NAMED[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

const MODIFIER_NAMES: Record<string, number> = {
  control: MODIFIER.Control,
  ctrl: MODIFIER.Control,
  controlormeta: MODIFIER.Control,
  shift: MODIFIER.Shift,
  alt: MODIFIER.Alt,
  option: MODIFIER.Alt,
  meta: MODIFIER.Meta,
  cmd: MODIFIER.Meta,
  command: MODIFIER.Meta,
  win: MODIFIER.Meta
};

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 }
};

/** One character as the key that types it (the US layout for punctuation). */
export function charStroke(char: string, modifiers = 0): KeyStroke {
  const typesText = !(modifiers & (MODIFIER.Control | MODIFIER.Alt | MODIFIER.Meta));
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase();
    const key = modifiers & MODIFIER.Shift ? upper : char;
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: typesText ? key : '', modifiers };
  }
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: typesText ? char : '', modifiers };
  if (char === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: typesText ? ' ' : '', modifiers };
  if (char === '\n' || char === '\r') return { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers };
  const punctuation = PUNCTUATION[char];
  return { key: char, code: punctuation?.code ?? '', keyCode: punctuation?.keyCode ?? 0, text: typesText ? char : '', modifiers };
}

/** Parses "Enter", "a", "Control+Shift+K", "Shift+Tab". Throws on an unknown key name. */
export function parseKey(combo: string): KeyStroke {
  const trimmed = combo.trim();
  if (!trimmed) throw new Error('No key given.');
  // "+" alone, or a combination ending in "+" ("Control++"), means the plus key.
  const parts = trimmed === '+' ? ['+'] : trimmed.endsWith('++') ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed.split('+');
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_NAMES[part.trim().toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${combo}". Use Control, Shift, Alt or Meta.`);
    modifiers |= modifier;
  }
  const last = parts[parts.length - 1];
  const name = last.trim().toLowerCase();
  if (MODIFIER_NAMES[name] && parts.length === 1) {
    const key = { control: 'Control', ctrl: 'Control', controlormeta: 'Control', shift: 'Shift', alt: 'Alt', option: 'Alt' }[name] ?? 'Meta';
    const codes: Record<string, [string, number]> = { Control: ['ControlLeft', 17], Shift: ['ShiftLeft', 16], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91] };
    return { key, code: codes[key][0], keyCode: codes[key][1], text: '', modifiers };
  }
  const named = NAMED[name];
  if (named) {
    const typesText = named.text && !(modifiers & (MODIFIER.Control | MODIFIER.Alt | MODIFIER.Meta));
    return { key: named.key, code: named.code, keyCode: named.keyCode, text: typesText ? named.text! : '', modifiers };
  }
  if ([...last].length === 1) return charStroke(last, modifiers);
  throw new Error(`Unknown key "${last}". Use a name like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, or a single character.`);
}

/** Only web URLs and local paths are actionable in assistant Markdown. */
export function chatLinkKind(href: string): 'web' | 'file' | 'unsupported' {
  if (!href || /[\u0000-\u001f]/.test(href)) return 'unsupported';
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) return 'web';
  if (/^file:\/\//i.test(href) || /^[a-z]:[\\/]/i.test(href)) return 'file';
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return 'unsupported';
  return 'file';
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
/** file:// URL, drive path or UNC path. */
const ABSOLUTE = String.raw`(?:file:\/\/|[a-z]:[\\/]|\\\\[^\\\s])`;
/** `[label](path with spaces)`: one level of parentheses may sit inside the path. */
const SPACED_LINK = /\[([^\]\n]+)\]\((?!<)((?:[^()\n]|\([^()\n]*\))*?\s(?:[^()\n]|\([^()\n]*\))*?)\)/g;
const ANGLE_LINK = new RegExp(String.raw`(?<!\]\()<(${ABSOLUTE}[^<>\n]*)>`, 'gi');
const BARE_FILE_URL = /(?<![\w(<[/])file:\/\/\/?[^\s<>()[\]"'`]+/gi;
const PATH_START = new RegExp(String.raw`^(?:${ABSOLUTE}|~[\\/]|\.{0,2}[\\/])`, 'i');
const PATH_END = /\.\w{1,8}(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)?$/i;
const LINE_ANCHOR = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i;

/** A destination Markdown accepts as written: no spaces or brackets, UNC as a file URL. */
function encodeFileHref(raw: string): string {
  let href = raw.trim().replace(/\\/g, '/');
  if (href.startsWith('//')) href = `file:${href}`;
  href = href.replace(/^file:\/\/([a-z]:)/i, 'file:///$1');
  const anchor = LINE_ANCHOR.exec(href)?.[0] ?? '';
  const body = anchor ? href.slice(0, -anchor.length) : href;
  return body
    .replace(/%(?![\da-f]{2})/gi, '%25')
    .replace(/[\s<>()[\]#?$]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`) + anchor;
}

function fileLabel(raw: string): string {
  const parts = raw.trim().replace(LINE_ANCHOR, '').split(/[\\/]/).filter(Boolean);
  let name = parts.at(-1) ?? raw;
  try { name = decodeURIComponent(name); } catch { /* keep as written */ }
  return name.replace(/[\\`*_[\]<>~$]/g, '\\$&');
}

function fixFileLinks(text: string): string {
  return text
    .replace(SPACED_LINK, (whole, label: string, dest: string) => {
      const path = dest.trim();
      // `[text](url "title")` is already valid Markdown.
      if (/\s["'][^"']*["']$/.test(path) || /^https?:/i.test(path) || chatLinkKind(path) !== 'file') return whole;
      if (!PATH_START.test(path) && !PATH_END.test(path)) return whole;
      return `[${label}](${encodeFileHref(path)})`;
    })
    .replace(ANGLE_LINK, (_whole, dest: string) => `[${fileLabel(dest)}](${encodeFileHref(dest)})`)
    .replace(BARE_FILE_URL, (whole) => {
      const url = whole.replace(/[.,;:!?]+$/, '');
      return `[${fileLabel(url)}](${encodeFileHref(url)})${whole.slice(url.length)}`;
    });
}

/**
 * Repairs file links that agents write but Markdown rejects, so they render as links instead of
 * raw text: `<file:///C:/My Docs/a.xlsx>` and `<C:\My Docs\a.xlsx>` (an autolink can't hold
 * spaces or start with a drive letter), `[a](C:/My Docs/a.xlsx)` (a destination with spaces
 * needs angle brackets) and a bare `file:///C:/a.xlsx`. Code fences and code spans are left alone.
 */
export function normalizeFileLinks(text: string): string {
  if (!/file:\/\/|\]\(|<[a-z]:[\\/]|<\\\\/i.test(text)) return text;
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    let out = '';
    let last = 0;
    for (const span of line.matchAll(CODE_SPAN)) {
      out += fixFileLinks(line.slice(last, span.index)) + span[0];
      last = span.index + span[0].length;
    }
    return out + fixFileLinks(line.slice(last));
  }).join('\n');
}

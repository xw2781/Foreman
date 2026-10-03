/** Only web URLs and local paths are actionable in assistant Markdown. */
export function chatLinkKind(href: string): 'web' | 'file' | 'unsupported' {
  if (!href || /[\u0000-\u001f]/.test(href)) return 'unsupported';
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) return 'web';
  if (/^file:\/\//i.test(href) || /^[a-z]:[\\/]/i.test(href)) return 'file';
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return 'unsupported';
  return 'file';
}

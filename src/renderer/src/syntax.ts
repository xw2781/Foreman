import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('sql', sql);

const EXTENSIONS: Record<string, string> = {
  py: 'python', pyw: 'python', sql: 'sql', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'bash', bash: 'bash', ps1: 'powershell', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', java: 'java',
  kt: 'kotlin', lua: 'lua', php: 'php', rb: 'ruby', rs: 'rust', swift: 'swift'
};

export function fileLanguage(file: string): string | undefined {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const extension = name.split('.').pop() ?? '';
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
}

/** Only the highlighter's escaped markup is rendered as HTML. Unknown/large input stays plain text. */
export function highlightCode(text: string, language?: string): string | null {
  const name = language?.toLowerCase();
  if (!name || text.length > 100_000 || !hljs.getLanguage(name)) return null;
  try {
    return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

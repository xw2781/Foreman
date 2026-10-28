import { describe, expect, it } from 'vitest';
import { fileLanguage, highlightCode } from '../src/renderer/src/syntax';

describe('preview syntax highlighting', () => {
  it('maps file extensions and highlights Python and SQL', () => {
    expect(fileLanguage('src/EXAMPLE.PY')).toBe('python');
    expect(fileLanguage('C:\\project\\query.sql')).toBe('sql');
    expect(highlightCode('def hello():\n    return "world"', 'python')).toContain('hljs-keyword');
    expect(highlightCode('SELECT name FROM users WHERE id = 42;', 'sql')).toContain('hljs-keyword');
  });
  it('escapes HTML in highlighted code', () => {
    const html = highlightCode('value = "<img src=x onerror=alert(1)>"', 'python');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
  it('falls back to plain text for unknown languages and large files', () => {
    expect(fileLanguage('report.txt')).toBeUndefined();
    expect(fileLanguage('file.constructor')).toBeUndefined();
    expect(highlightCode('<script>alert(1)</script>', 'unknown')).toBeNull();
    expect(highlightCode('x'.repeat(100_001), 'python')).toBeNull();
    expect(highlightCode('unlabelled')).toBeNull();
  });
});

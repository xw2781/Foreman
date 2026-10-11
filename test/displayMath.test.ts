import { describe, expect, it } from 'vitest';
import { normalizeDisplayMath } from '../src/renderer/src/displayMath';

describe('display math fences', () => {
  it('keeps the first line of math opened and closed on content lines', () => {
    expect(normalizeDisplayMath('Y:\n\n$$Y=\\begin{pmatrix}1\\end{pmatrix}\n\\begin{matrix}a\\end{matrix}$$\n\n**next**')).toBe(
      'Y:\n\n$$\nY=\\begin{pmatrix}1\\end{pmatrix}\n\\begin{matrix}a\\end{matrix}\n$$\n\n**next**'
    );
  });

  it('makes a whole-line $$…$$ a display block', () => {
    expect(normalizeDisplayMath('so:\n$$a+b\\qquad(3\\text{-}10)$$\nthen')).toBe('so:\n$$\na+b\\qquad(3\\text{-}10)\n$$\nthen');
  });

  it('leaves well-formed blocks, inline math and code alone', () => {
    const text = '$$\nx\n$$\n\ncost $5 and $$x$$ inline\n\n```tex\n$$a\nb$$\n```';
    expect(normalizeDisplayMath(text)).toBe(text);
  });

  it('keeps list indentation and text after the closing fence', () => {
    expect(normalizeDisplayMath('- item\n  $$a\n  b$$ (1)')).toBe('- item\n  $$\n  a\n  b\n  $$\n  (1)');
  });
});

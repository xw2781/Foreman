import { describe, expect, it } from 'vitest';
import { escapeCurrencyDollars, normalizeDisplayMath } from '../src/renderer/src/displayMath';
import { toString } from 'mdast-util-to-string';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

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

describe('currency dollars', () => {
  it('escapes two prices in one paragraph', () => {
    expect(escapeCurrencyDollars("I did not change the $8.02 in the tracker row. Set it to about $5.5 or scale it.")).toBe(
      "I did not change the \\$8.02 in the tracker row. Set it to about \\$5.5 or scale it."
    );
  });

  it('escapes price ranges and lone dollars', () => {
    expect(escapeCurrencyDollars('costs $5-$10, or $ 3')).toBe('costs \\$5-\\$10, or \\$ 3');
    expect(escapeCurrencyDollars('just $5.')).toBe('just \\$5.');
  });

  it('keeps inline math', () => {
    const text = 'time $O(n \\log n)$ where $x = 5$ and $\\alpha$, plus $$a$$ inline';
    expect(escapeCurrencyDollars(text)).toBe(text);
  });

  it('keeps math after a price', () => {
    expect(escapeCurrencyDollars('pay $8.02 and solve $x^2$')).toBe('pay \\$8.02 and solve $x^2$');
  });

  it('leaves code, display math and existing escapes alone', () => {
    const text = 'run `echo $HOME $5` and \\$5 then $x$\n\n```sh\necho $a $5\n```\n\n$$\na $ b\n$$';
    expect(escapeCurrencyDollars(text)).toBe(text);
  });

  it('does not pair across paragraphs', () => {
    expect(escapeCurrencyDollars('$5 here\n\nthere $x')).toBe('\\$5 here\n\nthere \\$x');
  });

  it('renders prices as text through remark-math', () => {
    const tree = unified().use(remarkParse).use(remarkMath).parse(escapeCurrencyDollars('the $8.02 row, about $5.5, and $x$'));
    const kinds: string[] = [];
    visit(tree, (node) => void kinds.push(node.type));
    expect(kinds.filter((k) => k === 'inlineMath')).toHaveLength(1);
    expect(toString(tree)).toBe('the $8.02 row, about $5.5, and x');
  });
});

import { describe, expect, it } from 'vitest';
import { extractNextSteps } from '../src/renderer/src/nextSteps';

const prompts = (text: string) => extractNextSteps(text).map((step) => step.prompt);

describe('next steps', () => {
  it('lifts the list closing a message', () => {
    const text = 'Done — the parser now handles CRLF.\n\n## Next steps\n\n1. Add tests for `parse()`\n2. Update the README\n';
    expect(prompts(text)).toEqual(['Add tests for `parse()`', 'Update the README']);
  });

  it('accepts a colon line or bold intro, and a short sign-off after', () => {
    expect(prompts('Fixed.\n\nWant me to:\n- run the migration\n- open a PR\n\nLet me know which.')).toEqual(['run the migration', 'open a PR']);
    expect(prompts('Fixed.\n\n**Suggested follow-ups**\n* Bump the version\n')).toEqual(['Bump the version']);
  });

  it('splits a bold lead-in into title and detail', () => {
    const [step] = extractNextSteps('Next steps:\n- **Run the tests** — to confirm nothing else broke\n');
    expect(step).toEqual({ prompt: 'Run the tests — to confirm nothing else broke', title: 'Run the tests', detail: 'to confirm nothing else broke' });
  });

  it('joins wrapped lines and leaves nested lists out', () => {
    expect(prompts('Next steps:\n- Refactor the store\n  so it is testable\n  - detail a\n- Ship it\n')).toEqual(['Refactor the store so it is testable', 'Ship it']);
  });

  it('ignores lists that are not the ending', () => {
    expect(prompts('## Recommendations\n- Use X\n- Use Y\n\n## Details\nA long explanation of everything that happened here.')).toEqual([]);
    expect(prompts('Next steps:\n- a\n\n```\ncode\n```\n')).toEqual([]);
  });

  it('ignores plain lists and long lists', () => {
    expect(prompts('Changed files:\n- a.ts\n- b.ts\n')).toEqual([]);
    expect(prompts('Here is what I did.')).toEqual([]);
    expect(prompts(`Next steps:\n${Array.from({ length: 9 }, (_, i) => `- step ${i}`).join('\n')}\n`)).toEqual([]);
  });

  it('does not read intros inside code', () => {
    expect(prompts('```\nNext steps:\n- x\n```\n')).toEqual([]);
  });
});

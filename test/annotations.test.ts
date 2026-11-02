import { describe, expect, it } from 'vitest';
import { annotatedMessage, parseAnnotatedMessage } from '../src/renderer/src/annotations';

describe('chat annotations', () => {
  it('reads quotes, contexts, comments and the follow-up back out of a sent message', () => {
    const quotes = [
      { id: 'a', text: 'first line\n\nsecond line', comment: 'why this?\nreally' },
      { id: 'b', text: 'Done', comment: '', context: '…tests pass. [[Done]] with the build…' },
      { id: 'c', text: 'Done', comment: 'and this', context: '[[Done]].' }
    ];
    const message = annotatedMessage('Fix both.', quotes);
    expect(message).toContain('the one meant is marked [[here]]: …tests pass. [[Done]] with the build…');
    expect(parseAnnotatedMessage(message)).toEqual({
      quotes: [
        { text: 'first line\n\nsecond line', comment: 'why this?\nreally' },
        { text: 'Done', comment: '', context: '…tests pass. [[Done]] with the build…' },
        { text: 'Done', comment: 'and this', context: '[[Done]].' }
      ],
      text: 'Fix both.'
    });
    expect(parseAnnotatedMessage(annotatedMessage('', quotes.slice(1, 2)))?.text).toBe('');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseAnnotatedMessage('Selected text from this conversation:\n\nnot a quote')).toBeNull();
    expect(parseAnnotatedMessage('hello')).toBeNull();
  });
});

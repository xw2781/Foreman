import { describe, expect, it } from 'vitest';
import { claudeLoginUrl } from '../src/main/loginUrl';

const url =
  'https://claude.com/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&scope=user%3Aprofile&code_challenge=xyz&state=s1';

describe('claudeLoginUrl', () => {
  it('joins a URL broken across rows once the prompt appears', () => {
    const rows = url.match(/.{1,40}/g)!.join('\r\n');
    const out = `Browser didn't open? Use the url below\r\n\x1b[2m${rows}\x1b[0m\r\n\r\nPaste code here if prompted > `;
    expect(claudeLoginUrl(out)).toBe(url);
  });

  it('waits for the prompt', () => {
    expect(claudeLoginUrl(url.slice(0, 60))).toBeNull();
    expect(claudeLoginUrl(url)).toBeNull();
  });

  it('ignores other hosts and paths', () => {
    expect(claudeLoginUrl(`${url.replace('claude.com', 'evil.com')}\r\nPaste code here if prompted`)).toBeNull();
    expect(claudeLoginUrl(`${url.replace('/oauth/authorize', '/x')}\r\nPaste code here if prompted`)).toBeNull();
  });
});

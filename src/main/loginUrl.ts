/** Read the complete URL only after Claude has finished printing its login prompt. */
export function claudeLoginUrl(output: string): string | null {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\r\n]/g, '');
  const prompt = plain.lastIndexOf('Paste code here if prompted');
  if (prompt < 0) return null;
  const matches = [...plain.slice(0, prompt).matchAll(/https:\/\/[^\s"'<>\x00-\x1f]+/g)];
  for (const match of matches.reverse()) {
    try {
      const url = new URL(match[0]);
      if (url.origin !== 'https://claude.com' && url.origin !== 'https://claude.ai') continue;
      if (url.pathname !== '/oauth/authorize') continue;
      if (!['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge'].every((key) => url.searchParams.get(key))) continue;
      if (url.searchParams.get('response_type') !== 'code') continue;
      return match[0];
    } catch { /* Incomplete or invalid terminal output. */ }
  }
  return null;
}

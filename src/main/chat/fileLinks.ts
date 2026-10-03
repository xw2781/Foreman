import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatLinkKind } from '../../shared/chatLinks';

/** Resolve against the session, never Electron's own working directory. */
export function resolveChatFile(href: string, cwd: string, home: string): string {
  if (chatLinkKind(href) !== 'file') throw new Error('This link is not a local file path.');
  const windows = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\\\');
  const paths = windows ? path.win32 : path.posix;
  let target: string;
  try {
    if (/^file:\/\//i.test(href)) {
      const url = new URL(href);
      url.hash = '';
      url.search = '';
      target = fileURLToPath(url, { windows });
    } else {
      // Source links often carry a line/column suffix; the OS opens the file itself.
      target = decodeURIComponent(href.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i, ''));
    }
  } catch {
    throw new Error('This file link contains an invalid path.');
  }
  target = target.replace(/:\d+(?::\d+)?$/, '');
  if (/[\u0000-\u001f]/.test(target)) throw new Error('This file link contains an invalid path.');
  if (windows && /^\/[a-z]:[\\/]/i.test(target)) target = target.slice(1);
  if (target === '~') target = home;
  else if (/^~[\\/]/.test(target)) target = paths.join(home, target.slice(2));
  return paths.resolve(cwd, target);
}

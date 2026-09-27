// The composer's command menu: what's being typed, and which commands match it.
import type { ChatCommand } from '@shared/types';

/** The command or skill being typed at the caret: a "/name" opening the message, or a Codex "$skill" anywhere. */
interface CommandToken {
  trigger: '/' | '$';
  query: string;
  start: number;
  end: number;
}

export function commandToken(text: string, caret: number, skillMentions: boolean): CommandToken | null {
  const before = text.slice(0, caret);
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { trigger: '/', query: slash[1], start: 0, end };
  const dollar = skillMentions ? /(?:^|\s)\$([\w:.-]*)$/.exec(before) : null;
  if (dollar) return { trigger: '$', query: dollar[1], start: caret - dollar[1].length - 1, end };
  return null;
}

/**
 * Name matches first (from the start, then from a word start, then anywhere),
 * then aliases, then a word in the description (for three letters or more;
 * fewer match nearly everything).
 */
export function rankCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/);
  const score = (c: ChatCommand) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (words(name).some((word) => word.startsWith(q))) return 1;
    if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    if (q.length >= 3 && words(c.description).some((word) => word.startsWith(q))) return 4;
    return -1;
  };
  return commands
    .map((c) => ({ c, s: score(c) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((r) => r.c);
}

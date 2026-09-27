import { describe, expect, it } from 'vitest';
import { commandToken, rankCommands } from '../src/renderer/src/commands';
import { mentionedSkills } from '../src/main/chat/codexChat';
import type { ChatCommand } from '../src/shared/types';

const command = (name: string, extra: Partial<ChatCommand> = {}): ChatCommand => ({ name, trigger: '/', kind: 'command', description: '', argumentHint: null, aliases: [], ...extra });

describe('command menu', () => {
  it('finds the command being typed at the start of a message', () => {
    expect(commandToken('/', 1, false)).toEqual({ trigger: '/', query: '', start: 0, end: 1 });
    expect(commandToken('/comp', 5, false)).toEqual({ trigger: '/', query: 'comp', start: 0, end: 5 });
    // The whole word is replaced, even with the caret inside it.
    expect(commandToken('/compact now', 3, false)).toEqual({ trigger: '/', query: 'co', start: 0, end: 8 });
    // Past the command, or a slash later on, is just text.
    expect(commandToken('/compact now', 12, false)).toBeNull();
    expect(commandToken('see /tmp', 8, false)).toBeNull();
  });

  it('finds a Codex skill mention anywhere', () => {
    expect(commandToken('use $pd', 7, true)).toEqual({ trigger: '$', query: 'pd', start: 4, end: 7 });
    expect(commandToken('$', 1, true)).toEqual({ trigger: '$', query: '', start: 0, end: 1 });
    expect(commandToken('use $pd', 7, false)).toBeNull();
    expect(commandToken('cost is 5$x', 11, true)).toBeNull();
  });

  it('ranks name matches before aliases and descriptions', () => {
    const list = [
      command('usage', { aliases: ['cost'] }),
      command('context', { description: 'Show current context usage' }),
      command('anthropic-skills:pdf'),
      command('compact'),
      command('security-review')
    ];
    expect(rankCommands(list, '').map((c) => c.name)).toEqual(list.map((c) => c.name));
    expect(rankCommands(list, 'co').map((c) => c.name)).toEqual(['context', 'compact', 'usage']);
    expect(rankCommands(list, 'pdf').map((c) => c.name)).toEqual(['anthropic-skills:pdf']);
    expect(rankCommands(list, 'review').map((c) => c.name)).toEqual(['security-review']);
    expect(rankCommands(list, 'usage').map((c) => c.name)).toEqual(['usage', 'context']);
    // Short queries don't reach into descriptions, and descriptions match by word ("update" isn't "pd").
    const skills = [command('pdf:pdf'), command('skill-creator', { description: 'Create or update a skill' })];
    expect(rankCommands(skills, 'pd').map((c) => c.name)).toEqual(['pdf:pdf']);
    expect(rankCommands(skills, 'upd').map((c) => c.name)).toEqual(['skill-creator']);
    expect(rankCommands(skills, 'dat').map((c) => c.name)).toEqual([]);
  });
});

describe('Codex skill mentions', () => {
  const skills = [
    { name: 'pdf:pdf', path: 'p', description: '' },
    { name: 'imagegen', path: 'i', description: '' }
  ];

  it('matches full and short names, once each', () => {
    expect(mentionedSkills('$pdf:pdf then $pdf, and $imagegen.', skills).map((s) => s.name)).toEqual(['pdf:pdf', 'imagegen']);
    expect(mentionedSkills('costs $5 and $unknown', skills)).toEqual([]);
    expect(mentionedSkills('no$pdf', skills)).toEqual([]);
  });
});

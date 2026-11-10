import { describe, expect, it } from 'vitest';
import { summarizeCommand } from '../src/main/chat/shellCommand';
import { claudeToolEntry } from '../src/main/chat/claudeTools';
import { codexItemEntry } from '../src/main/chat/codexItems';

const named = (command: string) => {
  const summary = summarizeCommand(command);
  return summary ? [summary.title, summary.detail] : null;
};

describe('shell command summaries', () => {
  it('names commands that read files', () => {
    expect(named('Get-Content src\\main\\util.ts')).toEqual(['Read', 'util.ts']);
    expect(named('Get-Content -Path "E:\\My Repo\\a.ts" -TotalCount 40')).toEqual(['Read', 'a.ts']);
    expect(named('cat a.txt b.txt')).toEqual(['Read', 'a.txt, b.txt']);
    expect(named('cd src && head -n 20 index.ts')).toEqual(['Read', 'index.ts']);
    expect(named("sed -n '10,40p' src/app.ts")).toEqual(['Read', 'app.ts']);
    expect(named('Get-Content log.txt -Tail 50 | Select-Object -First 5')).toEqual(['Read', 'log.txt']);
    expect(named('cat a 2>/dev/null; echo ---; cat b; cat c; cat d')).toEqual(['Read', 'a, b, c +1']);
  });

  it('names searches and listings', () => {
    expect(named('rg -n "tool_use" src')).toEqual(['Searched', 'tool_use']);
    expect(named('grep -rn -A 3 foo .')).toEqual(['Searched', 'foo']);
    expect(named('Select-String -Path *.ts -Pattern "a|b"')).toEqual(['Searched', 'a|b']);
    expect(named('git grep -n needle')).toEqual(['Searched', 'needle']);
    expect(named('Get-ChildItem -Recurse src | Select-String todo')).toEqual(['Searched', 'todo']);
    expect(named('Get-ChildItem src -Recurse -Filter *.ts')).toEqual(['Listed files', 'src']);
    expect(named('ls')).toEqual(['Listed files', null]);
    expect(named('find . -name "*.md"')).toEqual(['Listed files', null]);
  });

  it('leaves anything that could change something as a plain command', () => {
    for (const command of [
      'npm test',
      'echo hello',
      'cat a.txt > b.txt',
      'Get-Content a.txt | Set-Content b.txt',
      'cat a.txt; rm a.txt',
      'cat $(rm -rf x)',
      'cat "a$(rm x)"',
      'cat `rm x`',
      "sed -i 's/a/b/' file",
      'cat a | sed -i s/a/b/ f',
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} +',
      'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
      'cat a & rm b',
      'ls; cat a',
      'cat "unterminated'
    ]) {
      expect(named(command), command).toBeNull();
    }
  });

  it("titles Claude's shell steps and prefers its description to the command", () => {
    const read = claudeToolEntry('1', 'PowerShell', { command: 'Get-Content README.md', description: 'Read the readme' });
    expect([read.title, read.detail, read.input]).toEqual(['Read', 'README.md', 'Get-Content README.md']);
    const run = claudeToolEntry('2', 'Bash', { command: 'npm run typecheck && npm test', description: 'Typecheck and run tests' });
    expect([run.title, run.detail, run.input]).toEqual(['Ran', 'Typecheck and run tests', 'npm run typecheck && npm test']);
    const bare = claudeToolEntry('3', 'Bash', { command: 'npm test' });
    expect([bare.title, bare.detail]).toEqual(['Ran', 'npm test']);
  });

  it('titles Codex commands that carry no parsed actions', () => {
    const entry = codexItemEntry({ type: 'commandExecution', id: 'c', command: 'rg foo src', status: 'completed', exitCode: 0 });
    expect(entry).toMatchObject({ title: 'Searched', detail: 'foo', input: 'rg foo src' });
  });
});

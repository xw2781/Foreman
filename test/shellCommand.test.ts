import { describe, expect, it } from 'vitest';
import { summarizeCommand } from '../src/main/chat/shellCommand';
import { claudeToolEntry } from '../src/main/chat/claudeTools';
import { codexItemEntry } from '../src/main/chat/codexItems';
import { layoutCommand, leadingFolder } from '../src/shared/commandText';

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

  it('names in-place edits, and keeps the name when the result is then checked', () => {
    expect(named("sed -i 's/a/b/' file.txt")).toEqual(['Edited', 'file.txt']);
    expect(named("sed -i.bak -E -e 's/a/b/' -e 's/c/d/' one.ps1 two.ps1")).toEqual(['Edited', 'one.ps1, two.ps1']);
    expect(
      named(`cd "Z:/Rate Indications/2026Q3 Penn"; sed -i 's/\\$arr\\[0,1+\\$i\\]/$arr[0,(1+$i)]/; s/x/y/' agents/sandbox/t12_summary.ps1; grep -o 'arr\\[0,([0-9+$i]*)\\]' agents/sandbox/t12_summary.ps1`)
    ).toEqual(['Edited', 't12_summary.ps1']);
    expect(named("sed -i 's/a/b/'")).toBeNull();
  });

  it('names script runs and inline code', () => {
    expect(named('Set-Location "Z:\\Rate Indications\\2026Q3 Penn"; & "agents\\sandbox\\t12_summary.ps1"')).toEqual(['Ran', 'script t12_summary.ps1']);
    expect(named('& .\\build.ps1 -Month 9 2>&1 | Select-Object -Last 20')).toEqual(['Ran', 'script build.ps1']);
    expect(named('powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\jobs\\run all.ps1"')).toEqual(['Ran', 'script run all.ps1']);
    expect(named('python3 tools/check.py --strict')).toEqual(['Ran', 'script check.py']);
    expect(named('./deploy.sh staging')).toEqual(['Ran', 'script deploy.sh']);
    expect(named('. .\\env.ps1; node scripts/start.mjs')).toEqual(['Ran', 'script env.ps1, script start.mjs']);
    expect(named('python build.py; cat out.log')).toEqual(['Ran', 'script build.py']);
    expect(named('python -c "import sys; print(sys.version)"')).toEqual(['Ran', 'Python code']);
    expect(named('node -e "console.log(1)"')).toEqual(['Ran', 'Node.js code']);
  });

  it('names version checks', () => {
    expect(named('python3 --version')).toEqual(['Checked', 'python3 version']);
    expect(named('cd /tmp; node -v; git --version 2>&1')).toEqual(['Checked', 'node, git versions']);
    expect(named('"C:\\Program Files\\Python314\\python.exe" -V')).toEqual(['Checked', 'python version']);
  });

  it('leaves anything else that could change something as a plain command', () => {
    for (const command of [
      'npm test',
      'echo hello',
      'cat a.txt > b.txt',
      'Get-Content a.txt | Set-Content b.txt',
      'cat a.txt; rm a.txt',
      'cat $(rm -rf x)',
      'cat "a$(rm x)"',
      'cat `rm x`',
      'cat a | sed -i s/a/b/ f',
      'find . -name "*.tmp" -delete',
      'find . -exec rm {} +',
      'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
      'cat a & rm b',
      'ls; cat a',
      'cat "unterminated',
      // An edit beside a run, a script whose output goes to a file, a program that isn't a script.
      "sed -i 's/a/b/' build.py && python build.py",
      'python build.py > out.txt',
      'python build.py; rm out.txt',
      'python -m pytest',
      'python - <<EOF',
      '& "C:\\Program Files\\App\\app.exe" /quiet',
      'bash -c "rm -rf x"',
      'curl -v https://example.com',
      'python3 --version; ls'
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
    // A script run is named when the agent didn't say what it is for.
    const script = claudeToolEntry('4', 'PowerShell', { command: '& .\\t12_summary.ps1', description: 'Rebuild the T12 summary' });
    expect([script.title, script.detail]).toEqual(['Ran', 'Rebuild the T12 summary']);
    expect(claudeToolEntry('5', 'PowerShell', { command: '& .\\t12_summary.ps1' }).detail).toBe('script t12_summary.ps1');
    const edit = claudeToolEntry('6', 'Bash', { command: "sed -i 's/a/b/' notes.md", description: 'Fix the typo' });
    expect([edit.title, edit.detail]).toEqual(['Edited', 'notes.md']);
  });

  it('drops the folder change a command starts with from the step line, not from the command', () => {
    const claude = claudeToolEntry('1', 'Bash', { command: 'cd "Z:/Rate Indications/2026Q3 Penn"; npm test' });
    expect([claude.detail, claude.input]).toEqual(['npm test', 'cd "Z:/Rate Indications/2026Q3 Penn"; npm test']);
    const codex = codexItemEntry({ type: 'commandExecution', id: 'c', command: 'Set-Location "Z:\\Penn"\n$xl = New-Object -ComObject Excel.Application', status: 'completed', exitCode: 0 });
    expect(codex).toMatchObject({ title: 'Ran', detail: '$xl = New-Object -ComObject Excel.Application', input: 'Set-Location "Z:\\Penn"\n$xl = New-Object -ComObject Excel.Application' });
  });

  it('titles Codex commands that carry no parsed actions', () => {
    const entry = codexItemEntry({ type: 'commandExecution', id: 'c', command: 'rg foo src', status: 'completed', exitCode: 0 });
    expect(entry).toMatchObject({ title: 'Searched', detail: 'foo', input: 'rg foo src' });
  });
});

describe('command layout', () => {
  it('takes the leading folder change out and puts one statement on each line', () => {
    expect(layoutCommand('cd "Z:/Rate Indications/2026Q3 Penn"; sed -i \'s/a;b/c/\' x.ps1; grep -c c x.ps1')).toEqual({
      folder: 'Z:/Rate Indications/2026Q3 Penn',
      text: "sed -i 's/a;b/c/' x.ps1\ngrep -c c x.ps1"
    });
    expect(layoutCommand('cd src && npm run typecheck && npm test || echo failed')).toEqual({ folder: 'src', text: 'npm run typecheck\n&& npm test\n|| echo failed' });
    expect(layoutCommand('Set-Location -Path C:\\repo\nGet-Date')).toEqual({ folder: 'C:\\repo', text: 'Get-Date' });
    expect(layoutCommand('cd /d "C:\\My Repo" && dir')).toEqual({ folder: 'C:\\My Repo', text: 'dir' });
    expect(leadingFolder('cd src')).toBeNull();
    expect(leadingFolder('cdk deploy; ls')).toBeNull();
  });

  it('leaves a command alone when it cannot tell where its statements end', () => {
    for (const command of [
      'npm test',
      'foreach ($f in $files) { Get-Content $f; Remove-Item $f }',
      'Get-ChildItem | ForEach-Object { $_.Name; $_.Length } | Out-File "a;b.txt"',
      'echo "a\\"; rm -rf x"; ls',
      'Write-Host "a`"; b"; ls',
      'case $x in a) echo 1;; b) echo 2;; esac',
      'echo "unterminated; ls',
      "python - <<'EOF'; print(1); EOF",
      'line one; still one\nline two'
    ]) {
      expect(layoutCommand(command), command).toEqual({ folder: null, text: command });
    }
    expect(layoutCommand('for f in *.txt; do (cd x; ls); done; echo done').text).toBe('for f in *.txt\ndo (cd x; ls)\ndone\necho done');
  });
});

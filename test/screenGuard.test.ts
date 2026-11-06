import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardDecision, screenControlUse } from '../src/main/screenGuard';
import { HookServer } from '../src/main/hookServer';
import { screenToolLine } from '../src/main/computerUse';

// What a model wrote when asked to drive a desktop app without the skill (trimmed from a real session).
const CLICK_SCRIPT = `$d="E:\\Work\\scan"
@'
param([int]$x,[int]$y)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e); }
"@
[M]::SetCursorPos($x, $y)
'@ | Set-Content "$d\\click.ps1"`;

describe('screen guard', () => {
  it('catches hand-written input and screen capture', () => {
    expect(screenControlUse('PowerShell', { command: CLICK_SCRIPT })).toBe('synthetic mouse or keyboard input');
    expect(screenControlUse('PowerShell', { command: 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^a")' })).toBe('SendKeys keystrokes');
    expect(screenControlUse('Bash', { command: `powershell -c "$g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)"` })).toBe('a screen capture');
    expect(screenControlUse('Bash', { command: 'python -c "import pyautogui; pyautogui.click(10, 10)"' })).toBe('a GUI automation library');
    expect(screenControlUse('Bash', { command: `(New-Object -ComObject WScript.Shell).SendKeys('{ENTER}')` })).toBe('SendKeys keystrokes');
  });

  it('leaves the skill, searches and ordinary commands alone', () => {
    expect(screenControlUse('Bash', { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/x/skills/computer-use/scripts/computer.ps1" click -Element 12' })).toBeNull();
    expect(screenControlUse('Bash', { command: 'grep -rn "SendKeys]::SendWait" src' })).toBeNull();
    expect(screenControlUse('Bash', { command: 'npm test' })).toBeNull();
    // Naming an API without a way to call it is not input.
    expect(screenControlUse('Bash', { command: 'echo SetCursorPos' })).toBeNull();
    expect(screenControlUse('Read', { file_path: 'x.ps1' })).toBeNull();
  });

  it('checks script files being written, except the skill itself', () => {
    const content = '[DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int s);';
    expect(screenControlUse('Write', { file_path: 'E:\\work\\click.ps1', content: `Add-Type @"\n${content}\n"@` })).toBe('synthetic mouse or keyboard input');
    expect(screenControlUse('Edit', { file_path: 'E:\\work\\auto.py', new_string: 'from pynput import mouse' })).toBe('a GUI automation library');
    expect(screenControlUse('Write', { file_path: 'E:\\work\\Program.cs', content })).toBeNull();
    expect(screenControlUse('Write', { file_path: 'C:\\app\\resources\\skills\\computer-use\\scripts\\x.ps1', content: `Add-Type @"\n${content}\n"@` })).toBeNull();
  });

  it('denies with directions to the skill, or to the person when it is off', () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: CLICK_SCRIPT } };
    const denied = guardDecision(payload, { skillDir: 'C:\\Users\\me\\.claude\\skills\\computer-use' }) as any;
    expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('C:\\Users\\me\\.claude\\skills\\computer-use\\SKILL.md');
    const off = guardDecision(payload, { skillDir: null }) as any;
    expect(off.hookSpecificOutput.permissionDecisionReason).toContain('turned off for this account');
    expect(guardDecision({ ...payload, hook_event_name: 'PostToolUse' }, { skillDir: null })).toBeNull();
    expect(guardDecision({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { skillDir: null })).toBeNull();
  });

  it('shows computer-use commands by what they do', () => {
    expect(screenToolLine('Bash', 'powershell -NoProfile -File "C:/s/computer-use/scripts/computer.ps1" click -Element 12')).toBe('computer-use click -Element 12');
    expect(screenToolLine('Read', 'src/a.ts')).toBe('Read: src/a.ts');
  });
});

describe('hook server guard', () => {
  let server: HookServer | null = null;
  let dir: string | null = null;
  afterEach(() => {
    server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    server = null;
    dir = null;
  });

  it('answers PreToolUse with the guard on both routes, and reports events only on /hook', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-hooks-'));
    server = new HookServer(dir);
    await server.start();
    const events: string[] = [];
    server.onEvent = (e) => events.push(`${e.agentId}:${e.name}`);
    server.guard = (_id, payload) => guardDecision(payload, { skillDir: 'C:\\skill' });

    const file = server.writeSettingsFile('chat1', server.guardSettings('chat1'));
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('Bash|PowerShell|Write|Edit|MultiEdit');
    expect(hook.hooks[0].url).toBe(`${server.url}/guard/chat1`);

    const post = async (url: string, body: object) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hook.hooks[0].headers }, body: JSON.stringify(body) });
      return res.json();
    };
    const bad = { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: CLICK_SCRIPT } };
    expect((await post(hook.hooks[0].url, bad)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await post(hook.hooks[0].url, { ...bad, tool_input: { command: 'ls' } })).toEqual({});
    expect((await post(`${server.url}/hook/term1`, bad)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(events).toEqual(['term1:PreToolUse']);
  });
});

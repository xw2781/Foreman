// Keeps agents on the computer-use skill when they operate the desktop.
//
// Without the skill (or without noticing it), a model asked to "use the app on this PC" will
// write its own SendKeys / SetCursorPos / CopyFromScreen code. That works, but skips everything
// the skill gives the person: the on-screen indicator, Esc to take back control, the blocked-app
// list and the action log. Claude Code asks Foreman before each tool call (a PreToolUse hook);
// this decides whether the call is hand-rolled desktop control and, if so, refuses it with
// directions to the skill.

export interface GuardContext {
  /** The account's installed skill folder, or null when computer use is off for it. */
  skillDir: string | null;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
/** Script files a model might write its automation into, then run. */
const SCRIPT_FILE = /\.(ps1|psm1|py|pyw|ahk|au3|vbs|js|bat|cmd)$/i;

const NATIVE_INPUT = /\b(SetCursorPos|mouse_event|keybd_event|SendInput)\b/;
const NATIVE_BRIDGE = /DllImport|Add-Type|ctypes|windll|win32api|win32con|user32/i;

const RULES: Array<{ what: string; test: (text: string) => boolean }> = [
  { what: 'SendKeys keystrokes', test: (t) => /SendKeys\]?\s*::\s*Send(Wait)?\b|\.SendKeys\s*\(/i.test(t) },
  { what: 'synthetic mouse or keyboard input', test: (t) => NATIVE_INPUT.test(t) && NATIVE_BRIDGE.test(t) },
  { what: 'a screen capture', test: (t) => /\bCopyFromScreen\s*\(|\bImageGrab\.grab\s*\(/i.test(t) },
  { what: 'a GUI automation library', test: (t) => /\b(import|from)\s+(pyautogui|pynput|pydirectinput|pywinauto|autoit)\b/i.test(t) },
  { what: 'AutoHotkey or nircmd input', test: (t) => /\bAutoHotkey\w*(\.exe)?\b|\bnircmdc?(\.exe)?\s+(sendkey|sendkeypress|sendmouse|setcursor|movecursor)\b/i.test(t) }
];

/** Commands that only read or search text can mention these APIs freely. */
const READ_ONLY = /^\s*(grep|egrep|fgrep|rg|ag|findstr|git\s+(grep|log|diff|show|blame)|Select-String|sls|cat|head|tail|less|more|Get-Content|gc|type|wc|sed\s+-n)\b/i;

/** What the call does that should go through the skill, or null when it's fine. */
export function screenControlUse(tool: string, input: Record<string, any> | null | undefined): string | null {
  if (!input || typeof input !== 'object') return null;
  let text: string;
  if (SHELL_TOOLS.has(tool)) {
    text = typeof input.command === 'string' ? input.command : '';
    if (!text || READ_ONLY.test(text)) return null;
  } else if (WRITE_TOOLS.has(tool)) {
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    // The skill's own sources are where these APIs belong.
    if (!SCRIPT_FILE.test(file) || /[\\/]skills[\\/]computer-use[\\/]/i.test(file)) return null;
    const edits = Array.isArray(input.edits) ? input.edits.map((e: any) => e?.new_string) : [];
    text = [input.content, input.new_string, ...edits].filter((v): v is string => typeof v === 'string').join('\n');
    if (!text) return null;
  } else return null;
  return RULES.find((rule) => rule.test(text))?.what ?? null;
}

export function guardMessage(what: string, context: GuardContext): string {
  const head = `Foreman blocked this: it is ${what}, written by hand. On this computer, desktop apps are operated only through the computer-use skill, which shows the person an on-screen indicator, lets them take back control with Esc, enforces the blocked-app list and logs each action.`;
  if (!context.skillDir) {
    return `${head} Computer use is turned off for this account in Foreman. Stop and ask the person to turn it on (Foreman → Computer Use), or to do this step themselves. Do not write your own input or screen-capture code, in a command or a script file.`;
  }
  return `${head} Use the skill instead: read ${context.skillDir}\\SKILL.md, then run ${context.skillDir}\\scripts\\computer.ps1 (\`state -Window <hwnd>\` for a screenshot, then \`click\`, \`type\`, \`key\`…). Do not write your own input or screen-capture code, in a command or a script file.`;
}

/** The PreToolUse hook reply: a refusal, or null to let Claude Code carry on as it would. */
export function guardDecision(payload: Record<string, any>, context: GuardContext): Record<string, unknown> | null {
  if (payload?.hook_event_name !== undefined && payload.hook_event_name !== 'PreToolUse') return null;
  const what = screenControlUse(String(payload?.tool_name ?? ''), payload?.tool_input);
  if (!what) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: guardMessage(what, context)
    }
  };
}

/** Tools the chat's guard hook is registered for. */
export const GUARDED_TOOLS = [...SHELL_TOOLS, ...WRITE_TOOLS].join('|');

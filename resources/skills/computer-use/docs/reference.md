# computer.ps1 reference

```text
powershell -NoProfile -ExecutionPolicy Bypass -File <skill>/scripts/computer.ps1 <command> [options]
```

- The command comes first. Options are case-insensitive: `-Window 123`, `-Window:123` and
  `--window 123` all work. A value may start with `-` (`-ScrollY -3`, `-Text "-5"`).
- Results go to stdout. Failures go to stderr as `computer-use: <message>`; with `-Json`, a
  failure also prints `{"ok": false, "code": N, "message": "..."}` on stdout.
- Output is UTF-8.
- It runs under Windows PowerShell 5.1. Started from PowerShell 7 (`pwsh`), it re-runs the
  same command under `powershell.exe`.
- The C# helper (`AgentScreenControl.cs`) is compiled once per source version into
  `%LOCALAPPDATA%\AgentTaskCenter\computer-use\bin\AgentScreenControl-<hash>.dll` and loaded
  from there afterwards. The first run after a change takes about 1 s longer.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| 0 | Done. |
| 2 | Bad or missing arguments, an unknown command, or `action` with no session. |
| 3 | The person took back control (Esc, the panel's Release button, or `release`). Every command except `start`, `stop`, `release`, `status`, `policy`, `demo` and `help` exits 3 until `start` or `stop`; `status` prints its report and then exits 3. |
| 4 | Refused (app policy, the Windows key, a window guard) or failed (window gone, element stale, timeout, and so on). The message says which. |

## Environment

| Variable | Effect |
| :--- | :--- |
| `ATC_COMPUTER_USE_DIR` | State directory. Default `%APPDATA%\AgentTaskCenter\computer-use`. |
| `ATC_AGENT_NAME` | Agent name shown on the panel and in the logs. `-Agent` overrides it; default `Agent`. |
| `ATC_AGENT_ID` | Opaque id of the driving agent, recorded as `agent_id` in `state.json` and `actions.jsonl`. |

## Looking (no overlay involved)

### apps

```text
apps [-App <text>] [-Json]
```

Running apps that own visible top-level windows (cloaked windows, such as suspended Store apps
or windows on other virtual desktops, are left out). `-App` filters on process name, exe path,
or window title.

```text
EXCEL  pid=25104  C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE
    hwnd=788576  x=1358 y=528 width=2354 height=1432  "Budget.xlsx - Excel"
    hwnd=983068  minimized  "Tracking.xlsx - Excel"
```

`-Json` prints an array of
`{process, pid, path, windows: [{hwnd, title, process, pid, className, order, minimized, bounds: {x, y, width, height}}]}`.
Text output exits 4 when nothing matches; `-Json` prints `[]`.

### windows

```text
windows [-Window <text>] [-Json]
```

Visible titled top-level windows, front to back (`order` 0 is frontmost). `-Window` filters on
title or process name, or matches an exact hwnd. Exits 4 if a filter matches nothing.

```text
 2  hwnd=788576  x=1358 y=528 width=2354 height=1432  [EXCEL]  Budget.xlsx - Excel
 8  hwnd=1507500  minimized  [ms-teams]  Chat | Microsoft Teams
```

Bounds are the visible frame (DWM extended frame bounds) in physical screen pixels.

### state

```text
state -Window <text|hwnd> [-Text] [-NoShot] [-Out <png>] [-Zoom <n>] [-MaxElements <n>]
      [-TimeoutSeconds <n>] [-Json]
```

Observes one window and records the observation in `last_observation.json`, which `-Element`,
`-Image`, `set-value` and `invoke` read.

- The screenshot uses PrintWindow with `PW_RENDERFULLCONTENT`, so covered windows capture
  correctly and the overlay is never in it. A blank result falls back to a copy of the screen
  (`capture: screen`) with a warning naming the windows in front. A minimized window cannot
  be captured (exit 4; `activate` it first).
- `-Out`: where to save the PNG. Default `<state dir>\shots\state-<yyyyMMdd-HHmmss-fff>.png`;
  only the newest 30 `state-*.png` files are kept.
- `-Zoom`: image scale. When omitted, the zoom is chosen so the image fits within 1568 px on the
  long edge and 1.15 megapixels (never above 1), so vision models see it unresampled.
- `-Text`: also walk the UI Automation control view (pre-order, numbered from 0), up to
  `-MaxElements` (default 400) or `-TimeoutSeconds` (default 20). The focused element and
  selected text are printed too.
- `-NoShot`: skip the screenshot (needs `-Text`).
- The window is refused if its process is denied by the app policy.

Text output:

```text
window: hwnd=132456  [notepad]  "notes.txt - Notepad"  x=400 y=300 width=1200 height=900
image: C:\Users\me\AppData\Roaming\AgentTaskCenter\computer-use\shots\state-20260923-101500-123.png
  1200x900 px, zoom 1, origin x=400 y=300 (capture: printwindow)
  image pixel (px,py) is screen pixel (400 + px/1, 300 + py/1); or pass -Image to use image pixels directly
focused: [7] Document "Text editor" id=RichEditD2DPT  actions=set-value,focus
selected text: "hello"
elements: 23
[0] Window "notes.txt - Notepad"  actions=focus
  [1] MenuBar "Application"
    [2] MenuItem "File"  actions=expand
  ...
```

Each element line reads `[index] ControlType "Name" id=AutomationId value="..."`, followed by
any of these flags: `readonly`, `toggle=On|Off|Indeterminate`,
`expanded|collapsed|partiallyexpanded`, `selected`, `disabled`, `focused`, `offscreen`. Then
comes `actions=` with any of `invoke`, `toggle`, `expand`, `collapse`, `select`, `set-value`,
`focus`, and `scrollintoview` (offscreen elements only). Names and values are clipped to 80
characters in the text output. Nesting is shown by two spaces per level.

`-Json` prints the same object that is saved to `last_observation.json` (see below).

### screenshot

```text
screenshot [-Window <text|hwnd> | -X <x> -Y <y> -Width <w> -Height <h>] [-Out <png>] [-Zoom <n>]
```

Saves a PNG of one window (PrintWindow, as in `state`), a screen region, or the whole primary
screen. Default `-Out` is `<state dir>\shots\screenshot-<time>.png` (newest 30 kept); default
zoom is 1. It prints the origin and zoom (`screen = origin + image_px / zoom`). It does **not**
change `last_observation.json`, so `-Image` still refers to the last `state`. The overlay is
excluded from screen captures.

### status

```text
status [-Json]
```

Prints `active`, `agent`, `agent_id`, `action`, `session`, `started`, `heartbeat`,
`release_requested`, `released_at`, `release_source`, `auto_started`, `overlay_running`,
`overlay_pid`, `last_pointer`, and `state_dir`. Exits 3 when a release is pending. It is not
written to the action log.

### policy

```text
policy [-Json]
```

Shows the built-in deny list and the `config.json` allow and deny lists that are in force.
`-Json` prints `{configPath, builtinDenied, allowedProcesses, deniedProcesses}`. It is not
written to the action log.

## Acting

Every acting command first checks the release flag (exit 3) and the app policy (exit 4). The
pointer and keyboard commands and `set-value`/`invoke` start the overlay if no session is
running. An auto-started session uses the agent name from `ATC_AGENT_NAME` and exits after
5 idle minutes. Each command accepts `-Action "<text>"` for the panel line; otherwise a
default like `Clicking [12] Button "Save" in Notepad` is used.

### launch

```text
launch -App <name|exe path|AppUserModelId> [-TimeoutSeconds <n>]
```

Starts an app through the shell: a path, a name Windows can resolve (`notepad`, `mspaint`, App
Paths entries), a Store AppUserModelId (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), or a
Start menu display name as a last resort. Denied names are refused before anything starts.
It waits (default 15 s) for a new top-level window, preferring one from the started process
or with the expected process name, and prints it in `windows` format after `launched: `. If a
single-instance app only reused an existing window, that window is printed instead. Exits 4
when no window appears, or when the new window belongs to a denied process.

### activate

```text
activate -Window <text|hwnd>
```

Restores a minimized window and brings it to the foreground. It escalates from
SetForegroundWindow to attached input, then a double Alt tap, then SwitchToThisWindow, and
verifies the result. It prints `activated (<how>): <window line>`. Exit 4 if Windows keeps
another window in front.

### click

```text
click (-Element <n> | -X <x> -Y <y> [-Image]) [-Button Left|Right|Middle|Double] [-Count 1-3]
      [-Window <text|hwnd>] [-TimeoutSeconds <n>]
```

- `-Element n`: the centre of element `n` of the last `state -Text`. It is adjusted if the
  window only moved, and refused if the window changed size, is gone or minimized, or the
  element is offscreen, has no rectangle, or lies outside the window.
- `-Image`: `-X`/`-Y` are pixels of the last `state` screenshot.
- Otherwise `-X`/`-Y` are physical screen pixels.
- `-Window`: refuse unless the window under the point is that window (by hwnd: the window
  itself, a window it owns, or another window of the same process; by text: title or process
  name contains it). With `-Element`/`-Image`, the observed window is the default guard.
- The check is made twice: before anything moves, and again at the moment of the click. Both
  the named window and the window under the point must pass the app policy. A point under
  the overlay's panel is refused.

The overlay glides its pointer to the target, borrows the real pointer for about 0.1 s,
clicks, and puts the real pointer back. Output: `left click at 812,440 in Save As (notepad)`.

### move

```text
move (-X <x> -Y <y> [-Image]) [-Window <text|hwnd>]
```

Glides only the agent's drawn pointer; nothing is clicked. It is useful for showing the user
where you are looking.

### drag

```text
drag -X <x> -Y <y> -ToX <x> -ToY <y> [-Image] [-Window <text|hwnd>]
```

Presses the left button at the start, moves the real pointer along the drawn one, and releases
at the end. Both ends are checked against the guard and the policy. With `-Image`, all four
values are image pixels.

### scroll

```text
scroll (-Element <n> | -X <x> -Y <y> [-Image]) [-ScrollY <notches>] [-ScrollX <notches>] [-Window ...]
```

Wheel notches (120 units each). Positive `-ScrollY` scrolls down, positive `-ScrollX` scrolls
right. At most 50 of each per command. The wheel goes to whatever is under the point, so pick
a point inside the pane you want. Output: `scroll x=0 y=3 notches at 1900,700 in ...`.

### type

```text
type (-Text <string> | -TextFile <utf8 file>) [-Window <text|hwnd>] [-DelayMs <n>]
```

Brings the window to the front (with `-Window`) and verifies it is in front. It then sends the
text as Unicode key events, so any character works, including surrogate pairs. CR, LF and
CRLF each press Enter; tabs are typed as characters. There is a short pause per character
(`-DelayMs`, default 8). Every 16 characters it checks the release flag and that the window
is still in front; if not, it stops with exit 3 or 4 and says how many characters were typed.
Without `-Window`, the text goes to the current foreground window, which must pass the policy.
The action log records only the length of the text.

### key

```text
key -Keys <chord> [-Window <text|hwnd>] [-Repeat <1-100>]
```

A `+`-separated chord: modifiers first, one key last, with spaces around `+` ignored.
Output: `pressed Ctrl+s in notes.txt - Notepad (notepad)`.

| Kind | Names (case-insensitive) |
| :--- | :--- |
| Modifiers | `Control_L`, `Control`, `Ctrl`, `Control_R`; `Alt`, `Alt_L`, `Alt_R` (AltGr); `Shift`, `Shift_L`, `Shift_R` |
| Editing | `Return`/`Enter`, `Tab`, `ISO_Left_Tab` (Shift+Tab), `Escape`/`Esc`, `BackSpace`, `Delete`/`Del`, `Insert` |
| Navigation | `Home`, `End`, `Page_Up`/`Prior`, `Page_Down`/`Next`, `Up`, `Down`, `Left`, `Right` |
| Function | `F1` ... `F24` |
| Keypad | `KP_0` ... `KP_9` (also `Numpad_0`, `Numpad0`), `KP_Add`, `KP_Subtract`, `KP_Multiply`, `KP_Divide`, `KP_Decimal`, `KP_Separator`, `KP_Enter`, `KP_Home`, `KP_Up` and the other keypad navigation keys |
| Other | `space`, `Menu`/`Apps` (context-menu key), `Caps_Lock`, `Num_Lock`, `Scroll_Lock`, `Print`, `Pause` |
| Punctuation | `period`, `comma`, `slash`, `backslash`, `minus`, `equal`, `plus`, `semicolon`, `colon`, `apostrophe`, `quotedbl`, `grave`, `asciitilde`, `bracketleft`, `bracketright`, `braceleft`, `braceright`, `less`, `greater`, `question`, `exclam`, `at`, `numbersign`, `dollar`, `percent`, `asciicircum`, `ampersand`, `asterisk`, `parenleft`, `parenright`, `underscore`, `bar` |
| Characters | any single character, such as `a`, `7` or `/` |

- Letters in a chord are case-insensitive (`Ctrl+A` = `Ctrl+a`). A lone capital (`A`) adds Shift.
- Punctuation that needs Shift on the current keyboard layout gets it automatically (`greater`).
- A lone character that has no key on the layout is sent as Unicode.
- Refused with exit 4: `Win`, `Windows`, `Super`, `Meta`, `Cmd`, `Command`, `OS`, `Hyper`,
  `Start` and their `_L`/`_R` forms, and also `Ctrl+Shift+Escape` and `Ctrl+Alt+Delete`.
- An unknown name exits 2.

The overlay ignores injected keys, so `key -Keys Escape` does not trigger a release.

### set-value

```text
set-value -Element <n> -Value <text> [-TimeoutSeconds <n>]
```

Replaces an element's value through UI Automation: ValuePattern, or RangeValuePattern for a
number. A classic Win32 multi-line edit, which has no ValuePattern, gets `WM_SETTEXT` plus the
change notification it would have sent. No pointer or keyboard is used. It prints whether the
value now reads back as sent. The action log records only the length.

### invoke

```text
invoke -Element <n> [-Pattern Invoke|Toggle|Expand|Collapse|Select|Focus|ScrollIntoView] [-TimeoutSeconds <n>]
```

Performs one UI Automation action on the element (default `Invoke`). An unsupported pattern
exits 4 and lists the patterns the element does support. If the app does not return within
the timeout (default 10 s), usually because a modal dialog opened, it exits 0 with
`sent; the app has not answered yet`.

## Session

| Command | Effect |
| :--- | :--- |
| `start [-Agent <name>] [-Action <text>] [-Position TopCenter\|TopRight\|BottomCenter\|BottomRight] [-Color #RRGGBB] [-Thickness <px>] [-NoCursor] [-NoEdges] [-IdleExitMinutes <n>]` | Begins a new session (clearing any release) and shows the overlay. Default idle exit is 20 minutes. |
| `action -Action <text>` | Replaces the panel's action line and refreshes the heartbeat. Exits 2 when no session is active. |
| `stop` | Ends the session: `active` false, release cleared, overlay closed. |
| `release` | Does what the panel's Release button does: sets `release_requested` (source `command`). The desktop app calls this. |
| `demo` | Glides the agent pointer around the screen and taps without clicking anything, then stops. |
| `help` | Command summary. |

The overlay also exits by itself about 2.5 s after a release, after `-IdleExitMinutes` without a
heartbeat, or when `state.json` disappears. Only `start`, `stop` and `demo` clear a release.

## Files in the state directory

The state directory is `ATC_COMPUTER_USE_DIR`, or `%APPDATA%\AgentTaskCenter\computer-use`.
Every JSON file is UTF-8 without a BOM, pure ASCII (non-ASCII is `\u` escaped), and written
to a temp file then renamed over the target, so a reader never sees a partial file.

### state.json

Written by the CLI. The overlay and `release` only change the release fields.

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `active` | bool | A session is open (started, not yet stopped). |
| `session` | string | Random id of the session, new on every `start` or auto-start. |
| `agent` | string | Name shown on the panel. |
| `agent_id` | string | `ATC_AGENT_ID` of the agent that last drove (may be empty). |
| `action` | string | The panel's current action line. |
| `started`, `heartbeat` | ISO 8601 | Session start, and the last command. |
| `release_requested` | bool | The person took back control; commands exit 3. |
| `released_at` | ISO 8601 or `""` | When. |
| `release_source` | string | `panel`, `escape`, `command`, or `reasserted`; `""` if none. |
| `auto_started` | bool | Started by an input command rather than `start`. |
| `idle_exit_minutes` | int | The overlay exits after this long without a heartbeat. |
| `color`, `thickness`, `show_cursor`, `show_edges`, `panel_position` | | Overlay appearance. |
| `cursor_seq`, `cursor_action`, `cursor_x`, `cursor_y`, `cursor_to_x`, `cursor_to_y`, `cursor_button`, `cursor_count`, `cursor_scroll_x`, `cursor_scroll_y`, `cursor_window`, `cursor_issued` | | The pointer command handed to the overlay (internal). |

The agent is in control when `active && !release_requested` and the overlay is running.

### overlay.pid, overlay.ready

The overlay's process id (decimal). The overlay deletes both files when it exits, so
"`overlay.pid` exists and names a live process" means the overlay is running.

### cursor_ack.json

The overlay's answer to the last pointer command (internal):
`{seq, ok, released, message, window, hwnd, process, wheel_sent}`.

### overlay.log

One line per pointer command, with step timings, plus hook and exit events. It is cleared by
`start` and by auto-start.

### last_observation.json

Written by `state`.

```json
{
  "timestamp": "2026-09-23T15:01:16.6260000-04:00",
  "window": {"hwnd": 132456, "title": "...", "process": "notepad", "pid": 4242, "className": "Notepad",
             "order": -1, "minimized": false, "bounds": {"x": 400, "y": 300, "width": 1200, "height": 900}},
  "image": {"path": "C:\\...\\shots\\state-....png", "originX": 400, "originY": 300,
            "width": 1200, "height": 900, "sourceWidth": 1200, "sourceHeight": 900,
            "zoom": 1, "capture": "printwindow"},
  "hasTree": true,
  "focusedIndex": 7, "focused": "[7] Document ...", "selectedText": null,
  "truncated": false, "treeError": null, "elementCount": 23,
  "warnings": [],
  "elements": [
    {"index": 0, "depth": 0, "runtimeId": "42.132456", "controlType": "Window", "name": "...",
     "automationId": "", "className": "Notepad", "value": null, "readOnly": false,
     "toggle": null, "expand": null, "selected": false, "enabled": true, "focused": false,
     "offscreen": false, "actions": ["focus"], "rect": {"x": 400, "y": 300, "width": 1200, "height": 900}}
  ]
}
```

- `image` is `null` with `-NoShot`. `width`/`height` are the saved PNG's size, and
  `sourceWidth`/`sourceHeight` the captured screen area. A screen pixel is
  `originX + imageX / zoom`.
- Without `-Text`, `hasTree` is false, `elements` is empty, and the tree fields are absent.
- Element `rect`s are screen pixels at the time of the observation.

### actions.jsonl

One JSON object per line, appended by every command except `help`, `status`, `policy` and the
internal `overlay`. When the file passes 1000 lines, it is trimmed to the newest 500.

| Field | Meaning |
| :--- | :--- |
| `timestamp` | ISO 8601, local time with offset. |
| `agent`, `agent_id`, `session` | Who, and in which session (may be empty). |
| `command` | For example `click`, `type`, `state`. |
| `args` | A short summary such as `x=812 y=440 button=left count=1`, `keys=Control_L+s repeat=1`, `length=42`. Typed text and set values are never logged, only their length. |
| `window`, `process`, `hwnd` | The target window (empty or 0 if none). |
| `code` | The exit code. |
| `message` | The result or the refusal reason. |
| `duration_ms` | How long the command took. |

### config.json

Written by the user or the desktop app; read on every check.

```json
{ "allowedProcesses": [], "deniedProcesses": ["notepad"] }
```

Process names are matched case-insensitively, with or without `.exe`. An empty
`allowedProcesses` allows every app that is not denied; a non-empty one allows only the apps
it lists. The built-in deny list always applies, even with no `config.json`:
`WindowsTerminal`, `cmd`, `powershell`, `pwsh`, `conhost`, `OpenConsole`, `wt`,
`powershell_ise`, `mintty`, `ConEmu`, `ConEmu64`, `alacritty`, `wezterm-gui`, `LockApp`,
`consent`, `CredentialUIBroker`, `SecHealthUI`, `SecurityHealthSystray`, `Taskmgr`,
`regedit`, `mmc`, `1Password`, `KeePass`, `KeePassXC`, `Bitwarden`, `Foreman`, `Agent Task Center`,
`Codex`, `ChatGPT`, `claude`. The Windows Run dialog is refused as well. For Store apps
hosted in `ApplicationFrameHost`, the app's own process is checked too.

### shots/

The `state-*.png` and `screenshot-*.png` files; the newest 30 of each are kept.

## Limits

- **Elevated windows.** Windows does not let a normal process send input to a window running
  as administrator; the input is dropped or refused. Tell the user.
- **The secure desktop.** UAC prompts and the lock screen cannot be seen or driven.
- **Multiple monitors.** Coordinates cover every monitor, but the edge glow and panel appear
  on the primary one only.
- **Remote Desktop.** A minimized Remote Desktop client stops drawing the remote session, so
  captures and clicks fail. Covering the window is fine.
- **Hands off during a drag.** A drag holds the real button for its whole glide.
- **Speed.** Each command is a new `powershell.exe`, about 1.1 s of start-up on a typical
  machine. Commands take roughly 1.5 to 2.5 s; the first input command of a session takes
  about 3 s more while the overlay starts.

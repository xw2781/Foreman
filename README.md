# Foreman

A Windows desktop app for running **Claude Code** and **Codex** side by side:

- **Agents** — chat with an agent (the default) or run it in a real terminal (the CLI's own UI), with live status: working, needs input, idle, done. The chat streams replies, shows each tool step with its output and diffs, and asks for approvals inline; typing into a finished chat continues it, and a Chat ⇄ Terminal switch hands the same conversation between the two. Headless background tasks, renaming, stopping and resuming work as before.
- **Task Manager** — every agent the app started, with status, account, model, context usage, cost, CPU and memory; plus the Claude Code / Codex processes running elsewhere (VS Code, the desktop apps, terminals), which you can end.
- **Usage & Cost** — API-equivalent cost of every session on the machine, per day, per tool, per account and per model, with context usage per session. Any session (including ones from VS Code) can be resumed in the app.
- **Accounts** — two (or more) accounts per tool, switchable per agent, with each account's 5-hour and weekly plan usage. Accounts can run at the same time.
- **Computer Use** — a skill that lets Claude Code and Codex see the screen and drive Windows apps with their own on-screen pointer, with a live view of what the agent is doing and a one-click (or Esc) take-back.

Nothing is sent anywhere: the app reads local session files and talks to the CLIs on your machine.

## Install

```powershell
npm run dist          # builds dist\Foreman-Setup-<version>.exe
```

Run the installer (per-user, no admin rights). The app finds the CLIs automatically — on `PATH`, the native Claude installer, the VS Code extensions, the Codex desktop app, or npm — and Settings lets you point at a specific one.

## Accounts and switching

Each account is its own config folder, which the app passes to the CLI:

| Tool | Variable | Primary account | Added accounts |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` (variable removed) | `~/.agent-task-center/profiles/<id>` |
| Codex | `CODEX_HOME` | `~/.codex` (variable removed) | `~/.agent-task-center/profiles/<id>` |

- **Add account** creates the folder, optionally shares settings with the primary (copies `settings.json`/`CLAUDE.md` or `config.toml`/`AGENTS.md`; links `skills`, `agents`, `commands`, `prompts`, `rules` as directory junctions), then opens a sign-in terminal (`claude auth login` / `codex login`). Choose the other account in the browser.
- **Use for new agents** (also in the title bar) picks which account the next agent starts with. Running agents keep theirs.
- **Make default for other apps** sets the user-level `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so VS Code, the desktop apps and new terminals use that account after they restart. For the primary account it removes the variable.
- **Terminal as this account** opens a PowerShell whose environment points at the account.
- Credentials are never copied between accounts, so refresh-token rotation can't sign one account out by using another.

Plan usage comes from what each CLI last reported: Codex writes it into its session logs; Claude's comes from sessions started in the app (via the status line) and from Claude Code's own cache. A window whose reset time has passed shows as "Reset since last report".

## How status and cost are measured

- **Claude Code** agents get per-session HTTP hooks through `claude --settings <file>` (merged with your settings, nothing of yours is modified): prompt submitted, tool running, permission prompt, turn finished. With *Capture Claude Code's status line* on, the status-line JSON also reaches the app for the exact context-window size, Claude Code's own cost, and plan limits; your own status-line command still runs and is what you see.
- **Codex** agents: status from the session rollout (`task_started` / `task_complete`) and the terminal's approval prompts.
- **Cost** prices every request at public API list rates (Anthropic and OpenAI Standard tier; dated in the Usage view), including cache reads/writes, per-model rates within a session, subagent transcripts, and OpenAI's 2x rate for requests over 272K input tokens. For Claude sessions that recorded one, Claude Code's own estimate is shown alongside. Subscription plans are billed differently — treat these as the API-equivalent value of what you used.

## Computer use

`resources/skills/computer-use` is a skill (`SKILL.md` + PowerShell/C# helper) that any Claude Code or Codex account can use; install it per account on the Computer Use page. It extends the ArcRho agent screen control tool with window-targeted screenshots, UI Automation trees with element indexes, clicks by element or image coordinates, typing, key chords, scrolling, and an app allow/deny policy. While an agent drives the screen, amber edges, a second pointer and a panel appear; press **Esc** or **Release** (or *Take back control* in the app) to stop it. See the skill's `docs/` for details.

## Development

Node isn't required on PATH: `.tools/node` holds a portable Node (not committed).

Double-click `dev.cmd` (or run it from any terminal) to start the app in development mode:
UI edits hot-reload in place, main/preload edits restart the app, and closing the window ends the session.

```powershell
$env:PATH = "$PWD\.tools\node;$env:PATH"
npm install
npm run dev        # Vite + Electron with reload
npm start          # build and launch
npm test           # unit tests (vitest)
npm run typecheck
npm run dist:dir   # unpacked app in dist\win-unpacked
```

Layout:

- `src/main` — Electron main process: `agents.ts` (terminals, headless tasks, status), `profiles.ts` (accounts), `hookServer.ts` + `statusLine.ts` (Claude hooks/status line), `processMonitor.ts`, `computerUse.ts`, `cliLocator.ts`, `commands.ts`.
- `src/main/chat` — chat mode: `claudeChat.ts` drives `claude --input-format stream-json --permission-prompt-tool stdio` (the Agent SDK protocol), `codexChat.ts` drives `codex app-server` (JSON-RPC, as Codex's own IDE extension and desktop app do); both normalize to the chat items in `src/shared/types.ts`. `history.ts` rebuilds past conversations from transcripts and rollouts (in the telemetry worker).
- `src/main/telemetry` — session parsing and pricing, run in a worker thread (`engine.ts`, `claudeTranscript.ts`, `codexRollout.ts`, `pricing.ts`).
- `src/renderer` — React UI; `terminals.ts` keeps one xterm per agent alive across views, `chats.ts` holds conversations, `views/ChatView.tsx` renders them.
- `src/shared` — types and the IPC contract.
- `resources/skills/computer-use` — the computer-use skill.

`ATC_CAPTURE_DIR=<dir>` renders each view off-screen to PNGs (useful when the display is asleep or remote); `ATC_CAPTURE_SCRIPT=<steps.json>` runs scripted steps for end-to-end checks.

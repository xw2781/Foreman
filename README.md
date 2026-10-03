# Foreman

A Windows desktop app for running **Claude Code** and **Codex** side by side:

- **Agents** — chat with an agent (the default) or run it in a real terminal (the CLI's own UI), with live status: working, needs input, idle, done. The chat streams replies, shows each tool step with its output and diffs, and asks for approvals inline; typing into a finished chat continues it, and a Chat ⇄ Terminal switch hands the same conversation between the two. Headless background tasks, renaming, stopping and resuming work as before.
- **Task Manager** — every agent the app started, with status, account, model, context usage, cost, CPU and memory; plus the Claude Code / Codex processes running elsewhere (VS Code, the desktop apps, terminals), which you can end.
- **Usage & Cost** — API-equivalent cost of every session on the machine, per day, per tool, per account and per model, with context usage per session. Any session (including ones from VS Code) can be resumed in the app. Usage from your other computers joins in through a private GitHub repo (*Connect GitHub*) or an exported file; only per-session totals and titles travel, never conversations.
- **Accounts** — two (or more) accounts per tool, switchable per agent, with each account's 5-hour and weekly plan usage. Accounts can run at the same time.
- **Agent browser** — a Chromium browser built into Foreman that Claude Code and Codex agents drive through browser tools. It runs off-screen with its own cookies and logins, so an agent can test a local dev server or fill in a form without touching your screen, mouse, keyboard or browsers; you watch it live beside the conversation and can take control at any time.
- **Computer Use** — a skill that lets Claude Code and Codex see the screen and drive Windows apps with their own on-screen pointer, with a live view of what the agent is doing and a one-click (or Esc) take-back.

Nothing is sent anywhere: the app reads local session files and talks to the CLIs on your machine.

## Install

```powershell
npm run dist          # builds dist\Foreman-Setup-<version>.exe
```

Run the installer (per-user, no admin rights). The app finds the CLIs automatically — on `PATH`, the native Claude installer, the VS Code extensions, the Codex desktop app, or npm — and Settings lets you point at a specific one.

## Accounts and switching

For a new PC, open **Settings → Command-line tools → Install for Foreman** for Claude Code and Codex. Foreman downloads the official native Windows packages from npm, verifies their SHA-512 integrity, checks the executable version, and stores them under `%LOCALAPPDATA%\Foreman\tools`. Users do not need Node.js, npm, administrator rights, or VS Code extensions. Downloads require internet access.

**Update managed CLI** installs the latest stable package for new sessions; running sessions keep their existing executable. **Roll back** selects the previous managed version when available. Explicit paths in Settings override managed installations. Account credentials and transcripts remain in each account's config folder, separate from executable versions. This setup supports Windows x64 and ARM64; only x64 is currently covered by the packaged Foreman build.

Each account is its own config folder, which the app passes to the CLI:

| Tool | Variable | Primary account | Added accounts |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` (variable removed) | `~/.agent-task-center/profiles/<id>` |
| Codex | `CODEX_HOME` | `~/.codex` (variable removed) | `~/.agent-task-center/profiles/<id>` |

- **Add account** creates the folder, optionally shares settings with the primary (copies `settings.json`/`CLAUDE.md` or `config.toml`/`AGENTS.md`; links `skills`, `agents`, `commands`, `prompts`, `rules` as directory junctions), then opens a sign-in terminal (`claude auth login` / `codex login`). Choose the other account in the browser.
- **Model choices** refresh from each account's installed CLI at startup and hourly. Accounts refresh also forces a model refresh. Discovery uses Claude's initialization metadata and Codex's `model/list`, without sending a prompt. The last successful list is cached across restarts; the bundled list is used until discovery succeeds. Claude's `availableModels` setting still takes precedence. Keep the CLIs updated: Foreman can only discover models they report.
- **Use for new agents** (also in the title bar) picks which account the next agent starts with. Running agents keep theirs.
- **Make default for other apps** sets the user-level `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so VS Code, the desktop apps and new terminals use that account after they restart. For the primary account it removes the variable.
- **Terminal as this account** opens a PowerShell whose environment points at the account.
- Credentials are never copied between accounts, so refresh-token rotation can't sign one account out by using another.

Plan usage comes from what each CLI last reported: Codex writes it into its session logs; Claude's comes from sessions started in the app (via the status line) and from Claude Code's own cache. A window whose reset time has passed shows as "Reset since last report".

## How status and cost are measured

- **Session-log usage** excludes parent history replayed into forked Codex sessions. Its dollar figures remain API-equivalent estimates, not subscription bills. Older local caches are rebuilt automatically; corrected session accounting supersedes older counts during usage sync.
- Migrated Codex transcripts can give inherited history and genuine child work the same timestamp. Foreman uses locally recorded turn creation IDs to recognize new child work, retains its usage deltas, and excludes the inherited counter baseline. No scaling or official totals enter this calculation. Day boundaries still follow local time; incomplete or migrated transcripts can differ from account-wide official totals.

- **Claude Code** agents get per-session HTTP hooks through `claude --settings <file>` (merged with your settings, nothing of yours is modified): prompt submitted, tool running, permission prompt, turn finished. With *Capture Claude Code's status line* on, the status-line JSON also reaches the app for the exact context-window size, Claude Code's own cost, and plan limits; your own status-line command still runs and is what you see.
- **Codex** agents: status from the session rollout (`task_started` / `task_complete`) and the terminal's approval prompts.
- **Cost** prices every request at public API list rates (Anthropic and OpenAI Standard tier; dated in the Usage view), including cache reads/writes, per-model rates within a session, subagent transcripts, and OpenAI's per-model long-context rates for requests over 272K input tokens. For Claude sessions that recorded one, Claude Code's own estimate is shown alongside. Subscription plans are billed differently — treat these as the API-equivalent value of what you used.

## Computer use

`resources/skills/computer-use` is a skill (`SKILL.md` + PowerShell/C# helper) that any Claude Code or Codex account can use; install it per account on the Computer Use page. It extends the ArcRho agent screen control tool with window-targeted screenshots, UI Automation trees with element indexes, clicks by element or image coordinates, typing, key chords, scrolling, and an app allow/deny policy. While an agent drives the screen, amber edges, a second pointer and a panel appear; press **Esc** or **Release** (or *Take back control* in the app) to stop it. See the skill's `docs/` for details.

## Agent browser

New agents (chat, terminal and background tasks, both tools) get an MCP server of browser tools, `foreman_browser`: navigate, read the page as an outline with element refs, click, type, press keys, choose options, scroll, drag, screenshots, run JavaScript, wait for text, tabs, console messages, file uploads and downloads. Claude Code receives it with `--mcp-config`, Codex with `-c mcp_servers.foreman_browser.*`; nothing in your own configuration changes. The server listens on 127.0.0.1 with a secret URL for each agent, so agents can reach only their own browser.

- **Separate from you.** Each tab is an off-screen Chromium page. Its profile (`persist:foreman-agent-browser`, or one per agent) is apart from your browsers and from Foreman itself. Pages can't open native windows: `alert`/`confirm`/`prompt` are answered at once and reported to the agent, file choosers go to the agent (or ask you, if you clicked), downloads are saved to `<userData>/browser-downloads/<agent>`, links to other programs (`mailto:`, app protocols) are blocked, and camera, microphone, location and notification requests are refused. Tabs are muted.
- **Watching.** The **Browser** button beside an agent (the globe) shows its active tab live, with tabs, an address bar, back/forward/reload, DevTools, where the agent last clicked, and an activity log of each step and download. It opens by itself when an agent starts browsing (Settings → Agent browser). You can use the page with your own mouse and keyboard; **Take control** pauses the agent's browser tools until you hand it back.
- **Settings → Agent browser**: turn it off for new agents, ask before each browser step, choose a shared or a per-agent profile, and clear the agent browsing data.

It is not your Chrome: extensions aren't available and some sites refuse embedded browsers (Google sign-in among them). The agent can still read and write your files as before; the browser separates the web session, not the computer.

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

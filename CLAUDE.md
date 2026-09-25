# Foreman — notes for agents

Electron + React + TypeScript desktop app (Windows). See README.md for what it does.

## Running things

`node` is not on PATH on this machine. A portable Node lives in `.tools/node` (gitignored):

```bash
export PATH="$PWD/.tools/node:$PATH"     # Git Bash
$env:PATH = "$PWD\.tools\node;$env:PATH" # PowerShell
```

- `npm run typecheck` and `npm test` after any change.
- `npm start` builds and launches. Launch Electron only through `scripts/start.mjs` (or `npm run dev`): a shell inherited from VS Code / Claude Code carries `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node.
- The display may be asleep or remote; screen captures then come back black. To see the UI, run with `ATC_CAPTURE_DIR=<dir>` (renders every view off-screen to PNG) or `ATC_CAPTURE_SCRIPT=<steps.json>` (scripted steps: `{ js, wait, shot }`, run in the page; `window.__atcDev('usage' | 'launcher' | 'select:<agentId>')` switches views). Add `ATC_USER_DATA=<dir>` to run beside an instance that's already open (separate data folder and single-instance lock; accounts still resolve to `~/.claude` / `~/.codex`).
- `npm run dist:dir` packages to `dist/win-unpacked`; `npm run dist` builds the NSIS installer.

## Invariants

- Child agents get `cleanEnv()` (src/main/util.ts): it strips `CLAUDECODE`, `CLAUDE_CODE_*`, `VSCODE_*`, `ELECTRON_RUN_AS_NODE`, and any inherited `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Then `ProfileService.envFor` sets the account's variable — or leaves it unset for the built-in account, because Claude Code only uses `~/.claude.json` when `CLAUDE_CONFIG_DIR` is unset.
- Never copy credentials between account folders (refresh tokens rotate). Removing an account uses `removeTree`, which unlinks junctions instead of following them into the shared primary folders.
- The per-agent `--settings` file may contain only documented keys; an invalid one makes Claude Code show an error dialog.
- Chat drivers (`src/main/chat`) must answer every control request / server request they receive, even unsupported ones (with an error): the CLI blocks until it gets a reply.
- JSONL parsing belongs in the telemetry worker (`src/main/telemetry`), never on the main thread: session history is ~1 GB.
- Pricing (`src/main/telemetry/pricing.ts`) carries a `PRICING_DATE`; update both together. `test/pricing.test.ts` pins a real Claude Code `cost-state` figure — if it breaks, the rate table is wrong, not the test.
- Chart and account colors are validated palette slots (`--series-N` in styles.css; slots 1–2 are the providers, 3–8 accounts). Keep the order.

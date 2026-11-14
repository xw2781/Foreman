# Cost estimates: fixes and to-do

Claude cost estimates came out 23–58% higher than the real API cost. The error grew with context size, because cache reads are a bigger share of the tokens in long contexts. Foreman read the tokens from the transcripts correctly. The cause was a wrong rate in the price table. This note records the fix and the follow-up changes still to make.

## Done

- **Claude Sonnet 5.5 cache-read rate.** `src/main/telemetry/prices.json` had `cachedInput: 0.2` (the Claude Opus 5.5 rate). The published rate is `0.1`. Fixed, with `pricingDate` moved to 2026-11-13 so the shipped table outranks older `pricing.json` override copies (which carry the old rate). `test/pricing.test.ts` had the wrong rate written into it too; corrected.
  - After the fix, recomputed estimates match real cost to within about 1%.
  - Installed builds keep the wrong rate until a release ships. Until then, a user can fix it in Settings → Context & cost → Model prices: set Sonnet 5.5 `cachedInput` to `0.1` and `pricingDate` to `2026-11-13`.

## To do

### 1. Use Claude Code's own cost for chat sessions

Claude Code sends `total_cost_usd` in every stream-json `result` event. `ClaudeChat.onResult` (`src/main/chat/claudeChat.ts`, around line 417) uses it only for the per-turn cost in the chat log. The session's `telemetry.cost.reportedUsd` is never set from it, so the agent list, details panel and Task Manager fall back to the transcript estimate for every chat session. The UI already prefers `reportedUsd` over `totalUsd`.

- Pass the per-turn cost from the driver to `AgentManager`, add it to a running total for the session, and set `t.cost.reportedUsd` from that total, the same way `applyStatusLine` does for terminal agents (`src/main/agents.ts`, around line 1566).
- `total_cost_usd` counts from zero each time the CLI process starts, so a restart or resume starts over. Keep the running total on Foreman's side (the existing `lastTotalCost` difference already handles one process) and save it with the session's archived info so it survives restarts.
- Check how Claude Code's count behaves after `--resume`: whether it starts from zero or restores the previous total. Build the running total to fit.

### 2. Keep the last status-line cost instead of dropping it after 10 minutes

`applyStatusLine` ignores a status-line snapshot more than 10 minutes old, so an idle terminal agent goes back to the estimate. The 10-minute rule makes sense for context size, which goes stale. Cost doesn't go stale: an idle session's cost can't grow. Keep the last reported cost (subject to the same per-run caveat as item 1) and apply the age rule only to the context fields.

### 3. Flag prices that disagree with Claude Code's

When a session has both a reported cost and a transcript estimate, compare them. A gap of more than a few percent most likely means a wrong rate in the table. The `cost-state` record's `modelUsage` gives `costUSD` and token counts per model, so a gap can be traced to one model. Show the mismatch in Settings → Model prices or log it. The Sonnet 5.5 rate would have been caught on its first session.

### 4. Check each Claude model's rates against a real figure

`test/pricing.test.ts` checks Claude Opus 5.5 against a real `cost-state` figure. The Sonnet 5.5 test only repeated the table's own value, so it couldn't catch the mistake. Add a test that checks a real `cost-state` `modelUsage` entry for each current Claude model (Sonnet 5.5, Haiku 5.5, Fable 5.x) whenever its rate is added or changed.

### 5. Small gap: background requests missing from transcripts

`cost-state` `modelUsage` includes small Claude Haiku 5.5 requests that Claude Code makes in the background and that never show up as assistant records in the transcript. The transcript estimate leaves these out. They're too small to matter on their own. Item 1 covers them for live sessions; for history, consider adding the `cost-state` per-model figures when they're present.

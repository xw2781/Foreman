# Cost estimates: fixes

Claude cost estimates came out 23–58% higher than the real API cost. The error grew with context size, because cache reads are a bigger share of the tokens in long contexts. Foreman read the tokens from the transcripts correctly. The cause was a wrong rate in the price table. This note records the fix and the follow-up changes, all of which are now made.

## The rate fix

- **Claude Sonnet 5.5 cache-read rate.** `src/main/telemetry/prices.json` had `cachedInput: 0.2` (the Claude Opus 5.5 rate). The published rate is `0.1`. Fixed, with `pricingDate` moved to 2026-11-13 so the shipped table outranks older `pricing.json` override copies (which carry the old rate). `test/pricing.test.ts` had the wrong rate written into it too; corrected.
  - After the fix, recomputed estimates match real cost to within about 1%.
  - Installed builds keep the wrong rate until a release ships. Until then, a user can fix it in Settings → Context & cost → Model prices: set Sonnet 5.5 `cachedInput` to `0.1` and `pricingDate` to `2026-11-13`.

## Follow-ups

### 1. Chat sessions use Claude Code's own cost

`ClaudeChat.onResult` hands each `result` event's `total_cost_usd` to the host (`ChatHost.cost`). `AgentManager.trackCost` folds it into `AgentInfo.reportedCost`, a running total that is archived with the agent and put back on `telemetry.cost.reportedUsd` each time telemetry is re-read. The agent list, details panel and Task Manager already prefer `reportedUsd`. Background tasks record the cost of their one `result` the same way.

How the count behaves after `--resume` (checked with Claude Code 2.1.323, print mode, two processes on one session): on a clean exit the CLI appends a `cost-state` record to the session file, and a resumed process starts its counter from that record's total, not from zero. A process that is killed writes no record, and Foreman stops agents by killing them, so the next process starts from whatever older record the file holds, or from zero. `trackReportedCost` (`src/main/reportedCost.ts`) covers both: it keeps the total on Foreman's side, and at the first reading of a new process it subtracts the saved total (`cost.savedUsd`, read when the process was launched) if the counter starts at or above it. This also fixed the chat log's per-turn cost, which showed the whole restored total on the first turn after a resume.

### 2. The last status-line cost is kept

Status-line cost goes through the same running total, so it no longer depends on the snapshot's age. `applyStatusLine` applies the 10-minute rule to the context fields only.

### 3. Prices that disagree with Claude Code's are flagged

The parser keeps the latest `cost-state` record's per-model tokens and cost (`reportedByModel`). For each model the usage scan prices those same tokens with the table and stores both figures with the file's summary. The usage report lists a model in `priceMismatches` when the two differ by more than 3%, and Settings → Model prices shows it. Both figures price the same tokens, so a gap can only be a rate.

Two limits keep the check exact. It uses only records that split cache writes into 5-minute and 1-hour tokens (Claude Code 2.1.311 and later) and have no web searches, which are billed per request. And per model it compares against the session from the newest Claude Code version, because the CLI's own rates change between versions: 2.1.288 priced Sonnet 5.5 cache reads at $0.20, and 2.1.318 priced Fable 5.2 at $5/$25 against a published $8/$40. A flag therefore means the table and the current CLI disagree; either can be the one that is wrong.

### 4. Each current Claude model is checked against a real figure

`test/pricing.test.ts` prices one real `cost-state` `modelUsage` entry each for Fable 5.2, Sonnet 5.5, Opus 5.5 and Haiku 5.5 and expects Claude Code's `costUSD` to six decimals. Fable 5.2, Mythos 5.2 and Haiku 5.5 were missing from the table and were added at their published rates. Haiku 5.5 costs 5x for prompts over 100K tokens; the table has no way to say that and lists the base rate.

### 5. Background requests count toward a session's cost

Claude Code's small background requests (Haiku) appear in `cost-state` `modelUsage` but never as assistant records. Session telemetry now adds the record's figures for any model that neither the transcript nor its subagent transcripts mention. The Usage page still totals transcripts only: its per-file summaries can't tell a background model from one a subagent used, and the amounts are fractions of a cent per session.

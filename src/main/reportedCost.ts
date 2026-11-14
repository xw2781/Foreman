import type { ReportedCost } from '../shared/types';

/**
 * Folds one reading of Claude Code's cost counter (a chat turn's `total_cost_usd`, a status
 * line's `cost.total_cost_usd`) into the session's running total.
 *
 * The counter belongs to one CLI process. A new process starts it at zero, or, when it resumes
 * a session whose file holds a saved total (a `cost-state` record, written on a clean exit),
 * at that total. `restoredUsd` is the saved total as it stood when the process started; a
 * first reading below it means the CLI didn't take it up. A process that was killed saved
 * nothing, which is why the total is kept here rather than read back from the CLI.
 */
export function trackReportedCost(
  previous: ReportedCost | null | undefined,
  runId: string,
  counterUsd: number,
  restoredUsd: number | null
): { cost: ReportedCost | null; addedUsd: number } {
  // Nothing counted yet: wait for a reading that shows whether a saved total was taken up.
  if (!Number.isFinite(counterUsd) || counterUsd <= 0) return { cost: previous ?? null, addedUsd: 0 };
  if (previous && previous.runId === runId) {
    const addedUsd = counterUsd >= previous.counterUsd ? counterUsd - previous.counterUsd : counterUsd;
    return { cost: { totalUsd: previous.totalUsd + addedUsd, runId, counterUsd }, addedUsd };
  }
  const start = restoredUsd !== null && restoredUsd > 0 && counterUsd >= restoredUsd ? restoredUsd : 0;
  const addedUsd = counterUsd - start;
  // What the CLI restored may cover runs this app never saw.
  const before = Math.max(previous?.totalUsd ?? 0, start);
  return { cost: { totalUsd: before + addedUsd, runId, counterUsd }, addedUsd };
}

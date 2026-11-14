import { describe, expect, it } from 'vitest';
import { trackReportedCost } from '../src/main/reportedCost';

describe("Claude Code's reported cost, kept across processes", () => {
  it('adds what each reading of one process adds', () => {
    const first = trackReportedCost(null, 'run-1', 0.2, null);
    expect(first).toEqual({ cost: { totalUsd: 0.2, runId: 'run-1', counterUsd: 0.2 }, addedUsd: 0.2 });
    const second = trackReportedCost(first.cost, 'run-1', 0.5, null);
    expect(second.cost?.totalUsd).toBeCloseTo(0.5, 9);
    expect(second.addedUsd).toBeCloseTo(0.3, 9);
    // The same reading again (a status line redrawn) adds nothing.
    expect(trackReportedCost(second.cost, 'run-1', 0.5, null).addedUsd).toBe(0);
  });

  it('carries the total over a process that starts counting from zero', () => {
    const before = { totalUsd: 1.5, runId: 'run-1', counterUsd: 1.5 };
    // The first process was killed: nothing was saved for the next one to start from.
    const resumed = trackReportedCost(before, 'run-2', 0.25, null);
    expect(resumed.cost).toEqual({ totalUsd: 1.75, runId: 'run-2', counterUsd: 0.25 });
    expect(resumed.addedUsd).toBe(0.25);
    // A saved total the CLI didn't take up (its first reading is below it) changes nothing.
    expect(trackReportedCost(before, 'run-2', 0.25, 0.9).cost?.totalUsd).toBe(1.75);
  });

  it("doesn't count a restored total twice", () => {
    const before = { totalUsd: 1.5, runId: 'run-1', counterUsd: 1.5 };
    // Claude Code resumed from the 1.5 its session file saved, then spent 0.25.
    const resumed = trackReportedCost(before, 'run-2', 1.75, 1.5);
    expect(resumed.cost?.totalUsd).toBe(1.75);
    expect(resumed.addedUsd).toBe(0.25);
  });

  it('takes a restored total that covers runs it never saw', () => {
    // Tracked 0.4 here; the session then ran elsewhere and saved 2.0.
    const resumed = trackReportedCost({ totalUsd: 0.4, runId: 'run-1', counterUsd: 0.4 }, 'run-2', 2.1, 2.0);
    expect(resumed.cost?.totalUsd).toBeCloseTo(2.1, 9);
    expect(resumed.addedUsd).toBeCloseTo(0.1, 9);
    // A session first seen when resumed.
    expect(trackReportedCost(null, 'run-1', 2.1, 2.0).cost?.totalUsd).toBeCloseTo(2.1, 9);
  });

  it('waits for a reading that has counted something', () => {
    const before = { totalUsd: 1.5, runId: 'run-1', counterUsd: 1.5 };
    // A status line drawn before the saved total is back must not become the run's starting point.
    const early = trackReportedCost(before, 'run-2', 0, 1.5);
    expect(early).toEqual({ cost: before, addedUsd: 0 });
    expect(trackReportedCost(early.cost, 'run-2', 1.6, 1.5).cost?.totalUsd).toBeCloseTo(1.6, 9);
    expect(trackReportedCost(null, 'run-1', 0, null).cost).toBeNull();
  });

  it('follows a counter that starts over within a process', () => {
    const next = trackReportedCost({ totalUsd: 3, runId: 'run-1', counterUsd: 2 }, 'run-1', 0.5, null);
    expect(next.cost).toEqual({ totalUsd: 3.5, runId: 'run-1', counterUsd: 0.5 });
  });
});

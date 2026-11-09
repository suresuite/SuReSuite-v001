import { describe, expect, it } from "vitest";
import { QUEUED_STALE_MS, RUNNING_NO_PROGRESS_MS, runLiveness, runWaitReply } from "../../../../supabase/functions/_shared/runLiveness";

// 38(ai): the plan card and the chat say what the run row says.
const T0 = Date.parse("2026-11-09T11:42:21Z");

describe("runLiveness", () => {
  it("a freshly queued run is moving — the familiar progress line", () => {
    const l = runLiveness({ status: "queued", rep_count_done: 0, rep_count_target: 5, created_at: T0 }, T0 + 60_000);
    expect(l.state).toBe("moving");
    expect(l.line).toBe("run dispatched — 0/5 replications");
  });

  it("a run queued past the threshold is reported as not started by the worker", () => {
    const l = runLiveness({ status: "queued", rep_count_done: 0, rep_count_target: 5, created_at: new Date(T0).toISOString() }, T0 + QUEUED_STALE_MS + 5 * 60_000);
    expect(l.state).toBe("queued_stale");
    expect(l.minutes).toBe(15);
    expect(l.line).toContain("hasn't started this run");
  });

  it("running with no finished replication past the threshold is reported; progress clears it", () => {
    const base = { status: "running", rep_count_target: 5, created_at: T0, started_at: T0 };
    expect(runLiveness({ ...base, rep_count_done: 0 }, T0 + RUNNING_NO_PROGRESS_MS + 1).state).toBe("running_no_progress");
    expect(runLiveness({ ...base, rep_count_done: 2 }, T0 + RUNNING_NO_PROGRESS_MS + 1).line).toBe("run dispatched — 2/5 replications");
  });

  it("the chat reply never claims 'nothing is hung'", () => {
    const fresh = runWaitReply({ status: "queued", rep_count_done: 0, rep_count_target: 5, created_at: T0 }, T0 + 1000);
    expect(fresh).not.toContain("nothing is hung");
    const stale = runWaitReply({ id: "abcdef12-0000", status: "queued", rep_count_done: 0, rep_count_target: 5, created_at: T0 }, T0 + 20 * 60_000);
    expect(stale).toContain("Run abcdef12 has been queued for 20 minutes");
    expect(stale).toContain("nothing is computing it right now");
  });

  it("a missing timestamp is never called stale — no claim without the row's evidence", () => {
    expect(runLiveness({ status: "queued", rep_count_done: 0, rep_count_target: 5 }, T0 + 99 * 60_000).state).toBe("moving");
  });
});

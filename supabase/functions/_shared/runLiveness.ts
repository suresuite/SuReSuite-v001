// Is a dispatched run actually moving? (ai-agents.md §10 entry 38(ai))
//
// A plan waiting on a run used to say "Still working … waiting is a plan
// state, nothing is hung" no matter how long the run had sat at 0 — and a
// run the simulation worker never picks up (asleep and not woken, down, or
// stuck behind another run) sat exactly there: queued, 0 replications, for
// as long as anyone kept asking. That sentence was a claim nobody had
// checked. This module states what the RUN ROW says instead: how long it has
// been queued, or running without a single finished replication, and — past
// a threshold — that the worker has not started it.
//
// One rule, read by both the chat's resume reply (planTools.ts) and the plan
// card's live line (src/components/chat/PlanCard.tsx), so the two can never
// disagree. Pure: the caller passes `now`. It does not diagnose WHY (that
// needs the worker's own logs); it reports what is observable and says so.

/** A queued run the worker has not started within this is reported stale.
 * Waking a scaled-to-zero worker takes well under a minute; ten minutes is
 * far past any ordinary queue wait for a project's own runs. */
export const QUEUED_STALE_MS = 10 * 60_000;
/** A running run with no finished replication after this is reported. */
export const RUNNING_NO_PROGRESS_MS = 30 * 60_000;

export interface RunLivenessInput {
  status: string;
  rep_count_done?: number | null;
  rep_count_target?: number | null;
  created_at?: string | number | null;
  started_at?: string | number | null;
}

export interface RunLiveness {
  /** "moving" | "queued_stale" | "running_no_progress" | "terminal" */
  state: "moving" | "queued_stale" | "running_no_progress" | "terminal";
  /** Minutes in the state that is being reported (queued, or running). */
  minutes: number;
  /** Short line for the plan card. */
  line: string;
}

function ms(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function runLiveness(run: RunLivenessInput, now: number): RunLiveness {
  const done = Number(run.rep_count_done ?? 0) || 0;
  const target = Number(run.rep_count_target ?? 0) || 0;
  const progress = `${done}/${target} replications`;
  const status = String(run.status ?? "");
  if (status !== "queued" && status !== "running") {
    return { state: "terminal", minutes: 0, line: `run ${status || "ended"} — ${progress}` };
  }
  if (status === "queued") {
    const since = ms(run.created_at);
    const minutes = since === null ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
    if (since !== null && now - since >= QUEUED_STALE_MS) {
      return {
        state: "queued_stale",
        minutes,
        line: `queued for ${minutes} min — the simulation worker hasn't started this run`,
      };
    }
    return { state: "moving", minutes, line: `run dispatched — ${progress}` };
  }
  const since = ms(run.started_at) ?? ms(run.created_at);
  const minutes = since === null ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
  if (done === 0 && since !== null && now - since >= RUNNING_NO_PROGRESS_MS) {
    return {
      state: "running_no_progress",
      minutes,
      line: `running for ${minutes} min with no replication finished`,
    };
  }
  return { state: "moving", minutes, line: `run dispatched — ${progress}` };
}

/** The chat's reply while a plan waits on a run. Says what the run row says
 * — never "nothing is hung" unless the row shows movement. */
export function runWaitReply(run: RunLivenessInput & { id?: string }, now: number): string {
  const l = runLiveness(run, now);
  const id = run.id ? `Run ${String(run.id).slice(0, 8)}` : "The run";
  if (l.state === "queued_stale") {
    return `${id} has been queued for ${l.minutes} minutes and the simulation worker hasn't started it, so nothing is ` +
      `computing it right now. The plan keeps waiting and continues if the worker picks it up. Check the run in the ` +
      `Simulation Lab; if a new small Lab run also stays queued, the simulation worker isn't running — tell your administrator.`;
  }
  if (l.state === "running_no_progress") {
    return `${id} has been running for ${l.minutes} minutes without finishing a single replication. It may be very large ` +
      `or stuck; check it in the Simulation Lab, where you can cancel it. The plan keeps waiting meanwhile.`;
  }
  return `Still working: ${l.line}. The thread continues automatically when the run completes.`;
}

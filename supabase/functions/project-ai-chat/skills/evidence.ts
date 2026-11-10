// S8 "is the difference real?" and S12 "is my run done?" (ai-agents.md §28
// Phase A, A.4).
//
// SIGNIFICANCE. The paired statistics already exist (`pairedDelta`, mirrored
// from src/lib/sim/stats.ts) and the comparison already states whether two
// runs are like-for-like (`pairingOf`). What was missing is an answer to the
// QUESTION. The rule (§28.3 R-significance): a difference is called real only
// when its paired 95% interval excludes 0; otherwise it is "not resolved at
// this replication count", with how many replications would resolve a
// difference of that size. Runs that are not like-for-like get a descriptive
// difference and are never called significant.
//
// STATUS. What the run rows say, through the one liveness rule
// (`_shared/runLiveness.ts`). No time estimate is given (nothing measures
// one) and the chat cancels nothing (the Lab's run queue does).

import { runLiveness } from "../../_shared/runLiveness.ts";
import {
  callTool, dbOf, fmt, loadRecentRuns, loadRepKpis, loadRun, orderKpis, pairedDelta, pairingOf, runCi, runKindLabel,
  scalarKpis, signed, type RunRow, type Skill, type SkillInput, type SkillResult,
} from "./common.ts";

// ── S8 · significance ───────────────────────────────────────────────────────

const SIGNIFICANCE_WORDS =
  /\b(significan\w*|statistically|real\s+(?:improvement|difference|effect|change)|(?:is|was)\s+(?:that|this|the)\s+(?:difference|improvement|change|drop|gain)\s+(?:real|meaningful|just\s+noise|noise)|just\s+noise|how\s+(?:confident|sure|certain)\s+(?:are\s+you|can\s+(?:i|we)\s+be)|why\s+is\s+the\s+(?:interval|ci|confidence\s+interval|error\s+bar)s?\s+so\s+(?:wide|large|big)|tell\s+(?:them|the\s+(?:two|runs))\s+apart|(?:can|should)\s+(?:i|we)\s+trust\s+(?:a|the|this|that|these)\s+(?:run|result|number)s?|are\s+(?:these|those|the)\s+(?:two\s+)?runs\s+comparable|like[-\s]for[-\s]like)\b/i;
const RUN_REF = /\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;

/** Replications that would resolve a paired difference of this size, by the
 * interval's own arithmetic: half-width shrinks with √n. */
export function replicationsToResolve(d: { mean: number; ci: number; n: number }): number | null {
  if (!Number.isFinite(d.mean) || d.mean === 0 || d.ci <= 0) return null;
  return Math.ceil(d.n * (d.ci / Math.abs(d.mean)) ** 2) + 1;
}

export const significanceSkill: Skill = {
  id: "significance",
  drafts: false,
  describe: "says whether a difference between two runs is real — the paired 95% interval — or only descriptive, and how many replications would settle it",
  example: "is that difference significant?  ·  are these two runs comparable?",
  recognize(input: SkillInput) {
    if (!SIGNIFICANCE_WORDS.test(input.utterance)) return null;
    return { refs: [...input.utterance.matchAll(RUN_REF)].map((m) => m[0].toLowerCase()) };
  },
  async run(ctx, match): Promise<SkillResult> {
    const { refs } = match as { refs: string[] };
    const db = dbOf(ctx);
    const calls: SkillResult["calls"] = [];
    const recent = (await loadRecentRuns(db, ctx.projectId, 30)).filter((r) => r.status === "done");
    const picked: RunRow[] = [];
    for (const ref of refs) {
      const r = ref.length > 8 ? await loadRun(db, ctx.projectId, ref) : recent.find((x) => x.id.startsWith(ref)) ?? null;
      if (r && !picked.some((p) => p.id === r.id)) picked.push(r);
    }
    if (picked.length === 0 && recent[0]) picked.push(recent[0]);
    if (picked.length === 0) {
      return { reply: "There are no finished runs to compare yet, so there is no difference to test.", parts: [], calls, outcome: "no_runs" };
    }
    if (picked.length === 1) {
      // The run's counterpart: the newest no-disruption run on the same policy
      // version (the baseline), else the next newest run.
      const a = picked[0];
      const other = recent.find((r) => r.id !== a.id && (r.disruption_schedule ?? []).length === 0 && r.policy_version_id === a.policy_version_id) ??
        (refs.length === 0 ? recent.find((r) => r.id !== a.id) : undefined);
      if (other) picked.push(other);
    }
    for (const r of picked) await callTool(calls, ctx, "get_run_results", { run_id: r.id });

    if (picked.length === 1) {
      const r = picked[0];
      const k = scalarKpis(r);
      const keys = orderKpis(k.keys(), 4);
      const lines = keys.map((key) => `${key} ${fmt(k.get(key))}${runCi(r, key) !== null ? ` ± ${fmt(runCi(r, key))}` : " (no interval recorded)"}`);
      return {
        reply: `There is one finished run to look at, so there is no difference to test. Run ${r.id.slice(0, 8)} (${r.rep_count_done} replications, ${await runKindLabel(db, r)}): ${lines.join("; ")} — each ± is the 95% interval across its replications. ` +
          (r.rep_count_done < 2 ? "With a single replication there is no interval at all: it is one draw, not a result. " : "") +
          "Fewer replications mean a wider interval; ask \"how many replications do I need?\" for the count your model's own spread calls for.",
        parts: [], calls, outcome: "single_run",
      };
    }

    const [a, b] = picked; // a = the run asked about, b = what it is compared with
    const { paired, why } = pairingOf(a, b);
    const ka = scalarKpis(a);
    const kb = scalarKpis(b);
    const keys = orderKpis([...ka.keys()].filter((k) => kb.has(k)), 6);
    const labels = a.model_validation_id === b.model_validation_id
      ? `Both: ${await runKindLabel(db, a)}.`
      : `Run ${a.id.slice(0, 8)}: ${await runKindLabel(db, a)}; run ${b.id.slice(0, 8)}: ${await runKindLabel(db, b)}.`;
    const pair = `run ${a.id.slice(0, 8)} against run ${b.id.slice(0, 8)}`;
    if (!paired) {
      const rows = keys.map((k) => [k, fmt(ka.get(k)), fmt(kb.get(k)), signed((ka.get(k) ?? 0) - (kb.get(k) ?? 0))]);
      return {
        reply: `I can't say whether the difference is real: ${pair} is not a like-for-like comparison (${why}), so the differences below are DESCRIPTIVE only. ` +
          "To test it, re-run one on the other's seed, replication count and policy version — then the runs pair replication by replication. " + labels,
        parts: rows.length ? [{ kind: "table", data: { columns: ["KPI", `Run ${a.id.slice(0, 8)}`, `Run ${b.id.slice(0, 8)}`, "Δ (descriptive)"], rows } }] : [],
        calls, outcome: "not_comparable",
      };
    }
    const ra = await loadRepKpis(db, a.id);
    const rb = await loadRepKpis(db, b.id);
    const tested = keys.map((k) => ({ k, d: ra.get(k) && rb.get(k) ? pairedDelta(ra.get(k)!, rb.get(k)!) : null }))
      .filter((x): x is { k: string; d: { mean: number; ci: number; n: number } } => x.d !== null);
    if (tested.length === 0) {
      return {
        reply: `The two runs are like-for-like, but their per-replication values are not available (fewer than two shared replications), so no interval can be formed for ${pair}. ${labels}`,
        parts: [], calls, outcome: "not_comparable",
      };
    }
    const real = (d: { mean: number; ci: number }) => Math.abs(d.mean) > d.ci;
    const rows = tested.map(({ k, d }) => [k, fmt(ka.get(k)), fmt(kb.get(k)), `${signed(d.mean)} ± ${fmt(d.ci)}`, real(d) ? "yes" : "not resolved"]);
    const head = tested[0];
    const n = head.d.n;
    const need = replicationsToResolve(head.d);
    const lead = real(head.d)
      ? `Yes, for ${head.k}: ${signed(head.d.mean)} ± ${fmt(head.d.ci)} (${pair}, paired over ${n} replications). The 95% interval excludes 0, so the difference is real at this replication count.`
      : head.d.mean === 0
      ? `No difference in ${head.k} was observed between the two runs (${pair}, paired over ${n} replications).`
      : `Not resolved, for ${head.k}: ${signed(head.d.mean)} ± ${fmt(head.d.ci)} (${pair}, paired over ${n} replications). The 95% interval includes 0, so this could be noise — I won't call it an improvement or a loss.` +
        (need ? ` A difference of this size would take about ${need > 200 ? "more than 200" : need} replications to resolve; say "re-run with ${Math.min(need, 200)} replications" on the what-if if it matters.` : "");
    const others = tested.slice(1);
    const tail = others.length
      ? ` Other KPIs: ${others.filter((x) => real(x.d)).length} of ${others.length} resolved (table).`
      : "";
    return {
      reply: `${lead}${tail} ${labels}`,
      parts: [{ kind: "table", data: { columns: ["KPI", `Run ${a.id.slice(0, 8)}`, `Run ${b.id.slice(0, 8)}`, "Δ (paired, 95% CI)", "Real?"], rows } }],
      calls,
      outcome: real(head.d) ? "resolved" : "unresolved",
    };
  },
};

// ── S12 · run status ────────────────────────────────────────────────────────

const STATUS_ASK =
  /\b(?:is|are|has|have|did)\s+(?:my|the|that|this|our)\s+(?:last\s+)?(?:runs?|simulations?|study|sweep|experiment|what[-\s]?if)\s+(?:done|finished|finish|completed?|ready|still\s+running|running|stuck|queued|started)\b|\bwhy\s+is\s+(?:my|the|that|this)\s+(?:run|simulation|study)\s+(?:stuck|still\s+queued|queued|taking\s+so\s+long|so\s+slow|not\s+starting|not\s+running)\b|\bhow\s+long\s+will\s+(?:it|the\s+run|my\s+run|the\s+simulation|the\s+study)\s+take\b|\bwhat(?:'s|\s+is)\s+running\b|\brun\s+status\b|\bstatus\s+of\s+(?:my|the)\s+(?:run|simulation|study)\b/i;
const CANCEL_ASK = /\b(?:cancel|stop|abort|kill)\s+(?:that|the|my|this)\s+(?:run|simulation|study|sweep)\b/i;
const DURATION_ASK = /\bhow\s+long\s+will\b/i;

interface StatusMatch { cancel: boolean; duration: boolean }

export const statusSkill: Skill = {
  id: "status",
  drafts: false,
  describe: "says what your runs are doing right now — queued, running, finished — from the run records",
  example: "is my run done?  ·  why is my run stuck?",
  recognize(input: SkillInput): StatusMatch | null {
    const u = input.utterance;
    const cancel = CANCEL_ASK.test(u);
    if (!cancel && !STATUS_ASK.test(u)) return null;
    return { cancel, duration: DURATION_ASK.test(u) };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as StatusMatch;
    const db = dbOf(ctx);
    const calls: SkillResult["calls"] = [];
    let rows: Array<Record<string, unknown>> = [];
    try {
      const { data } = await db.from("simulation_runs")
        .select("id,status,rep_count_done,rep_count_target,created_at,started_at")
        .eq("project_id", ctx.projectId).in("status", ["queued", "running"]).limit(50);
      rows = (data ?? []) as Array<Record<string, unknown>>;
    } catch {
      return { reply: "I couldn't read the run records just now.", parts: [], calls, outcome: "error" };
    }
    const cancelLine = m.cancel
      ? " I can't cancel a run from the chat: open the run queue in the Simulation Lab and cancel it there."
      : "";
    const durationLine = m.duration
      ? " I can't give a time estimate — nothing on the platform measures one; the progress below is what is known."
      : "";
    if (rows.length === 0) {
      const last = (await loadRecentRuns(db, ctx.projectId, 5)).find((r) => r.status === "done");
      return {
        reply: "Nothing is queued or running on this project right now." +
          (last ? ` Your latest finished run is ${last.id.slice(0, 8)} (${last.rep_count_done} replications) — ask "what did the last run show?".` : " No run has finished yet.") +
          (m.cancel ? " So there is nothing to cancel." : ""),
        parts: [], calls, outcome: "idle",
      };
    }
    const now = Date.now();
    const lines = rows.map((r) => {
      const l = runLiveness({
        status: String(r.status), rep_count_done: Number(r.rep_count_done ?? 0), rep_count_target: Number(r.rep_count_target ?? 0),
        created_at: r.created_at as string | number | null, started_at: r.started_at as string | number | null,
      }, now);
      return { id: String(r.id).slice(0, 8), status: String(r.status), done: Number(r.rep_count_done ?? 0), target: Number(r.rep_count_target ?? 0), l };
    });
    const stalled = lines.filter((x) => x.l.state === "queued_stale" || x.l.state === "running_no_progress");
    const head = `${lines.length} run${lines.length === 1 ? " is" : "s are"} in progress.`;
    const stall = stalled.length
      ? ` **${stalled.length} ${stalled.length === 1 ? "is" : "are"} not moving**: ${stalled.map((x) => `run ${x.id} — ${x.l.line}`).join("; ")}. ` +
        "Check it in the Simulation Lab; if a new small run there also stays queued, the simulation worker isn't running — tell your administrator. I can't see why from here."
      : " All of them are moving; I'll answer automatically when a run I proposed finishes.";
    return {
      reply: head + stall + durationLine + cancelLine,
      parts: [{ kind: "table", data: { columns: ["Run", "State", "Replications", "Note"], rows: lines.map((x) => [x.id, x.status, `${x.done}/${x.target}`, x.l.line]) } }],
      calls,
      outcome: stalled.length ? "stalled" : "active",
    };
  },
};

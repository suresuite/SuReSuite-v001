// M8 Explain a result (ai-agents.md §26.3). "Why did fill rate drop at
// week 24?" — answered from what the run RECORDED: its disruption schedule
// (stamped at dispatch), its warm-up, and its KPIs against the matching
// no-disruption baseline run. Decision traces (B5, facet 11) would say WHICH
// policy decision caused it; they are not recorded yet, so the answer is
// labelled a timeline explanation and never a causal one.

import { pyRound } from "../whatIf.ts";
import {
  callTool,
  dbOf,
  fmt,
  loadRecentRuns,
  orderKpis,
  scalarKpis,
  signed,
  type RunRow,
  type Skill,
  type SkillInput,
  type SkillResult,
  runKindLabel,
} from "./common.ts";

const EXPLAIN_WORDS =
  /\bwhy\s+(?:did|does|is|was|were|do)\b[^?]*\b(fill\s*rate|service|backlog|stock[-\s]?outs?|lost\s+sales|cost|revenue|profit|ttr|tts|drop\w*|fall\w*|fell|spik\w*|ris\w*|rose|low|high|bad|worse)\b/i;

function targetLabel(t: unknown): string {
  const s = String(t ?? "");
  if (s === "node:plant" || s === "plant") return "the plant";
  return s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
}

export const explainSkill: Skill = {
  id: "explain",
  drafts: false,
  describe: "explains a result from the run's own timeline — warm-up, the disruption window, recovery — against the no-disruption baseline",
  example: "why did fill rate drop at week 24 in the last run?",
  recognize(input: SkillInput) {
    if (!EXPLAIN_WORDS.test(input.utterance)) return null;
    const wk = input.utterance.match(/\bweek\s*#?\s*(\d{1,3})\b/i);
    const ref = input.utterance.match(/\b([0-9a-f]{8})\b/i);
    return { week: wk ? Number(wk[1]) : null, ref: ref ? ref[1].toLowerCase() : null };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as { week: number | null; ref: string | null };
    const calls: SkillResult["calls"] = [];
    const runs = (await loadRecentRuns(dbOf(ctx), ctx.projectId, 30)).filter((r) => r.status === "done");
    const run: RunRow | undefined = m.ref ? runs.find((r) => r.id.startsWith(m.ref!)) : runs[0];
    if (!run) {
      return { reply: "There's no finished run to explain yet.", parts: [], calls, outcome: "no_runs" };
    }
    await callTool(calls, ctx, "get_run_results", { run_id: run.id });
    // §27 row 13: say what kind of result is being explained.
    const kind = await runKindLabel(dbOf(ctx), run);
    const schedule = run.disruption_schedule ?? [];
    const warm = run.warmup_detected_at;
    const events = schedule.map((e) => {
      const s = Math.max(1, pyRound(Number(e.start_day ?? 0) / 7));
      const d = Math.max(1, pyRound(Number(e.duration_days ?? 0) / 7));
      const mag = Number(e.magnitude_pct ?? 100);
      return { target: targetLabel(e.target), start: s, end: s + d - 1, effect: mag >= 100 ? "outage" : `${mag}% capacity cut` };
    });

    // Where the asked week sits on the run's own timeline.
    let place = "";
    if (m.week !== null) {
      const w = m.week;
      const hit = events.find((e) => w >= e.start && w <= e.end);
      const after = events.filter((e) => w > e.end).sort((a, b) => b.end - a.end)[0];
      if (warm !== null && w < warm) {
        place = `Week ${w} is inside the warm-up (the engine measured from week ${warm}), so no KPI counts it — it is the model filling its pipelines, not a result.`;
      } else if (hit) {
        place = `Week ${w} is inside the disruption: ${hit.target} ${hit.effect}, weeks ${hit.start}–${hit.end}. Supply from it stops or slows, so stock drains and orders backlog until it ends.`;
      } else if (after) {
        place = `Week ${w} is ${w - after.end} week(s) after the disruption on ${after.target} ended (week ${after.end}) — the recovery tail, while delayed orders arrive and the backlog clears.`;
      } else if (events.length) {
        place = `Week ${w} is before the first disruption (week ${Math.min(...events.map((e) => e.start))}), so the run is in its normal regime then; a drop there comes from demand variability, not the event.`;
      } else {
        place = `This run has no disruption, so a dip at week ${w} is ordinary demand and supply variability.`;
      }
    }

    // The run against its no-disruption counterpart: same policy version and
    // seed, empty schedule — the impact the disruption caused.
    const baseline = runs.find((r) =>
      r.id !== run.id && (r.disruption_schedule ?? []).length === 0 && r.policy_version_id === run.policy_version_id
    );
    const k = scalarKpis(run);
    const keys = orderKpis(k.keys(), 4);
    const kb = baseline ? scalarKpis(baseline) : null;
    const impact = kb
      ? keys.filter((key) => kb.has(key)).map((key) => `${key} ${fmt(k.get(key))} vs ${fmt(kb.get(key))} with no disruption (${signed((k.get(key) ?? 0) - (kb.get(key) ?? 0))})`).join("; ")
      : "";
    const timeline = events.length
      ? `Run ${run.id.slice(0, 8)} (${kind}) simulated ${events.map((e) => `${e.target} ${e.effect}, weeks ${e.start}–${e.end}`).join("; ")}` +
        `${warm !== null ? `, measured from week ${warm}` : ""}.`
      : `Run ${run.id.slice(0, 8)} (${kind}) has no disruption.`;
    return {
      reply: [
        timeline,
        place,
        impact ? `Across the run: ${impact} (descriptive; run ${baseline!.id.slice(0, 8)} is the baseline).` : "",
        "This is a timeline explanation from what the run recorded; which policy decision caused each change needs decision traces, which aren't recorded yet. The week-by-week chart is in the Simulation Lab's results.",
      ].filter(Boolean).join(" "),
      parts: [],
      calls,
      outcome: m.week !== null ? "placed" : "timeline",
    };
  },
};

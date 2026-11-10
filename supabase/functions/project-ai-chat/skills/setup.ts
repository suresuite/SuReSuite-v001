// M6 Model-setup advice (ai-agents.md §26.3). "How many replications do I
// need?", "what warm-up?", "how long should I simulate?" — answered from the
// statistics the V&V Analyst already computes for a validation card
// (buildComputedBlock: engine/Welch/MSER warm-up, per-KPI adequacy n*), read
// off the latest finished run. The horizon advice reads the engine's own run
// window (registry `run_window`), never a rule of thumb.

import registry from "../../_shared/registry.generated.json" with { type: "json" };
import { buildComputedBlock } from "../../_shared/vvEvidence.ts";
import { loadEvidenceRun } from "../vvTools.ts";
import { AGENT_REPLICATIONS_DEFAULT_CAP, AGENT_REPLICATIONS_HARD_CAP } from "../experimentTools.ts";
import { callTool, dbOf, fmt, loadRun, runKindLabel, type Skill, type SkillInput, type SkillResult } from "./common.ts";

const RUN_WINDOW = (registry as unknown as { run_window?: { analysis_window_weeks?: number; days_per_tick?: number } }).run_window ?? {};

const SETUP_WORDS =
  /\b(how\s+many\s+(?:replications?|reps|runs)|replication\s+count|warm[-\s]?up|how\s+long\s+(?:should|do)\s+(?:i|we)\s+(?:run|simulate)|(?:simulation\s+)?horizon|run\s+length|enough\s+replications|replications?\s+(?:is\s+|are\s+)?enough)\b/i;

export const setupSkill: Skill = {
  id: "setup",
  drafts: false,
  describe: "recommends warm-up, replication count and horizon from your latest run's own statistics",
  example: "how many replications do I need?  ·  what warm-up should I use?",
  recognize(input: SkillInput) {
    // Advice, not a definition: "what is warm-up?" is the how-to skill's.
    const advice = /\b(how\s+many|how\s+long|should|need|recommend\w*|enough|right|good|use|choose|set)\b/i;
    return SETUP_WORDS.test(input.utterance) && advice.test(input.utterance) ? {} : null;
  },
  async run(ctx, _m, _input, opts): Promise<SkillResult> {
    const calls: SkillResult["calls"] = [];
    const { run, reps } = await loadEvidenceRun(dbOf(ctx), ctx.projectId, null);
    if (!run) {
      return {
        reply: "There's no finished run to measure yet, and these settings come from your model's own output. Run your baseline scenario once (a few replications is enough to start), then ask again.",
        parts: [], calls, outcome: "no_runs",
      };
    }
    await callTool(calls, ctx, "get_run_results", { run_id: run.id });
    // §27 row 13: say what kind of result the evidence is.
    const full = await loadRun(dbOf(ctx), ctx.projectId, String(run.id));
    const kind = full ? await runKindLabel(dbOf(ctx), full) : "run record not found";
    const computed = buildComputedBlock({ run, reps, findings: [] });
    const warmWeeks = Math.round(computed.adopted_warmup_days / 7);
    const window = Number(RUN_WINDOW.analysis_window_weeks ?? 52);
    const per = Object.entries(computed.replication_basis.per_kpi);
    const rows = per.map(([k, a]) => [k, fmt(a.mean), `± ${fmt(a.half)}`, `${fmt(a.rel * 100)}%`, String(a.n), String(a.n_star)]);
    const method = computed.warmup_method === "engine" ? "detected by the engine" : `estimated by ${computed.warmup_method === "welch" ? "Welch's method" : "MSER-5"}`;
    const advice = [
      `From run ${run.id.slice(0, 8)} (${reps.length} replications; ${kind}): warm-up **${warmWeeks} weeks** (${computed.adopted_warmup_days} days, ${method}).`,
      `Replications: **${computed.recommended_replications}** reach ±${fmt(computed.replication_basis.target_precision * 100)}% precision at ${fmt(computed.replication_basis.confidence * 100)}% confidence on the focal KPIs` +
        (computed.adequacy_met ? " — this run already meets it." : " — this run does not yet."),
      `Horizon: at least **${warmWeeks + window} weeks** (warm-up + the engine's ${window}-week analysis window), plus the disruption and its recovery for a stress scenario.`,
      `Note: runs I propose in chat use at most ${AGENT_REPLICATIONS_HARD_CAP} replications (${AGENT_REPLICATIONS_DEFAULT_CAP} for an exploratory run) unless you ask for more — say "with ${computed.recommended_replications} replications" when precision matters.`,
      opts.enabledAgents.includes("vv-analyst")
        ? `To lock these in, say "adopt the recommended settings" and the V&V Analyst drafts a validation card.`
        : "",
    ].filter(Boolean);
    return {
      reply: advice.join(" "),
      parts: rows.length ? [{ kind: "table", data: { columns: ["KPI", "Mean", "95% CI", "Rel. precision", "n", "n* needed"], rows } }] : [],
      calls,
      outcome: "advised",
    };
  },
};

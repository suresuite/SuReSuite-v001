// M2 Mitigation study (ai-agents.md §26.3). "How do I mitigate it?" /
// "which playbook is best for that outage?" — answered by SIMULATING each
// candidate response against the same disruption on the same random numbers,
// never by ranking playbooks on their stated targets.
//
// Arms: "No recovery" (the reference) + the project's recovery playbooks
// (system playbooks included, the source recommend_disruption_strategy
// reads), or only the ones the user names. A playbook arm runs the
// disruption with the playbook's config as the scenario's recovery
// overrides — exactly the Lab's design-of-experiments row
// (src/lib/sim/playbookFactor.ts::materializeDesignRow).

import type { ToolContext } from "../tools.ts";
import { describeEvents, prepareWhatIf, whatIfReply } from "../whatIf.ts";
import { COMPARISON_ARMS_MAX, experimentTypesEnabled } from "../experimentTools.ts";
import { dbOf, fmt, orderKpis, signed, type Skill, type SkillInput, type SkillOptions, type SkillResult } from "./common.ts";
import { disruptionSubject } from "./disruptionSubject.ts";
import { parseRunChoice } from "../modelContext.ts";
import {
  compareOnKpi,
  draftStudy,
  loadArmResults,
  locateArms,
  progressLine,
  studyHorizonDays,
  studyTable,
  type StudyArm,
} from "./study.ts";

const MITIGATION_WORDS =
  /\b(mitigat\w*|recover(?:y|ies)?\s+(?:option|plan|strateg\w*|playbook\w*)|playbooks?|reduce\s+(?:the\s+)?(?:impact|damage|effect)|lessen\s+the\s+impact|(?:best|which)\s+(?:response|strategy|strategies|option)|how\s+(?:do|can|should)\s+(?:we|i)\s+(?:respond|handle|protect|recover|mitigate|cope)|what\s+should\s+(?:we|i)\s+do\s+about)\b/i;

interface PlaybookRow {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

async function loadPlaybooks(ctx: ToolContext): Promise<PlaybookRow[]> {
  try {
    const { data } = await dbOf(ctx).from("recovery_playbooks").select("id,name,config,is_system,project_id")
      .or(`project_id.eq.${ctx.projectId},is_system.eq.true`).limit(100);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({ id: String(r.id), name: String(r.name ?? ""), config: (r.config ?? {}) as Record<string, unknown> }))
      // A playbook with no configured response is the no-recovery reference
      // the study already runs ("Baseline (no recovery)").
      .filter((p) => p.name && Object.keys(p.config).length > 0 && !/no recovery|^baseline/i.test(p.name));
  } catch {
    return [];
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Naming recovery responses side by side is a mitigation comparison even
 * without the word "mitigate": "compare expedite and backup supplier for …". */
const RESPONSE_COMPARE =
  /\b(compare|vs\.?|versus|which|best|better)\b[\s\S]*\b(expedit\w*|backup\s+supplier|capacity\s+surge|safety\s+buffer|reallocat\w*|recovery\s+(?:response|strateg\w*|playbook\w*))\b/i;

export const mitigationSkill: Skill = {
  id: "mitigation",
  drafts: true,
  describe: "compares recovery playbooks against a disruption by simulating each one on the same random numbers, and recommends the cheapest that measurably helps",
  example: "how do I mitigate an S001 outage in weeks 22–25?",
  recognize(input: SkillInput) {
    if (!MITIGATION_WORDS.test(input.utterance) && !RESPONSE_COMPARE.test(input.utterance)) return null;
    // The subject may be in an earlier message; resolved at run time so an
    // unresolvable one is ASKED about rather than falling through.
    return { subject: disruptionSubject(input) };
  },
  async run(ctx, match, input, opts): Promise<SkillResult> {
    const calls: SkillResult["calls"] = [];
    const subject = (match as { subject: ReturnType<typeof disruptionSubject> }).subject;
    if (!subject) {
      return {
        reply: "Which disruption should I find mitigations for? For example: \"mitigate an S001 outage in weeks 22–25\".",
        parts: [], calls, outcome: "needs_disruption",
      };
    }
    const p = await prepareWhatIf(ctx, subject.ask, parseRunChoice(input.utterance));
    if (!p.ok) return { reply: whatIfReply(p.outcome), parts: [], calls, outcome: p.outcome.kind };
    const prep = p.prep;

    const all = await loadPlaybooks(ctx);
    if (all.length === 0) {
      return {
        reply: "This project has no recovery playbooks to compare. Add one in the Simulation Lab (Recovery playbooks), then ask again.",
        parts: [], calls, outcome: "no_playbooks",
      };
    }
    // The user's own choice of playbooks, else the fastest-recovering ones.
    const named = all.filter((pb) => input.utterance.toLowerCase().includes(pb.name.toLowerCase()));
    const chosen = (named.length > 0 ? named : [...all].sort((a, b) =>
      (num(a.config.recovery_target_days) ?? Infinity) - (num(b.config.recovery_target_days) ?? Infinity)
    )).slice(0, COMPARISON_ARMS_MAX - 1);
    const arms: StudyArm[] = [
      { label: "No recovery", disruption_schedule: prep.schedule, recovery_overrides: {}, stated_cost: 0 },
      ...chosen.map((pb) => ({
        label: pb.name.slice(0, 60),
        disruption_schedule: prep.schedule,
        recovery_overrides: pb.config,
        recovery_playbook_id: pb.id,
        stated_cost: num(pb.config.cost_cap),
      })),
    ];
    const what = describeEvents(prep.events);
    const how = prep.mode === "model"
      ? ` Every arm follows Validated Model "${prep.model.name}".${prep.modeNote ? ` ${prep.modeNote}` : ""}`
      : ` ${prep.modeNote ?? "Exploratory — not a validated result."}`;
    const assumed = how + (prep.defaults.length ? ` I assumed ${prep.defaults.join(", ")}.` : "");

    const states = await locateArms(ctx, calls, prep, arms);
    if (states.every((s) => s.state === "done")) {
      const results = await loadArmResults(ctx, arms, states);
      const table = studyTable(results);
      const headline = orderKpis(results.flatMap((r) => [...r.kpis.keys()]), 1)[0];
      const cmp = headline ? compareOnKpi(results, headline) : [];
      const helping = cmp.map((c, i) => ({ ...c, cost: results[i].stated_cost })).filter((c) => c.verdict === "improves");
      const best = helping.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
      const unresolved = cmp.filter((c) => c.verdict === "unresolved").map((c) => c.label);
      const reps = results[0]?.run.rep_count_done ?? 0;
      const lines = [
        `I compared ${arms.length - 1} recovery playbooks against ${what}, each simulated on the same ${reps} replications (paired, 95% intervals).`,
        best
          ? `Recommendation: **${best.label}** — it measurably improves ${headline} by ${signed(best.delta!.mean)} ± ${fmt(best.delta!.ci)} over no recovery` +
            `${best.cost !== null && best.cost !== undefined ? `, at the lowest stated cost among those that help (${fmt(best.cost)})` : ""}.`
          : `None of them measurably improves ${headline ?? "the headline KPI"} over no recovery at this replication count.`,
        unresolved.length
          ? `Too close to call at ${reps} replications: ${unresolved.join(", ")} — ask for more replications (e.g. "with 30 replications") to separate them.`
          : "",
        "Costs are the playbooks' stated cost caps, not simulated costs.",
      ].filter(Boolean);
      return {
        reply: lines.join(" ") + assumed,
        parts: table ? [table] : [],
        calls,
        outcome: "answered",
        interpretation: null,
      };
    }
    if (states.some((s) => s.state === "pending")) {
      return { reply: `The mitigation study for ${what} is running. ${progressLine(arms, states)}`, parts: [], calls, outcome: "in_progress", pendingRunIds: states.flatMap((s) => (s.state === "pending" ? [s.runId] : [])) };
    }
    // MISS (some or all arms): one study card.
    const comparisonOn = experimentTypesEnabled().includes("comparison");
    if (!opts.canDraft || !comparisonOn) {
      const why = !comparisonOn ? "comparison experiments are not enabled in this deployment" : (opts.draftBlockedReason ?? "drafting isn't available here");
      return {
        reply: `No study has compared mitigations for ${what} yet, and I couldn't draft one (${why}). ` +
          `In the Simulation Lab you can run it as a design of experiments with the "Recovery playbook" factor: ` +
          `${arms.map((a) => a.label).join(", ")}, ${prep.replications} replications each.` + assumed,
        parts: [], calls, outcome: "not_proposed",
      };
    }
    const name = `Mitigation: ${what.replace(/ \(\d+ wk\)/g, "")}`;
    const { proposal, refusal } = await draftStudy(ctx, calls, prep, {
      name,
      horizonDays: studyHorizonDays(prep, arms.map((a) => a.disruption_schedule)),
      arms,
      title: `Mitigation study: ${what.replace(/ \(\d+ wk\)/g, "")}`,
    });
    if (!proposal) {
      return { reply: `I couldn't draft the mitigation study: ${refusal}`, parts: [], calls, outcome: "refused" };
    }
    return {
      reply: `I've drafted ONE study card comparing ${arms.map((a) => a.label).join(", ")} against ${what} — ` +
        `${arms.length} runs × ${prep.replications} replications on the same random numbers. ` +
        `Nothing runs until you approve it; once the runs finish I'll rank the playbooks with paired confidence intervals ` +
        `and recommend the cheapest one that measurably helps.` + assumed,
      parts: [{ kind: "proposal", data: proposal }],
      calls,
      proposal,
      outcome: "proposed",
      ...(subject.from === "history" ? { subjectText: subject.text } : {}),
    };
  },
};

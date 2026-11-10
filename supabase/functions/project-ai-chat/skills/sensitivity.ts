// M5 Sensitivity (ai-agents.md §26.3). "How sensitive is fill rate to how
// long the outage lasts / how severe it is / when it starts?" — a one-factor
// sweep run as ONE comparison card (§26 M.2), arms = the factor's levels on
// the same random numbers, compared against the first level.
//
// What it does NOT sweep, and says so: project DATA (a lead time, demand
// variability, a price, safety stock). A comparison arm can vary only what a
// scenario carries — its disruption schedule and recovery overrides — so a
// data sweep needs per-arm data overrides in the engine (WP M.2b). Saying so
// beats sweeping something else and calling it the asked factor.

import { describeEvents, prepareWhatIf, WHATIF_RULE, whatIfReply } from "../whatIf.ts";
import { COMPARISON_ARMS_MAX, experimentTypesEnabled } from "../experimentTools.ts";
import { fmt, orderKpis, signed, type Skill, type SkillInput, type SkillResult } from "./common.ts";
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

const SENSITIVITY_WORDS = /\b(sensitiv\w*|how\s+much\s+does\s+it\s+matter|vary(?:ing)?\s+the|sweep|what\s+if\s+it\s+lasts?\s+(?:longer|shorter))\b/i;
const DATA_FACTORS = /\b(lead[-\s]?times?|demand|cv|variabilit\w*|safety\s+stock|reorder|price|cost|moq|holding)\b/i;

type Factor = "duration" | "magnitude" | "start";

function factorOf(text: string): Factor | null {
  if (/\b(duration|long|lasts?|length)\b/i.test(text)) return "duration";
  if (/\b(severity|severe|magnitude|capacity|how\s+bad|share|percent|%)\b/i.test(text)) return "magnitude";
  if (/\b(start|when|timing|week\s+it\s+(?:hits|starts))\b/i.test(text)) return "start";
  return null;
}

/** Levels the user listed ("2, 4 and 8 weeks", "25/50/75%"), else defaults
 * around the base disruption — never more than the arm cap. */
function levels(text: string, factor: Factor, base: { durationWeeks: number; magnitude: number; startWeek: number }): number[] {
  // Only a LIST attached to the factor's unit counts: "2, 4 and 8 weeks",
  // "25/50/75%", "start weeks 10, 14, 18" — so the base disruption's own
  // "week 22" is never read as a level.
  const LIST = "((?:\\d{1,3}\\s*%?\\s*(?:,|and|or|\\/)\\s*)+\\d{1,3})";
  const re = factor === "duration"
    ? new RegExp(`${LIST}\\s*(?:weeks?|wks?)`, "i")
    : factor === "magnitude"
    ? new RegExp(`${LIST}\\s*%`, "i")
    : new RegExp(`weeks?\\s+${LIST}`, "i");
  const m = text.match(re);
  const listed = m ? [...m[1].matchAll(/\d{1,3}/g)].map((x) => Number(x[0])).filter((n) => n > 0) : [];
  const uniq = (xs: number[]) => [...new Set(xs)].slice(0, COMPARISON_ARMS_MAX);
  if (listed.length >= 2) return uniq(listed);
  if (factor === "duration") {
    const d = base.durationWeeks;
    return uniq([Math.max(1, Math.round(d / 2)), d, d * 2, d * 3].filter((w) => w <= WHATIF_RULE.duration_weeks_max));
  }
  if (factor === "magnitude") return [25, 50, 75, WHATIF_RULE.full_outage_pct];
  const s = base.startWeek;
  return uniq([Math.max(WHATIF_RULE.start_week_min, s - 8), Math.max(WHATIF_RULE.start_week_min, s - 4), s, s + 4]);
}

export const sensitivitySkill: Skill = {
  id: "sensitivity",
  drafts: true,
  describe: "sweeps one disruption factor (duration, severity or start week) and shows how the KPIs move, with paired intervals",
  example: "how sensitive is fill rate to how long the S001 outage lasts?",
  recognize(input: SkillInput) {
    if (!SENSITIVITY_WORDS.test(input.utterance)) return null;
    return { subject: disruptionSubject(input) };
  },
  async run(ctx, match, input, opts): Promise<SkillResult> {
    const calls: SkillResult["calls"] = [];
    const text = input.utterance;
    const factor = factorOf(text);
    if (!factor && DATA_FACTORS.test(text)) {
      const what = text.match(DATA_FACTORS)?.[0] ?? "that input";
      return {
        reply: `I can't sweep ${what} yet: a comparison arm can only vary what a scenario carries (the disruption and the recovery response), ` +
          `and varying project data per arm needs an engine hook that isn't built (ai-agents.md §26 WP M.2b). ` +
          `What I can sweep today: the disruption's duration, severity or start week.`,
        parts: [], calls, outcome: "unsupported_factor",
      };
    }
    const subject = (match as { subject: ReturnType<typeof disruptionSubject> }).subject;
    if (!subject) {
      return {
        reply: "Which disruption should I vary? For example: \"how sensitive is fill rate to how long an S001 outage lasts?\"",
        parts: [], calls, outcome: "needs_disruption",
      };
    }
    const f: Factor = factor ?? "duration";
    const p = await prepareWhatIf(ctx, subject.ask, parseRunChoice(input.utterance));
    if (!p.ok) return { reply: whatIfReply(p.outcome), parts: [], calls, outcome: p.outcome.kind };
    const prep = p.prep;
    const startWeek = prep.events[0].startWeek;
    const lv = levels(text, f, { durationWeeks: prep.durationWeeks, magnitude: prep.magnitude, startWeek });
    if (lv.length < 2) {
      return { reply: "A sweep needs at least two levels — name them, e.g. \"2, 4 and 8 weeks\".", parts: [], calls, outcome: "invalid" };
    }
    const arms: StudyArm[] = lv.map((v) => {
      const schedule = prep.schedule.map((e) => {
        if (f === "duration") return { ...e, duration_days: v * 7 };
        if (f === "magnitude") return { ...e, magnitude_pct: v };
        return { ...e, start_day: v * 7 };
      });
      const label = f === "duration" ? `${v} wk` : f === "magnitude" ? (v >= WHATIF_RULE.full_outage_pct ? "full outage" : `${v}% cut`) : `start wk ${v}`;
      return { label, disruption_schedule: schedule, recovery_overrides: {} };
    });
    const what = describeEvents(prep.events);
    const factorWords = f === "duration" ? "duration" : f === "magnitude" ? "severity" : "start week";

    const states = await locateArms(ctx, calls, prep, arms);
    if (states.every((s) => s.state === "done")) {
      const results = await loadArmResults(ctx, arms, states);
      const headline = orderKpis(results.flatMap((r) => [...r.kpis.keys()]), 1)[0];
      const cmp = headline ? compareOnKpi(results, headline) : [];
      const steps = cmp.slice(1).map((c) =>
        `${c.label}: ${c.delta ? `${signed(c.delta.mean)} ± ${fmt(c.delta.ci)}${c.verdict === "unresolved" ? " (unresolved)" : ""}` : "—"}`
      );
      const table = studyTable(results);
      return {
        reply: `Sensitivity of ${headline ?? "the KPIs"} to the disruption's ${factorWords} (${what}; reference ${arms[0].label}, ` +
          `paired over ${results[0]?.run.rep_count_done ?? 0} replications): ${steps.join("; ")}.`,
        parts: table ? [table] : [], calls, outcome: "answered",
      };
    }
    if (states.some((s) => s.state === "pending")) {
      return { reply: `The ${factorWords} sweep is running. ${progressLine(arms, states)}`, parts: [], calls, outcome: "in_progress", pendingRunIds: states.flatMap((s) => (s.state === "pending" ? [s.runId] : [])) };
    }
    if (!opts.canDraft || !experimentTypesEnabled().includes("comparison")) {
      return {
        reply: `No sweep of the ${factorWords} has run for ${what}, and I couldn't draft one ` +
          `(${!experimentTypesEnabled().includes("comparison") ? "comparison experiments are not enabled" : opts.draftBlockedReason ?? "drafting isn't available here"}). ` +
          `Levels I'd run: ${arms.map((a) => a.label).join(", ")}, ${prep.replications} replications each.`,
        parts: [], calls, outcome: "not_proposed",
      };
    }
    const { proposal, refusal } = await draftStudy(ctx, calls, prep, {
      name: `Sweep ${factorWords}: ${what.replace(/ \(\d+ wk\)/g, "")}`,
      horizonDays: studyHorizonDays(prep, arms.map((a) => a.disruption_schedule)),
      arms,
      title: `Sensitivity to ${factorWords}: ${what.replace(/ \(\d+ wk\)/g, "")}`,
    });
    if (!proposal) return { reply: `I couldn't draft the sweep: ${refusal}`, parts: [], calls, outcome: "refused" };
    return {
      reply: `I've drafted ONE sweep card: the ${factorWords} at ${arms.map((a) => a.label).join(", ")}, ` +
        `${arms.length} runs × ${prep.replications} replications on the same random numbers. Approve it to run; ` +
        `once it finishes I'll show how the KPIs move with paired intervals.` +
        (prep.mode === "model"
          ? ` Every arm follows Validated Model "${prep.model.name}".${prep.modeNote ? ` ${prep.modeNote}` : ""}`
          : ` ${prep.modeNote ?? "Exploratory — not a validated result."}`) +
        (prep.defaults.length ? ` I assumed ${prep.defaults.join(", ")}.` : ""),
      parts: [{ kind: "proposal", data: proposal }], calls, proposal, outcome: "proposed",
      ...(subject.from === "history" ? { subjectText: subject.text } : {}),
    };
  },
};

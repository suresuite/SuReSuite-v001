// S9 — questions ABOUT the Validated Model (ai-agents.md §28 Phase A, A.2):
// "which model am I using?", "is my model valid?", "why does it say stale?",
// "what's the protocol?", "do I need to re-validate?", "which runs followed
// the model?".
//
// Until this skill the model, its protocol and its drift were resolved inside
// every drafting skill and shown on cards, but a QUESTION about them reached
// no skill. Nothing is decided here: the model in force, its protocol and
// what moved since validation come from `resolveModelContext`, which reads
// the Lab's own rules (`_shared/modelRules.ts`). When the project has drifted
// the reply puts the choice to the user as numbered options (§27.8 decision
// 3: the chat never picks for them) and never says "valid" without saying
// what was validated.

import { driftReasons } from "../../_shared/modelRules.ts";
import { resolveModelContext } from "../modelContext.ts";
import { dbOf, loadRecentRuns, runKindLabel, type Skill, type SkillInput, type SkillResult } from "./common.ts";

const MODEL_NOUN = /\b(model|baseline|validat\w*|credibility|badge|protocol)\b/i;
const MODEL_ASK =
  /\b(which|what)\s+(?:validated\s+)?model\b|\bis\s+(?:my|the|our)\s+(?:model|baseline)\s+(?:still\s+)?(?:valid(?:ated)?|stale|in\s+force|current|out\s+of\s+date|credible|trustworthy)\b|\bwhy\s+(?:does|is|did)\s+(?:it|my\s+model|the\s+model|the\s+badge)\s+(?:say\s+|show\s+|marked\s+)?(?:stale|drift\w*|not\s+validated|unvalidated)\b|\bwhat\s+(?:has\s+)?changed\s+since\s+(?:i\s+|we\s+)?(?:last\s+)?validat\w*|\b(?:what(?:'s|\s+is)|show(?:\s+me)?)\s+(?:the\s+|my\s+)?(?:model'?s?\s+)?protocol\b|\bprotocol\s+of\s+(?:my|the|our)\s+model\b|\b(?:do|should)\s+(?:i|we)\s+(?:need\s+to\s+|have\s+to\s+)?re[-\s]?validate\b|\bwhat\s+(?:is|'s)\s+(?:my|the|our)\s+baseline\s+run\b|\b(?:credibility|validation)\s+badge\b|\bmodel\s+status\b|\bwhat\s+seed\s+does\s+(?:my|the|our)\s+model\b/i;
const RUNS_ASK = /\bwhich\s+(?:of\s+my\s+)?runs?\s+(?:followed|follow|used|were|are)\b[^?]*\b(model|explorator\w*)\b/i;

interface ModelMatch { runs: boolean }

const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export const modelSkill: Skill = {
  id: "model",
  drafts: false,
  describe: "says which Validated Model is in force, its protocol, whether your project has changed since it was validated, and what you can do about it",
  example: "which validated model am I using?  ·  why does it say stale?",
  recognize(input: SkillInput): ModelMatch | null {
    const u = input.utterance;
    if (RUNS_ASK.test(u)) return { runs: true };
    return MODEL_ASK.test(u) && MODEL_NOUN.test(u) ? { runs: false } : null;
  },
  async run(ctx, match, input): Promise<SkillResult> {
    const m = match as ModelMatch;
    const calls: SkillResult["calls"] = [];
    const db = dbOf(ctx);
    if (m.runs) {
      const runs = (await loadRecentRuns(db, ctx.projectId, 30)).filter((r) => r.status === "done");
      if (runs.length === 0) return { reply: "There are no finished runs on this project yet.", parts: [], calls, outcome: "no_runs" };
      const rows: Array<[string, number, string]> = [];
      for (const r of runs.slice(0, 20)) rows.push([r.id.slice(0, 8), r.rep_count_done, await runKindLabel(db, r)]);
      const followed = rows.filter((r) => r[2].startsWith("follows")).length;
      return {
        reply: `Of your ${rows.length} most recent finished runs, ${followed} followed a Validated Model and ${rows.length - followed} ${rows.length - followed === 1 ? "was" : "were"} exploratory. Only a run that followed a model is a validated result. Source: each run's own record.`,
        parts: [{ kind: "table", data: { columns: ["Run", "Replications", "Kind"], rows } }],
        calls, outcome: "runs_labelled",
      };
    }
    const model = await resolveModelContext(ctx, input.utterance);
    if (!model.card) {
      return {
        reply: "This project has no Validated Model in force, so nothing you run now is a validated result. " +
          "To get one: run your baseline and validate it (Policies → Run & Validate, or ask me \"what does it take to validate my model?\"). " +
          "Until then I only run what-ifs as exploratory, and only when you ask for that.",
        parts: [], calls, outcome: "no_model",
      };
    }
    const card = model.card;
    const p = model.protocol;
    const when = day(card.validated_at);
    const protocolBits = [
      p.replications != null ? `${p.replications} replications` : null,
      p.horizon_weeks != null ? `${p.horizon_weeks}-week horizon` : null,
      p.warmup_week != null ? `warm-up to week ${p.warmup_week}` : null,
      p.root_seed != null ? `seed ${p.root_seed}` : null,
      p.crn != null ? (p.crn ? "common random numbers on" : "common random numbers off") : null,
    ].filter(Boolean);
    let policyLabel = "";
    try {
      const { data } = await db.from("policy_versions").select("id,label").eq("id", card.policy_version_id).maybeSingle();
      const v = data as Record<string, unknown> | null;
      if (v) policyLabel = String(v.label ?? String(v.id).slice(0, 8));
    } catch { /* the model still stands; the version label is decoration */ }
    const head = `Your Validated Model is **${model.name}**${when ? ` (validated ${when})` : ""}.`;
    const what = `It validated policy version ${policyLabel ? `"${policyLabel}"` : String(card.policy_version_id ?? "unknown").slice(0, 8)}` +
      `${card.dataset_version_id ? ` on data version ${String(card.dataset_version_id).slice(0, 8)}` : " (it does not record its data version)"}.`;
    const protocol = protocolBits.length
      ? ` Protocol: ${protocolBits.join(", ")}.`
      : " It records no protocol, so runs take the baseline scenario's own settings.";
    const baseline = model.evidenceRunId ? ` Its baseline run is ${model.evidenceRunId.slice(0, 8)}.` : " It names no baseline run.";
    const rows: Array<[string, string]> = [
      ["Model", model.name],
      ...(when ? [["Validated", when] as [string, string]] : []),
      ["Policy version", policyLabel || String(card.policy_version_id ?? "-")],
      ["Data version", card.dataset_version_id ? String(card.dataset_version_id).slice(0, 8) : "not recorded"],
      ...protocolBits.map((b, i) => [i === 0 ? "Protocol" : "", String(b)] as [string, string]),
      ["Baseline run", model.evidenceRunId ? model.evidenceRunId.slice(0, 8) : "-"],
    ];
    const part = { kind: "table", data: { columns: ["", ""], rows } };
    const offer = model.offer;
    if (offer?.kind === "blocked") {
      return { reply: `${head} ${offer.reason} ${what}${protocol}`, parts: [part], calls, outcome: "blocked" };
    }
    if (model.drift.length === 0) {
      return {
        reply: `${head} It is **in force**: neither your policies nor the simulation's inputs have changed since it was validated, so a what-if I run follows it and is a validated result. ${what}${protocol}${baseline}`,
        parts: [part], calls, outcome: "in_force",
      };
    }
    const reasons = driftReasons(model.drift).join(" and ");
    const replayable = !(offer?.kind === "moved" && !offer.replayable);
    const options = [
      replayable
        ? "run what-ifs **as validated** — on the data and policies the model was validated with (recommended while the change is not final; the result is validated, about the validated setup)"
        : null,
      "**re-validate** with the project as it is now (Policies → Run & Validate) — recommended once the change is final",
      "run the project's current data and policies **as exploratory** — a quick look, labelled as not validated",
    ].filter(Boolean).map((o, i) => `${i + 1}. ${o}`);
    return {
      reply: `${head} It is **stale**: ${reasons} since it was validated. ${what}${protocol}${baseline}\n\nYour options:\n${options.join("\n")}\n\n` +
        "I'll ask which one you want each time you ask for a run.",
      parts: [part], calls, outcome: "stale",
    };
  },
};

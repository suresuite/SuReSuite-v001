// The Phase M skill registry (ai-agents.md §26, WP M.1).
//
// ORDER IS PRECEDENCE: the first skill whose conservative recognizer claims a
// message runs it. More specific asks come first — "how do I mitigate the
// S001 outage?" is a mitigation ask even though it names a disruption, and
// "why did fill rate drop?" is an explanation even though it names a KPI.
// A message no skill claims goes to the router and the free tool loop as
// before (with the §21.5 wrap-up reserve).
//
// Kill switches: MODELER_SKILLS (unset ⇒ every skill on; "off" ⇒ none; else
// a comma list of skill ids) and, for back-compatibility, WHATIF_LOOP_ENABLED
// =false removes the what-if skill (§20.8).

import { parseWhatIf, runWhatIfLoop, whatIfInterpretationMessage, whatIfLoopEnabled, whatIfReply } from "../whatIf.ts";
import type { Skill, SkillId, SkillInput, SkillResult } from "./common.ts";
import { parseRunChoice } from "../modelContext.ts";
import { mitigationSkill } from "./mitigation.ts";
import { sensitivitySkill } from "./sensitivity.ts";
import { resultsSkill } from "./results.ts";
import { readinessSkill } from "./readiness.ts";
import { setupSkill } from "./setup.ts";
import { explainSkill } from "./explain.ts";
import { howtoSkill } from "./howto.ts";
import { modelSkill } from "./model.ts";
import { criticalWhatIfSkill, stressSkill } from "./stress.ts";
import { significanceSkill, statusSkill } from "./evidence.ts";
import { optimizeSkill, outOfScopeSkill, predictSkill } from "./guards.ts";
import { centralitySkill, criticalSkill, networkSkill } from "./network.ts";

export type { Skill, SkillId, SkillInput, SkillOptions, SkillResult } from "./common.ts";

/** M1 — the §20.8 loop, unchanged, behind the skill contract. */
export const whatIfSkill: Skill = {
  id: "whatif",
  drafts: true,
  describe: "answers a disruption what-if from a finished run, or drafts the one run that answers it",
  example: "what if S001 is down in weeks 22–25?",
  recognize(input: SkillInput) {
    return parseWhatIf(input.utterance);
  },
  async run(ctx, match, input, opts): Promise<SkillResult> {
    const wi = await runWhatIfLoop(ctx, match as NonNullable<ReturnType<typeof parseWhatIf>>, {
      canDraft: opts.canDraft,
      draftBlockedReason: opts.draftBlockedReason,
    });
    return {
      reply: whatIfReply(wi.outcome),
      parts: wi.parts,
      calls: wi.calls,
      proposal: wi.outcome.kind === "proposed" ? wi.outcome.proposal : null,
      interpretation: whatIfInterpretationMessage(input.utterance, wi.outcome),
      outcome: wi.outcome.kind,
    };
  },
};

const CAPABILITY_WORDS =
  /^\s*(?:what\s+can\s+you\s+(?:do|help\s+(?:me\s+)?with)|what\s+can\s+i\s+ask(?:\s+you)?|what\s+are\s+you\s+able\s+to\s+do|help|capabilities|what\s+do\s+you\s+do)\s*[?.!]*\s*$/i;

/** M.6 one front door: the modeler states what it can and cannot do. */
export const capabilitiesSkill: Skill = {
  id: "capabilities",
  drafts: false,
  describe: "lists what the simulation modeler can do",
  example: "what can you do?",
  recognize(input: SkillInput) {
    return CAPABILITY_WORDS.test(input.utterance) ? {} : null;
  },
  async run(_ctx, _m, _input, opts): Promise<SkillResult> {
    const lines = enabledSkills().filter((s) => s.id !== "capabilities").map((s) =>
      `- **${s.describe.charAt(0).toUpperCase()}${s.describe.slice(1)}** — e.g. "${s.example}"`
    );
    const drafting = opts.canDraft
      ? "When an answer needs a new simulation, I draft one card; nothing runs until you approve it."
      : `I can't file run cards here (${opts.draftBlockedReason ?? "drafting is off"}), so for new runs I'll give you the exact Lab settings.`;
    return {
      reply: `As your simulation modeler I can:\n${lines.join("\n")}\n\n${drafting} ` +
        `I can't change your data or policies on my own, and I don't predict results — every number comes from a run.`,
      parts: [], calls: [], outcome: "listed",
    };
  },
};

/** Precedence order (see header). */
export const SKILLS: readonly Skill[] = [
  capabilitiesSkill,
  mitigationSkill,
  sensitivitySkill,
  explainSkill,
  // §28 A.5 — "simulate losing my most critical supplier": the ranked phrase is
  // resolved from the stored analysis BEFORE the what-if parser can read a
  // word of it as a target.
  criticalWhatIfSkill,
  whatIfSkill,
  // §28 A.1 — network reads. `network` first: "when were critical nodes last
  // computed?" asks about the analysis, not for the ranking.
  networkSkill,
  criticalSkill,
  centralitySkill,
  // §28 A.2 — questions about the Validated Model itself; before readiness,
  // which keeps "can I run?".
  modelSkill,
  readinessSkill,
  setupSkill,
  // §28 A.5 — the stored stress test; after setup, which owns "what horizon
  // for a stress test?".
  stressSkill,
  // §28 A.4 — "is the difference real?" and "is my run done?"
  significanceSkill,
  statusSkill,
  resultsSkill,
  // §28 A.3 — the honest limits, after every skill that can actually answer.
  optimizeSkill,
  predictSkill,
  outOfScopeSkill,
  howtoSkill,
];

export function enabledSkills(): Skill[] {
  const raw = (Deno.env.get("MODELER_SKILLS") ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "none") return [];
  const allow = raw ? new Set(raw.split(",").map((s) => s.trim())) : null;
  return SKILLS.filter((s) => (allow ? allow.has(s.id) : true) && (s.id !== "whatif" || whatIfLoopEnabled()));
}

export interface SkillHit {
  skill: Skill;
  match: unknown;
  /** The input the skill runs on — the message itself, or (for a follow-up
   * choice) the earlier question joined with the choice. */
  input: SkillInput;
}

export function matchSkill(input: SkillInput): SkillHit | null {
  const skills = enabledSkills();
  for (const skill of skills) {
    const match = skill.recognize(input);
    if (match !== null && match !== undefined) return { skill, match, input };
  }
  // §27 follow-up: "run as validated" / "run it as exploratory" / "extend the
  // horizon" answers a question the assistant asked about an EARLIER what-if,
  // mitigation or sweep. Re-run that skill on the earlier question joined
  // with the choice (the user's own words, both of them).
  const choice = parseRunChoice(input.utterance);
  if ((choice.mode || choice.extendHorizon) && input.utterance.length <= 160) {
    const users = input.history.filter((h) => h.role === "user" && typeof h.content === "string");
    for (let i = users.length - 1; i >= 0 && i >= users.length - 6; i--) {
      const prior = users[i].content;
      for (const skill of skills.filter((sk) => sk.drafts)) {
        if (skill.recognize({ utterance: prior, history: [] }) == null) continue;
        const joined: SkillInput = { utterance: `${prior} — ${input.utterance}`.slice(0, 2000), history: input.history };
        const match = skill.recognize(joined);
        if (match !== null && match !== undefined) return { skill, match, input: joined };
      }
    }
  }
  return null;
}

export function skillById(id: string): Skill | null {
  return SKILLS.find((s) => s.id === id) ?? null;
}

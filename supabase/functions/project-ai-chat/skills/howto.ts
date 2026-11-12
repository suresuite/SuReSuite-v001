// M7 Technical how-to (ai-agents.md §26.3). "What is TTR?", "what does
// P-P.1 do?", "how do I add a scenario?" — answered from the platform's own
// manual, engine reference and policy catalog (skills/knowledge.ts), cited.
//
// It claims a question ONLY when it is a general how/what question (not about
// this project's data — no "my", no entity id) AND a passage matches it
// strongly; otherwise the question falls through to the normal path. A wrong
// passage confidently cited is worse than no skill.

import { searchKnowledge, type Hit } from "./knowledge.ts";
import type { Skill, SkillInput, SkillResult } from "./common.ts";

const HOWTO_START =
  /^\s*(?:what\s+(?:is|are|does|do)\b|what's\b|how\s+(?:do|can|should)\s+i\b|how\s+to\b|how\s+does\b|where\s+(?:do|can)\s+i\b|explain\b|define\b|what\s+is\s+the\s+(?:difference|meaning)\b|what\s+does\s+\S+\s+mean\b)/i;
const PROJECT_SPECIFIC = /\b(my|our|this\s+project|the\s+project's|last\s+run|latest\s+run)\b|\b[A-Za-z]{1,4}[-_]?\d{2,6}\b/i;
/** A policy catalog id (P-S.1, P-P.3 …) is NOT project data — it names the catalog. */
const CATALOG_ID = /\bP-[SPTCFXW]\.\d+\b/i;

const MIN_SCORE = 6;

function strong(hits: Hit[]): boolean {
  const top = hits[0];
  return !!top && top.score >= MIN_SCORE && top.matched >= Math.min(2, top.asked);
}

export const howtoSkill: Skill = {
  id: "howto",
  drafts: false,
  describe: "answers how-to and definition questions from the platform's own manual, engine reference and policy catalog, with citations",
  example: "what is TTR?  ·  what does P-P.1 do?  ·  how do I add a scenario?",
  recognize(input: SkillInput) {
    const q = input.utterance;
    if (!HOWTO_START.test(q)) return null;
    const stripped = q.replace(CATALOG_ID, "");
    if (PROJECT_SPECIFIC.test(stripped)) return null;
    const hits = searchKnowledge(q, 3);
    return strong(hits) ? { hits } : null;
  },
  async run(_ctx, match, input): Promise<SkillResult> {
    const hits = (match as { hits: Hit[] }).hits.filter((h, i, all) => i === 0 || h.score >= all[0].score * 0.6).slice(0, 2);
    const excerpt = (t: string) => (t.length > 420 ? `${t.slice(0, 417)}…` : t);
    const cites = hits.map((h, i) => `[${i + 1}] ${h.entry.title} — ${h.entry.ref}`);
    const reply = `From the platform's ${hits[0].entry.source === "docs" ? "manual" : hits[0].entry.source === "policy" ? "policy catalog" : "engine reference"}: ` +
      `${excerpt(hits[0].entry.text)} [1]\n\n${cites.join("\n")}`;
    return {
      reply,
      parts: [],
      calls: [],
      outcome: "cited",
      leadWithInterpretation: true,
      footer: cites.join("\n"),
      // The one interpretation call may only restate these passages.
      interpretation: `[internal handoff — this is not a user message]
The user asked: "${input.utterance.slice(0, 500)}"
Passages from the platform's own documentation:
${hits.map((h, i) => `[${i + 1}] ${h.entry.title}: ${h.entry.text}`).join("\n")}
Answer the question in 2-4 plain sentences using ONLY these passages, and end
each sentence that uses one with its marker [1] or [2]. If the passages do not
answer it, say so in one sentence.`,
    };
  },
};

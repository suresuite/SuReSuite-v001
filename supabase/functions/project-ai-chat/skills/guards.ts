// The honest-limit skills (ai-agents.md §28 Phase A, A.3): three kinds of
// question this platform cannot answer, each given ONE fixed reply in code so
// it never reaches a model as an open question (§28.3 S14, S15, X1).
//
//   optimize    "what's the optimal safety stock?"   The tool simulates; it
//               does not optimize. The reply offers what it CAN do.
//   predict     "what will fill rate be?", "just estimate it"   No KPI is ever
//               predicted (R-no-predict); the reply offers the run.
//   outofscope  industry benchmarks, live world events, company facts not in
//               the project, other projects, unrelated tasks.
//
// These are deliberately conservative recognizers placed LAST before the
// how-to skill: a what-if, a mitigation ask or a setup question that happens
// to contain "best" or "estimate" has already been claimed by its own skill.

import { deploymentEnabledAgents } from "../router.ts";
import type { Skill, SkillInput, SkillResult } from "./common.ts";

const none: Pick<SkillResult, "parts" | "calls"> = { parts: [], calls: [] };

// ── S14 · optimize ──────────────────────────────────────────────────────────

const OPTIMIZE_WORDS =
  /\b(optim(?:al|um|i[sz]e\w*|i[sz]ation)|minimi[sz]e\w*|maximi[sz]e\w*|tune\s+(?:my|the|our)\s+polic\w+|auto[-\s]?tune|find\s+(?:me\s+)?the\s+best|best\s+(?:reorder\s+point|safety\s+stock|moq|lot\s+size|order\s+quantity|policy|polic\w+\s+settings?|settings?|parameters?|values?)|what\s+polic\w+\s+should\s+(?:i|we)\s+(?:use|choose|pick|set))\b/i;

export const optimizeSkill: Skill = {
  id: "optimize",
  drafts: false,
  describe: "says plainly that the platform simulates rather than optimizes, and offers the comparison that finds the better setting",
  example: "what's the optimal safety stock for M001?",
  recognize(input: SkillInput) {
    return OPTIMIZE_WORDS.test(input.utterance) ? {} : null;
  },
  // deno-lint-ignore require-await
  async run(): Promise<SkillResult> {
    return {
      reply: "This platform simulates your supply chain; it does not search for an optimal value, so I have no \"best\" number to give you — and I won't guess one. What you can do:\n" +
        "1. **Compare candidates you choose** (recommended): save each candidate setting as a policy version on the Policies page, then run them against each other in the Simulation Lab. The comparison uses the same random numbers for every candidate, so the difference you see is the setting's.\n" +
        "2. **For a disruption response**, ask me \"how do I mitigate …\": that study ranks your recovery playbooks and names the cheapest one that holds the service level.\n" +
        "3. **For safety stock**, the Simulation Lab's safety-stock panel shows what the current rule yields per item.\n" +
        "Any value I recommend has to come from one of those runs.",
      ...none, outcome: "not_supported",
    };
  },
};

// ── S15 · predict ───────────────────────────────────────────────────────────

const OUTCOME_WORDS = /\b(fill\s*rate|service\s+level|otif|backlog|lost\s+sales|stock[-\s]?outs?|revenue|profit|impact|outcome|results?|kpis?|happen)\b/i;
const PARAMETER_WORDS = /\b(holding|ordering|unit|purchase|transport)\s+(?:cost|price)|\bparameters?\b|\bmissing\b|\bfill\s+(?:in|the)\b/i;
const PREDICT_VERB = /\b(predict\w*|forecast\w*|project(?:ed|ion)\b)/i;
const GUESS_VERB = /\b(estimate|roughly|ballpark|rough\s+(?:idea|number|guess)|guess|approximate\w*|off\s+the\s+top)\b/i;
const NO_RUN = /\bwithout\s+(?:running|simulating|a\s+(?:run|simulation))\b|\bdon'?t\s+(?:run|simulate)\b|\bno\s+need\s+to\s+(?:run|simulate)\b/i;
const FUTURE_KPI = /\bwhat\s+will\s+(?:my|our|the)?\s*(?:fill\s*rate|service\s+level|backlog|lost\s+sales|costs?|revenue|profit)\b/i;
const PROBABILITY = /\b(probabilit\w+|likelihood|how\s+likely|chances?\s+(?:of|that)|odds\s+(?:of|that))\b/i;
const DEMAND_FORECAST = /\bforecast\w*\s+(?:the\s+|my\s+|our\s+)?demand\b|\bdemand\s+forecast\s+for\b|\bpredict\w*\s+(?:the\s+|my\s+|our\s+)?demand\b/i;

interface PredictMatch { kind: "probability" | "demand" | "kpi" }

export const predictSkill: Skill = {
  id: "predict",
  drafts: false,
  describe: "declines to predict or estimate a result, and offers the run that would measure it",
  example: "what will fill rate be next quarter?",
  recognize(input: SkillInput): PredictMatch | null {
    const u = input.utterance;
    if (PROBABILITY.test(u)) return { kind: "probability" };
    if (DEMAND_FORECAST.test(u)) return { kind: "demand" };
    if (PARAMETER_WORDS.test(u)) return null; // "estimate the holding cost" is a data ask
    if (FUTURE_KPI.test(u) || NO_RUN.test(u)) return { kind: "kpi" };
    if ((PREDICT_VERB.test(u) || GUESS_VERB.test(u)) && OUTCOME_WORDS.test(u)) return { kind: "kpi" };
    return null;
  },
  // deno-lint-ignore require-await
  async run(_ctx, match): Promise<SkillResult> {
    const m = match as PredictMatch;
    if (m.kind === "probability") {
      return {
        reply: "The platform does not estimate how likely a real-world event is — it holds no failure probabilities, and I won't supply one from general knowledge. " +
          "What it does is simulate what happens **if** the event occurs. Ask e.g. \"what if S001 is down for 4 weeks from week 22?\", or \"which supplier is most critical?\" for the share of demand each one puts at risk.",
        ...none, outcome: "refused_prediction",
      };
    }
    if (m.kind === "demand") {
      return {
        reply: "The platform does not produce a demand forecast. The engine plans from the demand your customer data already carries (its forecast or mean, per customer and product), and I won't invent one. " +
          "To see what the project holds, ask \"what does customer C1 order?\"; to change it, edit the customer data and re-validate.",
        ...none, outcome: "refused_prediction",
      };
    }
    return {
      reply: "I don't predict or estimate results — not even roughly. Every number I give comes from a run of your model or from your project's data, with its source. " +
        "Ask it as a what-if (e.g. \"what if S001 is down for 4 weeks from week 22?\"): I first look for a finished run that already answers it, and only if there is none do I draft one run for your approval. " +
        "For what your model shows today, ask \"what did the last run show?\".",
      ...none, outcome: "refused_prediction",
    };
  },
};

// ── X1 · out of scope ───────────────────────────────────────────────────────

const BENCHMARK = /\b(industry\s+(?:average|standard|benchmark|norm)s?|benchmarks?\s+for|typical(?:ly)?\s+(?:for|in)\s+(?:the\s+)?\w+\s+(?:industry|sector)|(?:good|normal|typical|average)\s+(?:fill\s*rate|service\s+level|lead\s+time|inventory\s+turns?)\b[^?]*\b(?:industry|sector|companies|competitors)|compared?\s+(?:to|with)\s+(?:the\s+)?(?:industry|competitors|other\s+companies)|best\s+practices?)\b/i;
const LIVE_EVENT = /\b(right\s+now|currently\s+happening|latest\s+news|in\s+the\s+news|today'?s\s+news|is\s+there\s+(?:a|an)\s+[\w\s]{0,30}(?:strike|shortage|storm|war|embargo|tariff)|weather|stock\s+price|exchange\s+rate)\b/i;
const COMPANY_FACT = /\b(credit\s+rating|financial\s+health|bankrupt\w*|market\s+cap|share\s+price|ceo\s+of|headquarter\w*|how\s+many\s+employees)\b/i;
const OTHER_PROJECT = /\b(?:another|other|different|previous)\s+projects?\b|\bacross\s+(?:all\s+)?(?:my\s+|our\s+)?projects\b/i;
const UNRELATED = /\b(?:write|generate|give)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:python|sql|javascript|vba|excel\s+macro|script|code|poem|song|joke|essay|email)\b|\bcapital\s+of\b|\bwho\s+(?:won|is\s+the\s+president)\b|\btranslate\b|\brecipe\b/i;

type Scope = "benchmark" | "live" | "company" | "other_project" | "unrelated";

export const outOfScopeSkill: Skill = {
  id: "outofscope",
  drafts: false,
  describe: "says what the platform does not hold — industry benchmarks, live events, other projects — and points to the nearest thing it does",
  example: "what's a good fill rate for my industry?",
  recognize(input: SkillInput): { scope: Scope } | null {
    const u = input.utterance;
    if (UNRELATED.test(u)) return { scope: "unrelated" };
    if (OTHER_PROJECT.test(u)) return { scope: "other_project" };
    if (BENCHMARK.test(u)) return { scope: "benchmark" };
    if (COMPANY_FACT.test(u)) return { scope: "company" };
    // A live-event ask belongs to the Disruption Sentinel where it is enabled.
    if (LIVE_EVENT.test(u) && !deploymentEnabledAgents().includes("disruption-sentinel")) return { scope: "live" };
    return null;
  },
  // deno-lint-ignore require-await
  async run(_ctx, match): Promise<SkillResult> {
    const { scope } = match as { scope: Scope };
    const closing = " I answer from this project's data, its simulation runs and its network analyses — ask \"what can you do?\" for the list.";
    const reply: Record<Scope, string> = {
      benchmark: "I don't hold industry benchmarks or best-practice figures, and I won't quote one from general knowledge — it would be a number with no source. " +
        "The nearest thing I do have is your own baseline: ask \"what did the last run show?\" for your model's fill rate and service level, with the run they came from." + closing,
      live: "I have no live view of the world — no news, weather, markets or current events — so I can't tell you whether something is happening now. " +
        "If you want to know what it would do to you, describe it as a what-if (\"what if S001 is down for 4 weeks from week 22?\") and I'll simulate it." + closing,
      company: "I only know what your project's data says about a company — its lanes, lead times, prices, and its place in your network. Credit ratings, financials and corporate facts are not in the project, and I won't supply them from general knowledge. " +
        "Ask e.g. \"what does supplier S001 supply?\" or \"is S001 critical?\"." + closing,
      other_project: "I can only read the project this conversation is attached to; other projects are not visible to me here. Open the other project and ask there." + closing,
      unrelated: "That's outside what I do here." + closing,
    };
    return { reply: reply[scope], ...none, outcome: "out_of_scope" };
  },
};

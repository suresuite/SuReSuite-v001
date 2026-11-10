// Phase A, package A.3 (ai-agents.md §28): the honest-limit skills. Each
// question the platform cannot answer gets one fixed reply — no number, no
// general knowledge — and the next step the platform CAN take.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import type { ToolContext } from "../tools.ts";

const ctx = {} as ToolContext; // these skills read nothing
async function ask(utterance: string) {
  const hit = matchSkill({ utterance, history: [] });
  if (!hit) return { skill: null as string | null, outcome: "-", reply: "" };
  const r = await hit.skill.run(ctx, hit.match, { utterance, history: [] }, { canDraft: true, enabledAgents: [] });
  return { skill: hit.skill.id as string, outcome: r.outcome, reply: r.reply, calls: r.calls };
}
/** A reply that refuses must not carry a figure (a percentage or a decimal). */
const noFigure = (reply: string) => assertEquals(reply.replace(/\b(?:S|M|P|C)\d+\b|\bweek\s+\d+|\b\d+\s+weeks?\b/gi, "").match(/\d+(?:\.\d+)?\s*%|\b\d+\.\d+\b/g), null);

Deno.test("S14: 'optimal' is refused — the platform simulates — with numbered options", async () => {
  const r = await ask("what's the optimal safety stock for M001?");
  assertEquals([r.skill, r.outcome], ["optimize", "not_supported"]);
  assertStringIncludes(r.reply, "does not search for an optimal value");
  assertStringIncludes(r.reply, "1. **Compare candidates you choose** (recommended)");
  assertStringIncludes(r.reply, "2. ");
  assertStringIncludes(r.reply, "Any value I recommend has to come from one of those runs");
  noFigure(r.reply);
});

Deno.test("S15: a prediction, an estimate, a probability and a demand forecast are each refused", async () => {
  const kpi = await ask("what will fill rate be next quarter?");
  assertEquals([kpi.skill, kpi.outcome], ["predict", "refused_prediction"]);
  assertStringIncludes(kpi.reply, "I don't predict or estimate results");
  assertStringIncludes(kpi.reply, "draft one run for your approval");
  noFigure(kpi.reply);

  const rough = await ask("roughly, what would happen? just estimate the fill rate");
  assertEquals(rough.outcome, "refused_prediction");
  assertStringIncludes(rough.reply, "not even roughly");

  const prob = await ask("what's the probability S1 fails this year?");
  assertStringIncludes(prob.reply, "does not estimate how likely");
  noFigure(prob.reply);

  const dem = await ask("forecast demand for P1");
  assertStringIncludes(dem.reply, "does not produce a demand forecast");
});

Deno.test("X1: benchmarks, live events, company facts, other projects and unrelated asks get the fixed refusal", async () => {
  const cases: Array<[string, string]> = [
    ["what's a good fill rate for the electronics industry?", "don't hold industry benchmarks"],
    ["is there a port strike in Rotterdam right now?", "no live view of the world"],
    ["what's TTI's credit rating?", "are not in the project"],
    ["what happened in another project?", "only read the project this conversation is attached to"],
    ["write me a Python script to parse a CSV", "outside what I do here"],
    ["what is the capital of France?", "outside what I do here"],
  ];
  for (const [u, want] of cases) {
    const r = await ask(u);
    assertEquals([r.skill, r.outcome], ["outofscope", "out_of_scope"], u);
    assertStringIncludes(r.reply, want);
    noFigure(r.reply);
    assert(!/paris/i.test(r.reply));
  }
});

Deno.test("X1: a live-event ask is left to the Disruption Sentinel where it is enabled", () => {
  Deno.env.set("AGENT_ENABLED_IDS", "disruption-sentinel");
  try {
    assertEquals(matchSkill({ utterance: "is there a port strike in Rotterdam right now?", history: [] })?.skill.id ?? null, null);
  } finally {
    Deno.env.delete("AGENT_ENABLED_IDS");
  }
});

Deno.test("A.3: a limit skill never takes a question another skill or agent can answer", () => {
  const table: Array<[string, string | null]> = [
    ["which playbook is best for an S1 outage in weeks 22-25?", "mitigation"],
    ["what's the cheapest response that keeps fill rate above 95% for an S1 outage at week 22 for 4 weeks?", "mitigation"],
    // precedence: these contain "find the best" / "estimate the impact"
    ["find the best playbook for an S1 outage in weeks 22-25", "mitigation"],
    ["what if S1 goes down at week 22 for 4 weeks? roughly estimate the impact", "whatif"],
    ["how many replications do I need?", "setup"],
    ["estimate the holding cost for MAT-4", null],
    ["estimate the missing unit prices so my results are complete", null], // a Cost Estimator ask
    ["fill missing products.demand_cv", null],
    ["what is TTR?", "howto"],
    ["what if S1 goes down at week 4 for 6 weeks?", "whatif"],
    ["which supplier is most critical?", "critical"],
    ["what did the last run show?", "results"],
  ];
  const misses: string[] = [];
  for (const [u, want] of table) {
    const got = matchSkill({ utterance: u, history: [] })?.skill.id ?? null;
    if (got !== want) misses.push(`"${u}": want ${want}, got ${got}`);
  }
  assertEquals(misses, [], misses.join("\n"));
});

// Phase A, package A.5 (ai-agents.md §28): the stored stress test (S13) and
// the network ↔ simulation bridge (N8). Deterministic tier over the
// network-heavy stub. In it the STATIC analysis ranks S2 first (100% of
// demand at risk) and the SIMULATED stress test ranks S1 first (€412,000
// average lost sales) — on purpose, so a reply that mixed the two is caught.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import { runSkillTurn } from "../skills/runner.ts";
import { makeRequestBudget } from "../budgets.ts";
import { validatedProject } from "./harness/model_fixture.ts";
import { networkProject, type NetworkOptions } from "./harness/network_fixture.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function ask(utterance: string, net: NetworkOptions = {}, opts: { noModel?: boolean } = {}) {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  const tables = structuredClone(f.project_snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
  validatedProject(tables);
  if (opts.noModel) tables.model_validations = [];
  const rpcs = makeAgentRpcs(tables, { graphHash: "graph-hash-1" });
  rpcs.current_policy_hash = () => "ph-run";
  networkProject(tables, rpcs, net);
  const ctx: ToolContext = {
    projectId: PROJECT, userId: USER,
    supabase: makeStubDb(tables, rpcs) as unknown as ToolContext["supabase"],
    draft: { userEmail: "a@example.com", threadId: null, modelCode: "gpt-5", providerCode: "openai", canProposals: true, utterance },
  };
  const input = { utterance, history: [] };
  const hit = matchSkill(input);
  assert(hit, `no skill claims "${utterance}"`);
  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.set("AGENT_EXPERIMENT_TYPES", "single,comparison");
  Deno.env.set("CLOSED_LOOP_ENABLED", "true");
  try {
    const turn = await runSkillTurn({
      skill: hit.skill, match: hit.match, input,
      opts: { canDraft: true, enabledAgents: ["experiment-designer"] },
      ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
    });
    return { skill: hit.skill.id as string, outcome: turn.result.outcome, reply: turn.reply, calls: turn.result.calls, proposal: turn.result.proposal, tables };
  } finally {
    for (const k of ["AGENT_ENABLED_IDS", "AGENT_EXPERIMENT_TYPES", "CLOSED_LOOP_ENABLED"]) Deno.env.delete(k);
  }
}

Deno.test("S13: the stress test is read as a SIMULATED ranking, with everything it ran on", async () => {
  const r = await ask("rank suppliers by simulated impact", { stress: "current" });
  assertEquals([r.skill, r.outcome], ["stress", "answered"]);
  assertStringIncludes(r.reply, "By simulation, the most damaging supplier delay is **S1 (Acme)**: €412,000 average lost sales over 2–9 week delays");
  assertStringIncludes(r.reply, "S2 (Borealis) (€150,500)");
  // R-source: date, run, model, versions, replications, engine build
  assertStringIncludes(r.reply, 'stress test of 2026-11-04, run cccccccc, on Validated Model "VM-3 · Q4 baseline", policy version PV-6, data version v12, 30 replications, engine scsim-2.4.1+ab12cd34ef56');
  assert(!r.reply.includes("OUT OF DATE"));
  // the static top node (S2) is never presented as the simulated top
  assert(!/most damaging supplier delay is \*\*S2/.test(r.reply));
});

Deno.test("S13: a named duration and a named node read their own stored cell", async () => {
  const r = await ask("which supplier hurts most if it's delayed 4 weeks?", { stress: "current" });
  assertEquals(r.calls[0].args.duration_weeks, 4);
  assertStringIncludes(r.reply, "(€380,000 for a 4-week delay)");
  const mat = await ask("which material delay costs the most lost sales in the stress test?", { stress: "current" });
  assertStringIncludes(mat.reply, "most damaging material delay is **MAT-4 (Widget resin)**: €300,000");
});

Deno.test("S13: a battery the data has left behind says OUT OF DATE; no battery refuses and offers nothing simulated", async () => {
  const stale = await ask("what did the stress test show?", { stress: "stale" });
  assertEquals(stale.outcome, "answered_stale");
  assertStringIncludes(stale.reply, "OUT OF DATE: the project's data has changed since it ran");

  const none = await ask("what did the stress test show?", {});
  assertEquals(none.outcome, "no_battery");
  assertStringIncludes(none.reply, "I won't present the static network score as one");
  assertEquals(none.reply.match(/€/g), null);
});

Deno.test("S13: the chat never starts the battery — it names the Lab", async () => {
  const r = await ask("stress test all my suppliers", { stress: "current" });
  assertStringIncludes(r.reply, "I don't start the stress test from the chat");
  assertStringIncludes(r.reply, "stress card in the Simulation Lab");
  assertEquals(r.proposal ?? null, null);
  const st1 = await ask("run ST-1", {});
  assertEquals([st1.skill, st1.outcome], ["stress", "no_battery"]);
  assertStringIncludes(st1.reply, "I don't start the stress test from the chat");
});

Deno.test("N8: 'does it agree?' shows both rankings and the overlap — and computes no statistic", async () => {
  const r = await ask("does the stress test agree with the critical-node ranking?", { stress: "current" });
  assertEquals([r.skill, r.outcome], ["stress", "answered"]);
  assertStringIncludes(r.reply, "Not at the top: the stress test ranks S1 first and the critical-node analysis ranks S2 first");
  assertStringIncludes(r.reply, "3 appear in both");
  assertStringIncludes(r.reply, "I compute no correlation statistic");
  assertEquals(r.calls.map((c) => c.name), ["get_stress_results", "get_critical_nodes"]);
  assert(!/correlation of|ρ|rho|r\s*=\s*0/i.test(r.reply));
});

Deno.test("N8: 'my most critical supplier' is named from the analysis, then the what-if takes every §27 guardrail", async () => {
  const r = await ask("what if my most critical supplier is down for 4 weeks from week 22?", {});
  assertEquals([r.skill, r.outcome], ["criticalwhatif", "proposed"]);
  assertStringIncludes(r.reply, "S2 (Borealis) — 100.0% of demand at risk");
  assertStringIncludes(r.reply, "analysis of 2026-11-03");
  assertStringIncludes(r.reply, "static ranking");
  // the card is the what-if loop's own: it follows the Validated Model and disrupts S2
  const p = r.tables.proposals.at(-1)!;
  const payload = JSON.stringify(p);
  assertStringIncludes(payload, "S2");
  assert(/validated_model_id|model_validation_id/.test(payload), "the card follows the Validated Model");
  assertEquals(String(p.status), "proposed"); // a card awaiting approval
  assertEquals(r.tables.simulation_runs.length, 2, "nothing ran: only the fixture's two runs exist");
});

Deno.test("N8: several suppliers become several events; missing timing is ASKED as options; no analysis refuses", async () => {
  const two = await ask("what if my top 2 critical suppliers fail at week 22 for 4 weeks", {});
  assertEquals(two.outcome, "proposed");
  const payload = JSON.stringify(two.tables.proposals.at(-1));
  assert(payload.includes("S2") && payload.includes("S1"), "both suppliers are disrupted");

  const ask2 = await ask("simulate losing my most critical supplier", {});
  assertEquals(ask2.outcome, "needs_timing");
  assertStringIncludes(ask2.reply, '1. "what if S2 is down for 4 weeks from week 26?" (recommended');
  assertEquals(ask2.tables.proposals.length, 0);

  const none = await ask("simulate losing my most critical supplier", { analysed: false });
  assertEquals(none.outcome, "no_analysis");
  assertStringIncludes(none.reply, "I won't guess which one it is");
  assertEquals(none.tables.proposals.length, 0);
});

Deno.test("N8: with no Validated Model the bridge stops exactly as a plain what-if does", async () => {
  const r = await ask("what if my most critical supplier is down for 4 weeks from week 22?", {}, { noModel: true });
  assertEquals(r.outcome, "no_model");
  assertEquals(r.tables.proposals.length, 0);
  assertStringIncludes(r.reply, "no Validated Model");
});

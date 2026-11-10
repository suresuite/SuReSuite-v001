// Phase A, package A.2 (ai-agents.md §28): questions ABOUT the Validated
// Model, and the model/exploratory label in `setup` and `explain` (the §27.9
// gap). Deterministic tier: real handlers over the validated stub project.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import { runSkillTurn } from "../skills/runner.ts";
import { makeRequestBudget } from "../budgets.ts";
import { BASE_RUN, MODEL, validatedProject } from "./harness/model_fixture.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function ask(utterance: string, opts: { variant?: "no_model" | "drifted"; patch?: (t: Record<string, Row[]>) => void } = {}) {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  const tables = structuredClone(f.project_snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
  validatedProject(tables);
  if (opts.variant === "no_model") tables.model_validations = [];
  opts.patch?.(tables);
  const rpcs = makeAgentRpcs(tables, { graphHash: opts.variant === "drifted" ? "graph-hash-2" : "graph-hash-1" });
  rpcs.current_policy_hash = () => "ph-run";
  const ctx: ToolContext = {
    projectId: PROJECT, userId: USER,
    supabase: makeStubDb(tables, rpcs) as unknown as ToolContext["supabase"],
    draft: { userEmail: "a@example.com", threadId: null, modelCode: "gpt-5", providerCode: "openai", canProposals: true, utterance },
  };
  const input = { utterance, history: [] };
  const hit = matchSkill(input);
  assert(hit, `no skill claims "${utterance}"`);
  const turn = await runSkillTurn({
    skill: hit.skill, match: hit.match, input,
    opts: { canDraft: true, enabledAgents: ["experiment-designer"] },
    ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
  });
  return { skill: hit.skill.id as string, outcome: turn.result.outcome, reply: turn.reply, tables };
}

Deno.test("S9: a model in force is named with what it validated, its protocol and its baseline", async () => {
  const r = await ask("which validated model am I using?");
  assertEquals([r.skill, r.outcome], ["model", "in_force"]);
  assertStringIncludes(r.reply, "Q4 baseline");
  assertStringIncludes(r.reply, "**in force**");
  // the protocol is the model's own (model_fixture.ts), never a default
  assertStringIncludes(r.reply, "3 replications, 52-week horizon, warm-up to week 2, seed 42");
  assertStringIncludes(r.reply, `baseline run is ${BASE_RUN.slice(0, 8)}`);
  assertStringIncludes(r.reply, "validated policy version");
});

Deno.test("S9: 'is my model valid?' is never a bare yes — it says what was validated", async () => {
  const r = await ask("is my model valid?");
  assertEquals(r.outcome, "in_force");
  assert(!/^\s*yes\b/i.test(r.reply), "not a bare yes");
  assertStringIncludes(r.reply, "neither your policies nor the simulation's inputs have changed");
});

Deno.test("S9: a drifted project is STALE, says what moved, and puts numbered options — it does not choose", async () => {
  const r = await ask("why does my model say stale?", { variant: "drifted" });
  assertEquals([r.skill, r.outcome], ["model", "stale"]);
  assertStringIncludes(r.reply, "**stale**");
  assertStringIncludes(r.reply, "the simulation's inputs changed");
  assertStringIncludes(r.reply, "1. ");
  assertStringIncludes(r.reply, "re-validate");
  assertStringIncludes(r.reply, "as exploratory");
  assertStringIncludes(r.reply, "I'll ask which one you want each time");
  assert(!r.reply.includes("**in force**"));
});

Deno.test("S9: with no model the skill says so and offers validation — never a protocol", async () => {
  const r = await ask("is my model valid?", { variant: "no_model" });
  assertEquals(r.outcome, "no_model");
  assertStringIncludes(r.reply, "no Validated Model in force");
  assertStringIncludes(r.reply, "Run & Validate");
  assert(!/replications/.test(r.reply), "no protocol is invented");
});

Deno.test("S9: 'which runs followed the model' labels every run from its own record", async () => {
  const r = await ask("which runs followed the model and which were exploratory?", {
    patch: (t) => {
      t.simulation_runs.push({ ...structuredClone(t.simulation_runs[0]), id: "99999999-9999-4999-8999-9999999999ee", model_validation_id: null, created_at: 200 });
    },
  });
  assertEquals(r.outcome, "runs_labelled");
  assertStringIncludes(r.reply, "2 followed a Validated Model and 1 was exploratory");
});

Deno.test("§27.9 gap closed: setup and explain label the run they read", async () => {
  const setup = await ask("how many replications do I need?");
  assertEquals(setup.skill, "setup");
  assertStringIncludes(setup.reply, "follows Validated Model");

  const explain = await ask("why did fill rate drop in the last run?");
  assertEquals(explain.skill, "explain");
  assertStringIncludes(explain.reply, "follows Validated Model");

  const expl = await ask("why did fill rate drop in the last run?", {
    patch: (t) => { for (const r of t.simulation_runs) r.model_validation_id = null; },
  });
  assertStringIncludes(expl.reply, "exploratory — followed no Validated Model");
  assert(MODEL.length > 0);
});

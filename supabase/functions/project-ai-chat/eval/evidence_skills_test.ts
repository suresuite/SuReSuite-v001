// Phase A, package A.4 (ai-agents.md §28): "is the difference real?" (S8)
// and "is my run done?" (S12). Deterministic tier over the validated stub:
// the outage run (fill rate 0.86/0.87/0.88) and its baseline (0.96/0.97/0.98)
// share seed 42, three replications and the policy version.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import { runSkillTurn } from "../skills/runner.ts";
import { replicationsToResolve } from "../skills/evidence.ts";
import { makeRequestBudget } from "../budgets.ts";
import { BASE_RUN, OUTAGE_RUN, validatedProject } from "./harness/model_fixture.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function ask(utterance: string, patch?: (t: Record<string, Row[]>) => void) {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  const tables = structuredClone(f.project_snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
  validatedProject(tables);
  patch?.(tables);
  const rpcs = makeAgentRpcs(tables, { graphHash: "graph-hash-1" });
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
  return { skill: hit.skill.id as string, outcome: turn.result.outcome, reply: turn.reply, parts: turn.parts };
}

const setReps = (t: Record<string, Row[]>, run: string, values: number[]) => {
  t.run_replications = t.run_replications.filter((r) => String(r.run_id) !== run);
  values.forEach((v, i) => t.run_replications.push({ run_id: run, rep_index: i + 1, status: "done", kpis: { fill_rate: v } }));
};

Deno.test("S8: a paired interval that excludes 0 is called real, with the runs and the count", async () => {
  const r = await ask("is that difference significant?", (t) => setReps(t, OUTAGE_RUN, [0.85, 0.88, 0.87]));
  assertEquals([r.skill, r.outcome], ["significance", "resolved"]);
  assertStringIncludes(r.reply, "Yes, for fill_rate: -0.1033 ± 0.0287"); // diffs −0.11, −0.09, −0.11
  assertStringIncludes(r.reply, `run ${OUTAGE_RUN.slice(0, 8)} against run ${BASE_RUN.slice(0, 8)}`);
  assertStringIncludes(r.reply, "paired over 3 replications");
  assertStringIncludes(r.reply, "excludes 0");
  assertStringIncludes(r.reply, "follows Validated Model");
});

Deno.test("S8: an interval that includes 0 is NOT RESOLVED — never an improvement — with the replications it would take", async () => {
  const r = await ask("is 0.91 vs 0.93 a real improvement?", (t) => setReps(t, OUTAGE_RUN, [0.98, 0.95, 0.99]));
  assertEquals(r.outcome, "unresolved");
  assertStringIncludes(r.reply, "Not resolved, for fill_rate");
  assertStringIncludes(r.reply, "includes 0");
  assertStringIncludes(r.reply, "I won't call it an improvement or a loss");
  assertStringIncludes(r.reply, "more than 200 replications");
  assert(!/\bYes\b/.test(r.reply));
  assert(!/significant/i.test(r.reply));
});

Deno.test("S8: runs that are not like-for-like get a DESCRIPTIVE difference and the reason — never 'significant'", async () => {
  const r = await ask("are these two runs comparable?", (t) => {
    t.simulation_runs.find((x) => String(x.id) === OUTAGE_RUN)!.seed = 7;
  });
  assertEquals(r.outcome, "not_comparable");
  assertStringIncludes(r.reply, "not a like-for-like comparison (different seeds)");
  assertStringIncludes(r.reply, "DESCRIPTIVE only");
  assert(!/\b(significant|real at this)\b/i.test(r.reply));
});

Deno.test("S8: one run has no difference to test; its own interval is stated", async () => {
  const r = await ask("can I trust this run?", (t) => {
    t.simulation_runs = t.simulation_runs.filter((x) => String(x.id) === OUTAGE_RUN);
  });
  assertEquals(r.outcome, "single_run");
  assertStringIncludes(r.reply, "no difference to test");
  assertStringIncludes(r.reply, "3 replications");
});

Deno.test("S8: replicationsToResolve follows the interval's own arithmetic", () => {
  assertEquals(replicationsToResolve({ mean: 0.02, ci: 0.04, n: 10 }), 41); // half-width must halve ⇒ 4× the replications
  assertEquals(replicationsToResolve({ mean: 0, ci: 0.04, n: 10 }), null);
});

Deno.test("S12: nothing running is said plainly, with the latest finished run", async () => {
  const r = await ask("is my run done?");
  assertEquals([r.skill, r.outcome], ["status", "idle"]);
  assertStringIncludes(r.reply, "Nothing is queued or running");
  assertStringIncludes(r.reply, "latest finished run");
});

Deno.test("S12: a run queued 25 minutes is reported as NOT MOVING, by the one liveness rule", async () => {
  const r = await ask("why is my run stuck?", (t) => {
    t.simulation_runs.push({ id: "99999999-9999-4999-8999-9999999999aa", project_id: PROJECT, status: "queued", rep_count_done: 0, rep_count_target: 30, created_at: new Date(Date.now() - 25 * 60_000).toISOString() });
  });
  assertEquals(r.outcome, "stalled");
  assertStringIncludes(r.reply, "**1 is not moving**");
  assertStringIncludes(r.reply, "the simulation worker hasn't started this run");
  assertStringIncludes(r.reply, "I can't see why from here");
});

Deno.test("S12: a moving run shows its progress; no time estimate; no cancel from the chat", async () => {
  const running = (t: Record<string, Row[]>) => {
    t.simulation_runs.push({ id: "99999999-9999-4999-8999-9999999999bb", project_id: PROJECT, status: "running", rep_count_done: 12, rep_count_target: 30, created_at: new Date(Date.now() - 60_000).toISOString(), started_at: new Date(Date.now() - 30_000).toISOString() });
  };
  const dur = await ask("how long will the run take?", running);
  assertEquals(dur.outcome, "active");
  assertStringIncludes(dur.reply, "I can't give a time estimate");
  assertStringIncludes(JSON.stringify(dur.parts), "12/30");
  assert(!/\b\d+\s*(?:minutes?|hours?|seconds?)\s+(?:left|remaining|to\s+go)/i.test(dur.reply));

  const cancel = await ask("cancel that run", running);
  assertStringIncludes(cancel.reply, "I can't cancel a run from the chat");
  assertStringIncludes(cancel.reply, "run queue in the Simulation Lab");
});

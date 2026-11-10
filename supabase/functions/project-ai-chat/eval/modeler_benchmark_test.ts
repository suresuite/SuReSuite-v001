// WP M.0 — the modeler task benchmark (ai-agents.md §26.4), deterministic
// tier. 60 real modeler asks (the owner's own among them) in
// fixtures/modeler/modeler-tasks.jsonl, each labelled with the skill that
// must claim it (or null: it must FALL THROUGH to the router and the free
// loop) and, for most, the outcome the skill must reach on the stub project.
//
// Metric: TASK SUCCESS = right skill AND right outcome — not routing
// accuracy, not schema validity (§26.1 D7). The gate is 100% on this set:
// it is the regression floor every later change must hold. The owner decided
// evaluation is offline (§26.5 decision 1); what a live GPT-5 would add is
// the interpretation sentence, which ships only when verified.

import { assert, assertEquals } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import { runSkillTurn } from "../skills/runner.ts";
import { makeRequestBudget } from "../budgets.ts";
import { validatedProject } from "./harness/model_fixture.ts";
import { networkProject } from "./harness/network_fixture.ts";

interface Task {
  id: string;
  utterance: string;
  expect_skill: string | null;
  expect_outcome?: string;
  history?: Array<{ role: string; content: string }>;
  note?: string;
  /** §27: the project's state — default a validated project in force. */
  project?: "no_model" | "drifted" | "network" | "network_stale" | "network_none" | "network_firm";
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const tasks: Task[] = (await Deno.readTextFile(new URL("./fixtures/modeler/modeler-tasks.jsonl", import.meta.url)))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function stubProject(variant?: Task["project"]): Promise<{ ctx: ToolContext; tables: Record<string, Row[]> }> {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  const tables = structuredClone(f.project_snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
  validatedProject(tables); // §27: the benchmark project is a VALIDATED project
  if (variant === "no_model") tables.model_validations = [];
  tables.recovery_playbooks = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", project_id: PROJECT, is_system: false, name: "Expedite Shipments", config: { responses: ["expedite"], recovery_target_days: 10, cost_cap: 50000 } },
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02", project_id: PROJECT, is_system: false, name: "Activate Backup Supplier", config: { responses: ["backup_supplier"], recovery_target_days: 14, cost_cap: 20000 } },
  ];
  const rpcs = makeAgentRpcs(tables, { graphHash: variant === "drifted" ? "graph-hash-2" : "graph-hash-1" });
  rpcs.current_policy_hash = () => "ph-run";
  // §28: the network-heavy project — analysed and current, analysed and stale,
  // never analysed, or with a deep-tier firm network as well.
  if (variant?.startsWith("network")) {
    networkProject(tables, rpcs, { analysed: variant !== "network_none", stale: variant === "network_stale", firm: variant === "network_firm" });
  }
  const db = makeStubDb(tables, rpcs);
  return {
    tables,
    ctx: {
      projectId: PROJECT,
      userId: USER,
      supabase: db as unknown as ToolContext["supabase"],
      draft: { userEmail: "a@example.com", threadId: null, modelCode: "gpt-5", providerCode: "openai", canProposals: true, utterance: "" },
    },
  };
}

Deno.test("M.0 benchmark: modeler and analyst tasks — right skill AND right outcome (gate: 100%)", async () => {
  assert(tasks.length >= 148, `the benchmark holds ${tasks.length} tasks; §28 A.3 brought it to 148`);
  for (const k of ["AGENT_ENABLED_IDS", "AGENT_EXPERIMENT_TYPES", "CLOSED_LOOP_ENABLED"]) Deno.env.delete(k);
  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.set("AGENT_EXPERIMENT_TYPES", "single,comparison");
  Deno.env.set("CLOSED_LOOP_ENABLED", "true");
  const misses: string[] = [];
  const bySkill = new Map<string, { n: number; ok: number }>();
  try {
    for (const t of tasks) {
      const input = { utterance: t.utterance, history: t.history ?? [] };
      const hit = matchSkill(input);
      const got = hit?.skill.id ?? null;
      let ok = got === t.expect_skill;
      let outcome = "-";
      if (ok && hit && t.expect_outcome) {
        const { ctx } = await stubProject(t.project);
        ctx.draft!.utterance = t.utterance;
        const turn = await runSkillTurn({
          skill: hit.skill, match: hit.match, input,
          opts: { canDraft: true, enabledAgents: ["experiment-designer", "data-steward", "vv-analyst"] },
          ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
        });
        outcome = turn.result.outcome;
        ok = outcome === t.expect_outcome;
      }
      const key = t.expect_skill ?? "(fall-through)";
      const agg = bySkill.get(key) ?? { n: 0, ok: 0 };
      agg.n++;
      if (ok) agg.ok++;
      bySkill.set(key, agg);
      if (!ok) misses.push(`${t.id} "${t.utterance}": want ${t.expect_skill}/${t.expect_outcome ?? "-"}, got ${got}/${outcome}`);
    }
  } finally {
    for (const k of ["AGENT_ENABLED_IDS", "AGENT_EXPERIMENT_TYPES", "CLOSED_LOOP_ENABLED"]) Deno.env.delete(k);
  }
  const total = [...bySkill.values()].reduce((a, b) => ({ n: a.n + b.n, ok: a.ok + b.ok }), { n: 0, ok: 0 });
  console.log(`\nM.0 task success ${total.ok}/${total.n}\n` +
    [...bySkill.entries()].map(([k, v]) => `  ${k.padEnd(16)} ${v.ok}/${v.n}`).join("\n"));
  assertEquals(misses, [], `task misses:\n${misses.join("\n")}`);
});

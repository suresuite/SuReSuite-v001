// Phase M modeler skills (ai-agents.md §26) — deterministic tier.
//
// Every skill runs on the REAL handlers over the stub DB (the cl-01 project:
// supplier S1 "Acme", the scenario "6-week outage of S1" = S1 outage from day
// 28 for 42 days, with a done run whose fill_rate is 0.87 and three
// replications 0.86/0.87/0.88). No LLM, no network.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts"; // registers the handlers, as index.ts does
import { matchSkill, SKILLS, type SkillId } from "../skills/index.ts";
import { runSkillTurn, parseSkillNote, skillNote } from "../skills/runner.ts";
import { ciHalfWidth95, mean, pairedDelta, std, tCritical95 } from "../skills/common.ts";
import * as browserStats from "../../../../src/lib/sim/stats.ts";
import { makeRequestBudget } from "../budgets.ts";
import { applyExperimentSpec } from "../../agent-apply/experimentSpecApply.ts";
import { validateArms } from "../experimentTools.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const RUN = "99999999-9999-4999-8999-999999999901";
const SCEN = "55555555-5555-4555-8555-555555555502";
const VER = "44444444-4444-4444-8444-444444444401";
const PB_EXP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const PB_BAK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";

async function cl01(): Promise<Record<string, Row[]>> {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  return f.project_snapshot;
}

const PLAYBOOKS: Row[] = [
  { id: PB_EXP, project_id: PROJECT, is_system: false, name: "Expedite Shipments", config: { responses: ["expedite"], recovery_target_days: 10, cost_cap: 50000 } },
  { id: PB_BAK, project_id: PROJECT, is_system: false, name: "Activate Backup Supplier", config: { responses: ["backup_supplier"], recovery_target_days: 14, cost_cap: 20000 } },
  { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", project_id: null, is_system: true, name: "Baseline (no recovery)", config: {} },
];

async function harness(opts?: { patch?: (t: Record<string, Row[]>) => void; utterance?: string; graphHash?: string }) {
  const tables = structuredClone(await cl01()) as Record<string, Row[]>;
  tables.proposals ??= [];
  tables.recovery_playbooks = structuredClone(PLAYBOOKS);
  tables.chat_plans ??= [];
  opts?.patch?.(tables);
  const rpcs = makeAgentRpcs(tables, { graphHash: opts?.graphHash ?? "graph-hash-1" });
  rpcs.current_policy_hash = () => "ph-run";
  const db = makeStubDb(tables, rpcs);
  const ctx: ToolContext = {
    projectId: PROJECT,
    userId: USER,
    supabase: db as unknown as ToolContext["supabase"],
    draft: {
      userEmail: "a@example.com",
      threadId: THREAD,
      modelCode: "gpt-5",
      providerCode: "openai",
      canProposals: true,
      utterance: opts?.utterance ?? "",
      agentId: "experiment-designer",
    },
  };
  return { ctx, tables, db };
}

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  return fn().finally(() => {
    for (const k of Object.keys(env)) Deno.env.delete(k);
  });
}
const DESIGNER = { AGENT_ENABLED_IDS: "experiment-designer", AGENT_EXPERIMENT_TYPES: "single,comparison", CLOSED_LOOP_ENABLED: "true" };

async function run(skillUtterance: string, h: Awaited<ReturnType<typeof harness>>, history: Array<{ role: string; content: string }> = [], canDraft = true) {
  const input = { utterance: skillUtterance, history };
  const hit = matchSkill(input);
  assert(hit, `no skill claimed: ${skillUtterance}`);
  h.ctx.draft!.utterance = skillUtterance;
  const turn = await runSkillTurn({
    skill: hit!.skill, match: hit!.match, input,
    opts: { canDraft, draftBlockedReason: canDraft ? undefined : "this thread is in Ask mode", enabledAgents: ["experiment-designer", "data-steward", "vv-analyst"] },
    ctx: h.ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
  });
  return { skill: hit!.skill.id, turn };
}

/** Seed a finished arm: a scenario with the given recovery overrides and a
 * done run whose per-replication fill rates are given (CRN reps 1..n). */
function seedArm(t: Record<string, Row[]>, id: string, overrides: Record<string, unknown>, fills: number[]) {
  const sid = `55555555-5555-4555-8555-5555555555${id}`;
  const rid = `99999999-9999-4999-8999-9999999999${id}`;
  t.scenarios.push({ ...structuredClone(t.scenarios[0]), id: sid, name: `arm ${id}`, recovery_overrides: overrides, created_at: 21 });
  t.simulation_runs.push({
    ...structuredClone(t.simulation_runs[0]), id: rid, scenario_id: sid, scenario_hash: `scen-${sid}`,
    rep_count_done: fills.length, rep_count_target: fills.length,
    aggregate_kpis: { fill_rate: mean(fills) }, created_at: 101,
  });
  fills.forEach((f, i) => t.run_replications.push({ run_id: rid, rep_index: i + 1, status: "done", kpis: { fill_rate: f } }));
}

// ── shared statistics are the browser's, value for value ──────────────────

Deno.test("stats mirror: common.ts equals src/lib/sim/stats.ts", () => {
  const xs = [0.86, 0.87, 0.88, 0.9, 0.81];
  assertEquals(mean(xs), browserStats.mean(xs));
  assertEquals(std(xs), browserStats.std(xs));
  assertEquals(ciHalfWidth95(xs), browserStats.ciHalfWidth95(xs));
  for (const df of [1, 4, 29, 30, 31, 100]) assertEquals(tCritical95(df), browserStats.tCritical95(df));
  const d = pairedDelta(new Map([[1, 0.9], [2, 0.92], [3, 0.91]]), new Map([[1, 0.86], [2, 0.87], [3, 0.88]]));
  assert(d && Math.abs(d.mean - 0.04) < 1e-12 && d.n === 3);
});

// ── recognizers: precedence and conservatism ───────────────────────────────

Deno.test("recognizers: each ask goes to the skill that owns it; ordinary questions fall through", () => {
  const cases: Array<[string, SkillId | null]> = [
    ["what can you do?", "capabilities"],
    ["what if disruption with S001 at week 22 and duration of 4 weeks", "whatif"],
    ["how do I mitigate an S001 outage in weeks 22-25?", "mitigation"],
    ["which playbook is best for that outage?", "mitigation"],
    ["how sensitive is fill rate to how long the S001 outage lasts?", "sensitivity"],
    ["why did fill rate drop at week 24?", "explain"],
    ["can I run my model?", "readiness"],
    ["what data is missing?", "readiness"],
    ["how many replications do I need?", "setup"],
    ["what did the last run show?", "results"],
    ["compare runs 3166d661 and f09136d8", "results"],
    ["what is TTR?", "howto"],
    ["who are our suppliers?", null],
    ["what is the lead time of M001?", null],
    ["hi", null],
  ];
  for (const [q, want] of cases) assertEquals(matchSkill({ utterance: q, history: [] })?.skill.id ?? null, want, q);
});

Deno.test("MODELER_SKILLS: off disables every skill; a list keeps only those", () =>
  withEnv({ MODELER_SKILLS: "off" }, () => {
    assertEquals(matchSkill({ utterance: "what can you do?", history: [] }), null);
    return Promise.resolve();
  }).then(() =>
    withEnv({ MODELER_SKILLS: "readiness" }, () => {
      assertEquals(matchSkill({ utterance: "what can you do?", history: [] }), null);
      assertEquals(matchSkill({ utterance: "can I run my model?", history: [] })?.skill.id, "readiness");
      return Promise.resolve();
    })
  ));

// ── M2 mitigation ───────────────────────────────────────────────────────────

Deno.test("M2: a miss files ONE comparison card — No recovery + each playbook, 5 reps, same disruption; the plan binds it (M.3)", () =>
  withEnv({ ...DESIGNER, CHAT_STORE_ENABLED: "true", PLAN_TOOL_ENABLED: "true" }, async () => {
    const h = await harness();
    const { skill, turn } = await run("how do I mitigate an S1 outage in weeks 22-25?", h);
    assertEquals(skill, "mitigation");
    assertEquals(turn.result.outcome, "proposed");
    assertEquals(h.tables.proposals.length, 1);
    const p = h.tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(p.experiment_type, "comparison");
    const arms = p.arms as Array<Record<string, unknown>>;
    assertEquals(arms.map((a) => a.label), ["No recovery", "Expedite Shipments", "Activate Backup Supplier"]);
    assertEquals(p.replications, 5, "owner decision 38(ad)");
    for (const a of arms) assertEquals((a.disruption_schedule as Array<Record<string, unknown>>)[0].start_day, 154);
    assertEquals(arms[1].recovery_overrides, PLAYBOOKS[0].config);
    assertEquals(h.tables.simulation_runs.length, 1, "nothing runs before approval");
    // M.3: the plan waits on the card and remembers which skill answers it.
    const plan = h.tables.chat_plans[0] as Record<string, unknown>;
    assert(plan, "a plan was filed");
    const steps = plan.steps as Array<Record<string, unknown>>;
    assertEquals(steps.map((s) => s.status), ["done", "awaiting_approval", "pending"]);
    assertEquals(parseSkillNote(String(steps[2].note))?.skillId, "mitigation");
    assert(turn.parts.some((x) => x.kind === "plan") && turn.parts.some((x) => x.kind === "proposal"));
  }));

Deno.test("M2: the subject comes from the conversation — \"how do I mitigate it?\" after a what-if", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness();
    const history = [{ role: "user", content: "what if disruption with S1 at week 22 and duration of 4 weeks" }, { role: "assistant", content: "…" }];
    const { skill, turn } = await run("What about propose an approach to mitigate the impact?", h, history);
    assertEquals(skill, "mitigation");
    assertEquals(turn.result.outcome, "proposed");
    const arms = (h.tables.proposals[0].payload as Record<string, unknown>).arms as Array<Record<string, unknown>>;
    assertEquals((arms[0].disruption_schedule as Array<Record<string, unknown>>)[0].target, "supplier:S1");
  }));

Deno.test("M2: every arm finished ⇒ ranked by PAIRED deltas; the cheapest arm that measurably helps is recommended; no card", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness({
      patch: (t) => {
        t.scenarios[0].recovery_overrides = {}; // the existing outage scenario IS the No-recovery arm
        t.simulation_runs[0].rep_count_done = 3;
        seedArm(t, "11", PLAYBOOKS[0].config as Record<string, unknown>, [0.95, 0.96, 0.97]); // expedite: +0.09
        seedArm(t, "12", PLAYBOOKS[1].config as Record<string, unknown>, [0.90, 0.91, 0.92]); // backup: +0.04, cheaper
      },
    });
    const { turn } = await run("how do I mitigate an S1 outage at week 4 for 6 weeks with 3 replications", h);
    assertEquals(turn.result.outcome, "answered", turn.reply);
    assertEquals(h.tables.proposals.length, 0, "a finished study files nothing");
    assertStringIncludes(turn.reply, "**Activate Backup Supplier**", "both help; the cheaper stated cost wins");
    assertStringIncludes(turn.reply, "+0.04");
    const table = turn.parts.find((x) => x.kind === "table")!.data as { columns: string[]; rows: unknown[][] };
    assertEquals(table.rows.map((r) => r[0]), ["No recovery", "Expedite Shipments", "Activate Backup Supplier"]);
    assertEquals(table.rows[0][2], "reference");
  }));

Deno.test("M2: comparison not enabled ⇒ the Lab design-of-experiments instructions, no card", () =>
  withEnv({ ...DESIGNER, AGENT_EXPERIMENT_TYPES: "single" }, async () => {
    const h = await harness();
    const { turn } = await run("how do I mitigate an S1 outage in weeks 22-25?", h);
    assertEquals(turn.result.outcome, "not_proposed");
    assertStringIncludes(turn.reply, "Recovery playbook");
    assertEquals(h.tables.proposals.length, 0);
  }));

Deno.test("M2: no disruption anywhere in the conversation ⇒ it asks which", async () => {
  const h = await harness();
  const { turn } = await run("how do I mitigate the impact?", h);
  assertEquals(turn.result.outcome, "needs_disruption");
});

// ── M.2 the comparison type: draft gates + apply ───────────────────────────

Deno.test("M.2 arms validation: 2-6 arms, labelled, unique, known fields only", () => {
  assert(!validateArms([{ label: "a" }]).ok, "one arm is not a comparison");
  assert(!validateArms(Array.from({ length: 7 }, (_, i) => ({ label: `a${i}` }))).ok, "seven is over the cap");
  assert(!validateArms([{ label: "a" }, { label: "A" }]).ok, "labels are unique");
  assert(!validateArms([{ label: "a" }, { label: "b", seed: 3 }]).ok, "no unknown fields");
  assert(validateArms([{ label: "a" }, { label: "b", recovery_overrides: { x: 1 } }]).ok);
});

Deno.test("M.2 apply: ONE approval dispatches one run per arm through the single-run path, on one seed", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness();
    await run("how do I mitigate an S1 outage in weeks 22-25?", h);
    const proposal = h.tables.proposals[0];
    const before = h.tables.simulation_runs.length;
    const applied = await applyExperimentSpec(h.db, { upstash: () => Promise.resolve("ok") }, {
      projectId: PROJECT,
      payload: proposal.payload as Record<string, unknown>,
      grounding: proposal.grounding as Record<string, unknown>,
      userId: USER,
    });
    assertEquals(applied.experiment_type, "comparison");
    assertEquals(applied.arms!.length, 3);
    assertEquals(h.tables.simulation_runs.length - before, 3, "three arms, three runs");
    assertEquals(applied.run_id, applied.arms![2].run_id, "the plan binds the LAST arm's run");
    const armScenarios = h.tables.scenarios.filter((s) => String(s.name).startsWith("Mitigation:"));
    assertEquals(armScenarios.length, 3);
    assertEquals(new Set(armScenarios.map((s) => s.seed)).size, 1, "every arm on the same seed (CRN)");
    assertEquals(armScenarios.find((s) => String(s.name).endsWith("Expedite Shipments"))!.recovery_playbook_id, PB_EXP);
    // 38(ag): `created_by` references auth.users; the approving account is an
    // approved_users id, so an agent dispatch must leave it NULL (production
    // failed every agent run with simulation_runs_created_by_fkey).
    const newRuns = h.tables.simulation_runs.slice(before);
    for (const r of newRuns) assertEquals(r.created_by ?? null, null, "agent runs never write an app id into created_by");
  }));

// ── M5 sensitivity ─────────────────────────────────────────────────────────

Deno.test("M5: a duration sweep at the levels the user listed — not the base disruption's week number", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness();
    const { skill, turn } = await run("how sensitive is fill rate to the duration of an S1 outage at week 22 — try 2, 4 and 8 weeks", h);
    assertEquals(skill, "sensitivity");
    assertEquals(turn.result.outcome, "proposed", turn.reply);
    const arms = (h.tables.proposals[0].payload as Record<string, unknown>).arms as Array<Record<string, unknown>>;
    assertEquals(arms.map((a) => a.label), ["2 wk", "4 wk", "8 wk"]);
    assertEquals(arms.map((a) => (a.disruption_schedule as Array<Record<string, unknown>>)[0].duration_days), [14, 28, 56]);
  }));

Deno.test("M5: a DATA factor is refused with the reason, never swept as something else", async () => {
  const h = await harness();
  const { turn } = await run("how sensitive is fill rate to S1's lead time?", h);
  assertEquals(turn.result.outcome, "unsupported_factor");
  assertStringIncludes(turn.reply, "M.2b");
});

// ── M3 results ─────────────────────────────────────────────────────────────

Deno.test("M3: the last run is briefed from its persisted KPIs", async () => {
  const h = await harness();
  const { turn } = await run("what did the last run show?", h);
  assertEquals(turn.result.outcome, "brief");
  assertStringIncludes(turn.reply, "0.87");
  assertStringIncludes(turn.reply, "6-week outage of S1");
});

Deno.test("M3: two runs on one seed and rep count compare PAIRED; otherwise DESCRIPTIVE with the reason", async () => {
  const h = await harness({ patch: (t) => seedArm(t, "21", {}, [0.9, 0.91, 0.92]) });
  h.tables.simulation_runs[0].rep_count_done = 3;
  for (const r of h.tables.simulation_runs) r.seed = 42;
  const q = `compare runs ${RUN} and 99999999-9999-4999-8999-999999999921`;
  const paired = await run(q, h);
  assertEquals(paired.turn.result.outcome, "compared_paired", paired.turn.reply);
  h.tables.simulation_runs[1].seed = 7;
  const desc = await run(q, h);
  assertEquals(desc.turn.result.outcome, "compared_descriptive");
  assertStringIncludes(desc.turn.reply, "different seeds");
});

// ── M4 readiness + M.5 next step ───────────────────────────────────────────

Deno.test("M4: the pre-run check's verdict, the badge, and how to fix each finding", async () => {
  const h = await harness({ patch: (t) => { delete t.products[0].demand_cv; } });
  const { turn } = await run("can I run my model?", h);
  assert(["ready", "warnings", "blocked"].includes(turn.result.outcome));
  assert(/policy version "baseline"/.test(turn.reply), turn.reply);
  const table = turn.parts.find((x) => x.kind === "table");
  if (table) {
    const rows = (table.data as { rows: unknown[][] }).rows;
    const cv = rows.find((r) => String(r[1]).startsWith("products."));
    if (cv) assertStringIncludes(String(cv[3]), "Data Steward", "an item-master gap names its fixer");
  }
});

Deno.test("M4: no saved policy version ⇒ the honest dependency answer", async () => {
  const h = await harness({ patch: (t) => (t.policy_versions = []) });
  const { turn } = await run("am I ready to run? can I run it?", h);
  assertEquals(turn.result.outcome, "no_policy_version");
});

// ── M6 setup · M8 explain · M7 how-to · M.6 capabilities ───────────────────

Deno.test("M6: setup advice is read from the latest run's own statistics", async () => {
  const h = await harness();
  const { turn } = await run("how many replications do I need?", h);
  assertEquals(turn.result.outcome, "advised");
  assertStringIncludes(turn.reply, "Replications:");
  assertStringIncludes(turn.reply, "with ");
});

Deno.test("M8: a week inside the disruption is placed on the run's own timeline, labelled not causal", async () => {
  const h = await harness({
    patch: (t) => {
      t.simulation_runs[0].disruption_schedule = [{ target: "S1", start_day: 28, duration_days: 42, magnitude_pct: 100 }];
    },
  });
  const { turn } = await run("why did fill rate drop at week 6?", h);
  assertEquals(turn.result.outcome, "placed");
  assertStringIncludes(turn.reply, "inside the disruption");
  assertStringIncludes(turn.reply, "decision traces");
});

Deno.test("M7: a how-to answer cites the platform's own pages", async () => {
  const h = await harness();
  const { turn } = await run("what is TTR?", h);
  assertEquals(turn.result.outcome, "cited");
  assertStringIncludes(turn.reply, "[1]");
});

Deno.test("M.6: \"what can you do?\" lists every enabled skill, and says what it cannot do", async () => {
  const h = await harness();
  const { turn } = await run("what can you do?", h);
  for (const s of SKILLS.filter((x) => x.id !== "capabilities")) assertStringIncludes(turn.reply, s.example.split("  ·  ")[0]);
  assertStringIncludes(turn.reply, "don't predict results");
});

Deno.test("M.3 note round-trip: skill id + question fit the 200-char note", () => {
  const long = "how do I mitigate ".repeat(30);
  const n = skillNote("mitigation", long);
  assert(n.length <= 200);
  assertEquals(parseSkillNote(n)?.skillId, "mitigation");
});

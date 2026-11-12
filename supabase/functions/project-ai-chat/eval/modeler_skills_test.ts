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
import { closeSkillPlan, parseSkillNote, resumeInput, runSkillTurn, skillNote, waitSkillPlanOn } from "../skills/runner.ts";
import { mitigationSkill } from "../skills/mitigation.ts";
import { runResumePreStep } from "../planTools.ts";
import { ciHalfWidth95, mean, pairedDelta, std, tCritical95 } from "../skills/common.ts";
import * as browserStats from "../../../../src/lib/sim/stats.ts";
import { makeRequestBudget } from "../budgets.ts";
import { applyExperimentSpec } from "../../agent-apply/experimentSpecApply.ts";
import { validateArms } from "../experimentTools.ts";
import { BASE_RUN, MODEL, validatedProject } from "./harness/model_fixture.ts";

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
  validatedProject(tables); // §27: the stub is a VALIDATED project
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

Deno.test("M2: a miss files ONE comparison card — No recovery + each playbook, the protocol's reps, every arm follows the model; the plan binds it (M.3)", () =>
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
    assertEquals(p.replications, 3, "§27: the model's protocol count");
    assertEquals(p.validated_model_id, MODEL, "every arm follows the Validated Model");
    assertEquals(p.deviations, []);
    for (const a of arms) assertEquals((a.disruption_schedule as Array<Record<string, unknown>>)[0].start_day, 154);
    assertEquals(arms[1].recovery_overrides, PLAYBOOKS[0].config);
    assertEquals(h.tables.simulation_runs.length, 2, "nothing runs before approval (the two fixture runs only)");
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
  h.tables.simulation_runs.find((r) => String(r.id).endsWith("21"))!.seed = 7;
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
  // With a long subject both still fit, the subject first, the question's
  // recognizable start kept.
  const m = skillNote("mitigation", long, "what if supplier S1 is down at week 22 for 4 weeks ".repeat(5));
  assert(m.length <= 200, String(m.length));
  const r = parseSkillNote(m)!;
  assert(r.utterance.startsWith("how do I mitigate"), r.utterance);
  assert(r.subject!.startsWith("what if supplier S1"), String(r.subject));
});

Deno.test("38(ak) a follow-up study resumes with its subject: the plan note keeps the earlier what-if, and arms still running WAIT rather than fail", () =>
  withEnv({ ...DESIGNER, CHAT_STORE_ENABLED: "true", PLAN_TOOL_ENABLED: "true" }, async () => {
    const h = await harness();
    // Production 2026-11-10: the question named no disruption — its subject
    // was the what-if two messages earlier.
    const whatIf = "what if disruption with S1 at week 22 and duration of 4 weeks";
    const ask = "how could i mitigate the impact of the disruption?";
    const { turn } = await run(ask, h, [{ role: "user", content: whatIf }, { role: "assistant", content: "…" }]);
    assertEquals(turn.result.outcome, "proposed", turn.reply);
    const plan = h.tables.chat_plans[0] as Record<string, unknown>;
    const note = String((plan.steps as Array<Record<string, unknown>>)[2].note);
    assert(note.length <= 200, note);
    const ref = parseSkillNote(note)!;
    assertEquals([ref.skillId, ref.utterance, ref.subject], ["mitigation", ask, whatIf]);

    // The card is approved: every arm is dispatched and still running.
    const proposal = h.tables.proposals[0];
    const before = new Set(h.tables.simulation_runs.map((r) => String(r.id)));
    const applied = await applyExperimentSpec(h.db, { upstash: () => Promise.resolve("ok") }, {
      projectId: PROJECT, payload: proposal.payload as Record<string, unknown>,
      grounding: proposal.grounding as Record<string, unknown>, userId: USER,
    });
    proposal.status = "applied";
    proposal.applied_result = { run_id: applied.run_id };
    // The arm the plan binds (the last) finished first; the others still run.
    for (const r of h.tables.simulation_runs.filter((x) => !before.has(String(x.id)))) {
      Object.assign(r, String(r.id) === applied.run_id
        ? { status: "done", rep_count_done: 3, rep_count_target: 3 }
        : { status: "running", rep_count_done: 1, rep_count_target: 3 });
    }
    const outcome = await runResumePreStep(h.db, { planId: String(plan.id), userId: USER });
    assertEquals(outcome.kind, "run_done", JSON.stringify(outcome));
    if (outcome.kind !== "run_done") return;
    // The resume has NO conversation — only what the plan stored.
    const input = resumeInput(ref);
    const match = mitigationSkill.recognize(input);
    assert((match as { subject: unknown }).subject, "the subject is recovered from the note, not asked for again");
    const resumed = await runSkillTurn({
      skill: mitigationSkill, match, input,
      opts: { canDraft: false, enabledAgents: ["experiment-designer"] },
      ctx: h.ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT, resuming: true,
    });
    assert(!resumed.reply.includes("Which disruption"), resumed.reply);
    assertEquals(resumed.result.outcome, "in_progress", resumed.reply);
    const pending = resumed.result.pendingRunIds ?? [];
    assert(pending.length > 0, "the unfinished arms are named");

    // The plan waits on an unfinished arm; the answer is NOT failed.
    assert(!pending.includes(String(applied.run_id)), "a finished arm is not waited on");
    const part = await waitSkillPlanOn(h.ctx, outcome.plan as unknown as { id: string; steps: Array<Record<string, unknown>> }, outcome.stepId, pending[0]);
    const steps = (part!.data as { steps: Array<{ id: string; status: string; ref?: { run_id?: string } }> }).steps;
    assertEquals(steps.map((st) => `${st.id}:${st.status}`), ["check:done", "run:awaiting_run", "answer:pending"]);
    assertEquals(steps[1].ref?.run_id, pending[0]);

    // A note with no subject still parses (plans filed before 38(ak)).
    assertEquals(parseSkillNote("skill:mitigation|how do I mitigate it?")?.subject, null);
    assertEquals(resumeInput({ utterance: "q", subject: null }).history, []);
  }));

Deno.test("38(ah) Retry rebind: a failed first apply, then a successful Retry ⇒ the resume APPENDS a step on the new run and the skill closes the plan", () =>
  withEnv({ ...DESIGNER, CHAT_STORE_ENABLED: "true", PLAN_TOOL_ENABLED: "true" }, async () => {
    const h = await harness();
    const { turn } = await run("what if disruption with S1 at week 22 and duration of 4 weeks", h);
    assertEquals(turn.result.outcome, "proposed");
    const plan = h.tables.chat_plans[0] as Record<string, unknown>;
    const proposalId = turn.result.proposal!.proposal_id;

    // 1st apply fails (the production created_by FK): the client fails the step.
    const { error } = await h.db.rpc("advance_chat_plan_step", {
      p_plan_id: plan.id, p_step_id: "run", p_status: "failed", p_user_id: USER,
      p_note: "run not created: simulation_runs_created_by_fkey",
    });
    assert(!error, error?.message);

    // Retry succeeds: the card is applied with a run, which has finished.
    const RETRY_RUN = "99999999-9999-4999-8999-999999999977";
    h.tables.simulation_runs.push({ ...structuredClone(h.tables.simulation_runs[0]), id: RETRY_RUN, status: "done", rep_count_done: 5, rep_count_target: 5 });
    const card = h.tables.proposals.find((p) => String(p.id) === proposalId)!;
    card.status = "applied";
    card.applied_result = { run_id: RETRY_RUN };

    // The client posts the resume; the server rebinds by APPENDING a step.
    const outcome = await runResumePreStep(h.db, { planId: String(plan.id), userId: USER });
    assertEquals(outcome.kind, "run_done", JSON.stringify(outcome));
    if (outcome.kind !== "run_done") return;
    assertEquals(outcome.stepId, "run-retry");
    assertEquals(outcome.runId, RETRY_RUN);
    const ids = outcome.plan.steps.map((st) => `${st.id}:${st.status}`);
    assertEquals(ids, ["check:done", "run:failed", "run-retry:active", "answer:pending"], "the failed step is never reopened");

    // The skill resume closes the step that actually waited.
    const part = await closeSkillPlan(h.ctx, outcome.plan as unknown as { id: string; steps: Array<Record<string, unknown>> }, true, outcome.stepId);
    const closed = (part!.data as { steps: Array<{ id: string; status: string }> }).steps.map((st) => `${st.id}:${st.status}`);
    assertEquals(closed, ["check:done", "run:failed", "run-retry:done", "answer:done"]);

    // A second resume does not append another step for the same run.
    const again = await runResumePreStep(h.db, { planId: String(plan.id), userId: USER });
    assert(!(again.plan?.steps ?? []).some((st) => st.id === "run-retry2"), "one rebind per run");
  }));

Deno.test("38(ai) a plan waiting on a run the worker never started says so — not \"nothing is hung\"", () =>
  withEnv({ ...DESIGNER, CHAT_STORE_ENABLED: "true", PLAN_TOOL_ENABLED: "true" }, async () => {
    const h = await harness();
    const { turn } = await run("what if disruption with S1 at week 22 and duration of 4 weeks", h);
    const plan = h.tables.chat_plans[0] as Record<string, unknown>;
    const QUEUED = "99999999-9999-4999-8999-999999999966";
    h.tables.simulation_runs.push({
      ...structuredClone(h.tables.simulation_runs[0]), id: QUEUED, status: "queued", rep_count_done: 0, rep_count_target: 5,
      created_at: new Date(Date.now() - 25 * 60_000).toISOString(), started_at: null,
    });
    const card = h.tables.proposals.find((p) => String(p.id) === turn.result.proposal!.proposal_id)!;
    card.status = "applied";
    card.applied_result = { run_id: QUEUED };
    const out = await runResumePreStep(h.db, { planId: String(plan.id), userId: USER });
    assertEquals(out.kind, "progress");
    if (out.kind !== "progress") return;
    assertStringIncludes(out.reply, "queued for 25 minutes");
    assertStringIncludes(out.reply, "hasn't started it");
    assert(!out.reply.includes("nothing is hung"), out.reply);
  }));

// ── Phase V (ai-agents.md §27): apply + follow-up choices ───────────────────

Deno.test("V.3 apply: an approved model-following card creates the scenario FROM THE MODEL and dispatches a model run", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness();
    const { turn } = await run("what if disruption with S1 at week 22 and duration of 4 weeks", h);
    assertEquals(turn.result.outcome, "proposed", turn.reply);
    const proposal = h.tables.proposals[0];
    const before = h.tables.simulation_runs.length;
    const applied = await applyExperimentSpec(h.db, { upstash: () => Promise.resolve("ok") }, {
      projectId: PROJECT,
      payload: proposal.payload as Record<string, unknown>,
      grounding: proposal.grounding as Record<string, unknown>,
      userId: USER,
    });
    assertEquals(h.tables.simulation_runs.length - before, 1);
    const sc = h.tables.scenarios.find((x) => String(x.id) === applied.scenario_id)!;
    // The model's world and protocol — not the Lab's generic defaults.
    assertEquals([sc.horizon_days, sc.seed, sc.crn, sc.warmup_mode, sc.warmup_days, sc.replications], [364, 42, true, "manual", 14, 3]);
    assertEquals(sc.inherited_validation_id, MODEL, "a faithful scenario inherits the model");
    const runRow = h.tables.simulation_runs.find((r) => String(r.id) === applied.run_id)!;
    assertEquals(runRow.model_validation_id, MODEL, "the run FOLLOWS the Validated Model");
    assertEquals(runRow.policy_version_id, VER);
    assertEquals(runRow.created_by ?? null, null);
  }));

Deno.test("V.3 apply: a model revoked while the card waited ⇒ the apply refuses and says to ask again", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness();
    await run("what if disruption with S1 at week 22 and duration of 4 weeks", h);
    h.tables.model_validations[0].status = "revoked";
    let msg = "";
    try {
      await applyExperimentSpec(h.db, { upstash: () => Promise.resolve("ok") }, {
        projectId: PROJECT,
        payload: h.tables.proposals[0].payload as Record<string, unknown>,
        grounding: h.tables.proposals[0].grounding as Record<string, unknown>,
        userId: USER,
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assertStringIncludes(msg, "revoked");
  }));

Deno.test("V follow-up: \"run as exploratory\" answers the question the assistant asked about the EARLIER what-if", () =>
  withEnv(DESIGNER, async () => {
    const q = "what if disruption with S1 at week 22 and duration of 4 weeks";
    const h = await harness({ graphHash: "graph-hash-2" }); // the project drifted
    const first = await run(q, h);
    assertEquals(first.turn.result.outcome, "needs_choice");
    assertEquals(h.tables.proposals.length, 0);
    const history = [{ role: "user", content: q }, { role: "assistant", content: first.turn.reply }];
    const hit = matchSkill({ utterance: "run as exploratory", history });
    assert(hit, "the choice is routed back to the what-if");
    assertEquals(hit!.skill.id, "whatif");
    assertStringIncludes(hit!.input.utterance, q);
    h.ctx.draft!.utterance = hit!.input.utterance;
    const turn = await runSkillTurn({
      skill: hit!.skill, match: hit!.match, input: hit!.input,
      opts: { canDraft: true, enabledAgents: ["experiment-designer"] },
      ctx: h.ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
    });
    assertEquals(turn.result.outcome, "proposed", turn.reply);
    assertEquals((h.tables.proposals[0].payload as Record<string, unknown>).run_mode, "exploratory");
    // A bare "run as exploratory" with no earlier experiment is NOT claimed.
    assertEquals(matchSkill({ utterance: "run as exploratory", history: [] }), null);
  }));

Deno.test("V row 9: a mitigation study on a drifted project also stops and asks", () =>
  withEnv(DESIGNER, async () => {
    const h = await harness({ graphHash: "graph-hash-2" });
    const { turn } = await run("how do I mitigate an S1 outage in weeks 22-25?", h);
    assertEquals(turn.result.outcome, "needs_choice");
    assertEquals(h.tables.proposals.length, 0);
  }));


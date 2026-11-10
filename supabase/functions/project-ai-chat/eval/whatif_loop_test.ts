// §20.8 the deterministic what-if loop (ai-agents.md, v1.6) — deterministic
// tier. Drives the REAL whatIf.ts loop over the REAL tool handlers on the stub
// DB (the cl-01 closed-loop project: supplier S1, a "6-week outage of S1"
// scenario at day 28 with a done run), plus the v1.6 harness changes it
// shipped with: the wall wrap-up reserve, evidence-part de-duplication, and
// the readable get_run_results list. No LLM is called by the loop itself;
// the wall tests script the provider.
//
// The ask that motivated it — "what if disruption with S001 at week 22 and
// duration of 4 weeks" — is wi-02 below, run against this fixture's S1.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import { executeTool, type ToolContext } from "../tools.ts";
import { runChat } from "../providers.ts";
import { makeRequestBudget, WALL_WRAPUP_NOTE, BUDGET_EXHAUSTED_LINES } from "../budgets.ts";
import { installFetchMock, type ScriptedResponse } from "./harness/fetch_mock.ts";
import { kpiText } from "../vvTools.ts";
import { BASE_RUN, BASE_SCEN, MODEL, validatedProject, VER } from "./harness/model_fixture.ts";
// Importing agentTurn registers find_completed_run / get_run_results /
// draft_experiment_spec into the shared registry, as index.ts does.
import "../agentTurn.ts";
import { agentReplicationsLimit } from "../experimentTools.ts";
import {
  eventKey,
  parseWhatIf,
  runWhatIfLoop,
  whatIfInterpretationMessage,
  whatIfReply,
  whatIfRouteDecision,
} from "../whatIf.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "99999999-9999-4999-8999-999999999901";
const SCEN = "55555555-5555-4555-8555-555555555502";

async function cl01(): Promise<{ snapshot: Record<string, Row[]> }> {
  const f = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)),
  );
  return { snapshot: f.project_snapshot };
}

async function harness(opts?: {
  graphHash?: string;
  patch?: (t: Record<string, Row[]>) => void;
  utterance?: string;
}): Promise<{ ctx: ToolContext; tables: Record<string, Row[]> }> {
  const { snapshot } = await cl01();
  const tables = structuredClone(snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
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
      threadId: "33333333-3333-4333-8333-333333333333",
      modelCode: "gpt-5",
      providerCode: "openai",
      canProposals: true,
      utterance: opts?.utterance ?? "what if",
    },
  };
  return { ctx, tables };
}

function withDesigner<T>(fn: () => Promise<T>): Promise<T> {
  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.set("AGENT_EXPERIMENT_TYPES", "single");
  Deno.env.set("CLOSED_LOOP_ENABLED", "true");
  return fn().finally(() => {
    Deno.env.delete("AGENT_ENABLED_IDS");
    Deno.env.delete("AGENT_EXPERIMENT_TYPES");
    Deno.env.delete("CLOSED_LOOP_ENABLED");
  });
}

// ── 1. Understand: the parse ─────────────────────────────────────────────────

Deno.test("wi-parse: the motivating ask is fully understood — target, start week, duration", () => {
  const a = parseWhatIf("what if disruption with S001 at week 22 and duration of 4 weeks");
  assert(a !== null, "a disruption what-if");
  assertEquals(a!.targets, ["S001"]);
  assertEquals(a!.startWeek, 22, "'week 22' — unit before the number is the START");
  assertEquals(a!.durationWeeks, 4, "'4 weeks' — number before the unit is the DURATION");
  assertEquals(a!.magnitudePct, null, "no effect stated — defaulted later, and named in the reply");
});

Deno.test("wi-parse: ranges, capacity cuts, the plant, days and months", () => {
  const r = parseWhatIf("simulate a 40% capacity cut at S-104 in weeks 10-13")!;
  assertEquals([r.targets, r.startWeek, r.durationWeeks, r.magnitudePct], [["S-104"], 10, 4, 40]);
  const p = parseWhatIf("what if the plant goes offline from week 30 for 2 months")!;
  assertEquals([p.targets, p.startWeek, p.durationWeeks, p.magnitudePct], [["plant"], 30, 9, 100]);
  const d = parseWhatIf("what happens if supplier Acme shuts down on day 70 for 21 days")!;
  assertEquals([d.targets, d.startWeek, d.durationWeeks, d.magnitudePct], [["Acme"], 10, 3, 100]);
  const n = parseWhatIf("what if S1 fails at w12, re-run with 50 replications")!;
  assertEquals([n.targets, n.startWeek, n.replications, n.rerun], [["S1"], 12, 50, true]);
});

Deno.test("wi-parse: conservative — ordinary questions are NOT what-ifs (they go to the router as before)", () => {
  for (
    const m of [
      "who are our suppliers?",
      "what did the last run show?",
      "explain the disruption schedule",
      "what if we raise safety stock?",
      "hi",
    ]
  ) {
    assertEquals(parseWhatIf(m), null, m);
  }
});

Deno.test("wi-route: a parsed what-if is routed by the parse — Designer when routable, advisory otherwise", () => {
  const r = whatIfRouteDecision(true);
  assertEquals([r.route, r.agent_id, r.needs_run, r.cache_checkable, r.short_circuit], [
    "artifact",
    "experiment-designer",
    true,
    true,
    "whatif_parser",
  ]);
  const a = whatIfRouteDecision(false);
  assertEquals([a.route, a.agent_id], ["advisory", null]);
});

Deno.test("wi-key: the cache compares disruptions as the ENGINE runs them", () => {
  const ids = new Set(["S1"]);
  const k = (e: Record<string, unknown>) => eventKey(e, ids);
  const base = { target: "S1", start_day: 28, duration_days: 42, magnitude_pct: 100 };
  assertEquals(k({ ...base, target: "supplier:S1" }), k(base), "S1 ≡ supplier:S1");
  assertEquals(k({ ...base, start_day: 30 }), k(base), "day 30 rounds to the same engine week as day 28");
  assertEquals(k({ ...base, magnitude_pct: 150 }), k(base), "every magnitude ≥ the outage threshold is one effect");
  assert(k({ ...base, magnitude_pct: 40 }) !== k(base), "a 40% cut is a different event");
  assert(k({ ...base, start_day: 154 }) !== k(base), "a different start is a different event");
  assertEquals(k({ ...base, target: "S9" }), null, "a target the engine skips is no event");
});

// ── 2–4. The loop on a VALIDATED project (ai-agents.md §27) ─────────────────
// Every chat experiment follows the Validated Model: its versions, its
// protocol, its baseline. `validatedProject` (harness/model_fixture.ts) makes
// the stub what a validated project is.

Deno.test("V row 1 (hit): a finished run of the MODEL answers, PAIRED against the model's own baseline; no card", async () => {
  await withDesigner(async () => {
    const { ctx, tables } = await harness({ patch: validatedProject });
    const wi = await runWhatIfLoop(ctx, parseWhatIf("what if S1 goes down at week 4 for 6 weeks?")!, { canDraft: true });
    assertEquals(wi.outcome.kind, "hit");
    if (wi.outcome.kind !== "hit") return;
    assertEquals(wi.outcome.runId, RUN);
    assertEquals(wi.outcome.baselineRunId, BASE_RUN, "the model's evidence run IS the baseline");
    assertEquals(wi.outcome.paired, true);
    assertEquals(tables.proposals.length, 0);
    const reply = whatIfReply(wi.outcome);
    assertStringIncludes(reply, 'follows Validated Model "Q4 baseline"');
    assertStringIncludes(reply, "0.87");
    assertStringIncludes(reply, "-0.1 ± 0", "fill rate 0.86/0.87/0.88 vs 0.96/0.97/0.98, per replication");
    assertStringIncludes(reply, "paired");
    const table = wi.parts.find((p) => p.kind === "table")!.data as { columns: string[] };
    assertEquals(table.columns[4], "Difference (paired, 95% CI)");
  });
});

Deno.test("V row 1 (miss): ONE card that FOLLOWS the model — its policy version, protocol replications, its horizon; no deviation", async () => {
  await withDesigner(async () => {
    const utterance = "what if disruption with S1 at week 22 and duration of 4 weeks";
    const { ctx, tables } = await harness({ utterance, patch: validatedProject });
    const wi = await runWhatIfLoop(ctx, parseWhatIf(utterance)!, { canDraft: true });
    assertEquals(wi.outcome.kind, "proposed", whatIfReply(wi.outcome));
    assertEquals(tables.proposals.length, 1);
    const payload = tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.validated_model_id, MODEL);
    assertEquals(payload.policy_version_id, VER, "the MODEL's policy version");
    assertEquals(payload.replications, 3, "the protocol's count — not the 5 cap, not a guess");
    assertEquals(payload.deviations, [], "faithful by construction");
    assertEquals(payload.model_name, "Q4 baseline");
    const ns = payload.new_scenario as { horizon_days: number; disruption_schedule: unknown[] };
    assertEquals(ns.horizon_days, 364, "the model's 52 weeks, not a computed length");
    assertEquals(payload.experiment_type, undefined, "a usable baseline run exists — nothing extra runs");
    assertStringIncludes(String(tables.proposals[0].title), "What-if");
    assertStringIncludes(whatIfReply(wi.outcome), 'follows Validated Model "Q4 baseline"');
  });
});

Deno.test("V row 6: a stated replication count is used and SHOWN as a deviation from the protocol", async () => {
  await withDesigner(async () => {
    const utterance = "what if S1 has an outage at week 22 for 4 weeks, with 10 replications";
    const { ctx, tables } = await harness({ utterance, patch: validatedProject });
    await runWhatIfLoop(ctx, parseWhatIf(utterance)!, { canDraft: true });
    const payload = tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.replications, 10);
    assertEquals((payload.deviations as Array<Record<string, unknown>>).map((d) => [d.key, d.model, d.run]), [["replications", 3, 10]]);
  });
});

/** The owner's production model: a protocol of 161 replications (§10 38(al)). */
const protocol161 = (t: Record<string, Row[]>) => {
  validatedProject(t);
  const card = t.model_validations.find((c) => String(c.id) === MODEL)!;
  card.recommended_replications = 161;
  (card.protocol as Record<string, unknown>).replications = 161;
};

Deno.test("38(al): a model-following run is capped at 30 replications — the cut protocol is a deviation, and the card says how to run it", async () => {
  await withDesigner(async () => {
    const utterance = "what if S1 has an outage at week 22 for 4 weeks";
    const { ctx, tables } = await harness({ utterance, patch: protocol161 });
    const wi = await runWhatIfLoop(ctx, parseWhatIf(utterance)!, { canDraft: true });
    assertEquals(wi.outcome.kind, "proposed", whatIfReply(wi.outcome));
    const payload = tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.replications, 30, "the hard cap, not the protocol's 161");
    assertEquals((payload.deviations as Array<Record<string, unknown>>).map((d) => [d.key, d.model, d.run]), [["replications", 161, 30]]);
    assertEquals(payload.replications_cap, 30, "the card labels the deviation as the chat's limit, not the user's request");
  });
});

Deno.test("38(al): only a count the USER states goes above 30", async () => {
  await withDesigner(async () => {
    const utterance = "what if S1 has an outage at week 22 for 4 weeks, with 50 replications";
    const { ctx, tables } = await harness({ utterance, patch: protocol161 });
    await runWhatIfLoop(ctx, parseWhatIf(utterance)!, { canDraft: true });
    const payload = tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.replications, 50);
    assertEquals(payload.replications_cap, undefined, "the user's own count — no cap note");
    assertEquals((payload.deviations as Array<Record<string, unknown>>).map((d) => [d.key, d.model, d.run]), [["replications", 161, 50]]);
  });
});

Deno.test("38(al): agentReplicationsLimit — 5 exploratory, 30 model-following, a stated count above either, never past 200", () => {
  assertEquals(agentReplicationsLimit(null, false), 5);
  assertEquals(agentReplicationsLimit(null, true), 30);
  assertEquals(agentReplicationsLimit(10, true), 30, "a smaller stated count does not lower the ceiling the arguments meet");
  assertEquals(agentReplicationsLimit(50, true), 50);
  assertEquals(agentReplicationsLimit(50, false), 50);
  assertEquals(agentReplicationsLimit(999, true), 200);
});

Deno.test("V row 8: no usable baseline run of the model ⇒ the card runs the baseline too (one approval, paired)", async () => {
  await withDesigner(async () => {
    Deno.env.set("AGENT_EXPERIMENT_TYPES", "single,comparison");
    const utterance = "what if S1 has an outage at week 22 for 4 weeks";
    const { ctx, tables } = await harness({
      utterance,
      patch: (t) => {
        validatedProject(t);
        t.simulation_runs.find((r) => String(r.id) === BASE_RUN)!.status = "failed";
      },
    });
    const wi = await runWhatIfLoop(ctx, parseWhatIf(utterance)!, { canDraft: true });
    assertEquals(wi.outcome.kind, "proposed", whatIfReply(wi.outcome));
    const payload = tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.experiment_type, "comparison");
    assertEquals((payload.arms as Array<Record<string, unknown>>).map((a) => a.label), ["Baseline (no disruption)", "With disruption"]);
    assertEquals(payload.validated_model_id, MODEL, "both arms follow the model");
  });
});

Deno.test("V row 2: no Validated Model ⇒ NO card, the validation step is offered; exploratory only on explicit request", async () => {
  await withDesigner(async () => {
    const noModel = (t: Record<string, Row[]>) => { t.model_validations = []; };
    const a = await harness({ patch: noModel });
    const stop = await runWhatIfLoop(a.ctx, parseWhatIf("what if S1 has an outage at week 22 for 4 weeks")!, { canDraft: true });
    assertEquals(stop.outcome.kind, "no_model");
    assertEquals(a.tables.proposals.length, 0);
    assertStringIncludes(whatIfReply(stop.outcome), "Run & Validate");

    const utterance = "what if S1 has an outage at week 22 for 4 weeks — run it anyway as exploratory";
    const b = await harness({ utterance, patch: noModel });
    const go = await runWhatIfLoop(b.ctx, parseWhatIf(utterance)!, { canDraft: true });
    assertEquals(go.outcome.kind, "proposed", whatIfReply(go.outcome));
    const payload = b.tables.proposals[0].payload as Record<string, unknown>;
    assertEquals(payload.run_mode, "exploratory");
    assertEquals(payload.validated_model_id, undefined);
    assertEquals(payload.replications, 5, "38(ad) still governs exploratory runs");
    assertStringIncludes(whatIfReply(go.outcome), "not a validated result");
  });
});

Deno.test("V rows 3–4: the project drifted from the model ⇒ STOP AND ASK, every time; the user's choice decides", async () => {
  await withDesigner(async () => {
    const q = "what if S1 has an outage at week 22 for 4 weeks";
    // data drift (the live graph hash moved)
    const a = await harness({ graphHash: "graph-hash-2", patch: validatedProject });
    const ask = await runWhatIfLoop(a.ctx, parseWhatIf(q)!, { canDraft: true });
    assertEquals(ask.outcome.kind, "needs_choice");
    assertEquals(a.tables.proposals.length, 0, "nothing is drafted before the user chooses");
    const text = whatIfReply(ask.outcome);
    assertStringIncludes(text, "the simulation's inputs changed");
    assertStringIncludes(text, '"run as validated"');
    assertStringIncludes(text, '"run as exploratory"');

    // "run as validated": follows the model (replays its versions)
    const u1 = `${q} — run as validated`;
    const b = await harness({ graphHash: "graph-hash-2", utterance: u1, patch: validatedProject });
    const follow = await runWhatIfLoop(b.ctx, parseWhatIf(u1)!, { canDraft: true });
    assertEquals(follow.outcome.kind, "proposed", whatIfReply(follow.outcome));
    assertEquals((b.tables.proposals[0].payload as Record<string, unknown>).validated_model_id, MODEL);
    assertStringIncludes(whatIfReply(follow.outcome), "not the project's current ones");

    // "run as exploratory": current versions, labelled
    const u2 = `${q} — run as exploratory`;
    const c = await harness({ graphHash: "graph-hash-2", utterance: u2, patch: validatedProject });
    const explore = await runWhatIfLoop(c.ctx, parseWhatIf(u2)!, { canDraft: true });
    assertEquals(explore.outcome.kind, "proposed", whatIfReply(explore.outcome));
    const p = c.tables.proposals[0].payload as Record<string, unknown>;
    assertEquals([p.run_mode, p.validated_model_id, p.base_scenario_id], ["exploratory", undefined, BASE_SCEN]);
  });
});

Deno.test("V row 7: inside the warm-up ⇒ refused with a measurable week; past the horizon ⇒ ASK before extending", async () => {
  await withDesigner(async () => {
    const a = await harness({ patch: validatedProject });
    const warm = await runWhatIfLoop(a.ctx, parseWhatIf("what if S1 has an outage at week 2 for 2 weeks")!, { canDraft: true });
    assertEquals(warm.outcome.kind, "invalid");
    assertStringIncludes(whatIfReply(warm.outcome), "warm-up");

    const q = "what if S1 has an outage at week 50 for 6 weeks";
    const b = await harness({ patch: validatedProject });
    const far = await runWhatIfLoop(b.ctx, parseWhatIf(q)!, { canDraft: true });
    assertEquals(far.outcome.kind, "needs_horizon");
    assertEquals(b.tables.proposals.length, 0);
    assertStringIncludes(whatIfReply(far.outcome), "simulates 52 weeks");

    const u = `${q} — extend the horizon`;
    const c = await harness({ utterance: u, patch: validatedProject });
    const ext = await runWhatIfLoop(c.ctx, parseWhatIf(u)!, { canDraft: true });
    assertEquals(ext.outcome.kind, "proposed", whatIfReply(ext.outcome));
    const payload = c.tables.proposals[0].payload as Record<string, unknown>;
    assertEquals((payload.new_scenario as { horizon_days: number }).horizon_days, (55 + 8) * 7);
    assertEquals((payload.deviations as Array<Record<string, unknown>>).map((d) => d.key), ["horizon_weeks"], "the longer run is a shown deviation");
  });
});

Deno.test("V row 14: drafting not available ⇒ the Lab steps name the MODEL to choose; no card", async () => {
  const { ctx, tables } = await harness({ patch: validatedProject });
  const wi = await runWhatIfLoop(ctx, parseWhatIf("what if S1 shuts down at week 22 for 4 weeks")!, {
    canDraft: false,
    draftBlockedReason: "this thread is in Ask mode, which never files proposals",
  });
  assertEquals(wi.outcome.kind, "not_proposed");
  assertEquals(tables.proposals.length, 0);
  const reply = whatIfReply(wi.outcome);
  assertStringIncludes(reply, "Ask mode");
  assertStringIncludes(reply, 'choose the model "Q4 baseline"');
});

Deno.test("wi-04 an unknown target is asked about, with the project's real suppliers — never guessed", async () => {
  const { ctx } = await harness({ patch: validatedProject });
  const wi = await runWhatIfLoop(ctx, parseWhatIf("what if S999 has an outage at week 5 for 2 weeks")!, { canDraft: true });
  assertEquals(wi.outcome.kind, "needs_target");
  const reply = whatIfReply(wi.outcome);
  assertStringIncludes(reply, "S999");
  assertStringIncludes(reply, "- S1 (Acme)");
});

Deno.test("wi-05 an ambiguous fragment lists the candidates (§19.5)", async () => {
  const { ctx } = await harness({
    patch: (t) => {
      t.suppliers.push(
        { project_id: PROJECT, supplier_id: "SUP-10", name: "North" },
        { project_id: PROJECT, supplier_id: "SUP-11", name: "South" },
      );
    },
  });
  const wi = await runWhatIfLoop(ctx, parseWhatIf("what if SUP-1 has an outage at week 5 for 2 weeks")!, { canDraft: true });
  assertEquals(wi.outcome.kind, "needs_target");
  const reply = whatIfReply(wi.outcome);
  assertStringIncludes(reply, "SUP-10");
  assertStringIncludes(reply, "SUP-11");
});

// ── v1.6 harness changes shipped with the loop ────────────────────────────────

Deno.env.set("GEMINI_API_KEY", "test-gemini-key");
const textResponse = (text: string): ScriptedResponse => ({
  json: { candidates: [{ content: { parts: [{ text }] } }] },
});
const toolCallResponse = (calls: Array<[string, Record<string, unknown>]>): ScriptedResponse => ({
  json: { candidates: [{ content: { parts: calls.map(([name, args]) => ({ functionCall: { name, args } })) } }] },
});

Deno.test("wall wrap-up reserve: inside the reserve, no new tool hop — one tool-free closing answer + the named meter", async () => {
  let now = 0;
  const budget = makeRequestBudget({ wallBudgetMs: 4000, now: () => now }); // reserve = 1000 ms
  const tables: Record<string, Row[]> = {
    node_list: [{ project_id: PROJECT, node_id: "S1", node_type: "supplier", node_group: "g" }],
  };
  const db = makeStubDb(tables, makeAgentRpcs(tables));
  const ctx: ToolContext = { projectId: PROJECT, userId: USER, supabase: db as unknown as ToolContext["supabase"], budget };
  const mock = installFetchMock([
    toolCallResponse([["list_project_entities", { entity_type: "supplier" }]]),
    textResponse("S1 is the only supplier on file."),
  ]);
  try {
    const result = await runChat("gemini-2.5-flash", "list suppliers", [], ctx, null, {
      budget,
      onToolResult: () => {
        now = 3500; // inside the reserve (> 4000 - 1000), before the wall itself
      },
    });
    assertEquals(mock.calls.length, 2, "the closing completion, not a second tool hop");
    const closingBody = mock.calls[1].body as Record<string, unknown>;
    assertEquals(closingBody.tools, undefined, "the tool surface is withdrawn on the closing call");
    assertStringIncludes(result.reply, "S1 is the only supplier on file.");
    assertStringIncludes(result.reply, WALL_WRAPUP_NOTE, "the meter that stopped the work is still named");
    assertEquals(budget.budgetHit, "wall");
    assertEquals(result.parts.length, 1, "the evidence already read is kept");
  } finally {
    mock.restore();
  }
});

Deno.test("wall wrap-up: a failed closing completion falls back to the honest exhaustion line", async () => {
  let now = 0;
  const budget = makeRequestBudget({ wallBudgetMs: 4000, now: () => now });
  const tables: Record<string, Row[]> = {
    node_list: [{ project_id: PROJECT, node_id: "S1", node_type: "supplier", node_group: "g" }],
  };
  const db = makeStubDb(tables, makeAgentRpcs(tables));
  const ctx: ToolContext = { projectId: PROJECT, userId: USER, supabase: db as unknown as ToolContext["supabase"], budget };
  const mock = installFetchMock([
    toolCallResponse([["list_project_entities", { entity_type: "supplier" }]]),
    { status: 400, json: { error: "bad" } },
  ]);
  try {
    const result = await runChat("gemini-2.5-flash", "list suppliers", [], ctx, null, {
      budget,
      onToolResult: () => {
        now = 3500;
      },
    });
    assertEquals(result.reply, BUDGET_EXHAUSTED_LINES.wall);
  } finally {
    mock.restore();
  }
});

Deno.test("evidence parts are de-duplicated: the same rows fetched twice render ONE table", async () => {
  const tables: Record<string, Row[]> = {
    node_list: [{ project_id: PROJECT, node_id: "S1", node_type: "supplier", node_group: "g" }],
  };
  const db = makeStubDb(tables, makeAgentRpcs(tables));
  const ctx: ToolContext = { projectId: PROJECT, userId: USER, supabase: db as unknown as ToolContext["supabase"] };
  const mock = installFetchMock([
    toolCallResponse([
      ["list_project_entities", { entity_type: "supplier" }],
      ["list_project_entities", { entity_type: "supplier" }],
    ]),
    textResponse("One supplier: S1."),
  ]);
  try {
    const result = await runChat("gemini-2.5-flash", "list suppliers", [], ctx, null);
    assertEquals(result.toolCalls.length, 2, "both calls ran and the model saw both");
    assertEquals(result.parts.length, 1, "the user sees one table");
  } finally {
    mock.restore();
  }
});

Deno.test("get_run_results (list): names each run's scenario and shows KPIs as text, not a JSON blob", async () => {
  const { ctx } = await harness();
  const env = await executeTool("get_run_results", {}, ctx);
  assertEquals(env.kind, "table");
  const data = env.data as { columns: string[]; rows: unknown[][] };
  assertEquals(data.columns, ["run_id", "scenario", "status", "reps_done", "warmup_week", "gate_skipped", "policy_version_id", "kpis"]);
  assertEquals(data.rows[0][1], "6-week outage of S1");
  assertEquals(data.rows[0][7], "fill_rate 0.87 · backlog_peak 412");
  assertEquals(kpiText({ _meta: { engine: "scsim" }, _range: {} }), "-", "underscore keys are metadata, not KPIs");
});

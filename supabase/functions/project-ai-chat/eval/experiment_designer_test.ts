// B4 Experiment Designer golden suite, deterministic tier (ai-agents.md §5.4
// table, §7.4 tier 1): each ed-* fixture drives the REAL tool handler / apply
// module with a mocked LLM (the fixture's tool-call arguments), asserting the
// deterministic machinery — the §5.4 hard gates (version-in-project,
// replication clamp, ≤5 disruption events, FORCED acknowledge_warnings:false,
// read-only findings_preview), grounding {policy_hash}, idempotency, and the
// §4.4 apply through the ONE dispatch path (dispatchExperimentRun) with the
// full provenance stamps a Lab dispatch produces. No LLM, no network, no DB.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row, type StubDb } from "./harness/stub_db.ts";
import { executeTool, type ToolContext, type ToolEnvelope } from "../tools.ts";
import {
  buildExperimentContext,
  buildExperimentPrompt,
  DRAFT_EXPERIMENT_SPEC_SCHEMA,
  experimentToolDeclarations,
} from "../experimentTools.ts";
import { AGENT_COMMON } from "../draftTools.ts";
import { runAgentTurn } from "../agentTurn.ts";
import { installFetchMock } from "./harness/fetch_mock.ts";
import { applyExperimentSpec } from "../../agent-apply/experimentSpecApply.ts";
import { ARTIFACT_RIGHTS, checkApplyQuota, EXPERIMENT_DAILY_CAP } from "../../agent-apply/index.ts";
import { ApplyFailure } from "../../agent-apply/itemMasterApply.ts";
import { dispatchExperimentRun } from "../../_shared/dispatch.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SCEN = "55555555-5555-4555-8555-555555555501";
const VER = "44444444-4444-4444-8444-444444444401";

interface Fixture {
  id: string;
  description: string;
  project_snapshot: Record<string, Row[]> | { reuse: string; patch?: Record<string, Row[]> };
  utterance: string;
  mocked_llm?: { tool?: string; args?: Record<string, unknown> } | null;
  // deno-lint-ignore no-explicit-any
  expect: Record<string, any>;
  retired_reason: string | null;
}

async function loadFixture(id: string): Promise<Fixture> {
  const f: Fixture = JSON.parse(
    await Deno.readTextFile(new URL(`./fixtures/experiment-designer/${id}.json`, import.meta.url)),
  );
  if ("reuse" in f.project_snapshot) {
    const spec = f.project_snapshot as { reuse: string; patch?: Record<string, Row[]> };
    const base = await loadFixture(spec.reuse);
    f.project_snapshot = {
      ...(base.project_snapshot as Record<string, Row[]>),
      ...(spec.patch ?? {}),
    };
  }
  return f;
}

interface Harness {
  ctx: ToolContext;
  db: StubDb;
  upstashCalls: (string | number)[][];
  upstash: (args: (string | number)[]) => Promise<unknown>;
}

function makeCtx(fixture: Fixture): Harness {
  const tables = structuredClone(fixture.project_snapshot) as Record<string, Row[]>;
  const db = makeStubDb(tables, makeAgentRpcs(tables));
  const upstashCalls: (string | number)[][] = [];
  const upstash = (args: (string | number)[]) => {
    upstashCalls.push(args);
    return Promise.resolve("ok");
  };
  const ctx: ToolContext = {
    projectId: PROJECT,
    userId: USER,
    supabase: db as unknown as ToolContext["supabase"],
    draft: {
      userEmail: "a@example.com",
      threadId: "33333333-3333-4333-8333-333333333333",
      modelCode: "gemini-2.5-flash",
      providerCode: "gemini",
      canProposals: true,
      utterance: fixture.utterance,
    },
  };
  return { ctx, db, upstashCalls, upstash };
}

function withB4Enabled<T>(fn: () => Promise<T>): Promise<T> {
  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.set("AGENT_EXPERIMENT_TYPES", "single");
  return fn().finally(() => {
    Deno.env.delete("AGENT_ENABLED_IDS");
    Deno.env.delete("AGENT_EXPERIMENT_TYPES");
  });
}

function storedProposal(db: StubDb, env: ToolEnvelope): Row {
  assertEquals(env.kind, "proposal", `expected a proposal envelope, got ${env.kind}: ${env.data}`);
  const id = String((env.data as Record<string, unknown>).proposal_id);
  const row = db.tables.proposals.find((p) => String(p.id) === id);
  if (!row) throw new Error(`proposal ${id} not stored`);
  return row;
}

Deno.test("ed-01-simple-run: existing scenario + version → valid spec; unstated reps capped at 5 (38(ad)); grounding = {policy_hash}", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    const stored = storedProposal(db, env);
    const payload = stored.payload as Record<string, unknown>;
    const exp = fixture.expect.proposal;
    assertEquals(payload.scenario_id, exp.scenario_id);
    assertEquals(payload.policy_version_id, exp.policy_version_id);
    // §10 entry 38(ad): the user stated no count, so the model's 30 (the
    // card's recommendation) is capped at the owner's default of 5.
    assertEquals(exp.replications, 30, "the fixture's model asked for the card's 30");
    assertEquals(payload.replications, 5, "an unstated count is capped at 5");
    assertEquals(payload.acknowledge_warnings, exp.acknowledge_warnings);
    assertEquals(payload.newer_version_exists, exp.newer_version_exists);
    assertEquals(stored.provenance, exp.provenance, "§5.4: the spec is llm_drafted — human must verify");
    assertEquals((stored.grounding as Record<string, unknown>).policy_hash, exp.grounding_policy_hash,
      "§5.4: grounding = {policy_hash} of the bound version");
    assert(Array.isArray(payload.findings_preview), "read-only gate preview attached (§5.4 hard gate)");
    assert(typeof payload.gate_status === "string", "gate pre-check status recorded for the card");
    assertEquals(db.tables.proposals.length, fixture.expect.proposal_count);
  }));

Deno.test("ed-01: replications clamp 1-200 (the dispatch.ts clamp restated at draft time)", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx, db } = makeCtx(fixture);
    ctx.draft!.utterance = "run the outage scenario with 500 replications";
    const env = await executeTool("draft_experiment_spec", {
      ...fixture.mocked_llm!.args!,
      replications: 5000,
    }, ctx);
    const payload = storedProposal(db, env).payload as Record<string, unknown>;
    assertEquals(payload.replications, 200, "a STATED count lifts the 5 cap; 5000 still clamps to the 200 ceiling");
  }));

Deno.test("38(ad): the user's stated count is used; an unstated one is capped at 5", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const stated = makeCtx(fixture);
    stated.ctx.draft!.utterance = "simulate the outage with 30 replications";
    const a = storedProposal(stated.db, await executeTool("draft_experiment_spec", { ...fixture.mocked_llm!.args!, replications: 30 }, stated.ctx));
    assertEquals((a.payload as Record<string, unknown>).replications, 30, "the user asked for 30 — run 30");
    const unstated = makeCtx(fixture);
    unstated.ctx.draft!.utterance = "simulate the outage";
    const b = storedProposal(unstated.db, await executeTool("draft_experiment_spec", { ...fixture.mocked_llm!.args!, replications: 3 }, unstated.ctx));
    assertEquals((b.payload as Record<string, unknown>).replications, 3, "below the cap is left alone");
  }));

Deno.test("ed-01: idempotency — the same substantive spec converges on one card (§4.5)", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx, db } = makeCtx(fixture);
    const first = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    // Re-phrased free text, identical substance ⇒ duplicate (success-like).
    const second = await executeTool("draft_experiment_spec", {
      ...fixture.mocked_llm!.args!,
      title: "different title",
      question: "differently phrased question",
    }, ctx);
    assertEquals(second.meta.note, "duplicate");
    assertEquals(
      (second.data as Record<string, unknown>).proposal_id,
      (first.data as Record<string, unknown>).proposal_id,
    );
    assertEquals(db.tables.proposals.length, 1);
  }));

Deno.test("ed-02-new-scenario: outage ask → new_scenario with schedule ≤ 5 events; 6 events fail invalid_params", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-02-new-scenario");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    const payload = storedProposal(db, env).payload as Record<string, unknown>;
    const ns = payload.new_scenario as Record<string, unknown>;
    const exp = fixture.expect.proposal;
    assertEquals(ns.name, exp.new_scenario_name);
    assertEquals(ns.horizon_days, exp.new_scenario_horizon_days);
    assertEquals((ns.disruption_schedule as unknown[]).length, exp.new_scenario_events);
    assertEquals(payload.acknowledge_warnings, false);
    assertEquals((storedProposal(db, env).grounding as Record<string, unknown>).policy_hash, exp.grounding_policy_hash);

    // §5.4 hard gate: the engine G11 boundary — 6 events refuse at draft.
    const sixEvents = Array.from({ length: 6 }, (_, i) => ({
      target: "S1", target_type: "node", start_day: 7 * (i + 1), duration_days: 7, magnitude_pct: 50,
    }));
    const over = await executeTool("draft_experiment_spec", {
      new_scenario: { name: "too many events", horizon_days: 182, disruption_schedule: sixEvents },
      policy_version_id: VER,
      replications: 30,
    }, ctx);
    assertEquals(over.meta.note, fixture.expect.over_limit_error_code);
    assertEquals(db.tables.proposals.length, fixture.expect.proposal_count);
  }));

Deno.test("ed-03-no-version: no saved policy version → dependency_missing naming save/snapshot; no proposal", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-03-no-version");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    assertEquals(env.meta.note, fixture.expect.error_code);
    assertStringIncludes(String(env.data), fixture.expect.error_includes);
    assertEquals(db.tables.proposals.length, fixture.expect.proposal_count);
  }));

Deno.test("ed-04-doe-honest: the prompt carries the honest pre-Phase-C refusal; smuggled comparison params fail the schema gate", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-04-doe-honest");
    const { ctx, db } = makeCtx(fixture);
    const context = await buildExperimentContext(ctx, { utterance: fixture.utterance });
    for (const chunk of fixture.expect.context_includes) {
      assertStringIncludes(context, chunk);
    }
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    assertEquals(env.meta.note, fixture.expect.error_code, "additionalProperties: false (§5.4 schema verbatim)");
    assertEquals(db.tables.proposals.length, fixture.expect.proposal_count);
  }));

Deno.test("ed-05-ack-forced-false: the model sets acknowledge_warnings:true → stored false", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-05-ack-forced-false");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    const payload = storedProposal(db, env).payload as Record<string, unknown>;
    assertEquals(payload.acknowledge_warnings, fixture.expect.proposal.acknowledge_warnings,
      "§5.4 hard rule: only the card's approving human can flip it");
  }));

Deno.test("ed-06-brief-grounded: the grounding context carries the persisted run results; a brief drafts nothing", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-06-brief-grounded");
    const { ctx, db } = makeCtx(fixture);
    const context = await buildExperimentContext(ctx, { utterance: fixture.utterance });
    for (const chunk of fixture.expect.context_includes) {
      assertStringIncludes(context, chunk);
    }
    assertEquals(db.tables.proposals.length, fixture.expect.proposal_count);
  }));

Deno.test("ed-07-apply-gate-block: under-specified project — draft shows the block; apply fails gate_blocked, nothing dispatched", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-07-apply-gate-block");
    const { ctx, db, upstash, upstashCalls } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    const stored = storedProposal(db, env);
    const payload = stored.payload as Record<string, unknown>;
    assertEquals(payload.gate_status, fixture.expect.proposal.gate_status, "the read-only preview already shows it");
    const preview = payload.findings_preview as Array<{ severity: string }>;
    assertEquals(preview.some((f) => f.severity === "block"), fixture.expect.proposal.findings_preview_has_block);

    stored.status = "approved"; // the card's Approve
    try {
      await applyExperimentSpec(db, { upstash }, {
        projectId: PROJECT,
        payload: stored.payload as Record<string, unknown>,
        grounding: stored.grounding as Record<string, unknown>,
        userId: USER,
      });
      throw new Error("expected ApplyFailure");
    } catch (e) {
      assert(e instanceof ApplyFailure, `expected ApplyFailure, got ${e}`);
      assertEquals((e as ApplyFailure).code, fixture.expect.apply.error_code);
      assertStringIncludes((e as ApplyFailure).message, fixture.expect.apply.error_includes);
    }
    assertEquals((db.tables.simulation_runs ?? []).length, fixture.expect.apply.runs_created, "nothing dispatched");
    assertEquals(upstashCalls.length, 0, "nothing enqueued");
  }));

Deno.test("ed-08-apply-dispatch: run queued with the full provenance stamps; indistinguishable from a Lab dispatch; second approve returns the same run_id", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-08-apply-dispatch");
    const exp = fixture.expect.apply;

    // (a) provenance indistinguishability on the SAME command: the agent path
    // (scenario_id spec) and a direct Lab dispatch of identical inputs on a
    // clone must stamp identical rows — same stamps, same fields (ed-08).
    {
      const agentSide = makeCtx(fixture);
      const specEnv = await executeTool("draft_experiment_spec", {
        scenario_id: SCEN,
        policy_version_id: VER,
        replications: 30,
      }, agentSide.ctx);
      const stored = storedProposal(agentSide.db, specEnv);
      stored.status = "approved";
      const agentResult = await applyExperimentSpec(agentSide.db, { upstash: agentSide.upstash }, {
        projectId: PROJECT,
        payload: stored.payload as Record<string, unknown>,
        grounding: stored.grounding as Record<string, unknown>,
        userId: USER,
      });
      const agentRun = agentSide.db.tables.simulation_runs.find((r) => String(r.id) === agentResult.run_id)!;

      const labSide = makeCtx(fixture);
      // What the Lab does: set replications on the scenario, then dispatch.
      await labSide.db.from("scenarios").update({ replications: 30 }).eq("id", SCEN);
      const labDispatch = await dispatchExperimentRun(
        { reader: labSide.db, svc: labSide.db, upstash: labSide.upstash },
        {
          project_id: PROJECT,
          scenario_id: SCEN,
          kind: "experiment.run",
          payload: { policy_version_id: VER, acknowledge_warnings: false },
        },
        USER,
      );
      const labRun = labSide.db.tables.simulation_runs.find((r) => String(r.id) === labDispatch.run_id)!;

      for (const field of exp.provenance_stamp_fields as string[]) {
        assertEquals(agentRun[field], labRun[field],
          `provenance stamp "${field}" must be indistinguishable from a Lab dispatch`);
      }
      assertEquals(agentRun.model_validation_id, "88888888-8888-4888-8888-888888888801",
        "the active card in force at dispatch is stamped, exactly as the Lab stamps it");
      assert(agentSide.upstashCalls.some((c) => c[0] === "XADD"), "the worker envelope was enqueued");
    }

    // (b) the fixture's new_scenario spec: queued run with stamps; the
    // idempotent re-apply path returns the stored run_id without re-executing.
    {
      const h = makeCtx(fixture);
      const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, h.ctx);
      const stored = storedProposal(h.db, env);
      stored.status = "approved";
      const result = await applyExperimentSpec(h.db, { upstash: h.upstash }, {
        projectId: PROJECT,
        payload: stored.payload as Record<string, unknown>,
        grounding: stored.grounding as Record<string, unknown>,
        userId: USER,
      });
      const run = h.db.tables.simulation_runs.find((r) => String(r.id) === result.run_id)!;
      assertEquals(run.status, exp.run_status);
      assertEquals(run.rep_count_target, exp.rep_count_target);
      assertEquals(run.policy_version_id, exp.policy_version_id);
      assertEquals(run.policy_hash, exp.policy_hash);
      assertEquals(run.dataset_version_id, exp.dataset_version_id);
      assertEquals(run.graph_hash, exp.graph_hash);
      assert(typeof run.scenario_hash === "string" && String(run.scenario_hash).length > 0,
        "scenario fingerprint stamped");

      // §4.4: dispatch idempotency rides the proposal — agent-apply returns
      // the stored applied_result for an already-applied proposal without
      // re-executing. Mirror that check here.
      await h.db.rpc("mark_agent_proposal_applied", { p_proposal_id: stored.id, p_result: result });
      const applied = h.db.tables.proposals.find((p) => String(p.id) === String(stored.id))!;
      assertEquals(applied.status, "applied");
      const runsBefore = h.db.tables.simulation_runs.length;
      const secondApproveResult = applied.status === "applied" ? applied.applied_result : null;
      assertEquals((secondApproveResult as Record<string, unknown>).run_id, result.run_id,
        "second Approve returns the same run_id");
      assertEquals(h.db.tables.simulation_runs.length, runsBefore, "no second dispatch");

      // A retry (e.g. after a failed bookkeeping write) reuses the scenario —
      // the (project, name) reuse-or-create keeps the Lab clean of duplicates.
      const scenarios = h.db.tables.scenarios.filter((s) =>
        String(s.name) === (fixture.mocked_llm!.args!.new_scenario as Record<string, unknown>).name
      );
      assertEquals(scenarios.length, 1);
    }
  }));

Deno.test("§13.3 rights row: experiment_spec apply demands simulation_lab + /simulation-lab — the Lab's own Run-button rights", () => {
  // Checkpoint 5 (agent-apply/index.ts) walks this table fail-closed BEFORE
  // any mutation: a user without simulation_lab sees the card (agent_proposals)
  // but Approve→apply returns a typed FORBIDDEN and nothing dispatches — the
  // same loop already enforcing the Stage 1-3 rows.
  assertEquals(ARTIFACT_RIGHTS.experiment_spec, {
    features: ["simulation_lab"],
    pages: ["/simulation-lab"],
  });
});

Deno.test("apply quota (§13.4): the 11th same-day apply returns quota_exceeded naming the remaining allowance", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { db } = makeCtx(fixture);
    const today = new Date().toISOString();
    // Ten already-applied agent runs today for this user+project (all done —
    // the concurrent cap is not what trips here), joined through
    // proposals.applied_result→run_id exactly as §13.4 counts them.
    for (let i = 0; i < EXPERIMENT_DAILY_CAP; i++) {
      const runId = `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`;
      db.tables.simulation_runs.push({ id: runId, project_id: PROJECT, status: "done", created_at: today });
      db.tables.proposals.push({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        project_id: PROJECT,
        agent_id: "experiment-designer",
        artifact_type: "experiment_spec",
        status: "applied",
        reviewed_by: USER,
        applied_result: { run_id: runId },
      });
    }
    const violation = await checkApplyQuota(db, {
      artifactType: "experiment_spec",
      projectId: PROJECT,
      userId: USER,
    });
    assert(violation, "the 11th apply must be denied");
    assertStringIncludes(violation!, "10");
    assertStringIncludes(violation!, "0 remaining", "the message names the remaining allowance");
  }));

Deno.test("apply quota (§13.4): 3 concurrent queued/running agent runs block the 4th", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { db } = makeCtx(fixture);
    const today = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      const runId = `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`;
      db.tables.simulation_runs.push({ id: runId, project_id: PROJECT, status: i === 0 ? "running" : "queued", created_at: today });
      db.tables.proposals.push({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        project_id: PROJECT,
        agent_id: "experiment-designer",
        artifact_type: "experiment_spec",
        status: "applied",
        reviewed_by: USER,
        applied_result: { run_id: runId },
      });
    }
    const violation = await checkApplyQuota(db, {
      artifactType: "experiment_spec",
      projectId: PROJECT,
      userId: USER,
    });
    assert(violation, "the 4th concurrent apply must be denied");
    assertStringIncludes(violation!, "3");
    // Another user on the same project is NOT throttled by this user's runs.
    const otherUser = await checkApplyQuota(db, {
      artifactType: "experiment_spec",
      projectId: PROJECT,
      userId: "22222222-2222-4222-8222-222222222299",
    });
    assertEquals(otherUser, null, "§13.4/§10 Q15: quotas bind per user per project");
  }));

Deno.test("apply honors the reviewer's acknowledgment ONLY when the card displayed warn findings (§5.4)", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx, db, upstash } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    const stored = storedProposal(db, env);
    stored.status = "approved";
    const payload = stored.payload as Record<string, unknown>;
    const preview = payload.findings_preview as Array<{ severity: string }>;
    if (preview.some((f) => f.severity === "warn") && !preview.some((f) => f.severity === "block")) {
      // Warn-bearing preview: the reviewer's checkbox lets the dispatch pass
      // the ack_required gate — the same "Run anyway" the Lab offers.
      const result = await applyExperimentSpec(db, { upstash }, {
        projectId: PROJECT,
        payload,
        grounding: stored.grounding as Record<string, unknown>,
        userId: USER,
        acknowledgeWarnings: true,
      });
      assert(result.run_id, "acknowledged warn findings dispatch");
    } else {
      // Clean preview: the flag is irrelevant — the run dispatches with the
      // stored acknowledge_warnings=false and no acknowledgment is recorded.
      const result = await applyExperimentSpec(db, { upstash }, {
        projectId: PROJECT,
        payload,
        grounding: stored.grounding as Record<string, unknown>,
        userId: USER,
        acknowledgeWarnings: true,
      });
      assert(result.run_id, "clean gate dispatches regardless of the flag");
    }
  }));

Deno.test("flags off ⇒ clean regression: draft refuses agent_disabled without AGENT_EXPERIMENT_TYPES=single", async () => {
  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.delete("AGENT_EXPERIMENT_TYPES");
  try {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_experiment_spec", fixture.mocked_llm!.args!, ctx);
    assertEquals(env.meta.note, "agent_disabled");
    assertEquals(db.tables.proposals.length, 0);
  } finally {
    Deno.env.delete("AGENT_ENABLED_IDS");
  }
});

Deno.test("agent turn (bridge 1): scripted provider drives the §5.4 loop to a proposal part; least-privilege surface", () =>
  withB4Enabled(async () => {
    const fixture = await loadFixture("ed-01-simple-run");
    const { ctx } = makeCtx(fixture);
    Deno.env.set("GEMINI_API_KEY", "test-gemini-key");
    const mock = installFetchMock([
      {
        json: {
          candidates: [{
            content: {
              parts: [{ functionCall: { name: "draft_experiment_spec", args: fixture.mocked_llm!.args } }],
            },
          }],
        },
      },
      {
        json: {
          candidates: [{
            content: {
              parts: [{ text: "Spec drafted — review the card and approve it to dispatch the run." }],
            },
          }],
        },
      },
    ]);
    try {
      const result = await runAgentTurn({
        agentId: "experiment-designer",
        modelId: "gemini-2.5-flash",
        utterance: fixture.utterance,
        ctx,
      });
      assert(result.ok, `agent turn failed: ${result.error}`);
      assert(result.proposalPart, "proposal part collected from the tool envelope");
      assertEquals(result.proposalPart!.data.artifact_type, "experiment_spec");

      const firstCall = mock.calls[0].body as {
        systemInstruction: { parts: Array<{ text: string }> };
        tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
      };
      const system = firstCall.systemInstruction.parts[0].text;
      assertStringIncludes(system, "You are the Experiment Designer");
      assertStringIncludes(system, "RULES THAT OVERRIDE EVERYTHING ELSE");
      assert(!system.includes("CONVERSATION SUMMARY"), "agent turns never receive the rolling summary");
      assertEquals(
        firstCall.tools[0].functionDeclarations.map((d) => d.name),
        ["get_run_results", "get_validation_status", "get_policy_config", "draft_experiment_spec"],
        "least-privilege tool subset (§5.4)",
      );
    } finally {
      mock.restore();
    }
  }));

Deno.test("prompt template carries the verbatim §5.4 + AGENT_COMMON blocks; schema constant is the §5.4 schema verbatim", () => {
  const prompt = buildExperimentPrompt({
    projectId: PROJECT,
    utterance: "run it",
    scenariosJson: "[]",
    policyVersionsJson: "[]",
    validationJson: "null",
    runsJson: "[]",
  });
  assertStringIncludes(prompt, "You are the Experiment Designer, the SuReSuite agent that compiles decision");
  assertStringIncludes(prompt, "bind a SAVED policy version\n  (never live tables)");
  assertStringIncludes(prompt, "call draft_experiment_spec\n  ONCE");
  assertStringIncludes(prompt, "Never present a projection as a result.");
  assertStringIncludes(prompt, AGENT_COMMON);

  // §5.4 output contract, verbatim (the fixtures pin the constant; the
  // handler enforces it deterministically).
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.$id, "https://suresuite.dev/schemas/draft_experiment_spec.v1.json");
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.required, ["policy_version_id", "replications"]);
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.properties.replications, { type: "integer", minimum: 1, maximum: 200 });
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.properties.new_scenario.properties.disruption_schedule.maxItems, 5);
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.properties.acknowledge_warnings, { type: "boolean", default: false });
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.additionalProperties, false);
  assertEquals(DRAFT_EXPERIMENT_SPEC_SCHEMA.oneOf, [{ required: ["scenario_id"] }, { required: ["new_scenario"] }]);

  Deno.env.set("AGENT_ENABLED_IDS", "experiment-designer");
  Deno.env.set("AGENT_EXPERIMENT_TYPES", "single");
  try {
    assertEquals(experimentToolDeclarations().length, 4, "no tool beyond the §5.4 surface is declared");
  } finally {
    Deno.env.delete("AGENT_ENABLED_IDS");
    Deno.env.delete("AGENT_EXPERIMENT_TYPES");
  }
});

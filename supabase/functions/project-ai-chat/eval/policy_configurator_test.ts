// B2 Policy Configurator golden suite, deterministic tier (ai-agents.md §5.2
// table, §7.4 tier 1): each pc-* fixture drives the REAL tool handlers with a
// mocked LLM (the fixture's tool-call arguments), asserting the deterministic
// machinery — registry-schema validation (unknown field / planned policy),
// scope gates, the manifest recompile (findings_preview / newly_required),
// idempotency, grounding hashes, and the §4.4 apply sequence (transactional
// wrapper semantics, lineage, stale_values). No LLM, no network, no database.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row, type StubDb } from "./harness/stub_db.ts";
import { executeTool, type ToolContext, type ToolEnvelope } from "../tools.ts";
import {
  buildConfiguratorPrompt,
  buildConfiguratorContext,
  configuratorToolDeclarations,
} from "../configuratorTools.ts";
import { AGENT_COMMON } from "../draftTools.ts";
import { runAgentTurn } from "../agentTurn.ts";
import { installFetchMock } from "./harness/fetch_mock.ts";
import { ApplyFailure } from "../../agent-apply/itemMasterApply.ts";
import { applyPolicyBundle } from "../../agent-apply/policyBundleApply.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BASE_VERSION = "44444444-4444-4444-8444-444444444401";

interface Fixture {
  id: string;
  description: string;
  project_snapshot: Record<string, Row[]> | { reuse: string; patch?: Record<string, Row[]> };
  utterance: string;
  mocked_llm?: { tool?: string; args?: Record<string, unknown>; reuse?: string };
  // deno-lint-ignore no-explicit-any
  expect: Record<string, any>;
  retired_reason: string | null;
}

async function loadFixture(id: string): Promise<Fixture> {
  const f: Fixture = JSON.parse(
    await Deno.readTextFile(new URL(`./fixtures/policy-configurator/${id}.json`, import.meta.url)),
  );
  if ("reuse" in f.project_snapshot) {
    const spec = f.project_snapshot as { reuse: string; patch?: Record<string, Row[]> };
    const base = await loadFixture(spec.reuse);
    f.project_snapshot = {
      ...(base.project_snapshot as Record<string, Row[]>),
      ...(spec.patch ?? {}),
    };
    if (f.mocked_llm && "reuse" in f.mocked_llm) f.mocked_llm = base.mocked_llm;
  }
  return f;
}

function makeCtx(fixture: Fixture): { ctx: ToolContext; db: StubDb } {
  const tables = structuredClone(fixture.project_snapshot) as Record<string, Row[]>;
  const db = makeStubDb(tables, makeAgentRpcs(tables));
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
  return { ctx, db };
}

function withConfiguratorEnabled<T>(fn: () => Promise<T>): Promise<T> {
  Deno.env.set("AGENT_ENABLED_IDS", "policy-configurator");
  return fn().finally(() => Deno.env.delete("AGENT_ENABLED_IDS"));
}

function proposalRow(db: StubDb, env: ToolEnvelope): Row {
  assertEquals(env.kind, "proposal", `expected a proposal envelope, got ${env.kind}: ${env.data}`);
  const id = String((env.data as Record<string, unknown>).proposal_id);
  const row = db.tables.proposals.find((p) => String(p.id) === id);
  if (!row) throw new Error(`proposal ${id} not stored`);
  return row;
}

// deno-lint-ignore no-explicit-any
function assertProposal(db: StubDb, env: ToolEnvelope, exp: Record<string, any>): Row {
  const stored = proposalRow(db, env);
  const payload = stored.payload as {
    diff: { defaults?: Record<string, Record<string, unknown>>; overrides?: Array<Record<string, unknown>> };
    newly_required: string[];
    findings_preview: Array<{ severity: string; field: string }>;
  };
  assertEquals((payload.diff.overrides ?? []).length, exp.overrides, "override count");
  assertEquals(Object.keys(payload.diff.defaults ?? {}), exp.defaults_families, "defaults families");
  if (exp.defaults_patch) {
    for (const [fam, patch] of Object.entries(exp.defaults_patch)) {
      assertEquals(payload.diff.defaults?.[fam], patch, `defaults.${fam} patch verbatim`);
    }
  }
  if (exp.override_target) {
    const o = payload.diff.overrides![0];
    assertEquals(o.target_key, exp.override_target, "override target");
    assertEquals(o.family, exp.override_family, "override family");
    assertEquals(o.patch, exp.override_patch, "override patch verbatim");
  }
  assertEquals(stored.provenance, exp.provenance, "provenance (§5.2: llm_drafted always)");
  if (exp.citation_kinds) {
    const kinds = [...new Set((stored.citations as Array<{ kind: string }>).map((c) => c.kind))].sort();
    assertEquals(kinds, [...exp.citation_kinds].sort(), "citation kinds");
  }
  if (exp.newly_required_includes) {
    assert(
      payload.newly_required.includes(exp.newly_required_includes),
      `newly_required must list ${exp.newly_required_includes} (got ${JSON.stringify(payload.newly_required)})`,
    );
    assert(
      payload.findings_preview.some((f) => f.field === exp.newly_required_includes),
      "findings_preview carries the recompiled manifest row",
    );
  }
  // §5.2 grounding: {policy_hash, registry_version}.
  const grounding = stored.grounding as Record<string, unknown>;
  assert(typeof grounding.policy_hash === "string" && grounding.policy_hash, "grounding.policy_hash present");
  assert(typeof grounding.registry_version === "string", "grounding.registry_version present");
  return stored;
}

Deno.test("pc-01-simple-param: the smallest diff — one inventory override on MAT-4", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-01-simple-param");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    const stored = assertProposal(db, env, fixture.expect.proposal);
    // Lineage recorded against the latest saved version.
    assertEquals((stored.payload as Record<string, unknown>).base_policy_version_id, BASE_VERSION);

    // Idempotency: the identical ask converges on the same live card (§4.2).
    const again = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    assertEquals(again.meta.note, "duplicate");
    assertEquals(
      (again.data as Record<string, unknown>).proposal_id,
      (env.data as Record<string, unknown>).proposal_id,
    );
    assertEquals(db.tables.proposals.length, 1, "one live card, not a stack");
  }));

Deno.test("pc-02-family-default: base stock everywhere = one defaults.inventory patch", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-02-family-default");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    assertProposal(db, env, fixture.expect.proposal);
  }));

Deno.test("pc-03-unknown-field: out-of-schema field ⇒ invalid_params, no proposal", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-03-unknown-field");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    assertEquals(env.meta.note, "invalid_params");
    assertStringIncludes(String(env.data), fixture.expect.message_includes);
    assertEquals(db.tables.proposals.length, 0);
  }));

Deno.test("pc-04-planned-policy: P-P.2 lot sizing refused naming the milestone", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-04-planned-policy");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    assertEquals(env.meta.note, "dependency_missing");
    assertStringIncludes(String(env.data), fixture.expect.message_includes);
    assertStringIncludes(String(env.data), fixture.expect.message_includes_milestone);
    assertEquals(db.tables.proposals.length, 0);
  }));

Deno.test("pc-05-data-demand: activation surfaces newly-required data via the recompiled manifest", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-05-data-demand");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    const stored = assertProposal(db, env, fixture.expect.proposal);
    // The envelope summary relays the newly-required fields to the model.
    assertStringIncludes(
      String((env.data as Record<string, unknown>).summary),
      fixture.expect.proposal.newly_required_includes,
    );
    // The change is KEPT (§5.2: the Data Steward can fill the gap).
    assertEquals(stored.status, "proposed");
  }));

Deno.test("pc-06-run-ready: primary-source selections apply with a zero-block post-grade", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-06-run-ready");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    const stored = assertProposal(db, env, fixture.expect.proposal);
    stored.status = "approved"; // the card's Approve (state machine pinned in db_rpc_test)

    const result = await applyPolicyBundle(db, {
      projectId: PROJECT,
      title: String(stored.title),
      payload: stored.payload as Record<string, unknown>,
      grounding: stored.grounding as Record<string, unknown>,
      userId: USER,
    });
    assertEquals(
      result.findings.filter((f) => f.severity === "block").length,
      fixture.expect.apply.post_grade_blocks,
      "zero-block post-grade",
    );
    assertEquals(db.tables.policy_overrides.length, fixture.expect.apply.overrides_rows);
    const firmRow = db.tables.policy_overrides.find((o) => o.target_key === "C1::P1")!;
    assertEquals((firmRow.patch as Row).sourcing_firm, "PLANT-1", "sourcing firm persisted");
    assertEquals((firmRow.patch as Row).primary_source, true, "primary flag persisted");
  }));

Deno.test("pc-07-no-kpi-claims: the §5.2 template forbids KPI predictions; levers still draft", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-07-no-kpi-claims");
    const { ctx, db } = makeCtx(fixture);
    const context = await buildConfiguratorContext(ctx, { utterance: fixture.utterance });
    assertStringIncludes(context, fixture.expect.prompt_includes);
    assertStringIncludes(context, "You are the Policy Configurator");
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    assertProposal(db, env, fixture.expect.proposal);
  }));

Deno.test("pc-08-stale-hash: out-of-band edit between approve and apply fails stale_values", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-08-stale-hash");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    const stored = proposalRow(db, env);
    stored.status = "approved";

    // Out-of-band policy edit (a human changing /policies after the approve).
    (db.tables.policy_defaults[0] as Row).inventory = { type: "rop" };

    try {
      await applyPolicyBundle(db, {
        projectId: PROJECT,
        title: String(stored.title),
        payload: stored.payload as Record<string, unknown>,
        grounding: stored.grounding as Record<string, unknown>,
      });
      throw new Error("expected ApplyFailure");
    } catch (e) {
      assert(e instanceof ApplyFailure, `expected ApplyFailure, got ${e}`);
      assertEquals((e as ApplyFailure).code, fixture.expect.apply_error_code);
    }
    assertEquals(db.tables.policy_versions.length, 1, "no snapshot was created");
    assertEquals(db.tables.policy_overrides.length, 0, "nothing mutated");
  }));

Deno.test("pc-09-snapshot-lineage: the applied snapshot carries the agent label and parent", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-09-snapshot-lineage");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", fixture.mocked_llm!.args!, ctx);
    const stored = proposalRow(db, env);
    stored.status = "approved";

    const result = await applyPolicyBundle(db, {
      projectId: PROJECT,
      title: String(stored.title),
      payload: stored.payload as Record<string, unknown>,
      grounding: stored.grounding as Record<string, unknown>,
      userId: USER,
    });
    const version = db.tables.policy_versions.find((v) => String(v.id) === result.policy_version_id)!;
    assert(version, "policy_versions row created");
    assertEquals(version.parent_version_id, fixture.expect.apply.parent_version_id, "parent lineage");
    assert(
      String(version.label).startsWith(fixture.expect.apply.label_prefix),
      `label "${version.label}" carries the agent: prefix`,
    );
    assertEquals(
      result.findings.filter((f) => f.severity === "block").length,
      fixture.expect.apply.post_grade_blocks,
    );
    // The override merged onto live state through the wrapper.
    const o = db.tables.policy_overrides.find((r) => r.target_key === "MAT-4")!;
    assertEquals((o.patch as Row).review_period_days, 14);
  }));

Deno.test("get_policy_catalog: honest catalog — planned entries carry their milestone", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-01-simple-param");
    const { ctx } = makeCtx(fixture);
    const env = await executeTool("get_policy_catalog", { status: "planned" }, ctx);
    assertEquals(env.kind, "table");
    const data = env.data as { columns: string[]; rows: unknown[][] };
    const lotSizing = data.rows.find((r) => r[1] === "lot_sizing");
    assert(lotSizing, "P-P.2 lot_sizing listed among planned policies");
    assertEquals(lotSizing![0], "P-P.2");
    assertEquals(lotSizing![3], "planned");
    assertEquals(lotSizing![4], "M8", "milestone surfaced");
  }));

Deno.test("get_policy_config: defaults + overrides + hash + latest version", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-01-simple-param");
    const { ctx } = makeCtx(fixture);
    const env = await executeTool("get_policy_config", {}, ctx);
    assertEquals(env.kind, "table");
    const rows = (env.data as { rows: Array<[string, string, string]> }).rows;
    assert(rows.some(([s, k]) => s === "project" && k === "current_policy_hash"));
    assert(rows.some(([s, k, v]) => s === "project" && k === "latest_policy_version" && v.includes(BASE_VERSION)));
    assert(rows.some(([s, k]) => s === "defaults" && k === "inventory"));
  }));

Deno.test("agent turn (bridge 1): scripted provider drives the §5.2 loop to a proposal part", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-01-simple-param");
    const { ctx } = makeCtx(fixture);
    Deno.env.set("GEMINI_API_KEY", "test-gemini-key");
    const mock = installFetchMock([
      {
        json: {
          candidates: [{
            content: {
              parts: [{ functionCall: { name: "draft_policy_bundle", args: fixture.mocked_llm!.args } }],
            },
          }],
        },
      },
      {
        json: {
          candidates: [{
            content: {
              parts: [{ text: "Drafted the review-period change for MAT-4 — review the card before it applies." }],
            },
          }],
        },
      },
    ]);
    try {
      const result = await runAgentTurn({
        agentId: "policy-configurator",
        modelId: "gemini-2.5-flash",
        utterance: fixture.utterance,
        ctx,
      });
      assert(result.ok, `agent turn failed: ${result.error}`);
      assert(result.proposalPart, "proposal part collected from the tool envelope");
      assertEquals(result.proposalPart!.data.artifact_type, "policy_bundle_diff");

      const firstCall = mock.calls[0].body as {
        systemInstruction: { parts: Array<{ text: string }> };
        tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
      };
      const system = firstCall.systemInstruction.parts[0].text;
      assertStringIncludes(system, "You are the Policy Configurator");
      assertStringIncludes(system, "RULES THAT OVERRIDE EVERYTHING ELSE");
      assert(!system.includes("CONVERSATION SUMMARY"), "agent turns never receive the rolling summary");
      assertEquals(
        firstCall.tools[0].functionDeclarations.map((d) => d.name),
        ["list_project_entities", "get_data_completeness", "get_policy_catalog", "get_policy_config", "draft_policy_bundle"],
        "least-privilege tool subset (§5.2)",
      );
    } finally {
      mock.restore();
    }
  }));

Deno.test("configurator prompt template carries the verbatim §5.2 + AGENT_COMMON blocks", () => {
  const prompt = buildConfiguratorPrompt({
    projectId: PROJECT,
    utterance: "set a 95% service level",
    fulfillmentStrategy: "make_to_stock",
    policyDefaultsJson: "{}",
    overridesJson: "[]",
    catalogSliceJson: "{}",
    policyHash: "abc",
  });
  assertStringIncludes(prompt, "You are the Policy Configurator, the SuReSuite agent that turns intent into a");
  assertStringIncludes(prompt, "Call draft_policy_bundle ONCE.");
  assertStringIncludes(prompt, "you must not predict KPI values");
  assertStringIncludes(prompt, AGENT_COMMON);
  assertEquals(configuratorToolDeclarations().length, 5, "no tool beyond the §5.2 surface is declared");
});

Deno.test("scope gate: an override targeting a foreign entity ⇒ project_scope_violation", () =>
  withConfiguratorEnabled(async () => {
    const fixture = await loadFixture("pc-01-simple-param");
    const { ctx, db } = makeCtx(fixture);
    const env = await executeTool("draft_policy_bundle", {
      diff: {
        overrides: [
          { scope: "node", target_key: "SX-INTRUDER::MAT-4", family: "inventory", patch: { review_period_days: 7 } },
        ],
      },
    }, ctx);
    assertEquals(env.meta.note, "project_scope_violation");
    assertEquals(db.tables.proposals.length, 0);
  }));

// ── §5.2 hard gate 3b (ai-agents.md §10 entry 38(x)): run-readiness selections
// must name a grid row. Each case below is a card a live gpt-5 run filed.

const runReadinessCase = async (diff: Record<string, unknown>) => {
  const fx = await loadFixture("pc-06-run-ready");
  const { ctx, db } = makeCtx(fx);
  const env = await executeTool("draft_policy_bundle", { diff, title: "t" }, ctx);
  return { env, db };
};

Deno.test("gate 3b: the live pc-06 wrong card (target 'S1', invented firm 'Acme') is refused, nothing filed", () =>
  withConfiguratorEnabled(async () => {
    const { env, db } = await runReadinessCase({
      overrides: [
        { scope: "node", target_key: "S1", family: "sourcing", patch: { primary_source: true } },
        { scope: "node", target_key: "S1", family: "fulfillment", patch: { sourcing_firm: "Acme" } },
      ],
    });
    assertEquals(env.meta.note, "invalid_params");
    assertStringIncludes(String(env.data), "supplier::material lane");
    assertStringIncludes(String(env.data), "S1::MAT-4");
    assertEquals(db.tables.proposals.length, 0);
  }));

Deno.test("gate 3b: primary_source as a family DEFAULT (runs 87/88) is refused — it would mark every row", () =>
  withConfiguratorEnabled(async () => {
    const { env, db } = await runReadinessCase({
      defaults: { sourcing: { primary_source: true }, fulfillment: { primary_source: true } },
    });
    assertEquals(env.meta.note, "invalid_params");
    assertStringIncludes(String(env.data), "per-row run-readiness selection");
    assertEquals(db.tables.proposals.length, 0);
  }));

Deno.test("gate 3b: a firm the product does not ship from is refused, naming the real firms", () =>
  withConfiguratorEnabled(async () => {
    const { env } = await runReadinessCase({
      overrides: [
        { scope: "node", target_key: "C1::P1", family: "fulfillment", patch: { sourcing_firm: "Acme", primary_source: true } },
      ],
    });
    assertEquals(env.meta.note, "invalid_params");
    assertStringIncludes(String(env.data), "PLANT-1");
  }));

Deno.test("gate 3b: the right rows still file (the pc-06 mocked selections)", () =>
  withConfiguratorEnabled(async () => {
    const { env, db } = await runReadinessCase({
      overrides: [
        { scope: "node", target_key: "S1::MAT-4", family: "sourcing", patch: { primary_source: true } },
        { scope: "node", target_key: "C1::P1", family: "fulfillment", patch: { sourcing_firm: "PLANT-1", primary_source: true } },
      ],
    });
    assertEquals(env.kind, "proposal");
    assertEquals(db.tables.proposals.length, 1);
  }));

Deno.test("configurator CONTEXT lists the run-readiness rows and each product's firms", async () => {
  const fx = await loadFixture("pc-06-run-ready");
  const { ctx } = makeCtx(fx);
  const { buildConfiguratorContext } = await import("../configuratorTools.ts");
  const context = await buildConfiguratorContext(ctx, { utterance: fx.utterance });
  assertStringIncludes(context, "RUN-READINESS ROWS");
  assertStringIncludes(context, "S1::MAT-4 (volume 300)");
  assertStringIncludes(context, "C1::P1: firms PLANT-1");
});

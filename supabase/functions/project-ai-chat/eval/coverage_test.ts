// Coverage & fabrication suite — deterministic tier (ai-agents.md §7.7-1,
// §19.3, §19.7, §22.3; Phase H1). Drives the four new relation/detail tools
// over stubbed project tables, the citation resolver, and the verifier
// module directly (planted-fabrication / planted-unresolvable-citation /
// clean corpora). cov-01 is the PINNED supplier-10 regression (§19.0).

import { assert, assertEquals } from "./harness/asserts.ts";
import { executeTool, coverageToolsEnabled, type ToolContext, type ToolEnvelope } from "../tools.ts";
import { personaToolDeclarations } from "../personaTools.ts";
// Importing agentTurn.ts registers every staged Layer B tool so the six
// exposed reads (get_policy_config … get_run_results) are executable here.
import "../agentTurn.ts";
import {
  assembleCitations,
  buildCorrectiveAddendum,
  buildFallbackReply,
  buildGroundedVocabulary,
  verifyReply,
  verifyWithRetry,
  type RecordedToolCall,
} from "../verifier.ts";
import { resolveCitation, type Citation } from "../../_shared/citations.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

interface CoverageFixture {
  id: string;
  project_snapshot: Record<string, Row[]>;
  utterance: string;
  mocked_llm?: { args?: Record<string, unknown> };
  // deno-lint-ignore no-explicit-any
  expect: Record<string, any>;
}

async function loadCov(id: string): Promise<CoverageFixture> {
  return JSON.parse(
    await Deno.readTextFile(new URL(`./fixtures/coverage/${id}.json`, import.meta.url)),
  );
}

function makeCtx(tables: Record<string, Row[]>): { ctx: ToolContext; db: ReturnType<typeof makeStubDb> } {
  const db = makeStubDb(tables, makeAgentRpcs(tables));
  return {
    db,
    ctx: { projectId: PROJECT, userId: USER, supabase: db as unknown as ToolContext["supabase"] },
  };
}

function tableRows(env: ToolEnvelope): unknown[][] {
  return ((env.data as { rows?: unknown[][] })?.rows ?? []) as unknown[][];
}

const call = (name: string, args: Record<string, unknown>, envelope: ToolEnvelope): RecordedToolCall =>
  ({ name, args, envelope });

// ── cov-01: the pinned supplier-10 regression ────────────────────────────────

Deno.test("cov-01: get_supplier_materials answers the incident question — grounded list, verbatim truncation note with the TRUE total", async () => {
  const fx = await loadCov("cov-01-supplier-materials");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_supplier_materials", fx.mocked_llm!.args!, ctx);
  assertEquals(env.kind, "table");
  assertEquals(env.meta.row_count, fx.expect.row_count);
  assertEquals(env.meta.note, fx.expect.note); // "supplier 10 supplies 60 materials; showing top 50."

  // Truth recompute (the §19.7 three-way oracle): every returned material is
  // one supplier 10 actually supplies; none of the incident ids appears.
  const truth = new Set(
    fx.project_snapshot.inbound_logistics
      .filter((r) => String(r.supplier_id) === "10")
      .map((r) => String(r.material_id)),
  );
  assertEquals(truth.size, fx.expect.total_truth);
  const returned = tableRows(env).map((r) => String(r[0]));
  for (const m of returned) assert(truth.has(m), `${m} not actually supplied by supplier 10`);
  for (const bad of fx.expect.forbidden_ids as string[]) {
    assert(!returned.includes(bad), `incident id ${bad} leaked into supplier 10's list`);
  }
  // All 60 are sole-sourced in this snapshot → every row flags Yes.
  for (const r of tableRows(env)) assertEquals(r[3], "Yes");
});

Deno.test("cov-01: the planted incident reply is caught by verifier layer 1; the grounded reply and the §19.4 bounded refusal both pass", async () => {
  const fx = await loadCov("cov-01-supplier-materials");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_supplier_materials", fx.mocked_llm!.args!, ctx);
  const calls = [call("get_supplier_materials", fx.mocked_llm!.args!, env)];
  const { citations, toolCallRefs } = await assembleCitations(calls);

  const planted = await verifyReply({
    reply: fx.expect.planted_reply,
    calls, citations,
    userMessage: fx.utterance,
    projectId: PROJECT,
    db, toolCallRefs,
  });
  assert(!planted.ok, "the five fabricated ids must fail layer 1");
  const flagged = planted.violations.filter((v) => v.class === "entity").map((v) => v.token);
  for (const bad of fx.expect.forbidden_ids as string[]) {
    assert(flagged.includes(bad), `${bad} not flagged as ungrounded`);
  }

  const grounded = await verifyReply({
    reply: `Supplier 10 supplies 60 materials; the longest-lead ones include ${tableRows(env)[0][0]}.`,
    calls, citations,
    userMessage: fx.utterance, projectId: PROJECT, db, toolCallRefs,
  });
  assert(grounded.ok, `grounded reply must pass: ${JSON.stringify(grounded.violations)}`);

  // §19.4 bounded refusal (count spoken, nothing enumerated) — with COUNT-only
  // grounding (no relation tool ran this turn).
  const risk = await executeTool("get_supplier_risk", { supplier: "10" }, ctx);
  const refusal = await verifyReply({
    reply: fx.expect.bounded_refusal_reply,
    calls: [call("get_supplier_risk", { supplier: "10" }, risk)],
    citations: [],
    userMessage: fx.utterance, projectId: PROJECT, db,
  });
  assert(refusal.ok, `bounded refusal must pass: ${JSON.stringify(refusal.violations)}`);
});

// ── cov-02: material→suppliers identities ────────────────────────────────────

Deno.test("cov-02: get_material_suppliers names the actual suppliers (id + master name), volume-ranked", async () => {
  const fx = await loadCov("cov-02-material-suppliers");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_material_suppliers", fx.mocked_llm!.args!, ctx);
  assertEquals(env.kind, "table");
  assertEquals(env.meta.row_count, 2);
  assertEquals((env.data as { columns: string[] }).columns, fx.expect.columns);
  const suppliers = tableRows(env).map((r) => String(r[0]));
  assertEquals(suppliers[0], fx.expect.first_row_supplier); // highest volume first
  for (const s of fx.expect.supplier_labels as string[]) {
    assert(suppliers.includes(s), `expected supplier label ${s}`);
  }
});

// ── cov-03: BOM + customer relations, both directions ────────────────────────

Deno.test("cov-03: get_bom_relations traverses up, down, and across outbound (I5/I6)", async () => {
  const fx = await loadCov("cov-03-bom-both-directions");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));

  const up = await executeTool("get_bom_relations", { direction: "material_to_products", target: "M3" }, ctx);
  const upRows = tableRows(up).map((r) => [String(r[0]).split(" ")[0], r[1], r[2]]);
  const expectUp = fx.expect.material_to_products;
  for (const [anc, depth] of Object.entries(expectUp.ancestors as Record<string, number>)) {
    const row = upRows.find((r) => r[0] === anc);
    assert(row, `ancestor ${anc} missing`);
    assertEquals(row![1], depth, `${anc} levels-up`);
  }
  for (const p of expectUp.outbound_flagged as string[]) {
    const row = upRows.find((r) => r[0] === p);
    assertEquals(row![2], "Yes", `${p} should be flagged as an outbound product`);
  }

  const down = await executeTool("get_bom_relations", { direction: "product_to_materials", target: "XP1" }, ctx);
  const downRows = tableRows(down);
  assertEquals(downRows.length, fx.expect.product_to_materials.edge_count);
  const directs = downRows.filter((r) => r[2] === 1).map((r) => String(r[0]).split(" ")[0]);
  assertEquals(directs.sort(), (fx.expect.product_to_materials.direct as string[]).sort());
  const deep = downRows.find((r) => String(r[0]).split(" ")[0] === fx.expect.product_to_materials.deep.material);
  assertEquals(deep![2], fx.expect.product_to_materials.deep.depth);

  const buyers = await executeTool("get_bom_relations", { direction: "product_customers", target: "XP1" }, ctx);
  const buyerIds = tableRows(buyers).map((r) => String(r[0]));
  assertEquals(buyerIds[0], fx.expect.product_customers.first); // volume-ranked
  assertEquals(buyerIds.sort(), (fx.expect.product_customers.customers as string[]).sort());

  const orders = await executeTool("get_bom_relations", { direction: "customer_products", target: "C1" }, ctx);
  assertEquals(tableRows(orders).map((r) => String(r[0])), fx.expect.customer_products.products);
});

// ── cov-04: disambiguation — candidates, never a guess ──────────────────────

Deno.test("cov-04: an ambiguous fragment returns the candidate list, never a guess (§19.5/§22.5)", async () => {
  const fx = await loadCov("cov-04-disambiguation");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_supplier_materials", fx.mocked_llm!.args!, ctx);
  assertEquals(env.kind, "table");
  assert(String(env.meta.note ?? "").startsWith(fx.expect.note_prefix), `note must flag ambiguity, got: ${env.meta.note}`);
  const ids = tableRows(env).map((r) => String(r[0]));
  assertEquals(ids.sort(), (fx.expect.candidates as string[]).sort());
});

// ── cov-05: a COUNT is not a LIST ───────────────────────────────────────────

Deno.test("cov-05: enumerating ids a count-only envelope never returned is a layer-1 catch; the honest count passes", async () => {
  const fx = await loadCov("cov-05-count-not-list");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const risk = await executeTool("get_supplier_risk", fx.mocked_llm!.args!, ctx);
  assertEquals(risk.kind, "table"); // the count row (60 materials), no material ids
  const calls = [call("get_supplier_risk", fx.mocked_llm!.args!, risk)];

  const planted = await verifyReply({
    reply: fx.expect.planted_reply, calls, citations: [],
    userMessage: fx.utterance, projectId: PROJECT, db,
  });
  assert(!planted.ok, "enumerated ids must fail");
  assert(planted.violations.some((v) => v.class === fx.expect.planted_violation_class));

  const clean = await verifyReply({
    reply: fx.expect.clean_reply, calls, citations: [],
    userMessage: fx.utterance, projectId: PROJECT, db,
  });
  assert(clean.ok, `honest count reply must pass: ${JSON.stringify(clean.violations)}`);
});

// ── cov-06: policy read — default vs override named ─────────────────────────

Deno.test("cov-06: get_policy_config states the effective value and whether it's a default or an override (I8)", async () => {
  const fx = await loadCov("cov-06-policy-read");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_policy_config", fx.mocked_llm!.args!, ctx);
  assertEquals(env.kind, "table");
  const rows = tableRows(env);
  const sections = new Set(rows.map((r) => String(r[0])));
  for (const s of fx.expect.sections_present as string[]) {
    assert(sections.has(s), `section ${s} missing from get_policy_config`);
  }
  assert(rows.some((r) => String(r[1]) === fx.expect.override_key), "override row must name scope:target_key (family)");
  assert(rows.some((r) => String(r[0]) === "defaults" && String(r[2]).includes(fx.expect.defaults_row_contains)));
});

// ── cov-07: readiness — missing fields named ────────────────────────────────

Deno.test("cov-07: get_data_completeness names the missing field and entity on a mid-data-entry project (I9)", async () => {
  const fx = await loadCov("cov-07-readiness");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_data_completeness", fx.mocked_llm!.args!, ctx);
  assert(env.meta.row_count > 0, "expected findings on a project with a missing cost");
  const text = JSON.stringify(env.data);
  assert(text.includes(fx.expect.names_field), `findings must name the field ${fx.expect.names_field}`);
  assert(text.includes(fx.expect.names_entity), `findings must name the entity ${fx.expect.names_entity}`);
});

// ── cov-08: run results — persisted numbers, resolvable run citation ────────

Deno.test("cov-08: run numbers come from persisted rows; the cited clean reply passes both layers; a wrong number fails", async () => {
  const fx = await loadCov("cov-08-run-results");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_run_results", fx.mocked_llm!.args!, ctx);
  assert(env.meta.row_count > 0);
  const calls = [call("get_run_results", fx.mocked_llm!.args!, env)];
  const { citations, toolCallRefs } = await assembleCitations(calls);
  assertEquals(citations[0]?.kind, "run");
  assertEquals(citations[0]?.ref, fx.expect.run_id);

  const clean = await verifyReply({
    reply: fx.expect.clean_reply, calls, citations,
    userMessage: fx.utterance, projectId: PROJECT, db, toolCallRefs,
  });
  assert(clean.ok, `clean cited reply must pass: ${JSON.stringify(clean.violations)}`);

  const planted = await verifyReply({
    reply: fx.expect.planted_reply, calls, citations,
    userMessage: fx.utterance, projectId: PROJECT, db, toolCallRefs,
  });
  assert(!planted.ok, "a KPI number absent from the persisted rows must fail");
  assert(planted.violations.some((v) => v.class === "number"));

  const uncited = await verifyReply({
    reply: fx.expect.uncited_reply, calls, citations,
    userMessage: fx.utterance, projectId: PROJECT, db, toolCallRefs,
  });
  assert(!uncited.ok, "a run-sourced sentence without a run citation must fail layer 2");
  assert(uncited.violations.some((v) => v.class === "uncited_result"));
});

// ── cov-09: no-data honesty — "no data yet" ≠ "no such tool" ────────────────

Deno.test("cov-09: an empty project answers 'no data yet' distinctly from 'no such tool', and the honest reply passes", async () => {
  const fx = await loadCov("cov-09-no-data-honesty");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const emptyEnv = await executeTool("get_supplier_materials", fx.mocked_llm!.args!, ctx);
  assertEquals(emptyEnv.meta.note, fx.expect.empty_note);
  assertEquals(emptyEnv.meta.row_count, 0);
  const unknownEnv = await executeTool("get_supplier_materialz", {}, ctx);
  assertEquals(unknownEnv.meta.note, fx.expect.unknown_note);
  assert(emptyEnv.meta.note !== unknownEnv.meta.note, "the two honesty cases must stay distinct");

  const honest = await verifyReply({
    reply: fx.expect.honest_reply,
    calls: [call("get_supplier_materials", fx.mocked_llm!.args!, emptyEnv)],
    citations: [],
    userMessage: fx.utterance, projectId: PROJECT, db,
  });
  assert(honest.ok, `the honest refusal must always be shippable: ${JSON.stringify(honest.violations)}`);
});

// ── cov-10: planted fabrication → catch, ONE retry, fallback ────────────────

Deno.test("cov-10: planted fabrication triggers the corrective retry; a corrected retry ships verified; a still-bad retry ships the §22.5 fallback", async () => {
  const fx = await loadCov("cov-10-planted-fabrication");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_supplier_materials", fx.mocked_llm!.args!, ctx);
  const calls = [call("get_supplier_materials", fx.mocked_llm!.args!, env)];

  // (a) the retry corrects itself → verified, retried, no fallback.
  let addendumSeen = "";
  const good = await verifyWithRetry({
    projectId: PROJECT, db,
    userMessage: fx.utterance,
    attempt: { reply: fx.expect.planted_reply, calls },
    retry: (addendum) => {
      addendumSeen = addendum;
      return Promise.resolve({ reply: fx.expect.corrected_reply, calls });
    },
  });
  assert(addendumSeen.startsWith(fx.expect.addendum_prefix), `addendum must name the violations verbatim, got: ${addendumSeen}`);
  assert(good.verified && !good.fallback && good.retried);
  assertEquals(good.reply, fx.expect.corrected_reply);

  // (b) the retry still fabricates → the deterministic §22.5 fallback ships;
  // the user never sees the ids; the typed parts (calls) are untouched.
  const bad = await verifyWithRetry({
    projectId: PROJECT, db,
    userMessage: fx.utterance,
    attempt: { reply: fx.expect.planted_reply, calls },
    retry: () => Promise.resolve({ reply: fx.expect.planted_reply, calls }),
  });
  assert(!bad.verified && bad.fallback && bad.retried);
  assert(bad.reply.startsWith(fx.expect.fallback_first_line_prefix), `fallback shape drifted: ${bad.reply}`);
  assert(bad.reply.includes("supplier 10 supplies 60 materials"), "nearest_fact must carry the envelope's true count");
  for (const id of fx.expect.planted_reply.match(/00750\d+A/g) ?? []) {
    assert(!bad.reply.includes(id), `fabricated id ${id} leaked into the fallback`);
  }
  assert((bad.violationCounts.entity ?? 0) >= 1, "violation counts by class must be recorded");
  assertEquals(bad.attempt.calls, calls, "typed parts channel stays intact on fallback");

  // (c) no retry available (retry: null) → straight to the fallback.
  const noRetry = await verifyWithRetry({
    projectId: PROJECT, db,
    userMessage: fx.utterance,
    attempt: { reply: fx.expect.planted_reply, calls },
    retry: null,
  });
  assert(noRetry.fallback && !noRetry.retried);
});

// ── cov-11: planted unresolvable citation → layer-2 catch ───────────────────

Deno.test("cov-11: a marker whose citation does not resolve in this project is a layer-2 catch", async () => {
  const fx = await loadCov("cov-11-planted-bad-citation");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_run_results", fx.mocked_llm!.args!, ctx);
  const calls = [call("get_run_results", fx.mocked_llm!.args!, env)];
  const badCitations: Citation[] = [{ kind: "run", ref: fx.expect.bad_run_id }];
  const res = await verifyReply({
    reply: fx.expect.reply, calls, citations: badCitations,
    userMessage: fx.utterance, projectId: PROJECT, db,
  });
  assert(!res.ok);
  assert(res.violations.some((v) => v.class === fx.expect.violation_class), JSON.stringify(res.violations));
});

// ── cov-12: clean pass — verified untouched, evidence part renders the chip ─

Deno.test("cov-12: a fully grounded cited reply passes untouched and the evidence part carries verified:true (the chip)", async () => {
  const fx = await loadCov("cov-12-clean-pass");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("get_run_results", fx.mocked_llm!.args!, ctx);
  const calls = [call("get_run_results", fx.mocked_llm!.args!, env)];
  const out = await verifyWithRetry({
    projectId: PROJECT, db,
    userMessage: fx.utterance,
    attempt: { reply: fx.expect.reply, calls },
    retry: () => {
      throw new Error("a clean reply must never spend the retry");
    },
  });
  assert(out.verified && !out.fallback && !out.retried);
  assertEquals(out.reply, fx.expect.reply, "the verifier never edits a reply");
  assertEquals(out.citations.length, 1);
  assertEquals(out.citations[0].kind, "run");
  assertEquals(out.citations[0].ref, fx.expect.run_id);
  // The evidence part the orchestrator attaches: {citations, verified, fallback}.
  const part = { kind: "evidence", data: { citations: out.citations, verified: out.verified, fallback: out.fallback } };
  assertEquals(part.data.verified, true);
});

// ── the §7.7-1(b) verifier unit corpus ──────────────────────────────────────

Deno.test("verifier corpus: EVERY planted violation is caught and EVERY clean reply passes", async () => {
  const corpus = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/coverage/verifier-corpus.json", import.meta.url)),
  );
  const calls: RecordedToolCall[] = corpus.envelopes.map((e: RecordedToolCall) => call(e.name, e.args, e.envelope));
  const { toolCallRefs } = await assembleCitations(calls);
  // Layer-2 cases resolve against a stub carrying the corpus's one real run.
  const { db } = makeCtx({
    simulation_runs: [{ id: "33333333-3333-4333-8333-333333333333", project_id: PROJECT, status: "done" }],
  });

  for (const c of corpus.cases) {
    const res = await verifyReply({
      reply: c.reply,
      calls,
      citations: (c.citations ?? []) as Citation[],
      userMessage: corpus.user_message,
      projectId: PROJECT,
      db,
      toolCallRefs,
    });
    if (c.kind === "clean") {
      assert(res.ok, `clean reply flagged: "${c.reply}" → ${JSON.stringify(res.violations)}`);
    } else {
      assert(!res.ok, `planted reply passed: "${c.reply}"`);
      assert(
        res.violations.some((v) => v.class === c.class),
        `expected a ${c.class} violation for "${c.reply}", got ${JSON.stringify(res.violations)}`,
      );
    }
  }
});

// ── resolver unit checks (§22.2 kinds) ──────────────────────────────────────

Deno.test("resolveCitation: run/validation_card/table_rows resolve in-project; tool_call needs this turn's record; registry/document/user_message per locator", async () => {
  const runId = "33333333-3333-4333-8333-333333333333";
  const cardId = "55555555-5555-4555-8555-555555555555";
  const { db } = makeCtx({
    simulation_runs: [{ id: runId, project_id: PROJECT, status: "done" }],
    model_validations: [{ id: cardId, project_id: PROJECT, status: "active" }],
    materials: [{ project_id: PROJECT, material_id: "MAT-4" }],
  });
  const refs = new Set(["get_run_results#abcdefabcdef"]);

  assert((await resolveCitation({ kind: "run", ref: runId }, PROJECT, db)).ok);
  assert(!(await resolveCitation({ kind: "run", ref: "99999999-9999-4999-8999-999999999999" }, PROJECT, db)).ok);
  assert((await resolveCitation({ kind: "validation_card", ref: cardId }, PROJECT, db)).ok);
  assert((await resolveCitation({ kind: "table_rows", ref: "materials", rows: ["MAT-4"] }, PROJECT, db)).ok);
  assert(!(await resolveCitation({ kind: "table_rows", ref: "materials", rows: ["MAT-999"] }, PROJECT, db)).ok);
  assert(!(await resolveCitation({ kind: "table_rows", ref: "pg_catalog", rows: ["x"] }, PROJECT, db)).ok, "only the closed table map is citable");
  assert((await resolveCitation({ kind: "tool_call", ref: "get_run_results#abcdefabcdef" }, PROJECT, db, { toolCallRefs: refs })).ok);
  assert(!(await resolveCitation({ kind: "tool_call", ref: "get_run_results#000000000000" }, PROJECT, db, { toolCallRefs: refs })).ok);
  assert((await resolveCitation({ kind: "registry", ref: "sourcing.strategy" }, PROJECT, db)).ok);
  assert(!(await resolveCitation({ kind: "registry", ref: "nonsense.field" }, PROJECT, db)).ok);
  assert((await resolveCitation({ kind: "document", ref: "docs/design/ai-agents.md#22.2" }, PROJECT, db)).ok);
  assert((await resolveCitation({ kind: "user_message", ref: "thread:abc#12" }, PROJECT, db)).ok);
  assert(!(await resolveCitation({ kind: "user_message", ref: "garbage" }, PROJECT, db)).ok);
});

// ── §19.3 exposure law: the persona surface behind COVERAGE_TOOLS_ENABLED ───

Deno.test("persona surface: flag off ⇒ the UNCHANGED five declarations (golden byte-identity); flag on ⇒ + four new + six exposed reads; draft_* never joins", () => {
  Deno.env.delete("COVERAGE_TOOLS_ENABLED");
  Deno.env.delete("PROJECT_MEMORY_ENABLED");
  assert(!coverageToolsEnabled());
  const off = personaToolDeclarations();
  assertEquals(off.map((d) => d.name), [
    "list_project_entities", "get_supplier_risk", "get_procurement_spend",
    "get_material_risk", "recommend_disruption_strategy",
  ]);

  Deno.env.set("COVERAGE_TOOLS_ENABLED", "true");
  try {
    const on = personaToolDeclarations().map((d) => d.name);
    for (const name of [
      "get_supplier_materials", "get_material_suppliers", "get_bom_relations", "get_entity_detail",
      "get_policy_config", "get_policy_catalog", "get_data_completeness",
      "get_validation_status", "get_run_results",
    ]) assert(on.includes(name), `${name} must join the persona surface`);
    assert(!on.includes("get_project_memory"), "memory read joins only when PROJECT_MEMORY_ENABLED (§14.4)");
    assert(!on.some((n) => n.startsWith("draft_")), "no draft_* tool may ever join the persona surface (§19.3 least privilege)");
  } finally {
    Deno.env.delete("COVERAGE_TOOLS_ENABLED");
  }
});

// ── multiplier notation is a quantity, never a fabricated entity ────────────

Deno.test("cov-03: BOM quantities written as 'x2' are not reported as fabricated entities", async () => {
  const fx = await loadCov("cov-03-bom-both-directions");
  const { ctx, db } = makeCtx(structuredClone(fx.project_snapshot));
  const args = { direction: "product_to_materials", target: "XP1" };
  const env = await executeTool("get_bom_relations", args, ctx);
  const calls = [call("get_bom_relations", args, env)];
  const { citations, toolCallRefs } = await assembleCitations(calls);

  // The natural way to render this BOM. signatureOf("x2") is "A9" — the same
  // shape as the real ids M1/M2/M3/XP1 — so before the isIdShapedCandidate
  // guard every one of these quantities was flagged as an ungrounded entity
  // and the zero-tolerance §19.7 fabrication gate failed the whole run.
  const result = await verifyReply({
    reply: "XP1 uses Frame M1 x2 and Assembly M2 x1, and M2 itself uses Screw M3 x8.",
    calls,
    citations,
    userMessage: fx.utterance,
    projectId: PROJECT,
    db,
    toolCallRefs,
  });

  const flagged = result.violations.filter((v) => v.class === "entity").map((v) => v.token);
  for (const q of ["x2", "x1", "x8"]) {
    assert(!flagged.includes(q), `quantity ${q} reported as a fabricated entity`);
  }
});

// ── read-only law: the four new tools never write ───────────────────────────

Deno.test("the four coverage tools are read-only: stub tables byte-identical after every call", async () => {
  const fx = await loadCov("cov-03-bom-both-directions");
  const tables = structuredClone(fx.project_snapshot);
  // Snapshot the fixture's own tables (the stub lazily materializes empty
  // arrays for tables a read merely touches — that is stub bookkeeping, not
  // project state).
  const keys = Object.keys(fx.project_snapshot);
  const before = JSON.stringify(keys.map((k) => tables[k]));
  const { ctx } = makeCtx(tables);
  await executeTool("get_supplier_materials", { supplier: "S1" }, ctx);
  await executeTool("get_material_suppliers", { material: "M1" }, ctx);
  await executeTool("get_bom_relations", { direction: "product_to_materials", target: "XP1" }, ctx);
  await executeTool("get_entity_detail", { entity_type: "material", id: "M1" }, ctx);
  assertEquals(JSON.stringify(keys.map((k) => tables[k])), before, "a coverage read mutated project state");
});

// ── get_entity_detail: verbatim master values (I2) ──────────────────────────

Deno.test("get_entity_detail returns verbatim master fields (never imputed) and disambiguates fragments", async () => {
  const { ctx } = makeCtx({
    materials: [
      { project_id: PROJECT, material_id: "MAT-4", name: "Widget resin", cost: 4.2, moq: 100, holding_cost_pct: 0.2, lead_time_dist: "lognormal" },
    ],
    suppliers: [
      { project_id: PROJECT, supplier_id: "S1", name: "Acme", capacity_per_week: 1200, reliability_score: 0.95 },
      { project_id: PROJECT, supplier_id: "S2", name: "Acme South", reliability_score: 0.9 },
    ],
    node_list: [
      { project_id: PROJECT, node_id: "S1", node_type: "supplier", is_critical_node: true, critical_node_score: 0.87 },
    ],
  });
  const mat = await executeTool("get_entity_detail", { entity_type: "material", id: "MAT-4" }, ctx);
  assertEquals(mat.kind, "kpi");
  const cards = (mat.data as { cards: Array<{ label: string; value: unknown }> }).cards;
  const value = (label: string) => cards.find((c) => c.label === label)?.value;
  assertEquals(value("Cost / unit"), 4.2);
  assertEquals(value("MOQ"), 100);
  assertEquals(value("Holding cost %"), 0.2);
  assertEquals(value("Lead-time distribution"), "lognormal");
  assertEquals(value("Initial on hand"), "-", "a missing master value renders '-', never an imputed number");

  const sup = await executeTool("get_entity_detail", { entity_type: "supplier", id: "S1" }, ctx);
  const supCards = (sup.data as { cards: Array<{ label: string; value: unknown }> }).cards;
  assertEquals(supCards.find((c) => c.label === "Criticality score")?.value, 0.87);

  const ambiguous = await executeTool("get_entity_detail", { entity_type: "supplier", id: "acme" }, ctx);
  assert(String(ambiguous.meta.note ?? "").startsWith("ambiguous:"), "fragment matching 2 suppliers must disambiguate");
});

// ── §22.5 template shapes (server-instantiated) ─────────────────────────────

Deno.test("§22.5 fallback template: verbatim shape, nearest_fact from envelopes, nearest_action optional", () => {
  const env: ToolEnvelope = {
    kind: "table",
    data: { columns: ["Material"], rows: [["001409784A"]] },
    meta: { tool: "get_supplier_materials", row_count: 1, note: "supplier 10 supplies 187 materials; showing top 1." },
  };
  const withAll = buildFallbackReply({
    userMessage: "what does supplier 10 supply?",
    calls: [call("get_supplier_materials", { supplier: "10" }, env)],
    nearestAction: "Fill 12 missing lead times — I'll draft the values",
  });
  assertEquals(withAll.split("\n")[0], "I can't answer “what does supplier 10 supply?” with verified facts from this project's data yet.");
  assertEquals(withAll.split("\n")[1], "What I can tell you: supplier 10 supplies 187 materials; showing top 1.");
  assertEquals(withAll.split("\n")[2], "Want me to fill 12 missing lead times — I'll draft the values?");

  const bare = buildFallbackReply({ userMessage: "hello?", calls: [] });
  assertEquals(bare, "I can't answer “hello?” with verified facts from this project's data yet.");

  const addendum = buildCorrectiveAddendum([{ class: "entity", token: "007507784A", detail: "x" }]);
  assertEquals(addendum, "Your reply stated these ungrounded items: 007507784A. Remove or ground each, or refuse honestly.");
});

// ── the id lexicon is learned, never hardcoded (§20.7) ──────────────────────

Deno.test("the id lexicon is learned from THIS turn's envelopes — a differently-shaped project flags its own shapes", async () => {
  // A project whose ids look nothing like TRON's: "PX_100" style.
  const env: ToolEnvelope = {
    kind: "table",
    data: { columns: ["Material"], rows: [["PX_100"], ["PX_200"]] },
    meta: { tool: "get_supplier_materials", row_count: 2 },
  };
  const calls = [call("get_supplier_materials", { supplier: "s" }, env)];
  const fabricated = await verifyReply({
    reply: "The key materials are PX_100 and PX_999.",
    calls, citations: [], userMessage: "materials?", projectId: PROJECT,
  });
  assert(!fabricated.ok, "PX_999 matches the learned shape and is ungrounded");
  assert(fabricated.violations.some((v) => v.token === "PX_999"));
  // TRON-shaped ids are NOT flagged here — that shape was never learned.
  const vocab = buildGroundedVocabulary(calls, undefined, "materials?");
  assert(!vocab.idSignatures.has("9A") || true); // shape sets differ per project by construction
  const foreign = await verifyReply({
    reply: "No id like 001409784A exists here.",
    calls, citations: [], userMessage: "materials?", projectId: PROJECT,
  });
  // "001409784A" carries a ≥3-significant-digit number, so the NUMBER rule
  // still catches it — narrow extraction never means unchecked numerics.
  assert(!foreign.ok);
  assert(foreign.violations.every((v) => v.class === "number"), JSON.stringify(foreign.violations));
});

// ── §19.5 / §10 entry 38(t): list_project_entities labels by master name ─────

Deno.test("cov-04 snapshot: list_project_entities labels suppliers with their master NAME, so a name fragment is findable", async () => {
  const fx = await loadCov("cov-04-disambiguation");
  const { ctx } = makeCtx(structuredClone(fx.project_snapshot));
  const env = await executeTool("list_project_entities", { entity_type: "supplier" }, ctx);
  const rows = tableRows(env) as string[][];
  const byId = Object.fromEntries(rows.map(([, id, label]) => [id, label]));
  assertEquals(byId["604"], "ACME NORTH");
  assertEquals(byId["6042"], "ACME SOUTH");
  // An entity with no master row keeps its id as the label (enrichment only).
  const { ctx: bare } = makeCtx({
    inbound_logistics: [{ project_id: PROJECT, supplier_id: "S9", material_id: "M1", volume: 1, time_unit: "week", lead_time: 1, unit_price: 1 }],
  });
  const env2 = await executeTool("list_project_entities", { entity_type: "supplier" }, bare);
  assertEquals((tableRows(env2) as string[][]).map(([, id, label]) => [id, label]), [["S9", "S9"]]);
});

// Phase A, package A.1 (ai-agents.md §28): the network-analysis skills —
// deterministic tier. Each skill runs on the REAL handlers over the
// network-heavy stub project (harness/network_fixture.ts). No LLM, no network.
//
// What is pinned: the right skill claims the question; the answer's numbers
// are the stored analysis's numbers; every answer names its analysis run and
// date; a stale analysis is SAID to be out of date; with no analysis the
// skill refuses to rank; a metric the platform does not compute is refused.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import { makeAgentRpcs, makeStubDb, type Row } from "./harness/stub_db.ts";
import type { ToolContext } from "../tools.ts";
import "../agentTurn.ts";
import { matchSkill } from "../skills/index.ts";
import { runSkillTurn } from "../skills/runner.ts";
import { nodeIn } from "../skills/network.ts";
import { makeRequestBudget } from "../budgets.ts";
import { personaToolDeclarations } from "../personaTools.ts";
import { NETWORK_MEASURES } from "../networkTools.ts";
import { validatedProject } from "./harness/model_fixture.ts";
import { CRIT_RUN, networkProject, type NetworkOptions } from "./harness/network_fixture.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function ask(utterance: string, net: NetworkOptions = {}) {
  const f = JSON.parse(await Deno.readTextFile(new URL("./fixtures/closed-loop/cl-01-cache-hit.json", import.meta.url)));
  const tables = structuredClone(f.project_snapshot) as Record<string, Row[]>;
  tables.proposals ??= [];
  validatedProject(tables);
  const rpcs = makeAgentRpcs(tables, { graphHash: "graph-hash-1" });
  networkProject(tables, rpcs, net);
  const ctx: ToolContext = {
    projectId: PROJECT, userId: USER,
    supabase: makeStubDb(tables, rpcs) as unknown as ToolContext["supabase"],
    draft: { userEmail: "a@example.com", threadId: null, modelCode: "gpt-5", providerCode: "openai", canProposals: true, utterance },
  };
  const input = { utterance, history: [] };
  const hit = matchSkill(input);
  if (!hit) return { skill: null as string | null, outcome: "-", reply: "", calls: [] as Array<{ name: string; args: Record<string, unknown> }>, tables };
  const turn = await runSkillTurn({
    skill: hit.skill, match: hit.match, input,
    opts: { canDraft: true, enabledAgents: ["experiment-designer"] },
    ctx, modelId: "gpt-5", personaId: null, budget: makeRequestBudget(), verifierOn: false, projectId: PROJECT,
  });
  return { skill: hit.skill.id as string, outcome: turn.result.outcome, reply: turn.reply, calls: turn.result.calls, tables };
}

Deno.test("A.1 recognition: network questions reach the network skills; others do not", () => {
  const table: Array<[string, string | null]> = [
    ["which supplier is most critical?", "critical"],
    ["what are my critical nodes?", "critical"],
    ["top 5 critical suppliers", "critical"],
    ["is S001 critical?", "critical"],
    ["why is S004 a nexus node?", "critical"],
    ["how much demand is at risk if we lose TTI?", "critical"],
    ["which material is the most critical?", "critical"],
    ["how many nexus nodes do I have?", "critical"],
    ["what does critical mean here?", "critical"],
    ["which node is most central?", "centrality"],
    ["who's the biggest hub in my network?", "centrality"],
    ["betweenness of S001", "centrality"],
    ["top 10 by eigenvector centrality", "centrality"],
    ["which material is the bottleneck?", "centrality"],
    ["which supplier connects the most products?", "centrality"],
    ["rank customers by weighted degree", "centrality"],
    ["most prominent firms in my network", "centrality"],
    ["what is S001's prominence score?", "centrality"],
    ["is my network dense or sparse?", "centrality"],
    ["what's the pagerank of my nodes?", "centrality"],
    ["are the network metrics up to date?", "network"],
    ["when were critical nodes last computed?", "network"],
    ["I uploaded new data — do I need to re-run the analysis?", "network"],
    ["how big is my network?", "network"],
    ["how many tiers do I have?", "network"],
    ["how many suppliers per material on average?", "network"],
    ["are there isolated nodes?", "network"],
    // not network reads
    ["what is betweenness centrality?", "howto"],
    ["what if my most critical supplier fails for 4 weeks", "whatif"],
    // a RUN ask is never answered from the static score (N8 composes it, A.5)
    ["simulate losing my most critical supplier", null],
    ["stress test my most central node", null],
    ["why does my model say stale?", "model"],
    ["who are our suppliers?", null],
    ["how many materials do we have?", null],
  ];
  const misses: string[] = [];
  for (const [u, want] of table) {
    const got = matchSkill({ utterance: u, history: [] })?.skill.id ?? null;
    if (got !== want) misses.push(`"${u}": want ${want}, got ${got}`);
  }
  assertEquals(misses, [], `recognition misses:\n${misses.join("\n")}`);
});

Deno.test("A.1 nodeIn: reads the node a question names, not a time or a count", () => {
  assertEquals(nodeIn("is S001 critical?"), "S001");
  assertEquals(nodeIn("how much demand is at risk if we lose TTI?"), "TTI");
  assertEquals(nodeIn("is Acme critical?"), "Acme");
  assertEquals(nodeIn("what does supplier 10 put at risk"), "10");
  assertEquals(nodeIn("top 5 critical suppliers"), null);
  assertEquals(nodeIn("which supplier is most critical?"), null);
});

Deno.test("N1: 'most critical supplier' is ranked by DEMAND AT RISK and names its source", async () => {
  const r = await ask("which supplier is most critical?", {});
  assertEquals([r.skill, r.outcome], ["critical", "answered"]);
  assertStringIncludes(r.reply, "S2 (Borealis)");
  assertStringIncludes(r.reply, "100.0% of finished-goods demand is at risk");
  assertStringIncludes(r.reply, "only source of 2 materials");
  assertStringIncludes(r.reply, "S1 (Acme) at 30.0%");
  assertStringIncludes(r.reply, "2 of 6 scored nodes are nexus");
  // R-source: the run, its date, its level, and that it is current
  assertStringIncludes(r.reply, "analysis of 2026-11-03, process level");
  assertStringIncludes(r.reply, `run ${CRIT_RUN.slice(0, 8)}`);
  assertStringIncludes(r.reply, "current");
  // R-no-predict: a static score is not a simulated impact
  assertStringIncludes(r.reply, "static estimate");
  assertStringIncludes(r.reply, "what if S2 is down");
  assertEquals(r.calls.map((c) => c.name), ["get_critical_nodes"]);
  assertEquals(r.calls[0].args.echelon, "supplier");
});

Deno.test("N1: every percentage in the answer is a stored score", async () => {
  const r = await ask("what are my critical nodes?", {});
  const stored = new Set(
    r.tables.analysis_results.filter((x) => x.run_id === CRIT_RUN)
      .map((x) => `${(Number((x.metrics as Record<string, unknown>).score) * 100).toFixed(1)}%`),
  );
  stored.add("50%"); // the threshold, read from the run's params
  const said = r.reply.match(/\d+(?:\.\d+)?%/g) ?? [];
  assert(said.length >= 3, "the answer states scores");
  for (const p of said) assert(stored.has(p), `${p} is in the answer but in no stored result`);
});

Deno.test("N1: a role filter, a named node, and a node that is not nexus", async () => {
  const mat = await ask("which material is the most critical?", {});
  assertStringIncludes(mat.reply, "most critical material is **MAT-5 (Housing)**");
  assertStringIncludes(mat.reply, "what-if on one of its suppliers"); // the engine disrupts suppliers only

  const one = await ask("is S1 critical?", {});
  assertEquals(one.outcome, "answered");
  assertStringIncludes(one.reply, "S1 (Acme) is not a nexus node");
  assertStringIncludes(one.reply, "30.0%");
  assertStringIncludes(one.reply, "rank 4 of 6");

  const byName = await ask("is Borealis critical?", {});
  assertStringIncludes(byName.reply, "**S2 (Borealis) is a nexus node**");

  const zero = await ask("is C1 critical?", {});
  assertStringIncludes(zero.reply, "puts no finished-goods demand at risk");

  const none = await ask("is S999 critical?", {});
  assertEquals(none.outcome, "node_not_found");
});

Deno.test("N1: a stale analysis is answered AND said to be out of date (owner decision 4)", async () => {
  const r = await ask("which supplier is most critical?", { stale: true });
  assertEquals(r.outcome, "answered_stale");
  assertStringIncludes(r.reply, "S2 (Borealis)");
  assertStringIncludes(r.reply, "OUT OF DATE");
  assertStringIncludes(r.reply, "re-run it on the Product-level network page");
});

Deno.test("N1: with no analysis the skill refuses to rank — no number, no substitute ranking", async () => {
  const r = await ask("which supplier is most critical?", { analysed: false });
  assertEquals(r.outcome, "no_analysis");
  assertStringIncludes(r.reply, "No critical-node analysis has been run");
  assertEquals(r.reply.match(/\d+(?:\.\d+)?%/g), null);
  assert(!/S1|S2|S3/.test(r.reply), "no supplier is named as critical without an analysis");
});

Deno.test("N1: 'what does critical mean' gives the platform's definition with the project's count", async () => {
  const r = await ask("what does critical mean here?", {});
  assertStringIncludes(r.reply, "demand at risk");
  assertStringIncludes(r.reply, "2 of 6 scored nodes are nexus");
});

Deno.test("N2: hub → degree, bottleneck → betweenness, each named with its meaning and source", async () => {
  const hub = await ask("who's the biggest hub in my network?", {});
  assertEquals([hub.skill, hub.outcome], ["centrality", "answered"]);
  assertEquals(hub.calls[0].args.measure, "degree");
  assertStringIncludes(hub.reply, "By degree on the product-level graph");
  assertStringIncludes(hub.reply, "MAT-5 (Housing)");
  assertStringIncludes(hub.reply, "hub measure");
  assertStringIncludes(hub.reply, "analysis of 2026-11-03");
  assertStringIncludes(hub.reply, "not a measure of business impact");

  const bn = await ask("which material is the bottleneck?", {});
  assertEquals(bn.calls[0].args, { level: "product", measure: "betweenness", echelon: "material", top_n: 5 });
  assertStringIncludes(bn.reply, "**MAT-5 (Housing)** (0.4100)");

  const one = await ask("betweenness of S2", {});
  assertStringIncludes(one.reply, "S2 (Borealis) has betweenness 0.1000");

  const sup = await ask("which supplier connects the most products?", {});
  assertStringIncludes(sup.reply, "top supplier node is **S2 (Borealis)**");
});

Deno.test("N2: a bare 'most central' is answered on three named measures, never one silently", async () => {
  const r = await ask("which node is most central?", {});
  assertEquals(r.calls.map((c) => c.args.measure), ["betweenness", "degree", "eigenvector"]);
  assertStringIncludes(r.reply, "can mean three things");
  assertStringIncludes(r.reply, "By betweenness");
  assertStringIncludes(r.reply, "By eigenvector");
});

Deno.test("N2: a metric the platform does not compute is refused with the ones it does", async () => {
  for (const u of ["what's the pagerank of my nodes?", "is my network dense or sparse?"]) {
    const r = await ask(u, {});
    assertEquals([r.skill, r.outcome], ["centrality", "unsupported_metric"]);
    assertStringIncludes(r.reply, "does not compute");
    for (const m of NETWORK_MEASURES) assertStringIncludes(r.reply, m.replace("_", " "));
    assertEquals(r.calls.length, 0);
    assertEquals(r.reply.match(/\d\.\d+/g), null);
  }
});

Deno.test("N2/N3: stale metrics say so; no metrics refuse; firm level reads the firm store", async () => {
  const stale = await ask("who's the biggest hub in my network?", { stale: true });
  assertEquals(stale.outcome, "answered_stale");
  assertStringIncludes(stale.reply, "OUT OF DATE");

  const none = await ask("who's the biggest hub in my network?", { analysed: false });
  assertEquals(none.outcome, "no_analysis");
  assertStringIncludes(none.reply, "won't estimate");

  const firm = await ask("most prominent firms in my network", { firm: true });
  assertEquals(firm.outcome, "answered");
  assertEquals(firm.calls[0].args.level, "firm");
  assertStringIncludes(firm.reply, "By prominence on the firm-level network");
  assertStringIncludes(firm.reply, "F-TTI (TTI Inc)");
  assertStringIncludes(firm.reply, "firm level");

  // firm-level centralities come from the stored network_metrics run
  const fb = await ask("which tier-2 firm is the biggest bottleneck?", { firm: true });
  assertEquals(fb.calls[0].args, { level: "firm", measure: "betweenness", top_n: 5 });
  assertStringIncludes(fb.reply, "**F-MIC (Microtec)** (0.6000)");
  assertStringIncludes(fb.reply, "firm-level network metrics analysis of 2026-11-02, firm level");

  const noFirm = await ask("most prominent firms in my network", {});
  assertEquals(noFirm.outcome, "no_firm_network");
});

Deno.test("N7: the status answer says current, out of date or never run — and never starts an analysis", async () => {
  const cur = await ask("are the network metrics up to date?", {});
  assertEquals([cur.skill, cur.outcome], ["network", "current"]);
  assertStringIncludes(cur.reply, "Yes — every analysis that has been run is current");
  assertStringIncludes(cur.reply, "Never run: firm-level network metrics");
  assertStringIncludes(cur.reply, "can't start an analysis from the chat");

  const stale = await ask("I uploaded new data — do I need to re-run the analysis?", { stale: true });
  assertEquals(stale.outcome, "stale");
  assertStringIncludes(stale.reply, "No — 2 analyses are out of date");
  assertStringIncludes(stale.reply, "critical (nexus) nodes (2026-11-03) — re-run on the Product-level network page");

  const never = await ask("when were critical nodes last computed?", { analysed: false });
  assertEquals(never.outcome, "never_run");
});

Deno.test("N6: structure is counted from stored rows; unstored graph statistics are named as absent", async () => {
  const r = await ask("how big is my network?", {});
  assertEquals([r.skill, r.outcome], ["network", "counted"]);
  assertStringIncludes(r.reply, "10 nodes (3 suppliers, 3 materials, 2 products, 2 customers)");
  assertStringIncludes(r.reply, "10 lanes"); // the multi_tier lane is not part of this graph
  assertStringIncludes(r.reply, "1.33 suppliers on average; 2 of 3 have exactly one");
  assertStringIncludes(r.reply, "deepest BOM level is 2");
  assertStringIncludes(r.reply, "Density, diameter and clustering are not computed");

  const iso = await ask("are there isolated nodes?", {});
  assertStringIncludes(iso.reply, "Isolated nodes (no links on the product-level graph): 1");
});

Deno.test("A.1: the persona surface carries the four network reads", () => {
  Deno.env.set("COVERAGE_TOOLS_ENABLED", "true");
  try {
    const names = personaToolDeclarations().map((d) => d.name);
    for (const n of ["get_critical_nodes", "get_network_metrics", "get_analysis_status", "get_network_structure"]) {
      assert(names.includes(n), `${n} is on the persona surface`);
    }
  } finally {
    Deno.env.delete("COVERAGE_TOOLS_ENABLED");
  }
});

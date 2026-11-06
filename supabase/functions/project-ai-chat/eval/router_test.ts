// Router deterministic tier (ai-agents.md §6.2/§6.5 tier 1): short-circuits,
// strict parsing, fallbacks, tie-breaks — all with mocked classifier outputs.
// No LLM, no network.

import { assert, assertEquals, assertStringIncludes } from "./harness/asserts.ts";
import {
  AGENT_PRECEDENCE,
  AGENT_ROSTER,
  ROUTER_CONFIDENCE_MIN,
  AGENT_OWNERSHIP,
  buildClassifierPrompt,
  classifyIntent,
  decideRoute,
  deploymentEnabledAgents,
  parseClassifierResponse,
  type RouterContext,
} from "../router.ts";

const ctx = (over: Partial<RouterContext> = {}): RouterContext => ({
  personaId: null,
  hasProject: true,
  enabledAgents: ["data-steward"],
  modelId: "gemini-2.5-flash",
  ...over,
});

const artifactJson = (agent = "data-steward", confidence = 0.93) =>
  JSON.stringify({
    route: "artifact",
    agent_id: agent,
    intent: "steward.fill_missing",
    confidence,
    advisory_part: null,
    artifact_part: "fill in the costs",
  });

Deno.test("flag off ⇒ pure passthrough (no classifier call, advisory)", async () => {
  Deno.env.delete("AGENT_ROUTER_ENABLED");
  let called = false;
  const d = await decideRoute("fill in the missing costs", ctx(), () => {
    called = true;
    return Promise.resolve(artifactJson());
  });
  assertEquals(d.route, "advisory");
  assertEquals(d.short_circuit, "router_disabled");
  assertEquals(called, false, "flag off must never reach the LLM");
});

Deno.test("short-circuits: empty enabledAgents, then no project (§6.2 step 1)", async () => {
  Deno.env.set("AGENT_ROUTER_ENABLED", "true");
  const noAgents = await decideRoute("fill costs", ctx({ enabledAgents: [] }), () => Promise.resolve(artifactJson()));
  assertEquals(noAgents.short_circuit, "no_enabled_agents");
  const noProject = await decideRoute("fill costs", ctx({ hasProject: false }), () => Promise.resolve(artifactJson()));
  assertEquals(noProject.short_circuit, "no_project");
  Deno.env.delete("AGENT_ROUTER_ENABLED");
});

Deno.test("Stage 0: flag on but no classifier wired ⇒ advisory", async () => {
  Deno.env.set("AGENT_ROUTER_ENABLED", "true");
  const d = await decideRoute("fill costs", ctx());
  assertEquals(d.route, "advisory");
  assertEquals(d.short_circuit, "classifier_unavailable");
  Deno.env.delete("AGENT_ROUTER_ENABLED");
});

Deno.test("happy path: valid classification routes to the agent", async () => {
  Deno.env.set("AGENT_ROUTER_ENABLED", "true");
  const d = await decideRoute("fill in the missing costs", ctx(), () => Promise.resolve(artifactJson()));
  assertEquals(d.route, "artifact");
  assertEquals(d.agent_id, "data-steward");
  assertEquals(d.intent, "steward.fill_missing");
  assertEquals(d.short_circuit, null);
  Deno.env.delete("AGENT_ROUTER_ENABLED");
});

Deno.test("fallbacks: parse failure / classifier error / low confidence / disabled agent (§6.2 step 3)", async () => {
  Deno.env.set("AGENT_ROUTER_ENABLED", "true");
  const parseFail = await decideRoute("x", ctx(), () => Promise.resolve("not json at all"));
  assertEquals(parseFail.short_circuit, "parse_failure");

  const thrown = await decideRoute("x", ctx(), () => Promise.reject(new Error("provider down")));
  assertEquals(thrown.short_circuit, "classifier_error");

  const low = await decideRoute("x", ctx(), () => Promise.resolve(artifactJson("data-steward", ROUTER_CONFIDENCE_MIN - 0.01)));
  assertEquals(low.short_circuit, "low_confidence");
  assertEquals(low.route, "advisory");

  const atMin = await decideRoute("x", ctx(), () => Promise.resolve(artifactJson("data-steward", ROUTER_CONFIDENCE_MIN)));
  assertEquals(atMin.short_circuit, null, "confidence == threshold routes");

  const notEnabled = await decideRoute("x", ctx({ enabledAgents: ["vv-analyst"] }), () => Promise.resolve(artifactJson("data-steward")));
  assertEquals(notEnabled.short_circuit, "agent_not_enabled");
  Deno.env.delete("AGENT_ROUTER_ENABLED");
});

Deno.test("strict parse: closed vocabularies, array tie-break, fenced JSON", () => {
  assertEquals(parseClassifierResponse("{}"), null);
  assertEquals(parseClassifierResponse('{"route":"artifact","agent_id":null,"confidence":0.9}'), null, "artifact requires an owner");
  assertEquals(parseClassifierResponse('{"route":"artifact","agent_id":"made-up","confidence":0.9}'), null);
  assertEquals(parseClassifierResponse('{"route":"advisory","agent_id":null,"confidence":2}'), null, "confidence must be [0,1]");

  // model disobeys with an array ⇒ first valid element wins (§6.2 step 4)
  const arr = parseClassifierResponse(`[{"route":"bogus"}, ${artifactJson("vv-analyst")}]`);
  assertEquals(arr?.agent_id, "vv-analyst");

  const fenced = parseClassifierResponse("```json\n" + artifactJson() + "\n```");
  assertEquals(fenced?.agent_id, "data-steward");
});

Deno.test("classification prompt lists enabled agents in dependency order (§6.3)", () => {
  const prompt = buildClassifierPrompt("hello", ["explainer", "data-steward", "vv-analyst"]);
  const iSteward = prompt.indexOf('"data-steward"');
  const iVv = prompt.indexOf('"vv-analyst"');
  const iExplainer = prompt.indexOf('"explainer"');
  assert(iSteward >= 0 && iVv > iSteward && iExplainer > iVv, "precedence order must be preserved");
  assertStringIncludes(prompt, "prefer the earliest in the list order given");
  assertStringIncludes(prompt, "steward.fill_missing");
  assertStringIncludes(prompt, "USER MESSAGE:\nhello");
  // a disabled agent's intents never leak into the prompt
  const only = buildClassifierPrompt("x", ["data-steward"]);
  assert(!only.includes("exp.design"), "disabled agents are invisible to the router (§13.2)");
  // §6.3 ownership notes (ai-agents.md §25 Q1): one per ENABLED agent, after
  // the owner list and in the same precedence order; a disabled agent's note
  // never reaches the classifier.
  assertStringIncludes(only, `- data-steward: ${AGENT_OWNERSHIP["data-steward"]}`);
  assert(!only.includes(AGENT_OWNERSHIP["experiment-designer"]), "a disabled agent's ownership note never leaks");
  const notes = prompt.slice(prompt.indexOf("Ownership notes"));
  assert(notes.indexOf("- data-steward:") < notes.indexOf("- vv-analyst:") &&
    notes.indexOf("- vv-analyst:") < notes.indexOf("- explainer:"), "ownership notes follow precedence order");
  assert(prompt.indexOf("Ownership notes") > prompt.indexOf("prefer the earliest"), "notes come after the owner list");
});

Deno.test("classifyIntent honors the §6.1 contract shape", async () => {
  Deno.env.set("AGENT_ROUTER_ENABLED", "true");
  const d = await classifyIntent("fill costs", ctx(), () => Promise.resolve(artifactJson()));
  assertEquals(Object.keys(d).sort(), [
    // §6.6 (v1.4): needs_run + cache_checkable are additive contract fields —
    // always present, defaulting false with ROUTER_V2_SIGNALS off.
    "advisory_part", "agent_id", "artifact_part", "cache_checkable",
    "confidence", "intent", "needs_run", "route",
  ]);
  Deno.env.delete("AGENT_ROUTER_ENABLED");
});

Deno.test("deployment kill switch parses AGENT_ENABLED_IDS and drops unknowns", () => {
  Deno.env.set("AGENT_ENABLED_IDS", " data-steward , made-up, explainer ");
  assertEquals(deploymentEnabledAgents(), ["data-steward", "explainer"]);
  Deno.env.delete("AGENT_ENABLED_IDS");
  assertEquals(deploymentEnabledAgents(), []);
});

Deno.test("roster: every precedence slug has a mission and intents", () => {
  for (const slug of AGENT_PRECEDENCE) {
    assert(AGENT_ROSTER[slug].mission.length > 10, `${slug} mission`);
    assert(AGENT_ROSTER[slug].intents.length >= 2, `${slug} intents`);
  }
});

Deno.test("§6.3 ownership notes: the doc's verbatim table and AGENT_OWNERSHIP are one fact", async () => {
  const doc = await Deno.readTextFile(new URL("../../../../docs/design/ai-agents.md", import.meta.url));
  const start = doc.indexOf("`{{enabled_agents_ownership_notes}}`");
  assert(start >= 0, "§6.3 must document the ownership-notes placeholder");
  const section = doc.slice(start, doc.indexOf("### 6.4", start));
  const fromDoc: Record<string, string> = {};
  for (const m of section.matchAll(/^\| `([a-z-]+)` \| (.+) \|$/gm)) fromDoc[m[1]] = m[2];
  assertEquals(fromDoc, { ...AGENT_OWNERSHIP });
});

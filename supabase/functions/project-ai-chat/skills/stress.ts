// S13 simulated criticality and N8 the network ↔ simulation bridge
// (ai-agents.md §28 Phase A, A.5).
//
//   stress          "what did the stress test show?", "rank suppliers by
//                   simulated impact", "does it agree with the critical-node
//                   ranking?"  READS the stored nexus stress battery. It never
//                   starts one: a battery is hundreds of runs and belongs to
//                   the Simulation Lab's stress card.
//   criticalwhatif  "simulate losing my most critical supplier", "what if my
//                   top 3 critical suppliers fail for 4 weeks"  Names the
//                   node(s) from the stored analysis, with its source, and
//                   hands a concrete what-if to the what-if loop — so the run
//                   takes every §27 guardrail (Validated Model, approval).
//
// The two kinds of evidence are never mixed: the critical-node score is a
// STATIC estimate; the stress battery and a what-if are SIMULATED. A
// simulation question is never answered from the static score.

import registry from "../../_shared/registry.generated.json" with { type: "json" };
import { parseWhatIf, runWhatIfLoop, whatIfInterpretationMessage, whatIfReply } from "../whatIf.ts";
import { provenanceLine, type Provenance } from "../networkTools.ts";
import { callTool, type Skill, type SkillInput, type SkillResult } from "./common.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const NEXUS = (registry as unknown as { nexus_scenario?: { start_week?: number } }).nexus_scenario ?? {};
const EVENT_CAP = (registry as unknown as { disruption?: { event_cap?: number } }).disruption?.event_cap ?? 5;

const tableData = (env: { kind: string; data: unknown }): Any | null => (env.kind === "table" ? (env.data as Any) : null);
const who = (n: { node_id: string; name?: string | null }): string => (n.name && n.name !== n.node_id ? `${n.node_id} (${n.name})` : n.node_id);
const eur = (n: number | null): string => (n === null ? "—" : `€${Math.round(n).toLocaleString("en-US")}`);

// ── S13 · the stored stress battery ─────────────────────────────────────────

const STRESS_WORDS =
  /\bstress[-\s]?(?:test\w*|batter\w*)\b|\bST-[1-7]\b|\bsimulated\s+(?:impact|criticality|ranking|lost\s+sales)\b|\bby\s+simulat\w+\b|\b(?:hurts?|costs?|damages?)\s+(?:us\s+)?(?:the\s+)?most\s+if\b[^?]*\bdelay\w*|\bdelay\w*\s+(?:costs?|hurts?|causes?)\s+the\s+most\b|\bworst\s+in\s+(?:the\s+)?simulation\b/i;
const LAUNCH_WORDS = /\b(?:run|start|launch|kick\s+off|do)\s+(?:a\s+|the\s+|an?\s+)?(?:nexus\s+)?(?:stress[-\s]?(?:test|battery)|ST-[1-7])\b|\bstress[-\s]?test\s+(?:all|every|each|my)\b/i;
const AGREEMENT_WORDS = /\b(agree\w*|match\w*|consistent|same\s+as|line\s+up|also\s+the\s+worst|compare\w*)\b/i;
const STATIC_WORDS = /\b(critical\w*|nexus|central\w*|ranking|network\s+analysis)\b/i;

interface StressMatch { kind: "supplier" | "material"; launch: boolean; agreement: boolean; staticBy: "critical" | "betweenness"; weeks: number | null; node: string | null }

export const stressSkill: Skill = {
  id: "stress",
  drafts: false,
  describe: "reads the stored stress test — suppliers and materials ranked by simulated lost sales — and compares it with the critical-node ranking",
  example: "what did the stress test show?  ·  rank suppliers by simulated impact",
  recognize(input: SkillInput): StressMatch | null {
    const u = input.utterance;
    if (!STRESS_WORDS.test(u)) return null;
    const wk = u.match(/\b(\d{1,2})[-\s]?weeks?\b/i);
    const id = u.match(/\b[A-Za-z]{1,6}[-_]?\d{1,8}[A-Za-z]?\b/g)?.find((t) => !/^ST-?\d$/i.test(t) && !/^(?:w|wk|week)\d+$/i.test(t)) ?? null;
    return {
      kind: /\bmaterials?\b|\bparts?\b|\bcomponents?\b/i.test(u) && !/\bsuppliers?\b/i.test(u) ? "material" : "supplier",
      launch: LAUNCH_WORDS.test(u),
      agreement: AGREEMENT_WORDS.test(u) && STATIC_WORDS.test(u),
      staticBy: /\bcentral\w*\b/i.test(u) && !/\b(critical\w*|nexus)\b/i.test(u) ? "betweenness" : "critical",
      weeks: wk ? Number(wk[1]) : null,
      node: id,
    };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as StressMatch;
    const calls: SkillResult["calls"] = [];
    const launchLine = m.launch
      ? " I don't start the stress test from the chat — it is hundreds of runs. Start it from the stress card in the Simulation Lab; a single event (one supplier, one start, one duration) I can run for you as a what-if."
      : "";
    const env = await callTool(calls, ctx, "get_stress_results", {
      kind: m.kind, top_n: m.agreement ? 10 : 5,
      ...(m.weeks !== null ? { duration_weeks: m.weeks } : {}),
      ...(m.node && !m.agreement ? { node: m.node } : {}),
    });
    const data = tableData(env);
    if (!data) {
      const note = env.meta.note ?? "";
      if (note === "no_analysis") {
        return {
          reply: "No stress test has been run on this project, so I have no simulated ranking — and I won't present the static network score as one." + launchLine +
            (m.launch ? "" : " It runs on a Validated Model from the stress card in the Simulation Lab.") +
            " Meanwhile, \"which supplier is most critical?\" gives the static estimate (share of demand at risk), labelled as such.",
          parts: [], calls, outcome: "no_battery",
        };
      }
      return { reply: String(env.data ?? "I couldn't read the stress test."), parts: [], calls, outcome: note || "error" };
    }
    const st = data.stress as {
      run_id: string; computed_at: string | null; engine_build: string | null; model: string | null; policy_version: string | null;
      data_version: string | null; replications: number | null; durations_weeks: number[]; data_is_current: boolean; model_is_active: boolean; tested: number; kind: string;
    };
    const nodes = data.nodes as Array<{ node_id: string; name: string | null; rank: number | null; average_eur: number | null; at_duration_eur: number | null }>;
    const span = st.durations_weeks.length ? `${Math.min(...st.durations_weeks)}–${Math.max(...st.durations_weeks)} week` : "";
    const source = `Source: stress test of ${st.computed_at ?? "unknown date"}, run ${st.run_id.slice(0, 8)}, on Validated Model ${st.model ? `"${st.model}"` : "(unnamed)"}` +
      `${st.policy_version ? `, policy version ${st.policy_version}` : ""}${st.data_version ? `, data version ${st.data_version}` : ""}` +
      `${st.replications != null ? `, ${st.replications} replications` : ""}${st.engine_build ? `, engine ${st.engine_build}` : ""}.`;
    const stale = [
      !st.data_is_current ? "the project's data has changed since it ran" : "",
      !st.model_is_active ? "the model it ran on is no longer in force" : "",
    ].filter(Boolean);
    const staleLine = stale.length ? ` **OUT OF DATE: ${stale.join(" and ")}** — the ranking describes the earlier setup; re-run the stress test in the Simulation Lab.` : "";
    const outcome = stale.length ? "answered_stale" : "answered";
    const part = { kind: "table", data: { columns: data.columns, rows: data.rows } };

    if (m.agreement) {
      const staticName = m.staticBy === "critical" ? "critical-node analysis" : "betweenness ranking (product-level graph)";
      const cenv = m.staticBy === "critical"
        ? await callTool(calls, ctx, "get_critical_nodes", { echelon: m.kind, top_n: 10 })
        : await callTool(calls, ctx, "get_network_metrics", { level: "product", measure: "betweenness", echelon: m.kind, top_n: 10 });
      const cdata = tableData(cenv);
      if (!cdata) {
        return {
          reply: `I can show the simulated ranking, but there is no ${staticName} to compare it with (run it on the Product-level network page). Simulated top ${m.kind}: ${who(nodes[0])}, ${eur(nodes[0].average_eur)} average lost sales. ${source}${staleLine}`,
          parts: [part], calls, outcome: "no_analysis",
        };
      }
      const staticIds = (cdata.nodes as Array<{ node_id: string }>).map((n) => n.node_id);
      const simIds = nodes.map((n) => n.node_id);
      const k = Math.min(staticIds.length, simIds.length, 10);
      const overlap = simIds.slice(0, k).filter((id) => staticIds.slice(0, k).includes(id));
      const sameTop = simIds[0] === staticIds[0];
      return {
        reply: `${sameTop ? "Yes at the top" : "Not at the top"}: the stress test ranks ${simIds[0]} first and the ${staticName} ranks ${staticIds[0]} first. ` +
          `Of each list's top ${k} ${m.kind}s, ${overlap.length} appear in both${overlap.length ? ` (${overlap.join(", ")})` : ""}. ` +
          `They measure different things — the stress test is simulated lost sales from a delay, with stock and recovery; the ${m.staticBy === "critical" ? "critical-node score is a static share of demand at risk" : "betweenness score is a static count of the routes that pass through a node"} — so some disagreement is expected. I compute no correlation statistic. ` +
          `${source}${staleLine} ${provenanceLine(cdata.provenance as Provenance)}`,
        parts: [part], calls, outcome,
      };
    }
    const top = nodes[0];
    const lead = m.node
      ? `By simulation, ${who(top)} is rank ${top.rank ?? "—"} of ${st.tested} ${m.kind}s: ${eur(top.average_eur)} average lost sales over ${span} delays` +
        `${m.weeks !== null && top.at_duration_eur !== null ? ` (${eur(top.at_duration_eur)} for a ${m.weeks}-week delay)` : ""}.`
      : `By simulation, the most damaging ${m.kind} delay is **${who(top)}**: ${eur(top.average_eur)} average lost sales over ${span} delays` +
        `${m.weeks !== null && top.at_duration_eur !== null ? ` (${eur(top.at_duration_eur)} for a ${m.weeks}-week delay)` : ""}` +
        `${nodes[1] ? `; then ${nodes.slice(1, 3).map((n) => `${who(n)} (${eur(n.average_eur)})`).join(", ")}` : ""}. ${st.tested} ${m.kind}s were tested.`;
    return { reply: `${lead} ${source}${staleLine}${launchLine}`, parts: [part], calls, outcome };
  },
};

// ── N8 · "simulate losing my most critical supplier" ────────────────────────

const RUN_ASK = /\b(what\s+if|what\s+happens\s+if|what\s+would\s+happen|simulate|run\s+(?:a\s+)?(?:scenario|simulation|what-?if))\b/i;
const RANKED_SUBJECT =
  /\b(?:my|our|the)\s+(?:(?:top|first)[-\s]?(\d)\s+)?(?:(?:single\s+)?most\s+)?(critical|nexus|central|connected)\s+(?:supplier|vendor|node)s?\b|\b(?:my|our|the)\s+(biggest|largest|main)\s+(hub|bottleneck)\b/i;

interface BridgeMatch { n: number; by: "critical" | "betweenness" | "degree"; phrase: string }

export const criticalWhatIfSkill: Skill = {
  id: "criticalwhatif",
  drafts: true,
  describe: "simulates the loss of your most critical supplier: names it from the stored analysis, then sets up the what-if",
  example: "what if my most critical supplier is down for 4 weeks from week 22?",
  recognize(input: SkillInput): BridgeMatch | null {
    const u = input.utterance;
    if (!RUN_ASK.test(u)) return null;
    const m = u.match(RANKED_SUBJECT);
    if (!m) return null;
    const word = (m[2] ?? m[4] ?? "").toLowerCase();
    return {
      n: Math.min(EVENT_CAP, Math.max(1, Number(m[1] ?? 1))),
      by: word === "critical" || word === "nexus" ? "critical" : word === "bottleneck" || word === "central" ? "betweenness" : "degree",
      phrase: m[0],
    };
  },
  async run(ctx, match, input, opts): Promise<SkillResult> {
    const m = match as BridgeMatch;
    const calls: SkillResult["calls"] = [];
    const env = m.by === "critical"
      ? await callTool(calls, ctx, "get_critical_nodes", { echelon: "supplier", top_n: m.n })
      : await callTool(calls, ctx, "get_network_metrics", { level: "product", measure: m.by, echelon: "supplier", top_n: m.n });
    const data = tableData(env);
    if (!data) {
      return {
        reply: `I can't pick the supplier for you: ${m.by === "critical" ? "no critical-node analysis has" : "no product-level network metrics have"} been run on this project, and I won't guess which one it is. ` +
          "Run the analysis on the Product-level network page, or name the supplier: \"what if S001 is down for 4 weeks from week 22?\".",
        parts: [], calls, outcome: "no_analysis",
      };
    }
    const nodes = (data.nodes as Array<{ node_id: string; name: string | null; score?: number; value?: number }>).slice(0, m.n);
    const prov = data.provenance as Provenance;
    const basis = m.by === "critical"
      ? nodes.map((n) => `${who(n)} — ${((n.score ?? 0) * 100).toFixed(1)}% of demand at risk`).join("; ")
      : nodes.map((n) => `${who(n)} — ${m.by} ${(n.value ?? 0).toFixed(4)}`).join("; ");
    const named = `By the stored analysis, ${nodes.length === 1 ? "that supplier is" : "those suppliers are"} ${basis}. ${provenanceLine(prov)} That is a static ranking; the simulation below measures the actual impact.`;
    // The user's own sentence with the ranked phrase replaced by the ids, led
    // by a canonical what-if so the parser reads the targets and the timing.
    const ids = nodes.map((n) => n.node_id);
    const rest = input.utterance.replace(m.phrase, ids.join(" and "));
    const concrete = `what if ${ids.join(" and ")} goes down — ${rest}`;
    const ask = parseWhatIf(concrete);
    if (!ask || ask.startWeek === null || ask.durationWeeks === null) {
      const start = Number(NEXUS.start_week ?? 26);
      return {
        reply: `${named}\n\nTo simulate ${nodes.length === 1 ? "its" : "their"} loss I need when it starts and how long it lasts. Options:\n` +
          `1. "what if ${ids.join(" and ")} is down for 4 weeks from week ${start}?" (recommended — week ${start} is the stress test's own start week)\n` +
          `2. "what if ${ids.join(" and ")} is down for 8 weeks from week ${start}?"\n` +
          "3. your own start week and duration.\n" +
          "Send one of these and I'll look for a finished run first, then draft one for your approval.",
        parts: [], calls, outcome: "needs_timing",
      };
    }
    const wi = await runWhatIfLoop(ctx, ask, { canDraft: opts.canDraft, draftBlockedReason: opts.draftBlockedReason });
    return {
      reply: `${named}\n\n${whatIfReply(wi.outcome)}`,
      parts: wi.parts,
      calls: [...calls, ...wi.calls],
      proposal: wi.outcome.kind === "proposed" ? wi.outcome.proposal : null,
      interpretation: whatIfInterpretationMessage(concrete, wi.outcome),
      outcome: wi.outcome.kind,
    };
  },
};

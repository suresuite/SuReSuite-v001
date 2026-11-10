// Network-analysis skills (ai-agents.md §28 Phase A, package A.1):
//
//   critical    N1  "which supplier is most critical?", "is S001 critical?"
//   centrality  N2/N3  "who's the biggest hub?", "betweenness of S001",
//                      "most prominent firms"
//   network     N6/N7  "are the metrics up to date?", "how big is my network?"
//
// Every number is READ from the platform's analysis store through the tools
// in networkTools.ts; nothing is computed here and nothing comes from general
// knowledge. Three rules hold in every reply (§28.3):
//   - the answer names its analysis run, level and date, and says OUT OF DATE
//     when the data changed after the run (owner decision 4: answer from the
//     stale result, clearly marked — nothing is run on a stale basis);
//   - "critical" means DEMAND AT RISK, the platform's one definition (owner
//     decision 1); sole-source count is reported as exposure, never as rank;
//   - a static network score is never called a simulated impact — the reply
//     ends with the what-if that would measure it.
//   - the chat does not start an analysis (owner decision 3): it names the page.

import {
  MEASURE_MEANING,
  NETWORK_MEASURES,
  provenanceLine,
  type NetworkLevel,
  type NetworkMeasure,
  type Provenance,
} from "../networkTools.ts";
import { callTool, type Skill, type SkillInput, type SkillResult } from "./common.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── shared parsing ──────────────────────────────────────────────────────────

/** A run or what-if ask is not a read — it belongs to the simulation skills. */
const RUN_WORDS = /\b(what\s+if|what\s+happens\s+if|what\s+would\s+happen|simulate|simulated|in\s+(?:the\s+)?simulation|by\s+simulation|stress[-\s]?test|run\s+(?:a|the)\s+(?:scenario|simulation))\b/i;
/** "what is betweenness?" with nothing of the project in it is a manual question. */
const DEFINITION_ONLY = /^\s*(?:what\s+(?:is|are|does)|what's|define|explain)\b/i;
const PROJECT_WORDS = /\b(my|our|we|us|this\s+project|which|who|top|most|rank\w*|biggest|largest|highest|lowest|list|show)\b/i;
const TIME_TOKEN = /^(?:w|wk|wks|week|weeks|d|day|days|q|m|mo|month|months|top|tier|st|vm|p)-?\d+$/i;
const ID_TOKEN = /\b[A-Za-z]{0,6}[-_]?\d{1,10}[A-Za-z]?\b/g;

const NOT_A_NAME = /^(my|our|the|a|an|it|this|that|which|what|any|each|every|most|more|very|really|how|also|there|supplier|material|product|customer|node|firm|network)$/i;

const ECHELONS = ["supplier", "material", "product", "customer", "plant"] as const;
function echelonIn(text: string): string | null {
  for (const e of ECHELONS) if (new RegExp(`\\b${e}s?\\b`, "i").test(text)) return e;
  if (/\b(vendors?)\b/i.test(text)) return "supplier";
  if (/\b(parts?|components?)\b/i.test(text)) return "material";
  return null;
}

function topNIn(text: string): number | null {
  const m = text.match(/\btop[-\s]?(\d{1,2})\b/i) ?? text.match(/\b(\d{1,2})\s+(?:most|biggest|highest)\b/i);
  return m ? Math.min(50, Math.max(1, Number(m[1]))) : null;
}

/** The node a question names: an id-shaped token, a quoted name, or the word
 * right before/after the verb ("is Acme critical", "if we lose TTI"). */
export function nodeIn(text: string): string | null {
  const quoted = text.match(/["“']([^"”']{2,60})["”']/);
  if (quoted) return quoted[1].trim();
  const stripped = text.replace(/\btop[-\s]?\d+\b/gi, " ");
  for (const m of stripped.matchAll(ID_TOKEN)) {
    const tok = m[0];
    if (!/\d/.test(tok) || TIME_TOKEN.test(tok)) continue;
    if (/^\d+$/.test(tok)) {
      // a bare number is an id only right after a role word ("supplier 10")
      const before = stripped.slice(0, m.index).trimEnd().split(/\s+/).pop() ?? "";
      if (!/^(supplier|material|product|customer|node|vendor|part)$/i.test(before)) continue;
    }
    return tok;
  }
  const named =
    text.match(/\b(?:[Ii]s|[Ww]as|[Ww]hy\s+is|[Ww]hy's)\s+([A-Za-z][\w&.-]*(?:\s+[A-Z][\w&.-]*)?)\s+(?:a\s+|an\s+|so\s+|still\s+)?(?:critical|nexus|central|prominent)\b/) ??
    text.match(/\b(?:lose|losing|lost|without|loss\s+of)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)?)/) ??
    text.match(/\b(?:of|for)\s+([A-Z][\w&.-]{1,}(?:\s+[A-Z][\w&.-]*)?)\s*\??\s*$/);
  if (named) {
    const n = named[1].trim();
    if (!NOT_A_NAME.test(n)) return n;
  }
  return null;
}

const tableData = (env: { kind: string; data: unknown }): Any | null =>
  env.kind === "table" ? (env.data as Any) : null;
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
const who = (n: { node_id: string; name?: string | null }): string =>
  n.name && n.name !== n.node_id ? `${n.node_id} (${n.name})` : n.node_id;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── N1 · critical nodes ─────────────────────────────────────────────────────

const CRITICAL_WORDS = /\b(critical(?:ity)?|nexus|demand\s+(?:is\s+|would\s+be\s+)?at\s+risk)\b/i;
const CRITICAL_SUBJECT = /\b(nodes?|suppliers?|vendors?|materials?|parts?|components?|products?|customers?|firms?|plants?|network|supply\s+chain)\b/i;
const CRITICAL_MEANING = /\bwhat\s+does\s+(?:critical|nexus)\b[^?]*\bmean|\bwhat\s+(?:is|are)\s+(?:a\s+)?(?:nexus|critical)\s+nodes?\b|\bhow\s+is\s+(?:critical\w*|nexus)\s+(?:defined|calculated|computed|scored)/i;

interface CriticalMatch { node: string | null; echelon: string | null; topN: number | null; meaning: boolean }

export const criticalSkill: Skill = {
  id: "critical",
  drafts: false,
  describe: "reads the platform's critical-node analysis — the share of demand at risk if one node is lost — and says when it was computed",
  example: "which supplier is most critical?  ·  is S001 critical?",
  recognize(input: SkillInput): CriticalMatch | null {
    const u = input.utterance;
    if (!CRITICAL_WORDS.test(u) || RUN_WORDS.test(u)) return null;
    const meaning = CRITICAL_MEANING.test(u);
    const node = nodeIn(u);
    if (!meaning && !node && !CRITICAL_SUBJECT.test(u)) return null;
    return { node, echelon: echelonIn(u), topN: topNIn(u), meaning };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as CriticalMatch;
    const calls: SkillResult["calls"] = [];
    const env = await callTool(calls, ctx, "get_critical_nodes", {
      ...(m.node ? { node: m.node } : {}),
      ...(m.echelon && !m.node ? { echelon: m.echelon } : {}),
      top_n: m.topN ?? (m.node ? 3 : 5),
    });
    const definition =
      "On this platform a node's criticality is its **demand at risk**: the share of finished-goods demand that cannot be served if that node alone is lost and nothing is rerouted or drawn from stock.";
    const data = tableData(env);
    if (!data) {
      const note = env.meta.note ?? "";
      const text = String(env.data ?? "");
      if (note === "no_analysis") {
        return {
          reply: (m.meaning ? `${definition} A node is "nexus" at 50% or more. ` : "") +
            "No critical-node analysis has been run for this project yet, so I have no ranking to read — and I won't rank nodes from other data and call it critical. " +
            "Run it on the Product-level network page (Nexus nodes), then ask again. Until then I can show sole-source exposure (\"which materials are single-sourced?\").",
          parts: [], calls, outcome: "no_analysis",
        };
      }
      if (note === "node_not_found") return { reply: text, parts: [], calls, outcome: "node_not_found" };
      return { reply: text || "I couldn't read the critical-node analysis.", parts: [], calls, outcome: note === "error" ? "error" : "empty" };
    }
    const prov = data.provenance as Provenance;
    const s = data.summary as { threshold: number; nodes_scored: number; nexus_nodes: number; demand_basis: string; warnings: unknown[] };
    const nodes = data.nodes as Array<{ node_id: string; name: string | null; echelon: string | null; score: number; is_critical: boolean; rank: number | null; products_affected: number; sole_source_of: string[] }>;
    const top = nodes[0];
    const role = m.echelon ?? "node";
    const drivers = (n: typeof top): string => {
      const bits: string[] = [];
      if (n.sole_source_of.length) bits.push(`it is the only source of ${plural(n.sole_source_of.length, "material")}`);
      if (n.products_affected) bits.push(`${plural(n.products_affected, "product")} depend on it`);
      return bits.length ? `; ${bits.join(" and ")}` : "";
    };
    const threshold = pct(s.threshold).replace(".0%", "%");
    let lead: string;
    if (m.node) {
      const verdict = top.is_critical
        ? `**${who(top)} is a nexus node**`
        : top.rank === null
        ? `${who(top)} puts no finished-goods demand at risk on its own`
        : `${who(top)} is not a nexus node`;
      lead = top.rank === null
        ? `${verdict} in the stored analysis (demand at risk 0%).`
        : `${verdict}: ${pct(top.score)} of finished-goods demand is at risk if it alone is lost (rank ${top.rank} of ${s.nodes_scored}; nexus means at least ${threshold})${drivers(top)}.`;
    } else {
      lead = `Your most critical ${role} is **${who(top)}**: ${pct(top.score)} of finished-goods demand is at risk if it alone is lost${drivers(top)}.`;
      if (nodes[1]) lead += ` Next: ${nodes.slice(1, 3).map((n) => `${who(n)} at ${pct(n.score)}`).join(", ")}.`;
      lead += ` ${s.nexus_nodes} of ${s.nodes_scored} scored nodes ${s.nexus_nodes === 1 ? "is" : "are"} nexus (at least ${threshold} of demand at risk).`;
    }
    const basis = s.demand_basis === "equal_per_product"
      ? " Products were weighted equally because weekly demand volumes are missing."
      : "";
    const caveat = " This is a static estimate — no stock, no rerouting, no time.";
    const next = top.echelon === "supplier"
      ? ` For the simulated impact, ask e.g. "what if ${top.node_id} is down for 4 weeks from week 22?"`
      : " For a simulated impact, ask a what-if on one of its suppliers (the engine disrupts suppliers and the plant).";
    return {
      reply: (m.meaning ? `${definition} ` : "") + lead + basis + ` ${provenanceLine(prov)}` + caveat + next,
      parts: [{ kind: "table", data: { columns: data.columns, rows: data.rows } }],
      calls,
      outcome: prov.is_current === false ? "answered_stale" : "answered",
    };
  },
};

// ── N2/N3 · centrality and prominence ───────────────────────────────────────

const MEASURE_WORDS: Array<[RegExp, NetworkMeasure]> = [
  [/\bbetweenness\b|\bbottle[-\s]?necks?\b|\bchoke\s*points?\b/i, "betweenness"],
  [/\beigen\s*vector\b|\binfluential\b|\bmost\s+influence\b/i, "eigenvector"],
  [/\bcloseness\b/i, "closeness"],
  [/\bweighted[-\s]+degree\b|\bmost\s+(?:flow|volume)\b/i, "weighted_degree"],
  [/\bdegree\s+centralit\w*\b|\bby\s+degree\b|\bdegree\s+of\b|\bhubs?\b|\bmost\s+connect\w*\b|\bconnects?\s+(?:to\s+)?the\s+most\b|\bmost\s+(?:links|connections)\b/i, "degree"],
  [/\bprominen\w*\b/i, "prominence"],
];
const CENTRAL_GENERIC = /\b(most\s+central|central\s+(?:node|supplier|material|product|customer|firm)s?|centralit(?:y|ies))\b/i;
/** Graph metrics people ask for that this platform does not compute. */
const UNSUPPORTED_METRIC = /\b(page\s*rank|clustering(?:\s+coefficient)?|modularity|communit(?:y|ies)\s+detection|density|dense|sparse|diameter|katz|harmonic\s+centrality|k[-\s]?core)\b/i;
const FIRM_WORDS = /\b(firm[-\s]?level|firms?|compan(?:y|ies)|tier[-\s]?[23]|deep[-\s]?tier|sub[-\s]?tier)\b/i;

interface CentralityMatch {
  measure: NetworkMeasure | null; level: NetworkLevel; node: string | null; echelon: string | null;
  topN: number | null; unsupported: string | null;
}

export const centralitySkill: Skill = {
  id: "centrality",
  drafts: false,
  describe: "reads the platform's stored network metrics — hubs, bottlenecks, centrality and prominence — and says when they were computed",
  example: "who is the biggest hub in my network?  ·  betweenness of S001",
  recognize(input: SkillInput): CentralityMatch | null {
    const u = input.utterance;
    if (RUN_WORDS.test(u)) return null;
    const unsupported = u.match(UNSUPPORTED_METRIC)?.[0] ?? null;
    let measure: NetworkMeasure | null = null;
    for (const [re, m] of MEASURE_WORDS) if (re.test(u)) { measure = m; break; }
    if (!measure && !unsupported && !CENTRAL_GENERIC.test(u)) return null;
    if (unsupported && !measure && !/\b(network|graph|supply\s+chain|nodes?)\b/i.test(u)) return null;
    // "what is betweenness centrality?" is the manual's question, not the project's.
    if (DEFINITION_ONLY.test(u) && !PROJECT_WORDS.test(u) && !nodeIn(u)) return null;
    return {
      measure, level: FIRM_WORDS.test(u) ? "firm" : "product", node: nodeIn(u),
      echelon: echelonIn(u), topN: topNIn(u), unsupported: measure ? null : unsupported,
    };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as CentralityMatch;
    const calls: SkillResult["calls"] = [];
    if (m.unsupported) {
      return {
        reply: `This platform does not compute ${m.unsupported.toLowerCase()}, so I have no value to give you and I won't estimate one. ` +
          `The stored network measures are: ${NETWORK_MEASURES.map((x) => x.replace("_", " ")).join(", ")}. ` +
          `Ask e.g. "which node is the biggest bottleneck?" (betweenness) or "how big is my network?" (counts).`,
        parts: [], calls, outcome: "unsupported_metric",
      };
    }
    // A bare "most central" is ambiguous: answer it on the three readings, named.
    const measures: NetworkMeasure[] = m.measure ? [m.measure] : ["betweenness", "degree", "eigenvector"];
    const lines: string[] = [];
    const parts: SkillResult["parts"] = [];
    let prov: Provenance | null = null;
    let outcome = "answered";
    for (const measure of measures) {
      const env = await callTool(calls, ctx, "get_network_metrics", {
        level: m.level, measure,
        ...(m.node ? { node: m.node } : {}),
        ...(m.echelon && !m.node && m.level === "product" ? { echelon: m.echelon } : {}),
        top_n: m.topN ?? (measures.length > 1 ? 3 : 5),
      });
      const data = tableData(env);
      if (!data) {
        const note = env.meta.note ?? "";
        const text = String(env.data ?? "");
        if (note === "no_analysis") {
          return {
            reply: `${text} I won't estimate network metrics from general knowledge.` +
              (m.level === "firm" ? " The product-level graph may have metrics — ask without \"firm\"." : ""),
            parts: [], calls, outcome: m.level === "firm" ? "no_firm_network" : "no_analysis",
          };
        }
        return { reply: text || "I couldn't read the network metrics.", parts: [], calls, outcome: note || "error" };
      }
      prov = data.provenance as Provenance;
      if (prov.is_current === false) outcome = "answered_stale";
      const nodes = data.nodes as Array<{ node_id: string; name: string | null; echelon: string | null; value: number; connections: number | null }>;
      const word = measure.replace("_", " ");
      const graph = m.level === "firm" ? "firm-level network" : "product-level graph";
      const scope = m.echelon && !m.node && m.level === "product" ? `${m.echelon} ` : "";
      if (m.node) {
        const n = nodes[0];
        lines.push(`${who(n)} has ${word} ${n.value.toFixed(4)} on the ${graph}${n.connections != null ? ` (${plural(n.connections, "link")})` : ""}. ${MEASURE_MEANING[measure]}`);
      } else {
        const rest = nodes.slice(1, 3).map((n) => `${who(n)} (${n.value.toFixed(4)})`).join(", ");
        lines.push(`By ${word} on the ${graph}, the top ${scope}node is **${who(nodes[0])}** (${nodes[0].value.toFixed(4)})${rest ? `, then ${rest}` : ""}. ${MEASURE_MEANING[measure]}`);
      }
      parts.push({ kind: "table", data: { columns: data.columns, rows: data.rows } });
    }
    const ambiguity = measures.length > 1
      ? "\"Most central\" can mean three things, so here are all three. "
      : "";
    return {
      reply: ambiguity + lines.join("\n\n") + `\n\n${prov ? provenanceLine(prov) : ""}` +
        " A central node is structurally important; that is not a measure of business impact — for that ask \"which supplier is most critical?\" (demand at risk).",
      parts: parts.slice(0, 1),
      calls,
      outcome,
    };
  },
};

// ── N6/N7 · is the analysis current? how big is the network? ────────────────

const STATUS_WORDS = /\b(up[-\s]?to[-\s]?date|out[-\s]?of[-\s]?date|stale|fresh|last\s+(?:computed|calculated|run|updated|analy[sz]ed)|when\s+(?:were|was|did)\b|re[-\s]?(?:run|compute|calculate|analy[sz]e)|recalculate|refresh|fall[-\s]?back|graph\s+version|which\s+version)\b/i;
const ANALYSIS_NOUN = /\b(analys[ei]s|network\s+metrics?|metrics?|centralit\w*|critical\s+nodes?|nexus|prominence|network\s+science)\b/i;
const NOT_NETWORK = /\b(model|validat\w*|replications?|scenario|simulation\s+run|policy|policies)\b/i;
const STRUCTURE_WORDS = /\bhow\s+(?:big|large)\s+is\s+(?:my|the|our)\s+(?:network|supply\s+chain)\b|\bnetwork\s+size\b|\bhow\s+many\s+(?:tiers?|nodes?|echelons?|levels?|lanes?|edges?|links?)\b|\bsuppliers?\s+per\s+material\b|\bisolated\s+nodes?\b|\bhow\s+deep\s+is\s+(?:my|the|our)\s+(?:bom|network)\b|\bbom\s+depth\b/i;

interface NetworkMatch { mode: "status" | "structure"; isolated: boolean }

export const networkSkill: Skill = {
  id: "network",
  drafts: false,
  describe: "says whether each network analysis is up to date with your data, and counts the network (nodes, lanes, suppliers per material)",
  example: "are the network metrics up to date?  ·  how big is my network?",
  recognize(input: SkillInput): NetworkMatch | null {
    const u = input.utterance;
    if (RUN_WORDS.test(u)) return null;
    if (STRUCTURE_WORDS.test(u)) return { mode: "structure", isolated: /\bisolated\b/i.test(u) };
    if (STATUS_WORDS.test(u) && ANALYSIS_NOUN.test(u) && !NOT_NETWORK.test(u)) return { mode: "status", isolated: false };
    return null;
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as NetworkMatch;
    const calls: SkillResult["calls"] = [];
    if (m.mode === "status") {
      const env = await callTool(calls, ctx, "get_analysis_status", {});
      const data = tableData(env);
      if (!data) return { reply: String(env.data ?? "I couldn't read the analysis runs."), parts: [], calls, outcome: "error" };
      const all = data.analyses as Provenance[];
      const stale = all.filter((p) => p.run_id && p.is_current === false);
      const current = all.filter((p) => p.run_id && p.is_current);
      const never = all.filter((p) => !p.run_id);
      const bits: string[] = [];
      if (stale.length) {
        bits.push(`**Out of date** (your data changed after they ran): ${stale.map((p) => `${p.label.toLowerCase()} (${p.computed_at ?? "date unknown"}) — re-run on ${p.rerun_at}`).join("; ")}.`);
      }
      if (current.length) bits.push(`Current: ${current.map((p) => `${p.label.toLowerCase()} (${p.computed_at ?? "date unknown"})`).join(", ")}.`);
      if (never.length) bits.push(`Never run: ${never.map((p) => p.label.toLowerCase()).join(", ")}.`);
      const verdict = stale.length
        ? `No — ${plural(stale.length, "analysis", "analyses")} ${stale.length === 1 ? "is" : "are"} out of date.`
        : current.length
        ? "Yes — every analysis that has been run is current with your data."
        : "No network analysis has been run on this project yet.";
      return {
        reply: `${verdict} ${bits.join(" ")} I can't start an analysis from the chat; each one is a single click on the page named.`,
        parts: [{ kind: "table", data: { columns: data.columns, rows: data.rows } }],
        calls,
        outcome: stale.length ? "stale" : current.length ? "current" : "never_run",
      };
    }
    const env = await callTool(calls, ctx, "get_network_structure", {});
    const data = tableData(env);
    if (!data) return { reply: String(env.data ?? "I couldn't read the network."), parts: [], calls, outcome: env.meta.note === "empty" ? "empty" : "error" };
    const s = data.summary as { nodes: number; by_echelon: Record<string, number>; lanes: Record<string, number>; materials_with_supplier: number; suppliers_per_material: number | null; single_sourced_materials: number; bom_depth: number | null };
    const roles = Object.entries(s.by_echelon).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${n} ${e}${n === 1 ? "" : "s"}`).join(", ");
    const lanes = Object.values(s.lanes).reduce((a, b) => a + b, 0);
    let reply = `Your network has ${plural(s.nodes, "node")} (${roles}) and ${plural(lanes, "lane")}.`;
    if (s.suppliers_per_material != null) {
      reply += ` Each purchased material has ${s.suppliers_per_material} suppliers on average; ${s.single_sourced_materials} of ${s.materials_with_supplier} have exactly one.`;
    }
    reply += s.bom_depth != null ? ` The deepest BOM level is ${s.bom_depth}.` : " No BOM depth is recorded.";
    if (m.isolated) {
      const me = await callTool(calls, ctx, "get_network_metrics", { level: "product", measure: "degree", top_n: 1 });
      const md = tableData(me);
      reply += md
        ? ` Isolated nodes (no links on the product-level graph): ${md.summary.isolated_nodes}. ${provenanceLine(md.provenance as Provenance)}`
        : " I can't count isolated nodes: the product-level metrics have not been computed.";
    }
    reply += " Source: the project's node list and lane graph. Density, diameter and clustering are not computed on this platform.";
    return {
      reply,
      parts: [{ kind: "table", data: { columns: data.columns, rows: data.rows } }],
      calls,
      outcome: "counted",
    };
  },
};

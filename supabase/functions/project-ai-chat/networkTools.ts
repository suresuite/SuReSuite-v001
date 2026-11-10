// Network-analysis READ tools (ai-agents.md §28 Phase A, package A.1).
//
// The platform computes critical ("nexus") nodes, centralities and prominence
// and stores each result with the run that produced it. Until this module the
// chat could read none of it, so "which node is most central?" was answered
// from general knowledge. These tools READ THE STORE — they compute no metric:
//
//   get_critical_nodes     the `critical_nodes` run (demand at risk), through
//                          `get_critical_node_stats`, the nexus card's own read;
//   get_network_metrics    product level: the Product-level page's read
//                          (`get_product_level_metrics`); firm level: the
//                          Firm-level page's read for prominence
//                          (`get_network_nodes`) and the stored
//                          `network_metrics` run for the centralities;
//   get_analysis_status    every analysis kind: when it last ran, on which
//                          level, and whether the data has moved since;
//   get_network_structure  node and lane counts — counts of stored rows.
//
// "Current" is never decided here. It is the database's rule
// (`analysis_current_run` / `analysis_run_is_current`, PLAN.md §4 D238): a run
// on the project's current level hash first, the newest otherwise, and then
// the row says it is out of date. Every envelope carries a `provenance` block
// so an answer can name its analysis run, level and date (§28.3 R-source).

import {
  registerToolHandler,
  type ToolContext,
  type ToolDeclaration,
  type ToolEnvelope,
} from "./tools.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };
const dbOf = (ctx: ToolContext): Db => ctx.supabase as unknown as Db;

// ── vocabulary ──────────────────────────────────────────────────────────────

/** The measures `_shared/centrality.ts` computes — the only ones that exist. */
export const NETWORK_MEASURES = [
  "degree", "weighted_degree", "eigenvector", "betweenness", "closeness", "prominence",
] as const;
export type NetworkMeasure = (typeof NETWORK_MEASURES)[number];

/** Measure → the column both metric reads return. */
export const MEASURE_COLUMN: Record<NetworkMeasure, string> = {
  degree: "degree_centrality",
  weighted_degree: "weighted_degree_centrality",
  eigenvector: "eigenvector_centrality",
  betweenness: "betweenness_centrality",
  closeness: "closeness_centrality",
  prominence: "prominence",
};

/** One plain line per measure — stated in every answer that ranks by it. */
export const MEASURE_MEANING: Record<NetworkMeasure, string> = {
  degree: "Degree counts how many other nodes a node is directly linked to — a hub measure.",
  weighted_degree: "Weighted degree adds up the flow on a node's links — a volume measure.",
  eigenvector: "Eigenvector centrality is high for a node linked to other well-linked nodes — an influence measure.",
  betweenness: "Betweenness counts how often a node sits on the shortest route between two others — a bottleneck measure.",
  closeness: "Closeness is high for a node that is few steps from every other node.",
  prominence: "Prominence is the platform's 0–1 blend of connections, revenue, balance and centrality.",
};

export type NetworkLevel = "product" | "firm";

/** Where a user re-runs each analysis kind (the page that owns the button). */
export const ANALYSIS_PAGE: Record<string, string> = {
  critical_nodes: "the Product-level network page (Nexus nodes)",
  product_metrics: "the Product-level network page (Network metrics)",
  network_metrics: "the Firm-level network page",
  prominence: "the Firm-level network page",
  process_structure: "the Process-level network page",
  nexus_stress: "the Simulation Lab (stress test)",
};

export const ANALYSIS_LABEL: Record<string, string> = {
  critical_nodes: "Critical (nexus) nodes",
  product_metrics: "Product-level network metrics",
  network_metrics: "Firm-level network metrics",
  prominence: "Firm-level prominence",
  process_structure: "Process-level structure",
  nexus_stress: "Nexus stress test",
};

/** Kinds a user asks about; `combine_etl` is plumbing, not an analysis. */
const STATUS_KINDS = ["critical_nodes", "product_metrics", "network_metrics", "prominence", "process_structure", "nexus_stress"];

export interface Provenance {
  analysis: string;
  label: string;
  run_id: string | null;
  computed_at: string | null;
  level: string | null;
  is_current: boolean | null;
  /** "store" (an analysis run) or "column" (a value with no run behind it). */
  source: "store" | "column" | "none";
  rerun_at: string;
}

function envelope(tool: string, kind: ToolEnvelope["kind"], data: unknown, row_count: number, note?: string): ToolEnvelope {
  return { kind, data, meta: { tool, row_count, note } };
}
const failed = (tool: string, what: string): ToolEnvelope =>
  envelope(tool, "text",
    `Could not read ${what} for this project — the query failed. This is a lookup failure, NOT a finding. Say the read failed.`,
    0, "error");

const clampN = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (iso: unknown): string | null => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null);

/** One provenance line, the same words in every network answer. */
export function provenanceLine(p: Provenance): string {
  if (p.source === "none" || !p.run_id) return `${p.label} has not been computed for this project.`;
  const when = p.computed_at ? ` of ${p.computed_at}` : "";
  const level = p.level ? `, ${p.level} level` : "";
  const state = p.is_current === false
    ? ` — OUT OF DATE: the ${p.level ?? "project"}-level data changed after it ran; re-run it on ${p.rerun_at}`
    : p.is_current === true ? " — current" : "";
  const src = p.source === "column" ? " (read from the node's stored column: no analysis run stands behind it)" : "";
  return `Source: ${p.label.toLowerCase()} analysis${when}${level}, run ${p.run_id.slice(0, 8)}${src}${state}.`;
}

// ── the run behind a kind, by the database's own rule ───────────────────────

async function runOfKind(ctx: ToolContext, kind: string): Promise<Provenance> {
  const db = dbOf(ctx);
  const base: Provenance = {
    analysis: kind, label: ANALYSIS_LABEL[kind] ?? kind, run_id: null, computed_at: null,
    level: null, is_current: null, source: "none", rerun_at: ANALYSIS_PAGE[kind] ?? "its network page",
  };
  const cur = await db.rpc("analysis_current_run", { _project_id: ctx.projectId, _analysis_kind: kind });
  if (cur.error) throw new Error(cur.error.message ?? "analysis_current_run failed");
  let runId = cur.data ? String(cur.data) : null;
  const isCurrent = runId !== null;
  if (!runId) {
    const latest = await db.rpc("analysis_latest_run", { _project_id: ctx.projectId, _analysis_kind: kind });
    if (latest.error) throw new Error(latest.error.message ?? "analysis_latest_run failed");
    runId = latest.data ? String(latest.data) : null;
  }
  if (!runId) return base;
  const { data: run } = await db.from("analysis_runs")
    .select("id,analysis_kind,status,input_scope,finished_at,started_at")
    .eq("id", runId).maybeSingle();
  return {
    ...base,
    run_id: runId,
    computed_at: day((run as Any)?.finished_at) ?? day((run as Any)?.started_at),
    level: (run as Any)?.input_scope ? String((run as Any).input_scope) : null,
    is_current: isCurrent,
    source: "store",
  };
}

async function namesOf(ctx: ToolContext, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = dbOf(ctx);
  for (const [table, col] of [["suppliers", "supplier_id"], ["materials", "material_id"], ["products", "product_id"], ["customers", "customer_id"]]) {
    try {
      const { data } = await db.from(table).select(`${col},name`).eq("project_id", ctx.projectId).in(col, ids).limit(1000);
      for (const r of (data ?? []) as Any[]) {
        const name = String(r.name ?? "").trim();
        if (name && !out.has(String(r[col]))) out.set(String(r[col]), name);
      }
    } catch { /* a name is decoration; the id is the fact */ }
  }
  return out;
}

const matches = (needle: string, id: string, name: string): boolean => {
  const n = needle.toLowerCase();
  return id.toLowerCase() === n || id.toLowerCase().includes(n) || name.toLowerCase().includes(n);
};

// ── get_critical_nodes ──────────────────────────────────────────────────────

export const getCriticalNodesDeclaration: ToolDeclaration = {
  name: "get_critical_nodes",
  description:
    "Read the project's STORED critical-node (nexus) analysis. A node's score is its DEMAND AT RISK: the share of finished-goods demand that cannot be served if that node alone is lost and nothing is rerouted. Returns nodes ranked by that score with products affected and the materials the node is the only source of, plus the analysis run, its date and whether the data changed since. Use for 'most critical supplier/material/node', 'is X critical', 'why is X nexus'. This is a static estimate, not a simulation result. Computes nothing: when no analysis exists it says so.",
  parameters: {
    type: "object",
    properties: {
      node: { type: "string", description: "Optional node id or name fragment — return that node's score." },
      echelon: { type: "string", description: "Optional role filter: supplier, material, product, customer or plant." },
      top_n: { type: "number", description: "Rows to return (1-50). Default 10." },
    },
  },
};

interface CriticalRow {
  node_id: string; echelon: string | null; score: number; is_critical: boolean; rank: number | null;
  products_affected: number; sole_source_of: string[];
}

async function getCriticalNodes(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_critical_nodes";
  const db = dbOf(ctx);
  const topN = clampN(args.top_n, 10, 1, 50);
  const node = args.node ? String(args.node).trim() : "";
  const echelon = args.echelon ? String(args.echelon).trim().toLowerCase() : "";
  try {
    const { data: stats, error } = await db.rpc("get_critical_node_stats", { p_project_id: ctx.projectId, p_user_id: ctx.userId });
    if (error) return failed(tool, "the critical-node analysis");
    const s = (stats ?? {}) as Any;
    const prov: Provenance = {
      analysis: "critical_nodes", label: ANALYSIS_LABEL.critical_nodes, run_id: s.run_id ? String(s.run_id) : null,
      computed_at: day(s.finished_at), level: "process", is_current: s.run_id ? Boolean(s.is_current) : null,
      source: s.run_id ? "store" : "none", rerun_at: ANALYSIS_PAGE.critical_nodes,
    };
    if (!prov.run_id) {
      return envelope(tool, "text",
        `No critical-node analysis has been run for this project, so there is no ranking to read. Run it on ${prov.rerun_at}. Do not rank nodes from other data and call it "critical".`,
        0, "no_analysis");
    }
    // Every scored node of that run (the RPC returns only the ten highest).
    const all: CriticalRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error: e2 } = await db.from("analysis_results")
        .select("entity_id,entity_type,metrics").eq("run_id", prov.run_id).eq("entity_type", "node")
        .order("entity_id", { ascending: true }).range(from, from + 999);
      if (e2) return failed(tool, "the critical-node results");
      for (const r of (page ?? []) as Any[]) {
        const m = (r.metrics ?? {}) as Any;
        all.push({
          node_id: String(r.entity_id), echelon: null, score: num(m.score) ?? 0, is_critical: m.is_critical === true || m.is_critical === "true",
          rank: num(m.rank), products_affected: num(m.products_affected) ?? 0,
          sole_source_of: Array.isArray(m.sole_source_of) ? m.sole_source_of.map(String) : [],
        });
      }
      if (!page || page.length < 1000) break;
    }
    // The role is READ from node_list.echelon (PLAN.md §4 D127), never inferred.
    const { data: nl } = await db.from("node_list").select("node_id,echelon").eq("project_id", ctx.projectId).limit(10000);
    const echelonOf = new Map<string, string>();
    for (const r of (nl ?? []) as Any[]) if (r.echelon) echelonOf.set(String(r.node_id), String(r.echelon));
    for (const r of all) r.echelon = echelonOf.get(r.node_id) ?? null;

    const ranked = all.filter((r) => r.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
    let rows = echelon ? ranked.filter((r) => r.echelon === echelon) : ranked;
    const names = await namesOf(ctx, (node ? all : rows.slice(0, topN)).map((r) => r.node_id));
    let unranked: CriticalRow[] = [];
    if (node) {
      rows = rows.filter((r) => matches(node, r.node_id, names.get(r.node_id) ?? ""));
      unranked = all.filter((r) => r.rank === null && matches(node, r.node_id, names.get(r.node_id) ?? ""));
    }
    const shown = [...rows.slice(0, topN), ...unranked.slice(0, Math.max(0, topN - rows.length))];
    const summary = {
      method: String(s.method ?? "demand_at_risk"),
      threshold: num(s.threshold) ?? 0.5,
      demand_basis: String(s.demand_basis ?? ""),
      nodes_scored: num(s.total) ?? all.length,
      nexus_nodes: num(s.nexus) ?? all.filter((r) => r.is_critical).length,
      warnings: Array.isArray(s.warnings) ? s.warnings : [],
    };
    if (shown.length === 0) {
      return envelope(tool, "text",
        node
          ? `"${node}" is not a node in the critical-node analysis (${summary.nodes_scored} nodes scored). Check the id.`
          : `The critical-node analysis holds no ${echelon || "ranked"} node.`,
        0, node ? "node_not_found" : "empty");
    }
    return envelope(tool, "table", {
      columns: ["Rank", "Node", "Name", "Role", "Demand at risk", "Nexus", "Products affected", "Only source of"],
      rows: shown.map((r) => [
        r.rank ?? "-", r.node_id, names.get(r.node_id) ?? "-", r.echelon ?? "-",
        `${(r.score * 100).toFixed(1)}%`, r.is_critical ? "Yes" : "-", r.products_affected,
        r.sole_source_of.length ? `${r.sole_source_of.length} material${r.sole_source_of.length === 1 ? "" : "s"}` : "-",
      ]),
      nodes: shown.map((r) => ({ ...r, name: names.get(r.node_id) ?? null })),
      summary,
      provenance: prov,
    }, shown.length, prov.is_current === false ? "stale" : undefined);
  } catch (e) {
    console.warn("get_critical_nodes failed:", (e as Error).message);
    return failed(tool, "the critical-node analysis");
  }
}

// ── get_network_metrics ─────────────────────────────────────────────────────

export const getNetworkMetricsDeclaration: ToolDeclaration = {
  name: "get_network_metrics",
  description:
    "Read the project's STORED network metrics, ranked by one measure: degree, weighted_degree, eigenvector, betweenness, closeness or prominence. level 'product' (default) is the graph the Product-level page draws (supplier → material → product → customer); level 'firm' is the deep-tier firm network. Returns the nodes, the analysis run, its date and whether the data changed since. Use for 'most central node', 'biggest hub', 'bottleneck', 'betweenness of X', 'most prominent firm'. No other metric exists (no PageRank, clustering, density or diameter) — say so. Computes nothing.",
  parameters: {
    type: "object",
    properties: {
      level: { type: "string", description: "'product' (default) or 'firm'." },
      measure: { type: "string", description: "degree | weighted_degree | eigenvector | betweenness | closeness | prominence. Default degree." },
      node: { type: "string", description: "Optional node id or name fragment." },
      echelon: { type: "string", description: "Optional role filter (product level): supplier, material, product, customer." },
      top_n: { type: "number", description: "Rows to return (1-50). Default 10." },
    },
  },
};

async function getNetworkMetrics(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_network_metrics";
  const db = dbOf(ctx);
  const level: NetworkLevel = String(args.level ?? "product").toLowerCase() === "firm" ? "firm" : "product";
  const measureRaw = String(args.measure ?? "degree").toLowerCase().replace(/[\s-]+/g, "_").replace(/_centrality$/, "");
  if (!(NETWORK_MEASURES as readonly string[]).includes(measureRaw)) {
    return envelope(tool, "text",
      `"${String(args.measure)}" is not a metric this platform computes. The stored measures are: ${NETWORK_MEASURES.join(", ")}.`,
      0, "unsupported_metric");
  }
  const measure = measureRaw as NetworkMeasure;
  const col = MEASURE_COLUMN[measure];
  const topN = clampN(args.top_n, 10, 1, 50);
  const node = args.node ? String(args.node).trim() : "";
  const echelon = args.echelon ? String(args.echelon).trim().toLowerCase() : "";
  const kind = level === "product" ? "product_metrics" : measure === "prominence" ? "prominence" : "network_metrics";
  try {
    const label = ANALYSIS_LABEL[kind];
    const rerun = ANALYSIS_PAGE[kind];
    // Rows in ONE shape, whichever read they came from.
    let all: Any[] = [];
    let prov: Provenance | null = null;
    if (level === "product") {
      // The Product-level page's own read.
      const res = await db.rpc("get_product_level_metrics", { p_project_id: ctx.projectId, p_user_id: ctx.userId });
      if (res.error) return failed(tool, "the product-level network metrics");
      all = (res.data ?? []) as Any[];
      const first = all[0];
      if (first) {
        prov = {
          analysis: kind, label, run_id: first.run_id ? String(first.run_id) : null, computed_at: day(first.computed_at),
          level: "process", is_current: first.hash_is_current == null ? null : Boolean(first.hash_is_current),
          source: "store", rerun_at: rerun,
        };
      }
    } else if (measure === "prominence") {
      // The Firm-level page's own read: stored prominence with its provenance.
      const res = await db.rpc("get_network_nodes", { p_project_id: ctx.projectId, p_user_id: ctx.userId, p_user_email: ctx.draft?.userEmail ?? "" });
      if (res.error) return failed(tool, "the firm-level network");
      all = ((res.data ?? []) as Any[]).filter((r) => num(r.prominence) !== null && String(r.metrics_source ?? "none") !== "none");
      const first = all.find((r) => r.metrics_run_id) ?? all[0];
      if (first) {
        prov = {
          analysis: kind, label, run_id: first.metrics_run_id ? String(first.metrics_run_id) : null,
          computed_at: day(first.metrics_computed_at), level: "firm",
          is_current: first.hash_is_current == null ? null : Boolean(first.hash_is_current),
          source: String(first.metrics_source) === "store" ? "store" : "column", rerun_at: rerun,
        };
      }
    } else {
      // Firm-level centralities: the stored `network_metrics` run, found by the
      // database's own current-else-latest rule. No page-level read returns
      // every firm node's centralities, so the store is read directly.
      const run = await runOfKind(ctx, "network_metrics");
      if (run.run_id) {
        prov = run;
        const { data: nn } = await db.from("network_nodes").select("uid,name").eq("project_id", ctx.projectId).limit(20000);
        const nameOf = new Map<string, string>();
        for (const r of (nn ?? []) as Any[]) if (r.name) nameOf.set(String(r.uid), String(r.name));
        for (let from = 0; ; from += 1000) {
          const { data: page, error: e2 } = await db.from("analysis_results")
            .select("entity_id,entity_type,metrics").eq("run_id", run.run_id).eq("entity_type", "node")
            .order("entity_id", { ascending: true }).range(from, from + 999);
          if (e2) return failed(tool, "the firm-level network metrics");
          for (const r of (page ?? []) as Any[]) {
            const mt = (r.metrics ?? {}) as Any;
            all.push({ uid: String(r.entity_id), name: nameOf.get(String(r.entity_id)) ?? null, ...mt, connection_count: mt.connections ?? null });
          }
          if (!page || page.length < 1000) break;
        }
      }
    }
    let rows = all.filter((r) => num(r[col]) !== null);
    if (rows.length === 0 || !prov) {
      return envelope(tool, "text",
        level === "firm"
          ? `No firm-level ${measure === "prominence" ? "prominence" : "network metrics"} are stored for this project. They exist only when a deep-tier (firm) network is uploaded and analysed on ${rerun}.`
          : `No product-level network metrics have been computed for this project. Run them on ${rerun}.`,
        0, "no_analysis");
    }
    const total = rows.length;
    if (echelon) rows = rows.filter((r) => String(r.echelon ?? "").toLowerCase() === echelon);
    if (node) rows = rows.filter((r) => matches(node, String(r.uid ?? r.id), String(r.name ?? "")));
    rows.sort((a, b) => (num(b[col]) as number) - (num(a[col]) as number) || String(a.uid ?? a.id).localeCompare(String(b.uid ?? b.id)));
    if (rows.length === 0) {
      return envelope(tool, "text",
        node ? `"${node}" is not a node of the ${level}-level graph (${total} nodes have metrics).` : `No ${echelon} node has a stored ${measure} value.`,
        0, node ? "node_not_found" : "empty");
    }
    const shown = rows.slice(0, topN);
    const isolated = level === "product" ? all.filter((r) => (num(r.connection_count) ?? 0) === 0).length : null;
    return envelope(tool, "table", {
      columns: ["#", "Node", "Name", ...(level === "product" ? ["Role"] : []), measure, "Links"],
      rows: shown.map((r, i) => [
        i + 1, String(r.uid ?? r.id), String(r.name ?? "-"), ...(level === "product" ? [String(r.echelon ?? "-")] : []),
        Number((num(r[col]) as number).toFixed(4)), num(r.connection_count) ?? "-",
      ]),
      nodes: shown.map((r) => ({
        node_id: String(r.uid ?? r.id), name: r.name ? String(r.name) : null, echelon: r.echelon ? String(r.echelon) : null,
        value: num(r[col]), connections: num(r.connection_count),
      })),
      summary: { level, measure, meaning: MEASURE_MEANING[measure], nodes_with_metrics: total, isolated_nodes: isolated },
      provenance: prov,
    }, shown.length, prov.is_current === false ? "stale" : undefined);
  } catch (e) {
    console.warn("get_network_metrics failed:", (e as Error).message);
    return failed(tool, `the ${level}-level network metrics`);
  }
}

// ── get_analysis_status ─────────────────────────────────────────────────────

export const getAnalysisStatusDeclaration: ToolDeclaration = {
  name: "get_analysis_status",
  description:
    "For every network analysis of this project (critical nodes, product-level metrics, firm-level metrics, prominence, process structure, nexus stress test): when it last ran, on which data level, and whether the project's data has changed since (current / out of date / never run), with the page that re-runs it. Use for 'are the metrics up to date', 'when were critical nodes computed', 'do I need to re-run the analysis'.",
  parameters: { type: "object", properties: {} },
};

async function getAnalysisStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_analysis_status";
  try {
    const provs: Provenance[] = [];
    for (const kind of STATUS_KINDS) provs.push(await runOfKind(ctx, kind));
    return envelope(tool, "table", {
      columns: ["Analysis", "Last computed", "Data level", "State", "Re-run on"],
      rows: provs.map((p) => [
        p.label, p.computed_at ?? "-", p.level ?? "-",
        !p.run_id ? "never run" : p.is_current ? "current" : "out of date", p.rerun_at,
      ]),
      analyses: provs,
    }, provs.length);
  } catch (e) {
    console.warn("get_analysis_status failed:", (e as Error).message);
    return failed(tool, "the analysis runs");
  }
}

// ── get_network_structure ───────────────────────────────────────────────────

export const getNetworkStructureDeclaration: ToolDeclaration = {
  name: "get_network_structure",
  description:
    "Count the project's network: nodes by role (supplier, material, product, customer, plant, subassembly), lanes by kind (inbound, bom, outbound), suppliers per purchased material (average, and how many have exactly one), and the deepest BOM level. Counts of stored rows only — no density, diameter or clustering exists on this platform. Use for 'how big is my network', 'how many tiers', 'how many suppliers per material'.",
  parameters: { type: "object", properties: {} },
};

async function getNetworkStructure(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_network_structure";
  const db = dbOf(ctx);
  try {
    const { data: nl, error } = await db.from("node_list").select("node_id,echelon,bom_depth").eq("project_id", ctx.projectId).limit(20000);
    if (error) return failed(tool, "the node list");
    const nodes = (nl ?? []) as Any[];
    if (nodes.length === 0) {
      return envelope(tool, "text", "This project has no node list yet — upload logistics and BOM data and combine the project first.", 0, "empty");
    }
    const byEchelon = new Map<string, number>();
    let depth: number | null = null;
    for (const n of nodes) {
      const e = n.echelon ? String(n.echelon) : "unclassified";
      byEchelon.set(e, (byEchelon.get(e) ?? 0) + 1);
      const d = num(n.bom_depth);
      if (d !== null && (depth === null || d > depth)) depth = d;
    }
    const suppliersOf = new Map<string, Set<string>>();
    const laneKinds = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data: page, error: e2 } = await db.from("supply_chain_data")
        .select("id,data_source,from_location,to_location").eq("project_id", ctx.projectId)
        .order("id", { ascending: true }).range(from, from + 999);
      if (e2) return failed(tool, "the lane graph");
      for (const r of (page ?? []) as Any[]) {
        const kind = String(r.data_source ?? "").toLowerCase();
        if (kind === "multi_tier") continue;
        laneKinds.set(kind || "unknown", (laneKinds.get(kind || "unknown") ?? 0) + 1);
        if (kind === "inbound" && r.from_location && r.to_location) {
          const m = String(r.to_location);
          if (!suppliersOf.has(m)) suppliersOf.set(m, new Set());
          suppliersOf.get(m)!.add(String(r.from_location));
        }
      }
      if (!page || page.length < 1000) break;
    }
    const mats = suppliersOf.size;
    const single = [...suppliersOf.values()].filter((s) => s.size === 1).length;
    const avg = mats ? [...suppliersOf.values()].reduce((a, s) => a + s.size, 0) / mats : null;
    const rows: Array<[string, string | number]> = [["Nodes", nodes.length]];
    for (const [e, n] of [...byEchelon.entries()].sort((a, b) => b[1] - a[1])) rows.push([`  ${e}`, n]);
    for (const [k, n] of [...laneKinds.entries()].sort()) rows.push([`Lanes: ${k}`, n]);
    if (mats) {
      rows.push(["Purchased materials with a supplier", mats]);
      rows.push(["Suppliers per material (average)", Number((avg as number).toFixed(2))]);
      rows.push(["Materials with exactly one supplier", single]);
    }
    rows.push(["Deepest BOM level", depth ?? "not recorded"]);
    return envelope(tool, "table", {
      columns: ["Measure", "Value"],
      rows,
      summary: {
        nodes: nodes.length, by_echelon: Object.fromEntries(byEchelon), lanes: Object.fromEntries(laneKinds),
        materials_with_supplier: mats, suppliers_per_material: avg === null ? null : Number(avg.toFixed(2)),
        single_sourced_materials: single, bom_depth: depth,
      },
    }, rows.length);
  } catch (e) {
    console.warn("get_network_structure failed:", (e as Error).message);
    return failed(tool, "the network structure");
  }
}

registerToolHandler("get_critical_nodes", getCriticalNodes);
registerToolHandler("get_network_metrics", getNetworkMetrics);
registerToolHandler("get_analysis_status", getAnalysisStatus);
registerToolHandler("get_network_structure", getNetworkStructure);

/** The persona read surface gains these (personaTools.ts, §19.3's exposure law). */
export const networkToolDeclarations: ReadonlyArray<ToolDeclaration> = [
  getCriticalNodesDeclaration,
  getNetworkMetricsDeclaration,
  getAnalysisStatusDeclaration,
  getNetworkStructureDeclaration,
];

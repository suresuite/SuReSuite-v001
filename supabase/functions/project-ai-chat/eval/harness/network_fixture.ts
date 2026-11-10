// A NETWORK-HEAVY stub project for the Phase A suites (ai-agents.md §28).
//
// Three suppliers, three materials, two products, two customers, with a
// stored critical-node run and a stored product-metrics run, so the network
// skills have an analysis store to read:
//
//   S2 (Borealis) is the ONLY source of MAT-5 and MAT-6, which both products
//      need → 100% of demand at risk, nexus, rank 1.
//   S1 (Acme)     shares MAT-4 with S3 → 30% at risk, rank 2.
//   S3 (Cobalt)   → 12% at risk, rank 3.
//
// WHAT THE STUB RPCS ARE. They mirror the SQL reads' SHAPE
// (`get_critical_node_stats`, `get_product_level_metrics`,
// `get_network_nodes`, `analysis_current_run`,
// `analysis_latest_run`); they do not re-prove the SQL. The real functions are
// proved against PostgreSQL by supabase/rehearsal. What this fixture pins is
// what the CHAT does with what they return.

import type { Row, RpcHandler } from "./stub_db.ts";

export const NET_PROJECT = "11111111-1111-4111-8111-111111111111";
export const CRIT_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
export const PM_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";
export const FIRM_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccc03";

export interface NetworkOptions {
  /** false ⇒ the project has data but no analysis has ever run. */
  analysed?: boolean;
  /** true ⇒ the data changed after the analyses ran (no CURRENT run). */
  stale?: boolean;
  /** true ⇒ a deep-tier firm network with stored metrics exists. */
  firm?: boolean;
}

const P = NET_PROJECT;

export function networkProject(t: Record<string, Row[]>, rpcs: Record<string, RpcHandler>, opts: NetworkOptions = {}): void {
  const analysed = opts.analysed !== false;
  const stale = opts.stale === true;

  t.suppliers.push(
    { project_id: P, supplier_id: "S2", name: "Borealis", capacity_per_week: 900, reliability_score: 0.9 },
    { project_id: P, supplier_id: "S3", name: "Cobalt", capacity_per_week: 700, reliability_score: 0.92 },
  );
  t.materials.push(
    { project_id: P, material_id: "MAT-5", name: "Housing", cost: 2.1, moq: 50, holding_cost_pct: 0.2 },
    { project_id: P, material_id: "MAT-6", name: "Controller", cost: 9.5, moq: 20, holding_cost_pct: 0.2 },
  );
  t.products.push({ project_id: P, product_id: "P2", name: "Gadget", sell_price: 40, production_capacity: 300, demand_mean: 200, demand_cv: 0.3 });
  t.customers = [
    { project_id: P, customer_id: "C1", name: "Northwind" },
    { project_id: P, customer_id: "C2", name: "Contoso" },
  ];

  const node = (node_id: string, echelon: string, bom_depth: number | null = null): Row =>
    ({ project_id: P, node_id, echelon, node_type: echelon, bom_depth });
  t.node_list = [
    node("S1", "supplier"), node("S2", "supplier"), node("S3", "supplier"),
    node("MAT-4", "material", 1), node("MAT-5", "material", 1), node("MAT-6", "material", 2),
    node("P1", "product", 0), node("P2", "product", 0),
    node("C1", "customer"), node("C2", "customer"),
  ];
  const lane = (i: number, data_source: string, from_location: string, to_location: string): Row =>
    ({ id: i, project_id: P, data_source, from_location, to_location });
  t.supply_chain_data = [
    lane(1, "inbound", "S1", "MAT-4"), lane(2, "inbound", "S3", "MAT-4"),
    lane(3, "inbound", "S2", "MAT-5"), lane(4, "inbound", "S2", "MAT-6"),
    lane(5, "bom", "MAT-4", "P1"), lane(6, "bom", "MAT-5", "P1"),
    lane(7, "bom", "MAT-5", "P2"), lane(8, "bom", "MAT-6", "P2"),
    lane(9, "outbound", "P1", "C1"), lane(10, "outbound", "P2", "C2"),
    lane(11, "multi_tier", "X", "Y"), // never counted on the product-level graph
  ];

  t.analysis_runs = [];
  t.analysis_results = [];
  if (analysed) {
    t.analysis_runs.push(
      { id: CRIT_RUN, project_id: P, analysis_kind: "critical_nodes", status: "succeeded", input_scope: "process",
        started_at: "2026-11-03T09:00:00Z", finished_at: "2026-11-03T09:00:02Z",
        params: { method: "demand_at_risk", threshold: 0.5 }, row_counts: { demand_basis: "weekly_volume" }, warnings: [] },
      { id: PM_RUN, project_id: P, analysis_kind: "product_metrics", status: "succeeded", input_scope: "process",
        started_at: "2026-11-03T09:01:00Z", finished_at: "2026-11-03T09:01:01Z", params: {}, row_counts: {}, warnings: [] },
    );
    const crit = (entity_id: string, score: number, rank: number | null, products_affected: number, sole: string[]): Row => ({
      run_id: CRIT_RUN, entity_type: "node", entity_id,
      metrics: { score, is_critical: score >= 0.5, rank, products_affected, sole_source_of: sole, betweenness: 0 },
    });
    t.analysis_results.push(
      crit("S2", 1, 1, 2, ["MAT-5", "MAT-6"]),
      crit("MAT-5", 1, 2, 2, []),
      crit("MAT-6", 0.4, 3, 1, []),
      crit("S1", 0.3, 4, 1, []),
      crit("S3", 0.12, 5, 1, []),
      crit("C1", 0, null, 0, []),
    );
    const pm = (entity_id: string, entity_type: string, m: Record<string, number>): Row =>
      ({ run_id: PM_RUN, entity_type, entity_id, metrics: m });
    t.analysis_results.push(
      pm("MAT-5", "material", { degree_centrality: 0.33, weighted_degree_centrality: 0.5, eigenvector_centrality: 0.61, betweenness_centrality: 0.41, closeness_centrality: 0.55, prominence: 0.7, connections: 3 }),
      pm("S2", "supplier", { degree_centrality: 0.22, weighted_degree_centrality: 0.4, eigenvector_centrality: 0.5, betweenness_centrality: 0.1, closeness_centrality: 0.4, prominence: 0.6, connections: 2 }),
      pm("P1", "product", { degree_centrality: 0.33, weighted_degree_centrality: 0.6, eigenvector_centrality: 0.58, betweenness_centrality: 0.33, closeness_centrality: 0.5, prominence: 0.65, connections: 3 }),
      pm("S1", "supplier", { degree_centrality: 0.11, weighted_degree_centrality: 0.2, eigenvector_centrality: 0.2, betweenness_centrality: 0, closeness_centrality: 0.3, prominence: 0.3, connections: 1 }),
      pm("C2", "customer", { degree_centrality: 0, weighted_degree_centrality: 0, eigenvector_centrality: 0, betweenness_centrality: 0, closeness_centrality: 0, prominence: 0, connections: 0 }),
    );
    if (opts.firm) {
      t.analysis_runs.push({ id: FIRM_RUN, project_id: P, analysis_kind: "network_metrics", status: "succeeded", input_scope: "firm",
        started_at: "2026-11-02T08:00:00Z", finished_at: "2026-11-02T08:00:05Z", params: {}, row_counts: {}, warnings: [] });
    }
  }

  const runsOf = (kind: unknown) => (t.analysis_runs ?? []).filter((r) => r.analysis_kind === kind && r.status === "succeeded");
  rpcs.analysis_current_run = (a) => (stale ? null : (runsOf(a._analysis_kind)[0]?.id ?? null));
  rpcs.analysis_latest_run = (a) => runsOf(a._analysis_kind)[0]?.id ?? null;

  const nameOf = (id: string): string => {
    for (const [table, col] of [["suppliers", "supplier_id"], ["materials", "material_id"], ["products", "product_id"], ["customers", "customer_id"]]) {
      const r = (t[table] ?? []).find((x) => String(x[col]) === id);
      if (r?.name) return String(r.name);
    }
    return id;
  };

  rpcs.get_critical_node_stats = () => {
    const run = runsOf("critical_nodes")[0];
    if (!run) return { run_id: null };
    const rows = t.analysis_results.filter((r) => r.run_id === run.id && r.entity_type === "node");
    const m = (r: Row) => r.metrics as Record<string, unknown>;
    return {
      run_id: run.id, finished_at: run.finished_at, is_current: !stale,
      method: "demand_at_risk", threshold: 0.5, demand_basis: "weekly_volume", warnings: [],
      total: rows.length, nexus: rows.filter((r) => m(r).is_critical).length,
      top: rows.filter((r) => m(r).rank != null).sort((a, b) => Number(m(a).rank) - Number(m(b).rank)).slice(0, 10)
        .map((r) => ({ node_id: r.entity_id, ...m(r) })),
    };
  };

  rpcs.get_product_level_metrics = () => {
    const run = runsOf("product_metrics")[0];
    if (!run) return [];
    return t.analysis_results.filter((r) => r.run_id === run.id).map((r) => {
      const m = r.metrics as Record<string, number>;
      return {
        id: r.entity_id, uid: r.entity_id, name: nameOf(String(r.entity_id)), echelon: r.entity_type, flow: null,
        degree_centrality: m.degree_centrality, weighted_degree_centrality: m.weighted_degree_centrality,
        eigenvector_centrality: m.eigenvector_centrality, betweenness_centrality: m.betweenness_centrality,
        closeness_centrality: m.closeness_centrality, prominence: m.prominence, connection_count: m.connections,
        metrics_source: "store", run_id: run.id, computed_from_hash: "h", computed_at: run.finished_at, hash_is_current: !stale,
      };
    });
  };

  // The firm level: a deep-tier network with stored prominence (its own run)
  // and stored centralities (the network_metrics run).
  t.network_nodes = [];
  if (opts.firm && analysed) {
    const PROM_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccc04";
    t.analysis_runs.push({ id: PROM_RUN, project_id: P, analysis_kind: "prominence", status: "succeeded", input_scope: "firm",
      started_at: "2026-11-02T08:01:00Z", finished_at: "2026-11-02T08:01:03Z", params: {}, row_counts: {}, warnings: [] });
    const firm = (uid: string, name: string, prominence: number, betweenness: number, connections: number) => {
      t.network_nodes.push({ project_id: P, uid, name, prominence });
      t.analysis_results.push({ run_id: FIRM_RUN, entity_type: "node", entity_id: uid, metrics: {
        connections, degree_centrality: connections / 10, weighted_degree_centrality: connections / 10,
        eigenvector_centrality: prominence / 2, betweenness_centrality: betweenness, closeness_centrality: 0.3 } });
    };
    firm("F-TTI", "TTI Inc", 0.82, 0.3, 7);
    firm("F-MIC", "Microtec", 0.55, 0.6, 4);
    firm("F-ZED", "Zed GmbH", 0.2, 0, 1);
    rpcs.get_network_nodes = () => t.network_nodes.map((n) => ({
      ...n, metrics_source: "store", metrics_run_id: PROM_RUN, metrics_computed_at: "2026-11-02T08:01:03Z", hash_is_current: !stale,
    }));
  } else {
    rpcs.get_network_nodes = () => [];
  }
}

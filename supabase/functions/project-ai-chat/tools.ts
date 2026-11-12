// Supply-chain tool registry for the AI chatbot.
// Each tool is scoped to a project, validates inputs, and returns a strict
// { kind, data, meta } envelope so the UI can pick a renderer.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { tryConsumeToolCall, type RequestBudget } from "./budgets.ts";

// "proposal" is the Layer B draft-tool envelope kind (ai-agents.md §4.5):
// rendered by ProposalCard; no Stage 0 tool emits it yet. "plan" is the §21.1
// rule-5 envelope kind (Phase H3): rendered by PlanCard, exactly the
// "proposal" precedent — only update_task_plan (planTools.ts) emits it.
export type ToolKind = "table" | "kpi" | "bullets" | "text" | "proposal" | "plan";

export interface ToolEnvelope {
  kind: ToolKind;
  data: unknown;
  meta: { tool: string; row_count: number; note?: string };
}

/** Attribution + authorization the draft_* tool family needs beyond the read
 * scope (ai-agents.md §4.5, §13.2 checkpoint 3). Layer A persona turns never
 * set it — a draft handler invoked without it refuses `agent_disabled`. */
export interface DraftAttribution {
  userEmail: string | null;
  threadId: string | null;
  modelCode: string | null;
  providerCode: string | null;
  /** `agent_proposals` capability resolved server-side (checkpoint 3). */
  canProposals: boolean;
  /** The routed utterance — cited on user_supplied rows (kind user_message). */
  utterance: string;
  /** The thread's §15 interaction mode — lets the one ask-mode-routable
   * agent (report-builder, §16.1) phrase its refusals per mode. Absent ⇒
   * 'review' (the pre-§15 behavior). */
  mode?: "ask" | "review";
  /** The routed agent slug (Phase H3) — recorded on the chat_plans row the
   * update_task_plan handler writes (§21.2 agent_id). Attribution only. */
  agentId?: string;
}

export interface ToolContext {
  projectId: string;
  userId: string;
  supabase: SupabaseClient;
  draft?: DraftAttribution;
  /** §20.2 (Phase H2): the turn's cache-check record — appended by the
   * find_completed_run handler with each resolved (scenario, version) pair so
   * the draft_experiment_spec cache_hit guard can tell deterministically
   * whether the cache was already consulted this turn. Per-request state,
   * like the context itself; never persisted. */
  cacheChecks?: Array<{ scenario_id: string; policy_version_id: string }>;
  /** §21.5 (Phase H3): the request's spend meters. Set once per request by
   * the orchestrator; executeTool consumes the tool-call counter. Absent ⇒
   * unmetered (direct handler calls in the eval tier are unchanged). */
  budget?: RequestBudget;
  /** §21.3 telemetry recorded by the update_task_plan handler (plan.created /
   * plan.step_changed); the orchestrator emits after the turn (§7.5: ids and
   * counts only). Per-request state, never persisted. */
  planEvents?: Array<{ kind: "plan.created" | "plan.step_changed" | "plan.closed"; payload: Record<string, unknown> }>;
  /** The plan this request touched (drives the §21.3 integrity sweep). */
  planTouchedId?: string;
  /** §18.2 stages 2–4 (Phase 4b): the extraction sub-call seam. The B8
   * ingest handler uses this injected temperature-0 JSON call when present
   * (the eval tier scripts it) and falls back to the provider registry
   * (`makeExtractor`) otherwise. Absent everywhere else ⇒ zero behavior
   * change. */
  extract?: (prompt: string) => Promise<string>;
}

function envelope(
  tool: string,
  kind: ToolKind,
  data: unknown,
  row_count: number,
  note?: string,
): ToolEnvelope {
  return { kind, data, meta: { tool, row_count, note } };
}

function empty(tool: string, note = "No data available for this project."): ToolEnvelope {
  return envelope(tool, "text", note, 0, "empty");
}

/** A read that FAILED, as distinct from a read that came back empty.
 *
 * These two used to collapse: every catch below returned empty(), so a
 * database error reached the model as "No data available for this project"
 * and the model would tell the user, in good faith, that their project has no
 * suppliers. note:"error" is the Layer B posture already used by
 * draftTools.ts::get_data_completeness and its siblings — the model can see
 * the read failed and say so instead of reporting an empty project. */
function errored(tool: string, what: string): ToolEnvelope {
  return envelope(
    tool,
    "text",
    `Could not read ${what} for this project — the query failed. This is a lookup failure, ` +
      `NOT a finding that the project has no data. Say the read failed; do not report an empty result.`,
    0,
    "error",
  );
}

// ---------- Gemini function declarations (server-side only) ----------

// Shape of one function declaration as the providers send it. Layer B agent
// turns pass least-privilege subsets of these through runChat's optional
// `tools` parameter (bridge 1, ai-agents.md §3.2).
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const toolDeclarations = [
  {
    name: "list_project_entities",
    description:
      "List suppliers, customers, materials and plants known for the project. Use this FIRST when the user mentions an entity by name so you can resolve it to a canonical id before calling other tools.",
    parameters: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["supplier", "customer", "material", "plant", "all"],
          description: "Which kind of entity to list. Use 'all' if unsure.",
        },
        limit: { type: "number", description: "Max rows to return (1-100). Default 25." },
      },
      required: ["entity_type"],
    },
  },
  {
    name: "get_supplier_risk",
    description:
      "Rank suppliers by risk for the project, computed from procurement (inbound) logistics and node criticality: how many materials each supplier provides, how many of those it is the SOLE source for, its average lead time and total spend, plus any critical-node flag/score. Optionally filter by supplier id.",
    parameters: {
      type: "object",
      properties: {
        supplier: { type: "string", description: "Optional supplier id/name fragment to filter by." },
        top_n: { type: "number", description: "Return only the top N suppliers by risk. Default 10." },
      },
    },
  },
  {
    name: "get_procurement_spend",
    description:
      "Aggregate procurement spend (inbound volume × unit price) for the project, grouped by supplier or material. Useful for top-spend questions and concentration analysis. If the project has no unit prices, falls back to ranking by purchased volume.",
    parameters: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["supplier", "material"],
          description: "Dimension to aggregate spend on.",
        },
        top_n: { type: "number", description: "Top N rows to return. Default 10." },
      },
      required: ["group_by"],
    },
  },
  {
    name: "get_material_risk",
    description:
      "Identify materials at risk from inbound logistics: number of distinct suppliers (single-sourced = high risk), average lead time, and spend, with criticality enrichment when available. Returns rows ranked by risk.",
    parameters: {
      type: "object",
      properties: {
        material: { type: "string", description: "Optional material id/name fragment to filter on." },
        only_single_source: { type: "boolean", description: "If true, return only single-sourced materials." },
        top_n: { type: "number", description: "Top N rows. Default 15." },
      },
    },
  },
  {
    name: "recommend_disruption_strategy",
    description:
      "Given a disruption (target node id/name and disruption type), return ranked recovery playbooks with rationale. Use when the user describes a hypothetical outage, shortage, or shock.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Node id, supplier name, or material affected." },
        disruption_type: {
          type: "string",
          enum: ["supplier_outage", "material_shortage", "lead_time_shock", "demand_surge", "nexus_attack"],
        },
        magnitude_pct: { type: "number", description: "Severity 0-100. Default 50." },
      },
      required: ["disruption_type"],
    },
  },
] as const;

// ---------- Handlers ----------

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolEnvelope>;

/** Numeric arg coercion + bounds for tool parameters. Exported so the Layer B
 * tool modules clamp their own top_n the same way rather than re-deriving it. */
export const clamp = (n: unknown, fallback: number, min = 1, max = 100): number => {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
};

// Collect distinct string values of a column for the project (Supabase JS has no DISTINCT).
async function distinctCol(ctx: ToolContext, table: string, col: string): Promise<string[]> {
  const { data, error } = await ctx.supabase
    .from(table)
    .select(col)
    .eq("project_id", ctx.projectId)
    .limit(10000);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const v = row[col];
    if (v != null && String(v).trim() !== "") set.add(String(v));
  }
  return [...set];
}

async function listProjectEntities(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const entityType = String(args.entity_type ?? "all");
  const limit = clamp(args.limit, 25, 1, 100);
  const want = (t: string) => entityType === "all" || entityType === t;
  const out: Array<{ type: string; id: string; label: string }> = [];

  try {
    // Prefer the canonical node_list (carries node_type) when it has rows.
    const { data: nodes } = await ctx.supabase
      .from("node_list")
      .select("node_id, node_type, node_group")
      .eq("project_id", ctx.projectId)
      .limit(2000);

    if (nodes && nodes.length > 0) {
      for (const n of nodes as Record<string, unknown>[]) {
        const t = String(n.node_type ?? "node").toLowerCase();
        if (want(t)) out.push({ type: t, id: String(n.node_id), label: String(n.node_id) });
      }
    } else {
      // Fall back to the source-of-truth logistics/BOM tables.
      if (want("supplier")) for (const id of await distinctCol(ctx, "inbound_logistics", "supplier_id")) out.push({ type: "supplier", id, label: id });
      if (want("customer")) for (const id of await distinctCol(ctx, "outbound_logistics", "customer_id")) out.push({ type: "customer", id, label: id });
      if (want("material")) {
        const mats = new Set<string>([
          ...await distinctCol(ctx, "inbound_logistics", "material_id"),
          ...await distinctCol(ctx, "bom_multi_level", "material_id").catch(() => []),
        ]);
        for (const id of mats) out.push({ type: "material", id, label: id });
      }
      if (want("product")) for (const id of await distinctCol(ctx, "outbound_logistics", "product_id")) out.push({ type: "product", id, label: id });
      if (want("plant")) for (const id of await distinctCol(ctx, "node_list", "plant_name").catch(() => [])) out.push({ type: "plant", id, label: id });
    }
  } catch (e) {
    // A failed read is not an empty project — see errored(). Returning here
    // keeps the two apart; falling through would have reported "no entities".
    console.warn("list_project_entities query failed:", (e as Error).message);
    return errored("list_project_entities", "this project's entity list");
  }

  if (out.length === 0) return empty("list_project_entities");

  // §19.5 (ai-agents.md §10 entry 38(t)): label each master-backed entity with
  // its master NAME, as resolveEntity already matches on — an id-only label
  // left "what does acme supply?" unanswerable from this list, because the
  // user's word ("ACME NORTH") never appeared in it. Names are enrichment: a
  // failed read keeps the id label (masterNames logs and returns empty).
  const MASTER: Record<string, [string, string]> = {
    supplier: ["suppliers", "supplier_id"],
    customer: ["customers", "customer_id"],
    material: ["materials", "material_id"],
    product: ["products", "product_id"],
  };
  for (const [type, [table, idCol]] of Object.entries(MASTER)) {
    if (!out.some((r) => r.type === type)) continue;
    const names = await masterNames(ctx, table, idCol);
    for (const r of out) if (r.type === type && names.has(r.id)) r.label = names.get(r.id)!;
  }

  const rows = out.slice(0, limit);
  return envelope("list_project_entities", "table", {
    columns: ["type", "id", "label"],
    rows: rows.map((r) => [r.type, r.id, r.label]),
  }, rows.length);
}

// Shared loader: all inbound procurement rows for the project.
interface InboundRow { supplier_id: string; material_id: string; volume: number; unit_price: number; lead_time: number | null }
async function loadInbound(ctx: ToolContext): Promise<InboundRow[]> {
  const { data, error } = await ctx.supabase
    .from("inbound_logistics")
    .select("supplier_id, material_id, volume, unit_price, lead_time")
    .eq("project_id", ctx.projectId)
    .limit(10000);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    supplier_id: String(r.supplier_id ?? "unknown"),
    material_id: String(r.material_id ?? "unknown"),
    volume: Number(r.volume ?? 0) || 0,
    unit_price: Number(r.unit_price ?? 0) || 0,
    lead_time: r.lead_time == null ? null : Number(r.lead_time),
  }));
}

// Map node_id -> critical info, for a given node_type, from node_list.
async function criticalityMap(ctx: ToolContext, nodeType: string): Promise<Map<string, { critical: boolean; score: number | null }>> {
  const map = new Map<string, { critical: boolean; score: number | null }>();
  try {
    const { data } = await ctx.supabase
      .from("node_list")
      .select("node_id, node_type, is_critical_node, critical_node_score")
      .eq("project_id", ctx.projectId)
      .eq("node_type", nodeType)
      .limit(5000);
    for (const n of (data ?? []) as any[]) {
      map.set(String(n.node_id), { critical: Boolean(n.is_critical_node), score: n.critical_node_score == null ? null : Number(n.critical_node_score) });
    }
  } catch (e) {
    // Enrichment is best-effort, but stay loud: a silent failure here makes
    // every supplier render as non-critical, which reads as a finding.
    console.warn("criticalityMap enrichment failed:", (e as Error).message);
  }
  return map;
}

async function getSupplierRisk(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const supplier = args.supplier ? String(args.supplier).toLowerCase() : null;
  const topN = clamp(args.top_n, 10, 1, 50);

  try {
    const inbound = await loadInbound(ctx);
    if (inbound.length === 0) return empty("get_supplier_risk");

    // Suppliers per material (to find sole-sourced materials).
    const suppliersByMaterial = new Map<string, Set<string>>();
    for (const r of inbound) {
      if (!suppliersByMaterial.has(r.material_id)) suppliersByMaterial.set(r.material_id, new Set());
      suppliersByMaterial.get(r.material_id)!.add(r.supplier_id);
    }

    interface Agg { materials: Set<string>; leadSum: number; leadN: number; spend: number }
    const agg = new Map<string, Agg>();
    for (const r of inbound) {
      const a = agg.get(r.supplier_id) ?? { materials: new Set(), leadSum: 0, leadN: 0, spend: 0 };
      a.materials.add(r.material_id);
      a.spend += r.volume * r.unit_price;
      if (r.lead_time != null && Number.isFinite(r.lead_time)) { a.leadSum += r.lead_time; a.leadN += 1; }
      agg.set(r.supplier_id, a);
    }

    const crit = await criticalityMap(ctx, "supplier");

    let rows = [...agg.entries()].map(([sid, a]) => {
      const sole = [...a.materials].filter((m) => (suppliersByMaterial.get(m)?.size ?? 0) <= 1).length;
      const c = crit.get(sid);
      return {
        supplier: sid,
        critical: c?.critical ? "Yes" : "-",
        score: c?.score ?? null,
        materials: a.materials.size,
        sole,
        avgLead: a.leadN ? a.leadSum / a.leadN : null,
        spend: a.spend,
      };
    });

    if (supplier) rows = rows.filter((r) => r.supplier.toLowerCase().includes(supplier));
    // Rank by EXPOSURE: most sole-sourced first, then demand at risk, then
    // spend. "Most critical" is get_critical_nodes' ranking (§28 decision 1);
    // the declaration's wording is pinned by the flags-off golden transcripts,
    // so the distinction is stated in the COLUMNS and in get_critical_nodes.
    rows.sort((x, y) => y.sole - x.sole || (y.score ?? 0) - (x.score ?? 0) || y.spend - x.spend);
    rows = rows.slice(0, topN);
    if (rows.length === 0) return empty("get_supplier_risk");

    return envelope("get_supplier_risk", "table", {
      columns: ["Supplier", "Nexus", "Demand at risk", "# Materials", "# Sole-sourced", "Avg Lead Time", "Spend"],
      rows: rows.map((r) => [
        r.supplier,
        r.critical,
        r.score == null ? "-" : Number(r.score.toFixed(3)),
        r.materials,
        r.sole,
        r.avgLead == null ? "-" : Number(r.avgLead.toFixed(1)),
        Math.round(r.spend),
      ]),
    }, rows.length);
  } catch (e) {
    console.warn("get_supplier_risk failed:", (e as Error).message);
    return errored("get_supplier_risk", "inbound logistics and supplier criticality");
  }
}

async function getProcurementSpend(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const groupBy = String(args.group_by ?? "supplier") === "material" ? "material" : "supplier";
  const topN = clamp(args.top_n, 10, 1, 50);

  try {
    const inbound = await loadInbound(ctx);
    if (inbound.length === 0) return empty("get_procurement_spend");

    const agg = new Map<string, { spend: number; volume: number; orders: number }>();
    for (const r of inbound) {
      const key = groupBy === "supplier" ? r.supplier_id : r.material_id;
      const cur = agg.get(key) ?? { spend: 0, volume: 0, orders: 0 };
      cur.spend += r.volume * r.unit_price;
      cur.volume += r.volume;
      cur.orders += 1;
      agg.set(key, cur);
    }

    const totalSpend = [...agg.values()].reduce((s, v) => s + v.spend, 0);
    const label = groupBy === "supplier" ? "Supplier" : "Material";

    // No price data anywhere → rank by purchased volume instead of spend.
    if (totalSpend === 0) {
      const sorted = [...agg.entries()].sort((a, b) => b[1].volume - a[1].volume).slice(0, topN);
      const totalVol = [...agg.values()].reduce((s, v) => s + v.volume, 0);
      return envelope("get_procurement_spend", "table", {
        columns: [label, "Volume", "Orders", "% of Volume"],
        rows: sorted.map(([k, v]) => [k, Math.round(v.volume), v.orders, totalVol ? `${((v.volume / totalVol) * 100).toFixed(1)}%` : "-"]),
      }, sorted.length, "No unit prices on file — ranked by purchased volume instead of spend.");
    }

    const sorted = [...agg.entries()].sort((a, b) => b[1].spend - a[1].spend).slice(0, topN);
    return envelope("get_procurement_spend", "table", {
      columns: [label, "Spend", "Orders", "% of Total"],
      rows: sorted.map(([k, v]) => [
        k,
        Math.round(v.spend),
        v.orders,
        `${((v.spend / totalSpend) * 100).toFixed(1)}%`,
      ]),
    }, sorted.length, `Total procurement spend across project: ${Math.round(totalSpend)}`);
  } catch (e) {
    console.warn("get_procurement_spend failed:", (e as Error).message);
    return errored("get_procurement_spend", "procurement spend");
  }
}

async function getMaterialRisk(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const material = args.material ? String(args.material).toLowerCase() : null;
  const onlySingle = Boolean(args.only_single_source);
  const topN = clamp(args.top_n, 15, 1, 50);

  try {
    const inbound = await loadInbound(ctx);
    if (inbound.length === 0) return empty("get_material_risk");

    interface Agg { suppliers: Set<string>; leadSum: number; leadN: number; spend: number }
    const agg = new Map<string, Agg>();
    for (const r of inbound) {
      const a = agg.get(r.material_id) ?? { suppliers: new Set(), leadSum: 0, leadN: 0, spend: 0 };
      a.suppliers.add(r.supplier_id);
      a.spend += r.volume * r.unit_price;
      if (r.lead_time != null && Number.isFinite(r.lead_time)) { a.leadSum += r.lead_time; a.leadN += 1; }
      agg.set(r.material_id, a);
    }

    const crit = await criticalityMap(ctx, "material");

    let rows = [...agg.entries()].map(([mid, a]) => ({
      material: mid,
      suppliers: a.suppliers.size,
      single: a.suppliers.size <= 1,
      avgLead: a.leadN ? a.leadSum / a.leadN : null,
      spend: a.spend,
      score: crit.get(mid)?.score ?? null,
    }));

    if (material) rows = rows.filter((r) => r.material.toLowerCase().includes(material));
    if (onlySingle) rows = rows.filter((r) => r.single);
    // Rank: single-sourced first, then longer lead time, then higher spend.
    rows.sort((x, y) =>
      Number(y.single) - Number(x.single) ||
      (y.avgLead ?? 0) - (x.avgLead ?? 0) ||
      y.spend - x.spend
    );
    rows = rows.slice(0, topN);
    if (rows.length === 0) return empty("get_material_risk");

    return envelope("get_material_risk", "table", {
      columns: ["Material", "Suppliers", "Single-source", "Avg Lead Time", "Spend", "Criticality"],
      rows: rows.map((r) => [
        r.material,
        r.suppliers,
        r.single ? "Yes" : "-",
        r.avgLead == null ? "-" : Number(r.avgLead.toFixed(1)),
        Math.round(r.spend),
        r.score == null ? "-" : Number(r.score.toFixed(3)),
      ]),
    }, rows.length);
  } catch (e) {
    console.warn("get_material_risk failed:", (e as Error).message);
    return errored("get_material_risk", "material risk");
  }
}

async function recommendDisruptionStrategy(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const disruptionType = String(args.disruption_type ?? "");
  const target = args.target ? String(args.target) : null;
  const magnitude = clamp(args.magnitude_pct, 50, 0, 100);

  try {
    // Project-specific playbooks plus the shared system playbooks.
    const { data, error } = await ctx.supabase
      .from("recovery_playbooks")
      .select("name, description, config, is_system, project_id")
      .or(`project_id.eq.${ctx.projectId},is_system.eq.true`)
      .limit(100);
    if (error) throw error;

    const cfgNum = (cfg: any, key: string): number | null => {
      const v = cfg?.[key];
      return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
    };
    let rows = ((data ?? []) as any[]).map((r) => {
      const cfg = r.config ?? {};
      const responses = Array.isArray(cfg.responses) ? cfg.responses : [];
      return {
        name: r.name,
        responses: responses.length ? responses.join(", ") : "—",
        recovery: cfgNum(cfg, "recovery_target_days"),
        cost: cfgNum(cfg, "cost_cap"),
        detection: cfgNum(cfg, "detection_lag_days"),
        description: r.description ?? "",
      };
    });
    // Fastest target recovery first (nulls — e.g. baseline — last).
    rows.sort((a, b) => (a.recovery ?? Number.POSITIVE_INFINITY) - (b.recovery ?? Number.POSITIVE_INFINITY));
    rows = rows.slice(0, 8);

    if (rows.length === 0) {
      // Fall back to generic playbooks so the AI still has something to reason
      // about — but note:"generic" so the model must present them as canonical
      // patterns, never as this project's playbooks. The numbers in them are
      // derived from the caller's magnitude argument, not from project data.
      const generic = genericPlaybooks(disruptionType, magnitude, target);
      return envelope("recommend_disruption_strategy", "bullets", generic, generic.length,
        "generic");
    }

    return envelope("recommend_disruption_strategy", "table", {
      columns: ["Playbook", "Responses", "Target Recovery (d)", "Cost Cap", "Detection Lag (d)"],
      rows: rows.map((r) => [
        r.name,
        r.responses,
        r.recovery ?? "—",
        r.cost ?? "—",
        r.detection ?? "—",
      ]),
    }, rows.length, `Ranked by fastest target recovery for a ${disruptionType || "disruption"}.`);
  } catch (e) {
    // Previously this returned genericPlaybooks() as a row_count > 0 envelope,
    // so a database error produced invented numbers ("increase safety stock by
    // N%") that the model relayed as grounded project advice. A failed read is
    // a failed read.
    console.warn("recommend_disruption_strategy failed:", (e as Error).message);
    return errored("recommend_disruption_strategy", "the recovery playbook catalog");
  }
}

/** Canonical, NON-project-specific recovery patterns. Every number in these
 * is derived from the caller's magnitude argument, not from project data, so
 * they are only ever returned under note:"generic" and the leading line says
 * so — the model must not present them as this project's playbooks. */
function genericPlaybooks(disruption: string, magnitude: number, target: string | null): string[] {
  const t = target ? ` for ${target}` : "";
  const sev = magnitude >= 70 ? "high-severity" : magnitude >= 30 ? "moderate" : "low-severity";
  // Leads every list: the model reads tool results as evidence, so the
  // provenance has to travel with the content, not just in meta.note.
  const preface =
    "These are CANONICAL industry recovery patterns, not this project's playbooks — " +
    "no project data was read. Present them as general options and say so; any figure " +
    "below is scaled from the requested magnitude, not measured.";
  const generic = (items: string[]) => [preface, ...items];
  switch (disruption) {
    case "supplier_outage":
      return generic([
        `Activate qualified backup suppliers${t} — prioritize those already approved in the AVL.`,
        `Increase safety stock by ${Math.round(magnitude / 2)}% for the affected SKUs during the recovery window.`,
        `Engage logistics to expedite in-transit inventory; consider air freight for ${sev} disruption.`,
        `Open dual-sourcing RFQ within 5 business days to prevent recurrence.`,
      ]);
    case "material_shortage":
      return generic([
        `Substitute with approved alternate materials${t}; verify BOM compatibility first.`,
        `Reallocate constrained material to highest-margin or strategic-customer orders.`,
        `Negotiate long-term contract with secondary source to de-risk the category.`,
      ]);
    case "lead_time_shock":
      return generic([
        `Shift to closer-shore suppliers${t} for the affected category.`,
        `Pre-position inventory at distribution centers near top-demand regions.`,
        `Communicate revised promise dates to customers within 24 hours.`,
      ]);
    case "demand_surge":
      return generic([
        `Activate overtime / second-shift capacity at the focal plant.`,
        `Pull-in open POs and request expedites from top tier-1 suppliers.`,
        `Temporarily lift order limits on strategic SKUs; throttle non-strategic SKUs.`,
      ]);
    case "nexus_attack":
      return generic([
        `Isolate impacted hub${t}; re-route flows through redundant nexus nodes.`,
        `Stand up a temporary cross-dock at the next-best logistics node.`,
        `Increase monitoring cadence to daily for upstream suppliers feeding the nexus.`,
      ]);
    default:
      return [`No predefined playbook for disruption type "${disruption}". Run a scenario in the Simulation Lab to evaluate options.`];
  }
}

// ---------- §19.3 coverage read tools (ai-agents.md v1.4 Phase H1) ----------
// Four relation/detail reads closing the I2–I6 fabrication gaps (§19.2): each
// wraps the same inbound_logistics / bom_multi_level / outbound_logistics /
// masters reads the policies page performs via useStageRows /
// get_supply_chain_data — no new privileged path, service-role project-scoped,
// standard envelope, clamp()ed numerics, empty() on no data. Behind
// COVERAGE_TOOLS_ENABLED (§9 conventions, default off): the handlers are
// always registered (registration is inert — only declared tools are callable
// by a model), and personaTools.ts appends the declarations to the persona
// surface only when the flag is on.

export function coverageToolsEnabled(): boolean {
  return (Deno.env.get("COVERAGE_TOOLS_ENABLED") ?? "").trim().toLowerCase() === "true";
}

/** Best-effort master-name map for one entity kind (id → display name). */
async function masterNames(ctx: ToolContext, table: string, idCol: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data } = await ctx.supabase
      .from(table)
      .select(`${idCol}, name`)
      .eq("project_id", ctx.projectId)
      .limit(10000);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const id = r[idCol];
      if (id != null && r.name != null && String(r.name).trim() !== "") map.set(String(id), String(r.name));
    }
  } catch (e) {
    // Names are enrichment; ids alone are still grounded — but log it, or a
    // broken master table silently degrades every reply to bare ids.
    console.warn("masterNames enrichment failed:", (e as Error).message);
  }
  return map;
}

interface ResolvedEntity {
  id: string | null;
  /** ≤ 5 candidates when the fragment is ambiguous (§19.5: never guess). */
  candidates: Array<{ id: string; label: string }>;
}

/** §19.5 resolution: exact id match wins outright; otherwise the fragment is
 * matched against ids AND master names; >1 hit returns the candidate list. */
function resolveEntity(fragment: string, ids: Iterable<string>, names: Map<string, string>): ResolvedEntity {
  const frag = fragment.trim().toLowerCase();
  const all = [...new Set(ids)];
  const exact = all.find((id) => id.toLowerCase() === frag);
  if (exact) return { id: exact, candidates: [] };
  const hits = all.filter((id) =>
    id.toLowerCase().includes(frag) || (names.get(id) ?? "").toLowerCase().includes(frag)
  );
  if (hits.length === 1) return { id: hits[0], candidates: [] };
  return {
    id: null,
    candidates: hits.slice(0, 5).map((id) => ({ id, label: names.get(id) ?? id })),
  };
}

/** The "did you mean…" envelope (§19.5/§22.5): candidates as rows, never a
 * guess — the persona instantiates the disambiguation template from these. */
function ambiguousEnvelope(
  tool: string,
  fragment: string,
  candidates: Array<{ id: string; label: string }>,
  total: number,
): ToolEnvelope {
  return envelope(tool, "table", {
    columns: ["id", "label"],
    rows: candidates.map((c) => [c.id, c.label]),
  }, candidates.length, `ambiguous: "${fragment}" matches ${total} entities — ask which one`);
}

/** Last arc wins per (from,to) pair — the exact dedupe useStageRows applies
 * via its inboundByKey/outboundByKey maps, so tool answers and the policies
 * page can never disagree on which arc's values are shown. */
function lastArcByPair<T>(rows: T[], keyOf: (r: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) map.set(keyOf(r), r);
  return map;
}

async function getSupplierMaterials(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_supplier_materials";
  const fragment = String(args.supplier ?? "").trim();
  if (!fragment) return envelope(tool, "text", "supplier is required (id or name fragment).", 0, "error");
  const topN = clamp(args.top_n, 50, 1, 200);

  try {
    const inbound = await loadInbound(ctx);
    if (inbound.length === 0) return empty(tool);
    const names = await masterNames(ctx, "suppliers", "supplier_id");
    const resolved = resolveEntity(fragment, inbound.map((r) => r.supplier_id), names);
    if (!resolved.id) {
      if (resolved.candidates.length > 1) {
        return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
      }
      return empty(tool, `No supplier matching "${fragment}" in this project's inbound logistics.`);
    }
    const sid = resolved.id;

    // Suppliers per material (single-source flag), over the whole project.
    const suppliersByMaterial = new Map<string, Set<string>>();
    for (const r of inbound) {
      if (!suppliersByMaterial.has(r.material_id)) suppliersByMaterial.set(r.material_id, new Set());
      suppliersByMaterial.get(r.material_id)!.add(r.supplier_id);
    }

    const pairs = lastArcByPair(
      inbound.filter((r) => r.supplier_id === sid),
      (r) => r.material_id,
    );
    const total = pairs.size;
    if (total === 0) return empty(tool, `Supplier ${sid} has no inbound rows in this project.`);

    let rows = [...pairs.values()].map((r) => ({
      material: r.material_id,
      price: r.unit_price,
      lead: r.lead_time,
      single: (suppliersByMaterial.get(r.material_id)?.size ?? 0) <= 1,
      spend: r.volume * r.unit_price,
    }));
    // §19.3 ranking: single-source → lead time → spend.
    rows.sort((x, y) =>
      Number(y.single) - Number(x.single) ||
      (y.lead ?? 0) - (x.lead ?? 0) ||
      y.spend - x.spend
    );
    rows = rows.slice(0, topN);

    const supplierLabel = names.has(sid) ? `${sid} (${names.get(sid)})` : sid;
    // §19.3/§19.6: the note carries the TRUE total on truncation.
    const note = total > topN
      ? `supplier ${sid} supplies ${total} materials; showing top ${topN}.`
      : `supplier ${supplierLabel} supplies ${total} materials.`;
    return envelope(tool, "table", {
      columns: ["Material", "Unit Price", "Lead Time", "Single-source?"],
      rows: rows.map((r) => [
        r.material,
        r.price,
        r.lead == null ? "-" : r.lead,
        r.single ? "Yes" : "-",
      ]),
    }, rows.length, note);
  } catch (e) {
    console.warn("get_supplier_materials failed:", (e as Error).message);
    return errored(tool, "this supplier's materials");
  }
}

async function getMaterialSuppliers(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_material_suppliers";
  const fragment = String(args.material ?? "").trim();
  if (!fragment) return envelope(tool, "text", "material is required (id or name fragment).", 0, "error");
  const topN = clamp(args.top_n, 25, 1, 50);

  try {
    const inbound = await loadInbound(ctx);
    if (inbound.length === 0) return empty(tool);
    const matNames = await masterNames(ctx, "materials", "material_id");
    const supNames = await masterNames(ctx, "suppliers", "supplier_id");
    const resolved = resolveEntity(fragment, inbound.map((r) => r.material_id), matNames);
    if (!resolved.id) {
      if (resolved.candidates.length > 1) {
        return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
      }
      return empty(tool, `No material matching "${fragment}" in this project's inbound logistics.`);
    }
    const mid = resolved.id;

    const pairs = lastArcByPair(
      inbound.filter((r) => r.material_id === mid),
      (r) => r.supplier_id,
    );
    const total = pairs.size;
    if (total === 0) return empty(tool, `Material ${mid} has no inbound rows in this project.`);

    let rows = [...pairs.values()].map((r) => ({
      supplier: supNames.has(r.supplier_id) ? `${r.supplier_id} (${supNames.get(r.supplier_id)})` : r.supplier_id,
      price: r.unit_price,
      lead: r.lead_time,
      volume: r.volume,
    }));
    // useStageRows suggested-primary order: highest volume → lowest price →
    // lowest lead time (the sole-source case returns its one row unchanged).
    rows.sort((x, y) =>
      y.volume - x.volume ||
      (x.price ?? Number.POSITIVE_INFINITY) - (y.price ?? Number.POSITIVE_INFINITY) ||
      (x.lead ?? Number.POSITIVE_INFINITY) - (y.lead ?? Number.POSITIVE_INFINITY)
    );
    rows = rows.slice(0, topN);

    const note = total > topN
      ? `material ${mid} has ${total} suppliers; showing top ${topN}.`
      : `material ${mid} has ${total} supplier${total === 1 ? "" : "s"}.`;
    return envelope(tool, "table", {
      columns: ["Supplier", "Unit Price", "Lead Time", "Volume"],
      rows: rows.map((r) => [
        r.supplier,
        r.price,
        r.lead == null ? "-" : r.lead,
        r.volume,
      ]),
    }, rows.length, note);
  } catch (e) {
    console.warn("get_material_suppliers failed:", (e as Error).message);
    return errored(tool, "this material's suppliers");
  }
}

// §19.6: get_bom_relations declares no top_n — relation rows are capped at a
// fixed 200 with the TRUE total in meta.note.
const BOM_RELATION_ROW_CAP = 200;

interface BomRow { material_id: string; parent: string | null; level: number | null; rate: number | null }

async function loadBom(ctx: ToolContext): Promise<BomRow[]> {
  const { data, error } = await ctx.supabase
    .from("bom_multi_level")
    .select("material_id, higher_level_component_id, level, consumption_rate")
    .eq("project_id", ctx.projectId)
    .limit(10000);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    material_id: String(r.material_id ?? ""),
    parent: r.higher_level_component_id == null || String(r.higher_level_component_id).trim() === ""
      ? null
      : String(r.higher_level_component_id),
    level: r.level == null ? null : Number(r.level),
    rate: r.consumption_rate == null ? null : Number(r.consumption_rate),
  })).filter((r: BomRow) => r.material_id !== "");
}

interface OutboundRow { customer_id: string; product_id: string; volume: number; unit_price: number | null; lead: number | null }

async function loadOutbound(ctx: ToolContext): Promise<OutboundRow[]> {
  const { data, error } = await ctx.supabase
    .from("outbound_logistics")
    .select("customer_id, product_id, volume, unit_price, expected_lead_time")
    .eq("project_id", ctx.projectId)
    .limit(10000);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    customer_id: String(r.customer_id ?? "unknown"),
    product_id: String(r.product_id ?? "unknown"),
    volume: Number(r.volume ?? 0) || 0,
    unit_price: r.unit_price == null ? null : Number(r.unit_price),
    lead: r.expected_lead_time == null ? null : Number(r.expected_lead_time),
  }));
}

const BOM_DIRECTIONS = [
  "material_to_products", "product_to_materials", "product_customers", "customer_products",
] as const;

async function getBomRelations(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_bom_relations";
  const direction = String(args.direction ?? "");
  if (!(BOM_DIRECTIONS as readonly string[]).includes(direction)) {
    return envelope(tool, "text",
      `direction must be one of: ${BOM_DIRECTIONS.join(", ")}.`, 0, "error");
  }
  const fragment = String(args.target ?? "").trim();
  if (!fragment) return envelope(tool, "text", "target is required (entity id or name fragment).", 0, "error");

  try {
    if (direction === "product_customers" || direction === "customer_products") {
      const outbound = await loadOutbound(ctx);
      if (outbound.length === 0) return empty(tool, "No outbound logistics rows in this project yet.");
      const byProduct = direction === "product_customers";
      const idSpace = outbound.map((r) => (byProduct ? r.product_id : r.customer_id));
      const names = byProduct ? await masterNames(ctx, "products", "product_id") : new Map<string, string>();
      const resolved = resolveEntity(fragment, idSpace, names);
      if (!resolved.id) {
        if (resolved.candidates.length > 1) {
          return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
        }
        return empty(tool, `No ${byProduct ? "product" : "customer"} matching "${fragment}" in this project's outbound logistics.`);
      }
      const target = resolved.id;
      const pairs = lastArcByPair(
        outbound.filter((r) => (byProduct ? r.product_id : r.customer_id) === target),
        (r) => (byProduct ? r.customer_id : r.product_id),
      );
      const total = pairs.size;
      let rows = [...pairs.values()].sort((x, y) => y.volume - x.volume);
      rows = rows.slice(0, BOM_RELATION_ROW_CAP);
      const kindLabel = byProduct ? "Customer" : "Product";
      const note = total > rows.length
        ? `${byProduct ? "product" : "customer"} ${target} has ${total} ${kindLabel.toLowerCase()} relations; showing top ${rows.length}.`
        : `${byProduct ? "product" : "customer"} ${target}: ${total} relation${total === 1 ? "" : "s"} from outbound_logistics.`;
      return envelope(tool, "table", {
        columns: [kindLabel, "Volume", "Unit Price", "Expected Lead Time"],
        rows: rows.map((r) => [
          byProduct ? r.customer_id : r.product_id,
          r.volume,
          r.unit_price == null ? "-" : r.unit_price,
          r.lead == null ? "-" : r.lead,
        ]),
      }, rows.length, note);
    }

    // BOM traversal — parent/leaf logic mirrors useStageRows: an id is a
    // parent iff it appears as higher_level_component_id; finished products
    // are the outbound sources (bomTargets ∩ outboundSources, else outbound).
    const bom = await loadBom(ctx);
    if (bom.length === 0) return empty(tool, "No multi-level BOM rows in this project yet.");
    const outbound = await loadOutbound(ctx);
    const outboundProducts = new Set(outbound.map((r) => r.product_id));
    const matNames = await masterNames(ctx, "materials", "material_id");
    const prodNames = await masterNames(ctx, "products", "product_id");

    const parentsOf = new Map<string, BomRow[]>();   // child → edge rows up
    const childrenOf = new Map<string, BomRow[]>();  // parent → edge rows down
    for (const r of bom) {
      if (!r.parent) continue;
      if (!parentsOf.has(r.material_id)) parentsOf.set(r.material_id, []);
      parentsOf.get(r.material_id)!.push(r);
      if (!childrenOf.has(r.parent)) childrenOf.set(r.parent, []);
      childrenOf.get(r.parent)!.push(r);
    }

    if (direction === "material_to_products") {
      const idSpace = bom.map((r) => r.material_id);
      const resolved = resolveEntity(fragment, idSpace, matNames);
      if (!resolved.id) {
        if (resolved.candidates.length > 1) {
          return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
        }
        return empty(tool, `No material matching "${fragment}" in this project's BOM.`);
      }
      const target = resolved.id;
      // Walk UP via higher_level_component_id, cycle-safe, tracking depth.
      const seen = new Map<string, number>(); // ancestor → min levels up
      const queue: Array<{ id: string; depth: number }> = [{ id: target, depth: 0 }];
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        for (const edge of parentsOf.get(id) ?? []) {
          const p = edge.parent!;
          if (seen.has(p)) continue;
          seen.set(p, depth + 1);
          queue.push({ id: p, depth: depth + 1 });
        }
      }
      if (seen.size === 0) {
        return empty(tool, `Material ${target} has no parent components in this project's BOM.`);
      }
      const total = seen.size;
      const rows = [...seen.entries()]
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(0, BOM_RELATION_ROW_CAP);
      const note = total > rows.length
        ? `material ${target} feeds ${total} parent items; showing ${rows.length}.`
        : `material ${target} feeds ${total} parent item${total === 1 ? "" : "s"} (finished products flagged from outbound_logistics).`;
      return envelope(tool, "table", {
        columns: ["Product", "Levels up", "Outbound product?"],
        rows: rows.map(([id, depth]) => [
          prodNames.has(id) ? `${id} (${prodNames.get(id)})` : id,
          depth,
          outboundProducts.has(id) ? "Yes" : "-",
        ]),
      }, rows.length, note);
    }

    // product_to_materials — walk DOWN, one row per BOM edge visited.
    const idSpace = [...new Set([...childrenOf.keys(), ...outboundProducts])];
    const resolved = resolveEntity(fragment, idSpace, prodNames);
    if (!resolved.id) {
      if (resolved.candidates.length > 1) {
        return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
      }
      return empty(tool, `No product matching "${fragment}" in this project's BOM or outbound logistics.`);
    }
    const target = resolved.id;
    const visited = new Set<string>();
    const edges: Array<{ material: string; parent: string; depth: number; rate: number | null }> = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: target, depth: 0 }];
    visited.add(target);
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      for (const edge of childrenOf.get(id) ?? []) {
        edges.push({ material: edge.material_id, parent: id, depth: depth + 1, rate: edge.rate });
        if (!visited.has(edge.material_id)) {
          visited.add(edge.material_id);
          queue.push({ id: edge.material_id, depth: depth + 1 });
        }
      }
    }
    if (edges.length === 0) {
      return empty(tool, `Product ${target} has no BOM components in this project.`);
    }
    const total = edges.length;
    const rows = edges
      .sort((a, b) => a.depth - b.depth || a.material.localeCompare(b.material))
      .slice(0, BOM_RELATION_ROW_CAP);
    const note = total > rows.length
      ? `product ${target} uses ${total} BOM component rows; showing ${rows.length}.`
      : `product ${target}: ${total} BOM component row${total === 1 ? "" : "s"}.`;
    return envelope(tool, "table", {
      columns: ["Material", "Parent", "Levels down", "Consumption rate"],
      rows: rows.map((e) => [
        matNames.has(e.material) ? `${e.material} (${matNames.get(e.material)})` : e.material,
        e.parent,
        e.depth,
        e.rate == null ? "-" : e.rate,
      ]),
    }, rows.length, note);
  } catch (e) {
    console.warn("get_bom_relations failed:", (e as Error).message);
    return errored(tool, "BOM relations");
  }
}

const ENTITY_DETAIL_TYPES = ["supplier", "material", "product", "customer", "plant"] as const;

async function getEntityDetail(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "get_entity_detail";
  const entityType = String(args.entity_type ?? "");
  if (!(ENTITY_DETAIL_TYPES as readonly string[]).includes(entityType)) {
    return envelope(tool, "text",
      `entity_type must be one of: ${ENTITY_DETAIL_TYPES.join(", ")}.`, 0, "error");
  }
  const fragment = String(args.id ?? "").trim();
  if (!fragment) return envelope(tool, "text", "id is required.", 0, "error");

  try {
    const masterTable = entityType === "supplier" ? "suppliers"
      : entityType === "material" ? "materials"
      : entityType === "product" ? "products"
      : null;
    const idCol = entityType === "supplier" ? "supplier_id"
      : entityType === "material" ? "material_id"
      : entityType === "product" ? "product_id"
      : "node_id";

    // Master rows first; node_list is both the criticality enrichment and the
    // only home of customer/plant records.
    let masterRows: Record<string, unknown>[] = [];
    if (masterTable) {
      const { data } = await ctx.supabase
        .from(masterTable)
        .select("*")
        .eq("project_id", ctx.projectId)
        .limit(10000);
      masterRows = (data ?? []) as Record<string, unknown>[];
    }
    const { data: nodeData } = await ctx.supabase
      .from("node_list")
      .select("node_id, node_type, node_group, location_text, is_critical_node, critical_node_score")
      .eq("project_id", ctx.projectId)
      .limit(10000);
    const nodeRows = ((nodeData ?? []) as Record<string, unknown>[]).filter(
      (n) => masterTable === null
        ? String(n.node_type ?? "").toLowerCase() === entityType
        : true,
    );

    const names = new Map<string, string>();
    for (const r of masterRows) {
      if (r.name != null && String(r.name).trim() !== "") names.set(String(r[idCol]), String(r.name));
    }
    const idSpace = masterTable
      ? masterRows.map((r) => String(r[idCol]))
      : nodeRows.map((n) => String(n.node_id));
    if (idSpace.length === 0) {
      return empty(tool, `No ${entityType} records in this project yet.`);
    }
    const resolved = resolveEntity(fragment, idSpace, names);
    if (!resolved.id) {
      if (resolved.candidates.length > 1) {
        return ambiguousEnvelope(tool, fragment, resolved.candidates, resolved.candidates.length);
      }
      return empty(tool, `No ${entityType} matching "${fragment}" in this project.`);
    }
    const id = resolved.id;

    // §19.3: verbatim master values — never imputed. Missing fields render "-".
    const cards: Array<{ label: string; value: string | number; hint?: string }> = [
      { label: `${entityType} id`, value: id },
    ];
    const push = (label: string, v: unknown, hint?: string) => {
      cards.push({ label, value: v == null || String(v).trim() === "" ? "-" : (v as string | number), ...(hint ? { hint } : {}) });
    };
    const master = masterRows.find((r) => String(r[idCol]) === id);
    if (master) {
      if (entityType === "supplier") {
        push("Name", master.name);
        push("Capacity / week", master.capacity_per_week, "NULL = unlimited");
        push("Reliability score", master.reliability_score);
      } else if (entityType === "material") {
        push("Name", master.name);
        push("Cost / unit", master.cost);
        push("Holding cost %", master.holding_cost_pct);
        push("MOQ", master.moq);
        push("Initial on hand", master.initial_on_hand);
        push("Lead-time distribution", master.lead_time_dist);
        push("Lead-time CV", master.lead_time_cv);
      } else if (entityType === "product") {
        push("Name", master.name);
        push("Sell price", master.sell_price);
        push("Production capacity / week", master.production_capacity);
        push("Fulfillment mode", master.fulfillment_mode);
        push("Demand distribution", master.demand_distribution);
        push("Demand mean / week", master.demand_mean);
        push("Demand CV", master.demand_cv);
      }
    }
    const node = ((nodeData ?? []) as Record<string, unknown>[]).find((n) => String(n.node_id) === id);
    if (node) {
      push("Node type", node.node_type);
      push("Node group", node.node_group);
      push("Location", node.location_text);
      push("Critical node", node.is_critical_node ? "Yes" : "-");
      push("Criticality score", node.critical_node_score);
    }
    if (!master && !node) {
      return empty(tool, `No master record for ${entityType} ${id} in this project.`);
    }
    const note = master
      ? undefined
      : `no ${masterTable ?? "master"} row for ${id}; showing node_list fields only.`;
    return envelope(tool, "kpi", { cards }, cards.length, note);
  } catch (e) {
    console.warn("get_entity_detail failed:", (e as Error).message);
    return errored(tool, "this entity's master record");
  }
}

/** §19.3 declarations for the four relation/detail tools — appended to the
 * persona surface by personaTools.ts when COVERAGE_TOOLS_ENABLED. */
export const coverageToolDeclarations: ReadonlyArray<ToolDeclaration> = [
  {
    name: "get_supplier_materials",
    description:
      "List the materials a specific supplier supplies for this project, from inbound logistics: material id, unit price, lead time and whether the supplier is the sole source. Resolve the supplier via list_project_entities first if the user gave a name. Ranked single-source first, then lead time, then spend; meta.note carries the TRUE total when the list is truncated.",
    parameters: {
      type: "object",
      properties: {
        supplier: { type: "string", description: "Supplier id or name fragment (required)." },
        top_n: { type: "number", description: "Max materials to return (1-200). Default 50." },
      },
      required: ["supplier"],
    },
  },
  {
    name: "get_material_suppliers",
    description:
      "Name the actual suppliers of a specific material for this project, from inbound logistics: supplier id + name, unit price, lead time and volume. A sole-sourced material returns its one supplier row.",
    parameters: {
      type: "object",
      properties: {
        material: { type: "string", description: "Material id or name fragment (required)." },
        top_n: { type: "number", description: "Max suppliers to return (1-50). Default 25." },
      },
      required: ["material"],
    },
  },
  {
    name: "get_bom_relations",
    description:
      "Traverse this project's bill-of-materials and customer relations: which products use a material (material_to_products), what a product's BOM contains (product_to_materials), who buys a product (product_customers), or what a customer orders (customer_products). Rows come verbatim from bom_multi_level / outbound_logistics.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["material_to_products", "product_to_materials", "product_customers", "customer_products"],
          description: "Which relation to traverse.",
        },
        target: { type: "string", description: "The entity id (or name fragment) to start from (required)." },
      },
      required: ["direction", "target"],
    },
  },
  {
    name: "get_entity_detail",
    description:
      "Read one entity's master-record fields verbatim (never imputed): supplier capacity/reliability, material cost/MOQ/holding cost/lead-time distribution, product price/capacity/demand, plus node criticality where known. Use for lead time / price / MOQ / criticality questions about a NAMED entity.",
    parameters: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["supplier", "material", "product", "customer", "plant"],
          description: "Which entity kind the id names.",
        },
        id: { type: "string", description: "The entity id (or unambiguous fragment) to read (required)." },
      },
      required: ["entity_type", "id"],
    },
  },
];

const handlers: Record<string, Handler> = {
  list_project_entities: listProjectEntities,
  get_supplier_risk: getSupplierRisk,
  get_procurement_spend: getProcurementSpend,
  get_material_risk: getMaterialRisk,
  recommend_disruption_strategy: recommendDisruptionStrategy,
  // §19.3 coverage reads (Phase H1) — registered always, declared to persona
  // turns only when COVERAGE_TOOLS_ENABLED (personaTools.ts).
  get_supplier_materials: getSupplierMaterials,
  get_material_suppliers: getMaterialSuppliers,
  get_bom_relations: getBomRelations,
  get_entity_detail: getEntityDetail,
};

export type ToolHandler = Handler;

/** Registration seam for the staged Layer B tools (ai-agents.md §3.2 bridge 2,
 * §9.2): draftTools.ts registers `get_data_completeness` and the draft_* family
 * here so the shared runChat loop dispatches them through the same
 * executeTool path. Layer A behavior is untouched — the new tools are never in
 * `toolDeclarations`, so no persona turn can call them. */
export function registerToolHandler(name: string, handler: Handler): void {
  handlers[name] = handler;
}

export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const handler = handlers[name];
  if (!handler) {
    return envelope(name, "text", `Unknown tool: ${name}`, 0, "unknown_tool");
  }
  // §21.5: the per-request tool-call budget (DEFAULT 15), consumed here so
  // every executed call — persona or agent — spends the same meter. On
  // exhaustion the model gets a `too_large`-style envelope (note "budget")
  // and must wrap up; never a silent drop.
  if (ctx.budget && !tryConsumeToolCall(ctx.budget)) {
    return envelope(
      name,
      "text",
      `The per-request tool budget (${ctx.budget.maxToolCalls} calls) is spent — stop calling tools and wrap up with what you have.`,
      0,
      "budget",
    );
  }
  try {
    return await handler(rawArgs ?? {}, ctx);
  } catch (e) {
    console.error(`Tool ${name} threw:`, e);
    return envelope(name, "text", "Tool execution failed.", 0, "error");
  }
}

export function makeToolContext(projectId: string, userId: string): ToolContext {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  return { projectId, userId, supabase };
}

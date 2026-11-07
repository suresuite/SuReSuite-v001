// Run-readiness ROW CHECK for the Policy Configurator (ai-agents.md §5.2,
// §10 entry 38(x)).
//
// WHAT THIS IS — AND IS NOT. Run-readiness obligations 3–4 (one primary
// supplier per material, one primary sourcing firm per customer×product) are
// GRADED by the browser (`src/lib/policies/verification.ts`), over grid rows
// that `useStageRows` builds and pre-decides (a single-source material is its
// own primary; otherwise the highest-volume lane / firm — §4 D23). That
// grading is not repeated here: a second author of the gate's verdict would be
// the `single-source` failure CLAUDE.md names.
//
// This module answers a narrower, purely structural question the configurator
// got wrong in live evals (`pc-06`: `target_key: "S1"`, an invented firm
// "Acme"): DOES A RUN-READINESS SELECTION NAME A ROW THAT EXISTS? The rows are
// the ones the grid itself is keyed on — `supplier::material` for every
// inbound lane, `customer::product` for every outbound lane — and a firm is
// one the outbound lanes ship that product from (`supply_chain_data.plant_name`,
// the grid's firm source), or the project's focal plant. Reading the same
// tables the grid reads, it can disagree with the grid only by REFUSING a key
// the grid would not render — never by deciding a primary.

import type { DiffOverride, PolicyDiff } from "../_shared/policyFields.ts";
import type { ToolContext } from "./tools.ts";

type Row = Record<string, unknown>;
type Db = ToolContext["supabase"];

/** The fields that are run-readiness SELECTIONS (per row, never a default). */
export const RUN_READINESS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  sourcing: ["primary_source"],
  fulfillment: ["primary_source", "sourcing_firm"],
};

export interface SupplierLane {
  key: string; // `${supplier}::${material}` — the grid's supplier-stage row key
  supplier: string;
  material: string;
  volume: number;
}

export interface CustomerLane {
  key: string; // `${customer}::${product}` — the grid's customer-stage row key
  customer: string;
  product: string;
}

export interface RunReadinessRows {
  supplierLanes: SupplierLane[];
  customerLanes: CustomerLane[];
  /** product → firms the outbound lanes ship it from (sorted). */
  firmsByProduct: Map<string, string[]>;
  /** The project's focal plant, when the project row names one. */
  focalPlant: string | null;
}

const str = (v: unknown) => String(v ?? "").trim();

/** Pure: the run-readiness rows from rows already loaded (testable without a db). */
export function runReadinessRowsFrom(args: {
  inbound: Row[];
  outbound: Row[];
  outboundLaneEdges: Row[];
  focalPlant: string | null;
}): RunReadinessRows {
  const lanes = new Map<string, SupplierLane>();
  for (const r of args.inbound) {
    const supplier = str(r.supplier_id);
    const material = str(r.material_id);
    if (!supplier || !material) continue;
    const key = `${supplier}::${material}`;
    const vol = Number(r.volume);
    const prev = lanes.get(key);
    lanes.set(key, {
      key, supplier, material,
      volume: (prev?.volume ?? 0) + (Number.isFinite(vol) ? vol : 0),
    });
  }
  const customers = new Map<string, CustomerLane>();
  for (const r of args.outbound) {
    const customer = str(r.customer_id);
    const product = str(r.product_id);
    if (!customer || !product) continue;
    const key = `${customer}::${product}`;
    if (!customers.has(key)) customers.set(key, { key, customer, product });
  }
  const firms = new Map<string, Set<string>>();
  for (const e of args.outboundLaneEdges) {
    if (str(e.data_source) !== "outbound") continue;
    const product = str(e.from_location);
    const firm = str(e.plant_name);
    if (!product || !firm) continue;
    if (!firms.has(product)) firms.set(product, new Set());
    firms.get(product)!.add(firm);
  }
  return {
    supplierLanes: [...lanes.values()].sort((a, b) => a.key.localeCompare(b.key)),
    customerLanes: [...customers.values()].sort((a, b) => a.key.localeCompare(b.key)),
    firmsByProduct: new Map([...firms].map(([p, s]) => [p, [...s].sort()])),
    focalPlant: args.focalPlant && args.focalPlant.trim() ? args.focalPlant.trim() : null,
  };
}

/** Reads the same tables the grid's rows come from. Failures are surfaced, not swallowed. */
export async function loadRunReadinessRows(
  db: Db,
  projectId: string,
  dataset: { inbound: Row[]; outbound: Row[] },
): Promise<RunReadinessRows> {
  let edges: Row[] = [];
  let focal: string | null = null;
  try {
    const { data, error } = await db
      .from("supply_chain_data")
      .select("from_location,plant_name,data_source")
      .eq("project_id", projectId)
      .eq("data_source", "outbound")
      .limit(20000);
    if (error) throw error;
    edges = (data ?? []) as Row[];
  } catch (e) {
    console.warn("run-readiness firm read failed:", (e as Error).message);
  }
  try {
    const { data } = await db.from("projects").select("plant_name").eq("id", projectId).maybeSingle();
    focal = data ? str((data as Row).plant_name) || null : null;
  } catch { /* the focal plant is one candidate among the lanes' firms */ }
  return runReadinessRowsFrom({
    inbound: dataset.inbound,
    outbound: dataset.outbound,
    outboundLaneEdges: edges,
    focalPlant: focal,
  });
}

/** Firms a product can be sourced from: its outbound lanes' plants, plus the focal plant. */
export function firmsFor(rows: RunReadinessRows, product: string): string[] {
  const set = new Set(rows.firmsByProduct.get(product) ?? []);
  if (rows.focalPlant) set.add(rows.focalPlant);
  return [...set].sort();
}

export type RunReadinessVerdict = { ok: true } | { ok: false; code: "invalid_params" | "not_grounded"; reason: string };

/**
 * Structural check of every run-readiness selection in a diff:
 *  - a selection is PER ROW: `primary_source` / `sourcing_firm` in `defaults`
 *    would mark every row (several primaries per material — a gate block), so
 *    it is refused;
 *  - a sourcing `primary_source` override targets an existing
 *    `supplier::material` lane;
 *  - a fulfillment `primary_source` / `sourcing_firm` override targets an
 *    existing `customer::product` lane, and a firm must be one that lane's
 *    product can ship from.
 */
export function checkRunReadinessDiff(diff: PolicyDiff, rows: RunReadinessRows): RunReadinessVerdict {
  for (const [family, fields] of Object.entries(RUN_READINESS_FIELDS)) {
    const patch = (diff.defaults as Record<string, Record<string, unknown> | undefined> | undefined)?.[family];
    const hit = fields.filter((f) => patch && f in patch);
    if (hit.length > 0) {
      return {
        ok: false,
        code: "invalid_params",
        reason: `${hit.map((f) => `${family}.${f}`).join(", ")} is a per-row run-readiness selection, never a ` +
          `family default (a default would mark every row). Set it as an override on the row's key — ` +
          `see RUN-READINESS ROWS in CONTEXT.`,
      };
    }
  }
  const laneKeys = new Set(rows.supplierLanes.map((l) => l.key));
  const customerByKey = new Map(rows.customerLanes.map((c) => [c.key, c]));
  for (const o of (diff.overrides ?? []) as DiffOverride[]) {
    const fields = RUN_READINESS_FIELDS[o.family];
    if (!fields || !fields.some((f) => f in (o.patch ?? {}))) continue;
    if (o.family === "sourcing") {
      if (!laneKeys.has(o.target_key)) {
        return {
          ok: false,
          code: "invalid_params",
          reason: `sourcing.primary_source must target a supplier::material lane; "${o.target_key}" is not one ` +
            `in this project${sampleOf([...laneKeys])}.`,
        };
      }
      continue;
    }
    const lane = customerByKey.get(o.target_key);
    if (!lane) {
      return {
        ok: false,
        code: "invalid_params",
        reason: `fulfillment.${fields.filter((f) => f in o.patch).join("/")} must target a customer::product lane; ` +
          `"${o.target_key}" is not one in this project${sampleOf([...customerByKey.keys()])}.`,
      };
    }
    if ("sourcing_firm" in o.patch) {
      const firm = str(o.patch.sourcing_firm);
      const known = firmsFor(rows, lane.product);
      if (known.length === 0) {
        return {
          ok: false,
          code: "not_grounded",
          reason: `no firm ships product ${lane.product} in this project's lanes, so a sourcing firm for ` +
            `${lane.key} cannot be chosen from data — combine the project's lanes first.`,
        };
      }
      if (!known.includes(firm)) {
        return {
          ok: false,
          code: "invalid_params",
          reason: `sourcing_firm "${firm}" does not ship product ${lane.product}; its firms are: ${known.join(", ")}.`,
        };
      }
    }
  }
  return { ok: true };
}

function sampleOf(keys: string[]): string {
  return keys.length === 0 ? " (it has none)" : ` (e.g. ${keys.slice(0, 5).join(", ")})`;
}

/** The CONTEXT block: rows a run-readiness selection may target, budget-capped with the TRUE totals. */
export function runReadinessContextBlock(rows: RunReadinessRows, budget = 40): string {
  const byMaterial = new Map<string, SupplierLane[]>();
  for (const l of rows.supplierLanes) {
    byMaterial.set(l.material, [...(byMaterial.get(l.material) ?? []), l]);
  }
  // Materials with a CHOICE first (more than one lane) — those are the ones a
  // primary selection is about.
  const mats = [...byMaterial.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const supLines = mats.slice(0, budget).map(([m, ls]) =>
    `  - material ${m}: ${ls.map((l) => `${l.key} (volume ${l.volume})`).join("; ")}`);
  const custLines = rows.customerLanes.slice(0, budget).map((c) =>
    `  - ${c.key}: firms ${firmsFor(rows, c.product).join(", ") || "(none in the lanes)"}`);
  return [
    `- RUN-READINESS ROWS (the only valid targets for primary_source / sourcing_firm overrides):`,
    `  Supplier lanes, ${rows.supplierLanes.length} across ${byMaterial.size} materials` +
      (mats.length > budget ? ` (showing ${budget} materials, most choices first)` : "") + ":",
    ...supLines,
    `  Customer × product rows, ${rows.customerLanes.length}` +
      (rows.customerLanes.length > budget ? ` (showing ${budget})` : "") + ":",
    ...custLines,
  ].join("\n");
}

// Pre-dispatch validation gate — Phase A / G6 / §8.1–8.2.
//
// Thin edge adapter over the ONE grading module (grading.ts): loads the raw
// project tables and delegates manifest compilation + grading to the same
// code the browser verification runs, so the two surfaces cannot disagree.
// The registry snapshot is the generated mirror kept in sync by
// scsim/scripts/gen_frontend_registry.py (CI drift gate).
//
//   block          → run rejected (engine hard failures, unresolvable required)
//   warn           → rejected unless payload.acknowledge_warnings (the
//                    /policies verification stage sets it after displaying
//                    findings; the Lab offers "Run anyway")
//   info           → never gates
//
// The engine's MappingWarning stream remains the final tripwire; a project
// that passes this gate maps with no warn-level fallbacks (gate E1, §3).

import registry from "./registry.generated.json" with { type: "json" };
import bridge from "./engineBridge.json" with { type: "json" };
import { scheduleFindings, type DisruptionRule } from "./disruptionRules.ts";
import {
  flattenFindings,
  gradeManifest,
  type BridgeTables,
  type GradingDataset,
  type RegistryPayload,
  demandRowFindings,
} from "./grading.ts";

export interface GateFinding {
  severity: "block" | "warn" | "info";
  field: string;
  policy: string;
  rows: string[];
  message: string;
}

export interface GateResult {
  status: "blocked" | "ack_required";
  findings: GateFinding[];
}

export type { GradingDataset as GateDataset };

/**
 * Load the raw tables the grader reads. MUST be called with the service-role
 * client: grading is a read-only completeness check, and the app's custom
 * RLS context never reaches a pooled edge connection (the same reason the
 * project-existence check in sim-command uses the service role).
 */
/** Explicit row ceiling for every gate read. Without a `.limit()` PostgREST
 * applies its own `db-max-rows` (commonly 1000) and truncates SILENTLY, so a
 * large project was graded on a slice while reporting a complete grade. An
 * explicit, generous ceiling makes the bound ours, and a table that comes back
 * at exactly the ceiling is reported through `dataset.truncated`. */
export const GATE_ROW_CEILING = 50_000;

// deno-lint-ignore no-explicit-any
export async function loadGateDataset(sb: any, projectId: string): Promise<GradingDataset> {
  const [materials, products, suppliers, inbound, outbound, bomSingle, bomMulti, overrides, forecasts, customers] = await Promise.all([
    // `name` rides along for the B8 v2 IO-coefficient sector match
    // (estimators.ts::matchIoCoefficient) — the grader itself ignores it.
    sb.from("materials").select("material_id,name,cost,moq,holding_cost_pct").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    sb.from("products").select("product_id,sell_price,demand_mean,production_capacity,demand_cv").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    sb.from("suppliers").select("supplier_id,capacity_per_week,reliability_score").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    sb.from("inbound_logistics").select("supplier_id,material_id,unit_price,lead_time,volume,time_unit").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    sb.from("outbound_logistics").select("product_id,customer_id,unit_price,volume,time_unit,demand_distribution,demand_mean,demand_variation,demand_min,demand_max").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    // consumption_rate rides along for the B8 v2 rate back-test and the
    // mass-balance validator (estimators.ts) — the flatten already read it,
    // defaulting absent rates to 1.0 exactly as the engine does.
    sb.from("bom_single_level").select("product_id,material_id,consumption_rate").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    sb.from("bom_multi_level").select("material_id,higher_level_component_id,consumption_rate").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    // Per-entity policy patches. The grader resolves capacity per product from
    // these exactly as the engine does (§4 D75) — without them it reports a
    // plant-grid line capacity as defaulted while the run uses the value.
    sb.from("policy_overrides").select("scope,target_key,family,patch").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    // PLAN.md §24 WP 14.2 — the per-row forecast buckets.
    sb.from("demand_forecasts").select("customer_id,product_id,period_start,period_end,weekly_quantity").eq("project_id", projectId).limit(GATE_ROW_CEILING),
    // PLAN.md §24 WP 14.3 — priority and contracted floor per customer.
    sb.from("customers").select("customer_id,segment,priority_weight,sla_fill_floor_pct").eq("project_id", projectId).limit(GATE_ROW_CEILING),
  ]);
  // Multi-level rows win when they exist — the same rule the engine's
  // datamap and the frontend lanes apply. Rows pass through RAW: shape
  // normalization (the parent component standing in for product_id) happens
  // inside gradeManifest (normalizeBomRows), shared with the browser grader,
  // so the two surfaces cannot normalize differently. Grading the wrong
  // (empty) table once let a run through the gate only to die in the engine
  // with "bom too_short".
  const multiRows = bomMulti.data ?? [];
  const bom = multiRows.length > 0 ? multiRows : bomSingle.data ?? [];
  // A table that came back at exactly the ceiling was probably cut short.
  // Report it rather than grading a slice as if it were the whole project.
  const truncated = ([
    ["materials", materials], ["products", products], ["suppliers", suppliers],
    ["inbound_logistics", inbound], ["outbound_logistics", outbound],
    ["bom_single_level", bomSingle], ["bom_multi_level", bomMulti],
    ["policy_overrides", overrides], ["demand_forecasts", forecasts], ["customers", customers],
    // deno-lint-ignore no-explicit-any
  ] as Array<[string, any]>)
    .filter(([, r]) => (r?.data?.length ?? 0) >= GATE_ROW_CEILING)
    .map(([name]) => name);
  return {
    materials: materials.data ?? [],
    products: products.data ?? [],
    suppliers: suppliers.data ?? [],
    inbound: inbound.data ?? [],
    outbound: outbound.data ?? [],
    bom,
    overrides: overrides.data ?? [],
    demandForecasts: forecasts?.data ?? [],
    customers: customers?.data ?? [],
    ...(truncated.length > 0 ? { truncated } : {}),
  };
}

/**
 * The gate's dataset from FROZEN versions — PLAN.md §23 WP 13.3.
 *
 * A run of a Validated Model computes from the model's own dataset version and
 * policy version (WP 13.2/13.3), which can differ from the live project; grading
 * the live tables would then judge data the run does not read. This builds the
 * same `GradingDataset` `loadGateDataset` returns, from a `dataset_versions`
 * snapshot (v2/v3: tables under `inputs`) and the policy version's overrides.
 * Pure. Multi-level BOM rows win, as everywhere.
 */
export function gateDatasetFromSnapshot(
  datasetSnapshot: Record<string, unknown>,
  policySnapshot: Record<string, unknown>,
): GradingDataset {
  const inputs = (
    datasetSnapshot && typeof datasetSnapshot.inputs === "object" && datasetSnapshot.inputs
      ? datasetSnapshot.inputs
      : datasetSnapshot
  ) as Record<string, unknown>;
  const rows = (k: string) => (Array.isArray(inputs[k]) ? (inputs[k] as Record<string, unknown>[]) : []);
  const multi = rows("bom_multi_level");
  const overrides = Array.isArray(policySnapshot?.overrides)
    ? (policySnapshot.overrides as Record<string, unknown>[]).map((o) => ({ scope: "node", ...o }))
    : [];
  return {
    materials: rows("materials"),
    products: rows("products"),
    suppliers: rows("suppliers"),
    inbound: rows("inbound"),
    outbound: rows("outbound"),
    bom: multi.length > 0 ? multi : rows("bom"),
    overrides,
    demandForecasts: rows("demand_forecasts"),
    customers: rows("customers"),
  };
}

/** The `meta.note` for a tool envelope built from a graded dataset.
 *
 * Two things can make such a result partial, and both must reach the model:
 * the loader hit the row ceiling (`dataset.truncated`), or the tool capped its
 * own output. Silence on either produces a confident "your project has N gaps"
 * from a slice. Returns a spreadable object so the caller can inline it. */
export function gradedResultNote(
  dataset: GradingDataset,
  total: number,
  shown: number,
  unit: string,
): { note?: string } {
  const parts: string[] = [];
  if (dataset.truncated?.length) {
    parts.push(
      `PARTIAL DATASET — ${dataset.truncated.join(", ")} hit the ${GATE_ROW_CEILING}-row read ceiling, ` +
        `so this grade was computed on a slice of the project. Say so; do not report it as complete.`,
    );
  }
  if (total > shown) {
    parts.push(
      `${total} ${unit} in total; showing ${shown}. Do not describe this as the complete list.`,
    );
  }
  return parts.length > 0 ? { note: parts.join(" ") } : {};
}

export function runValidationGate(args: {
  dataset: GradingDataset;
  snapshotDefaults: Record<string, unknown>;
  disruptionSchedule: Array<Record<string, unknown>>;
  acknowledgeWarnings: boolean;
  /** The run's length in weeks, for the "forecast shorter than the run" warning. */
  horizonWeeks?: number;
}): GateResult | null {
  const { dataset, snapshotDefaults, disruptionSchedule, acknowledgeWarnings, horizonWeeks } = args;

  const graded = gradeManifest(
    dataset,
    snapshotDefaults,
    registry as unknown as RegistryPayload,
    bridge as unknown as BridgeTables,
  );
  const findings: GateFinding[] = flattenFindings(graded).map(
    ({ severity, field, policy, rows, message }) =>
      ({ severity, field, policy, rows, message }),
  );

  // Scenario-conditional checks — the engine's exported disruption rule, graded
  // by the module the Lab's pre-run panel uses too (one definition, two surfaces).
  findings.push(
    ...scheduleFindings(
      dataset.suppliers,
      disruptionSchedule ?? [],
      (registry as unknown as { disruption: DisruptionRule }).disruption,
      dataset.inbound,
    ).map(
      ({ severity, field, policy, rows, message }) =>
        ({ severity, field, policy, rows, message }),
    ),
  );

  // PLAN.md §24 WP 14.2 — the rows' own demand specs and forecast series.
  findings.push(
    ...demandRowFindings(dataset.outbound, dataset.demandForecasts ?? [], dataset.overrides ?? [], horizonWeeks).map(
      ({ severity, field, policy, rows, message }) => ({ severity, field, policy, rows, message }),
    ),
  );

  // A graded SLICE is not a pass (audit F-19b). `loadGateDataset` has always
  // reported a table that came back at the ceiling, and this function never
  // read it — so a large project cleared the gate on part of its data while
  // the run row recorded a clean pass. It is a `warn`: the caller must see it
  // and acknowledge it, like any other finding the engine could survive.
  if (dataset.truncated?.length) {
    findings.push({
      severity: "warn",
      field: "dataset.truncated",
      policy: "validation_gate",
      rows: [...dataset.truncated],
      message:
        `${dataset.truncated.join(", ")} reached the ${GATE_ROW_CEILING}-row read ceiling, so this ` +
        "check graded a slice of the project, not all of it. Findings beyond the slice are unknown.",
    });
  }

  const blocks = findings.filter((f) => f.severity === "block");
  const warns = findings.filter((f) => f.severity === "warn");
  if (blocks.length > 0) return { status: "blocked", findings };
  if (warns.length > 0 && !acknowledgeWarnings) return { status: "ack_required", findings };
  return null;
}

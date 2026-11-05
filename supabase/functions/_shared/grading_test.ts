// Grader contract tests (§8.2) — run with `deno test --allow-read`.
//
// Locks the shared grading module to the golden validation-parity fixture.
// The Python side of the same contract is sim-worker/tests/
// test_validation_parity.py: it feeds the SAME dataset.json through
// datamap → scsim's from_project_data and asserts the engine's WARN-level
// MappingWarnings coincide with the grader's warn findings. Together the two
// suites pin browser, edge gate, and engine to one semantic.

import registry from "./registry.generated.json" with { type: "json" };
import bridge from "./engineBridge.json" with { type: "json" };
import fixture from "./fixtures/validation_parity/dataset.json" with { type: "json" };
import expected from "./fixtures/validation_parity/expected_findings.json" with { type: "json" };
import {
  activeEnginePolicies,
  demandRowFindings,
  flattenFindings,
  gradeManifest,
  normalizeBomRows,
  type BridgeTables,
  type GradingDataset,
  type RegistryPayload,
  type Row,
} from "./grading.ts";
import { runValidationGate } from "./validationGate.ts";

const REG = registry as unknown as RegistryPayload;
const BRIDGE = bridge as unknown as BridgeTables;
const DATASET = fixture.dataset as unknown as GradingDataset;
const DEFAULTS = fixture.defaults as Row;

function assertEquals(actual: unknown, expectedVal: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expectedVal);
  if (a !== b) {
    throw new Error(`${msg}\n  actual:   ${a}\n  expected: ${b}`);
  }
}

Deno.test("golden fixture grades to the committed expected findings", () => {
  const findings = flattenFindings(gradeManifest(DATASET, DEFAULTS, REG, BRIDGE));
  assertEquals(findings, expected, "grader output drifted from the golden snapshot");
});

Deno.test("the golden fixture never blocks — engine-warn fallbacks are ack-able", () => {
  const findings = flattenFindings(gradeManifest(DATASET, DEFAULTS, REG, BRIDGE));
  const blocks = findings.filter((f) => f.severity === "block");
  assertEquals(blocks, [], "no block may exist: every gap has an engine fallback");
});

Deno.test("an unsourced BOM material is the hard block (engine ValueError mirror)", () => {
  const variant: GradingDataset = {
    ...DATASET,
    materials: [...DATASET.materials, ...(fixture.unsourced_extra.materials as Row[])],
    bom: [...DATASET.bom, ...(fixture.unsourced_extra.bom as Row[])],
  };
  const findings = flattenFindings(gradeManifest(variant, DEFAULTS, REG, BRIDGE));
  const blocks = findings.filter((f) => f.severity === "block");
  assertEquals(blocks.length, 1, "exactly one block expected");
  assertEquals(blocks[0].field, "materials.supplier_link", "block field");
  assertEquals(blocks[0].rows, ["M_UNSOURCED"], "blocked material");
});

// ── Multi-level BOM golden variant (§8.2) ────────────────────────────────────
// The SAME BOM in bom_multi_level shape — P_OK's materials routed through the
// intermediate assembly SUB_OK — must grade exactly like the single-level
// fixture. Both the browser verification and the sim-command gate pass their
// BOM rows RAW into gradeManifest, which flattens the multi-level shape
// itself (normalizeBomRows, the datamap._flatten_multi_level_bom port) — so
// these tests pin BOTH surfaces at once: the two can never again grade
// different BOMs, intermediates are never flagged unsourced (the engine
// demands supplier links only for leaf materials), and an unsourced leaf
// under an intermediate still blocks.

const MULTI_BOM = fixture.multi_level_variant.bom as Row[];
const MULTI_UNSOURCED_BOM = fixture.multi_level_variant.unsourced_bom as Row[];

Deno.test("multi-level BOM grades identically to the same BOM in single-level shape", () => {
  const multi = flattenFindings(
    gradeManifest({ ...DATASET, bom: MULTI_BOM }, DEFAULTS, REG, BRIDGE),
  );
  const single = flattenFindings(gradeManifest(DATASET, DEFAULTS, REG, BRIDGE));
  assertEquals(multi, single, "the two BOM shapes graded differently");
  assertEquals(multi, expected, "multi-level grading drifted from the golden snapshot");
});

Deno.test("multi-level BOM: an unsourced material raises the same hard block", () => {
  const extraMaterials = fixture.unsourced_extra.materials as Row[];
  const multiVariant: GradingDataset = {
    ...DATASET,
    materials: [...DATASET.materials, ...extraMaterials],
    bom: [...MULTI_BOM, ...MULTI_UNSOURCED_BOM],
  };
  const findings = flattenFindings(gradeManifest(multiVariant, DEFAULTS, REG, BRIDGE));
  const blocks = findings.filter((f) => f.severity === "block");
  assertEquals(blocks.length, 1, "exactly one block expected");
  assertEquals(blocks[0].field, "materials.supplier_link", "block field");
  assertEquals(blocks[0].rows, ["M_UNSOURCED"], "blocked material");

  // Finding-for-finding parity with the single-level unsourced variant.
  const singleVariant: GradingDataset = {
    ...DATASET,
    materials: [...DATASET.materials, ...extraMaterials],
    bom: [...DATASET.bom, ...(fixture.unsourced_extra.bom as Row[])],
  };
  assertEquals(
    findings,
    flattenFindings(gradeManifest(singleVariant, DEFAULTS, REG, BRIDGE)),
    "multi- and single-level unsourced variants graded differently",
  );
});

Deno.test("gate: a multi-level unsourced BOM material blocks the dispatch", () => {
  const gate = runValidationGate({
    dataset: {
      ...DATASET,
      materials: [...DATASET.materials, ...(fixture.unsourced_extra.materials as Row[])],
      bom: [...MULTI_BOM, ...MULTI_UNSOURCED_BOM],
    },
    snapshotDefaults: DEFAULTS,
    disruptionSchedule: [],
    acknowledgeWarnings: true,
  });
  if (gate?.status !== "blocked") {
    throw new Error(`expected blocked, got ${JSON.stringify(gate?.status)}`);
  }
  const block = gate.findings.find((f) => f.severity === "block");
  assertEquals(block?.field, "materials.supplier_link", "block field");
  assertEquals(block?.rows, ["M_UNSOURCED"], "blocked material");
});

Deno.test("normalizeBomRows: flattens to root→leaf pairs; single-level passes through", () => {
  const pairs = (rows: Row[]) =>
    rows
      .map((r) => `${r.product_id}→${r.material_id}`)
      .sort();
  assertEquals(
    pairs(normalizeBomRows(MULTI_BOM)),
    pairs(DATASET.bom),
    "flattened multi rows must carry the single-level (product_id, material_id) pairs",
  );
  // The intermediate assembly is collapsed away — it is neither a product
  // nor a material in any flattened pair (the engine never sources it).
  const flat = normalizeBomRows([...MULTI_BOM, ...MULTI_UNSOURCED_BOM]);
  if (flat.some((r) => r.product_id === "SUB_OK" || r.material_id === "SUB_OK")) {
    throw new Error("intermediate SUB_OK leaked into the flattened BOM");
  }
  // The deep leaf traces up to its root product.
  if (!flat.some((r) => r.product_id === "P_OK" && r.material_id === "M_UNSOURCED")) {
    throw new Error("deep leaf M_UNSOURCED did not flatten up to P_OK");
  }
  assertEquals(
    normalizeBomRows(DATASET.bom),
    DATASET.bom,
    "single-level rows must pass through unchanged",
  );
});

Deno.test("gate: warns require acknowledgment, acknowledged warns dispatch", () => {
  const unacknowledged = runValidationGate({
    dataset: DATASET,
    snapshotDefaults: DEFAULTS,
    disruptionSchedule: [],
    acknowledgeWarnings: false,
  });
  if (unacknowledged?.status !== "ack_required") {
    throw new Error(`expected ack_required, got ${JSON.stringify(unacknowledged?.status)}`);
  }
  const acknowledged = runValidationGate({
    dataset: DATASET,
    snapshotDefaults: DEFAULTS,
    disruptionSchedule: [],
    acknowledgeWarnings: true,
  });
  assertEquals(acknowledged, null, "acknowledged warns must dispatch");
});

Deno.test("policy activation matches the engine mapper (parity variant)", () => {
  // sim-worker/tests/test_validation_parity.py asserts the Python half:
  // _map_policies on the same defaults yields exactly expected_policies.
  const v = fixture.activation_variant;
  const active = activeEnginePolicies(v.defaults as Row, 1, BRIDGE, true).sort();
  assertEquals(active, v.expected_policies, "TS activation set diverged from _map_policies");
});

Deno.test("gate: partial-magnitude disruption on a capacity-less supplier warns", () => {
  const gate = runValidationGate({
    dataset: DATASET,
    snapshotDefaults: DEFAULTS,
    disruptionSchedule: [
      { target: "S1", magnitude_pct: 50, start_day: 30, duration_days: 14 },
    ],
    acknowledgeWarnings: false,
  });
  const hit = gate?.findings.find(
    (f) => f.field === "suppliers.capacity_per_week" && f.rows.includes("S1"),
  );
  if (!hit) throw new Error("expected the S1 capacity warn");
});

// ── §4 D75 — per-product capacity must grade the way the engine resolves it ──
// The plant grid keys its production patches "<plant>::<product>". Before the
// engine learned that spelling the grader agreed with it by accident: both
// ignored the row. Now the engine applies it, so a grader that still reports
// "defaulted" tells the user the opposite of what the run will do.

const PLANT = fixture.plant_override_variant;
const CAP_FIELD = "products.production_capacity";
const CAP_TARGET = PLANT.target_product as string;

/** Rows still reported as capacity-defaulted for `overrides`. */
function capacityWarnRows(overrides: Row[]): string[] {
  const variant: GradingDataset = { ...DATASET, overrides };
  const findings = flattenFindings(gradeManifest(variant, DEFAULTS, REG, BRIDGE));
  const warn = findings.find((f) => f.field === CAP_FIELD && f.severity === "warn");
  return warn ? warn.rows : [];
}

/** The weekly capacity the grader resolved for `id`, or undefined. */
function resolvedCapacity(overrides: Row[], id: string): number | undefined {
  const variant: GradingDataset = { ...DATASET, overrides };
  const graded = gradeManifest(variant, DEFAULTS, REG, BRIDGE)
    .find((g) => g.field === CAP_FIELD);
  return graded?.resolved.find((r) => r.id === id)?.value;
}

Deno.test("D75: a dataset with no overrides grades exactly as before", () => {
  // The no-regression guard. The golden snapshot test above already pins the
  // absent-field case; this pins the present-but-empty one.
  assertEquals(capacityWarnRows([]), ["P_PRICE_FALLBACK", "P_NO_DEMAND"],
    "an empty overrides array must change nothing");
});

Deno.test("D75: a composite <plant>::<product> override resolves capacity", () => {
  const rows = capacityWarnRows(PLANT.composite as Row[]);
  assertEquals(rows.includes(CAP_TARGET), false,
    `${CAP_TARGET} has a line capacity — the engine uses it, so the grader may not call it defaulted`);
  assertEquals(rows, ["P_NO_DEMAND"], "the product without an override still warns");
  assertEquals(
    resolvedCapacity(PLANT.composite as Row[], CAP_TARGET),
    PLANT.expected_weekly_capacity.composite,
    "capacity_units_per_day x 7 x utilization — the engine's own arithmetic",
  );
});

Deno.test("D75: the bare node:<product> spelling still resolves", () => {
  assertEquals(
    resolvedCapacity(PLANT.bare as Row[], CAP_TARGET),
    PLANT.expected_weekly_capacity.bare,
    "the bare key must keep working — no writer is required to use the composite form",
  );
});

Deno.test("D75: composite beats bare, matching the engine's precedence", () => {
  const both = [...(PLANT.bare as Row[]), ...(PLANT.composite as Row[])];
  assertEquals(
    resolvedCapacity(both, CAP_TARGET),
    PLANT.expected_weekly_capacity.composite,
    "defaults < node:<product> < node:<owner>::<product>",
  );
});

Deno.test("D75: an override on a product with a master capacity is not consulted", () => {
  // Master precedence is the engine's (project_map.py) and gradeManifest's
  // short-circuit on binding.master(row) > 0 — P_OK carries 900 units/week.
  const rows = capacityWarnRows([{
    scope: "node", target_key: "Focal plant::P_OK", family: "production",
    patch: { capacity_units_per_day: 1 },
  }] as Row[]);
  assertEquals(rows, ["P_PRICE_FALLBACK", "P_NO_DEMAND"],
    "P_OK has a master capacity, so it is neither warned nor policy-resolved");
});

Deno.test("D75: a non-production or non-node override is ignored", () => {
  const rows = capacityWarnRows([
    { scope: "node", target_key: `Focal plant::${CAP_TARGET}`, family: "inventory",
      patch: { capacity_units_per_day: 20 } },
    { scope: "edge", target_key: `Focal plant::${CAP_TARGET}`, family: "production",
      patch: { capacity_units_per_day: 20 } },
    { scope: "node", target_key: "Focal plant::P_NOT_A_PRODUCT", family: "production",
      patch: { capacity_units_per_day: 20 } },
  ] as Row[]);
  assertEquals(rows, ["P_PRICE_FALLBACK", "P_NO_DEMAND"],
    "only a node-scoped production patch naming a real product may resolve capacity");
});

Deno.test("D75: two owners on one product merge in key order (nganho124, PR #220)", () => {
  assertEquals(
    resolvedCapacity(PLANT.ambiguous as Row[], CAP_TARGET),
    PLANT.expected_weekly_capacity.ambiguous,
    "last key wins on a shared field; the other owner's untouched fields survive",
  );
});

Deno.test("D75: an owner name containing the separator still resolves", () => {
  assertEquals(
    resolvedCapacity(PLANT.nested_owner as Row[], CAP_TARGET),
    PLANT.expected_weekly_capacity.nested_owner,
    "second split candidate — a plant literally named \"A::B\"",
  );
});

// ── materials.cost is the volume-weighted lane price (§8.2) ──────────────────
// The golden findings above name the rows a fallback resolves; they do not
// carry the NUMBER, and the number is the whole of this rule. M_MULTI quotes
// 10.0 on a 300/week lane and 6.0 on a 100/week one: the engine values it at
// 9.0, and the cheapest quote (6.0) is what the chain would answer if the
// first step were skipped or the weights were dropped.

Deno.test("materials.cost resolves to the volume-weighted lane price, not the cheapest quote", () => {
  const graded = gradeManifest(DATASET, DEFAULTS, REG, BRIDGE)
    .find((g) => g.field === "materials.cost")!;
  const multi = graded.resolved.find((r) => r.id === "M_MULTI")!;
  assertEquals(multi.via, "volume_weighted_inbound_price", "M_MULTI reducer");
  assertEquals(multi.value, 9, "(10×300 + 6×100) / 400 — the cheapest quote is 6");
  assertEquals(multi.grade, "info", "a data-derived step is never a warn");

  // A single priced lane weights to its own price — the chain does not change
  // what a single-sourced material costs.
  const single = graded.resolved.find((r) => r.id === "M_DERIVED")!;
  assertEquals(single.value, 3, "M_DERIVED's one lane");
});

Deno.test("with no lane volumes the chain falls back to the cheapest quote", () => {
  const noVolumes = (DATASET.inbound as Row[]).map((a) => ({ ...a, volume: null }));
  const graded = gradeManifest({ ...DATASET, inbound: noVolumes }, DEFAULTS, REG, BRIDGE)
    .find((g) => g.field === "materials.cost")!;
  const multi = graded.resolved.find((r) => r.id === "M_MULTI")!;
  assertEquals(multi.via, "cheapest_inbound_price", "second step of the chain");
  assertEquals(multi.value, 6, "the cheapest of 10.0 and 6.0");
});

Deno.test("a lane with no volume carries no weight rather than an epsilon one", () => {
  // Drop the 100/week lane's volume: the weighted mean must become the other
  // lane's price exactly, not a near-average of the two.
  const inbound = (DATASET.inbound as Row[]).map((a) =>
    a.material_id === "M_MULTI" && a.supplier_id === "S2" ? { ...a, volume: 0 } : a
  );
  const graded = gradeManifest({ ...DATASET, inbound }, DEFAULTS, REG, BRIDGE)
    .find((g) => g.field === "materials.cost")!;
  assertEquals(graded.resolved.find((r) => r.id === "M_MULTI")!.value, 10, "S1's price alone");
});

// ── WP 9.4 slice 6 · the disruption rule, graded from the engine's export ─────
import { engineTargetOf, engineTargetReason, scheduleFindings, type DisruptionRule } from "./disruptionRules.ts";

const RULE = (registry as unknown as { disruption: DisruptionRule }).disruption;
const SUPPLIERS: Row[] = [
  { supplier_id: "S_CAP", capacity_per_week: 500 },
  { supplier_id: "S_NOCAP", capacity_per_week: null },
];
const ev = (target: string, magnitude_pct = 100): Row => ({
  target, target_type: "node", start_day: 140, duration_days: 28, magnitude_pct,
});

Deno.test("the rule is the engine's export, not a restatement", () => {
  assertEquals(RULE.event_cap, 5, "project_map.EVENT_CAP");
  assertEquals(RULE.duration_weeks_max, 52, "project_map.EVENT_DURATION_WEEKS_MAX");
  assertEquals(RULE.supported_target_kinds, ["supplier", "plant", "material"], "RULE.supported_target_kinds");
  assertEquals(RULE.material_cut_runs_as_outage, true, "registry_export material_cut_runs_as_outage");
});

Deno.test("engineTargetOf follows _map_events: a supplier id, the plant, a supplied material, or skipped", () => {
  const ids = new Set(["S_CAP"]);
  const mats = new Set(["M1"]);
  assertEquals(engineTargetOf("supplier:S_CAP", ids, RULE).kind, "supplier", "engineTargetOf(\"supplier:S_CAP\"");
  assertEquals(engineTargetOf("S_CAP", ids, RULE).kind, "supplier", "engineTargetOf(\"S_CAP\"");
  assertEquals(engineTargetOf("node:plant", ids, RULE).kind, "plant", "engineTargetOf(\"node:plant\"");
  assertEquals(engineTargetOf("plant:P1", ids, RULE).kind, "plant", "engineTargetOf(\"plant:P1\"");
  // Engine 0.9.0 (PLAN.md §29 WP 19.1): a material with a supply link is a target;
  // one with none is skipped, and says it is a material that is missing.
  assertEquals(engineTargetOf("material:M1", ids, RULE, mats).kind, "material", "engineTargetOf(\"material:M1\", mats");
  const missing = engineTargetOf("material:M1", ids, RULE);
  assertEquals(missing.kind, "unknown", "engineTargetOf(\"material:M1\") with no supplied materials");
  assertEquals(engineTargetReason(missing)?.includes("No supplied material named"), true, "the material reason");
  assertEquals(engineTargetOf("customer:all", ids, RULE).kind, "unsupported", "engineTargetOf(\"customer:all\"");
  assertEquals(engineTargetOf("supplier:NOPE", ids, RULE).kind, "unknown", "engineTargetOf(\"supplier:NOPE\"");
});

Deno.test("a clean schedule earns no finding", () => {
  assertEquals(scheduleFindings(SUPPLIERS, [ev("supplier:S_CAP", 30), ev("node:plant")], RULE), [], "scheduleFindings(SUPPLIERS");
});

Deno.test("events past the cap, skipped targets and uncapacitated cuts are each said", () => {
  const six = [1, 2, 3, 4, 5, 6].map(() => ev("supplier:S_CAP"));
  assertEquals(scheduleFindings(SUPPLIERS, six, RULE).length, 1, "one cap finding");
  const f = scheduleFindings(SUPPLIERS, [ev("material:M1"), ev("supplier:S_NOCAP", 30)], RULE);
  assertEquals(f.length, 2, "f.length");
  assertEquals(f[0].field, "scenarios.disruption_schedule", "f[0].field");
  assertEquals(f[1].field, "suppliers.capacity_per_week", "f[1].field");
  // §4 D223: the engine cuts BY the share — a 30% cut is not "to 30%".
  assertEquals(f[1].message.includes("by 30%"), true, f[1].message);
});

Deno.test("a supplied material is graded as the engine maps it (engine 0.9.0)", () => {
  const inbound = [{ supplier_id: "S_CAP", material_id: "M1" }];
  assertEquals(scheduleFindings(SUPPLIERS, [ev("material:M1")], RULE, inbound), [], "a material outage is clean");
  const cut = scheduleFindings(SUPPLIERS, [ev("material:M1", 40)], RULE, inbound);
  assertEquals(cut.length, 1, "a partial cut on a material is said once");
  assertEquals(cut[0].message.includes("full outage of its supply"), true, cut[0].message);
});

// ── §23 WP 13.1 — a /policies override of an item master is SET ─────────────
// /policies never writes the masters: a cost typed there is a Supplier-row
// override the engine reads BEFORE `materials.cost`. M_DERIVED has no master
// cost, so without the override the chain derives one from its lane; with a
// usable override the grader must say SET — the value the run will use — and
// with an override outside its declared domain (cost 0) the engine ignores it,
// so the grader must too.

Deno.test("WP 13.1: a usable /policies cost override makes materials.cost set", () => {
  const arc = (DATASET.inbound as Row[]).find((a) => a.material_id === "M_DERIVED")!;
  const key = `${arc.supplier_id}::M_DERIVED`;
  const withOverride = (cost: unknown): GradingDataset => ({
    ...DATASET,
    overrides: [{ scope: "node", target_key: key, family: "sourcing", patch: { material_cost: cost } }],
  });
  const set = gradeManifest(withOverride(4.5), DEFAULTS, REG, BRIDGE).find((g) => g.field === "materials.cost")!;
  assertEquals(set.set.includes("M_DERIVED"), true, "the override is the value the run uses");
  assertEquals(set.resolved.some((r) => r.id === "M_DERIVED"), false, "not also derived");
  const ignored = gradeManifest(withOverride(0), DEFAULTS, REG, BRIDGE).find((g) => g.field === "materials.cost")!;
  assertEquals(ignored.set.includes("M_DERIVED"), false, "a cost of 0 is outside the domain; the engine ignores it");
});


// PLAN.md §24 WP 14.2 — a row's demand spec must carry what its distribution
// needs (the engine would DROP it and run the product's distribution: a block),
// and a forecast shorter than the run or with a gap is a warn. A Customer-row
// override completes a spec the upload left incomplete.
Deno.test("WP 14.2: an incomplete row demand spec blocks; an override can complete it", () => {
  const outbound: Row[] = [
    { customer_id: "C1", product_id: "P1", demand_distribution: "normal", demand_mean: 40 },
    { customer_id: "C2", product_id: "P1", demand_distribution: "triangular", demand_mean: 10 },
    { customer_id: "C3", product_id: "P1" },
  ];
  const blocks = demandRowFindings(outbound).filter((f) => f.severity === "block");
  assertEquals(blocks.flatMap((f) => f.rows).sort(), ["C1::P1", "C2::P1"], "normal without a CV and triangular without bounds block");
  const fixed = demandRowFindings(outbound, [], [
    { scope: "node", target_key: "C1::P1", family: "demand", patch: { row_demand_variation: 0.2 } },
    { scope: "node", target_key: "C2::P1", family: "demand", patch: { row_demand_min: 5, row_demand_max: 20 } },
  ]);
  assertEquals(fixed.filter((f) => f.severity === "block").length, 0, "the overrides complete both specs");
});

Deno.test("WP 14.2: a forecast shorter than the run, or with a gap, warns", () => {
  const outbound: Row[] = [{ customer_id: "C1", product_id: "P1", demand_distribution: "deterministic" }];
  const forecasts: Row[] = [
    { customer_id: "C1", product_id: "P1", period_start: "2026-01-05", period_end: "2026-01-12", weekly_quantity: 50 },
    { customer_id: "C1", product_id: "P1", period_start: "2026-01-19", period_end: "2026-01-26", weekly_quantity: 50 },
  ];
  const f = demandRowFindings(outbound, forecasts, [], 52);
  assertEquals(f.every((x) => x.severity === "warn"), true, "a short or gapped series is a warn, not a block");
  assertEquals(f.length, 2, "one for the short series, one for the gap");
  assertEquals(f[0].rows[0], "C1::P1 (3 of 52 wk)", "the row and its coverage are named");
  // A deterministic row with a series needs no mean: the series is its centre.
  assertEquals(demandRowFindings(outbound, forecasts).filter((x) => x.severity === "block").length, 0, "no block");
});

Deno.test("WP 14.3: customers.priority_weight is graded — a stated 0 is set, a blank is not", () => {
  const ds: GradingDataset = {
    ...DATASET,
    // Two customers on the lanes, so P-C.2 is active and grades its requirements.
    outbound: [
      ...DATASET.outbound,
      { customer_id: "C1", product_id: "P-X", volume: 1, unit_price: 1 },
      { customer_id: "C3", product_id: "P-X", volume: 1, unit_price: 1 },
    ],
    customers: [
      { customer_id: "C1", priority_weight: 0 },
      { customer_id: "C2", priority_weight: null },
      { customer_id: "C3", priority_weight: 4 },
    ],
  };
  const g = gradeManifest(ds, { ...DEFAULTS, fulfillment: { allocation: "priority" } }, REG, BRIDGE)
    .find((f) => f.field === "customers.priority_weight");
  if (!g) throw new Error("priority rule with ≥ 2 customers must grade customers.priority_weight");
  assertEquals(g.evaluable, true, "the binding exists (contract:check R13)");
  assertEquals(g.set.sort(), ["C1", "C3"], "0 is the lowest priority, not an empty cell");
  assertEquals(g.set.includes("C2"), false, "a blank falls to the default");
});

// The /policies page, column by column: what each cell shows, where an edit is
// saved, what the simulation engine actually uses, and whether an edit changes
// a run. Rendered on the Data map view (`PolicyColumnCheck.tsx`).
//
// WHERE EACH FACT COMES FROM, so this file is not a second author of any:
//   - WHICH columns exist, their header label and sub-label: read from
//     `STAGE_TABLE_SPEC` / `COLUMN_FIT` / `shortLabelFor` — the grid's own spec.
//     `policyColumnCheck.test.ts` fails when a column is added to (or removed
//     from) the spec without its verdict here, so the page cannot go stale by
//     omission.
//   - WHAT the engine does with each field: `scsim/scsim/io/project_map.py`
//     (`_map_policies`, the product / material / arc loops). The verdicts below
//     restate that reader in words; the test pins the one mechanical part of it
//     (a column may only claim to reach the engine if it is master-backed or in
//     `SCSIM_VISIBLE_FIELDS`).
//   - The production counts: PLAN.md §15, audit 2026-09-29, run `36629798467`,
//     every project. They are dated because they are measurements, not rules.
//   - Each open problem cites its PLAN.md §4 D-row, which owns the evidence.
import { COLUMN_FIT, STAGE_TABLE_SPEC, shortLabelFor } from "./columnSpecs";
import type { StageKey } from "./stages";
import { PLANNING_UNIT, UNIT_LABEL_PLURAL } from "@/hooks/useTimeUnit";

/** Whether an edit made on /policies changes what the simulation runs. */
export type Verdict =
  /** An edit changes the run. */
  | "works"
  /** An edit changes the run only under the stated condition. */
  | "conditional"
  /** Read-only here; the value shown is NOT the value the engine uses. */
  | "differs"
  /** Stored and versioned, never read by the engine. */
  | "ignored"
  /** Shown disabled; nothing reads it yet. */
  | "disabled"
  /** Read-only and faithful, or a structural column with no value to edit. */
  | "info";

export interface ColumnCheck {
  /** What the cell displays, and where that value is read from. */
  shows: string;
  /** Where an edit is written ("—" when the cell is read-only). */
  savedTo: string;
  /** What the engine uses for this quantity, with its own default when blank. */
  engine: string;
  verdict: Verdict;
  /** The condition, and what production shows. */
  note?: string;
  /** What the column should be for the page and the run to agree. */
  shouldBe?: string;
  /** PLAN.md §4 rows that own the problem. */
  refs?: string[];
}

/** Production measurement the notes quote. */
export const MEASURED = {
  date: "2026-09-29",
  run: "36629798467",
  scope: "every project in production (10)",
} as const;

export const GRID_STAGES = ["supplier", "plant", "customer"] as const satisfies readonly StageKey[];
export type GridStage = (typeof GRID_STAGES)[number];

export const STAGE_TITLE: Record<GridStage, string> = {
  supplier: "Supplier stage — one row per supplier × material (override key supplier::material)",
  plant: "Plant stage — one row per finished product (override key plant::product)",
  customer: "Customer stage — one row per customer × product (override key customer::product)",
};

/** Where the stage's ROWS come from — the first thing a reader needs. */
export const STAGE_ROWS: Record<GridStage, string> = {
  supplier:
    "Rows: the stored lane graph (get_supply_chain_data, inbound lanes) enriched from inbound_logistics, " +
    "plus '(made in-house)', '(unassigned supplier)' and 'not in BOM' lines. The engine reads inbound_logistics " +
    "directly, never the stored graph — so a stale graph (§4 D187; Project 2 today) shows lanes the run does not use.",
  plant:
    "Rows: products that are a BOM parent in the stored graph AND ship outbound. The 'Focal plant' key is " +
    "projects.plant_name (§4 D202: Project AA's data sits on a different plant name). No demand cell: demand is " +
    "authored on the Customer rows, and a Plant-row demand override is no longer read (§4 D286). The FG stock columns appear " +
    "per row, behind the row's own MTS / MTO — the value the engine reads (row → products.fulfillment_mode → " +
    "projects.supply_chain_model → MTO); the policy's fulfillment strategy decides nothing here (§4 D197). " +
    "How much FG to keep is the row's S (or s,S / D); P-P.4's project buffer has no control, and a saved one shows as a removable notice.",
  customer:
    "Rows: outbound lanes of the stored graph. Backorder, priority, price and service target are per row (WP 14.3); " +
    "the allocation rule is the one line above the grid (2+ customers only). The demand parameters follow the row's " +
    "distribution, and Forecast is offered only on a row with an uploaded series.",
};

/** The key (identity) columns, which are not in the column spec's `cols`. */
export const KEY_COLUMNS: Record<GridStage, Array<{ label: string; check: ColumnCheck }>> = {
  supplier: [
    {
      label: "Material (flat view)",
      check: { shows: "material id of the lane (inbound_logistics.material_id)", savedTo: "—", engine: "arc material_id", verdict: "info" },
    },
    {
      label: "Product / L0…Ln (BOM tree view)",
      check: {
        shows: "the BOM path, from the uploaded bom_multi_level rows",
        savedTo: "—",
        engine: "the engine flattens the same BOM (datamap._flatten_multi_level_bom)",
        verdict: "info",
        note: "Multi-level projects only; a single-level project keeps the flat view.",
      },
    },
    {
      label: "Qty / assy (BOM tree view)",
      check: {
        shows: "the edge rate from the STORED multi-tier graph; tooltip flow and demand from the same graph",
        savedTo: "—",
        engine: "bom consumption_rate (blank → 1.0); demand = products.demand_mean, else Σ weekly outbound",
        verdict: "differs",
        note:
          "The graph reads a blank rate as 0 (0 blank rates today) and builds flow from outbound volume only, " +
          "never demand_mean — all 6 Aumovio products differ.",
        shouldBe: "graph built by the engine's rules: rate default 1.0, demand_mean first",
        refs: ["D195", "D198"],
      },
    },
    {
      label: "Qty / assy (flat view, single-level BOM)",
      check: {
        shows:
          "bom_single_level.consumption_rate for each product that uses the material — one value, or the range and product count; every product is listed in the tooltip",
        savedTo: "— (read-only; change it in the BOM file)",
        engine: "the same rate (BomArc.consumption_rate); blank or 0 → 1.0",
        verdict: "info",
        note: "A blank or 0 rate shows the engine's 1, marked 'def'. A material outside the BOM shows '—'. Hidden when the project has no single-level BOM rows.",
      },
    },
    {
      label: "Supplier",
      check: { shows: "supplier id of the lane (inbound_logistics.supplier_id)", savedTo: "—", engine: "arc supplier_id", verdict: "info" },
    },
  ],
  plant: [
    {
      label: "Focal plant",
      check: {
        shows: "projects.plant_name",
        savedTo: "—",
        engine: "ignored (the engine is single-plant and merges plant names)",
        verdict: "info",
        note: "Project AA: record says 'Plant AA', data says 'Plant AA Rocherfort'.",
        refs: ["D202"],
      },
    },
    { label: "Product", check: { shows: "product id", savedTo: "—", engine: "product id", verdict: "info" } },
  ],
  customer: [
    { label: "Customer", check: { shows: "customer id (outbound lane)", savedTo: "—", engine: "customer id", verdict: "info" } },
    { label: "Product", check: { shows: "product id (outbound lane)", savedTo: "—", engine: "product id", verdict: "info" } },
  ],
};

/**
 * One verdict per grid column, keyed `<stage>:<field>`. The test requires the
 * key set to equal the spec's columns exactly.
 */
export const COLUMN_CHECK: Record<string, ColumnCheck> = {
  // ─────────────────────────────── supplier ───────────────────────────────
  "supplier:primary_source": {
    shows:
      "saved choice; with nothing saved, the engine's own pick: cheapest link → shortest lead time → supplier id",
    savedTo: "override sourcing.primary_source",
    engine:
      "the material's primary link (where orders go): the saved choice, else the cheapest link. " +
      "Two saved for one material → neither applied, warned",
    verdict: "works",
    note:
      "866 stored as of the audit — seeded under the OLD suggestion (highest volume), so on multi-sourced " +
      "materials those runs now buy from the saved supplier rather than the cheapest one. The run log counts how many.",
    refs: ["D188"],
  },
  "supplier:supply_share": {
    shows: "override, 0–1 (column appears only when sourcing strategy = multi or ratios exist)",
    savedTo: "override sourcing.supply_share",
    engine: "P-S.2 proactive multi-sourcing weight, renormalized to 100 % per material",
    verdict: "conditional",
    note:
      "Only for a material with ≥ 2 suppliers. With no share set, P-S.2 splits EQUALLY over the cheapest " +
      "suppliers, not by lane volume. No project is on strategy = multi today, so the column is hidden everywhere.",
  },
  "supplier:material_price": {
    shows: "inbound_logistics.unit_price; a blank price shows the material's / project's AVERAGE (imputed)",
    savedTo: "— (read-only; change it in the inbound file)",
    engine: "inbound_logistics.unit_price; blank or ≤ 0 → 1.0",
    verdict: "differs",
    note: "30 blank prices (Project 2: 7, Project AA: 23) show an average and run at 1.0. 452 old price overrides are still stored and read by nothing.",
    shouldBe: "show the engine's value, a blank as 'default 1.0'",
    refs: ["D189"],
  },
  "supplier:material_cost": {
    shows: "your override → materials.cost (item master) → derived from the inbound lanes",
    savedTo: "override sourcing.material_cost (per row — /policies never writes the item master, §23 WP 13.1)",
    engine: "override → materials.cost → volume-weighted inbound price → cheapest inbound price → 1.0",
    verdict: "works",
  },
  "supplier:material_moq": {
    shows: "your override → materials.moq (item master)",
    savedTo: "override sourcing.material_moq (per row — /policies never writes the item master, §23 WP 13.1)",
    engine: "override → materials.moq, on every link of the material; blank → 0",
    verdict: "works",
  },
  "supplier:capacity_per_week": {
    shows: "your override → suppliers.capacity_per_week (item master); blank shows ∞",
    savedTo: "override sourcing.capacity_per_week (per row — /policies never writes the item master, §23 WP 13.1) — one value per supplier" ,
    engine: "override → suppliers.capacity_per_week; blank = unlimited",
    verdict: "works",
  },
  "supplier:reliability_score": {
    shows: "your override → suppliers.reliability_score (item master)",
    savedTo: "override sourcing.reliability_score (per row — /policies never writes the item master, §23 WP 13.1) — one value per supplier",
    engine: "passed to the engine, but read only by the backup-supplier 'reliability' selection rule, which the mapper never selects (always min_cost)",
    verdict: "ignored",
    shouldBe: "remove, or let the backup rule be chosen so this value matters",
  },
  "supplier:lead_time_weeks": {
    shows: "your override → the uploaded inbound lead_time × lead_time_unit, as the engine builds the link (whole weeks, 1–51); a blank lane shows the engine's 2 weeks",
    savedTo: "override sourcing.lead_time_weeks (per row = per supplier × material lane — /policies never writes the lane)",
    engine: "override → lead_time × lead_time_unit → weeks, rounded half to even, clamped 1–51; blank or 0 → 2 weeks",
    verdict: "works",
    note: "A typed value is rounded to whole weeks at entry, as the engine rounds it. The grid's suggested primary still breaks an exact cost tie on the UPLOADED lead time; a saved primary is unaffected.",
  },
  "supplier:lane_lead_time_dist": {
    shows: "your override → inbound_logistics.lead_time_dist → the material's shape (derived) → empty (deterministic)",
    savedTo: "override sourcing.lane_lead_time_dist (per row = per supplier × material lane — /policies never writes the lane)",
    engine: "override → the lane's uploaded shape → materials.lead_time_dist → deterministic; a shape missing a parameter runs deterministic (warn)",
    verdict: "works",
    note: "PLAN.md §26 WP 16.3. On a triangular or uniform row the Lead time cell shows the bounds' mean, which is what the run plans on.",
  },
  "supplier:lane_lead_time_cv": {
    shows: "your override → inbound_logistics.lead_time_cv → the material's CV (derived)",
    savedTo: "override sourcing.lane_lead_time_cv (per row)",
    engine: "read by normal, lognormal and gamma; 0–1",
    verdict: "conditional",
    note: "Shown only on a row whose shape reads it.",
  },
  "supplier:lane_lead_time_min_weeks": {
    shows: "your override → inbound_logistics.lead_time_min (weeks)",
    savedTo: "override sourcing.lane_lead_time_min_weeks (per row)",
    engine: "the triangular or uniform row's lower bound",
    verdict: "conditional",
    note: "Shown only on a triangular or uniform row.",
  },
  "supplier:lane_lead_time_mode_weeks": {
    shows: "your override → inbound_logistics.lead_time_mode (weeks)",
    savedTo: "override sourcing.lane_lead_time_mode_weeks (per row)",
    engine: "the triangular row's most likely lead time",
    verdict: "conditional",
    note: "Shown only on a triangular row.",
  },
  "supplier:lane_lead_time_max_weeks": {
    shows: "your override → inbound_logistics.lead_time_max (weeks)",
    savedTo: "override sourcing.lane_lead_time_max_weeks (per row)",
    engine: "the triangular or uniform row's upper bound, at most 51 weeks",
    verdict: "conditional",
    note: "Shown only on a triangular or uniform row.",
  },
  "supplier:type": {
    shows: "override → project default → min_max",
    savedTo: "override inventory.type",
    engine: "per-material policy type (inventory_control.material_overrides); s_S / continuous_review run as min_max; mrp orders from the plan (WP 14.5)",
    verdict: "works",
    note: "853 stored.",
  },
  "supplier:__inv_params": {
    shows: "the Replenishment cell: only the parameters the row's policy type uses (rows below); an empty s / S shows a computed placeholder",
    savedTo: "the individual fields below",
    engine: "see the individual fields",
    verdict: "info",
    note:
      "The placeholder uses the grid's demand (the AVERAGE of a product's customer lanes, one BOM level, never demand_mean) " +
      "and the grid's lead time — not the engine's. An empty cell runs on the engine's own numbers, not the placeholder.",
    refs: ["D189"],
  },
  "supplier:basis": {
    shows: "override → days_of_supply",
    savedTo: "override inventory.basis",
    engine: "not read",
    verdict: "ignored",
    note: "495 stored.",
    shouldBe: "remove",
  },
  "supplier:reorder_point": {
    shows: "override, else the computed placeholder",
    savedTo: "override inventory.reorder_point",
    engine: "absolute reorder point s for that material, used exactly — no safety stock added on top",
    verdict: "works",
    note: "Types min_max and rop only; a value stored under another type is not applied (warned).",
  },
  "supplier:order_up_to": {
    shows: "override, else the computed placeholder",
    savedTo: "override inventory.order_up_to",
    engine: "absolute order-up-to S for that material, used exactly — no safety stock added, never raised to s; dropped (formula S used) if S ≤ s",
    verdict: "works",
    note: "Types min_max, base_stock and periodic_review; a value stored under another type is not applied (warned). The placeholder includes the days-based safety stock the run adds to a formula level.",
  },
  "supplier:rop_q_quantity": {
    shows: "override",
    savedTo: "override inventory.rop_q_quantity",
    engine: "order quantity Q for that material, when > 0; its S is then R + Q",
    verdict: "works",
    note: "Type rop only, and required there: an (R,Q) row with no Q (its own or the project's) is flagged as needing input. The project's Q is read whatever the project's own type.",
  },
  "supplier:coverage_weeks": {
    shows: "override → project default → 8",
    savedTo: "override inventory.coverage_weeks",
    engine: "κ for that material, else the project default — which the policy version now stores as the page shows it (8), so the run reads 8",
    verdict: "works",
    note: "Shown only where the run reads it: S from the formula (S empty) on min-max, base-stock and periodic rows; never for (R,Q) or MRP. Before §23 WP 13.4 (§4 D204 a) an unsaved κ was 8 on the page and the 8 / 10 / 12-week strip in the run; κ was saved in no project.",
    refs: ["D204"],
  },
  "supplier:review_period_days": {
    shows: "override → 1",
    savedTo: "override inventory.review_period_days",
    engine: "that material's review period T, rounded to whole weeks (at least 1, at most 13), else the project's",
    verdict: "works",
    note: "Type periodic_review only. Until this was wired every periodic material was reviewed every 4 weeks whatever T said.",
  },
  "supplier:initial_on_hand": {
    shows: "your override → materials.initial_on_hand (item master)",
    savedTo: "override inventory.initial_on_hand (per row — /policies never writes the item master, §23 WP 13.1)",
    engine: "override → materials.initial_on_hand; blank → the engine's own starting stock",
    verdict: "works",
  },
  "supplier:safety_stock_days": {
    shows: "override → project default → 7",
    savedTo: "override inventory.safety_stock_days (per row)",
    engine:
      "that material's safety stock = E[D]·days/7 (P-P.3 fixed_days_by_material), whatever the project-wide " +
      "method; unset → the project-wide method. Two suppliers of one material disagreeing → first kept, warned",
    verdict: "works",
    note: "340 stored per row as of the audit — dropped until 2026-10-02, applied since.",
    refs: ["D204"],
  },
  "supplier:holding_cost_pct": {
    shows: "override → project default → 0.2",
    savedTo: "override inventory.holding_cost_pct (per row)",
    engine:
      "this row's value → materials.holding_cost_pct (master) → project-default policy → 20 %/yr. The /policies " +
      "value beats the master. Two suppliers of one material disagreeing → first kept, warned",
    verdict: "works",
    note: "817 stored per row as of the audit — dropped until 2026-10-02, applied since.",
    refs: ["D204"],
  },
  "supplier:mode": {
    shows: "disabled, 'pending'",
    savedTo: "override transport.mode",
    engine: "not read — waits for the planned transport policies (P-T.x)",
    verdict: "disabled",
  },
  "supplier:cost_per_km": {
    shows: "disabled, 'pending'",
    savedTo: "override transport.cost_per_km",
    engine: "not read — waits for the planned transport policies (P-T.x)",
    verdict: "disabled",
  },

  // ──────────────────────────────── plant ────────────────────────────────
  "plant:sell_price": {
    shows: "your override → products.sell_price (item master) → derived from the outbound lanes",
    savedTo: "override production.sell_price (per row — /policies never writes the item master, §23 WP 13.1)",
    engine: "override → products.sell_price → demand-weighted outbound price → 1.0",
    verdict: "works",
  },
  "plant:production_capacity": {
    shows: "your override → products.production_capacity, units / week (item master) → the line-rate derivation",
    savedTo: "override production.production_capacity (per row — /policies never writes the item master, §23 WP 13.1) — the ONE capacity of the row",
    engine: "override → master → line capacity × 7 × utilization → max(2 × demand, 1000)",
    verdict: "works",
  },
  "plant:capacity_units_per_day": {
    shows: "read-only: the row's saved line rate → the project default (1000), the input of the derived capacity",
    savedTo: "— (read-only since §23 WP 13.4; set the capacity itself in the Capacity column, the project line rate on the Defaults card)",
    engine: "used ONLY when the row's capacity (override or master) is blank",
    verdict: "info",
    note: "8 stored per row — still read and still shown. One editable capacity per row: the Capacity column.",
  },
  "plant:utilization_cap_pct": {
    shows: "read-only: the row's saved utilization → the project default (85)",
    savedTo: "— (read-only since §23 WP 13.4)",
    engine: "multiplies the line rate — only when the row's capacity (override or master) is blank",
    verdict: "info",
  },
  // Whether the product holds FG stock — the switch the FG columns sit behind.
  "plant:prod_lead_time_weeks": {
    shows: "your override → products.production_lead_time × production_lead_time_unit (weeks) → 0; on a triangular or uniform row the bounds' mean (derived, read-only)",
    savedTo: "override production.prod_lead_time_weeks (per Plant row — /policies never writes the product master)",
    engine: "P-P.13: output started in a week completes this many weeks later; the plan starts that many weeks ahead (expected value only)",
    verdict: "works",
    note: "PLAN.md §26 WP 16.5. 0 = completes in the week it starts.",
  },
  "plant:prod_lead_time_dist": {
    shows: "your override → products.production_lead_time_dist → empty (deterministic)",
    savedTo: "override production.prod_lead_time_dist (per Plant row)",
    engine: "override → master → deterministic; a shape missing a parameter runs deterministic (warn)",
    verdict: "works",
  },
  "plant:prod_lead_time_cv": {
    shows: "your override → products.production_lead_time_cv",
    savedTo: "override production.prod_lead_time_cv (per Plant row)",
    engine: "read by normal, lognormal and gamma; 0–1",
    verdict: "conditional",
    note: "Shown only on a row whose shape reads it.",
  },
  "plant:prod_lead_time_min_weeks": {
    shows: "your override → products.production_lead_time_min (weeks)",
    savedTo: "override production.prod_lead_time_min_weeks (per Plant row)",
    engine: "the triangular or uniform row's lower bound",
    verdict: "conditional",
    note: "Shown only on a triangular or uniform row.",
  },
  "plant:prod_lead_time_mode_weeks": {
    shows: "your override → products.production_lead_time_mode (weeks)",
    savedTo: "override production.prod_lead_time_mode_weeks (per Plant row)",
    engine: "the triangular row's most likely value",
    verdict: "conditional",
    note: "Shown only on a triangular row.",
  },
  "plant:prod_lead_time_max_weeks": {
    shows: "your override → products.production_lead_time_max (weeks)",
    savedTo: "override production.prod_lead_time_max_weeks (per Plant row)",
    engine: "the triangular or uniform row's upper bound, at most 26 weeks",
    verdict: "conditional",
    note: "Shown only on a triangular or uniform row.",
  },
  "plant:__fg_inv_params": {
    shows: "the FG Replenishment cell: only the levels the row's FG policy reads — S (base-stock), s and S (min-max), D (days of cover) — each with its source dot; an empty S shows what it means (≈ 1 wk demand)",
    savedTo: "the individual fields below (Plant-row overrides of products)",
    engine: "see the individual fields",
    verdict: "info",
    note: "PLAN.md §26 WP 16.6 — laid out like the Supplier stage's inventory band (§4 D301).",
  },
  "plant:fulfillment_mode": {
    shows: "your override → products.fulfillment_mode → projects.supply_chain_model → MTO",
    savedTo: "override production.fulfillment_mode (Plant row — /policies never writes the master)",
    engine: "Product.fulfillment_mode: MTS holds FG inventory and reads the FG policy below; MTO reads none of it",
    verdict: "works",
    note: "The FG columns appear only on an MTS row, so every FG cell shown is one the run reads.",
    refs: ["D197"],
  },
  // PLAN.md §24 WP 14.4 — the FG policy per product and FG opening stock. The
  // opening-stock cell replaced `initial_on_hand`, which had no reader (D89).
  "plant:fg_initial_on_hand": {
    shows: "your override → products.fg_initial_on_hand → empty (the run starts at the target)",
    savedTo: "override production.fg_initial_on_hand (Plant row — /policies never writes the master)",
    engine: "the MTS product's FG opening stock (engine RFC 4)",
    verdict: "conditional",
    note: "MTS products only.",
    refs: ["D89"],
  },
  "plant:fg_policy": {
    shows: "your override → products.fg_policy → empty (base-stock)",
    savedTo: "override production.fg_policy (Plant row)",
    engine: "Product.fg_policy: base-stock, min-max or days of cover; an incomplete policy runs as base-stock, warned",
    verdict: "conditional",
    note: "MTS products only.",
  },
  "plant:fg_base_stock": {
    shows: "your override → products.fg_base_stock → empty (derived: a week of forecast + P-P.4)",
    savedTo: "override production.fg_base_stock (Plant row)",
    engine: "S — the end-of-week FG target (base-stock, min-max); P-P.4 adds nothing on top of a typed S",
    verdict: "conditional",
    note: "MTS products only.",
  },
  "plant:fg_reorder_point": {
    shows: "your override → products.fg_reorder_point",
    savedTo: "override production.fg_reorder_point (Plant row)",
    engine: "s — min-max builds up to S only below it",
    verdict: "conditional",
    note: "Read under min-max only, MTS products only.",
  },
  "plant:fg_cover_days": {
    shows: "your override → products.fg_cover_days",
    savedTo: "override production.fg_cover_days (Plant row)",
    engine: "D — target = D/7 × the projected weekly demand",
    verdict: "conditional",
    note: "Read under days of cover only, MTS products only.",
  },
  "plant:allocation_priority_weight": {
    shows: "override → 1 (column appears only when the recovery response includes 'allocate materials')",
    savedTo: "override production.allocation_priority_weight",
    engine: "P-P.9 per-product allocation priority",
    verdict: "conditional",
    note: "No project has 'allocate materials' set, and no control on /policies can set it any more.",
  },

  // ─────────────────────────────── customer ───────────────────────────────
  "customer:primary_source": {
    shows: "the grid's pick of serving firm",
    savedTo: "override fulfillment.primary_source",
    engine: "not read",
    verdict: "ignored",
    note: "12 stored. The pre-run gate requires one per customer × product.",
  },
  "customer:sourcing_firm": {
    shows: "the highest-volume serving firm",
    savedTo: "override fulfillment.sourcing_firm",
    engine: "not read (the engine is single-plant)",
    verdict: "ignored",
    note: "10 stored. The pre-run gate requires it.",
  },
  // PLAN.md §24 WP 14.2 — demand per customer × product row.
  "customer:row_demand_mode": {
    shows: "your override, else empty — the engine's rule: the row's delivery schedule when one is entered, else its forecast when one is uploaded, else its model",
    savedTo: "override demand.row_demand_mode (Customer row)",
    engine: "'model' sets an uploaded forecast aside; 'forecast' without one is warned and ignored; 'schedule' runs the row's requested delivery schedule exactly",
    verdict: "works",
  },
  "customer:row_demand_schedule": {
    shows: "the row's requested delivery schedule — units per week from run week 0 (the project start), typed here",
    savedTo: "override demand.row_demand_schedule (Customer row, an array)",
    engine: "CustomerLink.forecast with a deterministic draw and mean 0: the row's demand is exactly the schedule, and nothing past its end; its distribution and any uploaded forecast are set aside",
    verdict: "works",
  },
  "customer:row_forecast": {
    shows: "the row's uploaded forecast buckets (demand_forecasts), summarized",
    savedTo: "—",
    engine: "the per-week centre of the row's demand, spread evenly over each bucket at promotion",
    verdict: "info",
  },
  "customer:row_demand_distribution": {
    shows: "your override → outbound_logistics.demand_distribution → empty (the product's distribution × share)",
    savedTo: "override demand.row_demand_distribution (per row — /policies never writes the data)",
    engine: "override → the row's uploaded distribution → the product's distribution scaled by the row's volume share",
    verdict: "works",
  },
  "customer:row_demand_mean": {
    shows: "your override → outbound_logistics.demand_mean (weekly) → empty (the product's mean × share)",
    savedTo: "override demand.row_demand_mean (per row)",
    engine: "override → the row's uploaded mean → the product's mean × share",
    verdict: "works",
  },
  "customer:row_demand_variation": {
    shows: "your override → outbound_logistics.demand_variation",
    savedTo: "override demand.row_demand_variation (per row)",
    engine: "read by the distribution: CV for normal, ± fraction for triangularAV",
    verdict: "conditional",
    note: "Read only when the row's distribution is normal or triangularAV.",
  },
  "customer:row_demand_min": {
    shows: "your override → outbound_logistics.demand_min (weekly)",
    savedTo: "override demand.row_demand_min (per row)",
    engine: "the triangular row's lower bound",
    verdict: "conditional",
    note: "Read only when the row's distribution is triangular.",
  },
  "customer:row_demand_max": {
    shows: "your override → outbound_logistics.demand_max (weekly)",
    savedTo: "override demand.row_demand_max (per row)",
    engine: "the triangular row's upper bound",
    verdict: "conditional",
    note: "Read only when the row's distribution is triangular.",
  },
  // PLAN.md §24 WP 14.3 — fulfillment per customer × product row.
  "customer:backorder_allowed": {
    shows: "your override, else the project's value, shown greyed in the cell",
    savedTo: "override fulfillment.backorder_allowed (Customer row)",
    engine: "P-C.1: this row waits (backorder) or loses (lost sales); its own backlog",
    verdict: "works",
  },
  "customer:max_backorder_days": {
    shows: "your override, else the project's; the note says the whole weeks the run uses",
    savedTo: "override fulfillment.max_backorder_days (Customer row)",
    engine: "the row's horizon in weeks — days ÷ 7 rounded half up, clamped 0–26",
    verdict: "conditional",
    note: "Read only for a row that backorders.",
  },
  "customer:backorder_cost_per_day": {
    shows: "your override, else the project's",
    savedTo: "override fulfillment.backorder_cost_per_day (Customer row)",
    engine: "× 7 → the row's backorder penalty per unit per week",
    verdict: "conditional",
    note: "Read only for a row that backorders.",
  },
  "customer:row_priority": {
    shows: "your override → customers.priority_weight of the row's customer → 1.0",
    savedTo: "override fulfillment.row_priority (per row — /policies never writes the customer)",
    engine: "P-C.2 row priority: higher serves first",
    verdict: "conditional",
    note: "Read under the priority and sla_tier rules; the cell is shown only then.",
  },
  "customer:price": {
    shows: "your override → outbound_logistics.unit_price → the product's sell price",
    savedTo: "override fulfillment.price (per row)",
    engine: "the row's price: what revenue_max serves first, and what values its fill rate",
    verdict: "works",
    note: "Shown under revenue_max, the rule that orders by it.",
  },
  "customer:sla_fill_floor_pct": {
    shows: "your override → customers.sla_fill_floor_pct of the row's customer → empty (the segment's tier floor)",
    savedTo: "override fulfillment.sla_fill_floor_pct (per row)",
    engine: "P-C.2 sla_tier: this % of the row's demand is served first",
    verdict: "conditional",
    note: "Read under the sla_tier rule; the cell is shown only then.",
  },
};

/** Header label + sub-label exactly as the grid renders them. */
export function headerFor(stage: GridStage, field: string): { label: string; sub: string } {
  const spec = STAGE_TABLE_SPEC[stage].cols.find((c) => c.field === field);
  const fit = COLUMN_FIT[field];
  let label = shortLabelFor(stage, field, spec?.label ?? field);
  // The grid names the planning unit only on READ-ONLY day-stored columns,
  // whose values it converts (StagePolicyTable's `adaptLabel`); same rule here.
  if (spec?.readOnly && /days?$/.test(field)) label = label.replace(/\(days\)/g, `(${UNIT_LABEL_PLURAL[PLANNING_UNIT]})`);
  return { label, sub: fit?.sub ?? "" };
}

/** The grid's columns for one stage, in the grid's order, each with its verdict. */
export function stageColumnChecks(stage: GridStage) {
  return STAGE_TABLE_SPEC[stage].cols.map((c) => ({
    field: c.field,
    family: c.family,
    inVector: c.vectorGroup === "invParams" || c.vectorGroup === "fgInvParams",
    ...headerFor(stage, c.field),
    check: COLUMN_CHECK[`${stage}:${c.field}`],
  }));
}

/**
 * The Allocation line above the Customer grid (`projectRules.ts` CUSTOMER_RULE)
 * — project scope, shown only with 2+ customers, saves the whole fulfillment
 * family. Keys are the line's fields; the test holds them equal.
 */
export const CUSTOMER_RULE_CHECK: Record<string, ColumnCheck> = {
  allocation: {
    shows: "saved value; never saved → 'priority'",
    savedTo: "policy_defaults.fulfillment (whole family on save); a policy version stores the shown default",
    engine: "P-C.2 customer allocation, with ≥ 2 customers; never saved → 'priority', as shown (§23 WP 13.4)",
    verdict: "works",
    note: "Never saved in 9 of 10 projects. Before WP 13.4 (§4 D204 a) the page said 'priority' and the run had no rule; the policy version now stores the default the page shows.",
    refs: ["D204"],
  },
};

/**
 * The project backorder values an EMPTY Customer-row cell inherits — no control
 * since §24 WP 14.8 (owner decision: backorder is set per row; a project line of
 * "defaults for empty cells" read as a second backorder setting). The engine
 * still reads them for an empty cell, and the cell shows the inherited value.
 */
export const PROJECT_BACKORDER_CHECK: Record<string, ColumnCheck> = {
  backorder_allowed: {
    shows: "no control; an empty row cell shows it as the inherited value (never saved → YES)",
    savedTo: "policy_defaults.fulfillment — Excel import or a version restore only",
    engine: "P-C.1 backorder; never saved → YES, as shown (§23 WP 13.4)",
    verdict: "works",
    note: "Never saved in 9 of 10 projects: before WP 13.4 (§4 D204 a) every run there simulated lost sales while the page said backorders are allowed. The policy version now stores the default the page shows.",
    refs: ["D204"],
  },
  max_backorder_days: {
    shows: "no control; an empty row cell shows it (never saved → 14)",
    savedTo: "policy_defaults.fulfillment",
    engine: "backorder horizon in weeks (days ÷ 7 rounded half up, clamped 0–26); never saved → 14",
    verdict: "works",
  },
  backorder_cost_per_day: {
    shows: "no control; an empty row cell shows it (never saved → 2)",
    savedTo: "policy_defaults.fulfillment",
    engine: "backorder penalty × 7 per week; never saved → 2, as shown (§23 WP 13.4)",
    verdict: "works",
    note: "Before WP 13.4 (§4 D204 a) an unsaved cost was 2 on the page and 0 in the run.",
    refs: ["D204"],
  },
};

/**
 * P-P.4's FG safety buffer — NO control on /policies (owner decision, WP 14.8):
 * a second way to say "keep more FG" beside the row's S. A saved value is shown
 * as a removable notice above the Plant grid while it acts.
 */
export const FG_BUFFER_CHECK: Record<string, ColumnCheck> = {
  fg_safety_stock: {
    shows: "no control (owner decision, WP 14.8 — it duplicated S on the row); a value an older version saved shows as a notice above the Plant grid while it acts, with Remove",
    savedTo: "policy_defaults.inventory — written only by Remove (→ none), Excel import or a version restore",
    engine: "P-P.4 sizes a buffer on a DERIVED FG target S, for MTS products only; a typed S gets nothing on top",
    verdict: "conditional",
    note: "Was a Plant-row column whose per-row value was dropped; the engine reads it project-wide only.",
    refs: ["D283"],
  },
  fg_service_level_target: {
    shows: "saved value; never saved → 0.95 (visible under service level)",
    savedTo: "policy_defaults.inventory",
    engine: "the z of P-P.4's service-level sizing",
    verdict: "conditional",
  },
  fg_safety_stock_days: {
    shows: "saved value; never saved → 2 (visible under fixed days)",
    savedTo: "policy_defaults.inventory",
    engine: "P-P.4's fixed cover in days of demand",
    verdict: "conditional",
  },
};

/** Page-level controls outside the grid. */
export const PAGE_LEVEL_CHECK: Array<{ label: string; check: ColumnCheck }> = [
  {
    label: "Planning unit (day · week · month)",
    check: {
      shows: "fixed to week; day and month disabled",
      savedTo: "browser storage only",
      engine: "the engine always steps in weeks",
      verdict: "info",
    },
  },
  {
    label: "Fulfillment strategy (display only since presets were removed)",
    check: {
      shows: "policy_defaults.fulfillment_strategy — decides nothing on the grid since the FG columns follow each row's own MTS / MTO",
      savedTo: "no control on /policies any more",
      engine: "worker AND browser engine: products.fulfillment_mode → projects.supply_chain_model → MTO (the browser engine reads the same column since D197's fix; this value is read by neither)",
      verdict: "differs",
      note: "The policy value and projects.supply_chain_model disagree in 6 of 10 projects; the value is display only, so a disagreement no longer changes a run.",
      shouldBe: "one project default, the one the worker reads",
      refs: ["D197"],
    },
  },
  {
    label: "Apply prefill",
    check: {
      shows: "one bulk action per stage",
      savedTo: "overrides: uploaded values plus the grid's 'decided' primary supplier / sourcing firm",
      engine: "the primary selections it writes are required by the pre-run gate and read by nothing in the engine",
      verdict: "info",
      refs: ["D188"],
    },
  },
  {
    label: "Excel import / export (per stage)",
    check: {
      shows: "the stage's families as a workbook",
      savedTo: "policy_defaults (the stage's families) and overrides",
      engine: "same rules as the grid and the cards",
      verdict: "info",
      note: "The only way left on /policies to change the project-default inventory, sourcing and recovery families.",
    },
  },
];

/** Run & validate stage. */
export const RUN_VALIDATE_CHECK: Array<{ label: string; check: ColumnCheck }> = [
  { label: "Seed", check: { shows: "run form", savedTo: "the 'validation' scenario row", engine: "scenario seed; a seed of 0 runs as 42", verdict: "works" } },
  { label: "Replications", check: { shows: "run form", savedTo: "the 'validation' scenario row", engine: "scenario replications", verdict: "works" } },
  { label: "Horizon (days)", check: { shows: "run form", savedTo: "the 'validation' scenario row", engine: "scenario horizon", verdict: "works" } },
  {
    label: "Warm-up (days, method)",
    check: {
      shows: "run form",
      savedTo: "NOT written to the scenario",
      engine: "the scenario's own warm-up (auto)",
      verdict: "ignored",
    },
  },
  {
    label: "Demand model",
    check: {
      shows: "not shown",
      savedTo: "the validation scenario is created with Poisson (λ 50, never read)",
      engine: "a product with no demand_distribution runs the SCENARIO's kind — Poisson",
      verdict: "differs",
      note: "16 completed runs simulated Poisson, and nothing on the run form says which model the run used.",
      refs: ["D190"],
    },
  },
];

/** Engine inputs with NO column on /policies — so nothing reads as complete that is not. */
export const NO_COLUMN_CHECK: Array<{ label: string; check: ColumnCheck }> = [
  {
    label: "Demand distribution, CV, min, max (products)",
    check: {
      shows: "no column here — their status per project is on the 'Uploaded data → engine' tab",
      savedTo: "item-master editor or products upload",
      engine: "products.* → the scenario's demand model (Poisson for scenarios created in the app) → triangular / 0.30",
      verdict: "info",
      shouldBe: "Plant-stage columns backed by the products master",
      refs: ["D190"],
    },
  },
  {
    label: "Fulfillment mode per product (products.fulfillment_mode)",
    check: {
      shows: "no column",
      savedTo: "item-master editor or products upload",
      engine: "products.fulfillment_mode → projects.supply_chain_model → MTO",
      verdict: "info",
      shouldBe: "a Plant-stage master column",
      refs: ["D197"],
    },
  },
  {
    label: "Lead-time distribution and CV (materials)",
    check: {
      shows: "no column",
      savedTo: "item-master editor or materials upload",
      engine: "materials.lead_time_dist / lead_time_cv → deterministic / 0",
      verdict: "info",
      shouldBe: "Supplier-stage master columns",
    },
  },
  {
    label: "Customer priority and segment (customers)",
    check: {
      shows: "no column",
      savedTo: "customers upload only",
      engine: "used only under an allocation rule — 'priority' by default since §23 WP 13.4 (§4 D204 a)",
      verdict: "info",
    },
  },
  {
    label: "Project-default safety-stock method, safety-stock days, service level, κ, holding cost",
    check: {
      shows: "no card since presets were removed",
      savedTo: "Excel import or a version restore only",
      engine: "read at the project-default scope (the per-row cells are dropped)",
      verdict: "info",
      shouldBe: "a Supplier-stage defaults card",
      refs: ["D204"],
    },
  },
  {
    label: "Sourcing strategy, recovery responses, detection lag",
    check: {
      shows: "no card since presets were removed",
      savedTo: "Excel import or a version restore only",
      engine: "read at the project-default scope (backup supplier, expedite, early warning, allocate materials…)",
      verdict: "info",
      shouldBe: "a defaults card",
    },
  },
  {
    label: "SLA tier floors (fulfillment.tier_overrides)",
    check: {
      shows: "no control",
      savedTo: "—",
      engine: "used only under the sla_tier allocation rule",
      verdict: "info",
    },
  },
];

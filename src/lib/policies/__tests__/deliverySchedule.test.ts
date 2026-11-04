/**
 * The Customer row's REQUESTED DELIVERY SCHEDULE — the third demand mode beside
 * forecast and model (P-C.4). The engine half is `scsim/tests/test_demand_rows.py`
 * (the schedule runs exactly, nothing past its end); this is the page half: the
 * mode resolves as the mapper resolves it, the grid shows only the cell the
 * schedule reads, the pre-run gate refuses an empty one, and the editor's
 * arithmetic.
 */
import { formatRunWeekRange } from "@/lib/sim/calendarWeeks";
import { describe, expect, it } from "vitest";
import { STAGE_TABLE_SPEC, rowDemandMode, type ColSpecCtx } from "../columnSpecs";
import { rowGateCtx, type DerivedMaps, type MasterRowMaps } from "../resolveEffective";
import { DEFAULT_BUNDLE, ENUM_OPTIONS } from "../schemas";
import {
  MAX_SCHEDULE_WEEKS,
  asSchedule,
  horizonWeeksOf,
  scheduleCellLabel,
  parseSchedulePaste,
  resizeSchedule,
  scheduleSummary,
} from "../deliverySchedule";
import { demandRowFindings } from "../../../../supabase/functions/_shared/grading";
import {
  MAX_SCHEDULE_WEEKS as EDGE_MAX_SCHEDULE_WEEKS,
  validatePolicyDiff,
} from "../../../../supabase/functions/_shared/policyFields";
import registry from "../registry.generated.json";

const modeOf = (opts: {
  draft?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  hasForecast?: boolean;
}) => {
  const masterRowById = {
    outbound_logistics: new Map([
      ["C1::P1", { customer_id: "C1", product_id: "P1", demand_mode: opts.hasForecast ? "forecast" : undefined }],
    ]),
  } as unknown as MasterRowMaps;
  return rowGateCtx({
    rowKey: "C1::P1",
    row: { customer_id: "C1", product_id: "P1" },
    draft: opts.draft,
    effective: opts.effective,
    projectFulfillmentMode: "mto",
    families: ["demand"],
    masterColByField: new Map(),
    masterRowById,
    derived: {} as DerivedMaps,
    defaults: DEFAULT_BUNDLE,
    overrides: [],
    scope: "node",
  });
};

describe("the mode resolves as the engine resolves it", () => {
  it("'schedule' is the third choice, everywhere the mode is offered", () => {
    expect(ENUM_OPTIONS.row_demand_mode).toEqual(["forecast", "model", "schedule"]);
    const keys = (registry as { policy_bundle_keys: Array<{ key: string; target: string }> }).policy_bundle_keys;
    expect(keys.find((k) => k.key === "row_demand_schedule")?.target).toBe("CustomerLink.forecast");
  });

  it("chosen 'schedule' runs a schedule, with or without a forecast uploaded", () => {
    expect(rowDemandMode(modeOf({ draft: { row_demand_mode: "schedule" } }))).toBe("schedule");
    expect(rowDemandMode(modeOf({ effective: { row_demand_mode: "schedule" }, hasForecast: true }))).toBe("schedule");
  });

  it("an empty mode follows the data: a saved schedule, else the forecast, else the model", () => {
    expect(rowDemandMode(modeOf({ effective: { row_demand_schedule: [5, 5] }, hasForecast: true }))).toBe("schedule");
    expect(rowDemandMode(modeOf({ hasForecast: true }))).toBe("forecast");
    expect(rowDemandMode(modeOf({}))).toBe("model");
  });

  it("'model' or 'forecast' set a saved schedule aside", () => {
    const saved = { row_demand_schedule: [5, 5] };
    expect(rowDemandMode(modeOf({ effective: { ...saved, row_demand_mode: "model" } }))).toBe("model");
    expect(rowDemandMode(modeOf({ effective: { ...saved, row_demand_mode: "forecast" }, hasForecast: true }))).toBe("forecast");
  });
});

describe("under a schedule the grid shows only the schedule", () => {
  const cols = STAGE_TABLE_SPEC.customer.cols;
  const demandCols = cols.filter((c) => c.family === "demand").map((c) => c.field);
  const shown = (resolved: Record<string, unknown>) =>
    cols
      .filter((c) => c.family === "demand")
      .filter((c) => !c.visibleWhen || c.visibleWhen({ resolved } as ColSpecCtx))
      .map((c) => c.field);

  it("the schedule column exists and sits right after the mode", () => {
    expect(demandCols.slice(0, 2)).toEqual(["row_demand_mode", "row_demand_schedule"]);
  });
  it("schedule → mode + schedule; no distribution, parameters or forecast", () => {
    expect(shown({ row_demand_mode: "schedule", has_forecast: true, row_demand_distribution: "normal" }))
      .toEqual(["row_demand_mode", "row_demand_schedule"]);
  });
  it("model → no schedule cell", () => {
    expect(shown({ row_demand_mode: "model", row_demand_distribution: "normal" })).not.toContain("row_demand_schedule");
  });
});

describe("the pre-run gate", () => {
  const outbound = [{ customer_id: "C1", product_id: "P1", demand_distribution: "normal", demand_mean: 40 }];
  const ovr = (patch: Record<string, unknown>) => [{ scope: "node", target_key: "C1::P1", family: "demand", patch }];

  it("a running schedule replaces the spec: a normal with no CV is not a finding", () => {
    expect(demandRowFindings(outbound).some((f) => f.severity === "block")).toBe(true);
    const f = demandRowFindings(outbound, [], ovr({ row_demand_mode: "schedule", row_demand_schedule: [10, 20] }), 2);
    expect(f).toEqual([]);
  });
  it("'schedule' with nothing entered blocks", () => {
    const f = demandRowFindings([{ customer_id: "C1", product_id: "P1" }], [], ovr({ row_demand_mode: "schedule" }));
    expect(f.map((x) => [x.severity, x.field])).toEqual([["block", "demand.row_demand_schedule"]]);
  });
  it("a schedule shorter than the run warns", () => {
    const f = demandRowFindings(outbound, [], ovr({ row_demand_schedule: [10, 20] }), 52);
    expect(f.map((x) => x.severity)).toEqual(["warn"]);
    expect(f[0].rows).toEqual(["C1::P1 (2 of 52 wk)"]);
  });
  it("a negative week blocks", () => {
    const f = demandRowFindings(outbound, [], ovr({ row_demand_schedule: [10, -1] }), 2);
    expect(f.some((x) => x.severity === "block" && x.field === "demand.row_demand_schedule")).toBe(true);
  });
});

describe("the agent surface validates it as the page saves it", () => {
  const diff = (v: unknown) =>
    validatePolicyDiff({
      overrides: [{ scope: "node", target_key: "C1::P1", family: "demand", patch: { row_demand_schedule: v } }],
    });
  it("an array of quantities ≥ 0 passes; anything else is refused", () => {
    expect(diff([0, 12.5, 30]).ok).toBe(true);
    expect(diff([1, -2]).ok).toBe(false);
    expect(diff("1,2").ok).toBe(false);
  });
  it("one length cap", () => {
    expect(EDGE_MAX_SCHEDULE_WEEKS).toBe(MAX_SCHEDULE_WEEKS);
  });
});

describe("the editor's arithmetic", () => {
  it("the run's weeks from the project window", () => {
    expect(horizonWeeksOf("2025-12-31", "2026-12-30")).toBe(52);
    expect(horizonWeeksOf(null, null)).toBe(52);
    expect(horizonWeeksOf("2026-01-01", "2026-01-10")).toBe(2);
  });
  it("a stored value is a schedule only when every week is a quantity", () => {
    expect(asSchedule([1, "2", null])).toEqual([1, 2, 0]);
    expect(asSchedule([1, -1])).toBeNull();
    expect(asSchedule([])).toBeNull();
    expect(asSchedule("1,2")).toBeNull();
  });
  it("pastes a spreadsheet column, a row, or a list", () => {
    expect(parseSchedulePaste("10\n20\n\n30")).toEqual({ values: [10, 20, 30] });
    expect(parseSchedulePaste("10\t20\t30")).toEqual({ values: [10, 20, 30] });
    expect(parseSchedulePaste("10, 20; 30")).toEqual({ values: [10, 20, 30] });
    expect(parseSchedulePaste("12,5\n7,5")).toEqual({ values: [12.5, 7.5] });
    expect(parseSchedulePaste("10\nabc")).toEqual({ error: '"abc" is not a quantity ≥ 0' });
  });
  it("resizes with zeros and summarizes", () => {
    expect(resizeSchedule([1, 2], 4)).toEqual([1, 2, 0, 0]);
    expect(resizeSchedule([1, 2, 3], 2)).toEqual([1, 2]);
    expect(scheduleSummary([10, 20, 30, 40], 52)).toBe("4 of 52 wk · Σ 100 · 10, 20, 30 …");
    expect(scheduleSummary(null)).toBe("not entered");
  });
});

describe("§4 D319 — a schedule cell is numbered as the engine runs it", () => {
  it("cell i is run week i, dated from the project start", () => {
    expect(scheduleCellLabel("2026-01-01", 0)).toEqual({ short: "W0", title: expect.stringMatching(/^Run week 0 · /) });
    const l = scheduleCellLabel("2026-01-01", 25);
    expect(l.short).toBe("W25");
    expect(l.title).toContain(formatRunWeekRange("2026-01-01", 25));
    expect(scheduleCellLabel(null, 3)).toEqual({ short: "W3", title: "Run week 3" });
  });
});


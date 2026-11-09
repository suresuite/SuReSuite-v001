import { describe, expect, it } from "vitest";
import { experimentSpecRows, specGate } from "../experimentSpecCard";

// The payload the §20.8 what-if loop files for "what if disruption with S001
// at week 22 and duration of 4 weeks" (draft_experiment_spec's stored shape).
const payload = {
  schema_version: 1,
  new_scenario: {
    name: "What-if: supplier S001 outage (lead-time delay), weeks 22–25",
    horizon_days: 238,
    disruption_schedule: [
      { target: "supplier:S001", target_type: "node", start_day: 154, duration_days: 28, magnitude_pct: 100 },
    ],
    recovery_overrides: {},
  },
  policy_version_id: "4e6b609b-cb1a-412e-9408-15912bacd780",
  policy_version_label: "Min, Max S1=90k, S4=25k",
  replications: 161,
  acknowledge_warnings: false,
  findings_preview: [
    { severity: "warn", field: "products.demand_cv", message: "products.demand_cv is missing for 1 row(s)" },
    { severity: "info", field: "x", message: "not gating" },
  ],
};

describe("experiment_spec card (§5.4 / §20.8)", () => {
  it("shows the spec itself — the disruption, length, version and replications — not an empty table", () => {
    const rows = experimentSpecRows(payload);
    expect(rows.map((r) => [r.field, r.value])).toEqual([
      ["disruption", "supplier S001, outage (lead-time delay), weeks 22–25"],
      ["simulated length", "34 weeks"],
      ["policy version", "bound"],
      ["replications", "161"],
    ]);
  });

  it("a warning with no block REQUIRES the reviewer's acknowledgment (the gate_blocked ack_required case)", () => {
    const g = specGate(payload);
    expect(g.findings).toHaveLength(1);
    expect(g.ackRequired).toBe(true);
    expect(g.blocked).toBe(false);
  });

  it("a block cannot be acknowledged away", () => {
    const g = specGate({
      findings_preview: [
        { severity: "warn", field: "a", message: "w" },
        { severity: "block", field: "b", message: "b" },
      ],
    });
    expect(g.blocked).toBe(true);
    expect(g.ackRequired).toBe(false);
  });

  it("a clean pre-check asks nothing", () => {
    expect(specGate({ findings_preview: [] })).toEqual({ findings: [], ackRequired: false, blocked: false });
    expect(specGate(undefined).ackRequired).toBe(false);
  });

  it("an existing-scenario re-run and a capacity cut read correctly", () => {
    const rows = experimentSpecRows({ scenario_id: "x", scenario_name: "Baseline", replications: 30 });
    expect(rows[0]).toMatchObject({ entity: "Baseline", value: "re-run as stored" });
    const cut = experimentSpecRows({
      new_scenario: { name: "n", horizon_days: 70, disruption_schedule: [{ target: "node:plant", start_day: 70, duration_days: 7, magnitude_pct: 40 }] },
    });
    expect(cut[0].value).toBe("the plant, 40% capacity reduction, week 10");
  });

  it("a comparison card lists every arm, the reference first, and the total replications (§26 M.2)", () => {
    const rows = experimentSpecRows({
      experiment_type: "comparison",
      new_scenario: { name: "Mitigation: S001", horizon_days: 238, disruption_schedule: payload.new_scenario.disruption_schedule },
      arms: [
        { label: "No recovery", recovery_overrides: {} },
        { label: "Expedite Shipments", recovery_overrides: { responses: ["expedite"] } },
      ],
      replications: 5,
    });
    expect(rows[0]).toMatchObject({ entity: "No recovery", field: "reference arm" });
    expect(rows[0].value).toContain("no recovery response");
    expect(rows[1]).toMatchObject({ entity: "Expedite Shipments", field: "arm 2" });
    expect(rows[1].value).toContain("with recovery response");
    expect(rows.at(-1)!.value).toBe("5 per arm × 2 arms = 10 (same random numbers in every arm)");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { readFileSync } from "node:fs";
import { RUN_SUMMARY_COLUMNS } from "../useSimulationRun";

const HEAVY = ["run_spec", "disruption_schedule", "mapping_warnings", "protocol_overrides"];
const src = readFileSync("src/hooks/useSimulationRun.tsx", "utf8");
const body = src.slice(src.indexOf("export interface SimulationRun {"));
const typeColumns = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^ {2}([a-z_0-9]+)\??:/gm)].map((m) => m[1]);
const listed = RUN_SUMMARY_COLUMNS.split(",");

describe("the Run queue's column list", () => {
  it("is the SimulationRun type minus exactly the four heavy JSON columns", () => {
    expect(typeColumns.length).toBeGreaterThan(30);
    expect([...listed].sort()).toEqual(typeColumns.filter((c) => !HEAVY.includes(c)).sort());
  });

  it("names only columns the database has", () => {
    const schema = JSON.parse(readFileSync("build/schema.introspected.json", "utf8"));
    const table = schema.tables.find((t: { name: string }) => t.name === "simulation_runs");
    const have = new Set(table.columns.map((c: { name: string }) => c.name));
    expect(listed.filter((c) => !have.has(c))).toEqual([]);
  });

  it("repeats nothing", () => {
    expect(new Set(listed).size).toBe(listed.length);
  });
});

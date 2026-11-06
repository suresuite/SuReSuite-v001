// The LARGE demo dataset (scripts/demo_project_large) is generated, not committed, so this
// test generates it — full size, into a temp directory — and holds it to what the small demo
// is held to: the real upload validators, the platform's pre-run data check, and the graph
// structure the firm-level page needs. It also pins the properties that make it a LARGE
// demo rather than a long one (shared materials, hub suppliers, a four-deep BOM) and the one
// limit it has to stay under (production returns at most 10 000 rows per unpaged read).
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv } from "../../../supabase/functions/_shared/csvParse";
import { validateRows } from "../../../supabase/functions/_shared/ingestValidate";
import { INGEST_DATASETS } from "../../../supabase/functions/_shared/ingestSpec.generated";
import { flattenFindings, gradeManifest } from "../../../supabase/functions/_shared/grading";

const python = spawnSync("python3", ["--version"]).status === 0;
const out = mkdtempSync(join(tmpdir(), "demo-large-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let data: any;

const WIZARD: Record<string, string> = {
  suppliers: "item_master_suppliers",
  materials: "item_master_materials",
  products: "item_master_products",
  bom_multi_level: "bom_multi_level",
  inbound_logistics: "inbound_logistics",
  outbound_logistics: "outbound_logistics",
};
const csv = (name: string) => readFileSync(join(out, "csv", `${name}.csv`), "utf8");

describe.skipIf(!python)("large demo dataset", () => {
  beforeAll(() => {
    const r = spawnSync("python3", ["scripts/demo_project_large/build_dataset.py", "--out", out, "--split", "700"], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    data = JSON.parse(readFileSync(join(out, "dataset.json"), "utf8"));
  }, 120_000);

  it("is the size the demo promises", () => {
    expect(data.products).toHaveLength(100);
    expect(data.suppliers).toHaveLength(1000);
    expect(data.materials).toHaveLength(1800);
    expect(data.network_nodes.length).toBeGreaterThan(3000);
  });

  it("stays under production's 10 000-row read ceiling on every table the engine reads", () => {
    for (const k of ["bom_multi_level", "inbound", "outbound", "materials", "suppliers", "products"]) {
      expect(data[k].length, k).toBeLessThan(10_000);
    }
  });

  it.each(Object.entries(WIZARD))("%s passes the real CSV and contract validators", (file, dataset) => {
    const result = validateRows(parseCsv(csv(file)), INGEST_DATASETS[dataset]);
    expect(result.ok, JSON.stringify(result.fileFindings)).toBe(true);
    expect(result.counts.rows_rejected).toBe(0);
    expect(result.fileFindings).toEqual([]);
  }, 60_000);

  it("raises no blocking finding in the platform's pre-run check", () => {
    const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const registry = read("supabase/functions/_shared/registry.generated.json");
    const bridge = read("supabase/functions/_shared/engineBridge.json");
    const fixture = read("supabase/functions/_shared/fixtures/validation_parity/dataset.json");
    const blank = (v: unknown) => (v === "" ? null : v);
    const dataset = {
      materials: data.materials, products: data.products, suppliers: data.suppliers,
      inbound: data.inbound, outbound: data.outbound,
      bom: data.bom_multi_level.map((b: Record<string, unknown>) => ({
        ...b, product_id: null, higher_level_component_id: blank(b.higher_level_component_id),
      })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = flattenFindings(gradeManifest(dataset as any, fixture.defaults, registry, bridge));
    const blocks = findings.filter((f: { severity: string }) => f.severity === "block");
    expect(blocks.slice(0, 5), JSON.stringify(blocks.slice(0, 5))).toEqual([]);
  }, 60_000);

  it("is multi-level, with shared materials and hub suppliers", () => {
    expect(Math.max(...data.bom_multi_level.map((r: { level: number }) => r.level))).toBe(4);
    const parents = new Map<string, number>();
    for (const r of data.bom_multi_level) parents.set(r.material_id, (parents.get(r.material_id) ?? 0) + 1);
    expect([...parents.entries()].filter(([id, n]) => id.startsWith("M-") && n > 1).length).toBeGreaterThan(300);
    const perSupplier = new Map<string, number>();
    for (const i of data.inbound) perSupplier.set(i.supplier_id, (perSupplier.get(i.supplier_id) ?? 0) + 1);
    expect(perSupplier.size).toBe(1000);
    expect(Math.max(...perSupplier.values())).toBeGreaterThanOrEqual(8);
  });

  it("has a deep-tier graph reachable from the plant, one tier down per edge", () => {
    const byUid = new Map<string, { depth: number; is_seed: boolean }>(
      data.network_nodes.map((n: { uid: string; depth: number; is_seed: boolean }) => [n.uid, n]),
    );
    expect(data.network_nodes.filter((n: { is_seed: boolean }) => n.is_seed)).toHaveLength(1);
    const reached = new Set<string>();
    for (const e of data.network_edges) {
      const a = byUid.get(e.src_uid), b = byUid.get(e.dst_uid);
      expect(a && b).toBeTruthy();
      expect(b!.depth).toBe(a!.depth + 1);
      reached.add(e.dst_uid);
    }
    for (const [uid, n] of byUid) if (!n.is_seed) expect(reached.has(uid)).toBe(true);
  });

  it("splits the big files into parts that validate and add up to the whole", () => {
    const parts = (stem: string) =>
      readdirSync(join(out, "csv_split")).filter((f) => f.startsWith(`${stem}_part`)).sort()
        .map((f) => readFileSync(join(out, "csv_split", f), "utf8"));
    for (const [stem, dataset] of [["bom_multi_level", "bom_multi_level"], ["inbound_logistics", "inbound_logistics"]] as const) {
      const chunks = parts(stem);
      expect(chunks.length).toBeGreaterThan(1);
      let rows = 0;
      for (const c of chunks) {
        const r = validateRows(parseCsv(c), INGEST_DATASETS[dataset]);
        expect(r.ok, `${stem}: ${JSON.stringify(r.fileFindings)}`).toBe(true);
        rows += r.rows.length;
      }
      expect(rows).toBe(data[stem === "bom_multi_level" ? "bom_multi_level" : "inbound"].length);
    }
  }, 60_000);

  it("never separates a sub-assembly from its parent when it splits the BOM", () => {
    const owner = (p: string) => (p.startsWith("P-") ? p : `P-${p.split("-")[1]}`);
    const seen = new Set<string>();
    for (const c of parts("bom_multi_level")) {
      const parsed = parseCsv(c);
      const col = parsed.headers.indexOf("higher_level_component_id");
      const products = new Set(parsed.rows.map((r) => owner(r.cells[col])));
      for (const p of products) {
        expect(seen.has(p), `${p} appears in two files`).toBe(false);
        seen.add(p);
      }
    }
    expect(seen.size).toBe(100);

    function parts(stem: string) {
      return readdirSync(join(out, "csv_split")).filter((f) => f.startsWith(`${stem}_part`)).sort()
        .map((f) => readFileSync(join(out, "csv_split", f), "utf8"));
    }
  });

  it("is deterministic: the same seed writes the same file", () => {
    const again = mkdtempSync(join(tmpdir(), "demo-large-"));
    const r = spawnSync("python3", ["scripts/demo_project_large/build_dataset.py", "--out", again], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(join(again, "dataset.json"), "utf8")).toEqual(readFileSync(join(out, "dataset.json"), "utf8"));
  }, 120_000);
});

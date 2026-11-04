// The demo dataset for the three network pages (scripts/demo_project) must load the
// way a real upload does. The item masters, the multi-level BOM and the two logistics
// files go through the REAL CSV and contract validators — the same ones the upload
// wizard and `ingest-file` run — so a header or a value the wizard would refuse fails
// here, before anyone tries to seed it. The deep-tier graph has no validator (it goes
// straight to the table through a bulk call), so its structure is checked directly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCsv } from "../../../supabase/functions/_shared/csvParse";
import { validateRows } from "../../../supabase/functions/_shared/ingestValidate";
import { INGEST_DATASETS } from "../../../supabase/functions/_shared/ingestSpec.generated";
import { flattenFindings, gradeManifest } from "../../../supabase/functions/_shared/grading";

const dir = "scripts/demo_project";
const csv = (name: string) => readFileSync(`${dir}/csv/${name}.csv`, "utf8");
const data = JSON.parse(readFileSync(`${dir}/dataset.json`, "utf8"));

const WIZARD: Record<string, string> = {
  suppliers: "item_master_suppliers",
  materials: "item_master_materials",
  products: "item_master_products",
  bom_multi_level: "bom_multi_level",
  inbound_logistics: "inbound_logistics",
  outbound_logistics: "outbound_logistics",
};

describe("demo dataset: upload-ready files", () => {
  it.each(Object.entries(WIZARD))("%s passes the real CSV and contract validators", (file, dataset) => {
    const result = validateRows(parseCsv(csv(file)), INGEST_DATASETS[dataset]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.counts.rows_rejected).toBe(0);
    expect(result.fileFindings).toEqual([]);
  });

  it("keeps the identifiers connected", () => {
    const rows = (file: string) =>
      validateRows(parseCsv(csv(file)), INGEST_DATASETS[WIZARD[file]]).rows.map((r) => r.parsed);
    const ids = (file: string, key: string) => new Set(rows(file).map((r) => r[key]));
    const materials = ids("materials", "material_id");
    const suppliers = ids("suppliers", "supplier_id");
    const products = ids("products", "product_id");
    const bom = rows("bom_multi_level");
    const parents = new Set(bom.map((r) => r.higher_level_component_id).filter(Boolean));
    // a leaf of the tree is a purchased material, and every purchased material has a lane
    const leaves = new Set(bom.map((r) => r.material_id).filter((m) => !parents.has(m)));
    expect(leaves).toEqual(materials);
    for (const r of rows("inbound_logistics")) {
      expect(materials.has(r.material_id)).toBe(true);
      expect(suppliers.has(r.supplier_id)).toBe(true);
    }
    expect(new Set(rows("inbound_logistics").map((r) => r.material_id))).toEqual(materials);
    for (const r of rows("outbound_logistics")) expect(products.has(r.product_id)).toBe(true);
  });

  it("has the shape each page needs", () => {
    expect(Math.max(...data.bom_multi_level.map((r: { level: number }) => r.level))).toBe(3);
    const lanesPerMaterial = new Map<string, number>();
    for (const i of data.inbound) lanesPerMaterial.set(i.material_id, (lanesPerMaterial.get(i.material_id) ?? 0) + 1);
    expect([...lanesPerMaterial.values()].some((n) => n > 1)).toBe(true); // a second source
  });
});

describe("demo dataset: the platform's pre-run data check", () => {
  // The grader every run goes through (sim-command's gate, the browser's verification).
  // A dataset that loads but is refused here can be looked at and never simulated, which
  // is how a level-1 BOM row with no parent got through the upload validators.
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const registry = read("supabase/functions/_shared/registry.generated.json");
  const bridge = read("supabase/functions/_shared/engineBridge.json");
  const fixture = read("supabase/functions/_shared/fixtures/validation_parity/dataset.json");

  it("raises no blocking finding, so a run can be dispatched", () => {
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
    expect(blocks, JSON.stringify(blocks)).toEqual([]);
  });
});

describe("demo dataset: deep-tier firm graph", () => {
  const nodes: Array<{ uid: string; depth: number; is_seed: boolean; name: string; country: string; lat: number; long: number }> =
    data.network_nodes;
  const edges: Array<{ src_uid: string; dst_uid: string; depth: number }> = data.network_edges;
  const byUid = new Map(nodes.map((n) => [n.uid, n]));

  it("has one seed, four tiers, and coordinates for the map", () => {
    expect(nodes.filter((n) => n.is_seed)).toHaveLength(1);
    expect(new Set(nodes.map((n) => n.depth))).toEqual(new Set([0, 1, 2, 3]));
    for (const n of nodes) {
      expect(Number.isFinite(n.lat) && Number.isFinite(n.long)).toBe(true);
      expect(n.country).toBeTruthy();
    }
    expect(new Set(nodes.map((n) => n.country)).size).toBeGreaterThanOrEqual(8);
  });

  it("wires every edge one tier down between firms that exist, with no duplicates", () => {
    const seen = new Set<string>();
    for (const e of edges) {
      const a = byUid.get(e.src_uid);
      const b = byUid.get(e.dst_uid);
      expect(a && b).toBeTruthy();
      expect(b!.depth).toBe(a!.depth + 1);
      expect(e.depth).toBe(b!.depth);
      const k = `${e.src_uid}>${e.dst_uid}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("reaches every firm from the plant", () => {
    const reached = new Set(edges.map((e) => e.dst_uid));
    for (const n of nodes) if (!n.is_seed) expect(reached.has(n.uid), n.name).toBe(true);
  });

  it("makes the tier-1 firms the chain's suppliers, by name", () => {
    const tier1 = new Set(nodes.filter((n) => n.depth === 1).map((n) => n.name));
    expect(tier1).toEqual(new Set(data.suppliers.map((s: { name: string }) => s.name)));
  });

  it("has shared upstream firms, so some are more critical than others", () => {
    const indegree = new Map<string, number>();
    for (const e of edges) indegree.set(e.dst_uid, (indegree.get(e.dst_uid) ?? 0) + 1);
    expect(Math.max(...indegree.values())).toBeGreaterThanOrEqual(3);
  });
});

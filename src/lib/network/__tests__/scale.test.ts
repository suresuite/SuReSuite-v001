import { describe, expect, it } from "vitest";
import {
  DEGREE_BUCKETS,
  LARGE_GRAPH,
  breakdown,
  buildOverviewNodes,
  degreeHistogram,
  degrees,
  isLargeGraph,
  rankNodes,
  type OverviewNode,
} from "../scale";

const node = (id: string, group: string, extra: Partial<OverviewNode> = {}): OverviewNode => ({
  id, label: id, group, degree: 0, weight: null, secondary: null, ...extra,
});

describe("isLargeGraph", () => {
  it("is false at the thresholds and true past either", () => {
    expect(isLargeGraph(LARGE_GRAPH.nodes, LARGE_GRAPH.edges)).toBe(false);
    expect(isLargeGraph(LARGE_GRAPH.nodes + 1, 0)).toBe(true);
    expect(isLargeGraph(0, LARGE_GRAPH.edges + 1)).toBe(true);
    expect(isLargeGraph(17, 40)).toBe(false); // the small demo
  });
});

describe("degrees", () => {
  it("counts edges touching a node in either direction and ignores strangers", () => {
    const d = degrees(["a", "b", "c"], [
      { source: "a", target: "b" }, { source: "a", target: "c" }, { source: "x", target: "a" },
    ]);
    expect(Object.fromEntries(d)).toEqual({ a: 3, b: 1, c: 1 });
  });
});

describe("buildOverviewNodes", () => {
  it("reads id, label, group, weight and secondary through the page's accessors", () => {
    const raw = [{ id: "S1", label: "Supplier 1", g: "A", w: 12, c: "Chile" }, { id: "M1", label: "", g: "B", w: NaN, c: undefined }];
    const out = buildOverviewNodes(raw, [{ source: "S1", target: "M1" }], {
      id: (n) => n.id, label: (n) => n.label, group: (n) => n.g, weight: (n) => n.w, secondary: (n) => n.c,
    });
    expect(out[0]).toMatchObject({ id: "S1", label: "Supplier 1", group: "A", degree: 1, weight: 12, secondary: "Chile" });
    expect(out[1]).toMatchObject({ label: "M1", weight: null, secondary: null }); // blank label → id; NaN → no weight
  });
});

describe("rankNodes", () => {
  const nodes = [
    node("a", "A", { degree: 3, weight: 10 }), node("b", "A", { degree: 9, weight: null }),
    node("c", "B", { degree: 9, weight: 50 }), node("d", "B", { degree: 1, weight: 2 }),
  ];
  it("ranks by connections, ties on label", () => {
    expect(rankNodes(nodes, { by: "degree" }).map((n) => n.id)).toEqual(["b", "c", "a", "d"]);
  });
  it("ranks by weight, nodes without one last", () => {
    expect(rankNodes(nodes, { by: "weight" }).map((n) => n.id)).toEqual(["c", "a", "d", "b"]);
  });
  it("filters by group and by a search on id or label", () => {
    expect(rankNodes(nodes, { by: "degree", group: "B" }).map((n) => n.id)).toEqual(["c", "d"]);
    expect(rankNodes(nodes, { by: "degree", query: " D " }).map((n) => n.id)).toEqual(["d"]);
  });
  it("does not mutate its input", () => {
    const before = nodes.map((n) => n.id).join();
    rankNodes(nodes, { by: "degree" });
    expect(nodes.map((n) => n.id).join()).toBe(before);
  });
});

describe("breakdown", () => {
  const nodes = ["x", "x", "y", "z", "w", null, undefined].map((s, i) => node(String(i), "A", { secondary: s ?? null }));
  it("counts every node: the rows add up to the total, unknowns included", () => {
    const rows = breakdown(nodes, (n) => n.secondary);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(nodes.length);
    expect(rows.find((r) => r.key === "x")?.count).toBe(2);
    expect(rows.find((r) => r.key === "Unknown")?.count).toBe(2);
    expect(rows[0].count).toBe(2); // largest first
  });
  it("folds the tail into one Other row without losing a node", () => {
    const rows = breakdown(nodes, (n) => n.secondary, 2);
    expect(rows).toHaveLength(3);
    expect(rows[2].key).toMatch(/^Other/);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(nodes.length);
  });
});

describe("degreeHistogram", () => {
  it("puts every node in exactly one bucket", () => {
    const degs = [0, 1, 1, 2, 3, 5, 6, 10, 11, 25, 26, 400];
    const rows = degreeHistogram(degs.map((d, i) => node(String(i), "A", { degree: d })));
    expect(rows.map((r) => r.key)).toEqual(DEGREE_BUCKETS.map((b) => b.label));
    expect(rows.map((r) => r.count)).toEqual([1, 2, 1, 2, 2, 2, 2]);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(degs.length);
  });
});

describe("at the size the large demo reaches", () => {
  it("summarises 5 000 nodes and 14 000 edges in well under a second", () => {
    const n = 5000;
    const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`, "ABCD"[i % 4], { secondary: `c${i % 40}` }));
    const edges = Array.from({ length: 14000 }, (_, i) => ({ source: `n${(i * 7) % n}`, target: `n${(i * 13 + 1) % n}` }));
    const t0 = performance.now();
    const built = buildOverviewNodes(nodes, edges, { id: (x) => x.id, label: (x) => x.label, group: (x) => x.group });
    const ranked = rankNodes(built, { by: "degree" });
    breakdown(built, (x) => x.group);
    degreeHistogram(built);
    const ms = performance.now() - t0;
    expect(ranked).toHaveLength(n);
    expect(ms).toBeLessThan(1000);
  });
});

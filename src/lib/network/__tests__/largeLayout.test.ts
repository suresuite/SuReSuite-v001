import { describe, expect, it } from "vitest";
import { columnLayout, edgeSpan, orderLayers, placeNodes, ringLayout, spreadOuterBand, type LayoutEdge, type PlaceInput } from "../largeLayout";

function rand(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** A planted layered graph whose node ids are SHUFFLED, so the given order carries no structure. */
function layered(sizes: number[], perNode = 2, seed = 11) {
  const r = rand(seed);
  const n = sizes.reduce((a, b) => a + b, 0);
  const perm = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5);
  const layerOf = new Int32Array(n);
  const slot: number[][] = [];
  let k = 0;
  sizes.forEach((s, l) => {
    slot.push([]);
    for (let i = 0; i < s; i++) { layerOf[perm[k]] = l; slot[l].push(perm[k]); k++; }
  });
  const edges: LayoutEdge[] = [];
  // each node in layer l+1 hangs off nodes at about the same relative position in layer l
  for (let l = 0; l + 1 < sizes.length; l++) {
    for (let i = 0; i < sizes[l + 1]; i++) {
      for (let j = 0; j < perNode; j++) {
        const p = Math.min(sizes[l] - 1, Math.max(0, Math.floor((i / sizes[l + 1]) * sizes[l] + (r() - 0.5) * 4)));
        edges.push({ source: slot[l][p], target: slot[l + 1][i] });
      }
    }
  }
  return { n, layerOf, edges };
}

describe("orderLayers (the barycenter ordering)", () => {
  it("puts every node in exactly one layer", () => {
    const g = layered([60, 120, 20, 5]);
    const layers = orderLayers(g.layerOf, 4, g.edges);
    expect(layers.map((l) => l.length)).toEqual([60, 120, 20, 5]);
    expect(new Set(layers.flat()).size).toBe(g.n);
  });
  it("makes edges much shorter than the order the nodes arrived in", () => {
    const g = layered([200, 300, 40, 10]);
    const initial = Array.from({ length: 4 }, (_, l) => Array.from(g.layerOf).map((v, i) => (v === l ? i : -1)).filter((i) => i >= 0));
    const before = edgeSpan(initial, g.edges, g.n);
    const after = edgeSpan(orderLayers(g.layerOf, 4, g.edges), g.edges, g.n);
    expect(after).toBeLessThan(before * 0.5);
  });
  it("is deterministic and leaves a node with no edges where it was", () => {
    const g = layered([30, 30]);
    expect(orderLayers(g.layerOf, 2, g.edges)).toEqual(orderLayers(g.layerOf, 2, g.edges));
    const lone = orderLayers(new Int32Array([0, 0, 1]), 2, []);
    expect(lone).toEqual([[0, 1], [2]]);
  });
});

describe("columnLayout", () => {
  const g = layered([300, 500, 60, 12]);
  const p = columnLayout(g.layerOf, 4, g.edges, { aspect: 1.8 });

  it("gives every node its own place", () => {
    const seen = new Set<string>();
    for (let i = 0; i < g.n; i++) {
      expect(Number.isFinite(p.x[i]) && Number.isFinite(p.y[i])).toBe(true);
      const k = `${p.x[i]},${p.y[i]}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
  it("is shaped like the card, not like the longest class", () => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < g.n; i++) {
      minX = Math.min(minX, p.x[i]); maxX = Math.max(maxX, p.x[i]);
      minY = Math.min(minY, p.y[i]); maxY = Math.max(maxY, p.y[i]);
    }
    const aspect = (maxX - minX) / (maxY - minY);
    expect(aspect).toBeGreaterThan(1.8 * 0.6);
    expect(aspect).toBeLessThan(1.8 * 1.6);
  });
  it("keeps the classes in order, left to right", () => {
    const meanX = [0, 1, 2, 3].map((l) => {
      let s = 0, c = 0;
      for (let i = 0; i < g.n; i++) if (g.layerOf[i] === l) { s += p.x[i]; c++; }
      return s / c;
    });
    expect(meanX).toEqual([...meanX].sort((a, b) => a - b));
  });
  it("lines neighbours up: an edge's two ends are at nearly the same height", () => {
    let total = 0;
    for (const e of g.edges) total += Math.abs(p.y[e.source] - p.y[e.target]);
    const mean = total / g.edges.length;
    let ymax = 0;
    for (let i = 0; i < g.n; i++) ymax = Math.max(ymax, p.y[i]);
    expect(mean).toBeLessThan(ymax * 0.12); // random placement would be ~ a third of the height
  });
  it("lays out 5 000 nodes and 14 000 edges quickly", () => {
    const big = layered([1000, 1800, 100, 25, 1500, 575], 3);
    const t0 = performance.now();
    columnLayout(big.layerOf, 6, big.edges, { aspect: 1.8 });
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("ringLayout", () => {
  // a plant, 600 tier-1, 800 tier-2 each hung off a tier-1, 400 tier-3 off tier-2
  const r = rand(3);
  const sizes = [1, 600, 800, 400];
  const layerOf = new Int32Array(sizes.reduce((a, b) => a + b, 0));
  const start = [0, 1, 601, 1401];
  sizes.forEach((s, l) => { for (let i = 0; i < s; i++) layerOf[start[l] + i] = l; });
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < 600; i++) edges.push({ source: 0, target: 1 + i });
  for (let i = 0; i < 800; i++) edges.push({ source: 1 + Math.floor(r() * 600), target: 601 + i });
  for (let i = 0; i < 400; i++) edges.push({ source: 601 + Math.floor(r() * 800), target: 1401 + i });
  const p = ringLayout(layerOf, 4, edges);
  const radius = (i: number) => Math.hypot(p.x[i], p.y[i]);

  it("puts the first layer at the centre and each layer on its own, larger ring", () => {
    expect(radius(0)).toBeCloseTo(0);
    const rs = [1, 2, 3].map((l) => radius(start[l]));
    expect(rs[0]).toBeLessThan(rs[1]);
    expect(rs[1]).toBeLessThan(rs[2]);
    for (let l = 1; l < 4; l++) for (let i = 0; i < sizes[l]; i += 37) expect(radius(start[l] + i)).toBeCloseTo(rs[l - 1], 3);
  });
  it("keeps nodes on a ring at least a pitch apart", () => {
    const l = 2;
    const pts = Array.from({ length: sizes[l] }, (_, i) => [p.x[start[l] + i], p.y[start[l] + i]]);
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      minD = Math.min(minD, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    }
    expect(minD).toBeGreaterThan(14 * 0.95);
  });
  it("seats a firm near the firms it buys from: the angle between linked ends is small", () => {
    let total = 0;
    let c = 0;
    for (const e of edges) {
      if (e.source === 0) continue;
      const a = Math.atan2(p.y[e.source], p.x[e.source]);
      const b = Math.atan2(p.y[e.target], p.x[e.target]);
      let d = Math.abs(a - b);
      if (d > Math.PI) d = 2 * Math.PI - d;
      total += d;
      c++;
    }
    expect(total / c).toBeLessThan(0.45); // random seating averages ~ π/2
  });
});

describe("placeNodes", () => {
  const inputs: PlaceInput[] = Array.from({ length: 60 }, (_, i) => ({
    x: 100 + i * 7, y: 50 + (i % 9) * 11, w: 20 + (i % 4) * 6, h: 12 + (i % 3) * 4, layer: i % 3, tie: i % 5,
  }));
  const edges: LayoutEdge[] = Array.from({ length: 80 }, (_, i) => ({ source: i % 60, target: (i * 7 + 1) % 60 }));

  it("`page` draws the lens's own layout exactly: every position and every size", () => {
    const p = placeNodes("page", inputs, 1, edges, 1.7);
    for (let i = 0; i < inputs.length; i++) {
      expect(p.x[i]).toBeCloseTo(inputs[i].x);
      expect(p.y[i]).toBeCloseTo(inputs[i].y);
      expect(p.w[i]).toBeCloseTo(inputs[i].w);
      expect(p.h[i]).toBeCloseTo(inputs[i].h);
    }
  });
  it("`columns` and `rings` ignore the page's positions and size every node alike", () => {
    for (const kind of ["columns", "rings"] as const) {
      const p = placeNodes(kind, inputs, 3, edges, 1.7);
      expect(new Set(Array.from(p.w)).size).toBe(1);
      expect(p.x.some((v, i) => Math.abs(v - inputs[i].x) > 1)).toBe(true);
      expect(Array.from(p.x).every(Number.isFinite)).toBe(true);
    }
  });
});

describe("spreadOuterBand", () => {
  // a plant, 300 inner firms in a disc, and 400 outer firms bunched in 6 clusters next to their parents
  const r = rand(21);
  const nIn = 301, nOut = 400, n = nIn + nOut;
  const x = new Float32Array(n), y = new Float32Array(n), w = new Float32Array(n).fill(20);
  const layer = new Int32Array(n);
  for (let i = 1; i < nIn; i++) {
    const a = r() * 2 * Math.PI, rad = 700 + r() * 300;
    x[i] = Math.cos(a) * rad; y[i] = Math.sin(a) * rad; layer[i] = 1;
  }
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < nOut; i++) {
    const v = nIn + i, parent = 1 + Math.floor(r() * 300);
    const a = Math.atan2(y[parent], x[parent]);
    x[v] = Math.cos(a) * 230 + (r() - 0.5) * 30; y[v] = Math.sin(a) * 230 + (r() - 0.5) * 30; layer[v] = 2;
    edges.push({ source: parent, target: v });
  }
  const sx = Float32Array.from(x), sy = Float32Array.from(y);
  spreadOuterBand(sx, sy, w, layer, edges, [2]);
  const outer = Array.from({ length: nOut }, (_, i) => nIn + i);

  it("leaves every other node exactly where the lens put it", () => {
    for (let i = 0; i < nIn; i++) { expect(sx[i]).toBe(x[i]); expect(sy[i]).toBe(y[i]); }
  });
  it("puts the outer layer outside everything else", () => {
    let reach = 0;
    for (let i = 0; i < nIn; i++) reach = Math.max(reach, Math.hypot(x[i], y[i]));
    for (const v of outer) expect(Math.hypot(sx[v], sy[v])).toBeGreaterThan(reach);
  });
  it("spreads it evenly around: no wide empty stretch of rim", () => {
    const angles = outer.map((v) => (Math.atan2(sy[v], sx[v]) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    let maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
    for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
    expect(maxGap).toBeLessThan(((2 * Math.PI) / nOut) * 6);
    // the bunched start had large empty stretches
    const before = outer.map((v) => (Math.atan2(y[v], x[v]) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    let beforeGap = before[0] + 2 * Math.PI - before[before.length - 1];
    for (let i = 1; i < before.length; i++) beforeGap = Math.max(beforeGap, before[i] - before[i - 1]);
    expect(maxGap).toBeLessThan(beforeGap);
  });
  it("keeps each node on the side of its parent", () => {
    let total = 0;
    for (const e of edges) {
      let d = Math.abs(Math.atan2(sy[e.target], sx[e.target]) - Math.atan2(sy[e.source], sx[e.source]));
      if (d > Math.PI) d = 2 * Math.PI - d;
      total += d;
    }
    expect(total / edges.length).toBeLessThan(0.45); // random seating averages ~ pi/2
  });
  it("gives every node its own place, and is deterministic", () => {
    const seen = new Set(outer.map((v) => `${sx[v].toFixed(2)},${sy[v].toFixed(2)}`));
    expect(seen.size).toBe(nOut);
    const again = Float32Array.from(x), againY = Float32Array.from(y);
    spreadOuterBand(again, againY, w, layer, edges, [2]);
    expect(Array.from(again)).toEqual(Array.from(sx));
  });
  it("does nothing when no layer is named, and through placeNodes leaves the page's sizes alone", () => {
    const px = Float32Array.from(x);
    spreadOuterBand(px, Float32Array.from(y), w, layer, edges, []);
    expect(Array.from(px)).toEqual(Array.from(x));
    const inputs: PlaceInput[] = Array.from({ length: n }, (_, i) => ({ x: x[i], y: y[i], w: 14 + (i % 3), h: 14, layer: layer[i], tie: 0 }));
    const placed = placeNodes("page", inputs, 1, edges, 1.7, { layers: [2] });
    expect(Array.from(placed.w)).toEqual(inputs.map((v) => v.w));
    expect(placed.x[0]).toBe(x[0]);
  });
});

describe("spreadOuterBand irregularity", () => {
  const r = rand(5);
  const nIn = 201, nOut = 500, n = nIn + nOut;
  const x = new Float32Array(n), y = new Float32Array(n), w = new Float32Array(n).fill(20);
  const layer = new Int32Array(n);
  for (let i = 1; i < nIn; i++) { const a = r() * 6.2832, rad = 40 + r() * 120; x[i] = Math.cos(a) * rad; y[i] = Math.sin(a) * rad; layer[i] = 1; }
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < nOut; i++) { const v = nIn + i; edges.push({ source: 1 + Math.floor(r() * 200), target: v }); layer[v] = 2; }
  const run = (irr: number) => {
    const px = Float32Array.from(x), py = Float32Array.from(y);
    spreadOuterBand(px, py, w, layer, edges, [2], irr);
    return { px, py };
  };
  const radii = (o: { px: Float32Array; py: Float32Array }) =>
    Array.from({ length: nOut }, (_, i) => Math.hypot(o.px[nIn + i], o.py[nIn + i]));
  const std = (a: number[]) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

  it("0 is the even band (a handful of exact radii), and the default scatters them", () => {
    const distinct = (o: { px: Float32Array; py: Float32Array }) => new Set(radii(o).map((v) => Math.round(v * 2))).size;
    const even = run(0), loose = run(1);
    expect(distinct(even)).toBeLessThanOrEqual(12);          // one per sub-ring
    expect(distinct(loose)).toBeGreaterThan(distinct(even) * 8);
    expect(std(radii(loose))).toBeGreaterThan(0);
  });
  it("gives every node its own place and is the same on every call", () => {
    const a = run(1), b = run(1);
    expect(Array.from(a.px)).toEqual(Array.from(b.px));
    const seen = new Set(Array.from({ length: nOut }, (_, i) => `${a.px[nIn + i].toFixed(1)},${a.py[nIn + i].toFixed(1)}`));
    expect(seen.size).toBe(nOut);
  });
  it("however loose, never moves a node inside what was already placed, or leaves a wide gap", () => {
    for (const irr of [0.5, 1, 2]) {
      const o = run(irr);
      let reach = 0;
      for (let i = 0; i < nIn; i++) reach = Math.max(reach, Math.hypot(x[i], y[i]));
      for (const v of radii(o)) expect(v).toBeGreaterThan(reach);
      for (let i = 0; i < nIn; i++) expect(o.px[i]).toBe(x[i]);
      const angles = Array.from({ length: nOut }, (_, i) => (Math.atan2(o.py[nIn + i], o.px[nIn + i]) + 2 * Math.PI) % (2 * Math.PI)).sort((p, q) => p - q);
      let maxGap = angles[0] + 2 * Math.PI - angles[nOut - 1];
      for (let i = 1; i < nOut; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
      expect(maxGap).toBeLessThan(((2 * Math.PI) / nOut) * 12);
    }
  });
});

describe("spreadOuterBand fringe", () => {
  // 300 suppliers on a ring (a few big), 700 firms that each buy from one or two of the biggest
  const r = rand(17);
  const nIn = 301, nOut = 700, n = nIn + nOut;
  const x = new Float32Array(n), y = new Float32Array(n), w = new Float32Array(n);
  const layer = new Int32Array(n);
  w[0] = 30;
  for (let i = 1; i < nIn; i++) { const a = r() * 6.2832, rad = 700 + r() * 300; x[i] = Math.cos(a) * rad; y[i] = Math.sin(a) * rad; layer[i] = 1; w[i] = 10 + 40 * r() ** 3; }
  const edges: LayoutEdge[] = [];
  const parentsOf: number[][] = [];
  const topInner = Array.from({ length: 300 }, (_, i) => i + 1).sort((a, b) => w[b] - w[a]).slice(0, 14);
  for (let i = 0; i < nOut; i++) {
    const v = nIn + i;
    layer[v] = 2;
    w[v] = 10 + 26 * r() ** 2;
    const pick = () => (r() < 0.7 ? topInner[Math.floor(r() * topInner.length)] : 1 + Math.floor(r() * 300));
    const ps = [pick()];
    parentsOf.push(ps);
    for (const p of ps) edges.push({ source: p, target: v });
  }
  const run = (irr = 0.8) => {
    const px = Float32Array.from(x), py = Float32Array.from(y);
    spreadOuterBand(px, py, w, layer, edges, [2], irr, "fringe");
    return { px, py };
  };
  const o = run();
  const outer = Array.from({ length: nOut }, (_, i) => nIn + i);
  const circ = (a: number, b: number) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
  const ang = (px: Float32Array, py: Float32Array, v: number) => Math.atan2(py[v], px[v]);

  it("leaves every other node where it was and puts the layer outside them, each on its own place", () => {
    let reach = 0;
    for (let i = 0; i < nIn; i++) { expect(o.px[i]).toBe(x[i]); reach = Math.max(reach, Math.hypot(x[i], y[i])); }
    for (const v of outer) expect(Math.hypot(o.px[v], o.py[v])).toBeGreaterThan(reach);
    expect(new Set(outer.map((v) => `${o.px[v].toFixed(2)},${o.py[v].toFixed(2)}`)).size).toBe(nOut);
  });

  it("seats each firm on the side of its supplier, not spread over the rim", () => {
    let total = 0;
    for (const v of outer) total += circ(ang(o.px, o.py, v), ang(x as Float32Array, y as Float32Array, parentsOf[v - nIn][0]));
    expect(total / nOut).toBeLessThan(0.1);
  });

  it("is thick in front of a busy supplier and thin elsewhere: no group shapes, an uneven fringe", () => {
    const R = (v: number) => Math.hypot(o.px[v], o.py[v]);
    const lo = Math.min(...outer.map(R));
    const sector = new Map<number, number[]>();
    for (const v of outer) { const k = Math.floor(((ang(o.px, o.py, v) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 12)); sector.set(k, [...(sector.get(k) ?? []), R(v)]); }
    const depth = [...sector.values()].map((rs) => Math.max(...rs) - lo);
    expect(Math.max(...depth)).toBeGreaterThan(Math.min(...depth) * 3 + 20);
  });

  it("never lets two firms overlap", () => {
    let min = Infinity;
    for (let a = 0; a < nOut; a++) for (let b = a + 1; b < nOut; b++) {
      const va = nIn + a, vb = nIn + b;
      const d = Math.hypot(o.px[va] - o.px[vb], o.py[va] - o.py[vb]);
      min = Math.min(min, d / ((w[va] + w[vb]) / 2));
    }
    expect(min).toBeGreaterThan(0.6);
  });

  it("puts the bigger of firms with the same supplier on the inner lane", () => {
    let inside = 0, groups = 0;
    for (const p of topInner) {
      const g = outer.filter((v) => parentsOf[v - nIn][0] === p).sort((a, b) => w[b] - w[a]);
      if (g.length < 8) continue;
      groups++;
      const radii = g.map((v) => Math.hypot(o.px[v], o.py[v])).sort((a, b) => a - b);
      if (Math.hypot(o.px[g[0]], o.py[g[0]]) <= radii[Math.floor(radii.length / 2)]) inside++;
    }
    expect(groups).toBeGreaterThanOrEqual(5);
    expect(inside / groups).toBeGreaterThanOrEqual(0.8);
  });

  it("is the same on every call, and ruler-straight at irregularity 0", () => {
    expect(Array.from(run().px)).toEqual(Array.from(o.px));
    const radii = new Set(outer.map((v) => Math.round(Math.hypot(run(0).px[v], run(0).py[v]) * 2)));
    expect(radii.size).toBeLessThanOrEqual(14); // a handful of lanes (at most 8 crowd one stretch), not a scatter
  });

  it("is reached through placeNodes with the same result", () => {
    const inputs: PlaceInput[] = Array.from({ length: n }, (_, i) => ({ x: x[i], y: y[i], w: w[i], h: w[i], layer: layer[i], tie: 0 }));
    const placed = placeNodes("page", inputs, 1, edges, 1.7, { layers: [2], irregularity: 0.8, style: "fringe" });
    expect(Array.from(placed.x)).toEqual(Array.from(o.px));
  });
});

import { describe, expect, it } from "vitest";
import {
  buildScene, centerOn, drawGraph, fitTransform, lodFor, nearestNode, panBy, screenToWorld, worldToScreen, zoomAt,
  type Ctx2D, type DrawStyle, type SceneEdgeInput, type SceneNodeInput,
} from "../canvasGraph";

const style: DrawStyle = {
  palette: ["#111", "#222", "#333"], edge: "#888", edgeHighlight: "#38f", ring: "#000", text: "#000",
  shape: "rect", background: "#fff",
};

/** A context that only counts what it is asked to do. */
function recorder() {
  const calls = { fillRect: 0, strokeRect: 0, arc: 0, moveTo: 0, lineTo: 0, stroke: 0, fill: 0, fillText: [] as string[] };
  const ctx: Ctx2D = {
    clearRect() {}, fillRect() { calls.fillRect++; }, strokeRect() { calls.strokeRect++; },
    beginPath() {}, moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
    arc() { calls.arc++; }, fill() { calls.fill++; }, stroke() { calls.stroke++; },
    fillText(t: string) { calls.fillText.push(t); },
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textAlign: "center", textBaseline: "top",
  };
  return { ctx, calls };
}

function rand(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function graph(n: number, m: number, extent = 4000, seed = 5) {
  const r = rand(seed);
  const nodes: SceneNodeInput[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, x: r() * extent, y: r() * extent * 0.5, w: 30, h: 19, label: `Node ${i}`, color: i % 3,
  }));
  const edges: SceneEdgeInput[] = Array.from({ length: m }, () => ({
    source: `n${Math.floor(r() * n)}`, target: `n${Math.floor(r() * n)}`, width: r() < 0.9 ? 1 : 2,
  }));
  return { nodes, edges };
}

describe("buildScene", () => {
  it("indexes nodes, drops an edge that names a node that is not there, and bounds the drawing", () => {
    const s = buildScene(
      [{ id: "a", x: 0, y: 0, w: 10, h: 10, label: "A", color: 0 }, { id: "b", x: 100, y: 50, w: 10, h: 10, label: "B", color: 1 }],
      [{ source: "a", target: "b" }, { source: "a", target: "ghost" }],
    );
    expect(s.n).toBe(2);
    expect(s.m).toBe(1);
    expect(s.indexOf.get("b")).toBe(1);
    expect(s.bounds).toEqual({ minX: -5, minY: -5, maxX: 105, maxY: 55 });
  });
  it("classes edge widths into three batches", () => {
    const s = buildScene(
      [{ id: "a", x: 0, y: 0, w: 1, h: 1, label: "", color: 0 }, { id: "b", x: 1, y: 1, w: 1, h: 1, label: "", color: 0 }],
      [{ source: "a", target: "b", width: 1 }, { source: "a", target: "b", width: 2 }, { source: "a", target: "b", width: 6 }, { source: "a", target: "b" }],
    );
    expect(Array.from(s.wclass)).toEqual([0, 1, 2, 0]);
  });
  it("copes with an empty graph", () => {
    const s = buildScene([], []);
    expect(s.n).toBe(0);
    expect(fitTransform(s.bounds, { width: 800, height: 600 }).k).toBeGreaterThan(0);
  });
});

describe("the view", () => {
  const size = { width: 900, height: 600 };
  it("fits the whole drawing inside the canvas, centred", () => {
    const b = { minX: 0, minY: 0, maxX: 3000, maxY: 1000 };
    const t = fitTransform(b, size);
    const tl = worldToScreen(t, b.minX, b.minY);
    const br = worldToScreen(t, b.maxX, b.maxY);
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(size.width);
    expect(br.y).toBeLessThanOrEqual(size.height);
    expect((tl.x + br.x) / 2).toBeCloseTo(size.width / 2);
    expect((tl.y + br.y) / 2).toBeCloseTo(size.height / 2);
  });
  it("converts between screen and world both ways", () => {
    const t = { k: 0.37, x: 120, y: -40 };
    const w = screenToWorld(t, 333, 222);
    const s = worldToScreen(t, w.x, w.y);
    expect(s.x).toBeCloseTo(333);
    expect(s.y).toBeCloseTo(222);
  });
  it("zooms about the cursor: the point under it does not move", () => {
    const t = { k: 1, x: 0, y: 0 };
    const before = screenToWorld(t, 400, 300);
    const z = zoomAt(t, 2.5, 400, 300);
    const after = screenToWorld(z, 400, 300);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(z.k).toBeCloseTo(2.5);
  });
  it("clamps the zoom, and pans by the drag", () => {
    expect(zoomAt({ k: 20, x: 0, y: 0 }, 100, 0, 0).k).toBe(24);
    expect(zoomAt({ k: 0.03, x: 0, y: 0 }, 0.001, 0, 0).k).toBe(0.02);
    expect(panBy({ k: 2, x: 10, y: 20 }, 5, -5)).toEqual({ k: 2, x: 15, y: 15 });
  });
  it("centres a world point", () => {
    const t = centerOn(size, 100, 200, 2);
    expect(worldToScreen(t, 100, 200)).toEqual({ x: 450, y: 300 });
  });
});

describe("nearestNode (the hit test)", () => {
  it("finds the node under the pointer and nothing where there is none", () => {
    const g = graph(800, 0);
    const s = buildScene(g.nodes, g.edges);
    const target = 123;
    expect(nearestNode(s, s.xs[target] + 2, s.ys[target] - 2, 12)).toBe(target);
    expect(nearestNode(s, -5000, -5000, 12)).toBe(-1);
  });
  it("agrees with a brute-force search on 2 000 random probes", () => {
    const g = graph(3000, 0);
    const s = buildScene(g.nodes, g.edges);
    const r = rand(99);
    for (let q = 0; q < 2000; q++) {
      const x = r() * 4000, y = r() * 2000, d = 25;
      let best = -1, bd = d * d;
      for (let i = 0; i < s.n; i++) {
        const dd = (s.xs[i] - x) ** 2 + (s.ys[i] - y) ** 2;
        if (dd < bd || (dd === bd && best !== -1 && i < best)) { bd = dd; best = i; }
      }
      expect(nearestNode(s, x, y, d)).toBe(best);
    }
  });
});

describe("what is drawn at a zoom", () => {
  it("shows labels only when zoomed in and few nodes are in view", () => {
    expect(lodFor(1, 1, 5000, 9000).labels).toBe(false);          // the whole graph
    expect(lodFor(3, 1, 5000, 9000).labels).toBe(false);          // zoomed, but thousands in view
    expect(lodFor(3, 1, 200, 9000).labels).toBe(true);            // zoomed, a readable few
    expect(lodFor(1.5, 1, 200, 9000).labels).toBe(false);         // not zoomed enough
  });
  it("draws a busier graph's edges fainter, and stronger as you zoom in", () => {
    expect(lodFor(1, 1, 100, 20000).edgeAlpha).toBeLessThan(lodFor(1, 1, 100, 500).edgeAlpha);
    expect(lodFor(4, 1, 100, 20000).edgeAlpha).toBeGreaterThan(lodFor(1, 1, 100, 20000).edgeAlpha);
  });
});

describe("drawGraph", () => {
  const size = { width: 900, height: 600 };
  const idle = { selected: -1, hover: -1, moving: false };

  it("draws every node of a graph that fits, as dots when they are tiny", () => {
    const g = graph(500, 800);
    const s = buildScene(g.nodes, g.edges);
    const t = fitTransform(s.bounds, size);
    const { ctx, calls } = recorder();
    const st = drawGraph(ctx, s, t, size, t.k, idle, style);
    expect(st.nodesDrawn).toBe(500);
    expect(calls.fillRect).toBe(1 + 500); // the background and one per node
    expect(st.labelsDrawn).toBe(0);
  });

  it("draws only what is on screen once zoomed in, and labels it", () => {
    const g = graph(3000, 6000);
    const s = buildScene(g.nodes, g.edges);
    const fit = fitTransform(s.bounds, size);
    const zoomed = zoomAt(fit, 12, 450, 300);
    const { ctx, calls } = recorder();
    const st = drawGraph(ctx, s, zoomed, size, fit.k, idle, style);
    expect(st.nodesDrawn).toBeGreaterThan(0);
    expect(st.nodesDrawn).toBeLessThan(300);
    expect(st.labelsDrawn).toBe(st.nodesDrawn);
    expect(calls.fillText).toHaveLength(st.labelsDrawn);
    expect(st.edgesDrawn).toBeLessThan(6000); // off-screen edges are culled
  });

  it("highlights the selection's edges and rings it", () => {
    const g = graph(400, 900);
    const s = buildScene(g.nodes, g.edges);
    const t = fitTransform(s.bounds, size);
    const sel = 7;
    const touching = Array.from(s.src).filter((a, e) => a === sel || s.dst[e] === sel).length;
    const { ctx, calls } = recorder();
    drawGraph(ctx, s, t, size, t.k, { selected: sel, hover: -1, moving: false }, style);
    expect(calls.strokeRect).toBe(1);
    expect(touching).toBeGreaterThan(0);
  });

  it("while dragging, skips the faint edges of a huge graph and draws them when it stops", () => {
    const g = graph(1500, 14000);
    const s = buildScene(g.nodes, g.edges);
    const t = fitTransform(s.bounds, size);
    const moving = recorder();
    const still = recorder();
    const a = drawGraph(moving.ctx, s, t, size, t.k, { ...idle, moving: true }, style);
    const b = drawGraph(still.ctx, s, t, size, t.k, idle, style);
    expect(a.edgesDrawn).toBe(0);
    expect(b.edgesDrawn).toBeGreaterThan(5000);
    expect(a.nodesDrawn).toBe(1500); // the nodes are always there
  });

  it("a graph the size of the large demo draws in well under a frame budget of CPU", () => {
    const g = graph(5000, 14000);
    const s = buildScene(g.nodes, g.edges);
    const t = fitTransform(s.bounds, size);
    const { ctx } = recorder();
    drawGraph(ctx, s, t, size, t.k, idle, style); // warm
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) drawGraph(ctx, s, t, size, t.k, idle, style);
    const per = (performance.now() - t0) / 10;
    // CPU cost of OUR loops only (the context here does nothing); the browser's rasteriser is extra.
    expect(per).toBeLessThan(25);
  });

  it("builds the scene for the large demo's size quickly", () => {
    const g = graph(5000, 14000);
    const t0 = performance.now();
    buildScene(g.nodes, g.edges);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

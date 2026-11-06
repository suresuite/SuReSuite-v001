import { describe, expect, it } from "vitest";
import { BASE_RADIUS, MAX_MARKERS, clusterAt, clusterPoints, type MapPoint } from "../mapClusters";

/** The loop MapView used before: every point against every cluster, in creation order. */
function reference(points: MapPoint<number>[], radius: number) {
  const clusters: { lon: number; lat: number; group: string; count: number; nodes: number[] }[] = [];
  for (const p of points) {
    const hit = clusters.find((c) => Math.sqrt((p.lon - c.lon) ** 2 + (p.lat - c.lat) ** 2) < radius && c.group === p.group);
    if (hit) { hit.nodes.push(p.ref); hit.count++; }
    else clusters.push({ lon: p.lon, lat: p.lat, group: p.group, count: 1, nodes: [p.ref] });
  }
  return clusters;
}

function rand(seed: number) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function points(n: number, spread: number, seed = 3): MapPoint<number>[] {
  const r = rand(seed);
  return Array.from({ length: n }, (_, i) => ({ lon: r() * spread, lat: r() * spread, group: r() < 0.8 ? "A" : "D", ref: i }));
}

describe("clusterAt", () => {
  it("gives exactly the clusters the old all-pairs loop gave", () => {
    for (const [n, spread, radius] of [[300, 1, 0.01], [800, 2, 0.05], [500, 0.5, 0.01], [1000, 30, 0.5]] as const) {
      const pts = points(n, spread);
      expect(clusterAt(pts, radius)).toEqual(reference(pts, radius));
    }
  });

  it("never joins two classes", () => {
    const out = clusterAt([
      { lon: 1, lat: 1, group: "A", ref: 0 }, { lon: 1, lat: 1, group: "D", ref: 1 },
    ], 0.01);
    expect(out).toHaveLength(2);
  });

  it("keeps every point in exactly one cluster", () => {
    const pts = points(2000, 5);
    const out = clusterAt(pts, 0.25);
    expect(out.reduce((s, c) => s + c.count, 0)).toBe(2000);
    expect(new Set(out.flatMap((c) => c.nodes)).size).toBe(2000);
  });
});

describe("clusterPoints", () => {
  it("clusters a small project at the base radius, as before", () => {
    const pts = points(40, 20);
    const { radius, clusters } = clusterPoints(pts);
    expect(radius).toBe(BASE_RADIUS);
    expect(clusters).toEqual(reference(pts, BASE_RADIUS));
  });

  it("widens the radius until the markers fit, losing no point", () => {
    const pts = points(3000, 40); // spread over 40° so the base radius leaves ~3000 clusters
    const { radius, clusters } = clusterPoints(pts);
    expect(radius).toBeGreaterThan(BASE_RADIUS);
    expect(clusters.length).toBeLessThanOrEqual(MAX_MARKERS);
    expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(3000);
  });

  it("clusters 3 000 points in well under a second (the old loop took far longer)", () => {
    const pts = points(3000, 40);
    const t0 = performance.now();
    clusterPoints(pts);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

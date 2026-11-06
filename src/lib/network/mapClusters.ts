// Merge map points that sit close together, so a map of thousands of suppliers draws a few
// hundred markers instead of thousands.
//
// The map draws one DOM marker (and one popup) per cluster, and moving a thousand DOM
// markers on every pan is what makes a big map stutter. Clustering is what the map has
// always done — points within `radius` degrees of an existing cluster of the SAME class
// join it, the first such cluster in creation order winning — but the old loop compared
// every point to every cluster (O(n × clusters), and it split a "lon,lat" string on every
// comparison). This finds the same cluster through a grid, in O(n), and widens the radius
// only when the markers would otherwise be too many: a small project clusters exactly as
// it did, at ~1 km.
export interface MapPoint<T> {
  lon: number;
  lat: number;
  group: string;
  ref: T;
}

export interface MapCluster<T> {
  /** The first member's position: where the marker is drawn, as before. */
  lon: number;
  lat: number;
  group: string;
  count: number;
  nodes: T[];
}

/** ~1 km — the radius the map has always used. */
export const BASE_RADIUS = 0.01;
/** Wider radii tried, in order, while there are still more clusters than `maxClusters`. */
export const WIDER_RADII = [0.05, 0.25, 0.5, 1, 2, 4, 8] as const;
export const MAX_MARKERS = 500;

export function clusterAt<T>(points: readonly MapPoint<T>[], radius: number): MapCluster<T>[] {
  const clusters: MapCluster<T>[] = [];
  const grid = new Map<string, number[]>(); // cell -> cluster indexes, creation order
  const cell = (v: number) => Math.floor(v / radius);
  for (const p of points) {
    const cx = cell(p.lon);
    const cy = cell(p.lat);
    let found = -1;
    // Any cluster within `radius` lies in this cell or one of its 8 neighbours. Of the matches
    // the OLDEST wins, which is what scanning the clusters in creation order did.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const idx of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const c = clusters[idx];
          if (c.group !== p.group) continue;
          if (Math.hypot(p.lon - c.lon, p.lat - c.lat) < radius && (found === -1 || idx < found)) found = idx;
        }
      }
    }
    if (found >= 0) {
      clusters[found].nodes.push(p.ref);
      clusters[found].count++;
    } else {
      clusters.push({ lon: p.lon, lat: p.lat, group: p.group, count: 1, nodes: [p.ref] });
      const key = `${cx},${cy}`;
      const list = grid.get(key);
      if (list) list.push(clusters.length - 1);
      else grid.set(key, [clusters.length - 1]);
    }
  }
  return clusters;
}

/** Cluster at the base radius; if that leaves more than `maxClusters`, widen until it does not. */
export function clusterPoints<T>(
  points: readonly MapPoint<T>[],
  maxClusters = MAX_MARKERS,
): { clusters: MapCluster<T>[]; radius: number } {
  let radius: number = BASE_RADIUS;
  let clusters = clusterAt(points, radius);
  for (const r of WIDER_RADII) {
    if (clusters.length <= maxClusters) break;
    radius = r;
    clusters = clusterAt(points, radius);
  }
  return { clusters, radius };
}

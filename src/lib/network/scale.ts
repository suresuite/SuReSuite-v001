// When a network lens is too big to draw the usual way.
//
// The three lenses draw every node and every edge as React Flow elements. That is the right
// picture for a supply chain of tens or a few hundred nodes, and the wrong cost and the wrong
// layout for thousands: an element per node and edge is slow, and the lenses' own layouts turn a
// class of a thousand into a thin ribbon. Above the thresholds below the whole network is drawn
// on a canvas (`canvasGraph.ts`) in a layout made for scale (`largeLayout.ts`): classes ordered
// so related nodes sit together, the drawing shaped like the card. One node can be FOCUSED,
// which hands back the lenses' own graph at a size it can be read at (that node's supply path),
// and a SUMMARY tab shows the same network as counts, breakdowns and a ranking.
//
// WHAT THIS MODULE IS. Pure functions over ids and counts, so the rules are testable
// without a renderer (the same shape as `lib/graph/lensLayout.ts`).
//
// WHAT IT DOES NOT DO — and says so. Nothing here is a network-science metric. Ranking is
// by CONNECTIONS (how many edges touch a node) or by the lens's own flow/revenue figure,
// both counted from the rows already on the page. Betweenness and closeness are not
// computed in the browser and are not available at this size (PLAN T2: a substitution is
// shown at the point of display) — `RANK_BASIS` is the one wording the overview uses.

/** The size at which a lens opens in the overview.
 *
 *  A JUDGMENT, NOT A MEASUREMENT. It is set above the largest real projects the app has seen
 *  (a 640-node, 2 300-edge supply chain and a ~780-row BOM tree), so none of them changes, and
 *  well below the large demo (~3 000 nodes, ~8 000 edges), where one graph is unreadable. Where
 *  React Flow actually starts to struggle has not been measured in a browser; if it does so
 *  sooner, lower these. */
export const LARGE_GRAPH = { nodes: 1000, edges: 3000 } as const;

export function isLargeGraph(nodeCount: number, edgeCount: number): boolean {
  return nodeCount > LARGE_GRAPH.nodes || edgeCount > LARGE_GRAPH.edges;
}

/** The one sentence about what the ranking means (T2: say what stands in for what). */
export const RANK_BASIS =
  'Ranked by connections (edges touching a node) or by the flow figure the page already shows. ' +
  'Betweenness and closeness are not computed at this size.';

export interface OverviewNode {
  id: string;
  label: string;
  group: string;
  /** Edges touching the node, either direction. */
  degree: number;
  /** The lens's own figure for the node (flow, revenue), or null when it has none. */
  weight: number | null;
  /** A second way to group (country, tier), or null. */
  secondary: string | null;
}

export interface OverviewEdge {
  source: string;
  target: string;
}

export interface NodeAccessors<N> {
  id: (n: N) => string;
  label: (n: N) => string;
  group: (n: N) => string | undefined | null;
  weight?: (n: N) => number | null | undefined;
  secondary?: (n: N) => string | null | undefined;
}

/** Edges touching each node. An edge naming a node that is not in the set is ignored. */
export function degrees(ids: Iterable<string>, edges: readonly OverviewEdge[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const id of ids) d.set(id, 0);
  for (const e of edges) {
    if (d.has(e.source)) d.set(e.source, d.get(e.source)! + 1);
    if (d.has(e.target)) d.set(e.target, d.get(e.target)! + 1);
  }
  return d;
}

export function buildOverviewNodes<N>(
  nodes: readonly N[],
  edges: readonly OverviewEdge[],
  a: NodeAccessors<N>,
): OverviewNode[] {
  const deg = degrees(nodes.map(a.id), edges);
  return nodes.map((n) => {
    const id = a.id(n);
    const w = a.weight?.(n);
    return {
      id,
      label: a.label(n) || id,
      group: a.group(n) ?? '',
      degree: deg.get(id) ?? 0,
      weight: typeof w === 'number' && Number.isFinite(w) ? w : null,
      secondary: a.secondary?.(n) ?? null,
    };
  });
}

export type RankBy = 'degree' | 'weight';

/** Nodes of one group (or all) matching a search, highest first; ties break on the label so the
 *  order is stable. A node with no weight sorts last when ranking by weight. */
export function rankNodes(
  nodes: readonly OverviewNode[],
  opts: { group?: string | null; query?: string; by: RankBy },
): OverviewNode[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const out = nodes.filter(
    (n) =>
      (!opts.group || n.group === opts.group) &&
      (!q || n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)),
  );
  const key = (n: OverviewNode) => (opts.by === 'weight' ? n.weight ?? Number.NEGATIVE_INFINITY : n.degree);
  return out.sort((a, b) => key(b) - key(a) || a.label.localeCompare(b.label));
}

export interface CountRow {
  key: string;
  count: number;
}

/** Counts per key, largest first; everything past `top` is folded into one "Other" row. Nodes with
 *  no key are counted under `unknownLabel`, never dropped: a total that does not add up is a lie. */
export function breakdown(
  nodes: readonly OverviewNode[],
  keyOf: (n: OverviewNode) => string | null | undefined,
  top = 10,
  unknownLabel = 'Unknown',
): CountRow[] {
  const m = new Map<string, number>();
  for (const n of nodes) {
    const k = keyOf(n) || unknownLabel;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const rows = [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (rows.length <= top) return rows;
  const head = rows.slice(0, top);
  const rest = rows.slice(top).reduce((s, r) => s + r.count, 0);
  return [...head, { key: `Other (${rows.length - top})`, count: rest }];
}

export const DEGREE_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '0', min: 0, max: 0 },
  { label: '1', min: 1, max: 1 },
  { label: '2', min: 2, max: 2 },
  { label: '3–5', min: 3, max: 5 },
  { label: '6–10', min: 6, max: 10 },
  { label: '11–25', min: 11, max: 25 },
  { label: '26+', min: 26, max: Number.POSITIVE_INFINITY },
];

/** How many nodes have 0, 1, 2, 3–5 … connections. Every node lands in exactly one bucket. */
export function degreeHistogram(nodes: readonly OverviewNode[]): CountRow[] {
  return DEGREE_BUCKETS.map((b) => ({
    key: b.label,
    count: nodes.filter((n) => n.degree >= b.min && n.degree <= b.max).length,
  }));
}

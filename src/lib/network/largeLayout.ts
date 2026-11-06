// Layouts for networks too big for the lenses' own.
//
// The Product and Process lenses lay a class out in columns of ~20 rows, so a class of a
// thousand suppliers runs 50 sub-columns wide and the whole graph becomes a thin ribbon whose
// edges collapse into grey blocks; the Firm lens places thousands of firms on rings in whatever
// order they came back in. Both are fine at a few hundred nodes and unreadable at thousands.
// What makes a big network readable is not more pixels but ORDER and SHAPE:
//
//   · related nodes sit next to each other — a layer is ordered by where its neighbours are
//     (the barycenter heuristic of layered graph drawing), so most edges run short and parallel
//     instead of crossing the whole picture;
//   · the drawing is shaped like the card it is in, not like the longest class.
//
// COLUMNS (Product, Process): the lens's classes in flow order, left to right. Each column is a
// block of rows × sub-columns; a node's ROW follows its rank in the ordering, so a node and its
// neighbours are at about the same height in every column and their edges run nearly level.
//
// RINGS (Firm): the plant at the centre, each tier on a ring. A tier is ordered by the angle of
// its buyers on the ring inside it and then spread evenly, so a firm sits next to the firms it
// supplies and the rings read as branches.
//
// PURE. Arrays in, arrays out; positions are in world units (one `pitch` between neighbours).
// Nothing here changes what the network says — it only chooses where each node is drawn.

export interface LayoutEdge {
  source: number;
  target: number;
}

export interface Placement {
  x: Float32Array;
  y: Float32Array;
  /** The size to draw a node at, in world units. */
  w: number;
  h: number;
}

export interface ColumnOptions {
  /** Width ÷ height the drawing should have (the card's). */
  aspect: number;
  /** World units between neighbouring nodes. */
  pitch?: number;
  /** Empty sub-columns between two classes. */
  gap?: number;
  /** Ordering sweeps (down, up, down, …). */
  sweeps?: number;
}

/** Neighbour lists from edges, both directions. */
function adjacency(n: number, edges: readonly LayoutEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.source === e.target) continue;
    adj[e.source].push(e.target);
    adj[e.target].push(e.source);
  }
  return adj;
}

/**
 * Order each layer by the mean rank of its neighbours, sweeping down and up the layers.
 * `rank` is a node's position in its layer, normalised to 0..1, so it compares across layers of
 * different size. A node with no neighbour keeps its place. Returns the order of each layer.
 */
export function orderLayers(
  layerOf: ArrayLike<number>,
  layerCount: number,
  edges: readonly LayoutEdge[],
  sweeps = 4,
  tieBreak?: ArrayLike<number>,
): number[][] {
  const n = layerOf.length;
  const adj = adjacency(n, edges);
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (let i = 0; i < n; i++) layers[layerOf[i]]?.push(i);
  if (tieBreak) for (const l of layers) l.sort((a, b) => tieBreak[a] - tieBreak[b] || a - b);

  const rank = new Float64Array(n);
  const refresh = (l: number) => {
    const L = layers[l];
    for (let k = 0; k < L.length; k++) rank[L[k]] = L.length > 1 ? k / (L.length - 1) : 0.5;
  };
  for (let l = 0; l < layerCount; l++) refresh(l);

  const sweep = (l: number) => {
    const L = layers[l];
    const key = new Float64Array(L.length);
    for (let k = 0; k < L.length; k++) {
      const v = L[k];
      let sum = 0;
      let c = 0;
      for (const u of adj[v]) {
        if (layerOf[u] === l) continue;
        sum += rank[u];
        c++;
      }
      key[k] = c ? sum / c : rank[v];
    }
    const idx = Array.from({ length: L.length }, (_, k) => k);
    idx.sort((a, b) => key[a] - key[b] || a - b);
    const next = idx.map((k) => L[k]);
    layers[l] = next;
    refresh(l);
  };

  for (let s = 0; s < sweeps; s++) {
    if (s % 2 === 0) for (let l = 1; l < layerCount; l++) sweep(l);
    else for (let l = layerCount - 2; l >= 0; l--) sweep(l);
  }
  return layers;
}

/** Sum over edges of the height difference between its ends, in rows, for a given set of layer orders. */
export function edgeSpan(layers: number[][], edges: readonly LayoutEdge[], n: number): number {
  const rank = new Float64Array(n);
  for (const L of layers) for (let k = 0; k < L.length; k++) rank[L[k]] = L.length > 1 ? k / (L.length - 1) : 0.5;
  let total = 0;
  for (const e of edges) total += Math.abs(rank[e.source] - rank[e.target]);
  return total;
}

export function columnLayout(
  layerOf: ArrayLike<number>,
  layerCount: number,
  edges: readonly LayoutEdge[],
  opts: ColumnOptions,
  tieBreak?: ArrayLike<number>,
): Placement {
  const pitch = opts.pitch ?? 14;
  const gap = opts.gap ?? 3;
  const n = layerOf.length;
  const layers = orderLayers(layerOf, layerCount, edges, opts.sweeps ?? 4, tieBreak);
  const sizes = layers.map((l) => l.length);

  // Choose the number of rows so the whole drawing is as wide as the card is: width is the
  // sub-columns each class needs at that height, plus the gaps; height is the rows.
  const widthFor = (r: number) =>
    sizes.reduce((s, c) => s + (c > 0 ? Math.ceil(c / r) : 0), 0) + gap * Math.max(0, sizes.filter((c) => c > 0).length - 1);
  const maxRows = Math.max(1, ...sizes);
  let best = Math.min(maxRows, 8);
  let bestErr = Infinity;
  for (let r = Math.min(maxRows, 6); r <= maxRows; r++) {
    const err = Math.abs(Math.log((widthFor(r) / r) / opts.aspect));
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  const rows = best;

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  let x0 = 0;
  for (const L of layers) {
    if (L.length === 0) continue;
    const subCols = Math.ceil(L.length / rows);
    // rows are filled by rank: rank k goes to row floor(k * rows / L.length), and the nodes that
    // share a row sit side by side, so a node's height follows its rank in every column
    const seen = new Int32Array(rows);
    for (let k = 0; k < L.length; k++) {
      const row = Math.min(rows - 1, Math.floor((k * rows) / L.length));
      const col = seen[row]++;
      x[L[k]] = (x0 + col) * pitch;
      y[L[k]] = row * pitch;
    }
    x0 += subCols + gap;
  }
  return { x, y, w: pitch * 0.72, h: pitch * 0.5 };
}

export interface RingOptions {
  pitch?: number;
  /** Spacing between a ring and the one inside it, in pitches, at least (default 20). */
  gap?: number;
  sweeps?: number;
}

/**
 * Rings: layer 0 at the centre, layer l on ring l. A ring's nodes are ordered by the mean angle of
 * their neighbours on the next ring in (a circular mean, so 359° and 1° average to 0°), then spread
 * evenly around the ring in that order. `tieBreak` orders the first ring. After one pass outward,
 * `sweeps` rounds go inward and outward again, each ring now also looking at the ring outside it,
 * so a firm sits between the firms it buys from AND the firms that buy from it. A node with no
 * neighbour on the side being looked at keeps the angle it had.
 */
export function ringLayout(
  layerOf: ArrayLike<number>,
  layerCount: number,
  edges: readonly LayoutEdge[],
  opts: RingOptions = {},
  tieBreak?: ArrayLike<number>,
): Placement {
  const pitch = opts.pitch ?? 14;
  const gapR = (opts.gap ?? 20) * pitch;
  const sweeps = opts.sweeps ?? 2;
  const n = layerOf.length;
  const adj = adjacency(n, edges);
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (let i = 0; i < n; i++) layers[layerOf[i]]?.push(i);
  if (tieBreak) for (const l of layers) l.sort((a, b) => tieBreak[a] - tieBreak[b] || a - b);

  const angle = new Float64Array(n);
  const spread = (l: number) => {
    const L = layers[l];
    L.forEach((v, k) => {
      angle[v] = (2 * Math.PI * k) / L.length;
    });
  };
  /** Reorder ring l by the circular mean angle of its neighbours on `side` (-1 inside, +1 outside). */
  const reorder = (l: number, side: -1 | 1) => {
    const L = layers[l];
    const key = new Float64Array(L.length);
    for (let k = 0; k < L.length; k++) {
      let sx = 0, sy = 0, c = 0;
      for (const u of adj[L[k]]) {
        if (side < 0 ? layerOf[u] >= l : layerOf[u] <= l) continue;
        sx += Math.cos(angle[u]);
        sy += Math.sin(angle[u]);
        c++;
      }
      key[k] = c && (sx !== 0 || sy !== 0) ? (Math.atan2(sy, sx) + 2 * Math.PI) % (2 * Math.PI) : angle[L[k]];
    }
    const order = Array.from({ length: L.length }, (_, k) => k);
    order.sort((a, b) => key[a] - key[b] || a - b);
    layers[l] = order.map((k) => L[k]);
    spread(l);
  };

  for (let l = 0; l < layerCount; l++) if (layers[l].length) spread(l);
  for (let l = 2; l < layerCount; l++) if (layers[l].length) reorder(l, -1);
  for (let s = 0; s < sweeps; s++) {
    for (let l = layerCount - 2; l >= 1; l--) if (layers[l].length) reorder(l, 1);
    for (let l = 2; l < layerCount; l++) if (layers[l].length) reorder(l, -1);
  }

  const radius = new Float64Array(layerCount);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let l = 0; l < layerCount; l++) {
    const L = layers[l];
    if (L.length === 0) {
      radius[l] = l === 0 ? 0 : radius[l - 1];
      continue;
    }
    radius[l] =
      l === 0
        ? L.length === 1 ? 0 : (L.length * pitch) / (2 * Math.PI)
        : Math.max(radius[l - 1] + gapR, (L.length * pitch) / (2 * Math.PI));
    for (const v of L) {
      x[v] = Math.cos(angle[v]) * radius[l];
      y[v] = Math.sin(angle[v]) * radius[l];
    }
  }
  return { x, y, w: pitch * 0.62, h: pitch * 0.62 };
}

/**
 * Re-place the OUTER layers of a layout as even bands around the rest of it.
 *
 * A lens that seats each outer node next to its parent (the Firm lens's tier 3) gets clusters
 * that bunch up around a few parents and leave the rim empty between them. This keeps every other
 * node where the lens put it and spreads the chosen layers around a band outside everything
 * placed so far: nodes ordered by the mean angle of their neighbours already placed (so a node
 * stays on the side of the firms it is linked to), then spaced evenly around the band, on as many
 * staggered sub-rings as the circumference needs. Mutates `x` and `y`.
 */
export function spreadOuterBand(
  x: Float32Array,
  y: Float32Array,
  w: Float32Array,
  layer: ArrayLike<number>,
  edges: readonly LayoutEdge[],
  spreadLayers: readonly number[],
): void {
  const n = x.length;
  const spreadSet = new Set(spreadLayers);
  const inner: number[] = [];
  for (let i = 0; i < n; i++) if (!spreadSet.has(layer[i])) inner.push(i);
  if (inner.length === 0) return;

  // the centre: the innermost layer's mean (the plant), else everything's
  const minLayer = Math.min(...inner.map((i) => layer[i]));
  const core = inner.filter((i) => layer[i] === minLayer);
  const cx = core.reduce((s, i) => s + x[i], 0) / core.length;
  const cy = core.reduce((s, i) => s + y[i], 0) / core.length;
  let reach = 0;
  for (const i of inner) reach = Math.max(reach, Math.hypot(x[i] - cx, y[i] - cy) + w[i] / 2);

  const adj = adjacency(n, edges);
  const placed = new Uint8Array(n);
  for (const i of inner) placed[i] = 1;

  for (const l of [...spreadLayers].sort((a, b) => a - b)) {
    const L: number[] = [];
    for (let i = 0; i < n; i++) if (layer[i] === l) L.push(i);
    if (L.length === 0) continue;
    const sizes = L.map((i) => w[i]).sort((a, b) => a - b);
    const s = Math.max(8, sizes[Math.floor(sizes.length / 2)] ?? 8);
    const slot = s * 1.3; // room one node takes along a ring
    const key = L.map((i) => {
      let sx = 0, sy = 0, c = 0;
      for (const u of adj[i]) {
        if (!placed[u]) continue;
        const a = Math.atan2(y[u] - cy, x[u] - cx);
        sx += Math.cos(a);
        sy += Math.sin(a);
        c++;
      }
      const a = c && (sx !== 0 || sy !== 0) ? Math.atan2(sy, sx) : Math.atan2(y[i] - cy, x[i] - cx);
      // 0..2π, the same range the nodes are placed in below, so a node ends up where its key says
      return (a + 2 * Math.PI) % (2 * Math.PI);
    });
    const order = L.map((_, k) => k).sort((a, b) => key[a] - key[b] || a - b);

    const R0 = reach + s * 2.5;
    // as many sub-rings as it takes to hold every node at `slot` spacing
    let rings = 1;
    const capacity = (m: number) => {
      let c = 0;
      for (let j = 0; j < m; j++) c += Math.floor((2 * Math.PI * (R0 + j * s * 1.5)) / slot);
      return c;
    };
    while (capacity(rings) < L.length) rings++;
    const counts = Array.from({ length: rings }, (_, j) => Math.floor(L.length / rings) + (j < L.length % rings ? 1 : 0));
    const next = new Array<number>(rings).fill(0);
    order.forEach((k, rank) => {
      const j = rank % rings;
      const pos = next[j]++;
      // staggered across sub-rings, so neighbours on adjacent rings do not line up
      const a = (2 * Math.PI * (pos + (0.5 * j) / rings)) / counts[j];
      const r = R0 + j * s * 1.5;
      x[L[k]] = cx + Math.cos(a) * r;
      y[L[k]] = cy + Math.sin(a) * r;
      placed[L[k]] = 1;
    });
    reach = R0 + (rings - 1) * s * 1.5 + s;
  }
}

export type LayoutKind = 'page' | 'columns' | 'rings';

export interface PlaceInput {
  /** The page's own centre and size for the node, in world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index of the node's class or tier, in flow order (unused for `page`). */
  layer: number;
  /** Orders the first ring (Firm: country); unused for `columns` and `page`. */
  tie: number;
}

export interface Placed {
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
}

/**
 * Where each node of a big network is drawn.
 *
 *   page      the lens's own layout — positions AND sizes — and the one a person already knows (the
 *             Firm lens's prominence-ordered rings). `spreadLayers` names outer layers to re-place as
 *             even bands around it (`spreadOuterBand`); everything else stays exactly where it is.
 *   columns   `columnLayout`: for the flow lenses, whose own columns become a thin ribbon.
 *   rings     `ringLayout`.
 */
export function placeNodes(
  kind: LayoutKind,
  nodes: readonly PlaceInput[],
  layerCount: number,
  edges: readonly LayoutEdge[],
  aspect: number,
  spreadLayers: readonly number[] = [],
): Placed {
  const n = nodes.length;
  if (kind === 'page') {
    const placed = {
      x: Float32Array.from(nodes, (v) => v.x),
      y: Float32Array.from(nodes, (v) => v.y),
      w: Float32Array.from(nodes, (v) => v.w),
      h: Float32Array.from(nodes, (v) => v.h),
    };
    // `layer` is only read for the layers to spread; the rest of the page's layout is left alone
    if (spreadLayers.length) {
      spreadOuterBand(placed.x, placed.y, placed.w, Int32Array.from(nodes, (v) => v.layer), edges, spreadLayers);
    }
    return placed;
  }
  const layerOf = Int32Array.from(nodes, (v) => Math.min(layerCount - 1, Math.max(0, v.layer)));
  const tie = Float64Array.from(nodes, (v) => v.tie);
  const p = kind === 'rings' ? ringLayout(layerOf, layerCount, edges, {}, tie) : columnLayout(layerOf, layerCount, edges, { aspect }, tie);
  return { x: p.x, y: p.y, w: new Float32Array(n).fill(p.w), h: new Float32Array(n).fill(p.h) };
}


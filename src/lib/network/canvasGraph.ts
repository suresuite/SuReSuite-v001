// The network drawn on a canvas, for graphs too big for one DOM element per node.
//
// React Flow draws every node and every edge as an element, which is the right picture for a
// supply chain of tens or hundreds and the wrong cost for thousands. This is the same picture
// — the lens's own layout, its class colours, its edges — painted as pixels: thousands of nodes
// and edges are a few batched paths per frame, and what the eye cannot use at the current zoom
// (labels, a hairline's flow width) is simply not drawn.
//
// PURE ON PURPOSE. Everything here is arithmetic over typed arrays and one function that draws
// onto whatever 2D context it is handed, so the rules — what is culled, when labels appear, what
// a click hits — are tested without a browser (`canvasGraph.test.ts` draws onto a recording
// context). `LargeGraphCanvas.tsx` owns the element, the pointer and the animation frame.
//
// NOT CLAIMED. Nothing here is a layout: positions come from the page, as they do for React Flow.
// It draws what it is given and says nothing about the network that the page does not.

export interface Transform {
  /** Scale: screen px per world unit. */
  k: number;
  /** Translation: screen = world * k + (x, y). */
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SceneNodeInput {
  id: string;
  /** Centre, in world units. */
  x: number;
  y: number;
  /** Full size, in world units. */
  w: number;
  h: number;
  label: string;
  /** Index into the scene's palette. */
  color: number;
}
export interface SceneEdgeInput {
  source: string;
  target: string;
  /** The page's own width for this edge (flow-weighted); 1 when it has none. */
  width?: number;
}

export interface Scene {
  n: number;
  ids: string[];
  labels: string[];
  xs: Float32Array;
  ys: Float32Array;
  hw: Float32Array;
  hh: Float32Array;
  color: Uint8Array;
  indexOf: Map<string, number>;
  m: number;
  src: Int32Array;
  dst: Int32Array;
  /** 0 hairline, 1 medium, 2 heavy — three batches rather than a stroke per edge. */
  wclass: Uint8Array;
  grid: SpatialGrid;
  bounds: Bounds;
}

export interface SpatialGrid {
  cell: number;
  cells: Map<number, number[]>;
}

const KEY = 100_003;
const cellKey = (cx: number, cy: number) => cx * KEY + cy;

export function buildGrid(xs: ArrayLike<number>, ys: ArrayLike<number>, cell: number): SpatialGrid {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < xs.length; i++) {
    const k = cellKey(Math.floor(xs[i] / cell), Math.floor(ys[i] / cell));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  return { cell, cells };
}

/** The node whose centre is nearest (wx, wy) within `maxDist` world units, or -1. Ties go to the
 *  lower index, so the answer does not depend on iteration order. */
export function nearestNode(
  scene: Pick<Scene, 'xs' | 'ys' | 'grid'>,
  wx: number,
  wy: number,
  maxDist: number,
): number {
  const { grid, xs, ys } = scene;
  const r = Math.max(1, Math.ceil(maxDist / grid.cell));
  const cx = Math.floor(wx / grid.cell);
  const cy = Math.floor(wy / grid.cell);
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const list = grid.cells.get(cellKey(cx + dx, cy + dy));
      if (!list) continue;
      for (const i of list) {
        const d = (xs[i] - wx) ** 2 + (ys[i] - wy) ** 2;
        if (d < bestD || (d === bestD && best !== -1 && i < best)) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/** Build the typed-array scene. An edge naming a node that is not there is dropped (and not counted). */
export function buildScene(nodes: readonly SceneNodeInput[], edges: readonly SceneEdgeInput[]): Scene {
  const n = nodes.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const hw = new Float32Array(n);
  const hh = new Float32Array(n);
  const color = new Uint8Array(n);
  const ids: string[] = new Array(n);
  const labels: string[] = new Array(n);
  const indexOf = new Map<string, number>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = nodes[i];
    xs[i] = v.x;
    ys[i] = v.y;
    hw[i] = v.w / 2;
    hh[i] = v.h / 2;
    color[i] = v.color;
    ids[i] = v.id;
    labels[i] = v.label;
    indexOf.set(v.id, i);
    minX = Math.min(minX, v.x - v.w / 2);
    minY = Math.min(minY, v.y - v.h / 2);
    maxX = Math.max(maxX, v.x + v.w / 2);
    maxY = Math.max(maxY, v.y + v.h / 2);
  }
  if (n === 0) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  const src: number[] = [];
  const dst: number[] = [];
  const wc: number[] = [];
  for (const e of edges) {
    const a = indexOf.get(e.source);
    const b = indexOf.get(e.target);
    if (a === undefined || b === undefined) continue;
    src.push(a);
    dst.push(b);
    const w = e.width ?? 1;
    wc.push(w > 3 ? 2 : w > 1.5 ? 1 : 0);
  }
  // A cell about the size of a typical node keeps a hit test to a handful of candidates.
  const sizes = Array.from(hw).sort((a, b) => a - b);
  const typical = Math.max(4, (sizes[Math.floor(sizes.length / 2)] ?? 8) * 4);
  return {
    n, ids, labels, xs, ys, hw, hh, color, indexOf,
    m: src.length,
    src: Int32Array.from(src),
    dst: Int32Array.from(dst),
    wclass: Uint8Array.from(wc),
    grid: buildGrid(xs, ys, typical),
    bounds: { minX, minY, maxX, maxY },
  };
}

// ── the view ────────────────────────────────────────────────────────────────

export const ZOOM = { min: 0.02, max: 24 } as const;

export function fitTransform(b: Bounds, size: Size, padding = 0.06): Transform {
  const bw = Math.max(1e-6, b.maxX - b.minX);
  const bh = Math.max(1e-6, b.maxY - b.minY);
  const k = Math.min((size.width * (1 - 2 * padding)) / bw, (size.height * (1 - 2 * padding)) / bh);
  const kk = Math.min(ZOOM.max, Math.max(ZOOM.min, k));
  return {
    k: kk,
    x: size.width / 2 - ((b.minX + b.maxX) / 2) * kk,
    y: size.height / 2 - ((b.minY + b.maxY) / 2) * kk,
  };
}

export const screenToWorld = (t: Transform, sx: number, sy: number) => ({ x: (sx - t.x) / t.k, y: (sy - t.y) / t.k });
export const worldToScreen = (t: Transform, wx: number, wy: number) => ({ x: wx * t.k + t.x, y: wy * t.k + t.y });

/** Zoom by `factor` keeping the world point under (cx, cy) where it is. Clamped to `limits`. */
export function zoomAt(
  t: Transform,
  factor: number,
  cx: number,
  cy: number,
  limits: { min: number; max: number } = ZOOM,
): Transform {
  const k = Math.min(limits.max, Math.max(limits.min, t.k * factor));
  const f = k / t.k;
  return { k, x: cx - (cx - t.x) * f, y: cy - (cy - t.y) * f };
}

export const panBy = (t: Transform, dx: number, dy: number): Transform => ({ ...t, x: t.x + dx, y: t.y + dy });

/** The transform that centres world point (wx, wy) at zoom `k`. */
export function centerOn(size: Size, wx: number, wy: number, k: number): Transform {
  return { k, x: size.width / 2 - wx * k, y: size.height / 2 - wy * k };
}

// ── what is drawn at a zoom ─────────────────────────────────────────────────

export interface Lod {
  /** Labels appear only when there is room for them and few enough to read. */
  labels: boolean;
  edgeAlpha: number;
  /** Smallest drawn node, in px: a node smaller than this is still a visible dot. */
  minNodePx: number;
}

/** `fitK` is the zoom at which the whole graph fits; `relative` zoom is k / fitK. */
export function lodFor(k: number, fitK: number, visibleNodes: number, edgeCount: number): Lod {
  const relative = fitK > 0 ? k / fitK : 1;
  const base = edgeCount > 10_000 ? 0.16 : edgeCount > 4_000 ? 0.26 : edgeCount > 1_000 ? 0.4 : 0.6;
  // zoomed in, fewer edges are in view and each can be stronger
  const alpha = Math.min(0.85, base * Math.max(1, Math.sqrt(relative)));
  return {
    labels: visibleNodes <= 350 && relative >= 2.2,
    edgeAlpha: alpha,
    minNodePx: 2.5,
  };
}

// ── drawing ─────────────────────────────────────────────────────────────────

export interface DrawStyle {
  palette: string[];
  edge: string;
  edgeHighlight: string;
  ring: string;
  text: string;
  shape: 'rect' | 'circle';
  background: string;
}

export interface DrawState {
  selected: number;
  hover: number;
  /** While the person is dragging or zooming, skip the work that does not change what they see. */
  moving: boolean;
}

export interface DrawStats {
  nodesDrawn: number;
  edgesDrawn: number;
  labelsDrawn: number;
}

/** The subset of CanvasRenderingContext2D this needs, so tests can hand it a recorder. */
export interface Ctx2D {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a: number, b: number): void;
  fill(): void;
  stroke(): void;
  fillText(t: string, x: number, y: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

const WIDTHS = [1, 1.8, 3] as const;
/** Past this many edges, dragging does not redraw the faint ones — they are redrawn when it stops. */
const MOVING_EDGE_BUDGET = 12_000;

export function drawGraph(
  ctx: Ctx2D,
  scene: Scene,
  t: Transform,
  size: Size,
  fitK: number,
  state: DrawState,
  style: DrawStyle,
): DrawStats {
  const { n, m, xs, ys, hw, hh, color, src, dst, wclass } = scene;
  const W = size.width;
  const H = size.height;
  const stats: DrawStats = { nodesDrawn: 0, edgesDrawn: 0, labelsDrawn: 0 };

  ctx.globalAlpha = 1;
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, W, H);

  // Which nodes are on screen (a little margin so a node half in view still draws).
  const margin = 12;
  const onScreen = new Uint8Array(n);
  let visible = 0;
  for (let i = 0; i < n; i++) {
    const sx = xs[i] * t.k + t.x;
    const sy = ys[i] * t.k + t.y;
    if (sx >= -margin && sx <= W + margin && sy >= -margin && sy <= H + margin) {
      onScreen[i] = 1;
      visible++;
    }
  }
  const lod = lodFor(t.k, fitK, visible, m);

  // Edges touching the selection are the ones that stay legible.
  const sel = state.selected;
  const selectedEdge = new Uint8Array(m);
  if (sel >= 0) {
    for (let e = 0; e < m; e++) if (src[e] === sel || dst[e] === sel) selectedEdge[e] = 1;
  }

  // 1 · edges, one path per width class
  const drawFaint = !(state.moving && m > MOVING_EDGE_BUDGET);
  if (drawFaint) {
    ctx.strokeStyle = style.edge;
    ctx.globalAlpha = sel >= 0 ? lod.edgeAlpha * 0.45 : lod.edgeAlpha;
    for (let cls = 0; cls < 3; cls++) {
      ctx.lineWidth = WIDTHS[cls];
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < m; e++) {
        if (wclass[e] !== cls || selectedEdge[e]) continue;
        const a = src[e];
        const b = dst[e];
        // both ends off the same side of the screen: nothing of the edge can be seen
        const ax = xs[a] * t.k + t.x, ay = ys[a] * t.k + t.y;
        const bx = xs[b] * t.k + t.x, by = ys[b] * t.k + t.y;
        if ((ax < 0 && bx < 0) || (ax > W && bx > W) || (ay < 0 && by < 0) || (ay > H && by > H)) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        stats.edgesDrawn++;
        any = true;
      }
      if (any) ctx.stroke();
    }
  }
  if (sel >= 0) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = style.edgeHighlight;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let e = 0; e < m; e++) {
      if (!selectedEdge[e]) continue;
      ctx.moveTo(xs[src[e]] * t.k + t.x, ys[src[e]] * t.k + t.y);
      ctx.lineTo(xs[dst[e]] * t.k + t.x, ys[dst[e]] * t.k + t.y);
      stats.edgesDrawn++;
    }
    ctx.stroke();
  }

  // 2 · nodes, one fill per colour
  ctx.globalAlpha = 1;
  for (let c = 0; c < style.palette.length; c++) {
    ctx.fillStyle = style.palette[c];
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!onScreen[i] || color[i] !== c) continue;
      const sx = xs[i] * t.k + t.x;
      const sy = ys[i] * t.k + t.y;
      const w = Math.max(lod.minNodePx, hw[i] * 2 * t.k);
      const h = Math.max(lod.minNodePx, hh[i] * 2 * t.k);
      if (style.shape === 'circle') {
        ctx.moveTo(sx + Math.min(w, h) / 2, sy);
        ctx.arc(sx, sy, Math.min(w, h) / 2, 0, Math.PI * 2);
      } else {
        ctx.fillRect(sx - w / 2, sy - h / 2, w, h);
      }
      stats.nodesDrawn++;
      any = true;
    }
    if (any && style.shape === 'circle') ctx.fill();
  }

  // 3 · the ring on the selected and the hovered node
  for (const [i, wdt] of [[state.hover, 1.5], [sel, 2.5]] as const) {
    if (i < 0 || i >= n) continue;
    const sx = xs[i] * t.k + t.x;
    const sy = ys[i] * t.k + t.y;
    const w = Math.max(lod.minNodePx + 2, hw[i] * 2 * t.k) + 3;
    const h = Math.max(lod.minNodePx + 2, hh[i] * 2 * t.k) + 3;
    ctx.strokeStyle = style.ring;
    ctx.lineWidth = wdt;
    ctx.globalAlpha = 1;
    if (style.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(sx, sy, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(sx - w / 2, sy - h / 2, w, h);
    }
  }

  // 4 · labels, only where there is room and few enough to read
  if (lod.labels) {
    ctx.fillStyle = style.text;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      if (!onScreen[i]) continue;
      ctx.fillText(
        scene.labels[i],
        xs[i] * t.k + t.x,
        ys[i] * t.k + t.y + Math.max(lod.minNodePx, hh[i] * t.k) + 2,
      );
      stats.labelsDrawn++;
    }
  }
  return stats;
}

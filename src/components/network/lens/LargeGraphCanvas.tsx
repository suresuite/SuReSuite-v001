/**
 * The network lens's graph, drawn on a canvas — for graphs too big for one element per node.
 *
 * It paints what the page already laid out (columns for Product and Process, rings for Firm):
 * same positions, same class colours, same edges. What differs is the cost. React Flow makes a
 * DOM node and an SVG path for everything; here the whole graph is a few batched canvas paths per
 * frame, labels appear only when there is room for them, and a click or hover is answered from a
 * spatial grid instead of the DOM. The rules for what is drawn when are in
 * `lib/network/canvasGraph.ts`, where they are tested without a browser; this file owns the
 * element, the pointer and the animation frame.
 *
 *   drag          pan                         wheel / pinch   zoom about the pointer
 *   click         select (the page's panel)   double-click    focus the node's supply path
 *
 * Presentational: the page owns selection and focus.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { GRAPH_INK } from '@/lib/graph';
import { placeNodes, type LayoutEdge, type LayoutKind } from '@/lib/network/largeLayout';
import {
  buildScene,
  centerOn,
  drawGraph,
  fitTransform,
  nearestNode,
  panBy,
  screenToWorld,
  zoomAt,
  type DrawStyle,
  type Scene,
  type Size,
  type Transform,
} from '@/lib/network/canvasGraph';
import { cn } from '@/lib/utils';
import { LENS } from './tokens';

export type LargeLayout =
  | {
      kind: Extract<LayoutKind, 'page'>;
      /** Outer layers to re-place around the page's layout, as a band or a fringe (Firm: tier 3). */
      spread?: { layerOf: (n: Node) => number; layers: number[]; irregularity?: number; style?: 'band' | 'fringe' };
    }
  | { kind: Exclude<LayoutKind, 'page'>; layerOf: (n: Node) => number; layerCount: number; tieKey?: (n: Node) => string };

export interface LargeGraphCanvasHandle {
  fit: () => void;
  centerOn: (id: string) => void;
  zoomBy: (factor: number) => void;
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  /** Index into `palette` for a node's colour. */
  colorOf: (n: Node) => number;
  palette: string[];
  shape: 'rect' | 'circle';
  /** How to place a big network: the page's own layout, or the large-network columns / rings. */
  layout: LargeLayout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFocus: (id: string) => void;
  /** Zoom relative to the fit, so the card can show "100%" at the whole graph. */
  onZoom?: (relative: number) => void;
}

const numeric = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const LargeGraphCanvas = forwardRef<LargeGraphCanvasHandle, Props>(function LargeGraphCanvas(
  { nodes, edges, colorOf, palette, shape, layout, selectedId, onSelect, onFocus, onZoom },
  ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; label: string } | null>(null);
  // the drawing is shaped like the card, so the card's shape is an input to the layout
  const [aspect, setAspect] = useState(1.7);

  // The scene is rebuilt when the node or edge SET (or the card's shape) changes, not on every render.
  // `page` draws the lens's own layout as it is; `columns` and `rings` are the large-network layouts
  // for lenses whose own turns a few thousand nodes into a thin ribbon (`lib/network/largeLayout.ts`).
  const scene: Scene = useMemo(() => {
    const index = new Map<string, number>();
    nodes.forEach((n, i) => index.set(n.id, i));
    let tie: Map<string, number> | null = null;
    if (layout.kind !== 'page' && layout.tieKey) {
      const order = [...new Set(nodes.map((n) => layout.tieKey!(n)))].sort();
      tie = new Map(order.map((k, i) => [k, i]));
    }
    const inputs = nodes.map((n) => {
      const w = numeric(n.style?.width, 30);
      const h = numeric(n.style?.height, 19);
      return {
        x: n.position.x + w / 2,
        y: n.position.y + h / 2,
        w,
        h,
        layer: layout.kind === 'page' ? layout.spread?.layerOf(n) ?? -1 : layout.layerOf(n),
        tie: tie && layout.kind !== 'page' ? tie.get(layout.tieKey!(n)) ?? 0 : 0,
      };
    });
    const le: LayoutEdge[] = [];
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a !== undefined && b !== undefined) le.push({ source: a, target: b });
    }
    const place = placeNodes(
      layout.kind,
      inputs,
      layout.kind === 'page' ? 1 : layout.layerCount,
      le,
      aspect,
      layout.kind === 'page' && layout.spread ? layout.spread : undefined,
    );
    return buildScene(
      nodes.map((n, i) => ({
        id: n.id,
        x: place.x[i],
        y: place.y[i],
        w: place.w[i],
        h: place.h[i],
        label: String((n.data as { label?: unknown })?.label ?? n.id),
        color: colorOf(n),
      })),
      edges.map((e) => ({
        source: e.source,
        target: e.target,
        width: typeof e.data?.width === 'number' ? (e.data.width as number) : 1,
      })),
    );
    // `colorOf` and `layout` are fresh objects each render; the sets and the card's shape decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, aspect]);

  const style: DrawStyle = useMemo(
    () => ({
      palette,
      edge: GRAPH_INK.edge,
      edgeHighlight: GRAPH_INK.edgeHighlight,
      ring: GRAPH_INK.nodeOutline,
      text: GRAPH_INK.nodeText,
      shape,
      background: '#ffffff',
    }),
    [palette, shape],
  );

  const view = useRef<Transform>({ k: 1, x: 0, y: 0 });
  const fitK = useRef(1);
  const sizeRef = useRef<Size>({ width: 900, height: 600 });
  const hover = useRef(-1);
  const moving = useRef(false);
  const raf = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>();
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const styleRef = useRef(style);
  styleRef.current = style;
  const selectedIdx = useRef(-1);
  selectedIdx.current = selectedId ? scene.indexOf.get(selectedId) ?? -1 : -1;
  const userMoved = useRef(false);
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  const draw = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = canvas.current;
      const ctx = el?.getContext('2d');
      if (!el || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGraph(
        ctx,
        sceneRef.current,
        view.current,
        sizeRef.current,
        fitK.current,
        { selected: selectedIdx.current, hover: hover.current, moving: moving.current },
        styleRef.current,
      );
    });
  }, []);

  const fit = useCallback(() => {
    const t = fitTransform(sceneRef.current.bounds, sizeRef.current);
    view.current = t;
    fitK.current = t.k;
    userMoved.current = false;
    onZoomRef.current?.(1);
    draw();
  }, [draw]);

  // size: the element's, scaled for the screen's pixel density
  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const apply = () => {
      const w = Math.max(50, el.clientWidth);
      const h = Math.max(50, el.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const first = sizeRef.current.width === 900 && sizeRef.current.height === 600;
      sizeRef.current = { width: w, height: h };
      setAspect((a) => (Math.abs(Math.log(w / h / a)) > 0.25 ? w / h : a));
      if (first || !userMoved.current) fit();
      else draw();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, draw]);

  // a new graph: show all of it
  useEffect(() => {
    fit();
  }, [scene, fit]);
  useEffect(() => {
    draw();
  }, [selectedId, style, draw]);
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  const settle = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      moving.current = false;
      draw();
    }, 140);
  }, [draw]);

  const applyView = useCallback(
    (t: Transform) => {
      view.current = t;
      userMoved.current = true;
      moving.current = true;
      onZoomRef.current?.(fitK.current > 0 ? t.k / fitK.current : 1);
      draw();
      settle();
    },
    [draw, settle],
  );

  useImperativeHandle(
    ref,
    () => ({
      fit,
      centerOn: (id: string) => {
        const i = sceneRef.current.indexOf.get(id);
        if (i === undefined) return;
        const k = Math.max(view.current.k, fitK.current * 2.5);
        applyView(centerOn(sizeRef.current, sceneRef.current.xs[i], sceneRef.current.ys[i], k));
      },
      zoomBy: (factor: number) =>
        applyView(zoomAt(view.current, factor, sizeRef.current.width / 2, sizeRef.current.height / 2)),
    }),
    [fit, applyView],
  );

  // wheel needs a non-passive listener to stop the page scrolling under it
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      applyView(zoomAt(view.current, Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyView]);

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const cursor = (c: 'grab' | 'grabbing' | 'pointer') => {
    if (canvas.current) canvas.current.style.cursor = c;
  };

  const pick = (clientX: number, clientY: number): number => {
    const el = canvas.current;
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    const w = screenToWorld(view.current, clientX - r.left, clientY - r.top);
    // a few pixels of slack, so a dot a few pixels wide can still be hit
    return nearestNode(sceneRef.current, w.x, w.y, Math.max(7 / view.current.k, 12));
  };

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden bg-white">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Network graph: ${scene.n.toLocaleString('en-US')} nodes and ${scene.m.toLocaleString('en-US')} edges. The Summary view lists them.`}
        className="block cursor-grab touch-none"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
          cursor('grabbing');
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) < 4) return;
            d.moved = true;
            d.x = e.clientX;
            d.y = e.clientY;
            setTip(null);
            applyView(panBy(view.current, dx, dy));
            return;
          }
          const i = pick(e.clientX, e.clientY);
          if (i !== hover.current) {
            hover.current = i;
            cursor(i >= 0 ? 'pointer' : 'grab');
            const r = canvas.current!.getBoundingClientRect();
            setTip(i >= 0 ? { x: e.clientX - r.left, y: e.clientY - r.top, label: sceneRef.current.labels[i] } : null);
            draw();
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          cursor(hover.current >= 0 ? 'pointer' : 'grab');
          if (d && !d.moved) {
            const i = pick(e.clientX, e.clientY);
            onSelect(i >= 0 ? sceneRef.current.ids[i] : null);
          }
        }}
        onPointerLeave={() => {
          if (hover.current !== -1) {
            hover.current = -1;
            setTip(null);
            draw();
          }
        }}
        onDoubleClick={(e) => {
          const i = pick(e.clientX, e.clientY);
          if (i >= 0) onFocus(sceneRef.current.ids[i]);
        }}
      />
      {tip && (
        <div
          className={cn(
            'pointer-events-none absolute z-10 max-w-[260px] truncate rounded-[4px] border bg-white px-2 py-0.5 font-mono text-[11px]',
            LENS.border,
            LENS.ink,
          )}
          style={{ left: Math.min(tip.x + 12, sizeRef.current.width - 120), top: tip.y + 14 }}
        >
          {tip.label}
        </div>
      )}
    </div>
  );
});

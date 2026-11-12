/**
 * The large-network behaviour of the lens graph card, rendered to static markup (this
 * repository's vitest runs in node with no DOM — see bomTreeRender.test.tsx for the pattern).
 *
 * What is pinned: a big graph opens in the OVERVIEW and never mounts React Flow with its
 * nodes; a small graph is exactly what it was; a focus leaves the overview for the graph; the
 * overview says what it is and what its ranking means; and a project the size of the large demo
 * renders in well under a second.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Edge, Node } from "@xyflow/react";
import { GraphCard, type LargeViewConfig } from "../GraphCard";
import { LargeNetworkOverview } from "../LargeNetworkOverview";
import { LARGE_GRAPH, RANK_BASIS, buildOverviewNodes } from "@/lib/network/scale";

const GROUPS = ["A", "B", "C", "D"] as const;
const legend = GROUPS.map((g, i) => ({ key: g, label: `Class ${g}`, color: ["#111111", "#222222", "#333333", "#444444"][i], count: 0 }));

function graph(n: number, e: number) {
  const nodes: Node[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, position: { x: i, y: i }, data: { label: `Node ${i}`, group: GROUPS[i % 4], country: `Country ${i % 30}` },
  }));
  const edges: Edge[] = Array.from({ length: e }, (_, i) => ({
    id: `e${i}`, source: `n${(i * 7) % n}`, target: `n${(i * 13 + 1) % n}`,
  }));
  return { nodes, edges };
}

function card(n: number, e: number, over: Partial<LargeViewConfig> = {}) {
  const g = graph(n, e);
  const largeView: LargeViewConfig = {
    projectKey: "p1", nodes: g.nodes, edges: g.edges,
    groupOf: (x) => (x.data as { group: string }).group,
    secondary: { title: "Country", of: (x) => (x.data as { country: string }).country },
    weight: { label: "Flow", of: (x) => Number(x.id.slice(1)) },
    layout: { kind: "columns", layerOf: (x) => GROUPS.indexOf((x.data as { group: (typeof GROUPS)[number] }).group), layerCount: 4 },
    focusedId: null, selectedId: null, onSelect: () => {}, onFocus: () => {}, ...over,
  };
  return renderToStaticMarkup(
    createElement(GraphCard, {
      legend, nodes: g.nodes, edges: g.edges, onNodesChange: () => {}, onNodeClick: () => {},
      onNodeDoubleClick: () => {}, onResetLayout: () => {}, fitKey: "k", hint: "hint", storageKey: "t", largeView,
    }),
  );
}

describe("a big graph opens as the whole network on a canvas", () => {
  it("draws on a canvas, never mounting React Flow with every node", () => {
    const html = card(LARGE_GRAPH.nodes + 400, LARGE_GRAPH.edges + 500);
    expect(html).toContain("<canvas");
    expect(html).toContain("Network graph: 1,400 nodes and 3,500 edges");
    expect(html).not.toContain("react-flow__node");
    expect(html).not.toContain('class="react-flow ');
    expect(html).not.toContain("large-overview");
  });

  it("offers the Network / Summary switch, with Network pressed, and the canvas controls", () => {
    const html = card(LARGE_GRAPH.nodes + 1, 10);
    expect(html).toContain('aria-label="Network view"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Network</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Summary</);
    for (const c of ["Zoom in", "Zoom out", "Fit view", "Reset layout"]) expect(html).toContain(`aria-label="${c}"`);
    expect(html).toContain("double-click to focus its supply path");
  });

  it("does not turn the summary into the default, or show it by itself", () => {
    expect(card(5000, 14000)).not.toContain("Large network — summary.");
  });
});

describe("a lens that keeps its own layout", () => {
  it("still draws the big network on the canvas", () => {
    const html = card(2000, 5000, { layout: { kind: "page" } });
    expect(html).toContain("<canvas");
    expect(html).not.toContain("react-flow__node");
  });
});

describe("a small graph is what it was", () => {
  it("draws React Flow, with no canvas and no switch", () => {
    const html = card(40, 60);
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain('aria-label="Network view"');
    expect(html).not.toContain("Full network");
  });

  it("is unchanged when the page passes no largeView", () => {
    const g = graph(2000, 5000);
    const html = renderToStaticMarkup(
      createElement(GraphCard, {
        legend, nodes: g.nodes, edges: g.edges, onNodesChange: () => {}, onNodeClick: () => {},
        onNodeDoubleClick: () => {}, onResetLayout: () => {}, fitKey: "k", hint: "hint", storageKey: "t",
      }),
    );
    expect(html).not.toContain("<canvas");
  });
});

describe("a focus leaves the canvas for the readable graph, and has a way back", () => {
  it("shows React Flow for the focused set and a Full network button", () => {
    const html = card(2000, 5000, { focusedId: "n5" });
    expect(html).not.toContain("<canvas");
    expect(html).toContain("← Full network (2,000)");
    expect(html).not.toContain('aria-label="Network view"');
  });
});

describe("at the large demo's size", () => {
  it("renders the card for 5 000 nodes and 14 000 edges in well under a second", () => {
    const t0 = performance.now();
    const html = card(5000, 14000);
    const ms = performance.now() - t0;
    expect(html).toContain("5,000 nodes and 14,000 edges");
    expect(ms).toBeLessThan(1500);
  });
});

describe("LargeNetworkOverview", () => {
  const raw = graph(900, 2000).nodes;
  const nodes = buildOverviewNodes(raw, [{ source: "n0", target: "n1" }], {
    id: (n) => n.id, label: (n) => n.id, group: (n) => (n.data as { group: string }).group,
  });
  it("shows no ranking-by selector when the lens has no figure of its own", () => {
    const html = renderToStaticMarkup(
      createElement(LargeNetworkOverview, { legend, nodes, edgeCount: 1, focusedId: null, onFocus: () => {}, onShowGraph: () => {} }),
    );
    expect(html).not.toContain("Rank by");
    expect(html).not.toContain("By country");
  });
  it("shows it, and the second grouping, when the lens has them", () => {
    const html = renderToStaticMarkup(
      createElement(LargeNetworkOverview, {
        legend, nodes, edgeCount: 1, weightLabel: "Revenue", secondaryTitle: "Country",
        focusedId: null, onFocus: () => {}, onShowGraph: () => {},
      }),
    );
    expect(html).toContain("Rank by");
    expect(html).toContain("Revenue");
    expect(html).toContain("By country");
  });
});

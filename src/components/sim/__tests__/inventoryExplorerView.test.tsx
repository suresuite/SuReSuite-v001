/**
 * The inventory explorer as a user sees it (G17 / §9.5.1) — rendered to static
 * markup (vitest runs in node, as `labModelStep.test.tsx` does) from a REAL
 * inspection run (`src/lib/sim/__tests__/fixtures/inventoryInspectionRun.json`).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
// renderToStaticMarkup cannot wait for a lazy chunk, so the real chart component stands
// in for its lazy wrapper (lazyCharts.tsx only defers it; props and output are the same).
vi.mock("@/components/sim/lazyCharts", async () => ({
  ItemCharts: (await import("@/components/sim/inventory/ItemCharts")).ItemCharts,
}));

import RUN from "@/lib/sim/__tests__/fixtures/inventoryInspectionRun.json";
import { InventoryExplorerView, type InventoryExplorerViewProps } from "../ItemSeriesExplorer";
import {
  EXPLORER_LIMITS,
  NOT_STOCKED,
  deriveInventory,
  type ExplorerInputs,
  type ItemSeriesRow,
} from "@/lib/sim/inventoryExplorer";

const rows = RUN.item_series as unknown as ItemSeriesRow[];
const W0 = RUN.warmup_detected_at as number;
const ctx: ExplorerInputs = { snapshot: RUN.snapshot, source: "snapshot", names: new Map([["M1", "Steel tube"]]) };

const view = (over: Partial<InventoryExplorerViewProps> = {}, rs: ItemSeriesRow[] = rows) =>
  renderToStaticMarkup(
    createElement(InventoryExplorerView, {
      rows: rs,
      derived: deriveInventory(rs, ctx, W0),
      warmupWeeks: W0,
      liveSource: false,
      kind: "material",
      onKind: () => {},
      query: "",
      onQuery: () => {},
      selected: [],
      onToggle: () => {},
      busy: null,
      canExport: true,
      exportRefusal: null,
      onDownload: () => {},
      ...over,
    }),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("inventory explorer view", () => {
  it("opens on Materials, one ranked row per material, with names from the project", () => {
    const html = view();
    expect(count(html, 'data-testid="material-row"')).toBe(3);
    expect(html).toContain('aria-pressed="true"');
    expect(html.indexOf(">M1<")).toBeLessThan(html.indexOf(">M2<")); // M1 ran out — riskiest
    expect(html).toContain("Steel tube");
  });

  it("the Finished goods table renders every product, and a make-to-order one says it is not stocked", () => {
    const html = view({ kind: "product" });
    expect(count(html, 'data-testid="product-row"')).toBe(3);
    expect(html).toContain(NOT_STOCKED);
    expect(html).toContain("Make-to-order");
    expect(html).toContain("Make-to-stock");
  });

  it("two selected items draw two charts, titled with suppliers and users or with the mode", () => {
    const html = view({ selected: ["material\u0000M1", "product\u0000P_O"] });
    expect(count(html, 'data-testid="item-chart"')).toBe(2);
    expect(html).toContain("from S1");
    expect(html).toContain("used by P_S");
    expect(html).toContain("make-to-order");
    expect(html).toContain("Download Excel (2 selected)");
  });

  it("states its limits where the data is shown", () => {
    const html = view();
    for (const l of EXPLORER_LIMITS) expect(html).toContain(l.limit.replace(/'/g, "&#x27;").split(":")[0]);
    expect(html).toContain(`warm-up ends (week ${W0})`);
  });

  it("a run that predates per-product FG stock keeps the switch and says so", () => {
    const old = rows.map((r) => {
      if (r.kind !== "product") return r;
      const series = { ...r.series };
      delete series.fg_on_hand;
      delete series.fg_target;
      delete series.make_to_stock;
      return { ...r, series };
    });
    const html = view({ kind: "product" }, old);
    expect(html).toContain("This run predates per-product finished-goods stock; run a new inspection.");
    expect(html).toContain("Finished goods");
    expect(html).toContain("not recorded by this run");
  });

  it("without the Export right, both downloads are disabled and say why", () => {
    const html = view({ canExport: false, exportRefusal: "Export is not enabled for your role." });
    expect(count(html, "disabled")).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Export is not enabled for your role.");
  });
});

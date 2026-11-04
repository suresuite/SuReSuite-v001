// Inventory explorer — single-run inspection mode, per-item weekly series
// (blueprint G17 / §13 B0 follow-on item 3, "W3"; §9.5.1). An inspection run
// (1 replication, user-chosen seed, full-debug trace) persists every material's
// and every finished good's weekly record to run_item_series. This panel ranks
// them by risk, charts the ones a user selects, and downloads them to Excel —
// notebook 04's steps 5 and 8 for a user who does not run notebooks.
//
// The tables and the workbook are computed in `src/lib/sim/inventoryExplorer.ts`
// and `inventoryWorkbook.ts`; this file loads the evidence and draws it. It
// renders nothing for runs without item series (i.e. every multi-rep run),
// unless the caller asked for the absence to be explained.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, Microscope } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useProjectRights } from "@/hooks/useProjectRights";
import type { SimulationRun } from "@/hooks/useSimulationRun";
import { fetchProjectLanes } from "@/lib/policies/projectLanes";
import { assembleRunRecord, RUN_SCENARIO_COLUMNS, type RunScenarioRow } from "@/lib/trust/assembleRunRecord";
import {
  EXPLORER_LIMITS,
  deriveInventory,
  snapshotInputs,
  type DerivedInventory,
  type ExplorerInputs,
  type ItemKind,
  type ItemSeriesRow,
} from "@/lib/sim/inventoryExplorer";
import { inventoryFileName } from "@/lib/sim/inventoryFileName";
import { ItemCharts } from "@/components/sim/lazyCharts";
import { MaterialTable, ProductTable } from "@/components/sim/inventory/InventoryTable";

const SERIES_LABEL: Record<string, string> = {
  on_hand: "On hand",
  in_transit: "In transit",
  orders: "Orders placed",
  demand: "Demand",
  production: "Production",
  fulfillment: "Fulfillment",
  backlog: "Backlog",
  lost_units: "Lost units",
  // Inventory explorer (G17/§9.5.1) — finished-goods stock per product, its
  // target S, and the mode the engine resolved (an attribute, never a line).
  fg_on_hand: "FG on hand",
  fg_target: "FG target",
  make_to_stock: "Make-to-stock (1) or make-to-order (0)",
  // PLAN.md §24 WP 14.4 — the plan's own record per product.
  projected_demand: "Projected demand (plan)",
  requirement: "Requirement (plan)",
  planned: "Planned production",
  // PLAN.md §24 WP 14.5 — the MRP record per material (orders placed are `orders`).
  mrp_need: "MRP need (next lead time)",
  mrp_on_hand: "MRP on hand (after production)",
  mrp_on_the_way: "MRP on the way",
  mrp_net: "MRP net",
};

const label = (key: string) => SERIES_LABEL[key] ?? key;

/** Charts drawn at once; the workbook carries every selected item regardless. */
const MAX_CHARTS = 12;

/** Rows per read of run_item_series (one row is one item's whole record). */
const PAGE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

interface Props {
  runId: string;
  warmupWeeks?: number | null;
  /** The project's name, for the workbook's file name and record. Absent, both
   *  use the project id — as the run-results export does. */
  projectName?: string | null;
  /** What to say when the run carries no per-item evidence.
   *
   *  Omitted, the panel renders nothing — right on /policies, where the
   *  inspection toggle sits a few rows above and silence is not a dead end.
   *  On /simulation-lab it WAS a dead end: that page dispatches no inspection
   *  run, so the panel was empty there by construction and said nothing about
   *  why — §4 D113's shape exactly. Passing a hint turns "empty forever" into
   *  a state with a remedy the reader can actually reach. */
  emptyHint?: ReactNode;
}

interface Context extends ExplorerInputs {
  run: SimulationRun | null;
}

const key = (kind: ItemKind, id: string) => `${kind}\u0000${id}`;


export function ItemSeriesExplorer({ runId, warmupWeeks = null, projectName, emptyHint }: Props) {
  const { user } = useAuth();
  const [rows, setRows] = useState<ItemSeriesRow[] | null>(null);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [kind, setKind] = useState<ItemKind>("material");
  const [query, setQuery] = useState("");
  // Selection order is chart order and workbook-sheet order.
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<"selected" | "all" | null>(null);
  const rights = useProjectRights(ctx?.run?.project_id ?? null);

  // Every item's record for this run, paged. Empty ⇒ not an inspection run.
  useEffect(() => {
    let alive = true;
    setRows(null);
    setCtx(null);
    setSelected([]);
    void (async () => {
      const all: ItemSeriesRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from("run_item_series")
          .select("kind,item_id,series")
          .eq("run_id", runId)
          .order("kind")
          .order("item_id")
          .range(from, from + PAGE - 1);
        if (!alive) return;
        if (error) {
          console.warn("run_item_series load failed", error);
          break;
        }
        all.push(...((data ?? []) as ItemSeriesRow[]));
        if ((data ?? []).length < PAGE) break;
      }
      if (alive) setRows(all);
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  // The run's own frozen inputs (BOM, lanes) and the items' display names —
  // read only once the run has item series to explain.
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    let alive = true;
    void (async () => {
      const { data: run } = await sb.from("simulation_runs").select("*").eq("id", runId).maybeSingle();
      const r = (run ?? null) as (SimulationRun & { dataset_version_id?: string | null }) | null;
      let snapshot: unknown = null;
      if (r?.dataset_version_id) {
        const { data: dsv } = await sb
          .from("dataset_versions")
          .select("snapshot")
          .eq("id", r.dataset_version_id)
          .maybeSingle();
        snapshot = dsv?.snapshot ?? null;
      }
      const names = new Map<string, string>();
      if (r?.project_id) {
        for (const [table, id] of [["materials", "material_id"], ["products", "product_id"]] as const) {
          const { data } = await sb.from(table).select(`${id},name`).eq("project_id", r.project_id);
          for (const row of (data ?? []) as Array<Record<string, string | null>>) {
            if (row[id] && row.name) names.set(String(row[id]), row.name);
          }
        }
      }
      const inputs = snapshotInputs(snapshot);
      let next: Context = { run: r, snapshot, source: snapshot ? "snapshot" : "none", names };
      // A v1 snapshot has no deep BOM; fall back to the live lanes, and say so.
      if (r?.project_id && (!snapshot || !("bom_multi_level" in inputs))) {
        const lanes = await fetchProjectLanes(r.project_id, user);
        next = { ...next, source: "live", liveBom: lanes.bom, liveInbound: lanes.inbound };
      }
      if (alive) setCtx(next);
    })();
    return () => {
      alive = false;
    };
  }, [rows, runId, user]);

  const w0 = Math.max(0, warmupWeeks ?? 0);
  const derived = useMemo(
    () => (rows && rows.length > 0 ? deriveInventory(rows, ctx, w0) : null),
    [rows, ctx, w0],
  );

  if (!rows || rows.length === 0 || !derived) {
    if (!rows || !emptyHint) return null;
    return (
      <div className="rounded-md border border-dashed bg-card px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">Inventory explorer</span> {"\u2014"} {emptyHint}
      </div>
    );
  }

  const download = async (scope: "selected" | "all") => {
    if (!rights.can("export")) {
      toast.error(rights.refusal("export") ?? "Export isn't enabled for you on this project.");
      return;
    }
    setBusy(scope);
    try {
      const run = ctx?.run ?? null;
      let record = null;
      let recordAbsentBecause: string | undefined;
      if (run?.project_id) {
        try {
          const { data: scenario } = await sb
            .from("scenarios")
            .select(RUN_SCENARIO_COLUMNS)
            .eq("id", run.scenario_id)
            .maybeSingle();
          record = await assembleRunRecord({
            run,
            scenario: (scenario ?? null) as RunScenarioRow | null,
            projectId: run.project_id,
            projectName,
            userId: user?.id ?? null,
          });
          if (ctx?.source === "live") {
            record.limits = [...record.limits, {
              ref: "T2",
              limit: "This run's dataset version predates the deep BOM in the snapshot.",
              consequence: "Use and suppliers were read from the project's CURRENT bill of materials and lanes, " +
                "which may differ from what the run read.",
            }];
          }
        } catch (err) {
          recordAbsentBecause = `The record could not be assembled: ${(err as Error).message ?? err}`;
        }
      } else {
        recordAbsentBecause = "The run row could not be read.";
      }
      // The workbook library loads on the first export click.
      const [{ buildInventoryWorkbook }, { downloadWorkbook }] = await Promise.all([
        import("@/lib/sim/inventoryWorkbook"),
        import("@/lib/policies/excel"),
      ]);
      const wb = buildInventoryWorkbook({
        record,
        recordAbsentBecause,
        materials: derived.materials,
        products: derived.products,
        rows,
        use: derived.use,
        selected: selected.map((k) => {
          const [kd, id] = k.split("\u0000");
          return { kind: kd as ItemKind, id };
        }),
        scope,
      });
      downloadWorkbook(wb, inventoryFileName(projectName ?? run?.project_id ?? "project", runId));
      toast.success("Inventory workbook downloaded");
    } catch (err) {
      console.error("inventory export failed", err);
      toast.error(`Export failed: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <InventoryExplorerView
      rows={rows}
      derived={derived}
      warmupWeeks={warmupWeeks}
      liveSource={ctx?.source === "live"}
      kind={kind}
      onKind={(k) => {
        setKind(k);
        setQuery("");
      }}
      query={query}
      onQuery={setQuery}
      selected={selected}
      onToggle={(k) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}
      busy={busy}
      canExport={rights.can("export")}
      exportRefusal={rights.refusal("export")}
      onDownload={(scope) => void download(scope)}
    />
  );
}

export interface InventoryExplorerViewProps {
  rows: ItemSeriesRow[];
  derived: DerivedInventory;
  warmupWeeks: number | null;
  /** The BOM and lanes are the project's current ones, not the run's snapshot. */
  liveSource: boolean;
  kind: ItemKind;
  onKind: (k: ItemKind) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Selection keys (`kind\u0000id`), in the order they were ticked. */
  selected: string[];
  onToggle: (key: string) => void;
  busy: "selected" | "all" | null;
  canExport: boolean;
  exportRefusal: string | null;
  onDownload: (scope: "selected" | "all") => void;
}

/** What the explorer draws — no reads, no state of its own. */
export function InventoryExplorerView({
  rows, derived, warmupWeeks, liveSource, kind, onKind, query, onQuery, selected, onToggle,
  busy, canExport, exportRefusal, onDownload,
}: InventoryExplorerViewProps) {
  const byKey = new Map(rows.map((r) => [key(r.kind, r.item_id), r]));
  const q = query.trim().toLowerCase();
  const match = (id: string, name: string | null) =>
    !q || id.toLowerCase().includes(q) || (name ?? "").toLowerCase().includes(q);
  const materials = derived.materials.filter((r) => match(r.id, r.name));
  const products = derived.products.filter((r) => match(r.id, r.name));
  const selectedOfKind = new Set(
    selected.filter((k) => k.startsWith(`${kind}\u0000`)).map((k) => k.slice(kind.length + 1)),
  );
  const toggle = (id: string) => onToggle(key(kind, id));
  const counts = { material: derived.materials.length, product: derived.products.length };

  const title = (r: ItemSeriesRow) => {
    const name = derived.names.get(r.item_id);
    const head = name ? `${r.item_id} \u00b7 ${name}` : r.item_id;
    if (r.kind === "material") {
      const sup = derived.suppliers.get(r.item_id)?.join(", ") || "no supplier in the run's data";
      const users = derived.users.get(r.item_id)?.join(", ") || "no product";
      return `${head} \u2014 from ${sup} \u00b7 used by ${users}`;
    }
    const p = derived.products.find((x) => x.id === r.item_id);
    const mode = p?.mode === "mts" ? "make-to-stock" : p?.mode === "mto" ? "make-to-order" : "mode not recorded";
    return `${head} \u2014 ${mode}`;
  };

  const charted = selected.map((k) => byKey.get(k)).filter((r): r is ItemSeriesRow => !!r);

  const exportTitle = canExport ? undefined : exportRefusal ?? undefined;
  const btn =
    "inline-flex min-h-11 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors md:h-7 md:min-h-0 " +
    "hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="min-w-0 rounded-md border bg-card" data-testid="inventory-explorer">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Microscope className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 text-xs font-semibold">Inventory explorer (inspection run)</span>
        <span className="min-w-0 text-[10px] text-emerald-600 dark:text-emerald-400">
          engine data {"\u00b7"} {counts.material} material(s) {"\u00b7"} {counts.product} finished good(s)
        </span>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Item kind">
          {(["material", "product"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === kind}
              onClick={() => onKind(k)}
              className={cn(
                "h-6 min-h-11 rounded-md border px-2 text-[10px] transition-colors md:min-h-0",
                k === kind ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted/50",
              )}
            >
              {k === "material" ? "Materials" : "Finished goods"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 p-2">
        <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
          {EXPLORER_LIMITS.map((l) => (
            <li key={l.limit}>{l.limit}</li>
          ))}
          {warmupWeeks != null && warmupWeeks > 0 && (
            <li>Weeks before the warm-up ends (week {warmupWeeks}) are left out of the tables.</li>
          )}
          {liveSource && (
            <li>
              This run&apos;s dataset version predates the deep BOM in its snapshot, so use and suppliers are
              read from the project&apos;s current data.
            </li>
          )}
        </ul>

        {kind === "product" && !derived.fgRecorded && (
          <div
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            role="status"
          >
            This run predates per-product finished-goods stock; run a new inspection.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder={`Search ${counts[kind]} ${kind === "material" ? "materials" : "finished goods"}\u2026`}
            className="h-7 min-h-11 w-full min-w-0 basis-full text-xs md:min-h-0 md:max-w-xs md:basis-auto md:flex-1"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search items"
          />
          <div className="flex-1" />
          <button
            type="button"
            className={btn}
            disabled={busy !== null || selected.length === 0 || !canExport}
            title={exportTitle ?? (selected.length === 0 ? "Select one or more items first" : undefined)}
            onClick={() => onDownload("selected")}
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            {busy === "selected" ? "Preparing\u2026" : `Download Excel (${selected.length} selected)`}
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy !== null || !canExport}
            title={exportTitle}
            onClick={() => onDownload("all")}
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            {busy === "all" ? "Preparing\u2026" : "Download Excel (all items)"}
          </button>
        </div>

        {kind === "material" ? (
          <MaterialTable rows={materials} selected={selectedOfKind} onToggle={toggle} />
        ) : (
          <ProductTable rows={products} selected={selectedOfKind} onToggle={toggle} />
        )}
        <p className="text-[10px] text-muted-foreground">
          Riskiest first:{" "}
          {kind === "material"
            ? "most weeks at zero, then the thinnest cover."
            : "largest shortfall (lost units + average backlog), then most weeks out of stock while demand waited, then lowest fill rate."}{" "}
          Select rows to chart them; the workbook holds the tables, every selected item week by week, and the
          reproducibility record.
        </p>

        {charted.length === 0 ? (
          <div className="flex items-center justify-center rounded border border-dashed p-6 text-[11px] text-muted-foreground">
            Select one or more rows to chart their weeks.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {charted.slice(0, MAX_CHARTS).map((r) => (
              <ItemCharts
                key={key(r.kind, r.item_id)}
                row={r}
                title={title(r)}
                warmupWeeks={warmupWeeks}
                use={r.kind === "material" ? derived.use.get(r.item_id) : undefined}
                fgRecorded={derived.fgRecorded}
                label={label}
              />
            ))}
          </div>
        )}
        {charted.length > MAX_CHARTS && (
          <p className="text-[10px] text-muted-foreground">
            Showing the first {MAX_CHARTS} of {charted.length} selected; the workbook carries all of them.
          </p>
        )}
      </div>
    </div>
  );
}

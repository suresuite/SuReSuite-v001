import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useProjectRights } from "@/hooks/useProjectRights";
import { ProjectRightRefused } from "@/lib/auth/projectRights";
import { toast } from "sonner";
import { fetchProjectForecasts, fetchProjectLanes } from "@/lib/policies/projectLanes";
import { shareRead } from "@/lib/sharedRead";
import type { ForecastBucket } from "@/lib/policies/customerRows";
import {
  demandWeightedSellPrice,
  derivedMaterialCost,
  weeklyDemand,
} from "@/lib/policies/effectiveEconomics";

// Item-master rows (supabase/migrations/20260614000001_item_master.sql).
// The generated Supabase types are out of sync with the supply-chain schema,
// so these tables are typed locally like the rest of the data layer.

/**
 * WP 3.3 (D55) put `ingest_run_id` and `source_row_id` on all three item
 * masters, and `select("*")` has been returning them ever since without anything
 * reading them. Declared here so WP 3.4's `RowProvenance` can: a canonical row
 * that names the line of the file it came from is A4 reaching the surface, and a
 * row with neither is one whose provenance is UNKNOWN — never one that had none.
 */
export interface RowSource {
  ingest_run_id?: string | null;
  source_row_id?: string | null;
}

export interface MaterialRow extends RowSource {
  material_id: string;
  name: string | null;
  cost: number | null; // €/unit
  holding_cost_pct: number | null; // fraction, e.g. 0.20
  moq: number | null;
  initial_on_hand: number | null;
  lead_time_dist: string | null; // deterministic | lognormal | gamma
  lead_time_cv: number | null;
}

export interface ProductRow extends RowSource {
  product_id: string;
  name: string | null;
  sell_price: number | null; // €/unit
  production_capacity: number | null; // units/week
  fulfillment_mode: string | null; // mto | mts
  demand_distribution: string | null; // triangular | deterministic | poisson | negbin
  demand_mean: number | null; // units/week
  demand_cv: number | null;
  demand_min: number | null; // a_p — explicit triangular lower bound (null → mean·(1−cv))
  demand_max: number | null; // c_p — explicit triangular upper bound, e.g. historical max (null → mean·(1+cv))
  // PLAN.md §24 WP 14.4 — the FG policy (MTS) and FG opening stock.
  fg_policy?: string | null; // base_stock | min_max | days_of_cover
  fg_base_stock?: number | null; // S, units
  fg_reorder_point?: number | null; // s, units (min_max)
  fg_cover_days?: number | null; // D, days (days_of_cover)
  fg_initial_on_hand?: number | null; // units
  // PLAN.md §26 WP 16.5 — P-P.13 production lead time (weeks after promotion).
  production_lead_time?: number | null;
  production_lead_time_unit?: string | null;
  production_lead_time_dist?: string | null;
  production_lead_time_cv?: number | null;
  production_lead_time_min?: number | null;
  production_lead_time_mode?: number | null;
  production_lead_time_max?: number | null;
}

export interface SupplierRow extends RowSource {
  supplier_id: string;
  name: string | null;
  capacity_per_week: number | null; // null = unlimited
  reliability_score: number | null;
}

export type ItemMasterTable = "materials" | "products" | "suppliers";

// Fields the engine reads with a lossy fallback when NULL
// (scsim/scsim/io/project_map.py — the G4 MappingWarning set).
export const REQUIRED_FIELDS: Record<ItemMasterTable, string[]> = {
  materials: ["cost"],
  products: ["sell_price", "demand_mean", "production_capacity"],
  suppliers: [], // capacity_per_week: NULL is a valid choice (unlimited)
};

const ID_COLUMN: Record<ItemMasterTable, string> = {
  materials: "material_id",
  products: "product_id",
  suppliers: "supplier_id",
};

const UPSERT_RPC: Record<ItemMasterTable, string> = {
  materials: "bulk_upsert_materials",
  products: "bulk_upsert_products",
  suppliers: "bulk_upsert_suppliers",
};

const SAVE_BATCH_SIZE = 100;

/**
 * Engine-fallback economics derived live from the uploaded logistics lanes
 * (inbound/outbound unit_price) via effectiveEconomics.ts. NULL master fields
 * with a derived value here are NOT "missing" — the engine resolves them.
 */
export interface DerivedEconomics {
  /** materials.cost fallback: the registry's inbound chain — the
   * volume-weighted lane price, else the cheapest quote. */
  materialCost: Map<string, number>;
  /** products.sell_price fallback: demand-weighted outbound unit_price. */
  sellPrice: Map<string, number>;
  /** products.demand_mean fallback: Σ weekly outbound volume. */
  demandMean: Map<string, number>;
}

interface UseItemMastersResult {
  materials: MaterialRow[];
  products: ProductRow[];
  suppliers: SupplierRow[];
  loading: boolean;
  error: string | null;
  missingCounts: Record<ItemMasterTable, number>;
  derived: DerivedEconomics;
  /** RAW logistics/BOM rows for the shared grader — never imputed. The
   * verification manifest must grade exactly what the edge gate reads. */
  lanes: {
    inbound: Record<string, unknown>[];
    outbound: Record<string, unknown>[];
    /** PLAN.md §24 WP 14.2 — the per-row forecast buckets (weekly rate each). */
    forecasts: ForecastBucket[];
    /** PLAN.md §24 WP 14.3 — the `customers` master rows (priority, contracted
     *  floor): the base under a Customer row's priority and service target. */
    customers: Record<string, unknown>[];
    /** Single- OR multi-level rows — bomLevel tells consumers the shape. */
    bom: Record<string, unknown>[];
    /** projects.bom_level — 'single' or 'multi'/'multi_level'. */
    bomLevel: string;
    /** D20: lane tables whose read hit the ceiling — the grade below was
     *  computed on a slice, and the surface says so. */
    truncated: string[];
    loaded: boolean;
  };
  reload: () => Promise<void>;
  saveRows: (
    table: ItemMasterTable,
    rows: Array<MaterialRow | ProductRow | SupplierRow>,
  ) => Promise<void>;
  /** D230 — "Edit Input Data" on this project, as /profile lists it; `saveRows` refuses without it. */
  canEditInputs: boolean;
  inputEditRefusal: string | null;
}

/**
 * Load + edit the item masters of a project. Calls ensure_item_masters on
 * mount so a row exists for every id referenced by the logistics/BOM tables,
 * then keeps the three tables live via postgres_changes.
 */
export function useItemMasters(projectId: string | null | undefined): UseItemMastersResult {
  const { user } = useAuth();
  const rights = useProjectRights(projectId);
  const canEditInputs = rights.can("data_edit_inputs");
  const inputEditRefusal = rights.loading
    ? "Checking your rights on this project…"
    : rights.refusal("data_edit_inputs");
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [inboundArcs, setInboundArcs] = useState<Record<string, unknown>[]>([]);
  const [outboundArcs, setOutboundArcs] = useState<Record<string, unknown>[]>([]);
  const [forecasts, setForecasts] = useState<ForecastBucket[]>([]);
  const [customerRows, setCustomerRows] = useState<Record<string, unknown>[]>([]);
  const [bomRows, setBomRows] = useState<Record<string, unknown>[]>([]);
  const [bomLevel, setBomLevel] = useState<string>("single");
  const [lanesLoaded, setLanesLoaded] = useState(false);
  const [laneTruncation, setLaneTruncation] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Logistics lanes — the engine's price/demand fallback sources. Read via
  // the SECURITY DEFINER RPC (direct .from() reads are RLS-blocked under the
  // app's custom auth — see src/lib/policies/projectLanes.ts). Rows are kept
  // RAW: the shared grader must see exactly what the edge gate reads.
  // `fresh`: a realtime change means a write just happened, so read again rather
  // than join a request that started before it.
  const loadLogistics = useCallback(async (fresh = false) => {
    if (!projectId) return;
    // The lanes, the forecast series and the customers master do not depend on one
    // another, so they are read together (they were three round trips in a row).
    const [lanes, fq, cq] = await Promise.all([
      fetchProjectLanes(projectId, user, { fresh }),
      fetchProjectForecasts(projectId, user),
      // WP 14.3 — the customers master (anon-readable, `customers_anon_read`).
      shareRead(`im|customers|${projectId}`, async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("customers")
          .select("customer_id,segment,priority_weight,sla_fill_floor_pct")
          .eq("project_id", projectId), fresh),
    ]);
    setInboundArcs(lanes.inbound);
    setOutboundArcs(lanes.outbound);
    // WP 14.2 — a failed read is logged and leaves the series empty; the
    // Customer row then shows no forecast, which the Data map reports as a
    // failed read rather than as "none uploaded" (useDataMap).
    if (fq.error) console.warn("[useItemMasters] demand forecast read failed", fq.error);
    setForecasts(fq.rows as unknown as ForecastBucket[]);
    // A failed customers read is logged; the Customer row's priority and target then
    // show their declared defaults, the same answer the Data map reports.
    if (cq.error) console.warn("[useItemMasters] customers read failed", cq.error);
    setCustomerRows((cq.data ?? []) as Record<string, unknown>[]);
    // BOTH BOM shapes pass through raw — the shared grader normalizes
    // multi-level rows itself. Dropping them here once made "Verify your
    // inputs" grade an empty BOM on multi-level projects and miss the
    // materials.supplier_link blocks the sim-command gate then raised.
    setBomRows(lanes.bom);
    setBomLevel(lanes.bomLevel);
    setLaneTruncation(lanes.truncated);
    setLanesLoaded(true);
  }, [projectId, user]);

  const loadTable = useCallback(
    // `fresh`: after a save or a realtime change, read again; at mount, join the read
    // another instance of this hook (this page mounts several) already started.
    async (table: ItemMasterTable, fresh = false) => {
      if (!projectId) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { data, error: err } = await shareRead(
        `im|${table}|${projectId}`,
        async () => await sb.from(table).select("*").eq("project_id", projectId).order(ID_COLUMN[table]),
        fresh,
      );
      if (err) {
        console.error(`load ${table} failed`, err);
        setError(err.message ?? `Failed to load ${table}`);
        return;
      }
      if (table === "materials") setMaterials((data ?? []) as MaterialRow[]);
      else if (table === "products") setProducts((data ?? []) as ProductRow[]);
      else setSuppliers((data ?? []) as SupplierRow[]);
    },
    [projectId],
  );

  const load = useCallback(async (fresh: boolean) => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    // Materialize master rows for every id in the logistics/BOM tables so
    // there is always a row to edit (ON CONFLICT DO NOTHING — user-entered
    // economics survive re-uploads).
    const { error: ensureErr } = await shareRead(
      `im|ensure|${projectId}|${user?.id ?? ""}`,
      async () =>
        await sb.rpc("ensure_item_masters", {
          p_project_id: projectId,
          // D71 · the actor, so the rows this materializes carry one. DEFAULT NULL
          // on the RPC, so omitting it is exactly the old behaviour.
          _actor_user_id: user?.id ?? null,
        }),
      fresh,
    );
    if (ensureErr) console.error("ensure_item_masters failed", ensureErr);
    await Promise.all([
      loadTable("materials", fresh),
      loadTable("products", fresh),
      loadTable("suppliers", fresh),
      loadLogistics(fresh),
    ]);
    setLoading(false);
  }, [projectId, loadTable, loadLogistics, user?.id]);

  // The public reload is always a fresh read (callers use it after a change); only the
  // mount-time load joins reads another instance of this hook has in flight.
  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Realtime: item masters are in the supabase_realtime publication; reload
  // the affected table on any change (rows are few, merging isn't worth it).
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase.channel(`item-masters:${projectId}`);
    (["materials", "products", "suppliers"] as ItemMasterTable[]).forEach((table) => {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `project_id=eq.${projectId}` },
        () => void loadTable(table, true),
      );
    });
    // Logistics re-uploads change the derived (fallback) economics too.
    (["inbound_logistics", "outbound_logistics"] as const).forEach((table) => {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `project_id=eq.${projectId}` },
        () => void loadLogistics(true),
      );
    });
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [projectId, loadTable, loadLogistics]);

  const saveRows = useCallback(
    async (table: ItemMasterTable, rows: Array<MaterialRow | ProductRow | SupplierRow>) => {
      if (!projectId || rows.length === 0) return;
      if (!canEditInputs) {
        const reason = inputEditRefusal ?? "You may not edit input data on this project.";
        toast.error(reason);
        throw new ProjectRightRefused(reason);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      for (let i = 0; i < rows.length; i += SAVE_BATCH_SIZE) {
        const batch = rows.slice(i, i + SAVE_BATCH_SIZE);
        const { error: err } = await sb.rpc(UPSERT_RPC[table], {
          p_project_id: projectId,
          p_rows: batch,
          _actor_user_id: user?.id ?? null,   // D71
        });
        if (err) {
          console.error(`${UPSERT_RPC[table]} failed`, err);
          throw new Error(err.message ?? `Failed to save ${table}`);
        }
      }
      await loadTable(table, true);
    },
    [projectId, loadTable, user?.id, canEditInputs, inputEditRefusal],
  );

  const derived: DerivedEconomics = useMemo(
    () => ({
      materialCost: derivedMaterialCost(inboundArcs),
      sellPrice: demandWeightedSellPrice(outboundArcs),
      demandMean: weeklyDemand(outboundArcs),
    }),
    [inboundArcs, outboundArcs],
  );

  // A field is "missing" only when the master is NULL *and* the engine has no
  // logistics fallback for it — mirroring verification.ts's warn/block split.
  const derivedFor = (table: ItemMasterTable, field: string, id: string): boolean => {
    if (table === "materials" && field === "cost") return derived.materialCost.has(id);
    if (table === "products" && field === "sell_price") return derived.sellPrice.has(id);
    if (table === "products" && field === "demand_mean") return (derived.demandMean.get(id) ?? 0) > 0;
    return false;
  };
  const missingCounts: Record<ItemMasterTable, number> = {
    materials: materials.filter((r) =>
      REQUIRED_FIELDS.materials.some(
        (f) => r[f as keyof MaterialRow] == null && !derivedFor("materials", f, r.material_id),
      ),
    ).length,
    products: products.filter((r) =>
      REQUIRED_FIELDS.products.some(
        (f) => r[f as keyof ProductRow] == null && !derivedFor("products", f, r.product_id),
      ),
    ).length,
    suppliers: 0,
  };

  const lanes = useMemo(
    () => ({
      inbound: inboundArcs, outbound: outboundArcs, forecasts, customers: customerRows, bom: bomRows, bomLevel,
      truncated: laneTruncation, loaded: lanesLoaded,
    }),
    [inboundArcs, outboundArcs, forecasts, customerRows, bomRows, bomLevel, laneTruncation, lanesLoaded],
  );

  return {
    materials, products, suppliers, loading, error, missingCounts, derived, lanes, reload, saveRows,
    canEditInputs, inputEditRefusal,
  };
}

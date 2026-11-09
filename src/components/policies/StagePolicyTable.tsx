import { rowWindow, scrollTopFor } from "@/lib/policies/rowWindow";
import { Fragment, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { MemoRow } from "./memoRow";
import { useLatestCallback } from "./rowMemo";
import { ProjectRightRefused } from "@/lib/auth/projectRights";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { LAYER, MonoChip, Toggle, tint } from "@/components/intelligence/piUi";
import {
  CellSegmented,
  FamilyBand,
  FamilyChip,
  NumCell,
  ProvenanceDotButton,
  POLICY_TYPE_OPTIONS,
  ProvenanceDot,
  ProvenanceLegend,
  ReplenishmentCell,
  PROVENANCE,
  ColResizeHandle,
  RowFlag,
  SortHeader,
  FilterInput,
  rowAccent,
  type Provenance,
} from "./policyGridUi";
import {
  specFor,
  familiesForStage,
  fitColsForStage,
  vectorParamCols,
  fgVectorParamCols,
  FG_POLICY_PARAMS,
  flattenBundle,
  fgBufferAppliesToRow,
  isFgDependentCol,
  projectFulfillmentModeOf,
  rowDemandMode,
  rowFulfillmentMode,
  rowHasForecast,
  type ColSpec,
  type ColSpecCtx,
} from "@/lib/policies/columnSpecs";
import { clampColWidth, fitColumns, foldNote, type FitCol } from "@/lib/policies/columnFit";
import {
  buildBomTreeModel,
  expandToLevel,
  occKey,
  revealForFilter,
  revealKeys,
  visibleTreeRows,
  type BomOcc,
  type BomTreeModel,
  type TreeLayout,
  type VisRow,
} from "@/lib/policies/bomTreeView";
import { stageEmptyMessage, treeFallbackReason } from "@/lib/policies/stageGridState";
import { groupByKeyA, memberDisplay, summarise } from "@/lib/policies/groupRows";
import { ENUM_OPTIONS, SCSIM_ENUM_OPTIONS, type FulfillmentStrategy, type PolicyBundle, type PolicyFamily } from "@/lib/policies/schemas";
import { effectivePolicy, overridesForTarget, type OverrideRow } from "@/lib/policies/resolve";
import {
  masterValueFor as masterValueForShared,
  derivedValueFor as derivedValueForShared,
  getEffectiveValue as getEffectiveValueShared,
  rowGateCtx,
  savedOverrideValue,
  isPrefillPersistable,
  resolveCell,
  rowHasSeedableField,
  substitutionNote,
  masterBaseFor,
  masterIdOf,
  masterOverrideFor,
  masterRawFor,
  isEnumMaster,
  normalizeEnumToken,
} from "@/lib/policies/resolveEffective";
import { cellEngineRead, notSimulatedNote as noteOf } from "@/lib/policies/cellEngineRead";
import {
  masterOverrideRule,
  planEntityOverride,
  planPatch,
  settlePlan,
  type SavePlan,
} from "@/lib/policies/masterOverrides";
import { policyTypeLabel, inventoryParamsForType, paramFeasibility } from "@/lib/policies/registryPolicyTypes";
import { reviewPeriodDays, reviewPeriodWeeks } from "@/lib/policies/reviewPeriod";
import { engineClassificationFor } from "@/lib/policies/engineBridge";
import { groupHasPrimary as groupHasPrimaryFor, groupKeyFor, lineNeedsInput, primaryGroupKeys } from "@/lib/policies/stageGuards";
import { ParameterSheet } from "./ParameterSheet";
import { supabase } from "@/integrations/supabase/client";
import { fetchProjectLanes } from "@/lib/policies/projectLanes";
import { useAuth } from "@/hooks/useAuth";
import { ValueChainPopover, type ValueChainTarget } from "@/components/policies/ValueChainPopover";
import { sourceFor } from "@/lib/trust/valueChain";
import { useGlobalProject } from "@/hooks/useGlobalProject";
import { useItemMasters } from "@/hooks/useItemMasters";
import { customerRowMasters, demandCellNote, fulfillmentCellNote } from "@/lib/policies/customerRows";
import { horizonWeeksOf } from "@/lib/policies/deliverySchedule";
import { DeliveryScheduleCell } from "./DeliveryScheduleEditor";
import { supplierLaneMasters } from "@/lib/policies/supplierLanes";
import { useProjectRights } from "@/hooks/useProjectRights";
import { useDerivedMaps } from "@/hooks/useDerivedMaps";
import { useTimeUnit } from "@/hooks/useTimeUnit";
import type { StageRowsQuery } from "@/hooks/useStageGuards";
import { qtyCellText, qtyPerAssemblyByMaterial } from "@/lib/policies/singleBomQty";
import type { StageKey } from "@/lib/policies/stages";

interface Props {
  projectId: string | null | undefined;
  plantName: string | null | undefined;
  stageKey: StageKey;
  defaults: PolicyBundle;
  overrides: OverrideRow[];
  fulfillmentStrategy: FulfillmentStrategy;
  /**
   * WP 6.3 · THE OPTIONS ARGUMENT WAS MISSING FROM THIS TYPE, AND ITS LAZY FIX
   * WOULD HAVE BEEN A SILENT DATA DEFECT.
   *
   * `usePolicies` declares `(rows, opts?: { seeded?: boolean })`; this prop
   * declared one parameter, so line 936's `bulkUpsertOverrides(toUpsert,
   * { seeded: true })` was a type error — baselined as debt on this surface.
   *
   * `{ seeded: true }` is WP 4.4's `seeded_from_hash`: the flag that makes a
   * prefilled override report itself STALE after a re-upload, because the engine
   * reads overrides rather than the grid. Deleting the second argument would have
   * made the error go away and stopped that flag being stamped — a green
   * typecheck bought by turning off D70's staleness machinery. The type widens to
   * match the hook instead.
   */
  bulkUpsertOverrides: (rows: OverrideRow[], opts?: { seeded?: boolean }) => Promise<void>;
  deleteOverride?: (scope: "node" | "edge", targetKey: string, family: PolicyFamily) => Promise<void>;
  /** Save a policy version snapshot — offered after saving grid edits. */
  saveSnapshot?: (label?: string) => Promise<string | null>;
  leftActions?: React.ReactNode;
  /** The stage's lines, loaded once at the page level (see useStageGuards). */
  stageRows: StageRowsQuery;
  /** §23 WP 13.4 — reports how many lines hold unsaved drafts. */
  onDraftsChange?: (lines: number) => void;
  /**
   * The stage's project-level settings, one line above the grid. Given what
   * only the grid knows: how many lines P-P.4's buffer is added to (an MTS
   * product on base-stock with an empty S) and how many customers the lines
   * name (P-C.2's rule is applied only between two or more).
   */
  ruleBar?: (state: { fgBufferRows: number; customerCount: number }) => React.ReactNode;
}

type RowDraft = Record<string, unknown>;

// Grid actions live on the left of the toolbar — keep the pointer's travel to
// their confirmation short.
const TOAST = { position: "bottom-left" } as const;

// Canonical ordering for family bands.
const FAMILY_ORDER: PolicyFamily[] = [
  "sourcing",
  "inventory",
  "transport",
  "production",
  "fulfillment",
  "demand",
];

/**
 * Frozen key-column widths, by viewport breakpoint (the ids carry the row's
 * identity). Both the `<col>` and the sticky `left` offset read the same
 * constant — never hard-code one and derive the other (columnFit.ts §0.2).
 */
const KEY_W = {
  wide: { a: 168, b: 132 }, // ≥1280
  mid: { a: 148, b: 116 }, // ≥1024
  narrow: { a: 132, b: 104 }, // <1024
} as const;

function keyWidthsFor(winWidth: number): { a: number; b: number } {
  if (winWidth >= 1280) return KEY_W.wide;
  if (winWidth >= 1024) return KEY_W.mid;
  return KEY_W.narrow;
}

/**
 * §4 D180 — the Supplier stage's BOM tree widens ONLY the Material key column,
 * and only while the tree is on screen: flat mode, single-level projects and
 * the other stages keep `KEY_W` exactly. One constant feeds both the `<col>`
 * and the sticky `left` (columnFit.ts §0.2); never below `KEY_W.*.a`.
 */
const TREE_KEY_W = {
  wide: 320, // ≥1280
  mid: 280, // ≥1024
  narrow: 240, // <1024
} as const;
/** The frozen "Qty / assy" column the tree adds right of Material. */
const TREE_QTY_W = 72;
/** Outline / Tabular: one column per level (Product, L0, L1, …). */
const TREE_LEVEL_W = [120, 100, 110, 170, 150, 220] as const;
const TREE_LEVEL_W_EXTRA = 150;
const treeLevelWidth = (i: number): number => TREE_LEVEL_W[i] ?? TREE_LEVEL_W_EXTRA;

function treeKeyWidthFor(winWidth: number): number {
  if (winWidth >= 1280) return TREE_KEY_W.wide;
  if (winWidth >= 1024) return TREE_KEY_W.mid;
  return TREE_KEY_W.narrow;
}

/** Per-project tree presentation prefs, beside `policy.table.collapsed.<stage>`. */
const TREE_PREFS_KEY = "policy.table.bomTree.supplier";
/** Every BOM-tree row is this tall (the "where used" panel excepted). */
const TREE_ROW_H = 30;
type TreePrefs = { layout: TreeLayout; repeat: boolean; level: number | "all" };
const TREE_PREFS_DEFAULT: TreePrefs = { layout: "compact", repeat: false, level: 2 };
function readTreePrefs(projectId: string | null | undefined): TreePrefs {
  if (!projectId || typeof window === "undefined") return TREE_PREFS_DEFAULT;
  try {
    const all = JSON.parse(localStorage.getItem(TREE_PREFS_KEY) ?? "{}") as Record<string, Partial<TreePrefs>>;
    const p = all[projectId] ?? {};
    return {
      layout: p.layout === "outline" || p.layout === "tabular" ? p.layout : "compact",
      repeat: p.repeat === true,
      level: p.level === "all" || (typeof p.level === "number" && p.level >= 0) ? p.level : 2,
    };
  } catch {
    return TREE_PREFS_DEFAULT;
  }
}
function writeTreePrefs(projectId: string | null | undefined, prefs: TreePrefs): void {
  if (!projectId || typeof window === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(TREE_PREFS_KEY) ?? "{}") as Record<string, TreePrefs>;
    all[projectId] = prefs;
    localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(all));
  } catch {
    /* noop — a preference, never state that must persist */
  }
}

/**
 * User-dragged column widths, per stage → column key (value columns by field,
 * key columns by their `KeyColDef.id`). A preference beside the family
 * collapse: presentation only, never read by a guard, a save or an export.
 */
const COL_WIDTHS_KEY = "policy.table.colWidths";
type ColWidths = Record<string, Record<string, number>>;
function readColWidths(): ColWidths {
  if (typeof window === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as ColWidths) : {};
  } catch {
    return {};
  }
}

const fmtQty = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(2);
const fmtFlow = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(2);

/** Short segmented labels for the inventory Policy Type (titles stay the
 *  registry library's own labels — "Min-max (s, S)", "(R, Q)", …). */
const POLICY_TYPE_SHORT: Record<string, string> = Object.fromEntries(
  POLICY_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

type CellKind = "readonly" | "segmented" | "select" | "toggle" | "number" | "text";

/** Supabase errors are plain objects, not Error instances — extract either. */
function errMsg(e: unknown, fallback: string): string {
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" && m ? m : fallback;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `fitColsForStage` reruns on every draft edit (drafts is in its deps via
 * rowCtxs), but the resolved *set* of visible columns only changes when an
 * edit actually flips a `visibleWhen` gate — not on every keystroke. Columns
 * are drawn from the static ColSpec definitions, so two calls describe the
 * same layout iff their `.key`s match in order. Reusing the previous
 * reference here lets `fit`, `bandGroups`, `visible` and `folded` below skip
 * recomputation on the vast majority of edits, which don't affect layout.
 */
function useStableColumnList(cols: FitCol[]): FitCol[] {
  const ref = useRef(cols);
  const prev = ref.current;
  const same =
    prev.length === cols.length && prev.every((c, i) => c.key === cols[i].key);
  if (!same) ref.current = cols;
  return ref.current;
}

export function StagePolicyTable({
  projectId,
  plantName,
  stageKey,
  defaults,
  overrides,
  fulfillmentStrategy,
  bulkUpsertOverrides,
  deleteOverride,
  saveSnapshot,
  leftActions,
  stageRows,
  onDraftsChange,
  ruleBar,
}: Props) {
  const spec = specFor(stageKey);
  // Memoized: a fresh array every render would move `rowEnv` and repaint every row.
  const families = useMemo(() => familiesForStage(stageKey), [stageKey]);
  const { rows: dataRows, loading, fallback, reload: reloadRows } = stageRows;
  const { adaptLabel: adaptUnitLabel, isDayField, fromDays } = useTimeUnit(projectId);
  const { user } = useAuth();
  const { selectedProject } = useGlobalProject();

  // Item masters are the BASE of the economics columns (ColSpec.master): the
  // grid shows materials.cost / products.sell_price / production_capacity /
  // demand_mean …, with the engine's derived fallback (≈) when unset, and an
  // edit is a policy override on top — /policies never writes a master (§23
  // WP 13.1). These rows are read here, never saved from here.
  const {
    materials,
    products,
    suppliers,
    derived: derivedEconomics,
    lanes,
    error: mastersError,
    canEditInputs,
    inputEditRefusal,
  } = useItemMasters(projectId);
  // The economics maps plus the capacity chain, which needs the bundle and its
  // overrides as well as the lanes — assembled by the one hook both grid
  // surfaces call, never per surface (§4 D167).
  const derived = useDerivedMaps({
    derived: derivedEconomics,
    products,
    outbound: lanes.outbound,
    inbound: lanes.inbound,
    materials: materials as unknown as Record<string, unknown>[],
    defaults,
    overrides,
  });
  const masterRowById = useMemo(
    () => ({
      materials: new Map(materials.map((m) => [m.material_id, m as unknown as Record<string, unknown>])),
      products: new Map(products.map((p) => [p.product_id, p as unknown as Record<string, unknown>])),
      suppliers: new Map(suppliers.map((s) => [s.supplier_id, s as unknown as Record<string, unknown>])),
      // PLAN.md §24 WP 14.2 — the Customer stage's base: each row's own demand
      // spec and its forecast series, keyed `<customer>::<product>`.
      outbound_logistics: customerRowMasters(lanes.outbound, lanes.forecasts),
      // WP 14.3 — the base under a Customer row's priority and service target.
      customers: new Map((lanes.customers ?? []).map((c) => [String(c.customer_id), c])),
      // The base under a Supplier row's lead time: each lane as the engine
      // builds its link, keyed `<supplier>::<material>`.
      inbound_logistics: supplierLaneMasters(lanes.inbound),
    }),
    [materials, products, suppliers, lanes.outbound, lanes.forecasts, lanes.customers, lanes.inbound],
  );
  const masterColByField = useMemo(() => {
    const m = new Map<string, ColSpec>();
    for (const c of specFor(stageKey).cols) if (c.master) m.set(c.field, c);
    return m;
  }, [stageKey]);
  // masterValueFor/derivedValueFor/getEffective delegate to
  // lib/policies/resolveEffective.ts — the single source of truth also used
  // by MobileStagePolicyList, so the two surfaces cannot disagree about a
  // line's own resolved value.
  const masterValueFor = (col: ColSpec, r: Record<string, unknown>): number | undefined =>
    masterValueForShared(col, r, masterRowById);
  // Suppliers the user can assign to an "(unassigned supplier)" material:
  // the suppliers master plus every supplier already sourcing in this stage.
  const knownSuppliers = useMemo(() => {
    const set = new Set<string>(suppliers.map((s) => s.supplier_id));
    for (const r of dataRows) {
      const sid = String((r as Record<string, unknown>).supplier_id ?? "");
      if (sid && !sid.startsWith("(")) set.add(sid);
    }
    return [...set].sort();
  }, [suppliers, dataRows]);
  const [assigning, setAssigning] = useState<string | null>(null);
  // Inline "new supplier" input state (per material row).
  const [newSupplierFor, setNewSupplierFor] = useState<string | null>(null);
  const [newSupplierId, setNewSupplierId] = useState("");
  const assignSupplier = useLatestCallback(async (materialId: string, supplierId: string) => {
    if (!projectId || !user) return;
    // D230 — assigning a supplier writes the input lanes: "Edit Input Data".
    if (!canEditInputs) {
      toast.error(inputEditRefusal ?? "You may not edit input data on this project.", TOAST);
      return;
    }
    setAssigning(materialId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    try {
      // Fast path: the dedicated RPC (creates lane + edge + supplier master).
      const { error } = await sb.rpc("assign_material_supplier", {
        p_project_id: projectId,
        p_material_id: materialId,
        p_supplier_id: supplierId,
        p_user_id: user.id,
        p_user_email: user.email,
      });
      if (error) throw error;
      toast.success(`Assigned ${supplierId} to ${materialId}`, TOAST);
      reloadRows();
    } catch (rpcErr) {
      // Fallback: the upload pipeline that provably works in every deployed
      // environment (same edge function the Data Manager uploads use), then a
      // combine so the supply-chain edge list picks the pair up.
      try {
        // The ingest edge function validates plant_name against the PROJECT
        // record (projects.plant_name) — which can differ from the plant name
        // stamped on older data rows. Prefer the project's registered plant,
        // then the page prop, then any existing lane as last resort.
        let plant =
          (selectedProject?.id === projectId ? selectedProject?.plant_name : null) ||
          (plantName && plantName !== "Focal plant" ? plantName : null);
        if (!plant) {
          const lanes = await fetchProjectLanes(projectId, user);
          plant = String(
            lanes.inbound[0]?.plant_name ?? lanes.outbound[0]?.plant_name ?? "",
          ) || null;
        }
        if (!plant) throw new Error("could not resolve the project's plant name");
        const { data, error: edgeErr } = await supabase.functions.invoke("ingest-inbound-logistics", {
          body: {
            rows: [{
              project_id: projectId,
              plant_name: plant,
              supplier_id: supplierId,
              material_id: materialId,
              volume: null,
              time_unit: null,
              lead_time: null,
              unit_price: null,
            }],
            userId: user.id,
            userEmail: user.email,
          },
        });
        if (edgeErr) {
          // FunctionsHttpError hides the response body — surface the real
          // error message the edge function returned.
          let detail = errMsg(edgeErr, "edge function failed");
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const body = await (edgeErr as any).context?.json?.();
            if (body?.error) detail = String(body.error);
          } catch { /* keep generic message */ }
          throw new Error(detail);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((data as any)?.success === false) {
          throw new Error(String((data as { error?: string })?.error ?? "upload failed"));
        }
        await sb.rpc("combine_project_into_supply_chain", {
          p_project_id: projectId,
          p_user_id: user.id,
          p_user_email: user.email,
        });
        toast.success(`Assigned ${supplierId} to ${materialId}`, TOAST);
        reloadRows();
      } catch (fallbackErr) {
        const msg = (e: unknown) => (e as { message?: string })?.message ?? String(e);
        toast.error(`Failed to assign supplier: ${msg(rpcErr)} · fallback: ${msg(fallbackErr)}`, TOAST);
      }
    } finally {
      setAssigning(null);
    }
  });

  const derivedValueFor = (col: ColSpec, r: Record<string, unknown>): number | undefined =>
    derivedValueForShared(col, r, derived);

  // Per-column "contains" filters (key = column id/field) + single active sort.
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});

  // Per-row flattened effective bundle (default + overrides), used by gates AND provenance.
  const rowEffective = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of dataRows) {
      m.set(String(r.key), flattenBundle(effectivePolicy(defaults, overrides, spec.scope, String(r.key))));
    }
    return m;
  }, [dataRows, defaults, overrides, spec.scope]);

  // The project's own MTS / MTO — the engine's fallback for a product that
  // states none (`projects.supply_chain_model`, §4 D197).
  const projectFulfillmentMode = projectFulfillmentModeOf(selectedProject?.supply_chain_model);
  // The run's length in weeks — the delivery-schedule editor's default size.
  const scheduleHorizonWeeks = horizonWeeksOf(selectedProject?.simulation_start, selectedProject?.simulation_end);

  // Build the per-row ColSpecCtx once, then compute the union for the header.
  // `resolved` carries the master-backed gate fields AS THE CELL SHOWS THEM
  // (draft → override → item master), so "does this product hold FG stock?"
  // is answered by the same chain the engine reads, not by the bundle.
  //
  // INCREMENTAL ON THE DRAFT. A draft replaces ONE row's object (`onCellChange`),
  // yet this map was rebuilt for every row on every edit — `rowGateCtx` is a
  // dozen resolver calls per row. A row's context is a function of its own draft
  // and of the non-draft inputs below, so a row is reused when its draft object
  // is the one it was built from and none of those inputs moved.
  const gateCache = useRef<{
    inputs: readonly unknown[];
    byKey: Map<string, { draft: RowDraft | undefined; ctx: ColSpecCtx }>;
  } | null>(null);
  const rowCtxByKey = useMemo(() => {
    const inputs = [
      dataRows, fulfillmentStrategy, rowEffective, masterColByField, masterRowById, derived,
      defaults, overrides, spec.scope, projectFulfillmentMode, stageKey,
    ];
    const prev = gateCache.current;
    const reusable = !!prev && prev.inputs.length === inputs.length && prev.inputs.every((v, i) => Object.is(v, inputs[i]));
    const built = new Map<string, { draft: RowDraft | undefined; ctx: ColSpecCtx }>();
    const m = new Map<string, ColSpecCtx>();
    for (const r of dataRows) {
      const rowKey = String(r.key);
      const draft = drafts[rowKey];
      const hit = reusable ? prev!.byKey.get(rowKey) : undefined;
      let ctx: ColSpecCtx;
      if (hit && hit.draft === draft) {
        ctx = hit.ctx;
      } else {
        ctx = rowGateCtx({
          rowKey, row: r as Record<string, unknown>, draft, fulfillmentStrategy,
          effective: rowEffective.get(rowKey), projectFulfillmentMode, families, masterColByField,
          masterRowById, derived, defaults, overrides, scope: spec.scope,
        });
      }
      built.set(rowKey, { draft, ctx });
      m.set(rowKey, ctx);
    }
    gateCache.current = { inputs, byKey: built };
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `families` is derived from stageKey
  }, [dataRows, drafts, fulfillmentStrategy, rowEffective, masterColByField, masterRowById, derived, defaults, overrides, spec.scope, projectFulfillmentMode]);
  const rowCtxs: ColSpecCtx[] = useMemo(() => [...rowCtxByKey.values()], [rowCtxByKey]);
  const ruleBarState = useMemo(
    () => ({
      fgBufferRows: stageKey === "plant" ? rowCtxs.filter(fgBufferAppliesToRow).length : 0,
      customerCount: new Set(
        dataRows.map((r) => String((r as Record<string, unknown>).customer_id ?? "")).filter(Boolean),
      ).size,
    }),
    [stageKey, rowCtxs, dataRows],
  );

  // Fit/render metadata for the header union (columnFit.ts, joined by field).
  const fitColsRaw = useMemo(() => fitColsForStage(stageKey, rowCtxs), [stageKey, rowCtxs]);
  const fitCols = useStableColumnList(fitColsRaw);

  // Every family that has at least one column at this stage, in canonical
  // order — independent of fold/collapse state, so the toolbar always offers
  // every family a chip.
  const familiesPresent = useMemo(() => {
    const set = new Set<PolicyFamily>();
    for (const c of fitCols) set.add(c.family);
    return FAMILY_ORDER.filter((f) => set.has(f));
  }, [fitCols]);

  // Per-stage collapsed family set persisted in localStorage.
  const collapseKey = `policy.table.collapsed.${stageKey}`;
  // 6.B — per-parameter transparency side-sheet (opened from a column header).
  const [paramSheetCol, setParamSheetCol] = useState<ColSpec | null>(null);

  const [collapsed, setCollapsed] = useState<Set<PolicyFamily>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem(collapseKey);
      return raw ? new Set(JSON.parse(raw) as PolicyFamily[]) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(collapseKey, JSON.stringify(Array.from(collapsed)));
    } catch {
      /* noop */
    }
  }, [collapseKey, collapsed]);
  const toggleFamily = (f: PolicyFamily) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const collapsedFamilies = useMemo(
    () => Object.fromEntries([...collapsed].map((f) => [f, true])),
    [collapsed],
  );

  // Column widths the user dragged, persisted per stage.
  const [allColWidths, setAllColWidths] = useState<ColWidths>(readColWidths);
  useEffect(() => {
    try {
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(allColWidths));
    } catch {
      /* noop */
    }
  }, [allColWidths]);
  const colWidths = useMemo(() => allColWidths[stageKey] ?? {}, [allColWidths, stageKey]);
  const setColWidth = (key: string, w: number) =>
    setAllColWidths((cur) => ({ ...cur, [stageKey]: { ...(cur[stageKey] ?? {}), [key]: clampColWidth(w) } }));
  const resetColWidth = (key: string) =>
    setAllColWidths((cur) => {
      const { [key]: _drop, ...rest } = cur[stageKey] ?? {};
      return { ...cur, [stageKey]: rest };
    });
  const resetAllColWidths = () =>
    setAllColWidths((cur) => {
      const { [stageKey]: _drop, ...rest } = cur;
      return rest;
    });
  const resizeHandle = (key: string, label: string) => (
    <ColResizeHandle label={label} onResize={(w) => setColWidth(key, w)} onReset={() => resetColWidth(key)} />
  );

  // Row-group collapse (§5) — a material's suppliers, a plant's products, a
  // customer's product lanes. State resets per stage on purpose (§5 note).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => {
    setCollapsedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Responsive chrome: the frozen key-column breakpoint and the family
  // summary column's narrow variant both key off the viewport, not the grid
  // container (columnFit.ts §3.1 / §1 narrow flag).
  const [winWidth, setWinWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const keyW = keyWidthsFor(winWidth);
  const narrowFamily = winWidth < 860;

  // Fit-fold: `enabled=false` means "show all columns", scrolling
  // horizontally instead of folding. Observe the scroll container's
  // offsetWidth (not clientWidth — that shrinks when a vertical scrollbar
  // appears, which the fold itself can cause, oscillating).
  const [fitEnabled, setFitEnabled] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Row windowing for the flat grid: only the rows in (or near) the scroll
  // viewport are mounted; spacer rows keep the scroll height. `rowH` is measured
  // from a rendered row, so wrapped or taller rows only skew the spacers.
  const [win, setWin] = useState({ top: 0, h: 700 });
  const [rowH, setRowH] = useState(27);
  const winRaf = useRef<number | null>(null);
  const onGridScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (winRaf.current !== null) return;
    winRaf.current = requestAnimationFrame(() => {
      winRaf.current = null;
      setWin((w) => (Math.abs(w.top - el.scrollTop) < rowH * 2 && w.h === el.clientHeight ? w : { top: el.scrollTop, h: el.clientHeight }));
    });
  };
  useEffect(() => () => {
    if (winRaf.current !== null) cancelAnimationFrame(winRaf.current);
  }, []);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // §4 D177 / D180 — the Supplier stage's BOM tree (multi-level projects
  // only). Presentation only: the flat rows every guard, prefill, verifier and
  // export reads pass through `buildBomTreeModel` untouched (each exactly
  // once) — the model orders them, interleaves read-only structural rows built
  // from the upload's shape and the derived lane's numbers, and decides which
  // are OPEN. An active column sort shows the flat view (the tree has its own
  // order). Declared before the column fit because the tree's key block is
  // wider than the flat one, and the fit must know it.
  const treeAvailable =
    stageKey === "supplier" && (stageRows.bomLevel ?? "").includes("multi");
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const treeWanted = treeAvailable && viewMode === "tree" && sort === null;
  // §4 D178 — the tree may never blank the grid. The build is guarded (no
  // error boundary protects this render path), and a tree with no structure
  // while flat rows exist falls back to the flat lanes WITH the reason.
  const treeBuild = useMemo<{ model: BomTreeModel | null; error: string | null }>(() => {
    if (!treeWanted) return { model: null, error: null };
    try {
      return {
        model: buildBomTreeModel({
          bomRows: stageRows.bomRows ?? [],
          deepRows: stageRows.deepRows ?? [],
          supplierRows: dataRows as Array<Record<string, unknown> & { key: string }>,
        }),
        error: null,
      };
    } catch (err) {
      return { model: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [treeWanted, stageRows.bomRows, stageRows.deepRows, dataRows]);
  const treeFallback = treeFallbackReason({
    wanted: treeWanted,
    buildError: treeBuild.error,
    hasStructure: (treeBuild.model?.occs.length ?? 0) > 0,
    flatRowCount: dataRows.length,
    deepError: stageRows.deepError ?? null,
  });
  const treeActive = treeWanted && treeFallback === null && treeBuild.model !== null;
  const treeModel = treeActive ? treeBuild.model : null;

  const [treePrefs, setTreePrefsState] = useState<TreePrefs>(() => readTreePrefs(projectId));
  useEffect(() => {
    setTreePrefsState(readTreePrefs(projectId));
  }, [projectId]);
  const setTreePrefs = (patch: Partial<TreePrefs>) =>
    setTreePrefsState((cur) => {
      const next = { ...cur, ...patch };
      writeTreePrefs(projectId, next);
      return next;
    });
  const treeLayout: TreeLayout = treePrefs.layout;
  const treePivot = treeActive && treeLayout !== "compact";
  const treeLevelCount = treeModel ? treeModel.maxDepth + 1 : 0;

  // The key block, one definition for the <col>s, the sticky offsets and the
  // cells. Flat (and every other stage) is exactly the two `KEY_W` columns.
  type KeyColDef = { id: string; w: number; left: number | null };
  const treeKeyA = treeKeyWidthFor(winWidth);
  // Qty per assembly on a SINGLE-level BOM (the tree has its own column):
  // a frozen key column between Material and Supplier, from the uploaded
  // bom_single_level rows read by the engine's rule (singleBomQty.ts).
  const qtyByMaterial = useMemo(
    () => qtyPerAssemblyByMaterial(stageRows.singleBomRows ?? []),
    [stageRows.singleBomRows],
  );
  const flatQty = stageKey === "supplier" && !treeActive && qtyByMaterial.size > 0;
  /** Flat key column `i` of `spec.keyCols` → its index in `keyDefs`. */
  const keyIdx = (i: number) => (flatQty && i > 0 ? i + 1 : i);
  const designKeyDefs: KeyColDef[] = useMemo(() => {
    if (!treeActive) {
      const flat = spec.keyCols.map((c, i) => ({ id: c.id, w: i === 0 ? keyW.a : keyW.b, left: i === 0 ? 0 : keyW.a }));
      if (!flatQty) return flat;
      return [flat[0], { id: "__qty", w: TREE_QTY_W, left: keyW.a }, ...flat.slice(1)];
    }
    const supplierCol = spec.keyCols[1]?.id ?? "supplier_id";
    if (!treePivot) {
      return [
        { id: "__tree", w: treeKeyA, left: 0 },
        { id: "__qty", w: TREE_QTY_W, left: treeKeyA },
        { id: supplierCol, w: keyW.b, left: treeKeyA + TREE_QTY_W },
      ];
    }
    // Outline / Tabular: the level block is ~1 074 px on AA-ver3, too wide to
    // freeze — it scrolls with the values (handoff §3).
    return [
      ...Array.from({ length: treeLevelCount }, (_, i) => ({ id: `__lvl${i}`, w: treeLevelWidth(i), left: null })),
      { id: "__qty", w: TREE_QTY_W, left: null },
      { id: supplierCol, w: keyW.b, left: null },
    ];
  }, [treeActive, treePivot, treeKeyA, treeLevelCount, keyW.a, keyW.b, spec.keyCols, flatQty]);
  // User widths replace the design width; the sticky `left` offsets are then
  // re-accumulated from the widths actually rendered (columnFit.ts §0.2).
  const keyDefs: KeyColDef[] = useMemo(() => {
    let left = 0;
    return designKeyDefs.map((d) => {
      const user = colWidths[d.id];
      const w = typeof user === "number" ? clampColWidth(user) : d.w;
      const out = { ...d, w, left: d.left === null ? null : left };
      left += w;
      return out;
    });
  }, [designKeyDefs, colWidths]);
  const keyBlockW = keyDefs.reduce((a, d) => a + d.w, 0);

  const avail = Math.max(0, containerW - 2 - 24 - (treePivot ? 0 : keyBlockW));
  const fit = useMemo(
    () =>
      fitColumns({
        cols: fitCols,
        avail,
        collapsedFamilies,
        enabled: fitEnabled,
        narrow: narrowFamily,
        widths: colWidths,
      }),
    [fitCols, avail, collapsedFamilies, fitEnabled, narrowFamily, colWidths],
  );
  const { visible, folded, fills } = fit;
  const totalCols = visible.length + folded.length;

  // Band groups: contiguous same-family runs of the currently visible
  // columns (declaration order already groups by family, so a partial fold
  // never interleaves two families).
  const bandGroups = useMemo(() => {
    const out: { family: PolicyFamily; cols: FitCol[] }[] = [];
    for (const c of visible) {
      const last = out[out.length - 1];
      if (last && last.family === c.family) last.cols.push(c);
      else out.push({ family: c.family, cols: [c] });
    }
    return out;
  }, [visible]);

  // Frozen key columns: cumulative left offsets from the breakpoint widths.
  const keyWidths = keyDefs.map((d) => d.w);
  const keyLeft = (i: number) => keyDefs[i]?.left ?? 0;
  const keyTotal = keyBlockW;
  const tableMinWidth = keyTotal + fit.valueWidth;

  // Reset drafts + filters/sort/group-collapse when stage / project changes.
  useEffect(() => {
    setDrafts({});
    setColFilters({});
    setSort(null);
    setCollapsedGroups(new Set());
  }, [stageKey, projectId]);

  /** Effective value lookup: data prefill → override → default.
   *  Master-backed columns resolve draft → item-master value → derived fallback.
   *  `family` is the column's declared family: when a field name is shared across
   *  families, resolve it from the column's OWN family first so the value matches
   *  the header (otherwise the flattened first-wins order could show a sibling
   *  family's value under the wrong label). */
  const getEffective = (
    rowKey: string,
    dataRow: Record<string, unknown>,
    field: string,
    family?: PolicyFamily,
  ): unknown =>
    getEffectiveValueShared({
      rowKey,
      dataRow,
      field,
      family,
      families,
      draft: drafts[rowKey]?.[field],
      masterColByField,
      masterRowById,
      derived,
      defaults,
      overrides,
      scope: spec.scope,
    });

  const getDefault = (field: string, family: PolicyFamily): unknown =>
    ((defaults[family] ?? {}) as Record<string, unknown>)[field];

  /** Saved-state + draft resolver shared with the step track's guardrail. */
  const resolveForGuard = (row: Record<string, unknown>, field: string): unknown =>
    getEffective(String(row.key), row, field);

  // Which primary-source groups already have a primary picked, answered ONCE per
  // change to what the guard resolves from. `groupHasPrimary` used to scan every
  // row for every multi-source row (rows × rows × overrides per render). The
  // deps are exactly the inputs of `getEffective`, which `resolveForGuard` reads.
  const primaryGroups = useMemo(
    () => primaryGroupKeys(stageKey, dataRows as Record<string, unknown>[], resolveForGuard),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `resolveForGuard` closes over the deps listed
    [stageKey, dataRows, drafts, families, masterColByField, masterRowById, derived, defaults, overrides, spec.scope],
  );

  // Full field→col map (includes vectorized inventory params hidden from the
  // header) so save/prefill can resolve a param's family even though it renders
  // inside the "Replenishment parameters" vector cell rather than its own column.
  const specColByField = useMemo(() => {
    const m = new Map<string, ColSpec>();
    for (const c of specFor(stageKey).cols) m.set(c.field, c);
    return m;
  }, [stageKey]);

  // The type-specific inventory params grouped into the per-row vector cell.
  const invParamColByField = useMemo(() => {
    const m = new Map<string, ColSpec>();
    for (const c of vectorParamCols(stageKey)) m.set(c.field, c);
    return m;
  }, [stageKey]);
  // The FG levels grouped into the Plant row's vector cell (WP 16.6).
  const fgParamColByField = useMemo(() => {
    const m = new Map<string, ColSpec>();
    for (const c of fgVectorParamCols(stageKey)) m.set(c.field, c);
    return m;
  }, [stageKey]);

  /** Enum choices for a column, with the registry's own labels for Policy Type. */
  const enumOptionsFor = (
    col: ColSpec,
  ): Array<{ value: string; label: string; title?: string }> | null => {
    const opts = SCSIM_ENUM_OPTIONS[col.field] ?? ENUM_OPTIONS[col.field];
    if (!opts) return null;
    if (col.field === "type" && col.family === "inventory") {
      return opts.map((o) => ({
        value: o,
        label: POLICY_TYPE_SHORT[o] ?? o,
        title: policyTypeLabel("inventory", o),
      }));
    }
    if (col.field === "row_demand_mode") {
      return opts.map((o) => ({
        value: o,
        label: o,
        title: o === "forecast"
          ? "Forecast — the row plans week by week on its uploaded series; the distribution adds spread around it"
          : o === "schedule"
            ? "Schedule — the customer's requested delivery schedule: you enter the quantity for each week, and the run uses it exactly"
            : "Model — a constant mean per week, drawn from the distribution below",
      }));
    }
    if (col.field === "fulfillment_mode") {
      return opts.map((o) => ({
        value: o,
        label: o.toUpperCase(),
        title: o === "mts" ? "Make to stock — holds FG inventory; the FG policy applies" : "Make to order — no FG inventory",
      }));
    }
    return opts.map((o) => ({ value: o, label: o }));
  };

  /**
   * The dynamic "Replenishment parameters" cell (§II.3): only the params the
   * row's chosen policy type needs, each as symbol + input. The per-row Policy
   * Basis control is hidden while the line uses the default basis — it repeated
   * identically on every line.
   */
  /** §23 WP 13.4 — the engine's own answer for a vector parameter on this stage. */
  const notSimulatedNote = (field: string): string | undefined => {
    const c = invParamColByField.get(field);
    return c ? noteOf(cellEngineRead(stageKey, c)) : undefined;
  };

  const renderInvParamsCell = (rowKey: string, r: Record<string, unknown>, paramW?: number) => {
    const type = String(getEffective(rowKey, r, "type", "inventory") ?? "min_max");
    const regParams = inventoryParamsForType(type).filter((p) => p.field !== "basis");
    const basis = String(getEffective(rowKey, r, "basis", "inventory") ?? "days_of_supply");

    // The engine's own default band, computed from the row's data with the
    // engine formulas (P-P.1 Eqs. 2–3): s = E[D]·T_s, S = E[D]·(T_s+κ), each
    // PLUS the safety stock P-P.3 adds to a formula level. An EMPTY level cell
    // resolves to these in the run, so they render as the greyed placeholder —
    // the global policy made visible per row. A number typed into the cell
    // becomes THIS material's level, exactly: no safety stock is added on top
    // of it and nothing raises it (inventory_control.material_overrides).
    // The lane's lead time as the engine reads it — the row's override, else the
    // uploaded lane, else the engine's declared default — in weeks already.
    const ltRaw = Number(
      getEffective(rowKey, r, "lead_time_weeks", "sourcing") ??
        masterOverrideRule("sourcing", "lead_time_weeks")?.emptyDefault,
    );
    const ltWeeks = Number.isFinite(ltRaw) && ltRaw > 0 ? ltRaw : undefined;
    const dWeek = Number((r as Record<string, unknown>).__mat_demand_per_week);
    const kappaRaw = Number(getEffective(rowKey, r, "coverage_weeks", "inventory"));
    const kappa = Number.isFinite(kappaRaw) ? kappaRaw : 8;
    const canCompute = ltWeeks !== undefined && Number.isFinite(dWeek) && dWeek > 0;
    // The safety stock the run adds to a formula level. Days-based — the row's
    // own safety-stock days, else the project's when its method is fixed days
    // — it is E[D]·days/7 and the placeholder includes it. A service-level or
    // King buffer needs σ and z the page does not hold, so the hover says the
    // run adds it rather than the page inventing a number.
    const rowSsDays = drafts[rowKey]?.safety_stock_days
      ?? savedOverrideValue(overrides, rowKey, "safety_stock_days", "inventory", families);
    const ssMethod = String(getDefault("safety_stock_method", "inventory") ?? "fixed_days");
    const daysBased = rowSsDays != null || (engineClassificationFor(ssMethod) ?? "fixed_days") === "fixed_days";
    const ssDays = Number(rowSsDays ?? getDefault("safety_stock_days", "inventory") ?? 7);
    const ssUnits = daysBased && canCompute && Number.isFinite(ssDays) ? (dWeek * ssDays) / 7 : 0;
    const sDefault = canCompute ? dWeek * ltWeeks! + ssUnits : undefined;
    const SDefault = canCompute ? dWeek * (ltWeeks! + kappa) + ssUnits : undefined;
    const fmt = (n: number | undefined) => (n === undefined ? undefined : String(Math.round(n)));
    const placeholderFor: Record<string, string | undefined> = {
      reorder_point: fmt(sDefault),
      order_up_to: fmt(SDefault),
    };
    const ssNote = !canCompute
      ? undefined
      : daysBased
        ? `includes ${Math.round(ssUnits)} safety stock (${ssDays} d); a typed value is used exactly`
        : "plus the service-level safety stock the run sizes; a typed value is used exactly";
    const placeholderNoteFor: Record<string, string | undefined> = {
      reorder_point: ssNote,
      order_up_to: ssNote,
    };

    // Level cells resolve ROW-SCOPE only (draft → this row's saved override):
    // the family bundle always carries the Zod defaults (50/200), which the
    // engine never reads at project scope — showing them as the value would
    // repeat the defect where the grid said one number and the run used
    // another. Empty cell = the formula placeholder above. A stored Q ≤ 0 is
    // the schema's UNSET marker, not a zero lot (the mapping skips it).
    const LEVEL_FIELDS = new Set(["reorder_point", "order_up_to"]);
    const valueFor = (field: string): unknown => {
      if (LEVEL_FIELDS.has(field)) {
        const draft = drafts[rowKey]?.[field];
        if (draft !== undefined) return draft;
        return savedOverrideValue(overrides, rowKey, field, "inventory", families);
      }
      const v = getEffective(rowKey, r, field, "inventory");
      if (field === "rop_q_quantity") {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      }
      return v;
    };

    return (
      <ReplenishmentCell
        policyType={type}
        paramW={paramW}
        params={regParams.map((p) => {
          const value = valueFor(p.field);
          const n = typeof value === "number" ? value : value == null ? undefined : Number(value);
          // T is typed and shown in WEEKS and stored as `review_period_days`
          // (reviewPeriod.ts — the one boundary). What shows is the whole-week
          // cadence the run uses, so 60 stored days read as 9, as the mapper says.
          const isReview = p.field === "review_period_days";
          const stored = n !== undefined && Number.isFinite(n) ? n : undefined;
          return {
            field: p.field,
            value: isReview && stored !== undefined ? reviewPeriodWeeks(stored) : stored,
            onCommit: (v: number | undefined) =>
              onCellChange(
                rowKey,
                p.field,
                isReview && v !== undefined && Number.isFinite(v) ? reviewPeriodDays(v) : v,
              ),
            invalid:
              paramFeasibility(p, value ?? undefined) ??
              (p.field === "rop_q_quantity" && n === undefined
                ? "(R,Q) needs a lot size Q — the run orders Q each time the position falls below R"
                : undefined),
            placeholder: placeholderFor[p.field],
            placeholderNote: placeholderNoteFor[p.field],
            notSimulated: notSimulatedNote(p.field),
          };
        })}
        labelFor={(f) =>
          f === "review_period_days"
            ? "Review period T (weeks)"
            : adaptLabel(invParamColByField.get(f)?.label ?? f, f)
        }
        basis={basis as "days_of_supply" | "forward_visible"}
        onBasisChange={(b) => onCellChange(rowKey, "basis", b)}
        basisNotSimulated={notSimulatedNote("basis")}
      />
    );
  };

  /**
   * The Plant row's FG "Replenishment parameters" cell (PLAN.md §26 WP 16.6,
   * §4 D301) — the Supplier stage's layout for the FG policy: only the levels
   * the row's FG policy reads (`FG_POLICY_PARAMS`, gated like `fgPolicyIn`).
   * Each level is still the master-backed cell it was: its value and source
   * come from the one resolver, a typed value saves as this row's override, and
   * clearing it resets to the item master (`null`, §23 WP 13.1).
   */
  const renderFgInvParamsCell = (
    rowKey: string,
    r: Record<string, unknown>,
    rowCtx: ColSpecCtx,
    paramW?: number,
  ) => {
    const policy = String(rowCtx.resolved?.fg_policy || "base_stock");
    const paramSpec = FG_POLICY_PARAMS[policy] ?? FG_POLICY_PARAMS.base_stock;
    return (
      <ReplenishmentCell
        policyType={policy}
        paramSpec={paramSpec}
        paramW={paramW}
        emptyNote={{ label: "—", title: "This FG policy reads no level" }}
        params={paramSpec.map(({ field }) => {
          const col = fgParamColByField.get(field)!;
          const cell = resolveCell({
            rowKey, row: r, col, draft: drafts[rowKey]?.[field], families, masterColByField,
            masterRowById, derived, defaults, overrides, scope: spec.scope, familyDefault: getDefault,
            gate: rowCtx,
          });
          const v = typeof cell.value === "number" ? cell.value : undefined;
          return {
            field,
            value: cell.provenance === "contract" ? undefined : v,
            onCommit: (n: number | undefined) => onCellChange(rowKey, field, n === undefined ? null : n),
            placeholder: cell.placeholder,
            placeholderNote: cell.placeholderTitle,
            source: cell.provenance,
            sourceTitle: substitutionNote(cell) ?? PROVENANCE[cell.provenance]?.title,
          };
        })}
        labelFor={(f) => fgParamColByField.get(f)?.label ?? f}
        basis="days_of_supply"
        onBasisChange={() => undefined}
      />
    );
  };

  // Detect whether a row currently has any existing override (vs default).
  const hasOverride = (rowKey: string): boolean =>
    overridesForTarget(overrides, rowKey).length > 0;

  /** Comparable cell value for any column (key col or value col). */
  const cellValueFor = (r: Record<string, unknown>, colId: string): unknown => {
    if (spec.keyCols.some((c) => c.id === colId)) return r[colId];
    const spec2 = specFor(stageKey).cols.find((c) => c.field === colId);
    if (spec2?.synthetic) return ""; // vector cell — not sortable/filterable
    return getEffective(String(r.key), r, colId, spec2?.family);
  };

  /** Toggle sort on a column: asc → desc → none. */
  const toggleSort = (colId: string) => {
    setSort((cur) => {
      if (!cur || cur.col !== colId) return { col: colId, dir: "asc" };
      if (cur.dir === "asc") return { col: colId, dir: "desc" };
      return null;
    });
  };

  const setColFilter = (colId: string, v: string) =>
    setColFilters((f) => ({ ...f, [colId]: v }));

  const hasActiveQuery =
    sort !== null || Object.values(colFilters).some((v) => v.trim() !== "");

  // §4 D180 — in the tree the Material filter OPENS the path to every match;
  // it never removes a row (handoff §5). Every other column's filter keeps
  // today's behaviour, and so does the Material filter in the flat view.
  const materialColId = spec.keyCols[0]?.id ?? "";
  const materialFilter = treeActive ? (colFilters[materialColId] ?? "") : "";
  const filtered = useMemo(() => {
    const active = Object.entries(colFilters).filter(
      ([colId, v]) => v.trim() !== "" && !(treeActive && colId === materialColId),
    );
    let out = dataRows;
    if (active.length > 0) {
      out = dataRows.filter((r) =>
        active.every(([colId, q]) =>
          String(cellValueFor(r as Record<string, unknown>, colId) ?? "")
            .toLowerCase()
            .includes(q.trim().toLowerCase()),
        ),
      );
    }
    if (sort) {
      out = [...out].sort((a, b) => {
        const av = cellValueFor(a as Record<string, unknown>, sort.col);
        const bv = cellValueFor(b as Record<string, unknown>, sort.col);
        const an = typeof av === "number" ? av : Number(av);
        const bn = typeof bv === "number" ? bv : Number(bv);
        let cmp: number;
        if (Number.isFinite(an) && Number.isFinite(bn)) {
          cmp = an - bn;
        } else {
          cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        }
        return sort.dir === "desc" ? -cmp : cmp;
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRows, colFilters, sort, drafts, overrides, spec.keyCols, treeActive]);

  // Row-group collapse (§5): consecutive runs sharing key A — a material's
  // suppliers, a plant's products, a customer's product lanes. An active sort
  // that scrambles key-A order degrades gracefully to singleton "groups",
  // which simply offer nothing to collapse.
  const rowGroups = useMemo(
    () => groupByKeyA(filtered as Record<string, unknown>[], spec.keyCols[0]?.id ?? ""),
    [filtered, spec.keyCols],
  );

  // ── §4 D180 — tree presentation state (all of it presentation-only) ──────
  // `null` = "the expand-to level decides" (the first render of a project
  // already shows the L2 default, no flash); a user's own expand/collapse
  // replaces it and is kept across rebuilds (occurrence keys are paths).
  const [treeOpenState, setTreeOpenState] = useState<Set<string> | null>(null);
  const [whereOpen, setWhereOpen] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  useEffect(() => {
    setTreeOpenState(null);
    setWhereOpen(null);
    setJumpTarget(null);
  }, [projectId]);
  const treeOpen = useMemo(
    () => treeOpenState ?? (treeModel ? expandToLevel(treeModel, treePrefs.level) : new Set<string>()),
    [treeOpenState, treeModel, treePrefs.level],
  );
  const setTreeOpen = (f: (cur: Set<string>) => Set<string>) =>
    setTreeOpenState((cur) => f(cur ?? treeOpen));
  const expandTreeTo = (level: number | "all") => {
    setTreePrefs({ level });
    if (treeModel) setTreeOpenState(expandToLevel(treeModel, level));
  };
  const toggleTreeOcc = (key: string) =>
    setTreeOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const jumpToOcc = (key: string) => {
    if (!treeModel) return;
    setTreeOpen((cur) => {
      const next = new Set(cur);
      for (const k of revealKeys(treeModel, key)) next.add(k);
      return next;
    });
    setJumpTarget(key);
  };
  useEffect(() => {
    if (!jumpTarget) return;
    const el = scrollRef.current?.querySelector(`[data-occ="${CSS.escape(jumpTarget)}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "center" });
      return;
    }
    // The tree is windowed, so the row may not be mounted yet: scroll to where it will be.
    const host = scrollRef.current;
    const at = treeVisible.rows.findIndex((v) => (v.t === "node" || v.t === "lane") && v.occ?.key === jumpTarget);
    if (host && at >= 0) host.scrollTop = scrollTopFor(treeRowHeights, at, host.clientHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when the target or the open set moves
  }, [jumpTarget, treeOpen]);

  const treeReveal = useMemo(
    () => (treeModel ? revealForFilter(treeModel, materialFilter) : { open: new Set<string>(), matches: new Set<string>() }),
    [treeModel, materialFilter],
  );
  const treeVisible = useMemo(() => {
    if (!treeModel) return { rows: [] as VisRow[], shownLines: 0 };
    const open = new Set([...treeOpen, ...treeReveal.open]);
    const v = visibleTreeRows(treeModel, { open, layout: treeLayout, whereOpen });
    // Other columns' filters thin supplier lines exactly as in the flat view;
    // the structure (and each sub-assembly's own line) always stays.
    if (filtered.length === dataRows.length) return v;
    const keep = new Set(filtered.map((r) => String(r.key)));
    const rows = v.rows.filter((r) => r.t !== "lane" || keep.has(String(r.row.key)));
    return { rows, shownLines: v.shownLines - (v.rows.length - rows.length) };
  }, [treeModel, treeOpen, treeReveal, treeLayout, whereOpen, filtered, dataRows.length]);
  // Row heights for the tree's windowing: every row is TREE_ROW_H tall except the "where used"
  // panel, whose height depends on its parents — estimated, since it only skews the spacers.
  const treeRowHeights = useMemo(
    () => treeVisible.rows.map((v) => (v.t === "where" ? 132 : TREE_ROW_H)),
    [treeVisible],
  );

  // Facts per material from the WHOLE flat set (never the filtered view):
  // how many suppliers, whether any line lacks one, and how many lines carry
  // an uploaded lead time. Read from the rows `useStageRows` built.
  const treeMaterialFacts = useMemo(() => {
    const m = new Map<string, { suppliers: number; unassigned: boolean; lines: number; leadMissing: number }>();
    if (!treeActive) return m;
    for (const r of dataRows as Array<Record<string, unknown>>) {
      const id = String(r.material_id ?? "");
      const f = m.get(id) ?? { suppliers: 0, unassigned: false, lines: 0, leadMissing: 0 };
      if (r.__needs_supplier) f.unassigned = true;
      else if (!r.__in_house) {
        f.suppliers += 1;
        f.lines += 1;
        // The lane as the engine builds it: `null` is a blank upload.
        const lane = masterRowById.inbound_logistics?.get(`${String(r.supplier_id ?? "")}::${id}`);
        if (lane?.lead_time == null) f.leadMissing += 1;
      }
      m.set(id, f);
    }
    return m;
  }, [treeActive, dataRows, masterRowById]);
  const collapsibleGroups = useMemo(() => rowGroups.filter((g) => g.members.length > 1), [rowGroups]);
  const anyGroupExpanded = collapsibleGroups.some((g) => !collapsedGroups.has(`${stageKey}::${g.id}`));
  const toggleAllGroups = () => {
    if (anyGroupExpanded) {
      setCollapsedGroups((cur) => {
        const next = new Set(cur);
        for (const g of collapsibleGroups) next.add(`${stageKey}::${g.id}`);
        return next;
      });
    } else {
      setCollapsedGroups((cur) => {
        const next = new Set(cur);
        for (const g of collapsibleGroups) next.delete(`${stageKey}::${g.id}`);
        return next;
      });
    }
  };

  const dirtyKeys = Object.keys(drafts).filter((k) => Object.keys(drafts[k] ?? {}).length > 0);
  // §23 WP 13.4 — the page asks before a stage switch or navigation drops these.
  useEffect(() => {
    onDraftsChange?.(dirtyKeys.length);
  }, [dirtyKeys.length, onDraftsChange]);
  useEffect(() => () => onDraftsChange?.(0), [onDraftsChange]);

  const onCellChange = useLatestCallback((rowKey: string, field: string, v: unknown) => {
    // The grid is not virtualized, so a draft re-renders every row. A transition
    // lets React yield to the next keystroke / click instead of blocking on it.
    startTransition(() => setDrafts((d) => {
      const next: Record<string, RowDraft> = {
        ...d,
        [rowKey]: { ...(d[rowKey] ?? {}), [field]: v },
      };
      // Mutual exclusion: only one primary per material / per (customer, product).
      if (field === "primary_source" && v === true) {
        const me = dataRows.find((row) => row.key === rowKey);
        const gk = me ? groupKeyFor(stageKey, me as Record<string, unknown>) : null;
        if (gk) {
          for (const other of dataRows) {
            if (other.key === rowKey) continue;
            if (groupKeyFor(stageKey, other as Record<string, unknown>) !== gk) continue;
            const cur = getEffective(String(other.key), other as Record<string, unknown>, "primary_source");
            if (cur === true) {
              next[String(other.key)] = {
                ...(next[String(other.key)] ?? {}),
                primary_source: false,
              };
            }
          }
        }
      }
      return next;
    }));
  });

  const saveAll = async () => {
    if (dirtyKeys.length === 0) return;
    // §23 WP 13.1 — /policies NEVER writes the item masters. Every value saved
    // here, a master-backed cost, MOQ, capacity, price or demand included, is a
    // POLICY OVERRIDE in the policy version; the engine reads it ahead of the
    // master (`masterOverrides.ts`). And every row is written as its FULL patch
    // — the saved one with this save applied on top — because the RPC replaces a
    // row's patch and a partial one deleted the row's other saved fields (§4 D281).
    const plan: SavePlan = new Map();
    for (const rowKey of dirtyKeys) {
      const draft = drafts[rowKey];
      const dataRow = dataRows.find((row) => row.key === rowKey) as
        | Record<string, unknown>
        | undefined;
      for (const [field, v] of Object.entries(draft)) {
        // Resolve from the FULL spec (not the header union) so vectorized
        // inventory params — which render inside the vector cell, not their own
        // column — still save under their family.
        const col = specColByField.get(field);
        if (!col || col.synthetic) continue;
        const rule = col.master ? masterOverrideRule(col.family, col.field) : undefined;
        if (col.master && rule && dataRow) {
          const id = masterIdOf(col, dataRow);
          if (!id) continue;
          const siblings = dataRows
            .filter((row) => masterIdOf(col, row as Record<string, unknown>) === id)
            .map((row) => String(row.key));
          // `null` (or a cleared cell) is *reset to master*: the key leaves every
          // row of the entity. A value equal to the base with no override saved
          // is not an override at all — nothing to store.
          // An ENUM master (the Customer row's distribution, WP 14.2) saves its
          // token as the engine reads it; every other master saves a number.
          const enumCell = isEnumMaster(col);
          const n =
            v === null || v === undefined || v === ""
              ? null
              : enumCell
                ? normalizeEnumToken(v)
                : Number(v);
          const base = enumCell
            ? masterRawFor(col, dataRow, masterRowById)
            : masterBaseFor(col, dataRow, masterRowById, derived);
          const saved = masterOverrideFor(col, dataRow, overrides, masterRowById);
          if (n !== null && !saved && base !== undefined && isEqual(n, base)) continue;
          if (n === null && !saved) continue;
          planEntityOverride({ plan, overrides, rule, editedKey: rowKey, rowKeysOfEntity: siblings, value: n });
          continue;
        }
        if (v === undefined) continue;
        const def = getDefault(field, col.family);
        // ── "EQUAL TO THE DEFAULT" IS NOT ALWAYS A NO-OP (§4 D23) ──────────
        //
        // Skipping an edit that matches the family default keeps the bundle
        // clean: an override restating the default is noise, and writing one is
        // how §4 D1 froze decisions nobody made. But it is only a no-op when the
        // default is what the cell would SHOW after the skip, and there are two
        // cases where it is not:
        //
        //   · a saved override already carries a different value for this field,
        //     so dropping the edit leaves the STALE override in place. Setting
        //     `primary_source` back to `false` looked saved and reloaded as
        //     `true`, because `false` is the schema default (`schemas.ts:81`).
        //   · the field is a routing DECISION, so the row's own suggestion is
        //     what shows when no override exists — not the default. Un-checking
        //     the suggested primary wrote nothing and changed nothing.
        //
        // Both are the same user action — un-checking a primary supplier — and
        // it was unsaveable either way.
        const overridden = overrides.some(
          (o) => o.target_key === rowKey && o.family === col.family && field in (o.patch ?? {}),
        );
        const isDecision = ((dataRow?.__decided ?? {}) as Record<string, true>)[field] === true;
        if (isEqual(v, def) && !overridden && !isDecision) continue;
        planPatch(plan, overrides, spec.scope, rowKey, col.family)[field] = v;
      }
    }
    const { upserts: toUpsert, deletes } = settlePlan(plan, spec.scope);
    if (toUpsert.length === 0 && deletes.length === 0) {
      setDrafts({});
      toast.info("No effective changes to save.", TOAST);
      return;
    }
    try {
      if (toUpsert.length > 0) await bulkUpsertOverrides(toUpsert);
      if (deletes.length > 0) {
        if (!deleteOverride) throw new Error("this page cannot remove a saved override");
        for (const d of deletes) await deleteOverride(d.scope, d.target_key, d.family);
      }
    } catch (e) {
      // Surface RPC failures instead of swallowing them — the click handler has
      // no other catch. A D230 refusal was already said by the hook that refused it.
      if (!(e instanceof ProjectRightRefused)) {
        toast.error(errMsg(e, "Failed to save changes"), TOAST);
      }
      return;
    }
    setDrafts({});
    // Offer to capture the edit as a version right away: every /policies edit
    // is policy state (the policy version snapshot), which a run binds to.
    toast.success(`Saved ${dirtyKeys.length} line(s)`, {
      ...TOAST,
      action: {
        label: "Save version",
        onClick: () => {
          void (async () => {
            try {
              if (saveSnapshot) await saveSnapshot("Grid edits");
              toast.success("Version saved", TOAST);
            } catch (e) {
              toast.error(errMsg(e, "Failed to save version"), TOAST);
            }
          })();
        },
      },
    });
  };

  const revertAll = () => setDrafts({});

  // Confirm dialog for "Apply prefill" (writes a lot of rows at once).
  const [confirmPrefill, setConfirmPrefill] = useState(false);
  const [applying, setApplying] = useState(false);
  /** A prefill has run for the current (project, stage) — see `dataBannerState`. */
  const [prefillSettled, setPrefillSettled] = useState(false);
  const policyRights = useProjectRights(projectId);
  const canSeedPolicies = policyRights.can("data_edit_policies");
  useEffect(() => {
    setPrefillSettled(false);
  }, [projectId, stageKey]);

  // Bulk reset: delete every saved override targeting a row in this stage.
  // Clears stale values frozen by the old auto-seed (e.g. 0-prices) so the
  // grid shows pure project data + bundle defaults again.
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [resetting, setResetting] = useState(false);
  const stageOverrides = useMemo(() => {
    const keys = new Set(dataRows.map((r) => String(r.key)));
    return overrides.filter((o) => keys.has(o.target_key));
  }, [overrides, dataRows]);
  const resetAllOverrides = async () => {
    if (!deleteOverride || stageOverrides.length === 0) {
      setConfirmResetAll(false);
      return;
    }
    setResetting(true);
    try {
      for (const o of stageOverrides) {
        await deleteOverride(spec.scope, o.target_key, o.family);
      }
      setDrafts({});
      toast.success(`Removed ${stageOverrides.length} saved override(s)`, TOAST);
    } catch (e) {
      toast.error(errMsg(e, "Failed to reset overrides"), TOAST);
    } finally {
      setResetting(false);
      setConfirmResetAll(false);
    }
  };

  // Whether the prefill has anything to persist: a field backed by uploaded
  // data OR a routing decision the stage derived from the uploads. Asked of
  // `rowHasSeedableField` (which derives from `prefillSourceFor`), not read
  // off `__from_data` directly — that narrower reading made the auto-seed
  // unreachable on the customer stage, whose only persistable fields are
  // `__decided` routing (§4 D23), so the suggested primary sourcing firm
  // never reached the saved bundle the pre-run gate reads (blueprint G16).
  const hasSeedableData = useMemo(
    () => dataRows.some((r) => rowHasSeedableField(r as Record<string, unknown>)),
    [dataRows],
  );
  // Whether any override already targets a row in this stage.
  const hasOverridesForStage = useMemo(
    () => {
      const keys = new Set(dataRows.map((r) => r.key));
      return overrides.some((o) => keys.has(o.target_key));
    },
    [overrides, dataRows],
  );

  /**
   * Persist the project-data prefill (+ any unsaved edits) as saved override
   * rows for every resolved row in the current stage. Rows still missing a
   * supplier / primary are skipped so we never lock in bad data.
   */
  const applyPrefill = async (opts: { silent?: boolean } = {}) => {
    // Armed BEFORE the row loop, not after it: the auto-seed effect below
    // re-runs on every `dataRows` identity change, and with the flag raised
    // only at the upsert it had an open window to re-enter and seed twice.
    setApplying(true);
    try {
      await runPrefill(opts);
    } finally {
      setApplying(false);
      setConfirmPrefill(false);
    }
  };

  const runPrefill = async ({ silent = false }: { silent?: boolean }) => {
    // D230 — the prefill writes policy overrides: "Edit Policies" on this project.
    if (!canSeedPolicies) {
      if (!silent) toast.error(policyRights.refusal("data_edit_policies") ?? "You may not change policies on this project.", TOAST);
      return;
    }
    const toUpsert: OverrideRow[] = [];
    let written = 0;
    let skipped = 0;
    for (const row of dataRows) {
      const r = row as Record<string, unknown>;
      const rowKey = String(r.key);
      if (rowNeedsAttention(r)) {
        skipped++;
        continue;
      }
      const byFamily = new Map<PolicyFamily, Record<string, unknown>>();
      // Iterate the FULL spec (incl. vectorized inventory params rendered in the
      // vector cell), honoring each col's per-row gate so only params the row's
      // policy type actually uses are persisted.
      for (const col of specFor(stageKey).cols) {
        if (col.synthetic || col.readOnly) continue;
        // Master-backed fields live in the item masters, never in overrides.
        if (col.master) continue;
        if (col.visibleWhen && !col.visibleWhen(rowCtxByKey.get(rowKey) ?? { row: r }))
          continue;
        // D1 — persist ONLY what the project data or the user actually says;
        // never a value that would come from a default. Imputed averages stay
        // excluded. The rule is `isPrefillPersistable`, unit-tested.
        if (!isPrefillPersistable(r, col.field, (drafts[rowKey] ?? {})[col.field]))
          continue;
        // draft → project-data prefill → effective default
        const v = getEffective(rowKey, r, col.field, col.family);
        if (v === undefined || v === null) continue;
        const bucket = byFamily.get(col.family) ?? {};
        bucket[col.field] = v;
        byFamily.set(col.family, bucket);
      }
      let touched = false;
      for (const [family, patch] of byFamily.entries()) {
        if (Object.keys(patch).length === 0) continue;
        toUpsert.push({ scope: spec.scope, target_key: rowKey, family, patch });
        touched = true;
      }
      if (touched) written++;
    }
    if (toUpsert.length === 0) {
      // Nothing the uploaded data can answer for this stage's columns. Say so
      // in the banner rather than leaving "uploaded data not applied" standing
      // over a stage where there is nothing left to apply.
      setPrefillSettled(true);
      if (!silent) toast.info("Nothing to persist", TOAST);
      return;
    }
    // WP 4.4 · SEEDED. These values are copies of numbers the project's data had
    // at this moment, not decisions somebody made, so the RPC stamps
    // `seeded_from_hash` and a later re-upload reports them stale. The engine
    // reads overrides rather than the grid, so that flag is what stops a run
    // silently using a number the project no longer holds.
    await bulkUpsertOverrides(toUpsert, { seeded: true });
    setDrafts({});
    setPrefillSettled(true);
    if (!silent)
      toast.success(
        `Persisted prefill for ${written} line(s)` + (skipped > 0 ? ` · ${skipped} skipped` : ""),
        TOAST,
      );
  };

  // Auto-seed: project data loaded for the first time with no existing overrides.
  // The marker is a SET, not one slot: holding a single `${projectId}::${stageKey}`
  // meant a supplier → plant → supplier tab round trip overwrote the supplier
  // marker with the plant one, so returning to supplier re-seeded it.
  const autoSeededRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const marker = `${projectId}::${stageKey}`;
    if (autoSeededRef.current.has(marker)) return;
    // D230 — wait for the rights before marking: a seed skipped while they load would
    // never be retried, and one the person may not write is not attempted at all.
    if (!canSeedPolicies) return;
    if (loading || applying || dataRows.length === 0) return;
    if (!hasSeedableData || hasOverridesForStage) return;
    autoSeededRef.current.add(marker);
    // An effect body cannot await; it does not need to. `applyPrefill` raises
    // `applying` synchronously before it touches a row, and this effect's own
    // guard reads it, so the whole write is covered. The seed is silent — the
    // user did not ask for it, so it does not toast.
    void applyPrefill({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, applying, dataRows, hasSeedableData, hasOverridesForStage, canSeedPolicies]);

  // Banner state: derived from project data presence + override existence.
  const dataBannerState = useMemo(():
    | "no_data"
    | "seeding"
    | "seeded"
    | "none_applicable"
    | "pending" => {
    if (!hasSeedableData) return "no_data";
    if (applying) return "seeding";
    if (hasOverridesForStage) return "seeded";
    // Prefill has run and the uploaded data had nothing to say about any of
    // this stage's columns. "Not applied" would be a standing instruction to
    // press a button that does nothing.
    if (prefillSettled) return "none_applicable";
    return "pending";
  }, [hasSeedableData, applying, hasOverridesForStage, prefillSettled]);

  /** Reset one row: drop drafts + delete all saved overrides on that row. */
  const resetRow = useLatestCallback(async (rowKey: string) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[rowKey];
      return next;
    });
    if (!deleteOverride) return;
    const rowOverrides = overrides.filter((o) => o.target_key === rowKey);
    for (const o of rowOverrides) {
      await deleteOverride(spec.scope, rowKey, o.family);
    }
    if (rowOverrides.length > 0) toast.success("Reverted to project data", TOAST);
  });

  /** Does the primary-source group for this row already have a chosen primary? */
  const groupHasPrimary = (r: Record<string, unknown>): boolean =>
    groupHasPrimaryFor(stageKey, r, dataRows as Record<string, unknown>[], resolveForGuard, primaryGroups);

  /** Line needs the user's input — the same rule the step track counts. */
  const rowNeedsAttention = (r: Record<string, unknown>): boolean =>
    lineNeedsInput(stageKey, r, dataRows as Record<string, unknown>[], resolveForGuard, primaryGroups);

  const imputedLines = useMemo(
    () =>
      dataRows.filter(
        (r: any) => r.__imputed && Object.keys(r.__imputed).length > 0,
      ).length,
    [dataRows],
  );

  // A label may name the planning unit (weeks) only where the VALUE under it is
  // converted too — today that is the read-only columns, whose display divides
  // by the unit's days below. Editable day-stored fields keep their "(days)"
  // label: relabelling them without converting what is typed would show a day
  // count under a week header.
  const adaptLabel = (label: string, field?: string) =>
    field && specColByField.get(field)?.readOnly && isDayField(field) ? adaptUnitLabel(label) : label;

  /** Which control a column's value renders as. */
  const kindOf = (
    col: ColSpec,
    opts: ReturnType<typeof enumOptionsFor>,
    firms: string[] | undefined,
    value: unknown,
    liveDefault: unknown,
  ): CellKind => {
    if (col.readOnly) return "readonly";
    if (col.field === "sourcing_firm" && firms && firms.length > 0)
      return firms.length <= 4 ? "segmented" : "select";
    if (opts) return opts.length <= 4 ? "segmented" : "select";
    if (typeof liveDefault === "boolean" || typeof value === "boolean") return "toggle";
    // A master column whose empty state is DECLARED has `liveDefault ===
    // undefined` by construction (§4 D17 — the fix is precisely that it no longer
    // invents a `0`), so the numeric probe below cannot see that the column is
    // numeric and the cell would silently become a text input. `nullMeans` is
    // only ever declared on a numeric master column; `columnNullMeans.test.ts`
    // is the gate that keeps that true.
    if (col.master?.nullMeans) return "number";
    if (typeof liveDefault === "number" || typeof value === "number") return "number";
    return "text";
  };

  const colCount = keyDefs.length + visible.length;

  /** The outermost column carries no right rule (§0.4) — it would otherwise
   *  spring a permanent 2px horizontal scrollbar. */
  const cellDivider = (isLastCol: boolean): React.CSSProperties => ({
    borderRight: isLastCol ? "none" : "1px solid var(--hair-divider)",
  });

  /** The material-level flags a line carries in its Material cell — shared by
   *  the flat cell and the BOM tree's cell (§4 D180), so the two cannot drift. */
  const materialFlags = (
    r: Record<string, unknown>,
    rowKey: string,
    overrode: boolean,
    isDirty: boolean,
  ): React.ReactNode => (
      <>
        {/* material-level required actions */}
        {r.__needs_supplier && (
          <RowFlag title="This material has no supplier in the project data — assign one in the Supplier column.">
            needs supplier
          </RowFlag>
        )}
        {/* §4 D175 — the two material classes this stage used to hide. */}
        {r.__in_house && (
          <RowFlag title="Consumed by another BOM item and produced from its own components — modeled through the BOM. There is no supplier to configure; sourcing does not apply to this line.">
            made in-house
          </RowFlag>
        )}
        {r.__not_in_bom && (
          <RowFlag title="In the item master but in no BOM and no inbound lane. The pre-run check blocks a simulation while such a row exists — assign a supplier lane, add it to the BOM, or remove the master row.">
            not in BOM
          </RowFlag>
        )}
        {
          !r.__needs_supplier &&
          Number(r.__lane_count ?? 0) > 1 &&
          !groupHasPrimary(r) && (
            <RowFlag title="Multiple sources — pick exactly one primary.">pick primary</RowFlag>
          )}
        {/* Per-row reset (drafts + saved overrides) */}
        {deleteOverride && (overrode || isDirty) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              resetRow(rowKey);
            }}
            className="shrink-0 font-mono text-[9.5px] text-[#c4c4c4] opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
            title="Revert this line to project data"
          >
            ↺
          </button>
        )}
      </>
  );

  /**
   * §4 D180 — a tree row reuses this row UNCHANGED from the Supplier column
   * rightwards; the tree supplies the Material-side cells (the indented tree
   * cell or the level columns, then Qty / assy). `flags` are this row's own
   * material-level flags, handed back so the tree cell can carry them.
   */
  type TreeRowCtx = {
    occKey?: string;
    cellsBefore: (o: { accent: string | null; flags: React.ReactNode }) => React.ReactNode;
    /** A sub-assembly's line: the engine reads no per-intermediate policy (D18's class). */
    readOnlyValues?: boolean;
    trStyle?: React.CSSProperties;
  };

  /** Flat, single-level BOM: the "Qty / assy" cell for one material. */
  const flatQtyTd = (materialId: string, bgClass: string) => {
    const q = qtyCellText(qtyByMaterial.get(materialId));
    const d = keyDefs[1];
    return (
      <td
        key="__qty"
        className={cn(
          "sticky z-20 border-b border-r border-[--hair-divider] px-2 py-[3px] text-right text-[12px] tabular-nums",
          bgClass,
        )}
        style={{ left: d.left ?? undefined, width: d.w, minWidth: d.w, maxWidth: d.w }}
        title={q.title}
      >
        <span className="block truncate" style={{ color: q.defaulted || q.text === "—" ? "#a1a1aa" : "#18181b" }}>
          {q.text}
          {q.defaulted && <span className="ml-0.5 text-[9px]">·def</span>}
        </span>
      </td>
    );
  };
  /** Its header: the tree's label, "per product" since the parent is always the product. */
  const flatQtyTh = () => {
    const d = keyDefs[1];
    return (
      <th
        key="__qty"
        className="sticky top-[23px] z-40 bg-[--brand-ink] p-0 align-top"
        style={{ left: d.left ?? undefined, width: d.w, minWidth: d.w }}
      >
        <div
          className="flex h-full flex-col items-end justify-start gap-px px-1.5 py-1 text-right font-mono text-white"
          style={{ borderRight: "1px solid rgba(255,255,255,0.22)" }}
          title="Units of this material per unit of finished product, from the single-level BOM. A blank or 0 rate runs as 1 (engine rule)."
        >
          <span className="text-[10px] font-medium uppercase leading-[1.2] tracking-[0.08em]">Qty / assy</span>
          <span className="text-[9px] leading-[1.2] text-white/55">per product</span>
        </div>
        {resizeHandle("__qty", "Qty / assy")}
      </th>
    );
  };

  /** One data row (§5.1 — plain or a group's expanded member). */
  const WINDOW_MIN_ROWS = 80;
  const OVERSCAN = 12;
  const windowRows = (rows: React.ReactNode[]): React.ReactNode[] => {
    if (rows.length < WINDOW_MIN_ROWS) return rows;
    const first = Math.max(0, Math.floor(win.top / rowH) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((win.top + win.h) / rowH) + OVERSCAN);
    const out: React.ReactNode[] = [];
    if (first > 0) {
      out.push(
        <tr key="__win_top" aria-hidden>
          <td colSpan={colCount} style={{ height: first * rowH, padding: 0, border: 0 }} />
        </tr>,
      );
    }
    for (let i = first; i < last; i++) out.push(rows[i]);
    if (last < rows.length) {
      out.push(
        <tr key="__win_bot" aria-hidden>
          <td colSpan={colCount} style={{ height: (rows.length - last) * rowH, padding: 0, border: 0 }} />
        </tr>,
      );
    }
    return out;
  };
  // Measure one real data row once the grid has painted.
  useEffect(() => {
    const tr = scrollRef.current?.querySelector<HTMLTableRowElement>("tbody tr.group");
    const h = tr?.getBoundingClientRect().height;
    if (h && Math.abs(h - rowH) > 1) setRowH(Math.round(h));
  }, [rowH, win.top, filtered.length]);

  const renderRow = (
    r: Record<string, unknown>,
    groupMeta?: { isFirstOfGroup: boolean; isContinuation: boolean; groupId: string },
    tree?: TreeRowCtx,
  ) => {
    const rowKey = String(r.key);
    const isDirty = (drafts[rowKey] && Object.keys(drafts[rowKey]).length > 0) ?? false;
    const overrode = hasOverride(rowKey);
    const attention = rowNeedsAttention(r);
    // Multi-source pairs stay marked permanently for review, even
    // once a primary is chosen.
    const isMultiSource = Number(r.__lane_count ?? 0) > 1;
    const accent = rowAccent({ edited: isDirty, attention, multiSource: isMultiSource });
    const supplierDef = tree ? keyDefs[keyDefs.length - 1] : null;
    return (
      <tr key={rowKey} className="group" data-occ={tree?.occKey} style={tree?.trStyle}>
        {tree?.cellsBefore({ accent: accent ?? null, flags: materialFlags(r, rowKey, overrode, isDirty) })}
        {spec.keyCols.map((c, i) => tree && i === 0 ? null : (
          <Fragment key={c.id}>
          {i === 1 && flatQty && !tree && flatQtyTd(String(r.material_id ?? ""), "bg-background group-hover:bg-[#fafafa]")}
          <td
            className={cn(
              (!supplierDef || supplierDef.left !== null) && "sticky z-20",
              "border-b border-r border-[--hair-divider] bg-background px-2 py-[3px] font-mono text-[11px] group-hover:bg-[#fafafa]",
              i === spec.keyCols.length - 1 && "border-r-[--hair-border]",
              tree && r.__in_house && "text-[#71717a]",
            )}
            style={{
              left: supplierDef ? (supplierDef.left ?? undefined) : keyLeft(keyIdx(i)),
              width: supplierDef ? supplierDef.w : keyWidths[keyIdx(i)],
              minWidth: supplierDef ? supplierDef.w : keyWidths[keyIdx(i)],
              maxWidth: supplierDef ? supplierDef.w : keyWidths[keyIdx(i)],
              ...(i === 0 && accent ? { borderLeft: `2px solid ${accent}` } : {}),
            }}
          >
            <span className="flex items-center gap-1.5">
              {i === 0 && groupMeta?.isFirstOfGroup && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGroup(groupMeta.groupId);
                  }}
                  className="-m-[14px] box-content grid h-[15px] w-[15px] shrink-0 place-items-center p-[14px] font-mono text-[10px] text-muted-foreground hover:text-foreground md:m-0 md:p-0"
                  title="Collapse this group"
                >
                  ▾
                </button>
              )}
              {i === 0 && groupMeta?.isContinuation ? (
                // Continuation member of a group: key A is the same id as the
                // row above, and it is STILL WRITTEN — every line names its own
                // material (owner-directed, §4 D179). A bare ↳ in place of the
                // id made a one-line material look like another material's
                // supplier; the ↳ and the lighter tone now only mark the group.
                <span
                  className="flex min-w-[62px] flex-1 items-center gap-1 truncate text-[#8a8a8a]"
                  title={String(r[c.id] ?? "")}
                >
                  <span className="shrink-0 text-[10px] text-[#c4c4c4]">↳</span>
                  <span className="truncate">{String(r[c.id] ?? "")}</span>
                </span>
              ) : c.id === "supplier_id" && r.__needs_supplier ? (
                newSupplierFor === rowKey ? (
                  // Typing a brand-new supplier id: Enter confirms,
                  // Escape cancels.
                  <Input
                    autoFocus
                    value={newSupplierId}
                    placeholder="new supplier id"
                    className="h-5 border-[--zinc-border] px-1.5 font-mono text-[11px]"
                    disabled={assigning === String(r.material_id)}
                    onChange={(e) => setNewSupplierId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setNewSupplierFor(null);
                        setNewSupplierId("");
                      }
                      if (e.key === "Enter") {
                        const id = newSupplierId.trim();
                        if (!id || id.startsWith("(")) {
                          toast.warning("Enter a valid supplier id.", TOAST);
                          return;
                        }
                        setNewSupplierFor(null);
                        setNewSupplierId("");
                        void assignSupplier(String(r.material_id), id);
                      }
                    }}
                    onBlur={() => {
                      setNewSupplierFor(null);
                      setNewSupplierId("");
                    }}
                  />
                ) : (
                  // Unassigned material: pick (or create) a supplier —
                  // creates the sourcing lane.
                  <Select
                    disabled={assigning === String(r.material_id)}
                    onValueChange={(v) => {
                      if (v === "__new__") {
                        setNewSupplierFor(rowKey);
                        setNewSupplierId("");
                        return;
                      }
                      void assignSupplier(String(r.material_id), v);
                    }}
                  >
                    <SelectTrigger
                      className="h-5 w-full px-1.5 font-mono text-[10.5px]"
                      style={{ borderColor: LAYER.brand, color: LAYER.brand }}
                    >
                      <SelectValue
                        placeholder={assigning === String(r.material_id) ? "assigning…" : "assign supplier"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__new__" className="text-xs font-medium">
                        + new supplier
                      </SelectItem>
                      {knownSuppliers.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )
              ) : (
                <span className="min-w-[62px] flex-1 truncate" title={String(r[c.id] ?? "")}>
                  {String(r[c.id] ?? "")}
                </span>
              )}

              {i === 0 && materialFlags(r, rowKey, overrode, isDirty)}
              {c.id === "product_id" && r.__unknown_product && (
                <span
                  title="Not found in BOM"
                  className="shrink-0 rounded-sm px-1 font-mono text-[9px]"
                  style={{ background: tint(LAYER.firm, 0.12), color: LAYER.firm }}
                >
                  !
                </span>
              )}
              {/* "set firm" only when the customer product has no known firms in data. */}
              {i === spec.keyCols.length - 1 &&
                stageKey === "customer" &&
                (!r.__firms_available || (r.__firms_available as string[]).length === 0) &&
                !getEffective(rowKey, r, "sourcing_firm") && (
                  <RowFlag title="No firms detected for this product — type a sourcing firm">set firm</RowFlag>
                )}
            </span>
          </td>
          </Fragment>
        ))}

        {visible.map((fc, fi) => {
          const isLastCol = fi === visible.length - 1;
          const width = fills && isLastCol ? undefined : fc.w;
          if (tree?.readOnlyValues) {
            // §4 D180 — a sub-assembly's line in the tree: nothing to set.
            // The engine flattens the BOM to product → purchased material and
            // reads no policy for an intermediate (D18's class), so a value
            // here would be a control that changes nothing.
            return (
              <td
                key={fc.key}
                className="border-b bg-[#fafafa]"
                style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
                title="Read-only — the engine reads no policy for a sub-assembly; it is modelled through its components"
              />
            );
          }
          if (fc.foldedFamily) {
            return (
              <td
                key={fc.key}
                className="border-b bg-[#fcfcfc]"
                style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
              />
            );
          }
          const col = specColByField.get(fc.key);
          if (!col) return null;
          const rowDraft = drafts[rowKey] ?? {};
          const eff = rowEffective.get(rowKey);
          const rowCtx: ColSpecCtx =
            rowCtxByKey.get(rowKey) ?? { fulfillmentStrategy, row: r, draft: rowDraft, effective: eff };
          // A product built to order holds no FG stock, so none of its FG cells
          // is read: they render as ONE sentence across the band, not a row of
          // dashes that look like values someone forgot to type.
          if (isFgDependentCol(col) && rowFulfillmentMode(rowCtx) !== "mts") {
            const fgAt = (j: number) => {
              const n = visible[j];
              const nc = n && !n.foldedFamily ? specColByField.get(n.key) : undefined;
              return !!nc && isFgDependentCol(nc);
            };
            if (fgAt(fi - 1)) return null;
            let span = 1;
            let spanW = fc.w;
            while (fgAt(fi + span)) {
              spanW += visible[fi + span].w;
              span++;
            }
            const spanLast = fi + span - 1 === visible.length - 1;
            const spanWidth = fills && spanLast ? undefined : spanW;
            return (
              <td
                key={col.field}
                colSpan={span}
                className="border-b px-2 font-mono text-[10px] text-[#b4b4b4]"
                style={{ width: spanWidth, minWidth: spanWidth, ...cellDivider(spanLast) }}
                title="Made to order — this product holds no finished-goods inventory, so no FG policy is read. Switch FG inventory to MTS to set one."
              >
                made to order · no FG inventory
              </td>
            );
          }
          // per-row gating: hide cells whose policy choice doesn't apply
          const isVisibleForRow = !col.visibleWhen || col.visibleWhen(rowCtx);
          if (!isVisibleForRow) {
            return (
              <td
                key={col.field}
                className="border-b p-0 text-center font-mono text-[10px] text-[#dcdcdc]"
                style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
                title="Not applicable for the current policy choice"
              >
                —
              </td>
            );
          }
          // The Plant row's FG "Replenishment parameters" cell (WP 16.6).
          if (col.synthetic && col.field === "__fg_inv_params") {
            return (
              <td
                key={col.field}
                className="border-b p-0 align-middle group-hover:bg-[#fafafa]"
                style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
              >
                {renderFgInvParamsCell(rowKey, r, rowCtx, fc.paramW)}
              </td>
            );
          }
          // The Customer row's requested delivery schedule: an array, edited in
          // its own dialog (one input per week), saved as the row's override.
          if (col.field === "row_demand_schedule") {
            const draftSched = rowDraft[col.field];
            const schedEdited = draftSched !== undefined;
            const saved = overridesForTarget(overrides, rowKey).some(
              (o) => o.family === "demand" && col.field in (o.patch ?? {}),
            );
            return (
              <td
                key={col.field}
                className="relative overflow-hidden border-b px-1 py-[3px] align-middle group-hover:bg-[#fafafa]"
                style={{
                  width,
                  minWidth: width,
                  ...cellDivider(isLastCol),
                  ...(schedEdited ? { background: "rgba(17,17,17,0.04)" } : {}),
                }}
              >
                <ProvenanceDot p={schedEdited ? "edited" : saved ? "override" : "default"} />
                <DeliveryScheduleCell
                  value={schedEdited ? draftSched : eff?.row_demand_schedule}
                  horizonWeeks={scheduleHorizonWeeks}
                  weekOneStart={selectedProject?.simulation_start}
                  rowLabel={`${String(r.customer_id ?? "")} · ${String(r.product_id ?? "")}`}
                  onCommit={(v) => onCellChange(rowKey, col.field, v)}
                />
              </td>
            );
          }
          // The dynamic "Replenishment parameters" vector cell.
          if (col.synthetic && col.field === "__inv_params") {
            return (
              <td
                key={col.field}
                className="border-b p-0 align-middle group-hover:bg-[#fafafa]"
                style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
              >
                {renderInvParamsCell(rowKey, r, fc.paramW)}
              </td>
            );
          }
          // ONE RESOLVER (WP 6.2). This was a verbatim copy of
          // `resolveEffective.ts::resolveCell` — masterSet, derivedVal,
          // liveDefault, the provenance ladder, all of it — carried in lockstep
          // since WP 0.1 with a comment in each copy telling the reader to
          // change both. That is `single-source` (I1) broken in the one place
          // the product decides what a number MEANS, and D26 is the record of
          // what the shape costs: two implementations of the D1 prefill rule,
          // both unit-tested, one dead, the suite green while only one ran.
          const resolved = resolveCell({
            rowKey,
            row: r,
            col,
            draft: rowDraft[col.field],
            families,
            masterColByField,
            masterRowById,
            derived,
            defaults,
            overrides,
            scope: spec.scope,
            familyDefault: getDefault,
            // A bounded lane's Lead time is its bounds' mean (PLAN.md §26 WP 16.3).
            gate: rowCtxByKey.get(rowKey),
          });
          const {
            cellValue, liveDefault, provenance: prov, edited,
            placeholder: cellPlaceholder, placeholderTitle, supersededBy,
          } = resolved;
          // T1/T2 — one sentence, assembled from the registry's own chain, used
          // by the hover AND by the popover so the two cannot disagree about
          // what stood in for this number (§4 D167).
          const demandNote = demandCellNote(
            col.field,
            col.field === "row_demand_variation"
              ? getEffective(rowKey, r, "row_demand_distribution", "demand")
              : undefined,
          );
          const fulfilNote = fulfillmentCellNote(col.field, cellValue ?? liveDefault);
          const substitution =
            [substitutionNote(resolved), demandNote, fulfilNote].filter(Boolean).join(" ") || undefined;

          const firms = r.__firms_available as string[] | undefined;
          const opts = enumOptionsFor(col);
          // A bounded lane's Lead time is its bounds' mean (§26.2 rule 3): the
          // engine reads no typed value there, so the cell is not an input.
          const kind =
            resolved.derivedVia?.via === "lead_time_bounds_mean"
              ? "readonly"
              : kindOf(col, opts, firms, cellValue, liveDefault);
          // A cleared master-backed cell is *reset to master* (§23 WP 13.1):
          // `null` removes the override on save, `undefined` would be no edit.
          // A column the engine rounds (`ColSpec.round`, the lane lead time) is
          // rounded here too, so the cell shows the value that runs.
          const commit = (v: unknown) =>
            onCellChange(
              rowKey,
              col.field,
              col.master && v === undefined
                ? null
                : col.round && typeof v === "number" && Number.isFinite(v)
                  ? col.round(v)
                  : v,
            );
          const rowDraftValue = rowDraft[col.field];
          const canResetToMaster =
            !!col.master &&
            (rowDraftValue === null
              ? false
              : rowDraftValue !== undefined || !!resolved.hasOverride);

          return (
            <td
              key={col.field}
              className="relative overflow-hidden border-b px-1 py-[3px] align-middle group-hover:bg-[#fafafa]"
              style={{
                width,
                minWidth: width,
                ...cellDivider(isLastCol),
                ...(edited ? { background: "rgba(17,17,17,0.04)" } : {}),
              }}
            >
              {kind !== "number" && <ProvenanceDot p={prov} />}

              {kind === "readonly" && (
                <span
                  title={col.engineStatus ? `Activates with ${col.engineStatus.milestone}` : substitution}
                  className="block w-full px-[5px] text-right font-mono text-[11px] tabular-nums text-[#c4c4c4]"
                  style={supersededBy ? { textDecoration: "line-through", opacity: 0.6 } : undefined}
                >
                  {(() => {
                    const raw = cellValue ?? liveDefault;
                    const stored = typeof raw === "number" ? raw : null;
                    // Day-stored read-only values render in the planning unit
                    // (weeks), matching the header adaptLabel gives them.
                    const n = stored != null && isDayField(col.field) ? Number(fromDays(stored).toFixed(2)) : stored;
                    if (n != null && Number.isFinite(n)) return col.format ? col.format(n) : String(n);
                    return typeof raw === "string" && raw !== "" ? raw : "—";
                  })()}
                </span>
              )}

              {kind === "segmented" && (
                <CellSegmented
                  value={String(
                    // An empty FG-stock cell is the product's mode by the engine's
                    // chain (master → the project → MTO), never the first option.
                    col.field === "fulfillment_mode"
                      ? rowFulfillmentMode(rowCtx)
                      : col.field === "row_demand_mode"
                        // The mode the ENGINE runs: forecast only with a series.
                        ? rowDemandMode(rowCtx)
                        : cellValue ?? liveDefault ?? (col.field === "sourcing_firm" ? firms?.[0] : opts?.[0]?.value) ?? "",
                  )}
                  options={
                    col.field === "sourcing_firm" && firms
                      ? firms.map((f) => ({ value: f, label: f }))
                      : col.field === "row_demand_mode"
                        ? opts!.map((o) =>
                            o.value === "forecast" && !rowHasForecast(rowCtx)
                              ? { ...o, disabled: true, title: "No forecast uploaded for this row — upload a demand forecast (demand_forecasts: quantity per period for this customer × product) in Project manager" }
                              : o)
                        : opts!
                  }
                  onChange={commit}
                />
              )}

              {kind === "select" && (
                <Select value={String(cellValue ?? liveDefault ?? "")} onValueChange={commit}>
                  <SelectTrigger className="h-5 border-transparent bg-transparent px-1.5 font-mono text-[10.5px] hover:bg-[#fafafa]">
                    {/* An empty distribution runs the PRODUCT's, × the row's share. */}
                    <SelectValue placeholder={col.field === "row_demand_distribution" ? "product's" : col.field === "lane_lead_time_dist" || col.field === "prod_lead_time_dist" ? "deterministic" : "—"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(col.field === "sourcing_firm" && firms
                      ? firms.map((f) => ({ value: f, label: f, title: undefined }))
                      : opts ?? []
                    ).map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">
                        {o.title ?? o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {kind === "toggle" && (
                <span className="flex justify-center">
                  <Toggle
                    checked={typeof cellValue === "boolean" ? cellValue : Boolean(liveDefault)}
                    onChange={commit}
                  />
                </span>
              )}

              {kind === "number" && (() => {
                // A2 (§5.4) — the dot becomes the trigger for the value chain.
                //
                // `sourceFor` names the tier-2 table only for a master-backed
                // column; for everything else it returns null and the popover
                // renders the bundle-resolution chain, which is that cell's TRUE
                // answer rather than a gap (§4 D125 says why the lane columns
                // cannot be named yet).
                const src = sourceFor(col as { field: string; master?: { table: string; field: string } });
                const masterRow = src && col.master
                  ? masterRowById[col.master.table]?.get(masterIdOf(col, r))
                  : undefined;
                const target: ValueChainTarget = {
                  dataset: src?.dataset ?? null,
                  column: src?.column ?? col.field,
                  stage: stageKey,
                  field: col.field,
                  // The masters have carried `source_row_id` since WP 3.3 and
                  // `select("*")` has been returning it with nothing reading it.
                  // This is the reader.
                  sourceRowId: (masterRow as { source_row_id?: string | null } | undefined)?.source_row_id ?? null,
                  projectId: projectId ?? null,
                };
                const shown = cellValue == null ? (cellPlaceholder ?? "—") : String(cellValue);
                return (
                  <NumCell
                    value={(() => {
                      const n = typeof cellValue === "number" ? cellValue : Number(cellValue);
                      return cellValue == null || !Number.isFinite(n) ? undefined : n;
                    })()}
                    provenance={prov}
                    decimals={fc.kind === "num" ? (fc.dec ?? 2) : prov === "derived" ? 2 : undefined}
                    integer={fc.kind === "int"}
                    unit={fc.unit}
                    placeholder={cellPlaceholder}
                    title={substitution ?? placeholderTitle}
                    superseded={!!supersededBy}
                    onCommit={commit}
                    reset={
                      canResetToMaster
                        ? {
                            title:
                              resolved.base !== undefined
                                ? `Reset to master — remove the /policies override and use the ${resolved.baseSource === "derived" ? "lane-derived" : "item-master"} value ${resolved.base}`
                                : "Reset to master — remove the /policies override (the item master has no value)",
                            onReset: () => onCellChange(rowKey, col.field, null),
                          }
                        : undefined
                    }
                    dot={
                      <ValueChainPopover
                        target={target}
                        provenance={prov}
                        displayed={shown}
                        substitution={substitution}
                        superseded={!!supersededBy}
                        userId={user?.id ?? null}
                      >
                        <ProvenanceDotButton p={prov} label={col.label} />
                      </ValueChainPopover>
                    }
                  />
                );
              })()}

              {kind === "text" && (
                <input
                  value={String(cellValue ?? liveDefault ?? "")}
                  onChange={(e) => commit(e.target.value)}
                  className="h-5 w-full min-w-0 rounded-sm border border-transparent bg-transparent px-[5px] font-mono text-[11.5px] outline-none hover:bg-[#fafafa] focus:border-[--zinc-border] focus:bg-background"
                  style={{ boxSizing: "border-box" }}
                  size={1}
                />
              )}
            </td>
          );
        })}
      </tr>
    );
  };

  // ── Row memoization (flat grid) ──────────────────────────────────────────
  //
  // `rowEnv` is an identity token: it moves only when one of the values below
  // does. These are the things EVERY row reads in common. What is per row goes
  // in `own`, below. Both lists are held to what `renderRow` reaches by
  // `stagePolicyTableRowMemo.test.ts`.
  const hasDeleteOverride = !!deleteOverride;
  const rowEnv = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list is the point: the object is only an identity token
    [
      stageKey, spec, projectId, plantName, defaults, overrides, fulfillmentStrategy,
      masterRowById, masterColByField, derived, families, keyDefs, visible, fills,
      flatQty, qtyByMaterial, specColByField, invParamColByField, fgParamColByField,
      knownSuppliers, scheduleHorizonWeeks, selectedProject, user, canEditInputs,
      inputEditRefusal, adaptUnitLabel, fromDays, hasDeleteOverride,
    ],
  );

  /** `renderRow` for a flat-grid line, repainted only when ITS inputs move. */
  const renderRowMemo = (
    r: Record<string, unknown>,
    groupMeta: { isFirstOfGroup: boolean; isContinuation: boolean; groupId: string },
  ) => {
    const rowKey = String(r.key);
    const editingNewSupplier = newSupplierFor === rowKey;
    return (
      <MemoRow
        key={rowKey}
        env={rowEnv}
        // This row's own inputs. The flags are what the row derives from OTHER
        // rows' state (a sibling's primary, the group's primary) — compared as
        // the answer, not as the state that produced it, so editing one row
        // does not repaint its neighbours.
        own={[
          r, groupMeta.isFirstOfGroup, groupMeta.isContinuation, groupMeta.groupId,
          drafts[rowKey], rowEffective.get(rowKey), rowCtxByKey.get(rowKey),
          rowNeedsAttention(r), groupHasPrimary(r), hasOverride(rowKey),
          editingNewSupplier, editingNewSupplier ? newSupplierId : "",
          assigning === String(r.material_id),
        ]}
        render={() => renderRow(r, groupMeta)}
      />
    );
  };

  // ── §4 D180 — the BOM tree render pass ───────────────────────────────────
  //
  // Handoff "Supplier stage — BOM tree in the Material column" (Option A,
  // approved 2026-09-29): only the Material key column changes (+ a frozen
  // "Qty / assy"); the Supplier column and every value column render through
  // `renderRow` exactly as in the flat view. Every number shown is the derived
  // lane's (`bomTreeView.ts`); the only arithmetic is the model's one division.
  const treeFactsFor = (occ: BomOcc, open: boolean): string => {
    const M = treeModel!;
    const stale = M.stale ? " · stale" : "";
    const inside = !open && occ.inside.lines > 0
      ? ` · ${occ.inside.materials} material${occ.inside.materials === 1 ? "" : "s"} · ${occ.inside.lines} line${occ.inside.lines === 1 ? "" : "s"} inside`
      : "";
    if (occ.kind === "root") {
      return occ.demandPerWeek === null
        ? `no outbound demand — flows below cannot be derived${inside}`
        : `demand ${fmtFlow(occ.demandPerWeek)} /wk${stale}${inside}`;
    }
    if (!occ.canonical) {
      const c = M.byKey.get(occ.canonicalKey);
      return `repeat — its lines live under ${c?.parentId ?? "?"} ↗ (click to go there)`;
    }
    if (!occ.derived) return `not derived — run Combine on the Data Manager${inside}`;
    const qty = M.qtyPerRoot(occ.id)
      .map((q) => `${fmtQty(q.qty)} / ${q.rootId} · ${fmtFlow(q.flowPerWeek)} /wk`)
      .join(" ; ") || "qty —";
    if (occ.kind === "subassembly") return `${qty} · made in-house · read-only${stale}${inside}`;
    const f = treeMaterialFacts.get(occ.id);
    const sup = f ? (f.unassigned && f.suppliers === 0 ? "0 suppliers" : `${f.suppliers} supplier${f.suppliers === 1 ? "" : "s"}`) : "";
    const att = treeAttention(occ);
    return `${qty} · ${sup}${att ? ` · ${att.text}` : ""}${stale}${inside}`;
  };
  const treeAttention = (occ: BomOcc): { text: string; color: string } | null => {
    if (occ.kind !== "material" || !occ.canonical) return null;
    const f = treeMaterialFacts.get(occ.id);
    if (!f) return null;
    if (f.unassigned) return { text: "no supplier — the engine refuses a run over this material", color: "#bf2330" };
    if (f.leadMissing > 0) return { text: `lead time missing on ${f.leadMissing} of ${f.lines} line${f.lines === 1 ? "" : "s"}`, color: "#f59e0b" };
    return null;
  };

  /** The tree's label content for one occurrence: twisty, id, chips, dot. */
  const treeLabel = (occ: BomOcc, open: boolean, pivotCell: boolean): React.ReactNode => {
    const M = treeModel!;
    const canOpen = occ.childKeys.length > 0 || occ.lanes.length > 0;
    const match = treeReveal.matches.has(occ.key);
    const jumped = jumpTarget === occ.key;
    const repeat = !occ.canonical;
    const usedIn = occ.kind === "material" && occ.canonical ? M.whereUsed(occ.id).length : 0;
    const att = treeAttention(occ);
    const whereIsOpen = whereOpen === occ.key;
    return (
      <span className="flex h-full min-w-0 items-center gap-1.5">
        {canOpen ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleTreeOcc(occ.key);
            }}
            aria-label={open ? "Collapse" : "Expand"}
            title={open ? "Collapse" : "Expand"}
            className="grid h-[11px] w-[11px] shrink-0 place-items-center rounded-[1px] border border-[#8a8a8a] bg-white font-mono text-[10px] leading-none text-[#18181b]"
          >
            {open ? "−" : "+"}
          </button>
        ) : (
          <span className="inline-block w-[11px] shrink-0" />
        )}
        <button
          type="button"
          onClick={() => (repeat ? jumpToOcc(occ.canonicalKey) : canOpen ? toggleTreeOcc(occ.key) : undefined)}
          className="min-w-0 flex-auto truncate text-left font-mono text-[11.5px]"
          style={{
            color: repeat ? "#71717a" : "#18181b",
            fontWeight: match || jumped ? 600 : occ.kind === "material" ? 400 : 500,
          }}
        >
          {occ.id}
        </button>
        {occ.kind === "root" && !pivotCell && (
          <span className="shrink-0 rounded-[3px] bg-[#18181b] px-1 font-mono text-[9px] leading-[14px] text-white">product</span>
        )}
        {repeat && (
          <span className="shrink-0 rounded-[3px] border border-[#e0e0e3] bg-white px-1 font-mono text-[9px] leading-[13px] text-[#71717a]">
            repeat
          </span>
        )}
        {usedIn > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setWhereOpen((cur) => (cur === occ.key ? null : occ.key));
            }}
            title={`Where used — ${usedIn} parents`}
            className="h-[15px] shrink-0 rounded-full border px-1.5 text-[9.5px] leading-[13px]"
            style={{
              color: "#7c3aed",
              borderColor: "rgba(124,58,237,0.3)",
              background: whereIsOpen ? "rgba(124,58,237,0.16)" : "rgba(124,58,237,0.06)",
            }}
          >
            used in {usedIn}
          </button>
        )}
        {att && (
          <span
            className="h-[6px] w-[6px] shrink-0 rounded-full"
            style={{ background: att.color }}
            title={att.text}
          />
        )}
      </span>
    );
  };

  const treeRowBg = (occ: BomOcc | null): string => {
    if (!occ) return "#fff";
    if (jumpTarget === occ.key) return "#f0f0f2";
    if (treeReveal.matches.has(occ.key)) return "#f7f5ff";
    return occ.kind === "material" ? "#fff" : "#fafafa";
  };
  const treeTip = (occ: BomOcc, open: boolean): string =>
    `${occ.path.join(" › ")}\n${treeFactsFor(occ, open)}`;

  const keyTdProps = (d: KeyColDef, bg: string, extra?: React.CSSProperties) => ({
    className: cn(
      d.left !== null && "sticky z-20",
      "border-b border-r border-[--hair-divider] px-0 py-0 font-mono text-[11px]",
    ),
    style: {
      ...(d.left !== null ? { left: d.left } : {}),
      width: d.w,
      minWidth: d.w,
      maxWidth: d.w,
      height: TREE_ROW_H,
      background: bg,
      ...extra,
    } as React.CSSProperties,
  });

  const qtyTd = (occ: BomOcc | null, bg: string, key = "__qty") => {
    const d = keyDefs[keyDefs.length - 2];
    const rate = occ && occ.kind !== "root" ? occ.edgeRate : null;
    return (
      <td key={key} {...keyTdProps(d, bg)}>
        {occ && occ.kind !== "root" && (
          <span
            className="block px-2 text-right text-[12px] tabular-nums"
            style={{ color: !occ.canonical || rate === null ? "#a1a1aa" : "#18181b", fontFamily: "inherit" }}
            title={rate === null ? (occ.derived ? "rate unknown" : "not derived — run Combine") : `×${rate} per ${occ.parentId} (derived lane)`}
          >
            {rate === null ? "—" : fmtQty(rate)}
          </span>
        )}
      </td>
    );
  };

  /** Outline / Tabular: the level cells for a row whose label sits at `depth`. */
  const levelCells = (
    occ: BomOcc | null,
    labelDepth: number | null,
    label: React.ReactNode,
    bg: string,
    accent: string | null,
  ): React.ReactNode[] => {
    const M = treeModel!;
    const chain: BomOcc[] = [];
    if (occ) for (let i = 1; i <= occ.path.length; i++) {
      const o = M.byKey.get(occKey(occ.path.slice(0, i)));
      if (o) chain.push(o);
    }
    return Array.from({ length: treeLevelCount }, (_, i) => {
      const d = keyDefs[i];
      const first = i === 0 && accent ? { borderLeft: `2px solid ${accent}` } : undefined;
      let content: React.ReactNode = null;
      if (labelDepth !== null && i === labelDepth) content = label;
      else if (labelDepth !== null && i < labelDepth && chain[i]) {
        const anc = chain[i];
        content = treePrefs.repeat ? (
          <button
            type="button"
            onClick={() => jumpToOcc(anc.key)}
            className="block w-full truncate text-left font-mono text-[11px] text-[#a1a1aa]"
            title={anc.id}
          >
            {anc.id}
          </button>
        ) : null;
      }
      return (
        <td key={d.id} {...keyTdProps(d, bg, first)} title={chain[i]?.id}>
          <div className="flex h-full min-w-0 items-center px-1.5">{content}</div>
        </td>
      );
    });
  };

  /** A line's own material cell: "↳ id" under its material, or the id itself. */
  const laneMaterialText = (row: Record<string, unknown>, continuation: boolean, flags: React.ReactNode) => (
    <span className="flex h-full min-w-0 items-center gap-1.5" title={String(row.material_id ?? "")}>
      {continuation && <span className="shrink-0 text-[10px] text-[#c4c4c4]">↳</span>}
      <span
        className="min-w-0 truncate font-mono"
        style={{ fontSize: continuation ? 10 : 11.5, color: continuation ? "#a1a1aa" : "#18181b" }}
      >
        {String(row.material_id ?? "")}
      </span>
      {flags}
    </span>
  );

  const renderTreeRows = (): React.ReactNode[] => {
    if (!treeModel) return [];
    const M = treeModel;
    const valueSpan = Math.max(1, visible.length);
    const supDef = keyDefs[keyDefs.length - 1];
    const out: React.ReactNode[] = [];
    // Only the rows in (or near) the viewport are built and mounted; a project whose open tree
    // runs to thousands of rows otherwise mounts thousands of rows of a dozen cells each.
    const all = treeVisible.rows;
    const tw = all.length < WINDOW_MIN_ROWS ? null : rowWindow(treeRowHeights, win.top, win.h, OVERSCAN);
    if (tw && tw.before > 0) {
      out.push(
        <tr key="__tree_top" aria-hidden>
          <td colSpan={colCount} style={{ height: tw.before, padding: 0, border: 0 }} />
        </tr>,
      );
    }
    for (let idx = tw ? tw.first : 0; idx < (tw ? tw.last : all.length); idx++) {
      const v = all[idx];
      if (v.t === "node") {
        const occ = v.occ;
        const bg = treeRowBg(occ);
        const tip = treeTip(occ, v.open);
        const label = treeLabel(occ, v.open, treePivot);
        const materialSide = (accent: string | null): React.ReactNode[] =>
          treePivot
            ? [...levelCells(occ, occ.depth, label, bg, accent), qtyTd(occ, bg)]
            : [
                <td
                  key="__tree"
                  {...keyTdProps(keyDefs[0], bg, accent ? { borderLeft: `2px solid ${accent}` } : undefined)}
                  title={tip}
                >
                  <div className="h-full min-w-0 pr-2" style={{ paddingLeft: 6 + occ.depth * 14 }}>{label}</div>
                </td>,
                qtyTd(occ, bg),
              ];
        if (occ.ownRow) {
          // The sub-assembly's line IS this row (handoff §1): Supplier cell
          // "(made in-house)", value cells read-only.
          out.push(
            renderRow(occ.ownRow as Record<string, unknown>, undefined, {
              occKey: occ.key,
              readOnlyValues: true,
              trStyle: { height: TREE_ROW_H },
              cellsBefore: () => materialSide(null),
            }),
          );
          continue;
        }
        out.push(
          <tr key={`t-node-${occ.key}`} className="group" data-occ={occ.key} style={{ height: TREE_ROW_H }} title={treePivot ? tip : undefined}>
            {materialSide(null)}
            <td {...keyTdProps(supDef, bg)}>
              <span className="block truncate px-2 text-[11px] text-[#71717a]">
                {v.linesHere > 0 ? `${v.linesHere} line${v.linesHere === 1 ? "" : "s"}` : ""}
              </span>
            </td>
            <td colSpan={valueSpan} className="border-b border-[--hair-divider]" style={{ background: bg }} />
          </tr>,
        );
        continue;
      }
      if (v.t === "lane") {
        const occ = v.occ;
        const bg = occ && v.carrier ? treeRowBg(occ) : "#fff";
        out.push(
          renderRow(v.row as Record<string, unknown>, undefined, {
            occKey: v.carrier && occ ? occ.key : undefined,
            trStyle: { height: TREE_ROW_H },
            cellsBefore: ({ accent, flags }) => {
              if (treePivot) {
                const labelDepth = occ ? occ.depth : 0;
                const label = v.carrier && occ ? (
                  <span className="flex min-w-0 items-center gap-1.5" title={treeTip(occ, true)}>
                    {treeLabel(occ, true, true)}
                    {flags}
                  </span>
                ) : (
                  laneMaterialText(v.row as Record<string, unknown>, v.continuation, flags)
                );
                return [
                  ...levelCells(occ, labelDepth, label, bg, accent),
                  qtyTd(v.carrier ? occ : null, bg),
                ];
              }
              const pad = occ ? 6 + (occ.depth + 1) * 14 + 4 : 8;
              return [
                <td
                  key="__tree"
                  {...keyTdProps(keyDefs[0], bg, accent ? { borderLeft: `2px solid ${accent}` } : undefined)}
                >
                  <div className="h-full min-w-0 pr-2" style={{ paddingLeft: pad }}>
                    {laneMaterialText(v.row as Record<string, unknown>, v.continuation, flags)}
                  </div>
                </td>,
                qtyTd(null, bg),
              ];
            },
          }),
        );
        continue;
      }
      if (v.t === "where") {
        const occ = v.occ;
        const w = M.whereUsed(occ.id);
        const qs = M.qtyPerRoot(occ.id);
        out.push(
          <tr key={`t-where-${occ.key}-${idx}`}>
            <td
              colSpan={keyDefs.length}
              className={cn(!treePivot && "sticky left-0 z-20", "border-b border-[--hair-divider] py-1.5")}
              style={{ background: "#faf8ff", paddingLeft: treePivot ? 12 : 6 + (occ.depth + 1) * 14, width: keyBlockW, maxWidth: keyBlockW }}
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "#7c3aed" }}>
                Where used · {w.length} parent{w.length === 1 ? "" : "s"}
              </div>
              <div className="mt-1 max-w-[500px]">
                {w.map((p) => (
                  <div
                    key={p.parentId}
                    className="grid h-[22px] items-center gap-2 border-b font-mono text-[11px]"
                    style={{ gridTemplateColumns: "minmax(0,1fr) 56px 88px 44px", borderColor: "#efeaff" }}
                  >
                    <span className="truncate" title={p.parentId}>{p.parentId}</span>
                    <span className="text-right tabular-nums">{p.edgeRate === null ? "—" : `×${fmtQty(p.edgeRate)}`}</span>
                    <span className="text-right tabular-nums" style={{ color: M.stale ? "#a1a1aa" : "#18181b" }}>
                      {p.flowPerWeek === null ? "—" : `${fmtFlow(p.flowPerWeek)} /wk`}
                    </span>
                    {p.occKey ? (
                      <button type="button" className="text-right underline underline-offset-2" onClick={() => jumpToOcc(p.occKey!)}>
                        Open
                      </button>
                    ) : (
                      <span className="text-right text-[#a1a1aa]" title="No shipping product reaches this parent">—</span>
                    )}
                  </div>
                ))}
              </div>
              {qs.map((q) => (
                <div key={q.rootId} className="mt-1 font-mono text-[10.5px] text-[#52525b]">
                  {q.qty !== null
                    ? `Σ ${q.edges} edge flow${q.edges === 1 ? "" : "s"} ${fmtFlow(q.flowPerWeek)} ÷ demand ${fmtFlow(q.demandPerWeek)} = ${fmtQty(q.qty)} per ${q.rootId}${M.stale ? " (stale — run Combine)" : ""}`
                    : `A parent edge under ${q.rootId} is not derived, or it has no demand — qty not shown (run Combine).`}
                </div>
              ))}
            </td>
            <td colSpan={valueSpan} className="border-b border-[--hair-divider]" style={{ background: "#faf8ff" }} />
          </tr>,
        );
        continue;
      }
      // section
      out.push(
        <tr key={`t-section-${v.id}`} style={{ height: TREE_ROW_H }}>
          <td
            colSpan={keyDefs.length}
            className={cn(!treePivot && "sticky left-0 z-20", "border-b border-[--hair-divider] px-2 font-mono text-[11px]")}
            style={{ background: "#fafafa", width: keyBlockW, maxWidth: keyBlockW }}
          >
            <span className="font-medium text-foreground">
              {v.id === "unreachable" ? "Not reaching any shipping product" : "Not in the BOM"}
            </span>{" "}
            <span className="text-muted-foreground">
              {v.id === "unreachable"
                ? `· ${v.count} derived edge${v.count === 1 ? "" : "s"} with no route to a finished product — check the BOM rows and outbound demand`
                : `· ${v.count} material${v.count === 1 ? "" : "s"} in no BOM — see each line's flag`}
            </span>
          </td>
          <td colSpan={valueSpan} className="border-b border-[--hair-divider]" style={{ background: "#fafafa" }} />
        </tr>,
      );
    }
    if (tw && tw.after > 0) {
      out.push(
        <tr key="__tree_bot" aria-hidden>
          <td colSpan={colCount} style={{ height: tw.after, padding: 0, border: 0 }} />
        </tr>,
      );
    }
    return out;
  };

  /** The layout bar, in the band-row cell above the key columns (handoff §3). */
  const treeLayoutBar = () => {
    const seg = "px-[6px] leading-[17px] rounded-[4px]";
    const levels = Array.from({ length: Math.max(0, treeLevelCount - 1) }, (_, i) => i);
    const repeatDisabled = treeLayout === "compact";
    return (
      <div className="flex h-[23px] items-center gap-2 overflow-hidden whitespace-nowrap px-1.5 font-mono text-[9.5px] text-white/70">
        <span className="inline-flex items-center gap-px rounded-[5px] bg-white/10 p-px">
          {(
            [
              ["compact", "Compact", "One indented column"],
              ["outline", "Outline", "One column per level; each item on its own row"],
              ["tabular", "Tabular", "One column per level; a material shares its row with its first supplier line"],
            ] as const
          ).map(([v, l, t]) => (
            <button
              key={v}
              type="button"
              title={t}
              onClick={() => setTreePrefs({ layout: v })}
              className={cn(seg, treeLayout === v ? "bg-white text-[#18181b]" : "hover:text-white")}
            >
              {l}
            </button>
          ))}
        </span>
        <button
          type="button"
          onClick={() => !repeatDisabled && setTreePrefs({ repeat: !treePrefs.repeat })}
          title={repeatDisabled ? "Outline and Tabular only — Compact has one label column" : "Repeat parent labels on every row"}
          aria-disabled={repeatDisabled}
          className="inline-flex items-center gap-1"
          style={{ opacity: repeatDisabled ? 0.4 : 1, cursor: repeatDisabled ? "not-allowed" : "pointer" }}
        >
          <span
            className="relative inline-block h-[14px] w-[26px] rounded-full"
            style={{ background: treePrefs.repeat && !repeatDisabled ? "#fff" : "rgba(255,255,255,0.3)" }}
          >
            <span
              className="absolute top-[2px] h-[10px] w-[10px] rounded-full"
              style={{
                left: treePrefs.repeat && !repeatDisabled ? 14 : 2,
                background: treePrefs.repeat && !repeatDisabled ? "#18181b" : "#fff",
              }}
            />
          </span>
          repeat labels
        </button>
        <span className="inline-flex items-center gap-1">
          expand to
          <span className="inline-flex items-center gap-px rounded-[5px] bg-white/10 p-px">
            {[...levels.map((n) => [n, `L${n}`] as const), ["all", "All"] as const].map(([n, l]) => (
              <button
                key={String(n)}
                type="button"
                title={n === "all" ? "Expand everything, including supplier lines" : `Expand down to uploaded level ${l}`}
                onClick={() => expandTreeTo(n)}
                className={cn(seg, treePrefs.level === n ? "bg-white text-[#18181b]" : "hover:text-white")}
              >
                {l}
              </button>
            ))}
          </span>
        </span>
      </div>
    );
  };

  /** The key heads while the tree is on screen (handoff §2, §3, §6). */
  const renderTreeHeads = (): React.ReactNode[] => {
    const matCol = spec.keyCols[0];
    const supCol = spec.keyCols[1];
    const supDef = keyDefs[keyDefs.length - 1];
    const qtyDef = keyDefs[keyDefs.length - 2];
    const headCls = "sticky top-[23px] z-40 bg-[--brand-ink] p-0 align-top";
    const pos = (d: KeyColDef): React.CSSProperties => ({
      ...(d.left !== null ? { left: d.left } : {}),
      width: d.w,
      minWidth: d.w,
    });
    const filterPlaceholder = "Filter… opens the path to matches";
    // Outline / Tabular: one head per level column, so a label can never
    // drift from its cells; the Material filter sits in the band row there.
    const material = treePivot ? (
      Array.from({ length: treeLevelCount }, (_, i) => (
        <th key={`__lvl${i}`} className={headCls} style={pos(keyDefs[i])}>
          <button
            type="button"
            onClick={() => expandTreeTo(i)}
            title={i === 0 ? "Expand every product" : `Expand every L${i - 1} item`}
            className="flex h-full w-full flex-col items-start gap-px px-1.5 py-1 text-left font-mono text-white"
            style={{ borderRight: "1px solid rgba(255,255,255,0.22)" }}
          >
            <span className="text-[10px] font-medium uppercase leading-[1.2] tracking-[0.08em]">
              {i === 0 ? "Product" : `L${i - 1}`}
            </span>
            <span className="text-[9px] leading-[1.2] text-white/55">{i === 0 ? "finished product" : "uploaded level"}</span>
          </button>
          {resizeHandle(`__lvl${i}`, i === 0 ? "Product" : `L${i - 1}`)}
        </th>
      ))
    ) : (
      <th key={matCol.id} className={headCls} style={pos(keyDefs[0])}>
        <SortHeader
          label={matCol.label}
          sub={treeMaterialSub}
          dir={sort?.col === matCol.id ? sort.dir : null}
          onSort={() => toggleSort(matCol.id)}
          filter={colFilters[matCol.id] ?? ""}
          onFilter={(v) => setColFilter(matCol.id, v)}
          filterPlaceholder={filterPlaceholder}
        />
        {resizeHandle(keyDefs[0].id, matCol.label)}
      </th>
    );
    return [
      material,
      <th key="__qty" className={headCls} style={pos(qtyDef)}>
        <div
          className="flex h-full flex-col items-end justify-start gap-px px-1.5 py-1 text-right font-mono text-white"
          style={{ borderRight: "1px solid rgba(255,255,255,0.22)" }}
          title="The edge's own rate from the derived lane: how many of this item one parent assembly consumes"
        >
          <span className="text-[10px] font-medium uppercase leading-[1.2] tracking-[0.08em]">Qty / assy</span>
          <span className="text-[9px] leading-[1.2] text-white/55">per parent</span>
        </div>
        {resizeHandle("__qty", "Qty / assy")}
      </th>,
      <th key={supCol.id} className={headCls} style={pos(supDef)}>
        <SortHeader
          label={supCol.label}
          dir={sort?.col === supCol.id ? sort.dir : null}
          onSort={() => toggleSort(supCol.id)}
          filter={colFilters[supCol.id] ?? ""}
          onFilter={(v) => setColFilter(supCol.id, v)}
        />
        {resizeHandle(supDef.id, supCol.label)}
      </th>,
    ];
  };

  const treeMaterialSub = treeModel
    ? `${treeModel.stale ? "numbers from an old calculation — run Combine · " : ""}BOM tree · ${treeVisible.shownLines} of ${treeModel.totalLines} lines open`
    : "";

  return (
    <div className="flex flex-col gap-2">
      {mastersError && (
        <div
          className="flex items-center gap-2 rounded-sm border px-2.5 py-1.5 font-mono text-[11px]"
          style={{ borderColor: tint(LAYER.brand, 0.4), color: LAYER.brand }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: LAYER.brand }} />
          item masters unavailable ({mastersError}) — base values under the master-backed columns cannot be shown
        </div>
      )}

      {ruleBar?.(ruleBarState)}

      {/* Toolbar — sticky under the page header so the actions follow the grid.
          `top-[62px]` is desktop's PageHeader height; below `md` the mobile
          header is taller (two-line title + project switcher) and this offset
          would stick the toolbar too high, so the table's own `sticky top-0`
          thead — inside its own scroll container, z-40 — paints over it during
          scroll (the overlap the user hit). Not sticky at all below `md`. */}
      <div className="static z-20 flex flex-wrap items-center gap-2 bg-background py-0.5 md:sticky md:top-[62px]">
        <span className="font-mono text-[11px] text-muted-foreground">
          {filtered.length}/{dataRows.length} lines
        </span>
        {hasActiveQuery && (
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-[#fafafa] hover:text-foreground"
            onClick={() => {
              setColFilters({});
              setSort(null);
            }}
          >
            clear filters
          </button>
        )}
        {dirtyKeys.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-sm bg-[#f4f4f4] px-1.5 py-px font-mono text-[10px]">
            <span className="h-[5px] w-[5px] rounded-full bg-foreground" />
            {dirtyKeys.length} edited
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {familiesPresent.map((f) => (
            <FamilyChip
              key={f}
              family={f}
              hidden={collapsed.has(f)}
              onToggle={() => toggleFamily(f)}
            />
          ))}
        </div>
        {treeAvailable && (
          <span className="inline-flex h-[22px] items-center overflow-hidden rounded-sm border border-[--zinc-border] bg-white font-mono text-[10px]">
            {(["tree", "flat"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className={cn(
                  "px-[7px] py-0 h-full",
                  viewMode === m ? "bg-[#171717] text-white" : "text-muted-foreground hover:text-foreground",
                )}
                title={
                  m === "tree"
                    ? "Order the grid by the BOM structure: finished product → sub-assembly → purchased material, with supplier lanes under each material"
                    : "Today's flat lane grid"
                }
              >
                {m === "tree" ? "BOM tree" : "flat"}
              </button>
            ))}
          </span>
        )}
        {treeAvailable && viewMode === "tree" && sort !== null && (
          <span className="font-mono text-[10px] text-muted-foreground">
            sorted — showing flat (clear the sort to see the tree)
          </span>
        )}
        {treeFallback && (
          <span className="font-mono text-[10px]" style={{ color: LAYER.firm }}>
            {treeFallback}
          </span>
        )}
        {stageRows.loadError && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: LAYER.brand }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: LAYER.brand }} />
            lines could not be loaded — {stageRows.loadError}
            <button
              type="button"
              onClick={reloadRows}
              className="rounded-sm border border-current px-1.5 py-px hover:bg-[#fafafa]"
            >
              retry
            </button>
          </span>
        )}
        {!treeActive && collapsibleGroups.length > 0 && (
          <button
            type="button"
            onClick={toggleAllGroups}
            className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-[--zinc-border] bg-white px-[7px] font-mono text-[10px] text-muted-foreground hover:text-foreground"
            title={anyGroupExpanded ? "Collapse every group to one summary row" : "Expand every group"}
          >
            {anyGroupExpanded ? "⇕" : "⇔"}{" "}
            {anyGroupExpanded ? `collapse ${collapsibleGroups.length} groups` : `expand ${collapsibleGroups.length} groups`}
          </button>
        )}
        {totalCols > 0 && (
          <button
            type="button"
            onClick={() => setFitEnabled((v) => !v)}
            className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-[--zinc-border] bg-white px-[7px] font-mono text-[10px] text-muted-foreground hover:text-foreground"
            title={
              fitEnabled
                ? "Show every column and scroll horizontally instead of folding"
                : "Fold low-priority columns to fit the box"
            }
          >
            {!fitEnabled
              ? `all ${totalCols} columns · scrolls`
              : folded.length > 0
                ? `${folded.length} folded · ${visible.length}/${totalCols}`
                : `all ${totalCols} columns fit`}
          </button>
        )}
        {Object.keys(colWidths).length > 0 && (
          <button
            type="button"
            onClick={resetAllColWidths}
            className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-[--zinc-border] bg-white px-[7px] font-mono text-[10px] text-muted-foreground hover:text-foreground"
            title="Return every column on this stage to its default width"
          >
            reset {Object.keys(colWidths).length} column width{Object.keys(colWidths).length === 1 ? "" : "s"}
          </button>
        )}
        {dataBannerState === "pending" && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: LAYER.firm }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: LAYER.firm }} />
            uploaded data not applied
          </span>
        )}
        {dataBannerState === "seeding" && (
          <span className="font-mono text-[10.5px] text-muted-foreground">seeding from project data…</span>
        )}
        {dataBannerState === "none_applicable" && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            uploaded data says nothing about these columns — bundle defaults
          </span>
        )}
        {dataBannerState === "no_data" && !loading && (
          <span className="font-mono text-[10.5px] text-muted-foreground">no uploaded data — bundle defaults</span>
        )}
        {fallback && dataRows.length > 0 && (
          <span className="font-mono text-[10.5px]" style={{ color: LAYER.firm }}>
            one line per location — upload logistics + BOM for per-material lines
          </span>
        )}
        <div className="flex-1" />
        {leftActions}
        <Button
          variant="outline"
          size="sm"
          className="h-[26px] px-2.5 text-[11.5px]"
          disabled={dataRows.length === 0 || applying}
          onClick={() => setConfirmPrefill(true)}
        >
          Apply prefill
        </Button>
        {deleteOverride && stageOverrides.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-[26px] px-2.5 text-[11.5px]"
            disabled={resetting}
            onClick={() => setConfirmResetAll(true)}
          >
            Reset overrides {stageOverrides.length}
          </Button>
        )}
        {dirtyKeys.length > 0 && (
          <Button variant="ghost" size="sm" className="h-[26px] px-2.5 text-[11.5px]" onClick={revertAll}>
            Revert
          </Button>
        )}
        <Button
          size="sm"
          className="h-[26px] px-2.5 text-[11.5px]"
          disabled={dirtyKeys.length === 0}
          onClick={saveAll}
        >
          Save changes
        </Button>
      </div>

      {dataRows.length > 0 && <ProvenanceLegend imputedLines={imputedLines} />}

      {/* Nothing folded is hidden silently (§0.5) — name it and say how to get it back. */}
      {fitEnabled && folded.length > 0 && (
        <div className="font-mono text-[10px] text-muted-foreground">
          folded: {folded.slice(0, 4).map((c) => c.label).join(", ")} · {foldNote(folded)}
        </div>
      )}

      {/* `isolate` keeps the grid's own z-indices inside the grid. The frozen
          key heads are z-40 — the same as the sticky PageHeader — and the
          frozen body cells z-20, the same as the toolbar above; without a
          stacking context of its own, a page scroll carried the left heads
          OVER the page title and the frozen body cells over the toolbar,
          while the value heads (z-30) slid under both. */}
      <div
        ref={scrollRef}
        onScroll={onGridScroll}
        className="isolate max-h-[614px] overflow-auto rounded-sm border border-[--hair-border] border-t-2 border-t-foreground [scrollbar-gutter:stable]"
      >
        <table
          className="border-separate border-spacing-0"
          style={{ width: "100%", minWidth: tableMinWidth, tableLayout: "fixed" }}
        >
          <colgroup>
            {keyDefs.map((d) => (
              <col key={d.id} style={{ width: d.w }} />
            ))}
            {visible.map((c, i) => (
              <col
                key={c.key}
                style={{ width: fills && i === visible.length - 1 ? "auto" : c.w }}
              />
            ))}
          </colgroup>
          <thead>
            {/* Row 1 — family bands. Widths come from the fit, never a fresh
                measurement — the <colgroup> above is the only source (§0.1). */}
            <tr>
              <th
                colSpan={keyDefs.length}
                className={
                  treePivot
                    ? "sticky top-0 z-40 h-[23px] border-r border-r-[rgba(255,255,255,0.22)] bg-[--brand-ink] p-0"
                    : "sticky left-0 top-0 z-40 h-[23px] border-r border-r-[rgba(255,255,255,0.22)] bg-[--brand-ink] p-0"
                }
                style={{ width: keyTotal, minWidth: keyTotal, ...(treeActive ? { maxWidth: keyTotal } : {}) }}
              >
                {treeActive && (
                  <div className="flex h-[23px] items-center">
                    {treePivot && (
                      <>
                        <FilterInput
                          value={colFilters[materialColId] ?? ""}
                          onCommit={(v) => setColFilter(materialColId, v)}
                          placeholder="Filter… opens the path to matches"
                          ariaLabel="Filter materials — opens the path to matches"
                          style={{ width: 240 }}
                          className="ml-1.5 h-[17px] shrink-0"
                        />
                        <span className="ml-2 min-w-0 truncate font-mono text-[9px] text-white/55">{treeMaterialSub}</span>
                      </>
                    )}
                    {treeLayoutBar()}
                  </div>
                )}
              </th>
              {bandGroups.map((g, gi) => {
                const isCollapsed = collapsed.has(g.family);
                const width = g.cols.reduce((a, c) => a + c.w, 0);
                return (
                  <th
                    key={`${g.family}-${gi}`}
                    colSpan={g.cols.length}
                    className="sticky top-0 z-30 h-[23px] bg-[--brand-ink] p-0 align-middle"
                  >
                    <FamilyBand
                      family={g.family}
                      label={isCollapsed ? `${g.cols[0]?.bandLabel ?? g.family} (folded)` : g.cols[0]?.bandLabel}
                      width={width}
                      collapsed={isCollapsed}
                      last={gi === bandGroups.length - 1}
                      onToggle={() => toggleFamily(g.family)}
                    />
                  </th>
                );
              })}
            </tr>
            {/* Row 2 — column heads, two lines (label + sub) on one baseline. */}
            <tr>
              {treeActive ? (
                renderTreeHeads()
              ) : (
                spec.keyCols.map((c, i) => (
                  <Fragment key={c.id}>
                  {i === 1 && flatQty && flatQtyTh()}
                  <th
                    className="sticky top-[23px] z-40 bg-[--brand-ink] p-0 align-top"
                    style={{
                      left: keyLeft(keyIdx(i)),
                      width: keyWidths[keyIdx(i)],
                      minWidth: keyWidths[keyIdx(i)],
                    }}
                  >
                    <SortHeader
                      label={c.label}
                      dir={sort?.col === c.id ? sort.dir : null}
                      onSort={() => toggleSort(c.id)}
                      filter={colFilters[c.id] ?? ""}
                      onFilter={(v) => setColFilter(c.id, v)}
                    />
                    {resizeHandle(c.id, c.label)}
                  </th>
                  </Fragment>
                ))
              )}
              {visible.map((fc, i) => {
                const isLast = i === visible.length - 1;
                const width = fills && isLast ? undefined : fc.w;
                if (fc.foldedFamily) {
                  return (
                    <th
                      key={fc.key}
                      className="sticky top-[23px] z-30 bg-[--brand-ink] px-2 py-1 text-left font-mono text-[9.5px] text-white/60"
                      style={{ width, minWidth: width, borderRight: isLast ? "none" : "1px solid rgba(255,255,255,0.22)" }}
                    >
                      {fc.foldedFamily} field{fc.foldedFamily === 1 ? "" : "s"} folded
                      {resizeHandle(fc.key, fc.label)}
                    </th>
                  );
                }
                const col = specColByField.get(fc.key);
                if (!col) return null;
                if (col.synthetic) {
                  return (
                    <th
                      key={fc.key}
                      className="sticky top-[23px] z-30 bg-[--brand-ink] p-0 align-top"
                      style={{ width, minWidth: width }}
                    >
                      {/* Vector cell anchor: a plain label — its params carry
                          their own meaning inside the cell. */}
                      <div
                        className="flex h-full flex-col items-start justify-center gap-px overflow-hidden px-1.5 py-1 font-mono font-medium uppercase text-white"
                        style={{ borderRight: isLast ? "none" : "1px solid rgba(255,255,255,0.22)" }}
                        title={adaptLabel(fc.label)}
                      >
                        <span className="w-full truncate text-[10px] leading-[1.2] tracking-[0.08em]">
                          {adaptLabel(fc.label)}
                        </span>
                        {fc.sub && (
                          <span className="w-full truncate text-[9px] font-normal normal-case tracking-normal text-white/55">
                            {fc.sub}
                          </span>
                        )}
                      </div>
                      {resizeHandle(fc.key, adaptLabel(fc.label))}
                    </th>
                  );
                }
                return (
                  <th
                    key={fc.key}
                    className="sticky top-[23px] z-30 bg-[--brand-ink] p-0 align-top"
                    style={{ width, minWidth: width }}
                  >
                    <SortHeader
                      label={adaptLabel(fc.label, col.field)}
                      sub={fc.sub}
                      dir={sort?.col === col.field ? sort.dir : null}
                      onSort={() => toggleSort(col.field)}
                      onInfo={() => setParamSheetCol(col)}
                      pending={!!col.engineStatus}
                      notSimulated={noteOf(cellEngineRead(stageKey, col))}
                      quiet={fc.quiet}
                      last={isLast}
                      filter={fc.filterable === false ? undefined : (colFilters[col.field] ?? "")}
                      onFilter={fc.filterable === false ? undefined : (v) => setColFilter(col.field, v)}
                    />
                    {resizeHandle(fc.key, adaptLabel(fc.label, col.field))}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={colCount} className="py-6 text-center font-mono text-[11px] text-muted-foreground">
                  loading lines…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && !(treeActive && treeVisible.rows.length > 0) && (
              <tr>
                <td colSpan={colCount} className="py-8 text-center font-mono text-[11px] text-muted-foreground">
                  {/* §4 D178 — the empty body always states WHY (read failed /
                      filtered out / genuinely no lines); a blank or a false
                      "no lines" over a failed read is §5.3 T2 broken. */}
                  {stageEmptyMessage({
                    stageLabel: stageKey === "plant" ? "focal plant" : stageKey,
                    loading,
                    loadError: stageRows.loadError ?? null,
                    totalRows: dataRows.length,
                    filteredRows: filtered.length,
                  })}
                  {stageRows.loadError && (
                    <button
                      type="button"
                      onClick={reloadRows}
                      className="ml-2 rounded-sm border border-[--zinc-border] px-1.5 py-px hover:bg-[#fafafa]"
                    >
                      retry
                    </button>
                  )}
                </td>
              </tr>
            )}
            {/* §4 D180 — the BOM tree pass (read-only structural rows; every
                line through renderRow, its continuation from the model). */}
            {!loading && treeActive && renderTreeRows()}
            {!loading &&
              !treeActive &&
              windowRows(rowGroups.flatMap((group) => {
                const isCollapsible = group.members.length > 1;
                const groupId = `${stageKey}::${group.id}`;
                const isGroupCollapsed = isCollapsible && collapsedGroups.has(groupId);

                if (!isGroupCollapsed) {
                  return group.members.map((m, mi) =>
                    renderRowMemo(m.row as Record<string, unknown>, {
                      ...memberDisplay(group.members.length, mi),
                      groupId,
                    }),
                  );
                }

                // §5.2 — collapsed group: one summary row, Σ / ø / distinct
                // aggregates per column kind. No provenance dots — they would
                // claim a provenance the aggregate does not have.
                const rows = group.members.map((m) => m.row as Record<string, unknown>);
                const anyFlagged = rows.some((rr) => rowNeedsAttention(rr));
                const flaggedCount = rows.filter((rr) => rowNeedsAttention(rr)).length;
                const accent = anyFlagged ? "#BF2330" : "#171717";
                const keyBLabel =
                  stageKey === "supplier"
                    ? `${rows.length} suppliers`
                    : stageKey === "plant"
                      ? `${rows.length} products`
                      : `${rows.length} lines`;
                return (
                  <tr key={groupId} className="group">
                    <td
                      className="sticky z-20 border-b border-r border-[--hair-divider] bg-[#f7f7f7] px-2 py-[3px] font-mono text-[11px]"
                      style={{
                        left: keyLeft(0),
                        width: keyWidths[0],
                        minWidth: keyWidths[0],
                        maxWidth: keyWidths[0],
                        borderLeft: `2px solid ${accent}`,
                      }}
                    >
                      <span className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleGroup(groupId)}
                          className="-m-[14px] box-content grid h-[15px] w-[15px] shrink-0 place-items-center p-[14px] font-mono text-[10px] text-muted-foreground hover:text-foreground md:m-0 md:p-0"
                          title="Expand this group"
                        >
                          ▸
                        </button>
                        <span className="min-w-0 flex-1 truncate font-medium" title={group.id}>
                          {group.id}
                        </span>
                        {anyFlagged && (
                          <RowFlag title="One or more lines in this group need input">
                            {flaggedCount} open
                          </RowFlag>
                        )}
                      </span>
                    </td>
                    {flatQty && flatQtyTd(group.id, "bg-[#f7f7f7]")}
                    <td
                      className="sticky z-20 border-b border-r border-r-[--hair-border] bg-[#f7f7f7] px-2 py-[3px] font-mono text-[11px] text-muted-foreground"
                      style={{ left: keyLeft(keyIdx(1)), width: keyWidths[keyIdx(1)], minWidth: keyWidths[keyIdx(1)], maxWidth: keyWidths[keyIdx(1)] }}
                    >
                      {keyBLabel}
                    </td>
                    {visible.map((fc, fi) => {
                      const isLastCol = fi === visible.length - 1;
                      const width = fills && isLastCol ? undefined : fc.w;
                      if (fc.foldedFamily) {
                        return (
                          <td
                            key={fc.key}
                            className="border-b bg-[#f7f7f7]"
                            style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
                          />
                        );
                      }
                      const col = specColByField.get(fc.key);
                      if (!col) return null;
                      if (col.synthetic) {
                        return (
                          <td
                            key={fc.key}
                            className="border-b bg-[#f7f7f7] px-1.5 py-[3px] font-mono text-[10.5px] text-muted-foreground"
                            style={{ width, minWidth: width, ...cellDivider(isLastCol) }}
                          >
                            per line
                          </td>
                        );
                      }
                      const values = rows.map((rr) => cellValueFor(rr, col.field));
                      const summary = summarise({ kind: fc.kind, dec: fc.dec }, values);
                      const align = fc.align === "left" ? "left" : fc.align === "center" ? "center" : "right";
                      return (
                        <td
                          key={fc.key}
                          className="border-b bg-[#f7f7f7] px-1.5 py-[3px] font-mono text-[10.5px] text-muted-foreground"
                          style={{ width, minWidth: width, textAlign: align, ...cellDivider(isLastCol) }}
                        >
                          {summary}
                        </td>
                      );
                    })}
                  </tr>
                );
              }))}
          </tbody>
        </table>
      </div>

      {/* §2.7's affordance line — the identifying column freezes (keyLeft
          above), this just says so below `md`, where a table this wide is
          always wider than the viewport. */}
      <p className="mt-1 font-mono text-[10px] text-muted-foreground md:hidden">
        swipe the table sideways for the remaining columns
      </p>

      <AlertDialog open={confirmPrefill} onOpenChange={setConfirmPrefill}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[13px]">Apply prefill to all lines?</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              Saves the resolved values as overrides. Lines that need input are skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void applyPrefill();
              }}
              disabled={applying}
            >
              {applying ? "Applying…" : "Apply prefill"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmResetAll} onOpenChange={setConfirmResetAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[13px]">
              Reset {stageOverrides.length} saved override(s)?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              The grid falls back to project data + bundle defaults. Uploads and item masters are
              not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void resetAllOverrides();
              }}
              disabled={resetting}
            >
              {resetting ? "Resetting…" : "Reset overrides"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 6.B — per-parameter transparency side-sheet. */}
      <ParameterSheet
        col={paramSheetCol}
        open={paramSheetCol !== null}
        onOpenChange={(v) => !v && setParamSheetCol(null)}
      />
    </div>
  );
}

// @ts-nocheck — RPC + raw tables not in generated types.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { StageKey } from "@/lib/policies/stages";
import { ratePerDay } from "@/lib/policies/effectiveEconomics";
import { fetchProjectForecasts, fetchProjectLanes } from "@/lib/policies/projectLanes";
import { shareRead } from "@/lib/sharedRead";
import { readAllPages } from "@/lib/pagedRead";
import { forecastSummary, type ForecastBucket } from "@/lib/policies/customerRows";
import { engineSupplierLinks } from "../../supabase/functions/_shared/grading";

export interface StageRow {
  /** Composite key = "<location>::<material_or_product>" — also used as override target_key. */
  key: string;
  [k: string]: unknown;
}

interface Args {
  projectId: string | null | undefined;
  plantName: string | undefined | null;
  stage: StageKey;
}

interface SCDRow {
  plant_name?: string;
  from_location: string;
  to_location: string;
  data_source?: string;
  weighted?: number;
}

/**
 * Source of truth = `get_supply_chain_data` RPC (same as /network/product-level),
 * which returns from_location/to_location keyed by data_source ∈ inbound|bom|outbound.
 * We then enrich with the real per-row tables (inbound_logistics, outbound_logistics,
 * bom_multi_level — note plural names) to fill price / lead time / capacity columns.
 */
export function useStageRows({ projectId, plantName, stage }: Args) {
  const { user } = useAuth();
  const [rows, setRows] = useState<StageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fallback, setFallback] = useState<boolean>(false);
  // D20: lane tables whose read hit the ceiling. The grid RENDERS this; it is
  // not a log line. An empty array is the normal case and the honest one.
  const [truncated, setTruncated] = useState<string[]>([]);
  // §4 D177 — the Supplier stage's BOM-tree presentation. Raw upload rows and
  // the derived deep-lane rows ride along on the supplier stage of a
  // multi-level project so the grid can render the structure. They decorate
  // the presentation ONLY: `rows` above stays the flat set every guard,
  // prefill and verification reads.
  const [bomLevel, setBomLevel] = useState<string>("single");
  const [bomRows, setBomRows] = useState<Record<string, unknown>[]>([]);
  // The single-level BOM rows (product ← material), for the flat grid's
  // "Qty / assy". Empty on a multi-level project, whose tree has its own.
  const [singleBomRows, setSingleBomRows] = useState<Record<string, unknown>[]>([]);
  const [deepRows, setDeepRows] = useState<Record<string, unknown>[]>([]);
  // §4 D178 — a failed read is a RENDERED state, not a console line. When the
  // catch below fires, `rows` is empty for a reason the project's data did not
  // choose, and the grid must say which read failed instead of claiming
  // "no lines for this project". Same rule for the deep-lane read: its failure
  // only degrades the tree, but the degradation must name itself.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deepError, setDeepError] = useState<string | null>(null);
  // Bumped by reload() to refetch after a write (e.g. assigning a supplier).
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!projectId || !user || stage === "run_validate") {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFallback(false);
    setTruncated([]);
    setBomLevel("single");
    setBomRows([]);
    setSingleBomRows([]);
    setDeepRows([]);
    setLoadError(null);
    setDeepError(null);

    (async () => {
      const sb = supabase as any;
      try {
        // START EVERY READ THIS STAGE WILL NEED NOW, AWAIT EACH WHERE IT IS USED.
        // These were awaited one after another (edges, lanes, then the stage's own
        // extra read), so the grid waited for the SUM of their round trips. None
        // depends on another's answer, and each stage below ALWAYS makes its own
        // extra read, so starting it early changes when it begins, not whether.
        const fresh = tick > 0; // a reload() follows a write, so it reads afresh
        // The three stage hooks ask for the edge list at once with the same
        // arguments: one request.
        const scdP = shareRead(
          `scd|${projectId}|${user.id}|${String(user.email).toLowerCase()}`,
          async () =>
            await sb.rpc("get_supply_chain_data", {
              p_project_id: projectId,
              p_plant_name: null,
              p_user_id: user.id,
              p_user_email: user.email,
            }),
          fresh,
        );
        const lanesP = fetchProjectLanes(projectId, user, { fresh });
        // Supplier stage: the materials master (ids only), listed for materials no
        // lane or BOM row names. Same direct read the Item Master editor uses.
        const masterP =
          stage === "supplier"
            ? (async () =>
                await sb.from("materials").select("material_id").eq("project_id", projectId).limit(50_000))()
            : null;
        // Customer stage: each row's uploaded forecast series.
        const forecastsP = stage === "customer" ? fetchProjectForecasts(projectId, user) : null;
        // A read nobody awaits (we threw earlier) must not surface as unhandled.
        for (const side of [lanesP, masterP, forecastsP]) side?.catch(() => undefined);

        // 1) Canonical edge list from the RPC.
        const { data: scd, error: scdErr } = await scdP;
        if (scdErr) {
          // Name the read: the catch renders this, and "failed" without a
          // source is not a diagnosis anyone can act on (§4 D178).
          throw new Error(
            `get_supply_chain_data: ${String((scdErr as { message?: string })?.message ?? JSON.stringify(scdErr))}`,
          );
        }
        const edges: SCDRow[] = (scd ?? []).filter(
          (d: SCDRow) => d.data_source && d.data_source !== "multi_tier",
        );

        // 2) Enrichment rows via the SECURITY DEFINER RPC (the app's custom
        //    auth makes direct .from() reads on the lane tables return empty
        //    under RLS — see src/lib/policies/projectLanes.ts).
        const lanes = await lanesP;
        if (!cancelled) setTruncated(lanes.truncated);
        const inbound = lanes.inbound;
        const outbound = lanes.outbound;
        // §4 D178 — THE ROWS' SHAPE DECIDES, NOT `projects.bom_level`. This
        // used to gate on the declared `lanes.bomLevel` label. A project
        // whose label disagrees with the
        // rows it holds then took every wrong branch at once: the D176
        // single-level sweep never ran (its gate read the same label), the
        // D177 tree offered itself with no hierarchy to show, and the
        // materials the BOM knows had no source left. The multi-level
        // hierarchy IS "a row carries `higher_level_component_id`" — read
        // that, and the label can drift without the grid lying.
        // (The label's own writer, `get_project_datasets`, still picks WHICH
        // BOM table it aggregates by comparing the label to 'single' exactly;
        // that latent half is recorded in the D178 row, not fixed here.)
        const hasMultiShape = lanes.bom.some(
          (r) =>
            String((r as Record<string, unknown>).higher_level_component_id ?? "").trim() !== "",
        );
        const bom = hasMultiShape ? lanes.bom : [];
        if (!cancelled) {
          setBomLevel(hasMultiShape ? "multi" : "single");
          setBomRows(bom);
          setSingleBomRows(hasMultiShape ? [] : lanes.bom);
        }

        // §4 D177 — the derived deep lane, read for the supplier stage's tree
        // on multi-level projects. Same RPC and paging the network pages use;
        // the numbers on the tree are THESE rows, never a client-side walk.
        if (stage === "supplier" && hasMultiShape) {
          // Pages are read several at a time (`pagedRead.ts`); the first error ends the
          // read with no rows, as the sequential loop did.
          const { rows: all, error: mtErr } = await readAllPages<Record<string, unknown>>(
            async (offset, limit) =>
              await sb.rpc("get_supply_chain_data_multi_tier", {
                p_project_id: projectId,
                p_user_id: user.id,
                p_user_email: user.email,
                p_limit: limit,
                p_offset: offset,
              }),
            { maxPages: 50 },
          );
          if (mtErr) {
            // The tree degrades in the grid; the flat rows above are
            // unaffected. Never fail the stage over this read — but the
            // degradation names itself: `deepError` reaches the toolbar
            // (§4 D178), a console line is not a display (§5.3 T2).
            console.warn("[useStageRows] deep-lane read failed — tree numbers unavailable", mtErr);
            if (!cancelled)
              setDeepError(
                `get_supply_chain_data_multi_tier: ${String((mtErr as { message?: string })?.message ?? JSON.stringify(mtErr))}`,
              );
          }
          if (!cancelled) setDeepRows(all);
        }

        // Unit contract (docs/data-simulation-mapping.md §3): `time_unit`
        // describes the VOLUME period only (day/week/month/yearly/…), while
        // `lead_time` / `expected_lead_time` are always WEEKS. Volume converts
        // via the shared engine-matching vocabulary in effectiveEconomics.
        const weeksToDays = (value: number | null | undefined): number | undefined => {
          const n = Number(value);
          return Number.isFinite(n) ? n * 7 : undefined;
        };

        const inboundByKey = new Map<string, any>();
        for (const r of inbound) {
          inboundByKey.set(`${r.supplier_id}::${r.material_id}`, {
            ...r,
            volume_per_day: ratePerDay(Number(r.volume), r.time_unit),
          });
        }
        const outboundByKey = new Map<string, any>();
        for (const r of outbound) {
          outboundByKey.set(`${r.customer_id}::${r.product_id}`, {
            ...r,
            expected_lead_time_days: weeksToDays(r.expected_lead_time),
            volume_per_day: ratePerDay(Number(r.volume), r.time_unit),
          });
        }

        // ── Smart-average imputation basis ──────────────────────────────────
        // When a (supplier,material)/(customer,product) pair from the RPC has no
        // matching uploaded row, we fill the project-backed numeric fields with a
        // "smart" average: the per-item average first (across the same material /
        // product), else the project-wide average. Imputed cells are flagged so
        // the UI can show a red "verify" dot.
        const avg = (nums: number[]): number | undefined => {
          const ok = nums.filter((n) => Number.isFinite(n) && n > 0);
          if (ok.length === 0) return undefined;
          return ok.reduce((s, n) => s + n, 0) / ok.length;
        };
        const pushTo = (map: Map<string, number[]>, k: string, v: any) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          if (!map.has(k)) map.set(k, []);
          map.get(k)!.push(n);
        };
        // Inbound (supplier) bases — keyed by material_id. Computed from the
        // raw rows with the same conversions as the enriched maps above (the
        // raw rows themselves carry no *_days fields).
        const inPriceByMaterial = new Map<string, number[]>();
        const inLeadByMaterial = new Map<string, number[]>();
        for (const r of inbound) {
          const mat = String(r.material_id);
          pushTo(inPriceByMaterial, mat, r.unit_price);
          pushTo(inLeadByMaterial, mat, weeksToDays(r.lead_time));
        }
        const inPriceGlobal = avg(inbound.map((r: any) => Number(r.unit_price)));
        const inLeadGlobal = avg(inbound.map((r: any) => Number(weeksToDays(r.lead_time))));
        // Outbound (customer) bases — keyed by product_id.
        const outPriceByProduct = new Map<string, number[]>();
        const outVolByProduct = new Map<string, number[]>();
        const outLeadByProduct = new Map<string, number[]>();
        for (const r of outbound) {
          const prod = String(r.product_id);
          pushTo(outPriceByProduct, prod, r.unit_price);
          pushTo(outVolByProduct, prod, ratePerDay(Number(r.volume), r.time_unit));
          pushTo(outLeadByProduct, prod, weeksToDays(r.expected_lead_time));
        }
        const outPriceGlobal = avg(outbound.map((r: any) => Number(r.unit_price)));
        const outVolGlobal = avg(outbound.map((r: any) => ratePerDay(Number(r.volume), r.time_unit)));
        const outLeadGlobal = avg(outbound.map((r: any) => Number(weeksToDays(r.expected_lead_time))));
        // Per-item average first, else project-wide average, else undefined.
        const impute = (
          perItem: Map<string, number[]>,
          itemKey: string,
          globalAvg: number | undefined,
        ): number | undefined => {
          const local = avg(perItem.get(itemKey) ?? []);
          return local ?? globalAvg;
        };
        const round2 = (n: number) => Math.round(n * 100) / 100;
        // Resolve a project-backed field: real value when finite, else imputed
        // average (flagged). Mutates `prov` with __from_data / __imputed markers.
        const resolveField = (
          prov: { __from_data: Record<string, true>; __imputed: Record<string, true> },
          field: string,
          real: any,
          imputedValue: number | undefined,
        ): number | undefined => {
          const r = Number(real);
          if (Number.isFinite(r) && r > 0) {
            prov.__from_data[field] = true;
            return r;
          }
          if (imputedValue !== undefined) {
            prov.__imputed[field] = true;
            return round2(imputedValue);
          }
          return undefined;
        };

        // A routing DECISION the project data's own shape determines (how many
        // suppliers a material has; which firm ships the most volume). Nobody
        // uploads a `primary_source` column, so it is NOT `__from_data` — it is
        // `__decided`, and the difference is §4 D23.
        //
        // ── WHAT THIS USED TO DO, AND WHAT IT COST ────────────────────────
        //
        // A `markFromData` helper wrote these three fields into `__from_data`
        // as well, to make the prefill persist them (G16 needs a primary
        // supplier per material on the saved bundle). Both call sites carried a
        // comment saying the opposite — "these are not `__from_data`" — so the
        // intent was on the record and the code did the other thing. Three
        // consequences, and the first is the defect:
        //
        //   · `getEffectiveValue` reads `dataRow[field]` BEFORE the override
        //     bundle, deliberately, so an uploaded column always beats a stale
        //     override. A suggestion sitting in that same slot means a SAVED
        //     routing choice could never surface — the user picks a supplier,
        //     saves, reloads, and sees the suggestion again.
        //   · the grid badged it "From project data" (green), for a value no
        //     upload contained — §4 D16's exact shape.
        //   · `hasRealProjectData` counted a project with no uploads at all as
        //     having real data.
        //
        // The prefill still persists them, through `__decided` — a source
        // `prefillSourceFor` now names, which is the honest door for a value the
        // STAGE decided rather than the upload.

        // Determine which BOM nodes are raw materials (= leaf level, never a parent).
        const isParent = new Set<string>();
        for (const r of bom) if (r.higher_level_component_id) isParent.add(String(r.higher_level_component_id));
        const rawMaterials = new Set<string>();
        for (const r of bom) {
          if (!r.material_id) continue;
          if (!isParent.has(String(r.material_id))) rawMaterials.add(String(r.material_id));
        }

        // Resolve a focal plant name.
        const focal = (() => {
          if (plantName && plantName !== "Focal plant") return plantName;
          for (const e of edges) if (e.plant_name) return e.plant_name;
          return plantName || "Focal plant";
        })();

        // Engine-formula ingredient for the replenishment placeholders: the
        // same E[D_m] shape the engine derives — product demand × BOM rate,
        // per WEEK — summed over every BOM line that names the material and
        // whose parent has an outbound demand. Deeper multi-level conversion
        // is the engine's job; this feeds a PLACEHOLDER (s = E[D]·T_s,
        // S = E[D]·(T_s+κ)), never a stored value.
        const matDemandPerWeek = new Map<string, number>();
        for (const r of lanes.bom as Array<Record<string, unknown>>) {
          const mat = String(r.material_id ?? "").trim();
          const parent = String(
            (r.product_id ?? r.higher_level_component_id) ?? "",
          ).trim();
          if (!mat || !parent) continue;
          const dPerDay = avg(outVolByProduct.get(parent) ?? []);
          if (dPerDay === undefined) continue;
          const rate = Number(r.consumption_rate);
          const eff = Number.isFinite(rate) && rate > 0 ? rate : 1;
          matDemandPerWeek.set(
            mat,
            (matDemandPerWeek.get(mat) ?? 0) + dPerDay * eff * 7,
          );
        }

        if (stage === "supplier") {
          const seen = new Map<string, any>();

          // 1) Build a DEDUPLICATED per-pair volume so the share numerator and
          //    denominator come from the exact same basis (→ always sums to 100%).
          //    The RPC can return multiple edges per (supplier, material) pair;
          //    summing those into the denominator while each row uses the single
          //    deduped pair volume as numerator is what produced shares like
          //    2.9% / 1.5% / 0% instead of 100%.
          const weightedByPair = new Map<string, number>();
          const suppliersByMaterial = new Map<string, Set<string>>();
          for (const e of edges) {
            if (e.data_source !== "inbound") continue;
            const mat = String(e.to_location);
            const sup = String(e.from_location);
            const pair = `${sup}::${mat}`;
            const w = Number((e as any).weighted ?? 0);
            weightedByPair.set(
              pair,
              (weightedByPair.get(pair) ?? 0) + (Number.isFinite(w) ? w : 0),
            );
            const set = suppliersByMaterial.get(mat) ?? new Set<string>();
            set.add(sup);
            suppliersByMaterial.set(mat, set);
          }
          // One volume per unique pair: deduped inbound volume/day, else summed weighted.
          const volByPair = new Map<string, number>();
          for (const [mat, sups] of suppliersByMaterial) {
            for (const sup of sups) {
              const pair = `${sup}::${mat}`;
              const enrich = inboundByKey.get(pair) ?? {};
              const vpd = Number(enrich.volume_per_day);
              const v = Number.isFinite(vpd)
                ? vpd
                : (weightedByPair.get(pair) ?? 0);
              volByPair.set(pair, Number.isFinite(v) ? v : 0);
            }
          }
          // Per-material: total volume (over unique suppliers) + suggested primary.
          const engineLinks = engineSupplierLinks(inbound as Record<string, unknown>[]);
          const matMeta = new Map<
            string,
            { total: number; primary: string; count: number }
          >();
          for (const [mat, sups] of suppliersByMaterial) {
            const supList = [...sups];
            const total = supList.reduce(
              (s, sup) => s + (volByPair.get(`${sup}::${mat}`) ?? 0),
              0,
            );
            // Suggest the supplier the ENGINE buys from when nothing is saved
            // (§4 D188): cheapest link → shortest lead time → supplier id, each
            // link built exactly as the mapper builds it (`engineSupplierLinks`).
            // This used to suggest the highest-VOLUME lane, so the grid named X
            // primary while an unsaved run bought from Y. Now an unsaved
            // suggestion is what runs, and a saved choice overrides both.
            const ranked = [...supList].sort((a, b) => {
              const la = engineLinks.get(`${a}::${mat}`);
              const lb = engineLinks.get(`${b}::${mat}`);
              return (
                (la?.cost ?? Number.POSITIVE_INFINITY) - (lb?.cost ?? Number.POSITIVE_INFINITY) ||
                (la?.leadWeeks ?? Number.POSITIVE_INFINITY) - (lb?.leadWeeks ?? Number.POSITIVE_INFINITY) ||
                (a < b ? -1 : a > b ? 1 : 0)
              );
            });
            matMeta.set(mat, {
              total,
              primary: ranked[0] ?? "",
              count: supList.length,
            });
          }

          for (const e of edges) {
            if (e.data_source !== "inbound") continue;
            const supplier = e.from_location;
            const material = e.to_location;
            const key = `${supplier}::${material}`;
            if (seen.has(key)) continue;
            const enrich = inboundByKey.get(key) ?? {};
            const meta = matMeta.get(String(material));
            const count = meta?.count ?? 1;
            const isSuggested = meta?.primary === String(supplier);
            const prov = { __from_data: {} as Record<string, true>, __imputed: {} as Record<string, true> };
            const material_price = resolveField(
              prov,
              "material_price",
              enrich.unit_price,
              impute(inPriceByMaterial, String(material), inPriceGlobal),
            );
            // NO LEAD TIME ON THE ROW. The lane's lead time is a master-backed
            // cell (`lead_time_weeks` over `inbound_logistics.lead_time`): the
            // grid reads it from the lane as the engine builds the link
            // (`supplierLaneMasters`) and a /policies override beats it. It used
            // to be put here in days, with a blank lane imputed as the average
            // of other lanes — a number the run never used (§4 D189 (a)).
            const primary_source = count === 1 ? true : isSuggested;
            seen.set(key, {
              key,
              supplier_id: supplier,
              material_id: material,
              // Real uploaded data where available, else smart-average imputed.
              material_price,
              __mat_demand_per_week: matDemandPerWeek.get(String(material)),
              // NOTE (D1/D16): no constants are written here. A row carries a
              // field ONLY when the project data says something about it —
              // anything else is supplied live by the policy bundle default or
              // `columnSpecs.defaultWhenMissing`, and is never persisted as an
              // override. Writing `safety_stock_days: 0` here silently
              // overrode the engine's own 7-day default (project_map.py:783)
              // and made the constant indistinguishable from uploaded data.
              // Single source → auto-lock. Multi-source → auto-enable the
              // suggested supplier, leave the rest off (user can still change).
              primary_source,
              __suggested_primary: isSuggested,
              __needs_primary: count > 1,
              __lane_count: count,
              __supplier_count: count,
              __from_data: prov.__from_data,
              __imputed: prov.__imputed,
              // Routing DECISIONS this stage derives from the uploaded volumes.
              // Not uploaded data (so not `__from_data`) and not an invented
              // constant either — the grid badges them "suggested" and the
              // prefill is allowed to persist them, because recording a primary
              // source is what the stage exists to do (blueprint G16). This
              // comment was true of the intent and false of the code until
              // §4 D23; `__decided` is now the only marker these carry.
              __decided: { primary_source: true } as Record<string, true>,
            });
          }

          for (const mat of rawMaterials) {
            const key = `(unassigned supplier)::${mat}`;
            if (seen.has(key)) continue;
            const alreadyPaired = [...seen.values()].some((r) => r.material_id === mat);
            if (alreadyPaired) continue;
            seen.set(key, {
              key,
              supplier_id: "(unassigned supplier)",
              material_id: mat,
              __needs_supplier: true,
              __supplier_count: 0,
              __lane_count: 0,
            });
          }

          // §4 D175 — EVERY material the project knows gets a line on this
          // stage. Until now the grid held (a) one line per supplier×material
          // lane and (b) BOM LEAF materials with no lane — two whole classes
          // were invisible with nothing saying so (AA-ver3: 260 BOM
          // materials, 35 with lanes; §15 run `35433474185`):
          //
          //   · INTERMEDIATE BOM materials (sub-assemblies — also a parent in
          //     the BOM): made, not bought. Listed as "(made in-house)", no
          //     "needs supplier" alarm — a supplier is not what they lack.
          //   · MASTER materials in no BOM and no lane: since D174 the
          //     pre-run gate BLOCKS a run over these, so hiding them here hid
          //     a run-blocker behind an unrelated page.
          const pairedMaterials = new Set(
            [...seen.values()].map((r) => String(r.material_id ?? "")),
          );
          const outboundProductIds = new Set(
            outbound.map((r) => String(r.product_id ?? "").trim()).filter(Boolean),
          );
          const bomMaterialIds = new Set<string>();
          for (const r of bom) {
            const id = String(r.material_id ?? "").trim();
            if (id) bomMaterialIds.add(id);
          }
          for (const mat of bomMaterialIds) {
            // Intermediate: consumed AND consuming — and not a shipped
            // product's own root row (the D171 shape).
            if (!isParent.has(mat) || outboundProductIds.has(mat)) continue;
            if (pairedMaterials.has(mat)) continue;
            const key = `(made in-house)::${mat}`;
            if (seen.has(key)) continue;
            seen.set(key, {
              key,
              supplier_id: "(made in-house)",
              material_id: mat,
              __in_house: true,
              __supplier_count: 0,
              __lane_count: 0,
            });
            pairedMaterials.add(mat);
          }
          // §4 D176 — D175's sweep read the MULTI-level shape only. `bom`
          // above is empty on a single-level project (the hierarchy walk
          // needs `higher_level_component_id`, which the single shape lacks),
          // so a material living only in `bom_single_level` — uploaded BOM,
          // no inbound lane, no master row — had no source left and stayed
          // invisible: the exact class D175 closed, one table over. The
          // single shape has no intermediates (every row is product ←
          // material), so an unpaired id here is bought and needs a supplier.
          // §4 D178 — gated on the rows' SHAPE, not the declared level: this
          // sweep must run whenever the BOM rows carry no hierarchy, whatever
          // `projects.bom_level` claims, or a mislabelled project loses its
          // BOM-only materials with nothing saying so.
          if (!hasMultiShape) {
            for (const r of lanes.bom) {
              const mat = String(r.material_id ?? "").trim();
              if (!mat || pairedMaterials.has(mat) || outboundProductIds.has(mat)) continue;
              const key = `(unassigned supplier)::${mat}`;
              if (seen.has(key)) continue;
              seen.set(key, {
                key,
                supplier_id: "(unassigned supplier)",
                material_id: mat,
                __needs_supplier: true,
                __supplier_count: 0,
                __lane_count: 0,
              });
              pairedMaterials.add(mat);
            }
          }
          try {
            // Same direct read the Item Master editor uses (its RLS admits it;
            // the lane tables' does not — see projectLanes.ts).
            const { data: masterRows, error: masterErr } = await masterP!;
            if (masterErr) throw masterErr;
            for (const m of (masterRows ?? []) as Record<string, unknown>[]) {
              const mat = String(m.material_id ?? "").trim();
              if (!mat || pairedMaterials.has(mat) || bomMaterialIds.has(mat)) continue;
              const key = `(unassigned supplier)::${mat}`;
              if (seen.has(key)) continue;
              seen.set(key, {
                key,
                supplier_id: "(unassigned supplier)",
                material_id: mat,
                __needs_supplier: true,
                __not_in_bom: true,
                __supplier_count: 0,
                __lane_count: 0,
              });
              pairedMaterials.add(mat);
            }
          } catch (masterReadErr) {
            // A failed master read may not silently shrink the list back to
            // the lanes-only view: the rows below are still complete for the
            // BOM; only master-only materials are unknown. Say so.
            console.warn("[useStageRows] materials master read failed — master-only materials are not listed", masterReadErr);
          }

          if (!cancelled)
            setRows(
              [...seen.values()].sort(
                (a, b) =>
                  String(a.material_id ?? "").localeCompare(String(b.material_id ?? "")) ||
                  String(a.supplier_id ?? "").localeCompare(String(b.supplier_id ?? "")),
              ),
            );
          return;
        }

        if (stage === "plant") {
          const bomTargets = new Set<string>();
          const outboundSources = new Set<string>();
          // Per-product outbound demand totals (units/day) → capacity hint.
          const outboundDemandByProduct = new Map<string, number>();
          // Per-product BOM components count (depth-1 children).
          const componentsByProduct = new Map<string, number>();
          // Median inbound lead time across components feeding this product
          // (rough proxy for production lead time when no explicit data exists).
          const inboundLeadTimesByProduct = new Map<string, number[]>();

          // BOM children per parent product
          for (const r of bom) {
            const parent = String(r.higher_level_component_id ?? "");
            if (!parent) continue;
            componentsByProduct.set(parent, (componentsByProduct.get(parent) ?? 0) + 1);
          }
          // outbound demand → product (raw rows: convert volume by time_unit)
          for (const o of outbound) {
            const p = String(o.product_id);
            const v = ratePerDay(Number(o.volume), o.time_unit);
            outboundDemandByProduct.set(p, (outboundDemandByProduct.get(p) ?? 0) + (Number.isFinite(v) ? v : 0));
          }
          // inbound lead times grouped by parent product via BOM (weeks → days)
          const inboundLeadByMaterial = new Map<string, number[]>();
          for (const i of inbound) {
            const mat = String(i.material_id);
            const lt = weeksToDays(i.lead_time);
            if (lt !== undefined) {
              if (!inboundLeadByMaterial.has(mat)) inboundLeadByMaterial.set(mat, []);
              inboundLeadByMaterial.get(mat)!.push(lt);
            }
          }
          for (const r of bom) {
            const parent = String(r.higher_level_component_id ?? "");
            const mat = String(r.material_id ?? "");
            if (!parent || !mat) continue;
            const lts = inboundLeadByMaterial.get(mat) ?? [];
            if (lts.length === 0) continue;
            if (!inboundLeadTimesByProduct.has(parent)) inboundLeadTimesByProduct.set(parent, []);
            inboundLeadTimesByProduct.get(parent)!.push(...lts);
          }

          for (const e of edges) {
            if (e.data_source === "bom") bomTargets.add(e.to_location);
            if (e.data_source === "outbound") outboundSources.add(e.from_location);
          }
          const products = new Set<string>();
          for (const p of bomTargets) if (outboundSources.has(p)) products.add(p);
          if (products.size === 0) for (const p of outboundSources) products.add(p);

          const median = (xs: number[]): number | undefined => {
            if (xs.length === 0) return undefined;
            const sorted = [...xs].sort((a, b) => a - b);
            const m = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
          };

          const seen = new Map<string, any>();
          for (const prod of products) {
            const key = `${focal}::${prod}`;
            const demand = outboundDemandByProduct.get(prod);
            const lt = median(inboundLeadTimesByProduct.get(prod) ?? []);
            const prov = { __from_data: {} as Record<string, true>, __imputed: {} as Record<string, true> };
            // §4 D24 — AN INBOUND MEDIAN IS NOT AN UPLOADED PRODUCTION LEAD TIME.
            //
            // `lt` is the median of the INBOUND lead times of this product's
            // feeding components. It was passed as `resolveField`'s REAL
            // argument, which marks `__from_data` — the marker that means "an
            // upload carried this value". Nobody uploads a production lead time;
            // this one is inferred from a different quantity on different rows.
            //
            // Latent today and confirmed so rather than assumed: the plant spec
            // declares no column for it, so nothing renders a dot, and
            // `runPrefill` iterates the SPEC rather than the row's fields, so
            // nothing persists it either. It would become a lie the moment a
            // column was added — which is the reason to fix it while it is
            // still cheap, and the reason this is a one-argument change.
            //
            // Passing it as the IMPUTED argument keeps the same precedence
            // (this product's own median first, then the smart average) and
            // tells the truth: an estimate to verify. It also rounds to 2dp, as
            // every other imputed value does.
            const production_lead_time_mean_days = resolveField(
              prov,
              "production_lead_time_mean_days",
              undefined,
              lt ?? impute(inLeadByMaterial, String(prod), inLeadGlobal),
            );
            seen.set(key, {
              key,
              item_id: focal,
              product_id: prod,
              // NOTE (D1/D16): the same rule as the supplier stage — no
              // constants. `capacity_machine_per_day`, `capacity_labor_per_day`,
              // `production_cost_per_unit` and `lead_time_distribution` were
              // written here and read by nothing: the plant column spec
              // declares none of them, so they never rendered and never
              // reached the engine. Defaults come from the policy bundle.
              // Real signal: median inbound lead time of feeding components,
              // else smart-average imputed.
              production_lead_time_mean_days,
              __components_count: componentsByProduct.get(prod) ?? 0,
              __demand_per_day: demand,
              __from_data: prov.__from_data,
              __imputed: prov.__imputed,
              __decided: {} as Record<string, true>,
            });
          }

          if (!cancelled)
            setRows([...seen.values()].sort((a, b) => a.key.localeCompare(b.key)));
          return;
        }

        if (stage === "customer") {
          // PLAN.md §24 WP 14.2 — each row's uploaded forecast series, shown
          // read-only with its source; the series itself is uploaded in Project
          // manager (the `demand_forecasts` dataset).
          const fq = await forecastsP!;
          if (fq.error) console.warn("[useStageRows] demand forecast read failed", fq.error);
          const bucketsByRow = new Map<string, ForecastBucket[]>();
          for (const f of fq.rows as unknown as ForecastBucket[]) {
            const k = `${f.customer_id}::${f.product_id}`;
            bucketsByRow.set(k, [...(bucketsByRow.get(k) ?? []), f]);
          }
          const bomProducts = new Set<string>();
          for (const e of edges) if (e.data_source === "bom") bomProducts.add(e.to_location);

          // Build per-product firm volumes (firm = plant_name, fallback focal).
          // firmVolByProduct.get(product).get(firm) = Σ weighted
          const firmVolByProduct = new Map<string, Map<string, number>>();
          for (const e of edges) {
            if (e.data_source !== "outbound") continue;
            const product = String(e.from_location);
            const firm = String(e.plant_name ?? focal);
            const v = Number((e as any).weighted ?? 0) || 0;
            const inner = firmVolByProduct.get(product) ?? new Map<string, number>();
            inner.set(firm, (inner.get(firm) ?? 0) + (Number.isFinite(v) ? v : 0));
            firmVolByProduct.set(product, inner);
          }
          // Suggested firm per product = highest volume; tie-break alphabetical.
          const suggestedFirmByProduct = new Map<string, { firm: string; firms: string[] }>();
          for (const [product, inner] of firmVolByProduct) {
            const firms = [...inner.keys()].sort();
            const ranked = [...inner.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const firm = ranked[0]?.[0] ?? "";
            suggestedFirmByProduct.set(product, { firm, firms });
          }

          const seen = new Map<string, any>();
          for (const e of edges) {
            if (e.data_source !== "outbound") continue;
            const customer = e.to_location;
            const product = e.from_location;
            const key = `${customer}::${product}`;
            if (seen.has(key)) continue;
            const enrich = outboundByKey.get(key) ?? {};
            const meta = suggestedFirmByProduct.get(String(product));
            const firms = meta?.firms ?? [];
            const suggestedFirm = meta?.firm ?? "";
            const prov = { __from_data: {} as Record<string, true>, __imputed: {} as Record<string, true> };
            const row_forecast = forecastSummary(bucketsByRow.get(key) ?? []);
            if (row_forecast) prov.__from_data.row_forecast = true;
            // Both firm-routing fields are decided by the uploaded outbound
            // volumes (highest volume wins). DECIDED, not uploaded — see the
            // supplier stage above for what conflating the two cost (§4 D23).
            const sourcing_firm = suggestedFirm || undefined;
            const primary_source = suggestedFirm ? true : undefined;
            seen.set(key, {
              key,
              customer_id: customer,
              product_id: product,
              row_forecast,
              // Prefill the suggested sourcing firm; single firm → only option.
              sourcing_firm,
              // Single firm → lock primary. Multi-firm → auto-enable the
              // suggested firm (user can still change).
              primary_source,
              __suggested_primary: !!suggestedFirm,
              __needs_primary: firms.length > 1,
              __lane_count: firms.length,
              __sourcing_firm_count: firms.length,
              __firms_available: firms,
              __unknown_product: bomProducts.size > 0 && !bomProducts.has(product),
              __from_data: prov.__from_data,
              __imputed: prov.__imputed,
              // Routing decisions derived from the uploaded outbound volumes —
              // see the supplier stage above for why these are not `__from_data`.
              __decided: (suggestedFirm
                ? { sourcing_firm: true, primary_source: true }
                : {}) as Record<string, true>,
            });
          }

          if (!cancelled)
            setRows([...seen.values()].sort((a, b) => a.key.localeCompare(b.key)));
          return;
        }
      } catch (err) {
        console.warn("[useStageRows] failed", err);
        if (!cancelled) {
          setRows([]);
          setFallback(true);
          // §4 D178 — the empty grid this leaves behind must say WHY it is
          // empty. Rendering it as "no lines for this project" was the same
          // silent swallow D3/D4 closed one layer down (loudFailure.test.ts).
          setLoadError(
            err instanceof Error
              ? err.message
              : String((err as { message?: string })?.message ?? err),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, plantName, stage, user, tick]);

  const reload = () => setTick((t) => t + 1);

  return { rows, loading, fallback, truncated, reload, bomLevel, bomRows, singleBomRows, deepRows, loadError, deepError };
}

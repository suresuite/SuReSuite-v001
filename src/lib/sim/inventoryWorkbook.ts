// The inventory explorer's workbook — notebook 04's step 8, for a user who does
// not run notebooks. Sheets, in order:
//
//   record     the run's reproducibility record (A5 — `assembleRunRecord`, the
//              same record the run-results export ships), with the explorer's
//              own limits appended (T3/T4)
//   materials  every material, ranked as the panel ranks them
//   products   every finished good, ranked as the panel ranks them
//   M <id> / FG <id>   one weekly sheet per SELECTED item
//   weekly     long form: week · kind · item · measure · value
//
// "All items" puts every item in `weekly`; the per-item sheets are always the
// selected ones (a sheet per item of a 500-item run is a file nobody opens).

import * as XLSX from "xlsx";
import { sheetName } from "@/lib/policies/excelNames";
import { recordRows, type ReproducibilityRecord } from "@/lib/trust/reproducibilityRecord";
import {
  EXPLORER_LIMITS,
  NOT_STOCKED,
  type ItemKind,
  type ItemSeriesRow,
  type MaterialRow,
  type ProductRow,
} from "@/lib/sim/inventoryExplorer";

/** Excel's row ceiling is 1 048 576; the long sheet splits before it. */
export const WEEKLY_SHEET_ROWS = 1_000_000;

/** The measure a material's weekly sheet adds beside the engine's own. */
export const USE_MEASURE = "use (derived)";

type Cell = string | number | null;

export interface InventoryWorkbookInput {
  record: ReproducibilityRecord | null;
  /** Why the record is absent, when it is. */
  recordAbsentBecause?: string;
  materials: MaterialRow[];
  products: ProductRow[];
  rows: ItemSeriesRow[];
  use: Map<string, number[]>;
  selected: Array<{ kind: ItemKind; id: string }>;
  scope: "selected" | "all";
}

const n = (v: number | null): Cell => (v === null || !Number.isFinite(v) ? null : v);

function materialsSheet(rows: MaterialRow[]): Cell[][] {
  return [
    ["material", "name", "suppliers", "used by", "avg on hand", "min on hand", "weeks at zero",
      "first stockout (week)", "avg in transit", "avg use / week (derived)", "min cover (weeks)", "ordered"],
    ...rows.map((r) => [
      r.id, r.name, r.suppliers.join(", ") || null, r.users.join(", ") || null,
      n(r.avgOnHand), n(r.minOnHand), r.weeksAtZero, r.firstStockout, n(r.avgInTransit),
      n(r.avgUsePerWeek), n(r.minCoverWeeks), n(r.ordered),
    ]),
  ];
}

function productsSheet(rows: ProductRow[]): Cell[][] {
  return [
    ["product", "name", "fulfillment mode", "avg FG on hand", "min FG on hand", "avg FG target",
      "weeks at zero (demand > 0)", "first stockout (week)", "fill rate", "avg backlog", "lost units",
      "weeks of cover"],
    ...rows.map((r) => {
      // A make-to-order product holds no FG stock by design: its stock cells say
      // so in words rather than reading 0, which would claim a measured stockout.
      const stock = (v: number | null): Cell =>
        r.mode === "mto" ? NOT_STOCKED : r.mode === null ? "not recorded by this run" : n(v);
      return [
        r.id, r.name,
        r.mode === "mts" ? "make-to-stock" : r.mode === "mto" ? "make-to-order" : "not recorded by this run",
        stock(r.avgFgOnHand), stock(r.minFgOnHand), stock(r.avgFgTarget), stock(r.weeksAtZero),
        r.mode === "mts" ? r.firstStockout : stock(null),
        n(r.fillRate), n(r.avgBacklog), n(r.lostUnits), stock(r.weeksOfCover),
      ];
    }),
  ];
}

/** The measures of one item, its derived use included for a material. */
export function itemMeasures(
  row: ItemSeriesRow,
  use: Map<string, number[]>,
): Array<[string, number[]]> {
  const out: Array<[string, number[]]> = Object.entries(row.series).filter(
    ([, v]) => Array.isArray(v),
  ) as Array<[string, number[]]>;
  if (row.kind === "material" && use.has(row.item_id)) out.push([USE_MEASURE, use.get(row.item_id)!]);
  return out;
}

function itemSheet(row: ItemSeriesRow, use: Map<string, number[]>): Cell[][] {
  const measures = itemMeasures(row, use);
  const weeks = Math.max(0, ...measures.map(([, v]) => v.length));
  return [
    ["week", ...measures.map(([k]) => k)],
    ...Array.from({ length: weeks }, (_, t) => [t, ...measures.map(([, v]) => n(v[t] ?? null))]),
  ];
}

/** Sheet names, sanitized to Excel's rules AND unique after truncation — two
 *  31-character prefixes can collide, and SheetJS refuses a duplicate. */
export function uniqueSheetNames(wanted: string[]): string[] {
  const used = new Set<string>();
  return wanted.map((w) => {
    const base = sheetName(w);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` ~${i}`;
      name = sheetName(base.slice(0, 31 - suffix.length) + suffix);
    }
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildInventoryWorkbook(input: InventoryWorkbookInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const sheets: Array<[string, Cell[][]]> = [];

  // record — always first, and always present: a workbook without it is not
  // reproducible, and one silently lacking it reads as if it were (T4).
  if (input.record) {
    const record = { ...input.record, limits: [...input.record.limits, ...EXPLORER_LIMITS] };
    sheets.push(["record", recordRows(record)]);
  } else {
    sheets.push(["record", [
      ["SuReSuite \u2014 REPRODUCIBILITY RECORD (A5)"],
      ["NOT SUPPLIED", input.recordAbsentBecause ?? "The record could not be assembled for this export."],
      ["", "These numbers are NOT evidence that the run is reproducible."],
      [],
      ["KNOWN LIMITS"],
      ["ref", "limit", "what it means for a figure here"],
      ...EXPLORER_LIMITS.map((l) => [l.ref, l.limit, l.consequence]),
    ]]);
  }
  sheets.push(["materials", materialsSheet(input.materials)]);
  sheets.push(["products", productsSheet(input.products)]);

  const byKey = new Map(input.rows.map((r) => [`${r.kind}\u0000${r.item_id}`, r]));
  for (const s of input.selected) {
    const row = byKey.get(`${s.kind}\u0000${s.id}`);
    if (row) sheets.push([`${s.kind === "material" ? "M" : "FG"} ${s.id}`, itemSheet(row, input.use)]);
  }

  // weekly — long form, split before Excel's row ceiling.
  const inScope =
    input.scope === "all"
      ? input.rows
      : input.selected.map((s) => byKey.get(`${s.kind}\u0000${s.id}`)).filter((r): r is ItemSeriesRow => !!r);
  const header: Cell[] = ["week", "kind", "item", "measure", "value"];
  let chunk: Cell[][] = [header];
  const chunks: Cell[][][] = [];
  for (const row of inScope) {
    for (const [measure, values] of itemMeasures(row, input.use)) {
      values.forEach((v, t) => {
        if (chunk.length > WEEKLY_SHEET_ROWS) {
          chunks.push(chunk);
          chunk = [header];
        }
        chunk.push([t, row.kind, row.item_id, measure, n(v)]);
      });
    }
  }
  chunks.push(chunk);
  chunks.forEach((c, i) => sheets.push([chunks.length === 1 ? "weekly" : `weekly ${i + 1}`, c]));

  const names = uniqueSheetNames(sheets.map(([name]) => name));
  sheets.forEach(([, aoa], i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), names[i]));
  return wb;
}

export { inventoryFileName } from "./inventoryFileName";


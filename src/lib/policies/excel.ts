import * as XLSX from "xlsx";
import {
  FIELD_LABELS,
  PolicySchemas,
  type PolicyBundle,
  type PolicyFamily,
} from "./schemas";
import type { OverrideRow } from "./resolve";

/**
 * Build a workbook for a stage. One sheet per family.
 * Row 1: defaults. Following rows: one per override (scope|target_key).
 */
export function exportStageWorkbook(
  stageTitle: string,
  families: PolicyFamily[],
  defaults: PolicyBundle,
  overrides: OverrideRow[],
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  for (const family of families) {
    const def = defaults[family] as Record<string, unknown>;
    const fields = Object.keys(def);
    const header = ["scope", "target_key", ...fields];

    const rows: (string | number | boolean | null)[][] = [];
    // defaults row
    rows.push([
      "default",
      "*",
      ...fields.map((f) => normalize(def[f])),
    ]);

    const famOverrides = overrides.filter((o) => o.family === family);
    for (const o of famOverrides) {
      rows.push([
        o.scope,
        o.target_key,
        ...fields.map((f) =>
          o.patch[f] !== undefined ? normalize(o.patch[f]) : normalize(def[f]),
        ),
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet([
      header.map((h) => FIELD_LABELS[h] ?? h),
      ...rows,
    ]);
    // also store the raw field keys on row 2 of meta? keep header simple.
    XLSX.utils.book_append_sheet(wb, ws, family.slice(0, 28));
  }

  // _meta sheet
  const meta = [
    ["Stage", stageTitle],
    ["Generated", new Date().toISOString()],
    [],
    ["Sheet", "Fields"],
    ...families.map((f) => [
      f,
      Object.keys(defaults[f] as Record<string, unknown>).join(", "),
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "_meta");

  return wb;
}

export function downloadWorkbook(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename);
}

// Defined in ./excelNames (no `xlsx` import); re-exported so existing imports keep working.
export { sheetName, safeName } from "./excelNames";

function normalize(v: unknown): string | number | boolean | null {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

export interface ImportResult {
  defaultsPatch: Partial<PolicyBundle>;
  overrides: OverrideRow[];
  errors: string[];
}

/** Parse a workbook back into defaults + override rows for a stage. */
export function importStageWorkbook(
  wb: XLSX.WorkBook,
  families: PolicyFamily[],
  currentDefaults: PolicyBundle,
): ImportResult {
  const result: ImportResult = { defaultsPatch: {}, overrides: [], errors: [] };

  for (const family of families) {
    const sheetName = wb.SheetNames.find((n) => n.startsWith(family.slice(0, 28)));
    if (!sheetName) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

    const def = currentDefaults[family] as Record<string, unknown>;
    const fields = Object.keys(def);
    const labelToKey: Record<string, string> = {};
    for (const f of fields) {
      labelToKey[FIELD_LABELS[f] ?? f] = f;
      labelToKey[f] = f;
    }

    for (const row of rows) {
      const scope = String(row["scope"] ?? "").trim();
      const target = String(row["target_key"] ?? "").trim();
      if (!scope && !target) continue;

      const raw: Record<string, unknown> = {};
      for (const [label, val] of Object.entries(row)) {
        if (label === "scope" || label === "target_key") continue;
        const key = labelToKey[label];
        if (!key) continue;
        raw[key] = coerce(val, def[key]);
      }

      if (scope === "default") {
        try {
          const parsed = PolicySchemas[family].parse({ ...def, ...raw });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result.defaultsPatch as any)[family] = parsed;
        } catch (e) {
          result.errors.push(`${family} default: ${(e as Error).message}`);
        }
      } else if (scope === "node" || scope === "edge") {
        if (!target) continue;
        // patch only fields that diverge from current defaults
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (JSON.stringify(v) !== JSON.stringify(def[k])) patch[k] = v;
        }
        result.overrides.push({ scope, target_key: target, family, patch });
      }
    }
  }

  return result;
}

function coerce(v: unknown, sample: unknown): unknown {
  if (typeof sample === "number") {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return isNaN(n) ? sample : n;
  }
  if (typeof sample === "boolean") {
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    return s === "true" || s === "yes" || s === "1";
  }
  if (Array.isArray(sample) || (sample && typeof sample === "object")) {
    if (typeof v === "string" && v.trim().startsWith("[")) {
      try { return JSON.parse(v); } catch { return sample; }
    }
    if (typeof v === "string" && v.trim().startsWith("{")) {
      try { return JSON.parse(v); } catch { return sample; }
    }
    return sample;
  }
  return String(v ?? "");
}

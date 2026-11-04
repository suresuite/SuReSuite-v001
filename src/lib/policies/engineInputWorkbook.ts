// The policy version's Export: WHAT THE ENGINE RECEIVES — PLAN.md §4 D289.
//
// Before D289 this export was the stored policy bundle, one column per family key,
// with the page's Zod defaults filled in and a "provenance" row under every value
// row. It was hard to read, and it was not the engine's input: a run reads the
// policy version TOGETHER WITH a dataset version, through the mapper, and the file
// showed neither the dataset nor the mapping — so a number in it could differ from
// the number the run used, and nothing in the file tied its content to its hash.
//
// The workbook is now built from `sim_worker.local.engine_input_from_snapshots`
// (`EngineInput`): the mapped scsim `Scenario` a run of these two frozen versions
// simulates, computed by the same code a run uses, in the browser engine. Nothing
// here re-derives a value. This module only lays it out for a person:
//
//   Read me                  what the file is, the identity block (versions, hashes,
//                            the hash re-check), how to read it, the sheet index
//   Suppliers … Customer demand
//                            one sheet per network list, one row per entity, units in
//                            the header, and a "source" column beside every value
//                            whose origin the mapper records
//   Policies                 every policy the run applies, parameter by parameter,
//                            "this version" vs "engine default"
//   Settings · Disruptions   the simulation settings and events the run reads
//   Where values came from   every master-backed value: override / item master /
//                            lanes / derived / engine default
//   Mapping notes            every substitution the mapper made, in its own words
//   Field guide              unit and meaning of every column
//   Policy as saved          the stored version, one setting per row — what the
//                            policy hash covers
//   Policy JSON (hashed)     the exact text the policy hash is the SHA-256 of
//
// Pure: data in → XLSX.WorkBook out. Fetching lives in `engineInputExport.ts`.

import * as XLSX from "xlsx";
import type { EngineInput } from "@/lib/sim/pyodideEngine";
import { FIELD_LABELS } from "./schemas";
import { sheetName } from "./excelNames";

type Cell = string | number | boolean | null;

export interface PolicyHashCheck {
  /** `match`: SHA-256 of the stored text, recomputed here, equals `policy_hash`.
   *  `mismatch`: it does not. `unchecked`: it could not be recomputed (`reason`). */
  state: "match" | "mismatch" | "unchecked";
  recomputed?: string;
  reason?: string;
}

export interface EngineInputExportData {
  version: {
    id: string;
    label: string | null;
    version_no?: number | null;
    notes?: string | null;
    author_name?: string | null;
    author_email?: string | null;
    created_at: string;
    policy_hash: string | null;
  };
  /** The stored `policy_versions.snapshot`, parsed — exactly what the run reads. */
  policySnapshot: Record<string, unknown>;
  /** The snapshot as the database's own text (`snapshot::text`) — the bytes the
   *  policy hash digests — or null when it could not be read as text. */
  policySnapshotText: string | null;
  policyHashCheck: PolicyHashCheck;
  dataset: {
    id: string;
    label?: string | null;
    created_at?: string | null;
    graph_hash?: string | null;
    hash_inputs?: string | null;
  };
  /** One sentence: why THIS dataset version (the version's latest run, or the
   *  project's data now when no run has used the version). */
  datasetReason: string;
  /** One sentence: which scenario's settings the mapping read, and why. */
  scenarioReason: string;
  /** `projects.supply_chain_model` — the MTS/MTO default a product without its own falls to. */
  projectModel: string | null;
  engine: EngineInput;
  generatedAt: string;
}

/** Lower-case hex SHA-256 of a string's UTF-8 bytes — how the database computes
 *  `policy_hash` from `snapshot::text`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The mapper's source tokens (`MappingResult.resolved`), as the /policies grid
 *  says them. */
export const SOURCE_LABEL: Record<string, string> = {
  override: "your /policies override",
  master: "item master (uploaded data)",
  lanes: "derived from your lanes",
  derived: "derived by the engine's rule",
  default: "engine default",
};

/** The network lists, upstream → downstream, with the sheet each becomes. A list
 *  the engine adds later still gets a sheet (humanized), never silently dropped. */
const NETWORK_SHEETS: Array<{ key: string; sheet: string; about: string }> = [
  { key: "suppliers", sheet: "Suppliers", about: "One row per supplier: capacity and reliability." },
  { key: "supplier_links", sheet: "Supplier links", about: "One row per supplier × material the plant can buy from: price, lead time, MOQ, and which source is primary." },
  { key: "materials", sheet: "Materials", about: "One row per material: cost, holding cost, opening stock." },
  { key: "bom", sheet: "Bill of materials", about: "Units of each material consumed per unit of product." },
  { key: "products", sheet: "Products", about: "One row per product: sell price, demand model, production capacity, finished-goods policy." },
  { key: "customers", sheet: "Customers", about: "One row per customer: segment, priority, contracted fill floor." },
  { key: "customer_links", sheet: "Customer demand", about: "One row per customer × product: the demand the run draws, and its price." },
  { key: "lanes", sheet: "Lanes", about: "Transport lanes the run models explicitly." },
];

function humanize(s: string): string {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Header text: the label, plus the unit when the unit adds something. */
export function headerFor(label: string, unit: string): string {
  const u = (unit ?? "").trim();
  if (!u || u === "-" || u === "enum" || u === "id") return label;
  if (label.toLowerCase().includes(u.toLowerCase())) return label;
  return `${label} (${u})`;
}

/** A value as a person reads it in a cell. Empty stays empty (the field guide
 *  says what empty means for that column). */
export function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" || typeof v === "string") return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "(none)";
    return v.every((x) => typeof x !== "object" || x === null)
      ? v.map((x) => (x === null ? "" : String(x))).join(", ")
      : JSON.stringify(v);
  }
  if (typeof v === "object") return Object.keys(v as object).length === 0 ? "(none)" : JSON.stringify(v);
  return String(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A table sheet: header row, data rows, column widths fitted, a filter on the header. */
function tableSheet(header: string[], rows: Cell[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h, i) => {
    const longest = Math.max(
      h.length,
      ...rows.slice(0, 500).map((r) => String(r[i] ?? "").length),
    );
    return { wch: Math.min(60, Math.max(8, longest + 2)) };
  });
  if (rows.length > 0) {
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  }
  return ws;
}

// ── The sheets ───────────────────────────────────────────────────────────────

/**
 * One network list as a table. Columns follow the engine model's field order;
 * beside every field the mapper records a source for, a "— source" column says
 * where THIS row's value came from. When the value the engine simulates differs
 * from the one the mapper resolved (an MTO product's FG levels, which are not
 * read), the source cell says so and points at the note.
 */
export function networkTable(
  rows: Record<string, unknown>[],
  fields: Record<string, { label: string; unit: string; notes: string }>,
  rowSources: Record<string, Record<string, { source: string; value: unknown }>> | undefined,
): { header: string[]; body: Cell[][] } {
  const order = Object.keys(fields);
  for (const r of rows) for (const k of Object.keys(r)) if (!order.includes(k)) order.push(k);
  const withSource = new Set<string>();
  for (const bySource of Object.values(rowSources ?? {})) for (const f of Object.keys(bySource)) withSource.add(f);

  const header: string[] = [];
  const plan: Array<{ field: string; kind: "value" | "source" }> = [];
  for (const f of order) {
    const meta = fields[f] ?? { label: humanize(f), unit: "", notes: "" };
    header.push(headerFor(meta.label, meta.unit));
    plan.push({ field: f, kind: "value" });
    if (withSource.has(f)) {
      header.push(`${meta.label} — source`);
      plan.push({ field: f, kind: "source" });
    }
  }
  const body = rows.map((r, i) =>
    plan.map(({ field, kind }) => {
      if (kind === "value") return cellOf(r[field]);
      const s = rowSources?.[String(i)]?.[field];
      if (!s) return "";
      const label = SOURCE_LABEL[s.source] ?? s.source;
      if (!sameValue(r[field], s.value)) {
        return `${label} (${String(cellOf(s.value)) || "empty"}) — not applied, see Mapping notes`;
      }
      return label;
    }),
  );
  return { header, body };
}

/** The stored policy version, one setting per row — what the policy hash covers. */
export function policyAsSavedRows(snapshot: Record<string, unknown>): Cell[][] {
  const rows: Cell[][] = [];
  const isV2 = "defaults" in snapshot;
  const defaults = (isV2 ? snapshot.defaults : snapshot) as Record<string, unknown> | undefined;
  for (const [family, values] of Object.entries(defaults ?? {})) {
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [field, v] of Object.entries(values as Record<string, unknown>)) {
      rows.push(["Project default", humanize(family), FIELD_LABELS[field] ?? humanize(field), field, cellOf(v)]);
    }
  }
  if (typeof snapshot.fulfillment_strategy === "string") {
    rows.push(["Project default", "Fulfillment", "Fulfillment strategy", "fulfillment_strategy", snapshot.fulfillment_strategy]);
  }
  const overrides = Array.isArray(snapshot.overrides) ? (snapshot.overrides as Record<string, unknown>[]) : [];
  for (const o of overrides) {
    const patch = (o.patch ?? {}) as Record<string, unknown>;
    const who = `Row ${String(o.target_key ?? "")}${o.scope && o.scope !== "node" ? ` (${String(o.scope)})` : ""}`;
    for (const [field, v] of Object.entries(patch)) {
      rows.push([who, humanize(String(o.family ?? "")), FIELD_LABELS[field] ?? humanize(field), field, cellOf(v)]);
    }
  }
  return rows;
}

function versionTitle(v: EngineInputExportData["version"]): string {
  const no = v.version_no ? `Policy v${v.version_no}` : "Policy version";
  return v.label ? `${no} · ${v.label}` : no;
}

function hashCheckSentence(c: PolicyHashCheck, stored: string | null): string {
  if (!stored) return "Not checked — this version predates stored policy hashes.";
  if (c.state === "match") {
    return "MATCHES — the SHA-256 of the stored version (sheet \"Policy JSON (hashed)\") was recomputed when this file was made and equals the policy hash.";
  }
  if (c.state === "mismatch") {
    return `DOES NOT MATCH — the stored version hashes to ${c.recomputed ?? "?"}, not to the policy hash. The version changed after it was saved; do not rely on this file until that is explained.`;
  }
  return `Not checked — ${c.reason ?? "the stored text could not be read"}.`;
}

/**
 * The whole workbook. Sheet order is reading order: what this is, the network
 * from suppliers to customers, the policies and settings that act on it, then
 * the evidence (sources, notes, the field guide, the stored version and its hash).
 */
export function buildEngineInputWorkbook(d: EngineInputExportData): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const net = (d.engine.scenario.network ?? {}) as Record<string, unknown>;
  const index: Array<[string, string, number | string]> = [];

  // ── network sheets ──
  const known = new Set(NETWORK_SHEETS.map((s) => s.key));
  const lists = [
    ...NETWORK_SHEETS,
    ...Object.keys(net)
      .filter((k) => Array.isArray(net[k]) && !known.has(k))
      .map((k) => ({ key: k, sheet: humanize(k), about: `The engine's ${humanize(k).toLowerCase()}.` })),
  ];
  const networkSheets: Array<[string, XLSX.WorkSheet]> = [];
  for (const s of lists) {
    const rows = (Array.isArray(net[s.key]) ? net[s.key] : []) as Record<string, unknown>[];
    if (rows.length === 0) {
      index.push([s.sheet, `${s.about} None — the run has no ${s.sheet.toLowerCase()}.`, 0]);
      continue;
    }
    const { header, body } = networkTable(rows, d.engine.fields[s.key] ?? {}, d.engine.row_sources[s.key]);
    networkSheets.push([s.sheet, tableSheet(header, body)]);
    index.push([s.sheet, s.about, rows.length]);
  }

  // ── policies ──
  const policyRows: Cell[][] = [];
  for (const p of d.engine.policies) {
    const name = `${p.catalog_ref} · ${p.id}`;
    policyRows.push([
      name, "(what it does)", "", "",
      p.in_mapping ? "applied by this version" : "always on — runs with engine defaults",
      p.summary,
    ]);
    for (const r of p.params) {
      policyRows.push([
        name,
        (r.display?.length ? r.display : r.path).join(" › "),
        cellOf(r.value),
        r.unit && r.unit !== "-" ? r.unit : "",
        r.set_by_mapping ? "this version / your data" : "engine default",
        r.notes,
      ]);
    }
  }
  index.push(["Policies", "Every policy the run applies, parameter by parameter, and whether the value comes from this version or is the engine's default.", d.engine.policies.length]);

  // ── settings ──
  const settings = (d.engine.scenario.settings ?? {}) as Record<string, unknown>;
  const settingRows: Cell[][] = Object.entries(settings).map(([k, v]) => {
    const m = d.engine.fields.settings?.[k];
    return [m?.label ?? humanize(k), cellOf(v), m?.unit && m.unit !== "-" ? m.unit : "", m?.notes ?? ""];
  });
  for (const [k, v] of Object.entries(net)) {
    if (Array.isArray(v)) continue;
    const m = d.engine.fields.network?.[k];
    settingRows.push([m?.label ?? humanize(k), cellOf(v), m?.unit && m.unit !== "-" ? m.unit : "", m?.notes ?? ""]);
  }
  index.push(["Settings", "The simulation settings the run reads (horizon, warm-up, seeds, confidence level, …).", settingRows.length]);

  // ── disruptions ──
  const events = (d.engine.scenario.events ?? []) as Record<string, unknown>[];
  const eventTable = events.length
    ? networkTable(events, d.engine.fields.events ?? {}, undefined)
    : { header: ["Disruptions"], body: [["None — the run simulates the undisrupted network."]] as Cell[][] };
  index.push(["Disruptions", "The disruption events the run injects.", events.length]);

  // ── where values came from ──
  const sourceRows: Cell[][] = d.engine.sources.map((s) => [
    s.target, s.entity, cellOf(s.value), SOURCE_LABEL[s.source] ?? s.source, s.master,
  ]);
  index.push(["Where values came from", "Every value that has more than one possible origin, and the one the engine used: your /policies override, the item master, your lanes, the engine's rule, or its default.", sourceRows.length]);

  // ── mapping notes ──
  const noteRows: Cell[][] = d.engine.warnings.map((w) => [w.level, w.entity, w.field, w.reason]);
  index.push(["Mapping notes", "Every substitution or adjustment the engine's mapper made, in its own words — read these before trusting an empty or derived value.", noteRows.length]);

  // ── field guide ──
  const guideRows: Cell[][] = [];
  for (const s of lists) {
    for (const [f, m] of Object.entries(d.engine.fields[s.key] ?? {})) {
      guideRows.push([s.sheet, headerFor(m.label, m.unit), f, m.unit, m.notes]);
    }
  }
  for (const [f, m] of Object.entries(d.engine.fields.settings ?? {})) guideRows.push(["Settings", m.label, f, m.unit, m.notes]);
  for (const [f, m] of Object.entries(d.engine.fields.events ?? {})) guideRows.push(["Disruptions", m.label, f, m.unit, m.notes]);
  index.push(["Field guide", "The unit and meaning of every column above, including what an EMPTY cell means for it.", guideRows.length]);

  // ── the stored version ──
  const savedRows = policyAsSavedRows(d.policySnapshot);
  index.push(["Policy as saved", "This policy version exactly as stored, one setting per row — the content the policy hash covers. The engine reads it through the mapping above.", savedRows.length]);
  const text = d.policySnapshotText;
  if (text) index.push(["Policy JSON (hashed)", "The stored version as the exact text the policy hash is the SHA-256 of, for anyone who wants to re-check the hash.", 1]);

  // ── read me ──
  const v = d.version;
  const readMe: Cell[][] = [
    [`Simulation input — ${versionTitle(v)}`],
    [],
    ["What this file is",
      "Exactly what the simulation engine receives when it runs this policy version on the dataset version below. " +
      "It was produced by the engine's own mapping code — the same calls a run makes, stopped before the simulation — " +
      "so every number in the input sheets is the number the run uses. Nothing in it was re-computed by the page."],
    [],
    ["Policy version", `${versionTitle(v)}  (id ${v.id})`],
    ["Saved", `${v.created_at}${v.author_name || v.author_email ? ` by ${v.author_name || v.author_email}` : ""}`],
    ...(v.notes ? [["Notes", v.notes] as Cell[]] : []),
    ["Policy hash (SHA-256)", v.policy_hash ?? "(not stored — legacy version)"],
    ["Policy hash check", hashCheckSentence(d.policyHashCheck, v.policy_hash)],
    [],
    ["Dataset version", `${d.dataset.label ? `${d.dataset.label} ` : ""}(id ${d.dataset.id})${d.dataset.created_at ? `, frozen ${d.dataset.created_at}` : ""}`],
    ["Dataset graph hash", d.dataset.graph_hash ?? "(not recorded)"],
    ["Simulation data hash", d.dataset.hash_inputs ?? "(not recorded — frozen before this hash existed)"],
    ["Why this dataset", d.datasetReason],
    ["Scenario", d.scenarioReason],
    ["Project fulfillment default", d.projectModel ?? "(not set, or not readable by this account — make-to-order)"],
    ["Engine", `scsim ${d.engine.engine_version}`],
    // WP 15.1 · §4 D293 — the build by content, which two different 0.6.1s do not share.
    ["Engine build", d.engine.engine_build ?? "(not recorded — the engine predates build identity)"],
    ["Generated", d.generatedAt],
    [],
    ["How to read it"],
    ["Rows and columns", "Each input sheet is one table: one row per supplier, material, product, customer row, … Units are in the column header."],
    ["Empty cells", "An empty cell means the engine has no value for that field. What that means (for example: no capacity limit, or 'start at the policy target') is in the Field guide."],
    ["\"— source\" columns", `Where the value on that row came from: ${Object.values(SOURCE_LABEL).join(" · ")}.`],
    ["Not in this file", "The raw uploaded rows (use Export dataset) and the run results (use Export results). This file is the engine's reading of them."],
    [],
    ["Sheet", "What it holds", "Rows"],
    ...index.map(([s, about, n]) => [s, about, n] as Cell[]),
  ];
  const readMeWs = XLSX.utils.aoa_to_sheet(readMe);
  readMeWs["!cols"] = [{ wch: 28 }, { wch: 110 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, readMeWs, "Read me");

  for (const [name, ws] of networkSheets) XLSX.utils.book_append_sheet(wb, ws, sheetName(name));
  XLSX.utils.book_append_sheet(
    wb,
    tableSheet(["Policy", "Parameter", "Value", "Unit", "Set by", "Meaning"], policyRows),
    "Policies",
  );
  XLSX.utils.book_append_sheet(wb, tableSheet(["Setting", "Value", "Unit", "Meaning"], settingRows), "Settings");
  XLSX.utils.book_append_sheet(wb, tableSheet(eventTable.header, eventTable.body), "Disruptions");
  XLSX.utils.book_append_sheet(
    wb,
    tableSheet(["Engine field", "Applies to", "Value used", "Source", "Item-master column"], sourceRows),
    "Where values came from",
  );
  XLSX.utils.book_append_sheet(
    wb,
    tableSheet(["Level", "Applies to", "Field", "Note"], noteRows.length ? noteRows : [["", "", "", "No notes — the mapper substituted nothing."]]),
    "Mapping notes",
  );
  XLSX.utils.book_append_sheet(wb, tableSheet(["Sheet", "Column", "Field id", "Unit", "Meaning"], guideRows), "Field guide");
  XLSX.utils.book_append_sheet(
    wb,
    tableSheet(["Applies to", "Family", "Setting", "Field id", "Value"], savedRows),
    "Policy as saved",
  );
  if (text) {
    // A cell holds at most 32 767 characters, so long text is split in order.
    const CHUNK = 30000;
    const chunks: Cell[][] = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push([text.slice(i, i + CHUNK)]);
    const ws = XLSX.utils.aoa_to_sheet([
      ["Join the cells below, top to bottom, with nothing between them. The SHA-256 (UTF-8) of that text is the policy hash on the Read me sheet."],
      ...chunks,
    ]);
    ws["!cols"] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ws, "Policy JSON (hashed)");
  }
  return wb;
}

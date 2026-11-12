#!/usr/bin/env node
// Seed the demo project for the product-, process- and firm-level network pages.
//
// What it loads is scripts/demo_project/dataset.json (authored in build_dataset.py):
// the manual's control-unit assembly grown to a three-deep bill of materials, 11
// suppliers, 2 customers and a 41-firm deep-tier graph. It drives the SAME lifecycle
// the app does (src/pages/DataManager.tsx), dependency-free like
// scripts/seed_example_project.mjs:
//
//   create_project (or reuse) → bulk_upsert_{suppliers,materials,products}
//   → delete_project_dataset('all' + 'deep_tier')
//   → bulk_insert_{bom_multi_level,inbound_logistics,outbound_logistics}
//   → update_project_completion_status → combine_project_into_supply_chain
//   → rebuild_node_list → upload_node_list_data (the map's locations)
//   → bulk_insert_network_{nodes,edges}                  (the firm-level graph)
//   → geocode-locations (the plant's pin)
//   → the analyses each page would otherwise start on first open, run ONCE here:
//     calculate-network-science-metrics (product_metrics + network_metrics),
//     calculate-node-prominence, process_structure
//   → read every page's data back as the modeler and report what it found.
//
// Why the analyses run here: a page that finds no current stored result computes it
// itself, as the person looking, and that writes a tier-3 table. A demo that opens
// with its results already stored never asks a visitor's session to write anything.
//
// Idempotent: re-running reuses the project by name, clears its arcs and the deep-tier
// graph, and loads them again.
//
// ── Auth model ───────────────────────────────────────────────────────────────
// Same as the example seed: the app authenticates against approved_users and the
// client always holds the anon JWT, so a LIVE run needs the id AND email of a real
// approved user, who becomes the project's modeler. The project's organization is
// stamped from that identity, and list_projects shows it only to that organization —
// there is deliberately no default.
//
// Usage:
//   node scripts/seed_demo_project.mjs --dry-run
//   USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs
//
// Env:
//   USER_ID, USER_EMAIL   (live run) the modeler who will own the project
//   USER_NAME             (default "Demo Seed")
//   PROJECT_NAME          (default: the dataset's)
//   SKIP_ANALYSES=1       load the data but leave the analyses to the pages
//   DATASET_DIR           the directory holding dataset.json (default: scripts/demo_project;
//                         the large one is scripts/demo_project_large/out)
//   LANES_VIA=sql         for a project too big to promote through the upload path (every
//                         promotion rebuilds the whole project's lanes, and past about 100
//                         products that exceeds the database's per-statement time limit even
//                         for a 20-row file). Writes DATASET_DIR/load_lanes.sql and stops: one
//                         file that loads the BOM, inbound and outbound rows with the rebuild
//                         triggers off, switches them back on and rebuilds ONCE. Run it as a
//                         single transaction (Supabase SQL editor, or `psql -1 -f`), then run
//                         this script again with LANES_VIA=loaded to finish (node list, firm
//                         graph, read-back). The rows skip the ingest tiers and their audit
//                         rows, as the bulk RPCs this script used before always did.
//   LANES_VIA=loaded      the lanes are already in (LANES_VIA=sql ran): skip clearing and
//                         loading them and carry on.
//   BATCH_ROWS            send each bulk call in slices of this many rows (default: all at
//                         once). A slice is one statement, so a big load stays under the
//                         database's per-statement time limit. A slice that still times out
//                         is halved and retried by itself (a timeout rolls the call back).
//   LANES_VIA=ingest      load the three lane files (BOM, inbound, outbound) the way the
//                         upload wizard does — `ingest-file` land, then apply — one part at a
//                         time, from DATASET_DIR/csv_split/ (or csv/ when there is no split).
//                         The bulk RPCs rebuild the project's lanes once PER ROW, which is
//                         what makes a big load time out; the ingest path promotes each file
//                         in one statement. A part that times out is split and retried.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const clientTs = readFileSync(join(repoRoot, "src/integrations/supabase/client.ts"), "utf8");
// SUPABASE_URL in the environment overrides the app's own (used to point the script at a local stand-in).
const SUPABASE_URL = process.env.SUPABASE_URL || clientTs.match(/SUPABASE_URL = "([^"]+)"/)?.[1];
const ANON_KEY = clientTs.match(/SUPABASE_PUBLISHABLE_KEY = "([^"]+)"/)?.[1];
if (!SUPABASE_URL || !ANON_KEY) {
  console.error("could not parse SUPABASE_URL / anon key from client.ts");
  process.exit(2);
}

const DRY_RUN = process.argv.includes("--dry-run");
const USER_ID = process.env.USER_ID || null;
const USER_EMAIL = process.env.USER_EMAIL || null;
const USER_NAME = process.env.USER_NAME || "Demo Seed";
const SKIP_ANALYSES = process.env.SKIP_ANALYSES === "1";

const DATASET_DIR = process.env.DATASET_DIR
  ? join(process.cwd(), process.env.DATASET_DIR)
  : join(repoRoot, "scripts/demo_project");
const BATCH_ROWS = Number(process.env.BATCH_ROWS) > 0 ? Number(process.env.BATCH_ROWS) : Infinity;
const LANES_VIA_INGEST = process.env.LANES_VIA === "ingest";
const LANES_VIA_SQL = process.env.LANES_VIA === "sql";
const LANES_LOADED = process.env.LANES_VIA === "loaded";
const data = JSON.parse(readFileSync(join(DATASET_DIR, "dataset.json"), "utf8"));
const { project: PROJECT, suppliers, materials, products, node_list: nodeList } = data;
const bom = data.bom_multi_level;
const inbound = data.inbound;
const outbound = data.outbound;
const netNodes = data.network_nodes;
const netEdges = data.network_edges;
const PROJECT_NAME = process.env.PROJECT_NAME || PROJECT.name;
const PLANT_NAME = PROJECT.plant;

// ── Local validation: what the RPCs' CHECKs and the gate would refuse ────────────
const FULFILLMENT_MODES = new Set(["mto", "mts"]);
const DEMAND_DISTS = new Set(["triangular", "deterministic", "poisson", "negbin"]);
const LEAD_TIME_DISTS = new Set(["deterministic", "lognormal", "gamma"]);

function validate() {
  const errors = [];
  const enumCheck = (rows, key, set, label) =>
    rows.forEach((r, i) => {
      if (r[key] != null && r[key] !== "" && !set.has(String(r[key]).toLowerCase()))
        errors.push(`${label}[${i}]: ${key}="${r[key]}" not in {${[...set].join(", ")}}`);
    });
  enumCheck(products, "fulfillment_mode", FULFILLMENT_MODES, "products");
  enumCheck(products, "demand_distribution", DEMAND_DISTS, "products");
  enumCheck(materials, "lead_time_dist", LEAD_TIME_DISTS, "materials");

  const supplierIds = new Set(suppliers.map((s) => s.supplier_id));
  const materialIds = new Set(materials.map((m) => m.material_id));
  const productIds = new Set(products.map((p) => p.product_id));
  if (products.length < 1) errors.push("need at least one product");

  // The tree: a leaf is a purchased material and must be sourced; a node that is
  // someone's parent is a sub-assembly, built in the plant, with no lane of its own.
  const parents = new Set(bom.map((b) => b.higher_level_component_id).filter(Boolean));
  const sourced = new Set(inbound.map((i) => i.material_id));
  const levelOf = new Map(bom.map((b) => [b.material_id, b.level]));
  for (const b of bom) {
    const want = b.higher_level_component_id ? (levelOf.get(b.higher_level_component_id) ?? 0) + 1 : 1;
    if (b.level !== want) errors.push(`bom ${b.material_id}: level ${b.level}, expected ${want}`);
    // The platform's pre-run check takes the roots of the tree as the products: a level-1
    // row with no parent, or one naming something that is not a product, leaves the
    // product with no BOM and every run is refused.
    if (b.level === 1 && !productIds.has(b.higher_level_component_id))
      errors.push(`bom ${b.material_id} is level 1 but its parent "${b.higher_level_component_id}" is not a finished product`);
    if (!parents.has(b.material_id)) {
      if (!materialIds.has(b.material_id)) errors.push(`bom leaf ${b.material_id} has no material master`);
      if (!sourced.has(b.material_id)) errors.push(`bom leaf ${b.material_id} is not sourced by any inbound lane`);
    }
  }
  for (const i of inbound) {
    if (!supplierIds.has(i.supplier_id)) errors.push(`inbound supplier ${i.supplier_id} has no master`);
    if (!materialIds.has(i.material_id)) errors.push(`inbound material ${i.material_id} has no master`);
  }
  for (const o of outbound)
    if (!productIds.has(o.product_id)) errors.push(`outbound product ${o.product_id} has no master`);

  // The firm graph: every edge joins two firms that exist, one tier down.
  const byUid = new Map(netNodes.map((n) => [n.uid, n]));
  for (const e of netEdges) {
    const a = byUid.get(e.src_uid), b = byUid.get(e.dst_uid);
    if (!a || !b) errors.push("edge names a firm with no node");
    else if (b.depth !== a.depth + 1) errors.push(`edge ${a.name} → ${b.name} is not one tier down`);
  }
  if (netNodes.filter((n) => n.is_seed).length !== 1) errors.push("need exactly one seed firm");
  return errors;
}

// ── REST / RPC / function helpers ────────────────────────────────────────────────
const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" };

async function call(url, body) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
async function rpc(fn, args) {
  const { status, body } = await call(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, args);
  if (status >= 300) throw new Error(`rpc ${fn} → HTTP ${status}: ${JSON.stringify(body)}`);
  return body;
}
// An analysis that fails does not undo the data: report it and carry on.
async function fn(name, body) {
  const { status, body: out } = await call(`${SUPABASE_URL}/functions/v1/${name}`, body);
  return { ok: status < 300 && !(out && out.error) && !(out && out.success === false), status, out };
}

const rowsFor = (rows, projectId) => rows.map((r) => ({ ...r, plant_name: PLANT_NAME, project_id: projectId }));

const isTimeout = (e) => /57014|statement timeout/i.test(String(e?.message ?? e));

// One bulk call per slice of BATCH_ROWS rows; the answers (row counts) are added up. With the
// default (no slicing) this is exactly the single call it replaces. A slice that hits the
// database's statement timeout is rolled back whole, so it is safe to halve it and try again.
async function bulkSlice(name, rows, extra) {
  try {
    const n = await rpc(name, { ...extra, p_rows: rows });
    return typeof n === "number" ? n : Number(n) || 0;
  } catch (e) {
    if (isTimeout(e) && rows.length > 25) {
      const mid = rows.length >> 1;
      console.log(`    ${name}: ${rows.length} rows timed out — retrying as ${mid} + ${rows.length - mid}`);
      return (await bulkSlice(name, rows.slice(0, mid), extra)) + (await bulkSlice(name, rows.slice(mid), extra));
    }
    throw e;
  }
}
async function bulk(name, rows, extra) {
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) total += await bulkSlice(name, rows.slice(i, i + BATCH_ROWS), extra);
  return total;
}

// ── The lane files, through the upload path ──────────────────────────────────────
// What the wizard sends: multipart to `ingest-file`, mode `land` (stage + diff), then mode
// `apply` with the run id (promote). Nothing here knows a column: the function validates
// against the data contract exactly as it does for a person.
const LANE_FILES = [
  { dataset: "bom_multi_level", stem: "bom_multi_level" },
  { dataset: "inbound_logistics", stem: "inbound_logistics" },
  { dataset: "outbound_logistics", stem: "outbound_logistics" },
];

function lanePartsFor(stem) {
  const split = join(DATASET_DIR, "csv_split");
  const parts = existsSync(split)
    ? readdirSync(split).filter((f) => f.startsWith(`${stem}_part`)).sort()
    : [];
  if (parts.length) return parts.map((f) => ({ name: f, text: readFileSync(join(split, f), "utf8") }));
  const whole = join(DATASET_DIR, "csv", `${stem}.csv`);
  return existsSync(whole) ? [{ name: `${stem}.csv`, text: readFileSync(whole, "utf8") }] : [];
}

async function ingestCall(fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("file", new Blob([file.text], { type: "text/csv" }), file.name);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-file`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: form,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const reasonOf = (r) =>
  `HTTP ${r.status}: ` +
  (typeof r.body === "string" ? r.body.slice(0, 300)
    : r.body?.error ?? (r.body?.findings ?? []).map((f) => f.message).slice(0, 3).join("; ") ?? JSON.stringify(r.body));

// A server that fell over or ran out of time may succeed on less. A 4xx is the file's fault.
const retryable = (r) => r.status >= 500 || isTimeout(JSON.stringify(r.body ?? ""));

/** Cut a CSV in two near the middle. A BOM is cut only between products, so a sub-assembly
 *  stays with its parent; null when it cannot be cut. */
function halve(dataset, text) {
  const lines = text.split("\n").filter((l) => l.length);
  const header = lines[0];
  const rows = lines.slice(1);
  if (rows.length < 40) return null;
  let cut = rows.length >> 1;
  if (dataset === "bom_multi_level") {
    const col = header.split(",").indexOf("higher_level_component_id");
    const owner = (row) => {
      const par = row.split(",")[col] ?? "";
      return par.startsWith("P-") ? par : `P-${par.split("-")[1]}`;
    };
    let i = cut;
    while (i < rows.length && owner(rows[i]) === owner(rows[i - 1])) i++;
    if (i >= rows.length) {
      i = cut;
      while (i > 0 && owner(rows[i]) === owner(rows[i - 1])) i--;
    }
    if (i <= 0 || i >= rows.length) return null;
    cut = i;
  }
  const join2 = (rs) => header + "\n" + rs.join("\n") + "\n";
  return [join2(rows.slice(0, cut)), join2(rows.slice(cut))];
}

async function uploadLaneFile(dataset, projectId, name, text) {
  const t0 = Date.now();
  const rowCount = text.split("\n").filter((l) => l.length).length - 1;
  let failure = null;
  const land = await ingestCall(
    { mode: "land", dataset, project_id: projectId, user_id: USER_ID },
    { name, text },
  );
  if (land.status < 300 && land.body?.success) {
    const apply = await ingestCall({ mode: "apply", run_id: land.body.run_id, user_id: USER_ID });
    if (apply.status < 300 && apply.body?.success) {
      const b = apply.body;
      const held = land.body.rows_held ?? b.rows_held ?? 0;
      console.log(
        `  ✓ ${name}: ${rowCount} rows · new ${b.rows_new ?? land.body.rows_new ?? "?"}` +
        `, changed ${b.rows_changed ?? land.body.rows_changed ?? "?"}` +
        `, unchanged ${b.rows_unchanged ?? land.body.rows_unchanged ?? "?"}` +
        (held ? `, HELD BACK ${held}` : "") + ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
      return;
    }
    failure = { stage: "apply", ...apply };
  } else {
    failure = { stage: "land", ...land };
  }
  if (retryable(failure)) {
    const halves = halve(dataset, text);
    if (halves) {
      console.log(`  … ${name}: ${failure.stage} failed (${reasonOf(failure).slice(0, 90)}) — splitting ${rowCount} rows in two`);
      await uploadLaneFile(dataset, projectId, name.replace(/\.csv$/, "") + "a.csv", halves[0]);
      await uploadLaneFile(dataset, projectId, name.replace(/\.csv$/, "") + "b.csv", halves[1]);
      return;
    }
  }
  throw new Error(`${name} (${dataset}): ${failure.stage} failed — ${reasonOf(failure)}`);
}

async function loadLanesViaIngest(projectId) {
  for (const { dataset, stem } of LANE_FILES) {
    const parts = lanePartsFor(stem);
    if (!parts.length) throw new Error(`no CSV for ${dataset} under ${DATASET_DIR}`);
    console.log(`  ${dataset}: ${parts.length} file(s)`);
    for (const part of parts) await uploadLaneFile(dataset, projectId, part.name, part.text);
  }
}

// ── The lanes as one SQL file ────────────────────────────────────────────────────
const sqlLit = (v) =>
  v === null || v === undefined || v === "" ? "NULL"
  : typeof v === "number" ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

function valuesSql(rows, cols) {
  return rows.map((r) => `(${cols.map((c) => sqlLit(r[c])).join(", ")})`).join(",\n");
}

function lanesSql(projectId) {
  const SLICE = 500;
  const out = [];
  const insert = (table, cols, rows) => {
    for (let i = 0; i < rows.length; i += SLICE) {
      out.push(`INSERT INTO public.${table} (${cols.join(", ")}) VALUES\n${valuesSql(rows.slice(i, i + SLICE), cols)};`);
    }
  };
  const withProject = (rows) => rows.map((r) => ({ ...r, plant_name: PLANT_NAME, project_id: projectId }));
  const bomCols = ["project_id", "plant_name", "material_id", "level", "higher_level_component_id", "consumption_rate"];
  const inCols = ["project_id", "plant_name", "supplier_id", "material_id", "volume", "time_unit", "lead_time", "unit_price"];
  const outCols = ["project_id", "plant_name", "customer_id", "product_id", "volume", "time_unit", "expected_lead_time", "unit_price"];

  out.push(`-- Generated by scripts/seed_demo_project.mjs (LANES_VIA=sql). Project ${projectId}.
--
-- WHAT THIS DOES: loads the BOM (${bom.length} rows), inbound (${inbound.length}) and outbound (${outbound.length}) lanes of
-- "${PROJECT_NAME}" with the lane triggers OFF, switches them back on, and rebuilds the project's lanes
-- ONCE. Through the upload path the same rebuild runs after every file, and on a project this size
-- one rebuild takes longer than the database's per-statement limit.
--
-- RUN IT AS ONE TRANSACTION: paste it into the Supabase SQL editor and press Run, or use
-- \`psql "<connection string>" -1 -f load_lanes.sql\`. If anything fails, the whole file rolls back
-- (the trigger switches too), so nothing is left half-loaded or with a trigger off. Do NOT run it
-- statement by statement.
--
-- WHAT IT SKIPS: the ingest tiers and their audit rows for these lane rows, as the bulk RPCs the
-- first version of this seed used also did.

SET LOCAL statement_timeout = '300s';

ALTER TABLE public.bom_multi_level    DISABLE TRIGGER USER;
ALTER TABLE public.inbound_logistics  DISABLE TRIGGER USER;
ALTER TABLE public.outbound_logistics DISABLE TRIGGER USER;

DELETE FROM public.bom_multi_level    WHERE project_id = '${projectId}';
DELETE FROM public.inbound_logistics  WHERE project_id = '${projectId}';
DELETE FROM public.outbound_logistics WHERE project_id = '${projectId}';
`);
  insert("bom_multi_level", bomCols, withProject(bom));
  insert("inbound_logistics", inCols, withProject(inbound));
  insert("outbound_logistics", outCols, withProject(outbound));
  out.push(`
-- Run any deferred constraint checks now: PostgreSQL refuses to change a table's triggers in a
-- transaction that still has some pending on it.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.bom_multi_level    ENABLE TRIGGER USER;
ALTER TABLE public.inbound_logistics  ENABLE TRIGGER USER;
ALTER TABLE public.outbound_logistics ENABLE TRIGGER USER;

-- What the triggers would have done for these rows: say the project's graph changed, refresh its
-- completion flags, and rebuild its lanes and node list once.
SELECT public._graph_state_mark(ARRAY['${projectId}'::uuid]);
SELECT public._project_completion_refresh('${projectId}'::uuid);
SELECT public.rebuild_supply_chain_lanes('${projectId}'::uuid, '${USER_ID}'::uuid);

-- Read-back: counts, and that no trigger was left off.
SELECT (SELECT count(*) FROM public.bom_multi_level    WHERE project_id = '${projectId}') AS bom_rows,
       (SELECT count(*) FROM public.inbound_logistics  WHERE project_id = '${projectId}') AS inbound_rows,
       (SELECT count(*) FROM public.outbound_logistics WHERE project_id = '${projectId}') AS outbound_rows,
       (SELECT count(*) FROM public.supply_chain_data  WHERE project_id = '${projectId}') AS lanes,
       (SELECT count(*) FROM public.supply_chain_data_multi_tier WHERE project_id = '${projectId}') AS deep_lanes,
       (SELECT count(*) FROM public.node_list          WHERE project_id = '${projectId}') AS nodes,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname IN ('bom_multi_level','inbound_logistics','outbound_logistics')
           AND NOT t.tgisinternal AND t.tgenabled = 'D') AS triggers_left_off;
`);
  return out.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`SuReSuite demo project seed — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  ${SUPABASE_URL}`);

  const errors = validate();
  if (errors.length) {
    console.error(`\n✗ validation FAILED (${errors.length}):`);
    for (const e of errors) console.error(`    - ${e}`);
    process.exit(1);
  }
  console.log("✓ payload validation passed");
  const counts = {
    suppliers: suppliers.length, materials: materials.length, products: products.length,
    bom_multi_level: bom.length, inbound: inbound.length, outbound: outbound.length,
    node_list: nodeList.length, network_nodes: netNodes.length, network_edges: netEdges.length,
  };
  console.log(`  project "${PROJECT_NAME}" · plant "${PLANT_NAME}" · ${PROJECT.model} · bom=${PROJECT.bom_level}`);
  console.log(`  rows: ${JSON.stringify(counts)}`);

  if (LANES_VIA_INGEST) {
    console.log("  lanes via ingest-file:");
    for (const { dataset, stem } of LANE_FILES) {
      const parts = lanePartsFor(stem);
      console.log(`    ${dataset}: ${parts.length} file(s) ${parts.map((p) => p.text.split("\n").filter(Boolean).length - 1).join(" + ")} rows`);
    }
  }
  if (DRY_RUN) {
    console.log("\nDRY RUN complete — no writes performed.");
    return;
  }
  if (!USER_ID || !USER_EMAIL) {
    console.error(
      "\n✗ a LIVE run needs BOTH USER_ID and USER_EMAIL — the approved_users id and email of the\n" +
      "  modeler the project should belong to. The project's organization is stamped from this\n" +
      "  identity, and list_projects shows it only to that organization.\n" +
      "  Re-run with:  USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs",
    );
    process.exit(2);
  }
  const auth = { p_user_id: USER_ID, p_user_email: USER_EMAIL };
  console.log(`  modeler identity: ${USER_EMAIL} (${USER_ID})`);

  // 1 · resolve the project (create or reuse)
  console.log("\n── resolving project");
  const existing = await rpc("list_projects", { ...auth });
  const found = Array.isArray(existing) ? existing.find((p) => p.name === PROJECT_NAME) : null;
  let projectId;
  if (found) {
    projectId = found.id;
    console.log(`  reusing project ${projectId}`);
  } else {
    projectId = await rpc("create_project", {
      p_name: PROJECT_NAME, p_plant: PLANT_NAME, p_model: PROJECT.model, p_bom_level: PROJECT.bom_level,
      p_user_id: USER_ID, p_user_email: USER_EMAIL, p_user_name: USER_NAME,
      p_data_type: "curated", p_deep_tier_enabled: true,
    });
    console.log(`  created project ${projectId}`);
  }

  // 2 · item masters (upsert)
  console.log("── item masters");
  console.log(`  suppliers: ${await bulk("bulk_upsert_suppliers", suppliers, { p_project_id: projectId })}`);
  console.log(`  materials: ${await bulk("bulk_upsert_materials", materials, { p_project_id: projectId })}`);
  console.log(`  products:  ${await bulk("bulk_upsert_products", products, { p_project_id: projectId })}`);

  // 3 · clear what a re-run would duplicate
  console.log("── clearing arcs and the deep-tier graph (idempotency)");
  // In sql mode the file clears the lane sources itself, with the rebuild triggers off; a delete
  // here would fire a rebuild per table over whatever is already loaded.
  if (LANES_LOADED || LANES_VIA_SQL) console.log("  arcs:      left to the next step (LANES_VIA=" + process.env.LANES_VIA + ")");
  else console.log(`  arcs:      ${await rpc("delete_project_dataset", { p_project_id: projectId, p_dataset: "all", ...auth })}`);
  console.log(`  deep tier: ${await rpc("delete_project_dataset", { p_project_id: projectId, p_dataset: "deep_tier", ...auth })}`);

  // 4 · the chain
  console.log("── the chain (multi-level bom + inbound + outbound)");
  if (LANES_VIA_SQL) {
    const file = join(DATASET_DIR, "load_lanes.sql");
    writeFileSync(file, lanesSql(projectId));
    const mb = (readFileSync(file).length / 1e6).toFixed(1);
    console.log(`\n  wrote ${file} (${mb} MB)`);
    console.log("\n  NEXT: run that file as ONE transaction, either");
    console.log("    · Supabase dashboard → SQL Editor → New query → paste the file's contents → Run, or");
    console.log(`    · psql "<connection string from Project Settings → Database>" -1 -f ${file}`);
    console.log("  Its last query prints the row counts and `triggers_left_off` (must be 0).");
    console.log("  Then finish with:");
    console.log("    LANES_VIA=loaded <the same variables as this run> node scripts/seed_demo_project.mjs");
    return;
  } else if (LANES_LOADED) {
    await rpc("update_project_completion_status", { p_project_id: projectId, ...auth });
    console.log("  lanes: already loaded (LANES_VIA=loaded)");
  } else if (LANES_VIA_INGEST) {
    await loadLanesViaIngest(projectId);
    await rpc("update_project_completion_status", { p_project_id: projectId, ...auth });
    // Each promotion rebuilt the lanes through the lane tables' own triggers, so these two are
    // repeated only to be safe. At this size they may exceed the time limit: not fatal.
    for (const name of ["combine_project_into_supply_chain", "rebuild_node_list"]) {
      try {
        await rpc(name, { p_project_id: projectId, ...auth });
        console.log(`  ✓ ${name}`);
      } catch (e) {
        console.log(`  ✗ ${name} (not fatal — the promotions already rebuilt the lanes): ${String(e.message).slice(0, 160)}`);
      }
    }
  } else {
    console.log(`  bom:      ${await bulk("bulk_insert_bom_multi_level", rowsFor(bom, projectId), auth)}`);
    console.log(`  inbound:  ${await bulk("bulk_insert_inbound_logistics", rowsFor(inbound, projectId), auth)}`);
    console.log(`  outbound: ${await bulk("bulk_insert_outbound_logistics", rowsFor(outbound, projectId), auth)}`);
    await rpc("update_project_completion_status", { p_project_id: projectId, ...auth });
    await rpc("combine_project_into_supply_chain", { p_project_id: projectId, ...auth });
    await rpc("rebuild_node_list", { p_project_id: projectId, ...auth });
  }
  // After the rebuild, so the rows exist to be located; the upload only sets the
  // description and the coordinates.
  console.log(`  locations: ${await bulk("upload_node_list_data", nodeList, { p_project_id: projectId, ...auth })}`);

  // 5 · the firm-level graph (nodes first: an edge to a missing firm connects nothing)
  console.log("── the deep-tier firm graph");
  const deep = { p_project_id: projectId, p_plant_name: PLANT_NAME, ...auth };
  console.log(`  nodes: ${await bulk("bulk_insert_network_nodes", netNodes, deep)}`);
  console.log(`  edges: ${await bulk("bulk_insert_network_edges", netEdges, deep)}`);

  // 6 · the analyses, once
  if (SKIP_ANALYSES) {
    console.log("── analyses skipped (SKIP_ANALYSES=1): each page computes its own on first open");
  } else {
    console.log("── analyses (stored once, so no visitor has to start them)");
    const report = (label, r) =>
      console.log(`  ${r.ok ? "✓" : "✗"} ${label}${r.ok ? "" : ` — HTTP ${r.status}: ${JSON.stringify(r.out).slice(0, 200)}`}`);
    report("geocode-locations (the plant's pin)", await fn("geocode-locations", { projectId, userId: USER_ID }));
    report("product_metrics", await fn("calculate-network-science-metrics", { project_id: projectId, uploaded_by: USER_ID, analysis_kind: "product_metrics" }));
    report("network_metrics", await fn("calculate-network-science-metrics", { project_id: projectId, uploaded_by: USER_ID, analysis_kind: "network_metrics" }));
    report("prominence", await fn("calculate-node-prominence", { project_id: projectId, uploaded_by: USER_ID }));
    try {
      const ps = await rpc("process_structure", { p_project_id: projectId, _actor_user_id: USER_ID });
      console.log(`  ✓ process_structure — ${Object.keys(ps?.reachable ?? {}).length} node(s) with stored reachability`);
    } catch (e) {
      console.log(`  ✗ process_structure — ${e.message}`);
    }
  }

  // 7 · read it back the way each page does, as this modeler
  console.log("── reading it back, as the pages do");
  const status = await rpc("get_project_dataset_status", { p_project_id: projectId, ...auth });
  const lanes = await rpc("get_supply_chain_data", { p_project_id: projectId, p_plant_name: null, ...auth });
  const nodesBack = await rpc("get_network_nodes", { p_project_id: projectId, p_plant_name: null, ...auth });
  const edgesBack = await rpc("get_network_edges", { p_project_id: projectId, p_plant_name: null, ...auth });
  const located = await rpc("get_node_list", { p_project_id: projectId, p_plant_name: null, ...auth });
  const withCoords = (located ?? []).filter((n) => n.latitude != null && n.longitude != null).length;
  console.log(`  product/process lanes (get_supply_chain_data): ${lanes?.length ?? 0}`);
  console.log(`  firm nodes / edges: ${nodesBack?.length ?? 0} / ${edgesBack?.length ?? 0}`);
  console.log(`  map nodes with coordinates (get_node_list): ${withCoords} of ${located?.length ?? 0}`);
  console.log(`  dataset status: ${JSON.stringify(status)}`);

  const problems = [];
  if (!lanes?.length) problems.push("no lanes — the product and process pages would be empty");
  if ((nodesBack?.length ?? 0) !== netNodes.length) problems.push(`firm nodes ${nodesBack?.length ?? 0} ≠ ${netNodes.length}`);
  if ((edgesBack?.length ?? 0) !== netEdges.length) problems.push(`firm edges ${edgesBack?.length ?? 0} ≠ ${netEdges.length}`);
  const listed = await rpc("list_projects", { ...auth });
  const seen = Array.isArray(listed) ? listed.find((p) => p.id === projectId) : null;
  if (!seen) problems.push("not visible to this modeler via list_projects (organization scoping)");

  console.log("\n════════ seed complete ════════");
  console.log(`project_id: ${projectId}`);
  if (seen) console.log(`organization: ${seen.organization ?? "(null)"}   modeler_id: ${seen.modeler_id ?? "(null)"}`);
  console.log(`open in app: /network/product-level · /network/process-level · /network/firm-level  (select "${PROJECT_NAME}")`);
  if (problems.length) {
    console.error("\n✗ problems:");
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }
  console.log("✓ every page's data reads back");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message ?? err}`);
  process.exit(1);
});

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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const clientTs = readFileSync(join(repoRoot, "src/integrations/supabase/client.ts"), "utf8");
const SUPABASE_URL = clientTs.match(/SUPABASE_URL = "([^"]+)"/)?.[1];
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

const data = JSON.parse(readFileSync(join(repoRoot, "scripts/demo_project/dataset.json"), "utf8"));
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
  console.log(`  suppliers: ${await rpc("bulk_upsert_suppliers", { p_project_id: projectId, p_rows: suppliers })}`);
  console.log(`  materials: ${await rpc("bulk_upsert_materials", { p_project_id: projectId, p_rows: materials })}`);
  console.log(`  products:  ${await rpc("bulk_upsert_products", { p_project_id: projectId, p_rows: products })}`);

  // 3 · clear what a re-run would duplicate
  console.log("── clearing arcs and the deep-tier graph (idempotency)");
  console.log(`  arcs:      ${await rpc("delete_project_dataset", { p_project_id: projectId, p_dataset: "all", ...auth })}`);
  console.log(`  deep tier: ${await rpc("delete_project_dataset", { p_project_id: projectId, p_dataset: "deep_tier", ...auth })}`);

  // 4 · the chain
  console.log("── the chain (multi-level bom + inbound + outbound)");
  console.log(`  bom:      ${await rpc("bulk_insert_bom_multi_level", { p_rows: rowsFor(bom, projectId), ...auth })}`);
  console.log(`  inbound:  ${await rpc("bulk_insert_inbound_logistics", { p_rows: rowsFor(inbound, projectId), ...auth })}`);
  console.log(`  outbound: ${await rpc("bulk_insert_outbound_logistics", { p_rows: rowsFor(outbound, projectId), ...auth })}`);
  await rpc("update_project_completion_status", { p_project_id: projectId, ...auth });
  await rpc("combine_project_into_supply_chain", { p_project_id: projectId, ...auth });
  await rpc("rebuild_node_list", { p_project_id: projectId, ...auth });
  // After the rebuild, so the rows exist to be located; the upload only sets the
  // description and the coordinates.
  console.log(`  locations: ${await rpc("upload_node_list_data", { p_project_id: projectId, p_rows: nodeList, ...auth })}`);

  // 5 · the firm-level graph (nodes first: an edge to a missing firm connects nothing)
  console.log("── the deep-tier firm graph");
  const deep = { p_project_id: projectId, p_plant_name: PLANT_NAME, ...auth };
  console.log(`  nodes: ${await rpc("bulk_insert_network_nodes", { ...deep, p_rows: netNodes })}`);
  console.log(`  edges: ${await rpc("bulk_insert_network_edges", { ...deep, p_rows: netEdges })}`);

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

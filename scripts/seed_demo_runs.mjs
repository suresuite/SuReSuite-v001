#!/usr/bin/env node
// Give the demo project something to show on /policies and /simulation-lab: two saved
// policy versions, three scenarios and their finished runs.
//
// Run it AFTER scripts/seed_demo_project.mjs has loaded the data. It goes through the
// public API (the same /v1 routes the notebooks use), because that is the one stable
// way to create scenarios, save policy versions and dispatch runs from outside the app:
//
//   freeze the dataset
//   → save policy version A ("Baseline policies") from the project's current policies
//   → set safety stock to 28 days, save version B, and put the policies back as they were
//   → create the scenarios (a normal year; a 6-week outage of the microcontroller's main
//     supplier; a 3-week plant shutdown), reusing any that exist by name
//   → run each scenario under each policy version, one at a time, and wait for it
//
// Idempotent: policy versions are content-addressed, scenarios are found by name, and
// every run carries a fixed Idempotency-Key, so a second run reuses what is there.
//
// WHAT YOU NEED. An API key of the demo project's OWNER with the scopes read:data,
// write:data, read:policies, write:policies, read:runs and write:runs. Sign in as the
// owner, open /developer, create the key, and pass it in the environment — never on the
// command line of a shared machine, and never in a file that is committed.
//
//   node scripts/seed_demo_runs.mjs --dry-run                 # print the plan, call nothing
//   SURESUITE_API_KEY=sk_… node scripts/seed_demo_runs.mjs
//
// Env:
//   SURESUITE_API_KEY   (live run) the owner's key
//   PROJECT_NAME        (default: the demo dataset's)
//   REPLICATIONS        (default 10) replications per run
//
// Prefer a LIVE key (sk_live_). A test key works — it allows one run at a time, which is how
// this runs — but caps a day at 300 requests, and six runs polled every ten seconds only fit
// in that if each finishes within a few minutes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientTs = readFileSync(join(repoRoot, "src/integrations/supabase/client.ts"), "utf8");
const SUPABASE_URL = clientTs.match(/SUPABASE_URL = "([^"]+)"/)?.[1];
if (!SUPABASE_URL) {
  console.error("could not parse SUPABASE_URL from client.ts");
  process.exit(2);
}
const BASE = `${SUPABASE_URL}/functions/v1/api/v1`;

const DRY_RUN = process.argv.includes("--dry-run");
const API_KEY = process.env.SURESUITE_API_KEY || "";
// DEMO=small (default) is scripts/demo_project; DEMO=large is scripts/demo_project_large, read
// from its generated out/ (run its build_dataset.py first).
const DEMO = (process.env.DEMO || "small").toLowerCase();
if (!["small", "large"].includes(DEMO)) {
  console.error(`DEMO must be small or large, not ${DEMO}`);
  process.exit(2);
}
const datasetPath = DEMO === "large"
  ? join(repoRoot, "scripts/demo_project_large/out/dataset.json")
  : join(repoRoot, "scripts/demo_project/dataset.json");
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
const PROJECT_NAME = process.env.PROJECT_NAME || dataset.project.name;
const REPLICATIONS = Number(process.env.REPLICATIONS || 10);

// ── The plan ─────────────────────────────────────────────────────────────────────
// Every figure below was checked by replaying the project's own frozen inputs through the
// engine (sim_worker.local.run_from_snapshots) before it was written here.
// THE CALENDAR. Run week 0 is `projects.simulation_start`. The Welch warm-up detected on the
// demos is 34 weeks, so week 34 — where measuring begins — is put on 1 January 2026 and the
// 52 measured weeks are the year 2026. The engine measures 52 weeks after warm-up and keeps a
// 13-week tail after that window, so the run must be at least 34 + 52 + 13 = 99 weeks; it is 104
// (two years). At 52 weeks, the length used before, only 18 weeks were measured.
const WARMUP_WEEKS = 34;
const HORIZON_WEEKS = 104;
const CALENDAR_START = "2025-05-08";   // run week 0; week 34 = 2026-01-01
const CALENDAR_END = "2027-05-06";     // week 0 + 104 weeks
const DISRUPTION_WEEK = 54;            // 21 May 2026, 20 weeks into the measured year
const DISRUPTION_DAY = DISRUPTION_WEEK * 7;
const FRAME = { horizon_days: HORIZON_WEEKS * 7, warmup_days: WARMUP_WEEKS * 7, replications: REPLICATIONS, seed: 42, crn: true };
const outage = (target, duration_days) =>
  ({ target, target_type: "node", start_day: DISRUPTION_DAY, duration_days, magnitude_pct: 100 });

// Customer terms: how long each customer × product row waits for a late order. With the
// project-wide 14 days every late order still shipped inside the window, so a 3-week plant
// shutdown showed a 51% fill rate and an unchanged revenue. These terms make a late order
// a lost one, as it would be for these customers.
const customerRow = (key, patch) => ({ scope: "node", family: "fulfillment", target_key: key, patch });

let SCENARIOS;
let CUSTOMER_TERMS;
if (DEMO === "small") {
  // The microcontroller is single-sourced from Kestrel (S-MCU, lead time 8 weeks): a 6-week
  // outage is covered by what is already in transit, so the outage runs 10 weeks.
  SCENARIOS = [
    { name: "Normal 2026", description: "Calendar 2026 (week 34–86 of a 104-week run), no disruption.", events: [] },
    {
      name: "Microcontroller outage May 2026 (10 wk)",
      description: "Kestrel Microsystems ships nothing for ten weeks from 21 May 2026.",
      events: [outage("S-MCU", 70)],
    },
    {
      name: "Plant shutdown May 2026 (3 wk)",
      description: "The plant makes nothing for three weeks from 21 May 2026.",
      events: [outage("plant", 21)],
    },
  ];
  CUSTOMER_TERMS = [
    // Spare-parts service: a late order is lost.
    customerRow("C-SERVICE::P-CONTROL", { backorder_allowed: false }),
    // The OEM line waits one week at most.
    customerRow("C-ASSEMBLY::P-CONTROL", { backorder_allowed: true, max_backorder_days: 7 }),
  ];
} else {
  // S-0198 (Husan Sensor Tech) is the single source whose outage costs the most lost sales
  // of the twelve largest, measured with the engine on this dataset (seed 7, 500 suppliers).
  SCENARIOS = [
    { name: "Normal 2026", description: "Calendar 2026 (week 34–86 of a 104-week run), no disruption.", events: [] },
    {
      name: "Sensor supplier outage May 2026 (10 wk)",
      description: "Husan Sensor Tech (S-0198) ships nothing for ten weeks from 21 May 2026.",
      events: [outage("S-0198", 70)],
    },
    {
      name: "Plant shutdown May 2026 (3 wk)",
      description: "The plant makes nothing for three weeks from 21 May 2026.",
      events: [outage("plant", 21)],
    },
  ];
  // Every customer waits one week at most.
  const rows = [...new Set(dataset.outbound.map((o) => `${o.customer_id}::${o.product_id}`))].sort();
  CUSTOMER_TERMS = rows.map((k) => customerRow(k, { backorder_allowed: true, max_backorder_days: 7 }));
}
const POLICY_LABELS = { A: "Baseline — customer terms", B: "Safety stock 28 days — customer terms" };

if (DRY_RUN) {
  console.log("SuReSuite demo runs seed — DRY RUN (nothing is called)\n");
  console.log(`  API: ${BASE}`);
  console.log(`  demo: ${DEMO}   project: "${PROJECT_NAME}"   frame: ${JSON.stringify(FRAME)}`);
  console.log(`  calendar: week 0 = ${CALENDAR_START}, week ${WARMUP_WEEKS} = 2026-01-01, run ends ${CALENDAR_END} (${HORIZON_WEEKS} weeks)`);
  console.log(`  customer terms: ${CUSTOMER_TERMS.length} row(s), e.g. ${JSON.stringify(CUSTOMER_TERMS[0])}`);
  console.log(`  policy versions: A "${POLICY_LABELS.A}", B "${POLICY_LABELS.B}" (inventory.safety_stock_method=fixed_days, safety_stock_days=28)`);
  for (const s of SCENARIOS) console.log(`  scenario "${s.name}" — ${s.events.length} event(s): ${JSON.stringify(s.events)}`);
  console.log(`  runs: ${SCENARIOS.length} scenarios × 2 policy versions = ${SCENARIOS.length * 2}, one at a time`);
  process.exit(0);
}
// Two ways in. With SURESUITE_API_KEY: the public /v1 API. Without one but with USER_ID and
// USER_EMAIL (the owner's approved_users id and email): the app's own path — the same RPCs,
// table writes and sim-command call /policies and the Lab make for that signed-in owner,
// with the app's publishable key, exactly as scripts/seed_demo_project.mjs loads the data.
const USER_ID = process.env.USER_ID || "";
const USER_EMAIL = process.env.USER_EMAIL || "";
const VIA_APP = !API_KEY && !!USER_ID && !!USER_EMAIL;
if (!VIA_APP && !/^sk_(live|test)_/.test(API_KEY)) {
  console.error("a live run needs SURESUITE_API_KEY (an owner's key), or USER_ID + USER_EMAIL of the owner — see the header");
  process.exit(2);
}

// ── A small client for /v1 ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(`[${status} ${e.code ?? "unknown"}] ${e.message ?? JSON.stringify(body)}`);
    this.status = status; this.code = e.code; this.details = e.details;
  }
}
async function api(method, path, body, headers = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(Number(res.headers.get("Retry-After") || 5), 60);
      console.log(`  (${res.status}, waiting ${wait}s)`);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status >= 400) throw new ApiError(res.status, parsed);
    return parsed;
  }
  throw new Error(`${method} ${path}: still throttled after 5 attempts`);
}
const listAll = async (path) => {
  const rows = []; let cursor = null;
  do {
    const page = await api("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    rows.push(...page.data); cursor = page.next_cursor;
  } while (cursor);
  return rows;
};

// ── The app's own path (no API key) ──────────────────────────────────────────────
const ANON_KEY = clientTs.match(/SUPABASE_PUBLISHABLE_KEY = "([^"]+)"/)?.[1];
const appHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" };
async function rest(method, path, body, extra = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method, headers: { ...appHeaders, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.status === 429 || res.status === 503 || res.status === 502) { await sleep(5000); continue; }
    return { status: res.status, body: parsed };
  }
  throw new Error(`${method} ${path}: still failing after 5 attempts`);
}
async function appRpc(fn, args) {
  const r = await rest("POST", `/rest/v1/rpc/${fn}`, args);
  if (r.status >= 300) throw new Error(`rpc ${fn} → HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}
const app = {
  async project() {
    const list = await appRpc("list_projects", { p_user_id: USER_ID, p_user_email: USER_EMAIL });
    return (Array.isArray(list) ? list : []).find((p) => p.name === PROJECT_NAME) ?? null;
  },
  // Run week 0. A run stamps the calendar it was dispatched against, so this comes first.
  setCalendar: (p) => appRpc("update_project", {
    p_project_id: p.id, p_name: p.name, p_plant: p.plant_name, p_model: p.supply_chain_model, p_bom_level: p.bom_level,
    p_user_id: USER_ID, p_user_email: USER_EMAIL, p_simulation_start: CALENDAR_START, p_simulation_end: CALENDAR_END,
  }),
  freeze: (pid) => appRpc("snapshot_dataset", { p_project_id: pid, p_label: "demo dataset", p_user_id: USER_ID, p_user_email: USER_EMAIL }),
  async inventory(pid) {
    const r = await rest("GET", `/rest/v1/policy_defaults?project_id=eq.${pid}&select=inventory`);
    return (Array.isArray(r.body) && r.body[0]?.inventory) || {};
  },
  saveInventory: (pid, value) => appRpc("save_policy_defaults", { p_project_id: pid, p_family: "inventory", p_value: value, _actor_user_id: USER_ID }),
  saveOverrides: (pid, rows) => appRpc("bulk_upsert_policy_overrides", { p_project_id: pid, p_rows: rows, _actor_user_id: USER_ID }),
  async saveVersion(pid, label) {
    const id = await appRpc("snapshot_policy", { p_project_id: pid, p_label: label, p_user_id: USER_ID, p_user_email: USER_EMAIL, p_user_name: "Demo seed" });
    return { id: String(id) };
  },
  async scenarios(pid) {
    const r = await rest("GET", `/rest/v1/scenarios?project_id=eq.${pid}&select=id,name`);
    if (r.status >= 300) throw new Error(`scenarios read → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  },
  async createScenario(pid, s) {
    // The Lab's own defaults (useScenarios.tsx SCENARIO_ENGINE_DEFAULTS) with the frame above.
    const row = {
      project_id: pid, name: s.name, description: s.description, role: "experiment",
      time_step: "day", warmup_mode: "manual", demand_model: { kind: "poisson", lambda: 50 },
      recovery_overrides: {}, stopping_rule: { kind: "fixed_horizon", max_wall_seconds: 600 }, primary_kpi: "fill_rate",
      ...FRAME, disruption_schedule: s.events,
    };
    const r = await rest("POST", "/rest/v1/scenarios", row, { Prefer: "return=representation" });
    if (r.status >= 300) throw new Error(`scenario insert → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body[0];
  },
  async dispatch(pid, scenarioId, versionId, ack) {
    return rest("POST", "/functions/v1/sim-command", {
      project_id: pid, scenario_id: scenarioId, kind: "experiment.run",
      payload: { policy_version_id: versionId, acknowledge_warnings: ack, actor_user_id: USER_ID },
      client_ts: Date.now(),
    });
  },
  async run(id) {
    const r = await rest("GET", `/rest/v1/simulation_runs?id=eq.${id}&select=id,status,aggregate_kpis,error_message`);
    return (Array.isArray(r.body) && r.body[0]) || { status: "unknown" };
  },
};

async function mainViaApp() {
  console.log(`SuReSuite demo runs seed — LIVE, through the app's own path as ${USER_EMAIL}`);
  const project = await app.project();
  if (!project) throw new Error(`no project named "${PROJECT_NAME}" is visible to ${USER_EMAIL} — seed the data first, with the same owner`);
  const pid = project.id;
  console.log(`  project ${pid}`);
  await app.setCalendar(project);
  console.log(`  calendar: week 0 = ${CALENDAR_START}, week ${WARMUP_WEEKS} = 2026-01-01, ${HORIZON_WEEKS} weeks`);

  const ds = await app.freeze(pid);
  console.log(`  dataset version ${String(ds).slice(0, 8)}`);
  await app.saveOverrides(pid, CUSTOMER_TERMS);
  console.log(`  customer terms saved on ${CUSTOMER_TERMS.length} row(s)`);
  const original = await app.inventory(pid);
  const versionA = await app.saveVersion(pid, POLICY_LABELS.A);
  let versionB;
  try {
    await app.saveInventory(pid, { ...original, safety_stock_method: "fixed_days", safety_stock_days: 28 });
    versionB = await app.saveVersion(pid, POLICY_LABELS.B);
  } finally {
    await app.saveInventory(pid, original);
  }
  console.log(`  policy versions: A ${versionA.id.slice(0, 8)}  B ${versionB.id.slice(0, 8)}`);
  if (versionA.id === versionB.id) throw new Error("versions A and B are the same — set the project's safety stock to something else first");

  const existing = await app.scenarios(pid);
  const scenarios = [];
  for (const s of SCENARIOS) {
    let sc = existing.find((x) => x.name === s.name);
    if (!sc) { sc = await app.createScenario(pid, s); console.log(`  created scenario "${s.name}"`); }
    else console.log(`  reusing scenario "${s.name}"`);
    scenarios.push(sc);
  }

  const results = [];
  for (const sc of scenarios) {
    for (const [tag, version] of [["A", versionA], ["B", versionB]]) {
      const label = `${sc.name} · ${POLICY_LABELS[tag]}`;
      let r = await app.dispatch(pid, sc.id, version.id, false);
      if (r.status === 422 && r.body?.validation === "ack_required") {
        console.log(`  ${label}: the data check only warns —`);
        for (const f of r.body.findings ?? []) console.log(`      [${f.severity}] ${f.message}`);
        r = await app.dispatch(pid, sc.id, version.id, true);
      }
      if (r.status === 409 && r.body?.reuse_available) {
        const id = r.body.reuse_candidate?.run_id;
        console.log(`  ✓ ${label}: an identical run already exists (${String(id).slice(0, 8)})`);
        results.push({ label, id, status: "done" });
        continue;
      }
      if (r.status >= 300) {
        for (const f of r.body?.findings ?? []) console.error(`      [${f.severity}] ${f.message}`);
        throw new Error(`${label}: sim-command HTTP ${r.status}: ${JSON.stringify(r.body?.error ?? r.body).slice(0, 400)}`);
      }
      const id = r.body.run_id;
      process.stdout.write(`  ${label}: waiting for run ${String(id).slice(0, 8)}`);
      let run = await app.run(id);
      const t0 = Date.now();
      while (!["done", "failed", "cancelled"].includes(run.status)) {
        if (Date.now() - t0 > 30 * 60 * 1000) throw new Error(`${label}: still ${run.status} after 30 minutes`);
        process.stdout.write(".");
        await sleep(10000);
        run = await app.run(id);
      }
      const k = run.aggregate_kpis ?? {};
      console.log(` ${run.status}${k.fill_rate != null ? ` — fill rate ${(k.fill_rate * 100).toFixed(1)}%, revenue ${Math.round(k.revenue ?? 0).toLocaleString("en")}, lost sales ${Math.round(k.lost_sales_value ?? 0).toLocaleString("en")}` : ""}${run.error_message ? ` — ${run.error_message}` : ""}`);
      results.push({ label, id, status: run.status });
    }
  }
  const failed = results.filter((r) => r.status !== "done");
  console.log(`\n${results.length - failed.length} of ${results.length} runs done.`);
  if (failed.length) {
    console.error("✗ not done:\n" + failed.map((f) => `    - ${f.label}: ${f.status}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ the Lab has three scenarios with results, and /policies two saved versions.");
  console.log("  Left to the app: /policies → Run & Validate, once, to create the Validated Model.");
}

// ── Main ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("SuReSuite demo runs seed — LIVE");
  const key = await api("GET", "/key");
  const need = ["read:data", "write:data", "read:policies", "write:policies", "read:runs", "write:runs"];
  const missing = need.filter((s) => !(key.scopes ?? []).includes(s));
  if (missing.length) throw new Error(`this key cannot use ${missing.join(", ")} — create one with all of: ${need.join(", ")}`);

  const project = (await listAll("/projects")).find((p) => p.name === PROJECT_NAME);
  if (!project) throw new Error(`no project named "${PROJECT_NAME}" is visible to this key — run scripts/seed_demo_project.mjs first, with the same owner`);
  const pid = project.id;
  console.log(`  project ${pid}`);

  // 1 · data and policies
  const frozen = await api("POST", `/projects/${pid}/datasets:freeze`, { label: "demo dataset" });
  console.log(`  dataset version ${frozen.id}`);
  // The customer terms stay on the project: they are its policies from now on.
  await api("PUT", `/projects/${pid}/policies`, { overrides: CUSTOMER_TERMS });
  console.log(`  customer terms saved on ${CUSTOMER_TERMS.length} row(s)`);
  const original = (await api("GET", `/projects/${pid}/policies`)).defaults?.inventory ?? {};
  const versionA = await api("POST", `/projects/${pid}/policy-versions`, { label: POLICY_LABELS.A });
  let versionB;
  try {
    await api("PUT", `/projects/${pid}/policies`, { defaults: { inventory: { ...original, safety_stock_method: "fixed_days", safety_stock_days: 28 } } });
    versionB = await api("POST", `/projects/${pid}/policy-versions`, { label: POLICY_LABELS.B });
  } finally {
    // The project's own policies go back exactly as they were, even if the save failed.
    await api("PUT", `/projects/${pid}/policies`, { defaults: { inventory: original } });
  }
  console.log(`  policy versions: A ${versionA.id.slice(0, 8)}  B ${versionB.id.slice(0, 8)}${versionA.id === versionB.id ? "   ✗ identical — safety stock was already 28 days" : ""}`);
  if (versionA.id === versionB.id) throw new Error("versions A and B are the same, so there is nothing to compare — set the project's safety stock to something else first");

  // 2 · scenarios (found by name, else created)
  const existing = await listAll(`/projects/${pid}/scenarios`);
  const scenarios = [];
  for (const s of SCENARIOS) {
    let sc = existing.find((x) => x.name === s.name);
    if (!sc) {
      const created = await api("POST", `/projects/${pid}/scenarios`, {
        name: s.name, description: s.description, ...FRAME, disruption_schedule: s.events,
      });
      sc = { id: created.id, name: s.name };
      console.log(`  created scenario "${s.name}"`);
    } else {
      console.log(`  reusing scenario "${s.name}"`);
    }
    scenarios.push(sc);
  }

  // 3 · runs, one at a time
  const results = [];
  for (const sc of scenarios) {
    for (const [tag, version] of [["A", versionA], ["B", versionB]]) {
      const label = `${sc.name} · ${POLICY_LABELS[tag]}`;
      // Keyed on the policy VERSION too: a new version of the same scenario is a new run.
      const idem = `demo-seed-${sc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}-${version.id.slice(0, 8)}`;
      const body = { scenario_id: sc.id, policy_version_id: version.id };
      let run;
      try {
        run = await api("POST", `/projects/${pid}/runs`, body, { "Idempotency-Key": idem });
      } catch (e) {
        if (e.code === "reuse_available") {
          const id = e.details?.reuse_candidate?.run_id;
          console.log(`  ✓ ${label}: an identical run already exists (${id?.slice(0, 8)})`);
          results.push({ label, id, status: "done", reused: true });
          continue;
        }
        if (e.code === "validation_failed" && e.details?.validation === "ack_required") {
          console.log(`  ${label}: the data check only warns —`);
          for (const f of e.details.findings ?? []) console.log(`      [${f.severity}] ${f.message}`);
          run = await api("POST", `/projects/${pid}/runs`, { ...body, acknowledge_warnings: true }, { "Idempotency-Key": `${idem}-ack` });
        } else {
          // Say what the data check found: a bare "validation_failed" is not actionable.
          if (e.code === "validation_failed")
            for (const f of e.details?.findings ?? []) console.error(`      [${f.severity}] ${f.message}`);
          throw e;
        }
      }
      process.stdout.write(`  ${label}: waiting for run ${(run.run_id ?? run.id).slice(0, 8)}`);
      const id = run.run_id ?? run.id;
      let r = await api("GET", `/runs/${id}`);
      const t0 = Date.now();
      while (!["done", "failed", "cancelled"].includes(r.status)) {
        if (Date.now() - t0 > 30 * 60 * 1000) throw new Error(`${label}: still ${r.status} after 30 minutes`);
        process.stdout.write(".");
        await sleep(10000);
        r = await api("GET", `/runs/${id}`);
      }
      const fill = r.aggregate_kpis?.fill_rate;
      console.log(` ${r.status}${r.status === "done" && fill != null ? ` — fill rate ${(fill * 100).toFixed(1)}%` : ""}${r.error_message ? ` — ${r.error_message}` : ""}`);
      results.push({ label, id, status: r.status });
    }
  }

  const failed = results.filter((r) => r.status !== "done");
  console.log(`\n${results.length - failed.length} of ${results.length} runs done.`);
  if (failed.length) {
    console.error("✗ not done:\n" + failed.map((f) => `    - ${f.label}: ${f.status}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ /simulation-lab now has three scenarios with results, and /policies two saved versions.");
  console.log("  One step stays manual: the Policies page's Run & Validate queue belongs to the");
  console.log("  project's validation baseline, which only the app creates. As the owner, open");
  console.log("  /policies → Run & Validate and run one baseline.");
}

(VIA_APP ? mainViaApp() : main()).catch((err) => {
  console.error(`\n✗ ${err.message ?? err}`);
  process.exit(1);
});

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
const dataset = JSON.parse(readFileSync(join(repoRoot, "scripts/demo_project/dataset.json"), "utf8"));
const PROJECT_NAME = process.env.PROJECT_NAME || dataset.project.name;
const REPLICATIONS = Number(process.env.REPLICATIONS || 10);

// ── The plan ─────────────────────────────────────────────────────────────────────
// The microcontroller has two sources; Kestrel (S-MCU) ships 70% of it.
const MAIN_MCU_SUPPLIER = "S-MCU";
const FRAME = { horizon_days: 364, replications: REPLICATIONS, seed: 42, crn: true };
const outage = (target, start_day, duration_days) =>
  ({ target, target_type: "node", start_day, duration_days, magnitude_pct: 100 });

const SCENARIOS = [
  { name: "Normal year", description: "52 weeks, no disruption.", events: [] },
  {
    name: "Microcontroller supplier outage (6 weeks)",
    description: "Kestrel Microsystems ships nothing for six weeks from week 20.",
    events: [outage(MAIN_MCU_SUPPLIER, 140, 42)],
  },
  {
    name: "Plant shutdown (3 weeks)",
    description: "The plant makes nothing for three weeks from week 20.",
    events: [outage("plant", 140, 21)],
  },
];
const POLICY_LABELS = { A: "Baseline policies", B: "Safety stock 28 days" };

if (DRY_RUN) {
  console.log("SuReSuite demo runs seed — DRY RUN (nothing is called)\n");
  console.log(`  API: ${BASE}`);
  console.log(`  project: "${PROJECT_NAME}"   frame: ${JSON.stringify(FRAME)}`);
  console.log(`  policy versions: A "${POLICY_LABELS.A}", B "${POLICY_LABELS.B}" (inventory.safety_stock_method=fixed_days, safety_stock_days=28)`);
  for (const s of SCENARIOS) console.log(`  scenario "${s.name}" — ${s.events.length} event(s): ${JSON.stringify(s.events)}`);
  console.log(`  runs: ${SCENARIOS.length} scenarios × 2 policy versions = ${SCENARIOS.length * 2}, one at a time`);
  process.exit(0);
}
if (!/^sk_(live|test)_/.test(API_KEY)) {
  console.error("a live run needs SURESUITE_API_KEY (an owner's key, sk_test_… or sk_live_…) — see the header");
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
      const idem = `demo-seed-${sc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tag}`;
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

main().catch((err) => {
  console.error(`\n✗ ${err.message ?? err}`);
  process.exit(1);
});

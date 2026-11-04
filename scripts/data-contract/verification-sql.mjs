#!/usr/bin/env node
/**
 * PLAN.md §15 — the verification SQL, executed.
 *
 * WHY THIS FILE EXISTS. §15 says "run against one project before Phase 0 and
 * after each phase; record counts in §16". It had never been run when Phase 2
 * closed, because no work-package session can open a database connection — the
 * egress proxy denies CONNECT — and §15 is written as a psql script nobody in
 * this repo is positioned to paste anywhere. So §15 sat as prose through two
 * phases while four decisions accumulated behind it (§16 PHASE BOUNDARY).
 *
 * The route is the one §16's WP 2.1 follow-up and `seed-project.yml` already
 * prove: CI holds `SUPABASE_ACCESS_TOKEN`, and the Supabase Management API's
 * `/database/query` endpoint runs SQL against the live project. This script is
 * the §15 queries against that endpoint, and `verification-sql.yml` is the
 * dispatcher.
 *
 * READ-ONLY BY CONSTRUCTION, not by discipline. Every statement below is a
 * single `select`. There is no transaction to leave open, no DDL, and no
 * write path to get wrong — which matters because this is the one script in
 * the repo pointed at PRODUCTION DATA. `assertReadOnly()` refuses to send
 * anything whose first keyword is not `select` or `with`, so a later edit that
 * adds a write fails before it reaches the wire rather than after.
 *
 * WHAT IT PRINTS is counts and bounded samples, because counts are what §16
 * records and because a full dump of `material_id` spellings into a git branch
 * is a data export nobody asked for. Sample lists are capped at SAMPLE_CAP.
 *
 * Usage:  SUPABASE_ACCESS_TOKEN=… node scripts/data-contract/verification-sql.mjs [--project <uuid>] [--out report.md]
 */

import { readFileSync, writeFileSync } from "node:fs";

const SAMPLE_CAP = 8;
const API = "https://api.supabase.com/v1/projects";

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outPath = argOf("--out");
let forcedProject = argOf("--project");

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN is not set — this script only runs in CI.");
  process.exit(2);
}

// The project ref is read from the client the app itself ships, so this script
// can never be pointed at a different project by an environment variable.
const clientTs = readFileSync(new URL("../../src/integrations/supabase/client.ts", import.meta.url), "utf8");
const ref = clientTs.match(/SUPABASE_URL\s*=\s*"https:\/\/([^.]+)\./)?.[1];
if (!ref) {
  console.error("could not read the project ref from src/integrations/supabase/client.ts");
  process.exit(2);
}

const lines = [];
const out = (...parts) => {
  // `table()` returns an ARRAY of lines, and the first version of this spread it
  // into `out(...)` against a single-parameter signature — which printed the
  // header and silently dropped every data row. A reporting script that loses
  // its own rows is the §5 T1 defect in miniature, so out() takes many.
  for (const s of parts.length ? parts : [""]) {
    lines.push(s);
    console.log(s);
  }
};

function assertReadOnly(sql) {
  const first = sql.replace(/^\s*(--[^\n]*\n|\s)+/g, "").slice(0, 12).trim().toLowerCase();
  if (!first.startsWith("select") && !first.startsWith("with")) {
    throw new Error(`refusing to send a non-SELECT statement: ${sql.slice(0, 80)}…`);
  }
}

let queryCount = 0;
async function q(sql) {
  assertReadOnly(sql);
  queryCount += 1;
  const res = await fetch(`${API}/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** Run a query that may reference a table production does not have. */
async function tryQ(sql) {
  try {
    return { rows: await q(sql) };
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
}

const sample = (arr) => {
  const a = arr ?? [];
  return a.length <= SAMPLE_CAP ? a : [...a.slice(0, SAMPLE_CAP), `…+${a.length - SAMPLE_CAP} more`];
};

function table(rows, cols) {
  if (!rows || rows.length === 0) return ["  (no rows)"];
  const head = cols ?? Object.keys(rows[0]);
  const body = rows.map((r) => head.map((c) => String(r[c] ?? "")));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => "  | " + cells.map((c, i) => c.padEnd(w[i])).join(" | ") + " |";
  return [fmt(head), "  |" + w.map((n) => "-".repeat(n + 2)).join("|") + "|", ...body.map(fmt)];
}

function section(title) {
  out("");
  out(`### ${title}`);
  out(`<!-- at ${new Date().toISOString()} -->`);
  out("");
}

function report(label, res, render) {
  if (res.error) {
    out(`- **${label}** — QUERY FAILED: \`${res.error.replace(/\n/g, " ").slice(0, 300)}\``);
    return null;
  }
  render(res.rows);
  return res.rows;
}

// THE PROBE IS NOW A GATE (D43). Anything pushed here makes the run exit
// non-zero, so `verification-sql.yml` goes red and the report still publishes.
// §15 is the only instrument in this repo that can see production; a finding it
// can only ever REPORT is a finding nothing enforces, which is how `customers`
// and `product_code_map` sat untracked long enough for R4 to lose sight of them.
const gateFailures = [];

// ── schema probe: what does production ACTUALLY have? (D32, D43) ───────────
// ── THE MIGRATION FENCE (D153) ──────────────────────────────────────────────
//
// §15 must not race a deploy, and the rule for that has always been a HABIT: do
// not put a probe in the same push as a migration. That habit is satisfiable on a
// feature branch and **unsatisfiable at the merge**, which is where both workflows
// actually fire — `supabase-migrations.yml` is `branches: [main]` and this workflow
// has no branch filter at all, so a branch that touched a migration AND one of the
// three §15 doors fires both on its merge commit, at the same second, by
// construction. Run `35466205199` is that: the report is stamped 20:03:28 and the
// seven migrations applied at 20:04:11–13, in the middle of its 74 statements.
//
// So the instrument detects it instead of the author remembering. `max(version)` of
// the migration ledger is read BEFORE the first probe and again AFTER the last one.
// If it moved, the database changed underneath the report and every count in it is of
// an unknown shape — which is a GATE FAILURE, not a footnote, because a number nobody
// can date is the thing this whole file exists to replace.
//
// Each `### ` heading also carries an HTML-comment timestamp, so a raced report can
// still be read: the sections before the deploy are of the old shape and those after
// are of the new one, and the boundary is visible rather than guessed.
let fenceBefore = null;

async function migrationFenceOpen() {
  const res = await tryQ(
    `select max(version) as version, count(*)::int as applied
       from supabase_migrations.schema_migrations`);
  fenceBefore = res.rows?.[0] ?? null;
  out(
    `- migration ledger at start: **${fenceBefore?.version ?? "unreadable"}** ` +
      `(${fenceBefore?.applied ?? "?"} applied)`,
  );
}

async function migrationFenceClose() {
  const res = await tryQ(
    `select max(version) as version, count(*)::int as applied
       from supabase_migrations.schema_migrations`);
  const after = res.rows?.[0] ?? null;
  section("The migration fence — did the database change under this report?");
  if (!fenceBefore || !after) {
    out("- **UNREADABLE.** `supabase_migrations.schema_migrations` could not be read at",
        "  one or both ends, so this run cannot say whether a deploy landed during it.");
    gateFailures.push(
      "the migration fence could not be read, so no count in this report can be " +
        "dated against the schema it describes (PLAN.md §4 D153).",
    );
    return;
  }
  const moved = String(fenceBefore.version) !== String(after.version) ||
    Number(fenceBefore.applied) !== Number(after.applied);
  out(`  | end | version | applied |`,
      `  |-----|---------|---------|`,
      `  | before | ${fenceBefore.version} | ${fenceBefore.applied} |`,
      `  | after  | ${after.version} | ${after.applied} |`);
  if (moved) {
    out(
      "- **A DEPLOY LANDED WHILE THIS REPORT WAS BEING WRITTEN.** The counts above",
      "  describe two different databases and the report cannot say which section got",
      "  which. Use the per-section timestamps against the deploy log to find the",
      "  boundary, then request a fresh run in a push that carries no migration.",
    );
    gateFailures.push(
      `the migration ledger moved from ${fenceBefore.version} to ${after.version} ` +
        `during this run (${fenceBefore.applied} → ${after.applied} applied): the report ` +
        `straddles a deploy and every count in it is of an unknown shape. Request a ` +
        `fresh run from a push carrying no migration (PLAN.md §4 D153).`,
    );
  } else {
    out(
      `- **Unmoved at \`${after.version}\`.** No migration was applied between the first`,
      "  probe and the last, so every count in this report is of one schema.",
    );
  }
}

// ── TEMPORARY session diagnostic (branch claude/rq-scenario-revenue-zero) ───
// Read-only look at one project's runs: an (R,Q) scenario reports revenue 0
// while the (s,S) scenario on the same project does not. Removed after the
// diagnosis; every statement is a SELECT like the rest of the file.
const DIAG_PROJECT = "50141cd1-9285-4d91-a7d1-dbd91a3ffcb5";
const DIAG_SCENARIO = "9a3aecb6-c2b4-462f-b5b9-034ca87608e8";

async function rqScenarioDiagnostic() {
  section("TEMPORARY DIAGNOSTIC — (R,Q) scenario revenue 0");
  out(`- project \`${DIAG_PROJECT}\`, scenario \`${DIAG_SCENARIO}\``);
  out("");

  const runs = await tryQ(`
    select r.id, r.scenario_id, s.name as scenario_name, r.status, r.code_version,
           r.rep_count_done, r.rep_count_target, r.created_at, r.ended_at,
           r.aggregate_kpis->>'revenue'          as revenue,
           r.aggregate_kpis->>'fill_rate'        as fill_rate,
           r.aggregate_kpis->>'lost_sales_value' as lost_sales_value,
           r.aggregate_kpis->'_meta'->>'engine'  as engine,
           left(coalesce(r.error_message, ''), 240) as error_message
    from simulation_runs r
    left join scenarios s on s.id = r.scenario_id
    where r.project_id = '${DIAG_PROJECT}'
    order by r.created_at desc
    limit 14`);
  out("**All recent runs in the project (both scenarios, newest first):**");
  report("runs", runs, (rows) => out(...table(rows, [
    "id", "scenario_name", "status", "code_version", "rep_count_done",
    "revenue", "fill_rate", "lost_sales_value", "engine", "created_at", "error_message",
  ])));

  const kpis = await tryQ(`
    select id, status, created_at, aggregate_kpis::text as aggregate_kpis
    from simulation_runs
    where project_id = '${DIAG_PROJECT}' and scenario_id = '${DIAG_SCENARIO}'
    order by created_at desc
    limit 2`);
  out("", "**Full aggregate_kpis of the newest runs on the named scenario:**");
  report("kpis", kpis, (rows) => {
    for (const r of rows) {
      out(`- run \`${r.id}\` (${r.status}, ${r.created_at}):`);
      out("  ```json", "  " + String(r.aggregate_kpis ?? "null").slice(0, 6000), "  ```");
    }
  });

  const warns = await tryQ(`
    select r.id as run_id, r.created_at, w->>'level' as level, w->>'entity' as entity,
           w->>'field' as field, left(w->>'reason', 200) as reason
    from simulation_runs r,
         jsonb_array_elements(coalesce(r.mapping_warnings, '[]'::jsonb)) w
    where r.id in ('33b669c0-b52e-49d2-be6c-105081b08912',
                   '154d7032-a01c-4456-9f04-f4dc86549a5b')
    order by r.created_at, w->>'entity'
    limit 90`);
  out("", "**Mapping warnings on the two Test New runs (154d7032 = the (R,Q) one):**");
  report("warnings", warns, (rows) => out(...table(rows, [
    "run_id", "level", "entity", "field", "reason",
  ])));

  const pol = await tryQ(`
    select r.id as run_id, pv.label,
           (pv.snapshot->'defaults'->'inventory')::text as inventory_default,
           left((pv.snapshot->'defaults')::text, 2500)  as defaults_all,
           left((pv.snapshot->'overrides')::text, 4000) as overrides
    from simulation_runs r
    join policy_versions pv on pv.id = r.policy_version_id
    where r.project_id = '${DIAG_PROJECT}'
    order by r.created_at desc
    limit 4`);
  out("", "**Policy snapshot per recent run — default inventory + overrides:**");
  report("policy", pol, (rows) => {
    for (const r of rows) {
      out(`- run \`${r.run_id}\` · version "${r.label}"`);
      out(`  inventory default: \`${String(r.inventory_default).slice(0, 1200)}\``);
      out(`  defaults (all families): \`${String(r.defaults_all).slice(0, 2500)}\``);
      out(`  overrides: \`${String(r.overrides).slice(0, 4000)}\``);
    }
  });

  const reps = await tryQ(`
    select rr.run_id, rr.rep_index, rr.status,
           rr.kpis->>'revenue' as revenue, rr.kpis->>'fill_rate' as fill_rate,
           rr.kpis->>'lost_sales_value' as lost_sales_value
    from run_replications rr
    where rr.run_id in (select id from simulation_runs
                        where project_id = '${DIAG_PROJECT}'
                          and scenario_id = '${DIAG_SCENARIO}')
    order by rr.run_id, rr.rep_index
    limit 12`);
  out("", "**Replication rows for the named scenario's runs:**");
  report("replications", reps, (rows) => out(...table(rows)));

  const scen = await tryQ(`
    select id, name, horizon_days, time_step, warmup_mode, warmup_days,
           replications, seed, crn, primary_kpi, from_network,
           left(demand_model::text, 500) as demand_model,
           left(disruption_schedule::text, 300) as disruption_schedule
    from scenarios
    where project_id = '${DIAG_PROJECT}'
    order by created_at desc
    limit 6`);
  out("", "**The project's scenarios (newest first):**");
  report("scenarios", scen, (rows) => {
    for (const r of rows) {
      out(`- \`${r.id}\` **${r.name}** — horizon ${r.horizon_days}d, step ${r.time_step}, ` +
          `warmup ${r.warmup_mode}/${r.warmup_days}, reps ${r.replications}, seed ${r.seed}, ` +
          `crn ${r.crn}, primary_kpi ${r.primary_kpi}, from_network ${r.from_network}`);
      out(`  demand_model: \`${String(r.demand_model).slice(0, 500)}\``);
      out(`  disruptions: \`${String(r.disruption_schedule).slice(0, 300)}\``);
    }
  });
}

async function schemaProbe() {
  section("Schema probe — production vs. the migrations (D32, D43)");

  const live = await q(`
    select table_name, table_type
    from information_schema.tables
    where table_schema = 'public'
    order by table_name`);
  const liveNames = new Set(live.map((r) => r.table_name));

  const art = JSON.parse(readFileSync(new URL("../../build/schema.introspected.json", import.meta.url), "utf8"));
  // `tables` is an ARRAY of records; `views` is an OBJECT keyed by name. Reading
  // both the same way made every table look missing AND every relation look
  // untracked — 76 and 78 on the first run, which is how this bug announced
  // itself: a divergence report whose two halves are both "everything".
  const artTables = (art.tables ?? []).map((t) => t.name);
  const artViews = Object.keys(art.views ?? {});

  const missingTables = artTables.filter((t) => !liveNames.has(t));
  const missingViews = artViews.filter((t) => !liveNames.has(t));
  const extra = [...liveNames].filter((t) => !artTables.includes(t) && !artViews.includes(t));

  out(`- migrations create **${artTables.length} tables** and **${artViews.length} views**; production's \`public\` schema holds **${live.length} relations**.`);
  out(`- **created by a migration, ABSENT from production: ${missingTables.length} tables, ${missingViews.length} views**`);
  if (missingTables.length) out(...table(missingTables.map((t) => ({ missing_table: t }))));
  if (missingViews.length) out(...table(missingViews.map((t) => ({ missing_view: t }))));
  out(`- **present in production, created by NO migration: ${extra.length}**`);
  if (extra.length) {
    // The shape, not just the name. Adopting a relation means writing a
    // `CREATE TABLE IF NOT EXISTS` that matches what is already there (WP 1.4's
    // `risk_data` pattern), and that cannot be written from a name alone — the
    // reason D43 sat open is that nobody could see the columns from a session.
    for (const name of extra) {
      const cols = await tryQ(`
        select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = '${name}'
        order by ordinal_position`);
      const n = await tryQ(`select count(*)::int as rows from public.${name}`);
      const kind = live.find((r) => r.table_name === name)?.table_type ?? "?";
      out("");
      out(`**\`${name}\`** — ${kind}, **${n.rows?.[0]?.rows ?? "?"} rows**`);
      report(`${name} columns`, cols, (rows) => out(...table(rows)));
    }
    gateFailures.push(
      `${extra.length} relation(s) exist in production that no migration creates: ` +
        `${extra.join(", ")}. Adopt each with a CREATE TABLE IF NOT EXISTS migration ` +
        `(WP 1.4's risk_data is the pattern) or drop it. PLAN.md §4 D43.`,
    );
  }

  return liveNames;
}

// ── D38: the declared exception, asked of PRODUCTION rather than of a rehearsal
//
// The Supabase database linter reports `v_admin_user_usage` as
// `security_definer_view`, ERROR, EXTERNAL — and it is RIGHT that the view runs
// as its owner. That is the one declared exception to D38: `approved_users` is
// REVOKEd from `authenticated` (20250826015629), so `security_invoker = true`
// raises "permission denied" for every reader including the super admins whose
// two pages are its only consumers. `20260916000009` proved that by executing it.
//
// The exception is safe for exactly one reason: the view states its own
// authorization, `WHERE public.current_is_super_admin()`, the same predicate
// `ai_usage_logs`'s own policy enforces. Without that line an owner-run view
// hands every user's month-to-date AI SPEND to anyone who can select from it.
//
// WHAT WAS MISSING IS THE HALF §15 EXISTS FOR. `supabase/rehearsal/030` asserts
// both clauses — no seventh owner-view, and this one keeps its predicate — but
// against a database built from the migrations ON THE BRANCH. Nothing had ever
// asked PRODUCTION. The schema probe above compares relation NAMES, so a view
// that exists under the right name with the wrong `reloptions`, or one replaced
// from the SQL editor, is invisible to it. That is D45's lesson with a different
// object in it: WP 2.3 claimed the data-plane audit worked on the strength of a
// migration that landed, and §15 found zero rows. This is the same claim about
// views, made against the database the linter is actually looking at.
//
// A GATE, not a report (D43): either half failing is a live disclosure of
// per-person cost data, which is not a finding to read in a branch later.
async function viewSecurity() {
  section("D38 — every view runs as its caller, or is the declared exception");

  // `pg_options_to_table` yields (option_name, option_value); a view with no
  // reloptions at all yields no row, which is `security_invoker` OFF — Postgres
  // defaults it off, which is the whole of why D38 was a class rather than a bug.
  const res = await tryQ(`
    select c.relname as view_name,
           coalesce((select o.option_value = 'true'
                       from pg_options_to_table(c.reloptions) o
                      where o.option_name = 'security_invoker'), false) as security_invoker,
           pg_get_viewdef(c.oid, true) like '%current_is_super_admin()%' as states_own_rule
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
    order by c.relname`);

  if (res.error) {
    out(`- **view security** — QUERY FAILED: \`${res.error.replace(/\n/g, " ").slice(0, 300)}\``);
    gateFailures.push(
      "the D38 view-security probe could not run, so nothing in this repository " +
        "has checked production's views. PLAN.md §4 D38.",
    );
    return;
  }

  // The Management API renders a boolean as JSON `true` on some paths and as the
  // string `"t"`/`"true"` on others; reading only one of the two would report
  // every view as owner-run and fail this gate on all seven.
  const truthy = (v) => v === true || v === "t" || v === "true";
  const rows = res.rows.map((r) => ({
    view_name: r.view_name,
    security_invoker: truthy(r.security_invoker),
    states_own_rule: truthy(r.states_own_rule),
  }));

  out(`- production's \`public\` schema holds **${rows.length} view${rows.length === 1 ? "" : "s"}**.`);
  out(...table(rows.map((r) => ({
    view: r.view_name,
    runs_as: r.security_invoker ? "caller" : "OWNER",
    states_own_rule: r.states_own_rule ? "yes" : "—",
  }))));

  const EXCEPTION = "v_admin_user_usage";

  // 1 · a SEVENTH owner-view. The rehearsal fails on this against the branch;
  //     this fails on it against the database, which is where a view created
  //     outside a migration actually appears.
  const ownerRun = rows.filter((r) => !r.security_invoker && r.view_name !== EXCEPTION);
  if (ownerRun.length) {
    gateFailures.push(
      `${ownerRun.length} view(s) in production run as their OWNER and bypass their ` +
        `base tables' RLS: ${ownerRun.map((r) => r.view_name).join(", ")}. Set ` +
        `security_invoker = true in a migration, or — if the view cannot take it — ` +
        `give it its own authorization predicate and declare it the way ` +
        `20260916000009 declares v_admin_user_usage. PLAN.md §4 D38.`,
    );
  }

  // 2 · the exception without the thing that makes it one.
  const exc = rows.find((r) => r.view_name === EXCEPTION);
  if (!exc) {
    out(`- \`${EXCEPTION}\` is ABSENT from production — the schema probe above should already have failed this run.`);
  } else if (!exc.security_invoker && !exc.states_own_rule) {
    gateFailures.push(
      `${EXCEPTION} runs as its OWNER in production and its definition does NOT ` +
        `contain current_is_super_admin(). An owner-run view with no predicate of ` +
        `its own returns every user's month-to-date AI requests, tokens and ` +
        `cost_usd to any reader who can select from it — the disclosure ` +
        `20260916000009 closed. Restore the WHERE clause. PLAN.md §4 D38.`,
    );
  } else if (exc.security_invoker) {
    // Not a disclosure — the opposite failure, and it takes the admin area down
    // rather than leaking from it. A gate because both admin pages break.
    gateFailures.push(
      `${EXCEPTION} carries security_invoker = true in production. approved_users ` +
        `is REVOKEd from authenticated (20250826015629), so this view now raises ` +
        `"permission denied for table approved_users" for EVERY reader — ` +
        `AdminDashboard and AdminUsers are both broken. PLAN.md §4 D38.`,
    );
  } else {
    out(`- \`${EXCEPTION}\` runs as its owner AND states its own rule — the declared exception is intact in production.`);
  }
}

// ── D30: which of the two migrations actually ran? ─────────────────────────
//
// `20250913085427` creates the view/modify policy pair on `simulation_cache`,
// `simulation_jobs` and `simulation_performance_metrics`; `20250914113723`
// creates all six AGAIN, verbatim apart from `public.` qualification, and
// neither drops first. `CREATE POLICY` on an existing name raises 42710, so
// exactly one of two things is true and NO STATIC REPLAY CAN SAY WHICH: either
// the earlier file never took effect, or the later one aborted at its first
// duplicate and every statement after it never ran.
//
// It is decidable, and it does not need a `db push` to decide it. The two files
// end with DIFFERENTLY NAMED triggers — `20250913085427` writes
// `simulation_jobs_defaults` / `simulation_job_timing_trigger` and the function
// `cleanup_simulation_cache()`; `20250914113723` writes
// `set_simulation_jobs_defaults` / `update_simulation_job_timing`. Whichever
// set production holds is the file that ran past its policy block.
async function d30() {
  section("D30 — which of the two duplicate-policy migrations ran");

  const trigs = await tryQ(`
    select t.tgname as trigger_name, c.relname as on_table
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal
      and t.tgname in (
        'simulation_jobs_defaults','simulation_cache_defaults',
        'simulation_performance_metrics_defaults','simulation_job_timing_trigger',
        'set_simulation_jobs_defaults','set_simulation_cache_defaults',
        'set_simulation_performance_metrics_defaults','update_simulation_job_timing')
    order by 1`);
  report("the triggers each file would have left behind", trigs, (rows) => {
    const names = new Set(rows.map((r) => r.trigger_name));
    const early = ['simulation_jobs_defaults', 'simulation_cache_defaults',
      'simulation_performance_metrics_defaults', 'simulation_job_timing_trigger']
      .filter((n) => names.has(n));
    const late = ['set_simulation_jobs_defaults', 'set_simulation_cache_defaults',
      'set_simulation_performance_metrics_defaults', 'update_simulation_job_timing']
      .filter((n) => names.has(n));
    out(...table(rows));
    out(`- from \`20250913085427\`: **${early.length} of 4**; from \`20250914113723\`: **${late.length} of 4**.`);
    if (early.length === 4 && late.length === 0)
      out("- **SETTLED: `20250913085427` ran to completion and `20250914113723` ABORTED at its first duplicate `CREATE POLICY` (42710).** Everything after statement 155 of the later file — two functions and four triggers — never reached production. What the tables have is the EARLIER file's set.");
    else if (late.length === 4 && early.length === 0)
      out("- **SETTLED the other way: `20250914113723` ran and `20250913085427` did not**, so the earlier file's policy block never took effect and the later one found nothing to collide with.");
    else if (early.length === 4 && late.length === 4)
      out("- **BOTH ran.** That is only possible if something dropped the six policies between them; look for it before assuming either file is safe to re-run.");
    else
      out("- **Neither pattern is clean.** Record the exact set above in §16 rather than inferring; a partial set means a third migration has been at these objects.");
  });

  const fns = await tryQ(`
    select p.proname as function_name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('cleanup_simulation_cache','set_simulation_tables_defaults','update_simulation_job_timing')
    order by 1`);
  report("and the functions", fns, (rows) => out(...table(rows)));

  // D44/D45 · the remediation's own audit row, read back out of production.
  // The `db push` log drops RAISE NOTICE (§16 · WP 2.1 follow-up), so the
  // counts the migration printed are invisible — but it wrote them into the
  // audit row on purpose, which is what an audit row is for. This is also the
  // first `plane='data'` row production has ever been asked to show.
  const remediation = await tryQ(`
    select created_at, action, target_type,
           before ->> 'rows_carrying_zero'  as rows_carrying_zero,
           before ->> 'distinct_targets'    as distinct_targets,
           after  ->> 'keys_removed'        as keys_removed,
           after  ->> 'rows_deleted_empty'  as rows_deleted_empty,
           after  ->> 'rows_still_zero'     as rows_still_zero,
           after  ->> 'actor_known'         as actor_known
    from public.audit_logs
    where plane = 'data' and action = 'remediate'
      and after ->> 'defect' = 'D1 via D44'
    order by created_at desc limit 5`);
  report("D44's remediation, as the audit log recorded it", remediation, (rows) => {
    out("");
    out("**D44 · what the unseed actually did**, read back from the audit row rather than from a NOTICE the `db push` log discards:");
    out(...table(rows));
    const r = rows[0];
    if (r) out(`- \`rows_deleted_empty = ${r.rows_deleted_empty}\` is the number that judges the SHAPE of the fix: every row it did NOT delete is a row a row-level \`DELETE\` would have taken, along with whatever else its patch held.`);
  });

  const planeRows = await tryQ(`
    select plane, count(*)::int as rows, min(created_at)::text as first_row
    from public.audit_logs group by 1 order by 1`);
  report("audit_logs by plane", planeRows, (rows) => {
    out("");
    out("**D45 · the data plane, in production** — 18 rows and all of them `admin` was the measurement that opened D45:");
    out(...table(rows));
  });

  const dupes = await tryQ(`
    select schemaname, tablename, policyname, count(*)::int as copies
    from pg_policies group by 1,2,3 having count(*) > 1 order by 4 desc`);
  report("duplicate policy names anywhere in the database", dupes, (rows) => {
    out(rows.length
      ? `- **${rows.length}** policy name(s) exist more than once on the same table — Postgres does not permit this, so read the query, not the database.`
      : "- No policy name is duplicated. WP 2.1's drop-and-recreate left one of each, which is the END STATE D30 says was already deterministic.");
    if (rows.length) out(...table(rows));
  });
}

// ── WP 3.1: the ingestion tables, after the rename ─────────────────────────
//
// The schema probe above already fails the run if `ingest_runs` and friends are
// missing from production, which is the rename's structural proof. This is the
// other half: a rename moves ROWS, and nothing in the repository can see whether
// any arrived. It also answers a question WP 3.1 could not: how much connector
// traffic production has ever had, which is what makes the "MRP behaviour must
// not change" exit check worth what it costs.
async function ingestTables() {
  section("WP 3.1 — the ingestion tables, after the rename");

  const counts = await tryQ(`
    select (select count(*) from public.ingest_runs)::int              as runs,
           (select count(*) from public.ingest_runs
             where source_kind = 'orbit-mrp')::int                     as runs_connector,
           (select count(*) from public.ingest_runs
             where link_id is null)::int                               as runs_without_link,
           (select count(*) from public.ingest_runs
             where project_id is null)::int                            as runs_without_project,
           (select count(*) from public.ingest_staged_products)::int    as staged_products,
           (select count(*) from public.ingest_staged_bom_versions)::int as staged_bom_versions,
           (select count(*) from public.ingest_staged_bom_lines)::int   as staged_bom_lines,
           (select count(*) from public.ingest_files)::int              as landed_files,
           (select count(*) from public.project_erp_links)::int         as links`);
  report("row counts under the new names", counts, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    if (Number(r.runs_without_project) > 0) {
      out(`- **${r.runs_without_project} run(s) carry no \`project_id\`**, which the NOT NULL should have made impossible. Read the migration before anything else.`);
    }
    if (Number(r.runs) === 0) {
      out("- The connector has never run in production. The rename therefore moved an EMPTY table, and `supabase/rehearsal/050` — which runs against rows — is the only evidence that the path still works. That is the right way round, and it is why the assertion exists.");
    }
  });

  // WP 3.2 — the CSV path's own tables. Production had never run an ingestion of
  // any kind when this was written (§16 · WP 3.1), so the first non-zero here is
  // the first row `ingest_files` or `ingest_staged_rows` has ever held, and it is
  // the only corroboration the landing will ever get that is not a rehearsal.
  section("WP 3.2 — the CSV landing, and whether it has ever run");
  const csv = await tryQ(`
    select (select count(*) from public.ingest_runs
             where source_kind = 'csv')::int                            as csv_runs,
           (select count(*) from public.ingest_runs
             where source_kind = 'csv' and status = 'applied')::int     as csv_runs_applied,
           (select count(*) from public.ingest_staged_rows)::int         as staged_rows,
           (select count(*) from public.ingest_staged_rows
             where findings @> '[{"level": "error"}]'::jsonb)::int       as staged_rows_rejected,
           (select count(*) from public.ingest_files
             where source_kind = 'csv')::int                            as csv_files,
           (select count(*) from public.audit_logs
             where action = 'ingest_file_landed')::int                   as landing_audit_rows`);
  report("the CSV path", csv, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    if (Number(r.csv_runs) === 0) {
      out("- **No CSV has been uploaded through `ingest-file` yet.** Every claim WP 3.2 makes rests on `supabase/rehearsal/070`. Do not read an empty staging table as evidence that anything works (§16 · WP 3.1).");
    } else if (Number(r.landing_audit_rows) !== Number(r.csv_files)) {
      out(`- **${r.csv_files} landed CSV file(s) but ${r.landing_audit_rows} landing audit row(s)** — they are written in the same transaction, so a difference means something writes \`ingest_files\` outside \`ingest_land_file\`. That is invariant \`audit-actor\` failing, not a counting quirk.`);
    }
    if (Number(r.staged_rows_rejected) > 0) {
      out(`- ${r.staged_rows_rejected} staged row(s) carry an \`error\` finding and were never promoted. That is the feature, not a fault — each one is a row the old parser would have written to tier 2 as a null.`);
    }
  });

  // ── WP 3.4 ────────────────────────────────────────────────────────────────
  //
  // THREE THINGS §15 HAS BEEN ASSERTING WITHOUT MEASURING. §16 · WP 3.3 · L
  // says "`ingest_run_id` is NULL on all 1 691 surviving arcs" — true, and it
  // was read off the absence of runs rather than off the columns. The same for
  // `diff_state`: the claim that every staged row says `new` was a reading of
  // the DDL, and the staging table was empty, so neither number had ever come
  // back from the database that holds it.
  section("WP 3.4 — provenance on tier 2, and what `diff_state` actually holds");

  const prov = await tryQ(`
    select t.tbl,
           t.total,
           t.with_run,
           t.with_row
      from (
        select 'inbound_logistics'::text as tbl, count(*)::int as total,
               count(ingest_run_id)::int as with_run, count(source_row_id)::int as with_row
          from public.inbound_logistics
        union all select 'outbound_logistics', count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.outbound_logistics
        union all select 'bom_single_level',   count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.bom_single_level
        union all select 'bom_multi_level',    count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.bom_multi_level
        union all select 'materials',          count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.materials
        union all select 'products',           count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.products
        union all select 'suppliers',          count(*)::int, count(ingest_run_id)::int, count(source_row_id)::int from public.suppliers
      ) t
     order by t.tbl`);
  report("tier-2 rows that can name the line they came from (A4)", prov, (rows) => {
    out(...table(rows));
    const traced = rows.reduce((a, r) => a + Number(r.with_row || 0), 0);
    const total = rows.reduce((a, r) => a + Number(r.total || 0), 0);
    out(
      `- **${traced} of ${total} canonical rows trace to a source line.** A NULL means the ` +
        "provenance is UNKNOWN, never that there was none: both columns are `ON DELETE SET " +
        "NULL`, and every row predating the CSV landing path carries neither because the " +
        "files were never stored. Nothing can backfill it.",
    );
  });

  const diffs = await tryQ(`
    select coalesce(diff_state, '(not computed)') as diff_state, count(*)::int as rows
      from public.ingest_staged_rows group by 1 order by 2 desc`);
  report("`diff_state`, as the rows actually hold it (D62)", diffs, (rows) => {
    if (!rows.length) {
      out("- No staged row exists, so the column holds nothing. The claim that WP 3.3 left every row saying `new` is about the DDL, not about data — there is none.");
      return;
    }
    out(...table(rows));
  });

  const runCounts = await tryQ(`
    select r.id, r.source_kind, r.status,
           (select count(*)::int from public.ingest_staged_rows s where s.ingest_run_id = r.id) as staged,
           r.rows_new, r.rows_changed, r.rows_unchanged, r.rows_superseded, r.rows_held, r.rows_removed
      from public.ingest_runs r
     where exists (select 1 from public.ingest_staged_rows s where s.ingest_run_id = r.id)
     order by r.created_at desc
     limit 25`);
  report("do a run's five counts add up to the rows it staged?", runCounts, (rows) => {
    if (!rows.length) {
      out("- No run stages `ingest_staged_rows`. The partition the review screen renders has never been exercised on real data.");
      return;
    }
    out(...table(rows));
    const bad = rows.filter(
      (r) =>
        Number(r.rows_new) + Number(r.rows_changed) + Number(r.rows_unchanged) +
          Number(r.rows_superseded) + Number(r.rows_held) !== Number(r.staged),
    );
    out(
      bad.length
        ? `- **${bad.length} run(s) whose counts do not account for every staged row.** The review screen says so where it renders them, and this is the same check against production.`
        : "- Every run's five counts partition its staged rows exactly.",
    );
  });

  // D61 — the number this package CHANGES in production, so it needs a before.
  const members = await tryQ(`
    select (select count(*)::int from public.projects)                              as projects,
           (select count(*)::int from public.projects p
             where not exists (select 1 from public.project_members m where m.project_id = p.id))
                                                                                    as projects_with_no_member,
           (select count(*)::int from public.projects p
             where p.modeler_id is not null
               and exists (select 1 from public.approved_users au where au.id = p.modeler_id)
               and not exists (select 1 from public.project_members m
                                where m.project_id = p.id and m.user_id = p.modeler_id))
                                                                                    as modeler_not_a_member,
           (select count(*)::int from public.project_members)                       as memberships`);
  report("D61 — can a project's own creator promote into it?", members, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out(
      Number(r.modeler_not_a_member) > 0
        ? `- **${r.modeler_not_a_member} project(s) whose modeler holds no membership row**, so \`effective_project_role\` returns NULL for them and the WP 3.4 promotion gate refuses them. WP 2.2's backfill ran once and left no writer; WP 3.4's trigger is the writer.`
        : "- Every project's modeler is a member of it. The role gate resolves for the person who created the project, which is the precondition WP 3.4's exit check stands on.",
    );
  });
}

// ── WP 4.1: the graph_hash blast radius, measured before the bump ──────────
// `schema_version` is not a local change. `current_graph_hash` wraps
// `_build_dataset_snapshot`, is granted to `anon`, and the readers below do
// more than display: `expire_agent_proposals` WRITES `status='expired'` with
// `status_reason='grounding_drift'` on the next read after the deploy, and
// nothing un-expires a proposal when the hash comes back. So the bump's cost
// is a number, and this is where the number comes from. Run BEFORE the
// migration and again after.
async function graphHashBlastRadius() {
  section("WP 4.1 — what the `schema_version` bump costs, counted before it happens");

  const versions = await tryQ(`
    select (select count(*)::int from public.dataset_versions)                        as dataset_versions,
           (select count(distinct project_id)::int from public.dataset_versions)      as projects_with_a_version,
           (select count(distinct graph_hash)::int from public.dataset_versions)      as distinct_graph_hashes,
           (select count(*)::int from public.projects)                                as projects`);
  report("`dataset_versions` — what exists to be re-hashed", versions, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out(
      `- Every one of these ${r.dataset_versions ?? "?"} rows is IMMUTABLE and keeps its stored ` +
        "`snapshot` and `graph_hash`. The bump does not rewrite them; it means the NEXT " +
        "`snapshot_dataset` call inserts a new version instead of deduping against the latest, " +
        "which is the intended behaviour and not the cost. The cost is below.",
    );
  });

  const runs = await tryQ(`
    select (select count(*)::int from public.simulation_runs)                                as runs,
           (select count(*)::int from public.simulation_runs where dataset_version_id is not null) as runs_bound_to_a_version,
           (select count(*)::int from public.simulation_runs where graph_hash is not null)   as runs_with_a_graph_hash,
           (select count(*)::int from public.simulation_runs r
              where r.dataset_version_id is not null
                and not exists (select 1 from public.dataset_versions v where v.id = r.dataset_version_id))
                                                                                            as runs_whose_version_is_gone`);
  report("§11 exit check — do existing runs still resolve their `dataset_version_id`?", runs, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out(
      Number(r.runs_whose_version_is_gone) > 0
        ? `- **${r.runs_whose_version_is_gone} run(s) point at a \`dataset_versions\` row that is gone.** The column is ` +
          "`ON DELETE SET NULL`, so this can only be a row written outside the FK — investigate before the bump."
        : "- Every bound run resolves its version. The bump cannot change this: `dataset_versions` rows are " +
          "never updated and never deleted by any path this package touches, and the FK is `ON DELETE SET NULL`.",
    );
  });

  // The reader that WRITES. This is the blast radius proper.
  const props = await tryQ(`
    select (select count(*)::int from public.proposals)                                   as proposals,
           (select count(*)::int from public.proposals
             where status in ('draft','proposed','approved'))                             as live,
           (select count(*)::int from public.proposals
             where status in ('draft','proposed','approved') and grounding ? 'graph_hash') as live_grounded_on_graph_hash,
           (select count(*)::int from public.proposals
             where status in ('draft','proposed','approved') and grounding ? 'graph_hash'
               and grounding->>'graph_hash' = public.current_graph_hash(project_id))       as live_and_fresh_today,
           (select count(*)::int from public.proposals where status = 'expired')           as already_expired`);
  report(
    "**the reader that writes** — `expire_agent_proposals` flips `status` to `expired`/`grounding_drift`",
    props,
    (rows) => {
      out(...table(rows));
      const r = rows[0] ?? {};
      const n = Number(r.live_grounded_on_graph_hash ?? 0);
      out(
        n > 0
          ? `- **${n} live proposal(s) carry a v1 \`graph_hash\` in \`grounding\`.** A v1 hash cannot equal a v2 ` +
            "hash, so on the first `list_agent_proposals` call after the deploy every one of them is UPDATEd to " +
            "`status='expired'`, `status_reason='grounding_drift'` — including any in `approved`. **Nothing " +
            "un-expires a proposal**: the predicate is one-way and `supersede_agent_proposal` does not reverse it. " +
            "This is the number the §11 decision has to be made against."
          : "- No live proposal is grounded on a `graph_hash`, so the bump expires nothing. The write path exists " +
            "and is unexercised; the decision costs nothing today and would cost `live_grounded_on_graph_hash` " +
            "proposals on any day it is not zero.",
      );
    },
  );

  const cards = await tryQ(`
    select (select count(*)::int from public.model_validations)                        as validation_cards,
           (select count(*)::int from public.model_validations where status = 'active') as active_cards,
           (select count(*)::int from public.model_validations c
             where c.status = 'active'
               and c.graph_hash = public.current_graph_hash(c.project_id))             as active_and_data_fresh_today`);
  report("`model_validations` — cards that stop reading fresh", cards, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out(
      `- ${r.active_and_data_fresh_today ?? "?"} active card(s) match their project's hash today and will report ` +
        '`drift: ["data"]` from the deploy onward. **This one is display-only and reversible** — the badge is ' +
        "derived at read time (`useModelValidation`), no column is written, and re-validating clears it.",
    );
  });

  const mem = await tryQ(`
    select (select count(*)::int from public.project_memory)                       as memories,
           (select count(*)::int from public.project_memory where grounding ? 'graph_hash') as grounded_on_graph_hash`);
  report("`project_memory` — grounding shown as stale", mem, (rows) => {
    out(...table(rows));
    out("- Display-only and reversible, same as the cards: `useProjectMemory` compares at read time.");
  });

  section("WP 4.1 — the tables the hash starts covering, and the three that hold nothing");

  const covered = await tryQ(`
    select t.tbl, t.rows, t.projects
      from (
        select 'bom_multi_level'::text as tbl, count(*)::int as rows, count(distinct project_id)::int as projects from public.bom_multi_level
        union all select 'customers',              count(*)::int, count(distinct project_id)::int from public.customers
        union all select 'tier2_suppliers',        count(*)::int, count(distinct project_id)::int from public.tier2_suppliers
        union all select 'tier3_suppliers',        count(*)::int, count(distinct project_id)::int from public.tier3_suppliers
        union all select 'multi_tier_supply_chain',count(*)::int, count(distinct project_id)::int from public.multi_tier_supply_chain
      ) t order by t.tbl`);
  report("the five tier-2 tables v1 did not hash", covered, (rows) => {
    out(...table(rows));
    const net = (rows ?? []).filter((r) =>
      ["tier2_suppliers", "tier3_suppliers", "multi_tier_supply_chain"].includes(r.tbl),
    );
    const netRows = net.reduce((a, r) => a + Number(r.rows || 0), 0);
    out(
      netRows === 0
        ? "- **`hash_network`'s three tables hold ZERO rows in every project**, which is the settled decision's " +
          "second clause measured rather than asserted. The half is free to add and is UNEXERCISED until " +
          "somebody uploads one: a green test on it is not a working path."
        : `- **\`hash_network\`'s three tables hold ${netRows} row(s)** — the settled decision recorded ZERO. ` +
          "Re-read §11 before assuming the network half is unexercised.",
    );
  });

  // DID THE MIGRATION ACTUALLY LAND? Nothing above can say.
  //
  // Read the after-run against the before-run and every WP 4.1 count is
  // IDENTICAL — which is the correct result for the data and says nothing about
  // the deploy. The counts are about rows; the migration changed FUNCTIONS and
  // added two COLUMNS, and the schema probe compares RELATIONS, not columns. So
  // a failed deploy and a successful one produced the same report, and the
  // "after" would have been a measurement of nothing.
  //
  // These three are the difference, read off production rather than off a green
  // workflow badge.
  section("WP 4.1 — did the bump actually reach production?");

  const landed = await tryQ(`
    select (select count(*)::int from information_schema.columns
             where table_schema = 'public' and table_name = 'dataset_versions'
               and column_name in ('hash_inputs','hash_network'))              as domain_columns,
           -- DISTINCT proname, because pg_proc has one row PER OVERLOAD and this
           -- probe asks whether nine FUNCTIONS exist. It read count(*) and
           -- reported 10/9 the moment WP 4.3 added the three-argument
           -- analysis_mark_critical_nodes beside the two-argument one: an
           -- overload that exists on purpose, to cover the window between a
           -- migration deploy and an edge-function deploy. Three such shims are
           -- live right now, so the bug would have recurred twice more.
           (select count(distinct p.proname)::int from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('current_hash_inputs','current_hash_network',
                                 '_dataset_domain_hashes','_dataset_graph_hash',
                                 'ingest_legacy_upsert_lane','mrp_apply_staged_products',
                                 'etl_replace_supply_chain','analysis_mark_critical_nodes',
                                 'assert_writer_may_act'))                     as wp41_functions`);
  report("the two columns and the nine functions this package adds", landed, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    const ok = Number(r.domain_columns) === 2 && Number(r.wp41_functions) === 9;
    if (!ok) {
      gateFailures.push(
        `WP 4.1's migrations are NOT fully present in production: ${r.domain_columns ?? "?"}/2 ` +
        `domain columns and ${r.wp41_functions ?? "?"}/9 functions. Every count above is ` +
        `therefore a measurement of the PRE-migration database wearing an after-run's label.`,
      );
      out("- **NOT LANDED.** See the GATE section at the end of this report.");
      return;
    }
    out("- Landed: both domain columns and all nine functions are present.");
  });

  // The snapshot is at the CURRENT schema_version AND the hash moved. Two
  // separate claims: the function could be replaced and still return a
  // v1-shaped object if a later definition shadowed it, and the shape could be
  // right while the composite was not recomputed. `schema_version` is read from
  // the live snapshot, not asserted.
  //
  // THE EXPECTED VERSION IS A NAMED CONSTANT BECAUSE THIS GATE WENT STALE (D101).
  // It was written pinned to the literal "2". `20260917000009_topology_in_the_anchor.sql`
  // folded the deep-tier topology into `hash_network` and bumped 2 -> 3 — a bump
  // §15 itself had asked for and measured the blast radius of — and the gate was
  // not moved with it. Every run after that migration reported five correct
  // projects as a GATE FAILURE, which is the failure mode a gate exists to
  // prevent: production was right and the check called it red. One name, one
  // place to change at the next bump.
  const SNAPSHOT_SCHEMA_VERSION = "3"; // 20260917000009_topology_in_the_anchor.sql
  const shape = await tryQ(`
    select p.id::text as project_id,
           public._build_dataset_snapshot(p.id) -> 'schema_version'          as schema_version,
           (public._build_dataset_snapshot(p.id) ? 'inputs')                 as has_inputs,
           (public._build_dataset_snapshot(p.id) ? 'network')                as has_network,
           (public.current_hash_inputs(p.id) is not null)                    as inputs_hash,
           (public.current_hash_network(p.id) is not null)                   as network_hash
      from public.projects p order by p.created_at limit 5`);
  report("the live snapshot's own shape, on real projects", shape, (rows) => {
    if (!rows?.length) { out("- No project to build a snapshot for."); return; }
    out(...table(rows));
    const bad = rows.filter(
      (r) => String(r.schema_version) !== SNAPSHOT_SCHEMA_VERSION || r.has_inputs !== true,
    );
    if (bad.length) {
      gateFailures.push(
        `WP 4.1: ${bad.length} project(s) build a snapshot that is not ` +
        `v${SNAPSHOT_SCHEMA_VERSION}. \`_build_dataset_snapshot\` was not replaced, ` +
        `or a later definition shadows it.`,
      );
      out(`- **NOT v${SNAPSHOT_SCHEMA_VERSION}.** See the GATE section.`);
    } else {
      out(
        `- Every project builds a v${SNAPSHOT_SCHEMA_VERSION} snapshot with both domains, ` +
        `and both domain hashes compute.`,
      );
    }
  });

  // THE DIRTY READ, AND ITS PREMISE HAS AN EXPIRY DATE THAT HAS NOW PASSED.
  //
  // WP 4.1 wrote this as "every stored version predates v2, so no stored
  // `graph_hash` may still equal its project's current one". True on the day of
  // the bump and FALSE from the first version frozen after it: a v2 version on a
  // project nobody has edited since SHOULD equal the current hash — that is the
  // anchor working, not the deploy failing.
  //
  // Production now holds 7 versions, 6 of them v1 (`hash_inputs IS NULL`) and one
  // v2, and the one that matched was the v2 one. The gate was reporting correct
  // behaviour as "THE BUMP DID NOT TAKE".
  //
  // So the check is scoped to the rows the premise is actually about: a PRE-BUMP
  // version whose stored hash still equals the current one is the real defect,
  // because a v1 hash cannot equal a v2 hash unless the composite is unversioned.
  const dirty = await tryQ(`
    select count(*)::int as versions,
           count(*) filter (where v.hash_inputs is null
                              and v.graph_hash = public.current_graph_hash(v.project_id))::int
             as pre_bump_still_matching,
           count(*) filter (where v.hash_inputs is not null
                              and v.graph_hash = public.current_graph_hash(v.project_id))::int
             as post_bump_matching_expected,
           count(*) filter (where v.hash_inputs is null)::int as without_domain_hashes
      from public.dataset_versions v`);
  report("every pre-bump version now reads dirty (§16 · WP 4.1 · C)", dirty, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    if (Number(r.post_bump_matching_expected) > 0) {
      out(
        `- ${r.post_bump_matching_expected} POST-bump version(s) match their project's current`,
        `  hash, which is correct: a v2 version on a project nobody has edited since`,
        `  should match. This row used to be counted as a failure.`,
      );
    }
    if (Number(r.versions) > 0 && Number(r.pre_bump_still_matching) > 0) {
      gateFailures.push(
        `WP 4.1: ${r.pre_bump_still_matching} PRE-BUMP dataset version(s) still match ` +
        `current_graph_hash. Every one was frozen under v1 and a v1 hash cannot equal a v2 ` +
        `hash, so either the bump did not deploy or the composite is not versioned.`,
      );
      out("- **THE BUMP DID NOT TAKE.** See the GATE section.");
      return;
    }
    out(
      `- All ${r.versions ?? 0} version(s) read dirty against the live project, and ` +
        `${r.without_domain_hashes ?? 0} carry no domain hashes — correct and not backfillable: ` +
        "a v1 snapshot has no `network` domain. The next freeze on each project writes all three.",
    );
  });

  section("WP 4.1 — D36's six PostgREST writers, as the audit log holds them");

  const unattributed = await tryQ(`
    select a.target_type, a.action,
           count(*)::int as rows,
           count(*) filter (where coalesce((a.after->>'actor_known')::boolean, false))::int as actor_known,
           count(*) filter (where not coalesce((a.after->>'actor_known')::boolean, false))::int as actor_unknown
      from public.audit_logs a
     where a.plane = 'data'
     group by 1,2 order by 5 desc, 1, 2 limit 40`);
  report("data-plane audit rows that name their actor, by table (D36)", unattributed, (rows) => {
    if (!rows?.length) {
      out("- The data plane holds no audit row at all, so D36 has nothing to measure yet: the six writers have not run since WP 2.3 created the triggers.");
      return;
    }
    out(...table(rows));
    const unknown = rows.reduce((a, r) => a + Number(r.actor_unknown || 0), 0);
    out(
      `- **${unknown} data-plane row(s) record \`actor_known: false\`.** That is honest and it is not attribution ` +
        "(§2.1 `audit-actor`). This package moves the six PostgREST writes into RPCs that take the actor as a " +
        "parameter; the after-run is how we find out whether the number moved for a path anyone actually ran.",
    );
  });
}

// ── WP 4.2: the smear, as a quantity ───────────────────────────────────────
//
// TWO THINGS NOTHING HAS EVER MEASURED, and they are this package's to measure
// FIRST, before the store exists to change them.
//
//  1. The four DERIVED tables' row counts. WP 4.1's probes did not touch them
//     (§16 · WP 4.1 · I lists them as deferred and stops), so "how big is the
//     smear" has never had a number — only the adjective in D19.
//  2. How many rows carry a COMPUTED column with no input hash. No tier-3 table
//     has `computed_from_hash` yet (that is WP 4.3's), so today the answer is
//     "every one of them" — and the point of writing it down as a count is that
//     WP 4.3 needs a before-number to show it moved.
//
// EVERY project, never one (D42): the largest project here is the one
// `seed-project.yml` seeds, and reading it alone reports a clean data layer.
async function wp42Smear() {
  section("WP 4.2 — the four DERIVED tables, and D19 as a quantity");

  // `network_nodes` is the table D56 has deferred three times, and the reason
  // is visible in its own column list: the INPUT half is what a user uploaded
  // (`name`, `country`, `industry`, `revenue`, `lat`, `long`, `is_seed`), the
  // COMPUTED half is what an analysis wrote. The counts are kept apart here
  // because a single row count cannot tell those two apart, which is D19.
  const derived = await tryQ(`
    select 'node_list'       as tbl,
           count(*)::int     as rows,
           count(distinct project_id)::int as projects,
           count(*) filter (where is_critical_node is not null
                               or critical_node_score is not null
                               or prediction_timestamp is not null)::int as rows_with_computed,
           count(*) filter (where longitude is not null or latitude is not null)::int as rows_geocoded
      from public.node_list
    union all
    select 'network_nodes', count(*)::int, count(distinct project_id)::int,
           count(*) filter (where degree_centrality is not null
                               or weighted_degree_centrality is not null
                               or eigenvector_centrality is not null
                               or betweenness_centrality is not null
                               or closeness_centrality is not null
                               or prominence is not null)::int,
           count(*) filter (where lat is not null or long is not null)::int
      from public.network_nodes
    union all
    select 'network_edges', count(*)::int, count(distinct project_id)::int, 0, 0
      from public.network_edges
    union all
    select 'network_summary', count(*)::int, count(distinct project_id)::int,
           count(*) filter (where nodes_count is not null or edges_count is not null
                               or tiers_data is not null)::int, 0
      from public.network_summary`);
  report("the four tables WP 4.1 deferred, counted for the first time", derived, (rows) => {
    if (!rows?.length) { out("- No rows returned."); return; }
    out(...table(rows));
    const total = rows.reduce((a, r) => a + Number(r.rows || 0), 0);
    const computed = rows.reduce((a, r) => a + Number(r.rows_with_computed || 0), 0);
    out("");
    out(
      `- **${total} row(s) across the four tables, ${computed} of them carrying at least one COMPUTED column ` +
        `and NONE of them carrying an input hash** — no tier-3 table has \`computed_from_hash\` yet. That is D19 ` +
        "as a number rather than an adjective, and it is WP 4.3's before-figure.",
    );
    if (total === 0) {
      out(
        "- **Zero rows is itself the finding**, and it is the honest caveat stated as data: the analyses this " +
          "package caches have produced nothing in production, so every claim about a cache hit is a claim " +
          "about `supabase/rehearsal/` fixtures and must not be reported as adoption.",
      );
    }
  });

  // Per project, because a total hides which projects are affected (D42).
  const perProject = await tryQ(`
    select p.name as project,
           (select count(*)::int from public.node_list       t where t.project_id = p.id) as node_list,
           (select count(*)::int from public.network_nodes   t where t.project_id = p.id) as network_nodes,
           (select count(*)::int from public.network_edges   t where t.project_id = p.id) as network_edges,
           (select count(*)::int from public.network_summary t where t.project_id = p.id) as network_summary,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.network_metrics_updated_at is not null)      as nodes_with_metrics
      from public.projects p order by p.created_at`);
  report("the same four, per project (D42 — never just the seeded one)", perProject, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
  });

  // D54 AS A NUMBER. The rule this package adds is that a deferral must SAY
  // whether the table is audited; this is the measurement that says what the
  // coverage list has been deciding silently.
  const deferredAudit = await tryQ(`
    select c.relname::text as tbl,
           count(t.tgname) filter (where not t.tgisinternal)::int as audit_triggers
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_trigger t on t.tgrelid = c.oid
                            and not t.tgisinternal
                            and t.tgname like '%audit_tier_write%'
     where n.nspname = 'public'
       and c.relname in ('node_list','network_nodes','network_edges','network_summary',
                         'model_validations','external_evidence')
     group by 1 order by 1`);
  report("D54 — the six DEFERRED tables this package owns, and their audit triggers", deferredAudit, (rows) => {
    if (!rows?.length) { out("- None of the six exist in production."); return; }
    out(...table(rows));
    const unaudited = rows.filter((r) => Number(r.audit_triggers) === 0);
    out("");
    out(
      `- **${unaudited.length} of ${rows.length} carry no \`audit_tier_write\` trigger.** They are outside the ` +
        "contract, therefore outside `dataPlaneAudit.test.ts`'s rule, therefore their writes are unattributable " +
        "with nothing to notice. That is D54 measured rather than described.",
    );
  });
}

// ── WP 4.2: did the store actually reach production? ───────────────────────
//
// WP 4.1's after-run could not tell a landed deploy from a failed one: every
// count came back identical to the before-run, which was correct for the data
// and is also exactly what a failed deploy prints, because the counts are about
// ROWS and the migration changed FUNCTIONS and COLUMNS (§16 · WP 4.1 · K).
//
// WP 4.2's migration creates TABLES, so the schema probe would catch a total
// failure — but not a PARTIAL one, and the counts below would again be the same
// on both sides of it because nothing has called the store. These assertions are
// therefore about the SCHEMA, not the data, and they push to `gateFailures` so a
// half-landed deploy turns the run red instead of publishing a report that looks
// like the previous one.
/**
 * WP 4.3 + WP 4.4 — THE THREE COUNTS TWO PACKAGES OWED AND NEITHER COULD TAKE.
 *
 * Both carried a migration, and a push with a migration must not touch any of
 * the three doors that fire `verification-sql.yml` (§4 D31, and the fourth loss
 * that added the third door). WP 5.1 changes no schema, so it can carry them.
 *
 * MEASURE EVERY PROJECT. §4 D42: the largest project here is the one the seeder
 * creates, and reading it alone reports a clean data layer that is not clean.
 */
/**
 * WP 6.2 / 6.4 — the BEFORE numbers for two changes this branch makes, and one
 * question a sidecar could not answer.
 *
 * READ AGAINST PRODUCTION WITHOUT THIS BRANCH'S MIGRATIONS. `supabase-migrations.yml`
 * is `branches: [main]`, so the seven migrations here deploy on MERGE — which makes
 * this the BEFORE half of two readings that straddle it, rather than a measurement of
 * something already done.
 *
 * SELECT ONLY, like every probe in this file (`assertReadOnly`).
 */
/**
 * WP 7.1 STAGE 0 — the access-control surface, read from the LIVE database.
 *
 * The plan in §14 counts 27 predicate-less policies, 7 predicate-less write policies
 * and 7 write grants to `anon`. **Those numbers come from MIGRATION HISTORY**, and
 * `no-orphan-table`'s lesson (§4 D43) is that production can differ from what the
 * migrations say: a policy dropped by hand, a grant added in the dashboard, a role
 * that does not exist here. Stage 0 exists because every stage after it is sized by
 * these figures, and a plan sized from history is a plan sized from a guess.
 *
 * SELECT ONLY. `pg_policies`, `information_schema.role_table_grants` and `pg_roles`
 * are catalog reads; nothing here changes anything.
 *
 * WHAT A PREDICATE-LESS POLICY IS, precisely, because the whole stage turns on it:
 * `qual` is the USING clause and `with_check` is the WITH CHECK clause. A policy with
 * neither, or with one that is literally `true`, permits every row for every caller
 * holding the table grant. That is not "permissive RLS" in the PostgreSQL sense of
 * `AS PERMISSIVE` — it is RLS that refuses nothing.
 */
// ── D205 · /admin's users: who exists, who can see them, and which org they are in ──
// Read-only. Counts and organization names only — no person's name or email is
// printed, because this report is published to a branch.
async function d205AdminUsers() {
  section("D205 — /admin's users: the list the page reads, and the three org facts");

  out("**A · Accounts by role and state** (the population /admin/users should list):");
  report("A", await tryQ(`
    select role::text as role, is_active, count(*)::int as accounts
      from public.approved_users group by 1, 2 order by 1, 2`), (r) => out(...table(r)));

  out("", "**B · What `v_admin_user_usage` returns to a reader who carries no GUC and no",
      "session** — the browser's shape (D155). The Management API runs as the owner, so",
      "this is the view's OWN predicate answering, not a grant:");
  report("B", await tryQ(`
    select (select count(*) from public.approved_users)::int as accounts,
           (select count(*) from public.v_admin_user_usage)::int as view_rows,
           public.current_is_super_admin() as predicate_for_this_reader`), (r) => out(...table(r)));

  out("", "**C · Per organization: the three authors of \"who is in it\"** — `organization_id`",
      "(the authority, D13), the `organization_members` rows (the Organizations page's",
      "Members figure), and the `organization` text copy:");
  report("C", await tryQ(`
    select o.name as organization, o.status,
           (select count(*) from public.approved_users u where u.organization_id = o.id)::int as by_uuid,
           (select count(*) from public.organization_members m where m.org_id = o.id)::int as member_rows,
           (select count(*) from public.approved_users u where u.organization = o.name)::int as by_text
      from public.organizations o order by o.name`), (r) => out(...table(r)));

  out("", "**D · Contradictions between `organization_members` and `organization_id`:**");
  report("D", await tryQ(`
    select
      (select count(*) from public.organization_members m
         join public.approved_users u on u.id = m.user_id
        where m.org_id is distinct from u.organization_id)::int as member_rows_in_another_org,
      (select count(*) from public.organization_members m
         join public.approved_users u on u.id = m.user_id
        where m.org_id is distinct from u.organization_id and m.org_role <> 'member')::int as of_which_owner_or_admin,
      (select count(*) from public.approved_users u
        where u.organization_id is not null
          and not exists (select 1 from public.organization_members m
                           where m.user_id = u.id and m.org_id = u.organization_id))::int as accounts_missing_their_row,
      (select count(*) from public.approved_users u where u.organization_id is null)::int as accounts_without_org,
      (select count(*) from public.approved_users u
         join public.organizations o on o.id = u.organization_id
        where u.organization is distinct from o.name)::int as text_copy_disagrees`), (r) => out(...table(r)));

  out("", "**E · Org roles held, by whether the row agrees with the account's org:**");
  report("E", await tryQ(`
    select m.org_role, (m.org_id = u.organization_id) as agrees, u.role::text as app_role,
           count(*)::int as rows
      from public.organization_members m join public.approved_users u on u.id = m.user_id
     group by 1, 2, 3 order by 1, 2, 3`), (r) => out(...table(r)));

  out("", "**F · Suspended accounts that signed in AFTER they were suspended** (the login",
      "never reads `is_active`; the sign-in rows exist since D185):");
  report("F", await tryQ(`
    with susp as (
      select u.id,
             (select max(l.created_at) from public.audit_logs l
               where l.action = 'user.set_active' and l.target_id = u.id::text
                 and (l.after ->> 'is_active') = 'false') as suspended_at
        from public.approved_users u where u.is_active = false)
    select count(*)::int as suspended_accounts,
           count(*) filter (where suspended_at is null)::int as suspension_not_in_log,
           (select count(*) from public.audit_logs l join susp s on l.actor_user_id = s.id
             where l.action = 'auth.sign_in' and (s.suspended_at is null or l.created_at > s.suspended_at))::int as sign_ins_after
      from susp`), (r) => out(...table(r)));

  out("", "**G · What the Overview's zeros may be hiding:**");
  report("G", await tryQ(`
    select (select count(*) from public.ai_usage_logs)::int as usage_rows,
           (select count(*) from public.ai_usage_logs where created_at >= date_trunc('month', now()))::int as usage_rows_mtd,
           (select count(*) from public.organizations)::int as organizations,
           (select count(*) from public.projects)::int as projects,
           (select count(*) from public.approved_users where role = 'super_admin' and is_active)::int as active_super_admins`), (r) => out(...table(r)));
}

// WP 9.4 slice 4 · §4 D227 — the validated baseline, before and after `scenarios.role`
// deploys. Reads the role through `to_jsonb(s)` so the probe runs on a database that
// does not have the column yet (the BEFORE read) and on one that does (the AFTER read,
// taken in the push after the merge — D153). Every project, never one (D42).
async function wp94ScenarioRole() {
  section("WP 9.4 — the validated baseline: by name, and by role (D227)");
  out("**A · Per project: scenarios named like the baseline, and baselines by role.** More",
      "than one named row is the rename/duplicate shape the name lookup produced; after the",
      "deploy every project with a validation run should read exactly one by role:");
  report("A", await tryQ(`
    select p.name as project,
           count(*) filter (where s.name = 'Policy validation (auto)')::int as named_baseline,
           count(*) filter (where to_jsonb(s) ->> 'role' = 'validation_baseline')::int as by_role,
           count(*) filter (where to_jsonb(s) ? 'role')::int as rows_with_column,
           count(*)::int as scenarios
      from public.projects p join public.scenarios s on s.project_id = p.id
     group by p.name order by p.name`), (r) => out(...table(r)));
  out("", "**B · Active model cards whose evidence run belongs to a scenario that is NOT the",
      "project's baseline by role** — should be 0 after the deploy:");
  report("B", await tryQ(`
    select count(*)::int as cards_off_baseline
      from public.model_validations mv
      join public.simulation_runs r on r.id = mv.evidence_run_id
      join public.scenarios s on s.id = r.scenario_id
     where mv.status = 'active'
       and coalesce(to_jsonb(s) ->> 'role', '') <> 'validation_baseline'`), (r) => out(...table(r)));
}

async function wp71Stage0() {
  section("§15 · WP 7.1 stage 0 — the access surface, from the live database");

  // 1 · Every policy, classified. `roles` is a name[] so it is unnested for the
  // report: "which ROLE can do this without a predicate" is the question, and a
  // policy granted to `{public}` answers it differently from one granted to `{anon}`.
  const policies = await tryQ(`
    select count(*)::int as policies,
           count(distinct tablename)::int as tables,
           count(*) filter (where coalesce(qual, '') in ('', 'true')
                              and coalesce(with_check, '') in ('', 'true'))::int as no_predicate,
           count(*) filter (where cmd in ('INSERT','UPDATE','DELETE','ALL')
                              and coalesce(qual, '') in ('', 'true')
                              and coalesce(with_check, '') in ('', 'true'))::int as no_predicate_write,
           count(*) filter (where qual ilike '%get_current_user_id%'
                               or with_check ilike '%get_current_user_id%'
                               or qual ilike '%app.current_user_id%'
                               or with_check ilike '%app.current_user_id%')::int as via_guc,
           count(*) filter (where qual ilike '%auth.uid%' or with_check ilike '%auth.uid%')::int as via_auth_uid
      from pg_policies where schemaname = 'public'`);
  report("stage 0.1 — every policy in `public`, classified", policies, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out(
      `- **${r.no_predicate ?? "?"} of ${r.policies ?? "?"}** policies refuse nothing: no USING and no`,
      "  WITH CHECK, or one that is literally `true`. Those are what makes the product",
      "  work while it runs as `anon`, and stage 3 is what replaces them.",
      `- **${r.via_guc ?? "?"}** name the GUC path (\`get_current_user_id\` /`,
      `  \`app.current_user_id\`) and **${r.via_auth_uid ?? "?"}** name \`auth.uid()\`. The first`,
      "  number is the size of what stage 2's re-ordering has to keep working; the",
      "  second is how much of the schema already speaks the language stage 1 issues.",
      "- **Compare all of these with §14's counts from migration history.** A difference",
      "  is not an error in either place — it is a policy or grant that moved outside a",
      "  migration, and it is the reason this stage exists (D43's class).",
    );
  });

  // 2 · The tables whose policies refuse nothing, by name, so stage 3 has its list
  // from the database rather than from a test fixture.
  const uncond = await tryQ(`
    select tablename,
           count(*)::int as no_predicate_policies,
           string_agg(distinct cmd, ', ' order by cmd) as commands
      from pg_policies
     where schemaname = 'public'
       and coalesce(qual, '') in ('', 'true')
       and coalesce(with_check, '') in ('', 'true')
     group by tablename
     order by tablename`);
  report("stage 0.2 — the tables stage 3 has to cover, from `pg_policies`", uncond, (rows) => {
    out(...table(rows));
    out(
      `- **${rows.length} table(s).** \`governanceEnforcement.test.ts\` pins a list of 27 read`,
      "  from the migrations; this is the same question asked of production.",
      "- Stage 3 adds ONE restrictive policy per table here. A restrictive policy ANDs",
      "  with whatever is already present, so `DROP POLICY` is an exact undo — which is",
      "  why the plan prefers it to rewriting each permissive policy in place.",
    );
  });

  // 3 · The grants, per role. A policy that refuses nothing only matters to a role
  // that holds the table grant, so these two reads are halves of one answer.
  const grants = await tryQ(`
    select grantee,
           count(*) filter (where privilege_type = 'SELECT')::int as select_on,
           count(*) filter (where privilege_type in ('INSERT','UPDATE','DELETE'))::int as write_privs,
           count(distinct table_name) filter (where privilege_type in ('INSERT','UPDATE','DELETE'))::int as writable_tables
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon','authenticated','service_role','PUBLIC')
     group by grantee
     order by grantee`);
  report("stage 0.3 — table grants per role", grants, (rows) => {
    out(...table(rows));
    out(
      "- `anon` is the role this product runs as. Its `writable_tables` is what stage 4",
      "  revokes, one table per push, with a read either side.",
      "- A `PUBLIC` row here would be the widest finding on the page: a grant to PUBLIC",
      "  reaches every role including `anon`, and revoking it from `anon` alone would",
      "  change nothing at all.",
    );
  });

  // 4 · The writable tables by name, which is stage 4's worklist.
  const writable = await tryQ(`
    select table_name,
           string_agg(distinct privilege_type, ', ' order by privilege_type) as privs
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon'
       and privilege_type in ('INSERT','UPDATE','DELETE')
     group by table_name
     order by table_name`);
  report("stage 0.4 — what `anon` may write, by name (stage 4's worklist)", writable, (rows) => {
    out(...table(rows));
    out(
      `- **${rows.length} table(s).** §14 counts 7 from migration history; a difference here`,
      "  changes stage 4's size and is the kind of thing only a live read can say.",
    );
  });

  // 5 · Does the database have anybody to be? Stage 1 issues real sessions, and this
  // says whether `auth.users` is populated at all today — if it is empty, stage 1 is
  // creating identities rather than attaching to them, which is a bigger change than
  // the plan's wording implies.
  const authUsers = await tryQ(`
    select (select count(*) from auth.users)::int as auth_users,
           (select count(*) from public.approved_users)::int as approved_users,
           (select count(*) from public.approved_users a
              where exists (select 1 from auth.users u where u.id = a.id))::int as approved_with_matching_auth_row`);
  report("stage 0.5 — is there an identity to attach a session to?", authUsers, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    const a = Number(r.auth_users ?? 0);
    const m = Number(r.approved_with_matching_auth_row ?? 0);
    const ap = Number(r.approved_users ?? 0);
    out(...(m === ap && ap > 0
      ? ["- **Every `approved_users` row has an `auth.users` row with the SAME uuid.** So",
         "  stage 1 can mint a session whose `sub` is the id every predicate already uses,",
         "  and `auth.uid()` will equal `get_current_user_id()` without a mapping table."]
      : [`- **${m} of ${ap}** approved users have a matching \`auth.users\` row (\`auth.users\``,
         `  holds ${a}). Where they do not, stage 1 cannot simply mint a session for the`,
         "  existing uuid — it has to create the auth identity first, which is a larger",
         "  change than the plan's stage 1 describes and must be re-planned before stage 2."]));
  });

  // 6 · THE BLAST RADIUS OF STAGE 1 ITSELF, which nothing above asks.
  //
  // Stage 1 issues a real Supabase session. The moment it does, a request stops
  // arriving as `anon` and starts arriving as `authenticated` — and a policy whose
  // `roles` is `{anon}` STOPS APPLYING to it. RLS denies by default when no policy
  // applies, so a policy that today permits everything would, after stage 1, refuse
  // everything: the product breaks on the read path, not on the write path, and it
  // breaks for the users who logged in rather than for the ones who did not.
  //
  // The same question for grants: `authenticated` must hold the table privilege too,
  // or the role change is a permission error before RLS is ever consulted.
  const byRole = await tryQ(`
    select array_to_string(roles, ',') as granted_to,
           count(*)::int as policies,
           count(distinct tablename)::int as tables
      from pg_policies where schemaname = 'public'
     group by 1 order by 2 desc`);
  report("stage 0.6 — which ROLE each policy is granted to (stage 1's own blast radius)", byRole, (rows) => {
    out(...table(rows));
    const anonOnly = rows.filter((r) => String(r.granted_to ?? "") === "anon");
    const n = anonOnly.reduce((s, r) => s + Number(r.policies ?? 0), 0);
    out(...(n === 0
      ? ["- **No policy is granted to `anon` alone**, so switching a request from `anon` to",
         "  `authenticated` takes no policy away from it. Stage 1 is safe on this axis."]
      : [`- **${n} policy/policies are granted to \`anon\` ALONE.** After stage 1 a logged-in`,
         "  request arrives as `authenticated`, those policies stop applying to it, and RLS",
         "  denies by default — so stage 1 would break reads for exactly the users who",
         "  authenticated. Each must be widened to include `authenticated` BEFORE stage 1,",
         "  which is work the plan's stage 1 does not currently contain."]));
    out(
      "- A `public` row is the benign case: `TO public` covers every role, so the role",
      "  change is invisible to it.",
    );
  });

  // 7 · …and the grant half of the same question.
  const grantGap = await tryQ(`
    select table_name,
           string_agg(distinct privilege_type, ', ' order by privilege_type) as anon_has
      from information_schema.role_table_grants g
     where table_schema = 'public' and grantee = 'anon'
       and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
       and not exists (
         select 1 from information_schema.role_table_grants h
          where h.table_schema = g.table_schema and h.table_name = g.table_name
            and h.grantee = 'authenticated' and h.privilege_type = g.privilege_type)
     group by table_name order by table_name`);
  report("stage 0.7 — privileges `anon` holds that `authenticated` does not", grantGap, (rows) => {
    out(...table(rows));
    out(...(rows.length === 0
      ? ["- **None.** Every privilege `anon` holds, `authenticated` holds too, so the role",
         "  change stage 1 causes cannot produce a permission error before RLS is reached."]
      : [`- **${rows.length} table(s).** A request that becomes \`authenticated\` loses these`,
         "  privileges outright — a `permission denied for table` error, which RLS never",
         "  gets to soften. Grant them to `authenticated` before stage 1, not after."]));
  });

  // 8 · THE REAL EXPOSURE, which 0.2–0.4 each see only half of.
  //
  // A write grant matters only where RLS lets the statement through, and a
  // predicate-less policy matters only where the role holds the grant. Neither probe
  // above is the answer on its own, and the gap between them is large: `anon` holds
  // write privileges on 86 tables (0.4) while only 16 predicate-less WRITE policies
  // exist (0.1). **The third term is RLS itself** — a table with `relrowsecurity =
  // false` has no policies to consult, so the grant is the whole of its protection.
  // This probe is the intersection, and it is the list stages 3 and 4 actually work.
  const exposure = await tryQ(`
    with anon_write as (
      select distinct table_name
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'
         and privilege_type in ('INSERT','UPDATE','DELETE')),
    rls as (
      select c.relname, c.relrowsecurity, c.relkind
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v')),
    wp as (
      select tablename,
             count(*) filter (where coalesce(qual,'') in ('','true')
                                and coalesce(with_check,'') in ('','true'))::int as open_write_policies,
             count(*)::int as write_policies
        from pg_policies
       where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')
       group by tablename)
    select case
             when r.relkind = 'v' then 'view (grant only; RLS lives on the base table)'
             when r.relrowsecurity is not true then 'RLS OFF — the grant is the only gate'
             when coalesce(w.write_policies,0) = 0 then 'RLS on, NO write policy — denied today'
             when coalesce(w.open_write_policies,0) > 0 then 'RLS on, a write policy that refuses nothing'
             else 'RLS on, every write policy has a predicate'
           end as state,
           count(*)::int as tables,
           string_agg(a.table_name, ', ' order by a.table_name) as which
      from anon_write a
      join rls r on r.relname = a.table_name
      left join wp w on w.tablename = a.table_name
     group by 1 order by 2 desc`);
  report("stage 0.8 — grant × RLS × policy: what `anon` can ACTUALLY write", exposure, (rows) => {
    for (const r of rows) {
      out("", `**${r.state}** — ${r.tables} table(s)`, "", `  ${r.which}`);
    }
    const bad = rows.filter((r) => /RLS OFF|refuses nothing/.test(String(r.state)));
    const n = bad.reduce((s, r) => s + Number(r.tables ?? 0), 0);
    out(
      "",
      `- **${n} table(s) are genuinely writable by an anonymous caller today.** That is the`,
      "  number stages 3 and 4 are sized by — not the 86 grants (most are held behind a",
      "  policy that refuses the write) and not the 16 open write policies (some sit on",
      "  tables `anon` cannot reach anyway).",
      "- A row reading `RLS OFF` is the sharpest case in this report: there is no policy to",
      "  add a restrictive clause to, so stage 3's mechanism does not apply and the only",
      "  fix is the grant. Those tables belong at the FRONT of stage 4, not in its middle.",
      "- `denied today` is the benign large group: the grant exists and RLS refuses every",
      "  write for want of a permissive policy, which is why revoking is tidying rather",
      "  than repair.",
    );
  });

  // 9 · THE IDENTITY SPLIT, from `pg_constraint` rather than from the artifact.
  //
  // `build/schema.introspected.json` records nine columns as `REFERENCES auth.users(id)`
  // — and at least one of them is WRONG: `20260613000001_fix_snapshot_created_by.sql`
  // DROPPED `policy_versions_created_by_fkey` in June, for exactly the reason 0.5 just
  // measured. Its header is the clearest statement of this problem in the repository:
  // *"The app authenticates against public.approved_users (custom auth), so the user id
  // passed to snapshot_policy is NOT an auth.users id. The legacy FK … therefore rejects
  // every snapshot with a real user."*
  //
  // So the question is which of those keys production STILL has, and it cannot be
  // answered from the repository — the artifact is demonstrably behind on at least one.
  // It matters beyond bookkeeping: `ingest_land_file` RAISES when its actor is NULL
  // (deliberately — `audit-actor`) and writes that actor into
  // `ingest_runs.triggered_by_user_id`. If that FK still points at `auth.users`, then
  // with 0 of 14 approved users present there the two requirements are mutually
  // unsatisfiable and **every CSV landing by a real user aborts** — under WP 6.5 (a),
  // which is the package that publishes `ingest-file`.
  const authFks = await tryQ(`
    select con.conname as constraint_name,
           rel.relname as table_name,
           (select string_agg(att.attname, ', ' order by att.attnum)
              from unnest(con.conkey) k
              join pg_attribute att on att.attrelid = rel.oid and att.attnum = k) as columns
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_class fre on fre.oid = con.confrelid
      join pg_namespace fns on fns.oid = fre.relnamespace
     where con.contype = 'f' and ns.nspname = 'public'
       and fns.nspname = 'auth' and fre.relname = 'users'
     order by rel.relname, con.conname`);
  report("stage 0.9 — which foreign keys to `auth.users` production STILL has", authFks, (rows) => {
    out(...table(rows));
    out(
      `- **${rows.length} key(s)**. Expected **6** since \`20260919000012\` re-keyed`,
      "  `ingest_runs`' two actor columns to `approved_users` (D156); the artifact records",
      "  seven, and the one it is still wrong about is `policy_versions.created_by`, dropped",
      "  in June and not followed by the introspector (D157).",
      "  A difference is a defect in the artifact, not in the database (D49/D52's class):",
      "  a constraint dropped by a later `ALTER TABLE` that the introspector did not",
      "  follow, and therefore a foreign key this repository believes in and production",
      "  does not — or the reverse, which is worse.",
    );
    const t = rows.map((r) => r.table_name);
    // `ingest_runs` must NOT be here any more. Until `20260919000012` it was, and the gate
    // below is what made that visible rather than a footnote; it stays because a migration
    // that reverted the re-key would otherwise put the CSV landing path back into a state
    // where it cannot run, silently.
    if (t.includes("ingest_runs")) {
      out(
        "- **`ingest_runs` IS IN THIS LIST, AND THAT BLOCKS WP 6.5 (a).**",
        "  `ingest_land_file` raises when `_actor_user_id` is NULL and writes it into",
        "  `triggered_by_user_id`; 0 of 14 approved users exist in `auth.users` (0.5). So a",
        "  real CSV upload cannot satisfy both, and publishing `ingest-file` would make",
        "  every landing fail. Every rehearsal passes because each one INSERTs its actor",
        "  into `auth.users` first — a world production does not have.",
      );
      gateFailures.push(
        "`ingest_runs` still carries a foreign key to `auth.users` while 0 of the " +
          "approved users exist there, and `ingest_land_file` both requires a non-NULL " +
          "actor and writes it into that column, so the CSV landing path cannot run in " +
          "production (PLAN.md §4 D156). It is LATENT, not an outage: `ingest-file` is " +
          "not deployed (D123), so nothing reaches the path today. This run is red " +
          "because WP 6.5 (a) publishes that function, and publishing it over these two " +
          "keys turns every upload into a foreign-key error — drop them first, the " +
          "pattern being `20260613000001_fix_snapshot_created_by.sql`. Red until then, " +
          "deliberately.",
      );
    } else {
      out(
        "- **`ingest_runs` is NOT in this list**, so its actor columns take an",
        "  `approved_users` id without complaint and the landing path is not blocked by",
        "  this. Then the artifact is wrong about it, which is its own finding.",
      );
    }
  });

  // 10 · THE SIXTEEN, BY NAME — stage 1's first migration, written from the database.
  //
  // 0.6 counted them. Stage 1 has to RECREATE each one `TO anon, authenticated`, and
  // that needs the name, the table, the command and both expressions — because
  // PostgreSQL has no `ALTER POLICY … ADD ROLE`: widening a policy's roles means
  // `ALTER POLICY … TO anon, authenticated`, which keeps the predicates, and getting
  // the list from `grep 'TO anon'` is exactly the mistake D154 was.
  //
  // The expressions are printed so the migration can be checked against them rather
  // than trusted: `ALTER POLICY … TO` preserves USING and WITH CHECK, and this is what
  // they must still be afterwards.
  const anonOnly = await tryQ(`
    select tablename, policyname, cmd, permissive,
           coalesce(qual, '—') as using_expr,
           coalesce(with_check, '—') as with_check_expr
      from pg_policies
     where schemaname = 'public' and roles = '{anon}'
     order by tablename, policyname`);
  report("stage 0.10 — the sixteen `anon`-only policies, by name (stage 1's worklist)", anonOnly, (rows) => {
    out(...table(rows, ["tablename", "policyname", "cmd", "permissive"]));
    out("");
    out("**The predicates each one must still have afterwards:**");
    for (const r of rows) {
      out(
        "",
        `- \`${r.tablename}\` · \`${r.policyname}\` (${r.cmd})`,
        `  - USING: \`${String(r.using_expr).replace(/`/g, "'").slice(0, 300)}\``,
        `  - WITH CHECK: \`${String(r.with_check_expr).replace(/`/g, "'").slice(0, 300)}\``,
      );
    }
    out(
      "",
      `- **${rows.length} policy/policies.** Each becomes \`ALTER POLICY <name> ON <table>`,
      "  TO anon, authenticated\\` — additive, since a policy gaining a role takes none",
      "  away, and revertible by the same statement with `TO anon`.",
      "- **This must land BEFORE stage 1 issues a session.** Until it does, every one of",
      "  these reads is available to an anonymous caller and refused to an authenticated",
      "  one, which is the inversion nothing in §14 had pointed at (D155).",
    );
  });
}

async function wp62and64Before() {
  section("§15 · WP 6.2 / 6.4 — before the cascade, and the catalog nothing reads");

  // 1 · D117's orphans. `20260919000005` DELETES exactly these rows before it can
  // add each foreign key, and prints every count on deploy. This is the number to
  // compare that output against — and if it is large, it is also the answer to
  // "how long has deleting a project not deleted the project".
  const orphans = await tryQ(`
    select 'customers' as tbl, count(*)::int as orphan_rows from public.customers t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'network_summary', count(*)::int from public.network_summary t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'policy_defaults', count(*)::int from public.policy_defaults t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'policy_overrides', count(*)::int from public.policy_overrides t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'simulation_job_magnitudes', count(*)::int from public.simulation_job_magnitudes t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'tier2_suppliers', count(*)::int from public.tier2_suppliers t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
    union all select 'tier3_suppliers', count(*)::int from public.tier3_suppliers t
      where not exists (select 1 from public.projects p where p.id = t.project_id)
     order by 1`);
  report("§4 D117 — rows whose project no longer exists (the cascade's before number)", orphans, (rows) => {
    out(...table(rows));
    const total = rows.reduce((n, r) => n + Number(r.orphan_rows ?? 0), 0);
    out(
      `- **${total} row(s)** belong to a project that has been deleted. No screen can`,
      `  reach them — every read is \`WHERE project_id = <a project you can open>\` —`,
      `  and nothing has ever removed them.`,
      `- \`policy_defaults\` and \`policy_overrides\` are the sharp ones: those rows are`,
      `  the decisions a user typed into the grid.`,
      `- \`20260919000005\` deletes exactly these and then adds seven \`ON DELETE CASCADE\``,
      `  keys, so the same query must return 0 everywhere after the merge.`,
    );
  });

  // 2 · D126. A seeded catalog nothing reads is a different finding from an empty
  // table nothing reads, and only the database can say which this is.
  const presets = await tryQ(`
    select count(*)::int as rows,
           count(*) filter (where is_system)::int as system_rows,
           count(distinct slug)::int as slugs,
           count(*) filter (where owner_id is not null)::int as user_rows
      from public.policy_presets`);
  report("§4 D126 — `policy_presets`: is there a catalog nobody reads?", presets, (rows) => {
    out(...table(rows));
    const n = Number(rows[0]?.rows ?? 0);
    // Two different findings, and the report says which rather than printing a
    // number and leaving the reader to decide what it means.
    out(...(n === 0
      ? ["- The table is EMPTY. Nothing reads it and nothing ever filled it, so D126 is",
         "  a dead table rather than an unread catalog — which makes deleting it the",
         "  cheaper of the two answers."]
      : [`- **${n} row(s)** are seeded here and NO code reads them: not \`src/\`, not an`,
         "  RPC, not an edge function. The presets a user applies are compiled into the",
         "  bundle under `src/lib/policies/presets/`, so this catalog cannot be edited",
         "  into effect — changing a preset needs a deploy."]));
  });

  // 3 · The six tables WP 6.4 describes, as rows. A described table with no rows is
  // still described — but the reader of this report deserves to know which of the
  // six the product has actually been using.
  const decisions = await tryQ(`
    select 'policy_versions' as tbl, count(*)::int as rows from public.policy_versions
    union all select 'policy_presets', count(*)::int from public.policy_presets
    union all select 'scenarios', count(*)::int from public.scenarios
    union all select 'scenario_templates', count(*)::int from public.scenario_templates
    union all select 'recovery_playbooks', count(*)::int from public.recovery_playbooks
    union all select 'external_evidence', count(*)::int from public.external_evidence
     order by 1`);
  report("WP 6.4 — the decision plane, as rows", decisions, (rows) => {
    out(...table(rows));
    out(
      "- Every one of these is now described, governed and audited by three triggers.",
      "- A table with 0 rows here is not a finding on its own: `external_evidence` fills",
      "  only when an agent has run, and `policy_presets` is D126's subject.",
    );
  });
}

async function wp43and44Counts() {
  section("WP 4.3 / 4.4 — provenance coverage, and D70's realised damage");

  // 1 · I5 as a quantity. `computed_from_hash IS NULL` is the size of what
  // WP 5.3 cannot migrate: a row that cannot say which data produced it.
  const prov = await tryQ(`
    select 'network_nodes' as tbl,
           count(*)::int as rows,
           count(*) filter (where computed_from_hash is null)::int as no_provenance,
           count(distinct project_id)::int as projects
      from public.network_nodes
    union all
    select 'node_list', count(*)::int,
           count(*) filter (where computed_from_hash is null)::int,
           count(distinct project_id)::int
      from public.node_list
    union all
    select 'supply_chain_data', count(*)::int,
           count(*) filter (where computed_from_hash is null)::int,
           count(distinct project_id)::int
      from public.supply_chain_data
    union all
    select 'network_summary', count(*)::int,
           count(*) filter (where computed_from_hash is null)::int,
           count(distinct project_id)::int
      from public.network_summary
     order by 1`);
  report("`computed_from_hash IS NULL` per derived table — I5 as a number", prov, (rows) => {
    out(...table(rows));
    const total = rows.reduce((n, r) => n + Number(r.rows ?? 0), 0);
    const none = rows.reduce((n, r) => n + Number(r.no_provenance ?? 0), 0);
    out(
      `- **${none} of ${total}** derived row(s) carry NO input hash. Those are rows`,
      `  written before WP 4.3, and nothing can say whether they are current — the`,
      `  freshness badge reports them as \`unknown\`, which is not the same as stale.`,
      `- This is the size of what WP 5.3 cannot migrate: dropping the entity columns`,
      `  loses these values with no \`analysis_results\` row to replace them.`,
    );
  });

  // 2 · D70's realised damage. UNRECOVERABLE by construction — `expired`
  // overwrote the prior status and the row does not record it — so the only
  // honest thing left is to know the number.
  const drift = await tryQ(`
    select count(*)::int as expired_for_drift,
           count(distinct project_id)::int as projects,
           min(updated_at) as earliest,
           max(updated_at) as latest
      from public.proposals
     where status = 'expired' and status_reason = 'grounding_drift'`);
  report("proposals a READ expired for grounding drift (§4 D70)", drift, (rows) => {
    out(...table(rows));
    const n = Number(rows[0]?.expired_for_drift ?? 0);
    if (n === 0) {
      out("- **Zero.** D70 was closed before it cost anything, which is what WP 4.1's");
      out("  measure-before-the-bump discipline bought.");
    } else {
      out(
        `- **${n} proposal(s) were expired by somebody opening a page**, not by any`,
        `  decision. Each said \`draft\`, \`proposed\` or \`approved\` and \`expired\``,
        `  overwrote it; the row does not record which, so THEY CANNOT BE RESTORED.`,
        `  The number is the point: it is the realised cost of D70 and it can only`,
        `  ever grow smaller by somebody re-authoring those proposals by hand.`,
      );
    }
  });

  // 3 · what a `schema_version` bump would cost TODAY. WP 5.3 folds the network
  // topology into `hash_network` (D75) and WP 4.1's rule is to count first.
  const bump = await tryQ(`
    select count(*)::int as live_grounded_on_graph_hash,
           count(distinct project_id)::int as projects
      from public.proposals
     where status in ('draft','proposed','approved')
       and grounding ? 'graph_hash'`);
  report("what WP 5.3's hash bump would land on (D75) — count before, not after", bump, (rows) => {
    out(...table(rows));
    const n = Number(rows[0]?.live_grounded_on_graph_hash ?? 0);
    out(
      n === 0
        ? "- **Zero.** WP 5.3 can take the bump for the same reason WP 4.1 could."
        : `- **${n} live proposal(s)** are grounded on a graph hash. Since WP 4.4 a bump `
          + `no longer EXPIRES them — drift is computed now — so they will read as `
          + `\`stale\` and come back if the hash does. That is the whole value of D70 `
          + `being closed before this bump rather than after it.`,
    );
  });

  // 4 · D72's index, re-measured against the constraint that now exists.
  const key = await tryQ(`
    select (select count(*)::int from pg_index i join pg_class c on c.oid = i.indexrelid
             where c.relname = 'network_nodes_natural_key' and i.indisunique) as key_present,
           (select count(*)::int from public.network_nodes where uid is null)  as null_uid`);
  report("D72's `(project_id, uid)` key, after the fact", key, (rows) => {
    out(...table(rows));
    if (Number(rows[0]?.key_present ?? 0) !== 1) {
      gateFailures.push(
        "WP 4.3's `network_nodes_natural_key` is NOT in production, so " +
        "`calculate-network-science-metrics`'s fallback upsert is still failing with " +
        "42P10 on every run (§4 D72).",
      );
    }
  });
}

async function wp42Landed() {
  section("WP 4.2 — did the analysis store reach production?");

  const landed = await tryQ(`
    select (select count(*)::int from information_schema.tables
             where table_schema = 'public'
               and table_name in ('analysis_runs','analysis_results'))            as store_tables,
           (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('analysis_get_or_start','analysis_complete_run',
                                 'analysis_fail_run','analysis_results_are_immutable',
                                 'analysis_runs_identity_is_immutable'))          as store_functions,
           (select count(*)::int from pg_index i join pg_class c on c.oid = i.indexrelid
             where c.relname = 'analysis_runs_key_uniq'
               and i.indisunique and i.indpred is not null)                       as partial_unique_key,
           (select count(*)::int from pg_trigger t
             where not t.tgisinternal
               and t.tgname like 'audit_analysis_%')                              as audit_triggers`);
  report("the two tables, five functions, the partial key and the six audit triggers", landed, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    const want = { store_tables: 2, store_functions: 5, partial_unique_key: 1, audit_triggers: 6 };
    const bad = Object.entries(want).filter(([k, v]) => Number(r[k]) !== v);
    if (bad.length) {
      gateFailures.push(
        `WP 4.2's migration is NOT fully present in production: ` +
        bad.map(([k, v]) => `${k} ${r[k] ?? "?"}/${v}`).join(", ") +
        `. Every WP 4.2 count in this report is therefore a measurement of the ` +
        `PRE-migration database wearing an after-run's label (§16 · WP 4.1 · K).`,
      );
      out("- **NOT LANDED.** See the GATE section at the end of this report.");
      return;
    }
    out("- Landed: both tables, all five functions, the partial unique key and all six audit triggers.");
  });

  // THE KEY IS PARTIAL, and that is the deviation from §11 this package had to
  // make (§16 · WP 4.2 · I). A full index would let the first FAILED run own a
  // cache key forever, so the shape is asserted rather than assumed — a later
  // migration that "tidied" it into a plain unique index would be silent.
  const keydef = await tryQ(`
    select pg_get_indexdef(i.indexrelid) as definition
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'analysis_runs_key_uniq'`);
  report("the key index, as production actually holds it", keydef, (rows) => {
    if (!rows?.length) { out("- The key index does not exist."); return; }
    out(...table(rows));
    if (!/WHERE .*status/i.test(String(rows[0].definition))) {
      gateFailures.push(
        "WP 4.2: `analysis_runs_key_uniq` is not partial in production. A failed run " +
        "then owns its cache key permanently and that analysis can never be retried " +
        "on that input (§11's flat key, and why this package deviated from it).",
      );
    }
  });

  // NOT ADOPTION, AND THIS REPORT MUST NOT BE READ AS IF IT WERE. Nothing has
  // called the store outside a rehearsal; the row count is expected to be zero
  // and zero is the honest answer rather than a failure.
  const usage = await tryQ(`
    select (select count(*)::int from public.analysis_runs)                        as runs,
           (select count(*)::int from public.analysis_results)                     as results,
           (select count(distinct project_id)::int from public.analysis_runs)      as projects,
           (select count(*)::int from public.analysis_runs where actor_user_id is null) as runs_with_no_actor`);
  report("what the store holds (expected: nothing — this is NOT adoption)", usage, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    if (Number(r.runs) === 0) {
      out(
        "- Zero runs, as expected. The analyzers do not call the store until WP 4.3 " +
          "dual-writes, so every claim this package makes about a cache hit is a claim " +
          "about `supabase/rehearsal/` fixtures. **A future non-zero count here is not " +
          "adoption either until an analyzer is the caller.**",
      );
    }
    // Not a gate since `20260930000007` (WP 7.2 (a), §4 D213): deleting an account
    // anonymises the runs it asked for, so a NULL actor is what an erasure LOOKS like.
    // "A run is created naming who asked" moved from NOT NULL to the BEFORE INSERT
    // trigger `analysis_runs_actor_required`, which `rehearsal/480` §2 proves.
    if (Number(r.runs_with_no_actor) > 0) {
      out(
        `- ${r.runs_with_no_actor} run(s) have no actor: the account that asked for each ` +
          "was deleted and the run kept (WP 7.2 (a)). A run cannot be CREATED without one.",
      );
    }
  });

  // D72's BEFORE-NUMBER, which WP 4.3 needs and cannot take after it has acted.
  // `calculate-network-science-metrics` upserts `network_nodes` on
  // `(project_id, uid)` and that index does not exist, so the statement fails
  // every time it runs. Before the index can be created the duplicates have to be
  // counted — exactly the way D5's before-number was taken for the seven lanes.
  const d72 = await tryQ(`
    select count(*)::int as rows,
           count(*) filter (where uid is null)::int as null_uid,
           (select coalesce(sum(copies - 1), 0)::int from (
              select count(*)::int as copies from public.network_nodes
               group by project_id, uid having count(*) > 1) d)
             as rows_a_unique_index_would_reject,
           (select count(*)::int from (
              select 1 from public.network_nodes
               group by project_id, uid having count(*) > 1) d)
             as duplicated_keys
      from public.network_nodes`);
  report("D72 — `network_nodes (project_id, uid)` before any index is attempted", d72, (rows) => {
    out(...table(rows));
    const r = rows[0] ?? {};
    out("");
    out(
      `- **${r.rows_a_unique_index_would_reject ?? "?"} row(s) across ` +
        `${r.duplicated_keys ?? "?"} duplicated key(s)** would be rejected by the unique index ` +
        "`calculate-network-science-metrics:115` already names in its `onConflict`. " +
        "Until it exists that upsert raises `42P10` on every run, the handler logs and " +
        "carries on, and the per-node update loop then matches nothing (D72). " +
        `\`null_uid\` is ${r.null_uid ?? "?"} — a nullable key column means the index must be ` +
        "`NULLS NOT DISTINCT` or it constrains every row except those (D5).",
    );
  });
}

// ── WP 4.3: the two T3 tables nothing has counted, and the before-figures ──
//
// THREE THINGS NOTHING HAS EVER MEASURED, and every one of them is a number
// WP 4.3 cannot take after it has acted:
//
//  1. `supply_chain_data` and `supply_chain_data_multi_tier` row counts. They
//     are the two ETL outputs in the contract, they are the tier-3 tables that
//     GAIN `computed_from_hash` here, and WP 5.3 needs today's figure as its
//     own before-number. WP 4.1's probes did not touch them and WP 4.2's four
//     derived tables are a different set — so "how many derived rows carry no
//     input hash" has only ever been answered for the network group.
//
//  2. `analysis_runs` BY KIND. WP 4.2 shipped with the count at zero and said
//     so in three places. This package is the first real caller, so the
//     after-run is the first time a non-zero count means anything at all — and
//     it means ANALYZERS RAN, never adoption (§16 · WP 4.2 · N).
//
//  3. `network_nodes.uid`'s NULLABILITY, read from production rather than from
//     the migration. D72's row asserts `uid` is NULLABLE and the creating
//     migration says `uid text NOT NULL`; D43's whole class is production
//     disagreeing with the migrations, so the only way to know which is true of
//     the database the index will be created on is to ask it.
//
// EVERY project, never one (D42).
async function wp43Before() {
  section("WP 4.3 — the T3 tables that gain `computed_from_hash`, counted before the dual-write");

  const t3 = await tryQ(`
    select 'supply_chain_data'            as tbl,
           count(*)::int                  as rows,
           count(distinct project_id)::int as projects,
           0::int                         as rows_with_input_hash
      from public.supply_chain_data
    union all
    select 'supply_chain_data_multi_tier', count(*)::int, count(distinct project_id)::int, 0::int
      from public.supply_chain_data_multi_tier`);
  report("the two ETL outputs in the contract, counted for the first time", t3, (rows) => {
    if (!rows?.length) { out("- No rows returned."); return; }
    out(...table(rows));
    const total = rows.reduce((a, r) => a + Number(r.rows || 0), 0);
    out("");
    out(
      `- **${total} row(s) across the two tables, NONE carrying an input hash** — neither table has a ` +
        "`computed_from_hash` column before this package. `rows_with_input_hash` is a literal `0` and not a " +
        "count, because there is no column to count: that is the honest spelling of a before-figure for a " +
        "column that does not exist yet, and the after-run replaces the literal with a real count.",
    );
    out(
      "- These two are `combine-project`'s output. They are what `analysis_kind='combine_etl'` will key, and " +
        "they are WP 5.3's before-number as much as this package's.",
    );
  });

  const t3PerProject = await tryQ(`
    select p.name as project,
           (select count(*)::int from public.supply_chain_data t            where t.project_id = p.id) as supply_chain_data,
           (select count(*)::int from public.supply_chain_data_multi_tier t where t.project_id = p.id) as multi_tier
      from public.projects p order by p.created_at`);
  report("the same two, per project (D42 — never just the seeded one)", t3PerProject, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
  });

  // WHICH PROJECT THE GAP CHECK CAN RUN AGAINST, and which field CLASSES have
  // no real data in it. §11's gap check is a field-by-field numeric comparison
  // old-vs-new, and a comparison that silently covers nothing is this plan's
  // recurring failure mode — so the field classes are counted SEPARATELY and the
  // report says which of them is empty rather than reporting a clean comparison
  // over zero values.
  const fieldClasses = await tryQ(`
    select p.name as project,
           (select count(*)::int from public.network_nodes t where t.project_id = p.id) as nn_rows,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.degree_centrality is not null)             as degree,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.weighted_degree_centrality is not null)    as weighted_degree,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.eigenvector_centrality is not null)        as eigenvector,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.betweenness_centrality is not null)        as betweenness,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.closeness_centrality is not null)          as closeness,
           (select count(*)::int from public.network_nodes t
             where t.project_id = p.id and t.prominence is not null)                    as prominence,
           (select count(*)::int from public.node_list t
             where t.project_id = p.id and t.is_critical_node is not null)              as is_critical_node,
           (select count(*)::int from public.node_list t
             where t.project_id = p.id and t.critical_node_score is not null)           as critical_node_score
      from public.projects p order by p.created_at`);
  report("**the gap check's own coverage** — which project has real values, per FIELD CLASS", fieldClasses, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const cols = ["degree", "weighted_degree", "eigenvector", "betweenness", "closeness",
                  "prominence", "is_critical_node", "critical_node_score"];
    const totals = Object.fromEntries(cols.map((c) => [c, rows.reduce((a, r) => a + Number(r[c] || 0), 0)]));
    const empty = cols.filter((c) => totals[c] === 0);
    out("");
    out(`- Per-class totals across every project: ${cols.map((c) => `\`${c}\` ${totals[c]}`).join(", ")}.`);
    out(
      empty.length
        ? `- **${empty.length} field class(es) have NO real value in ANY project**: ${empty.map((c) => `\`${c}\``).join(", ")}. ` +
          "§11's gap check cannot compare them against `analysis_results` on real data, and the gap check must SAY " +
          "so rather than reporting a comparison that covered nothing."
        : "- Every field class has at least one real value somewhere, so the gap check can cover all of them.",
    );
  });

  // `analysis_runs` BY KIND. Zero before; a non-zero after means the analyzers
  // ran, which is not the same sentence as adoption.
  const kinds = await tryQ(`
    select coalesce(r.analysis_kind, '(none)') as analysis_kind,
           count(*)::int                        as runs,
           count(*) filter (where r.status = 'succeeded')::int as succeeded,
           count(*) filter (where r.status = 'running')::int   as still_running,
           count(*) filter (where r.status = 'failed')::int    as failed,
           (select count(*)::int from public.analysis_results ar where ar.run_id in
              (select id from public.analysis_runs r2 where r2.analysis_kind = r.analysis_kind)) as result_rows
      from public.analysis_runs r group by r.analysis_kind order by 1`);
  report("`analysis_runs` by kind — WP 4.2 shipped this at ZERO", kinds, (rows) => {
    if (!rows?.length) {
      out(
        "- **No runs at all.** WP 4.2 said so in three places and this re-measures it: every claim about a " +
          "cache hit is still a claim about `supabase/rehearsal/` fixtures. WP 4.3 is the first real caller, so " +
          "the after-run is the first time a non-zero count here means anything — and what it will mean is " +
          "**ANALYZERS RUN**, never adoption.",
      );
      return;
    }
    out(...table(rows));
  });

  // D72, RE-MEASURED, and the nullability read from the database.
  //
  // The re-measure matters because the earlier figure is four weeks stale the
  // moment an analyzer runs. The nullability matters because D72's row and the
  // creating migration DISAGREE, and only production can settle which schema the
  // index will actually be created on (D43's class).
  const uidShape = await tryQ(`
    select a.attname::text                                  as column_name,
           a.attnotnull                                     as not_null,
           (select count(*)::int from public.network_nodes)  as rows,
           (select count(*)::int from public.network_nodes where uid is null) as null_uid,
           (select coalesce(sum(copies - 1), 0)::int from (
              select count(*)::int as copies from public.network_nodes
               group by project_id, uid having count(*) > 1) d)
                                                            as rows_a_unique_index_would_reject,
           (select count(*)::int from (
              select 1 from public.network_nodes
               group by project_id, uid having count(*) > 1) d)
                                                            as duplicated_keys
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'network_nodes'
       and a.attname in ('uid', 'project_id') and a.attnum > 0
     order by a.attname`);
  report("D72 — re-measured, with `uid`'s NULLABILITY read from production and not from the migration", uidShape, (rows) => {
    if (!rows?.length) { out("- `network_nodes` does not exist in production."); return; }
    out(...table(rows));
    const uid = rows.find((r) => r.column_name === "uid") ?? {};
    const reject = Number(uid.rows_a_unique_index_would_reject ?? 0);
    const notNull = uid.not_null === true || String(uid.not_null) === "true";
    out("");
    out(
      `- **${reject} row(s) across ${uid.duplicated_keys ?? "?"} duplicated key(s)** would be rejected by the ` +
        "unique index `calculate-network-science-metrics` already names in its `onConflict`. " +
        (reject === 0
          ? "So the fix is ONE `CREATE UNIQUE INDEX` with no dedup migration and no rows lost."
          : "**A dedup migration IS needed**, on D5's shape (most complete copy, then the later one), before the index."),
    );
    out(
      `- \`uid\` is **${notNull ? "NOT NULL" : "NULLABLE"}** in production, and \`null_uid\` is ${uid.null_uid ?? "?"}. ` +
        (notNull
          ? "**D72's row says `uid` is NULLABLE and that is wrong** — the creating migration declares " +
            "`uid text NOT NULL` and production agrees. The row's CONCLUSION still holds: the index is spelled " +
            "`NULLS NOT DISTINCT` anyway, because nullability is a schema property a later `ALTER` can change and " +
            "the spelling is a no-op while there are no NULLs (D5's half nobody writes down). What changes is that " +
            "it is defensive against a future `DROP NOT NULL` rather than corrective of a present NULL."
          : "So the `NULLS NOT DISTINCT` spelling is load-bearing today, exactly as D5 says."),
    );
  });
}

// ── D29: is organizations.name unique in practice? ─────────────────────────
async function d29() {
  section("D29 — `organizations.name` collisions (the dual read's text branch)");
  const dupes = await tryQ(`
    select lower(btrim(name)) as norm, count(*) as orgs
    from public.organizations
    group by 1 having count(*) > 1 order by 2 desc`);
  report("name collisions", dupes, (rows) => {
    out(`- **${rows.length}** normalized organization names are held by more than one organization.`);
    if (rows.length) out(...table(rows.slice(0, SAMPLE_CAP)));
    out(rows.length
      ? "- The text branch of `org_is_current_user_org` admits one tenant to another on these names. D29 is LIVE."
      : "- No collision today. D29 is latent, not live — nothing prevents the next one (`name` has no unique constraint).");
  });
  const total = await tryQ(`select count(*)::int as organizations from public.organizations`);
  report("organization count", total, (rows) => out(`- organizations: **${rows[0]?.organizations ?? "?"}**`));

  // WHAT THE TEXT BRANCH IS ACTUALLY CARRYING. §15's sweep found exactly one
  // project with `organization_id IS NULL`, and "resolve that project" is D29's
  // whole remaining cost — but a project cannot be resolved from its uuid. It
  // needs the org TEXT it carries and whether any organization answers to it.
  // Assigning a project to the wrong tenant is not a defect to be fixed later,
  // so this prints the evidence rather than letting a migration guess.
  const unresolved = await tryQ(`
    select p.id::text as project_id, p.name as project_name,
           p.organization as org_text,
           (select count(*)::int from public.organizations o
             where lower(btrim(o.name)) = lower(btrim(p.organization))) as orgs_matching_text,
           (select string_agg(o.id::text || ' = ' || o.name, ' | ')
              from public.organizations o
             where lower(btrim(o.name)) = lower(btrim(p.organization))) as candidates,
           p.modeler_id::text as modeler_id,
           (select count(*)::int from public.approved_users a where a.id = p.modeler_id) as modeler_rows
    from public.projects p
    where p.organization_id is null`);
  report("the unresolved project, in full", unresolved, (rows) => {
    out("");
    out("**D29 · the one project the text branch is load-bearing for.** Removing the branch is gated on this row:");
    out(...table(rows));
    out(rows.every((r) => Number(r.orgs_matching_text) === 1)
      ? "- Each row's org text matches EXACTLY ONE organization, so the backfill's own ambiguity rule resolves it. The branch can go once it is applied."
      : "- At least one row's org text matches zero or several organizations. A migration must not choose; say so in §16 instead.");
  });

  const orgs = await tryQ(`
    select id::text as id, name, slug, status from public.organizations order by name`);
  report("every organization", orgs, (rows) => out(...table(rows)));

  // WHO WOULD LOSE ACCESS IF THE TEXT BRANCH WENT. This is the only question
  // that decides D29, and asking it is cheaper than arguing about it.
  // `org_is_current_user_org(NULL, 'default_org')` can only be true for a
  // reader whose OWN `approved_users.organization` text is `default_org` — the
  // column default, which names no organization. If nobody's is, dropping the
  // branch revokes nothing from anybody, and WP 2.1's rule ("a package whose
  // job is to stop revoking access must not add a new way to revoke it") is
  // satisfied rather than argued around.
  const defaultOrgUsers = await tryQ(`
    select count(*)::int as users_with_default_org_text,
           count(*) FILTER (WHERE is_active)::int as active,
           (select count(*)::int from public.approved_users
             where organization is null or btrim(organization) = '') as users_with_blank_org_text
    from public.approved_users
    where lower(btrim(coalesce(organization,''))) = 'default_org'`);
  report("who the text branch still admits", defaultOrgUsers, (rows) => {
    out("");
    out("**D29 · who would lose access if the text branch were removed.** The branch can only admit a reader whose own org TEXT matches a project's:");
    out(...table(rows));
    out(Number(rows[0]?.users_with_default_org_text ?? -1) === 0
      ? "- Nobody carries the `default_org` text, so the NULL-org project is reachable by no ordinary user today. Removing the branch revokes nothing."
      : "- At least one account still carries `default_org`. Removing the branch WOULD revoke their access to the NULL-org project; resolve the account first.");
  });
}

// ── the four decisions §16's PHASE BOUNDARY parked behind §15 ──────────────
async function boundaryDecisions() {
  section("The four decisions §15 gates (§16 PHASE BOUNDARY, condition 2)");

  const orgCov = await tryQ(`
    select
      (select count(*)::int from public.projects)                                   as projects,
      (select count(*)::int from public.projects where organization_id is null)     as projects_org_null,
      (select count(*)::int from public.projects where organization is null or btrim(organization) = '') as projects_org_text_blank,
      (select count(*)::int from public.approved_users)                             as approved_users,
      (select count(*)::int from public.approved_users where organization_id is null) as users_org_null`);
  report("1 · org backfill coverage (WP 2.1)", orgCov, (rows) => {
    out("**1 · The org backfill's real coverage** — WP 2.1's unverifiable exit check.");
    out(...table(rows));
  });

  const modeler = await tryQ(`
    select count(*)::int as projects_with_modeler,
           count(*) filter (where a.id is null)::int as modeler_without_account
    from public.projects p
    left join public.approved_users a on a.id = p.modeler_id
    where p.modeler_id is not null`);
  report("2 · projects whose modeler has no account", modeler, (rows) => {
    out("");
    out("**2 · Projects whose `modeler_id` resolves to no `approved_users` row** — WP 2.2's owner backfill.");
    out(...table(rows));
  });

  const planes = await tryQ(`
    select plane, count(*)::int as rows
    from public.audit_logs group by 1 order by 2 desc`);
  report("3 · audit_logs plane distribution", planes, (rows) => {
    out("");
    out("**3 · Production's audit rows against WP 2.3's new `plane` CHECK.**");
    out(...table(rows));
    const bad = rows.filter((r) => !["admin", "data", "access"].includes(r.plane));
    out(bad.length
      ? `- **${bad.length} plane value(s) outside (admin, data, access)** — the CHECK would have rejected them.`
      : "- Every row's `plane` is inside `(admin, data, access)`. The generalization migrated cleanly.");
  });
}

// ── §15 proper, for one project ───────────────────────────────────────────
async function pickProject() {
  // The NAME matters as much as the id. `seed-project.yml` seeds "Project TRON -
  // ver2" through the app's own RPC lifecycle, and that project is the biggest
  // one in the database — so "the project with the most rows is clean" can mean
  // "the seeder writes clean rows" rather than anything about real uploads. A
  // reader cannot tell those apart from a uuid.
  if (forcedProject) {
    const [row] = await q(`select name from public.projects where id = '${forcedProject}'::uuid`);
    return { id: forcedProject, name: row?.name ?? "(unknown)", why: "passed with --project" };
  }
  const rows = await q(`
    select i.project_id as id, p.name, count(*)::int as inbound_rows
    from public.inbound_logistics i
    left join public.projects p on p.id = i.project_id
    group by 1, 2 order by 3 desc limit 1`);
  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name ?? "(no projects row)", why: `most inbound_logistics rows (${rows[0].inbound_rows})` };
}

async function section15(pid) {
  const P = `'${pid}'::uuid`;

  section("§15 · D8 — blank / untrimmed / case-variant ids");
  report("blank or untrimmed ids", await tryQ(`
    select count(*)::int as offending_rows,
           count(*) filter (where supplier_id is null or btrim(supplier_id) = '')::int as blank_supplier,
           count(*) filter (where material_id is null or btrim(material_id) = '')::int as blank_material,
           count(*) filter (where supplier_id is distinct from btrim(supplier_id))::int as untrimmed_supplier,
           count(*) filter (where material_id is distinct from btrim(material_id))::int as untrimmed_material
    from public.inbound_logistics where project_id = ${P}
      and (supplier_id is null or btrim(supplier_id) = ''
        or material_id is null or btrim(material_id) = ''
        or supplier_id is distinct from btrim(supplier_id)
        or material_id is distinct from btrim(material_id))`),
    (rows) => out(...table(rows)));

  report("case-variant material ids", await tryQ(`
    select lower(btrim(material_id)) as norm, count(distinct material_id)::int as variants,
           array_agg(distinct material_id) as spellings
    from public.inbound_logistics where project_id = ${P}
    group by 1 having count(distinct material_id) > 1 order by 2 desc`),
    (rows) => {
      out(`- **${rows.length}** normalized material ids carry more than one spelling.`);
      if (rows.length) out(...table(rows.slice(0, SAMPLE_CAP).map((r) => ({ ...r, spellings: sample(r.spellings).join(" · ") }))));
    });

  section("§15 · D6 — field-shift signature from an unquoted comma");
  report("embedded quote characters", await tryQ(`
    select count(*)::int as rows_with_quote_char
    from public.inbound_logistics where project_id = ${P}
      and (supplier_id like '%"%' or material_id like '%"%' or time_unit like '%"%')`),
    (rows) => {
      out(...table(rows));
      out(Number(rows[0]?.rows_with_quote_char) > 0
        ? "- The client-side split-on-comma parser shifted fields on at least one row. D6 is LIVE in this project's data."
        : "- No row carries the field-shift signature. D6 is unexercised here — it is a parser defect, not a data defect, and WP 3.2 still owns it.");
    });

  section("§15 · D7 — blank numerics that passed validation");
  report("null / non-positive numerics", await tryQ(`
    select count(*) filter (where volume     is null)::int as null_volume,
           count(*) filter (where lead_time  is null)::int as null_lead_time,
           count(*) filter (where unit_price is null)::int as null_price,
           count(*) filter (where unit_price <= 0)::int    as nonpositive_price,
           count(*)::int as total
    from public.inbound_logistics where project_id = ${P}`),
    (rows) => out(...table(rows)));

  section("§15 · D5 — duplicate arcs (WP 3.3's before number)");
  report("duplicate inbound arcs", await tryQ(`
    select count(*)::int as duplicated_groups,
           coalesce(sum(copies - 1), 0)::int as surplus_rows,
           coalesce(max(copies), 0)::int as worst_group
    from (
      select count(*)::int as copies
      from public.inbound_logistics where project_id = ${P}
      group by supplier_id, material_id, volume, unit_price having count(*) > 1) d`),
    (rows) => out(...table(rows)));

  // The natural key WP 3.3 will actually enforce is narrower than §15's
  // value-equality grouping above: two rows with the same key and DIFFERENT
  // volumes are a key violation that the §15 query does not see.
  report("duplicates by `natural_key_intended`", await tryQ(`
    select count(*)::int as duplicated_keys,
           coalesce(sum(copies - 1), 0)::int as rows_the_unique_index_would_reject,
           coalesce(max(copies), 0)::int as worst_key
    from (
      select count(*)::int as copies
      from public.inbound_logistics where project_id = ${P}
      group by project_id, plant_name, supplier_id, material_id having count(*) > 1) d`),
    (rows) => {
      out("");
      out("Against `inbound_logistics`'s `natural_key_intended` (`project_id + plant_name + supplier_id + material_id`) — this is the number WP 3.3's `CREATE UNIQUE INDEX` has to survive:");
      out(...table(rows));
    });

  section("§15 · D2 / D10 — mixed and unrecognized `time_unit`");
  report("materials with more than one time_unit", await tryQ(`
    select count(*)::int as materials_with_mixed_units from (
      select material_id from public.inbound_logistics where project_id = ${P}
      group by 1 having count(distinct lower(btrim(coalesce(time_unit,'<null>')))) > 1) m`),
    (rows) => {
      out(...table(rows));
      out(Number(rows[0]?.materials_with_mixed_units) > 0
        ? "- `sourcing_ratio` is meaningless for these materials — shares are summed across incommensurable periods."
        : "- No material mixes time units in this project, so `sourcing_ratio` is at least internally comparable here.");
    });

  report("unrecognized time_unit tokens", await tryQ(`
    select coalesce(time_unit, '<null>') as time_unit, count(*)::int as rows
    from public.inbound_logistics where project_id = ${P}
      and lower(btrim(coalesce(time_unit,''))) not in
        ('day','days','d','daily','week','weeks','wk','w','weekly','month','months','mo','m',
         'monthly','quarter','quarters','quarterly','year','years','yr','y','yearly',
         'annual','annually')
    group by 1 order by 2 desc`),
    (rows) => {
      out(`- **${rows.length}** distinct token(s) fall outside the recognized set and are silently read as weekly.`);
      if (rows.length) out(...table(rows.slice(0, SAMPLE_CAP)));
    });

  section("§15 · D3 — `plant_name` drift between arcs and BOM");
  report("arcs whose plant matches no BOM row", await tryQ(`
    select count(distinct i.plant_name)::int as orphan_plants,
           count(*)::int as affected_arcs
    from public.inbound_logistics i where i.project_id = ${P}
      and not exists (select 1 from public.bom_single_level b
                      where b.project_id = i.project_id and b.plant_name = i.plant_name)
      and not exists (select 1 from public.bom_multi_level m
                      where m.project_id = i.project_id and m.plant_name = i.plant_name)`),
    (rows) => out(...table(rows)));

  section("§15 · D2 / D3 headline — rows that reached the grid weighted 0");
  report("supply_chain_data weighting", await tryQ(`
    select data_source, count(*)::int as total,
           count(*) filter (where weighted = 0 or weighted is null)::int as zero_weighted
    from public.supply_chain_data where project_id = ${P} group by 1 order by 1`),
    (rows) => out(...table(rows)));

  report("sourcing shares that do not sum to 1", await tryQ(`
    select count(*)::int as materials_off_one from (
      select to_location from public.supply_chain_data
      where project_id = ${P} and data_source = 'inbound'
      group by 1 having abs(sum(sourcing_ratio) - 1.0) > 0.0001) s`),
    (rows) => out(...table(rows)));

  section("§15 · masters missing for multi-level BOM materials");
  report("unmastered BOM materials", await tryQ(`
    select count(distinct m.material_id)::int as materials_without_master
    from public.bom_multi_level m where m.project_id = ${P}
      and not exists (select 1 from public.materials mm
                      where mm.project_id = m.project_id and mm.material_id = m.material_id)`),
    (rows) => out(...table(rows)));

  section("§15 · D17 — suppliers the grid renders as capacity 0");
  report("supplier capacity", await tryQ(`
    select count(*) filter (where capacity_per_week is null)::int as shown_as_zero_but_unlimited,
           count(*)::int as total
    from public.suppliers where project_id = ${P}`),
    (rows) => out(...table(rows)));

  section("§15 · D1 — auto-seeded zero safety stock");
  report("zero safety_stock_days overrides", await tryQ(`
    select count(*)::int as zero_safety_stock_patches
    from public.policy_overrides
    where family = 'inventory' and patch ? 'safety_stock_days'
      and (patch->>'safety_stock_days')::numeric = 0`),
    (rows) => {
      out(...table(rows));
      out("- Project-scoped filtering is deliberately omitted: WP 0.1 closed the WRITE path, so the question is whether any seeded zeros survive anywhere.");
    });

  // The two names have OPPOSITE expectations and the first version of this
  // report printed one verdict for both, so a correct result read as a finding:
  // `risk_data` is EXPECTED — WP 1.4 adopted it and §15's own text says so —
  // while `product_code_map` is expected to be gone (WP 3.0 dropped it). A
  // report whose green case reads like an accusation is D42's lesson in
  // miniature, so each name is judged against its own expectation.
  section("§15 · D3 / D4 — the two adopted-or-dropped tables, each against its own expectation");
  report("orphan tables", await tryQ(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('product_code_map','risk_data')`),
    (rows) => {
      const present = new Set(rows.map((r) => r.table_name));
      out(present.has("risk_data")
        ? "- `risk_data` is present, which is CORRECT: WP 1.4 adopted it (`20260915000003_risk_data.sql`) and it is in the contract."
        : "- **`risk_data` is MISSING from production** and a migration creates it — the schema probe above should already have failed this run.");
      out(present.has("product_code_map")
        ? "- **`product_code_map` is STILL PRESENT**, and WP 3.0's migration dropped it. Read `20260916000003` before anything else."
        : "- `product_code_map` is gone, which is CORRECT: WP 3.0 dropped it (0 rows, no writer had ever existed).");
    });
}

/**
 * §15 · D175 follow-up — WHERE does each project's notion of "a material" live?
 *
 * D175 closed the Supplier stage's visibility gap by appending two row classes
 * (BOM intermediates, master-only materials) to the lane rows. What the fix
 * still cannot list is a material that exists ONLY in `bom_single_level` —
 * `useStageRows` reads the multi-level shape only (its line-80 guard), and a
 * single-level-only id that is also absent from `materials` has no source left.
 * A user report (2026-09-24, project `Test_Simulation`: "2 materials, 1 shown")
 * is either that shape, a not-yet-loaded frontend build, or an id that is a
 * PRODUCT to the model. Only production can say which, so this reads it —
 * every project, per §4 D42, with a per-id breakdown where the id count is
 * small enough to print.
 */
async function d175MaterialVisibility() {
  section("§15 · D175 follow-up — where each project's materials live, per source");
  const counts = await tryQ(`
    select p.name as project,
           (select count(distinct m.material_id) from public.materials m where m.project_id = p.id) as master,
           (select count(distinct b.material_id) from public.bom_single_level b where b.project_id = p.id) as bom_single,
           (select count(distinct b.material_id) from public.bom_multi_level b where b.project_id = p.id) as bom_multi,
           (select count(distinct l.material_id) from public.inbound_logistics l where l.project_id = p.id) as inbound,
           (select count(distinct s.to_location) from public.supply_chain_data s
             where s.project_id = p.id and s.data_source = 'inbound') as scd_inbound
      from public.projects p
     order by p.name`);
  report("(D175a) distinct material ids per source, every project", counts, (rows) => {
    out("", "**(D175a) distinct material ids per source per project** — the Supplier grid renders `scd_inbound` lanes; D175 adds `bom_multi` leaves/intermediates and `master`; nothing renders a `bom_single`-only id:");
    out(...table(rows));
  });
  const perId = await tryQ(`
    with ids as (
      select project_id, material_id as id from public.materials
      union select project_id, material_id from public.bom_single_level
      union select project_id, material_id from public.bom_multi_level
      union select project_id, material_id from public.inbound_logistics
      union select project_id, to_location from public.supply_chain_data where data_source = 'inbound'
    )
    select p.name as project, i.id as material,
           exists(select 1 from public.materials m where m.project_id = i.project_id and m.material_id = i.id) as master,
           exists(select 1 from public.bom_single_level b where b.project_id = i.project_id and b.material_id = i.id) as bom_single,
           exists(select 1 from public.bom_multi_level b where b.project_id = i.project_id and b.material_id = i.id) as bom_multi,
           exists(select 1 from public.inbound_logistics l where l.project_id = i.project_id and l.material_id = i.id) as lane,
           exists(select 1 from public.supply_chain_data s where s.project_id = i.project_id
                     and s.data_source = 'inbound' and s.to_location = i.id) as scd_inbound,
           exists(select 1 from public.products pr where pr.project_id = i.project_id and pr.product_id = i.id) as is_product
      from ids i
      join public.projects p on p.id = i.project_id
     where (select count(*) from ids x where x.project_id = i.project_id) <= 30
     order by p.name, i.id`);
  report("(D175b) per-id breakdown for projects with ≤ 30 ids", perId, (rows) => {
    out("", "**(D175b) every material id in every SMALL project (≤ 30 ids), and which source knows it** — an id with every visibility column false except `bom_single` is invisible on the Supplier stage even after D175; an id with `is_product` true belongs to the Focal-plant stage instead:");
    out(...table(rows));
  });
}

// ── AUDIT 2026-09-29 — the data mapping, end to end: ONE FACT, EVERY HOP ───────
//
// The single-source audit (PLAN.md §4.2's lineage matrix, §16 · *Audit 2026-09-29*)
// asks one question of every business fact: when two hops answer it, do they
// agree? Every probe below computes the SAME fact twice — once as the stored,
// derived row a page reads, once from the tier-2 rows by the rule the repository
// says is current — and counts the disagreement PER PROJECT, never for one (§4 D42).
// The recomputations call the database's own `rate_to_weekly`, so a disagreement
// is between the stored row and the current rule, not between two copies of a rule.
//
// Read-only: every statement is a SELECT, and the functions called are the
// IMMUTABLE unit functions and the STABLE classifiers.
async function mappingAudit() {
  section("Audit 2026-09-29 · A — which WRITER produced the graph every page reads");
  // A1 — the current writer (`20260924000001`) writes `level` = `bom_depth` on
  // every multi-tier row, NULLs included; no retired writer ever set `bom_depth`.
  // So `level IS DISTINCT FROM bom_depth` is a row the current writer did not write.
  const a1 = await tryQ(`
    select p.name as project, p.bom_level,
           (select count(*) from public.supply_chain_data s where s.project_id = p.id)::int as scd_rows,
           (select count(*) from public.supply_chain_data_multi_tier t where t.project_id = p.id)::int as mt_rows,
           (select count(*) from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.level is distinct from t.bom_depth)::int as mt_rows_not_current_writer,
           (select left(max(s.created_at)::text, 16) from public.supply_chain_data s where s.project_id = p.id) as graph_written,
           left(greatest(
              (select max(greatest(x.created_at, x.updated_at)) from public.inbound_logistics x where x.project_id = p.id),
              (select max(greatest(x.created_at, x.updated_at)) from public.outbound_logistics x where x.project_id = p.id),
              (select max(greatest(x.created_at, x.updated_at)) from public.bom_single_level x where x.project_id = p.id),
              (select max(greatest(x.created_at, x.updated_at)) from public.bom_multi_level x where x.project_id = p.id))::text,
              16) as sources_last_touched,
           (select count(*) from public.supply_chain_data s where s.project_id = p.id and s.computed_from_hash is not null)::int as scd_hashed
      from public.projects p order by p.name`);
  report("A1 — writer fingerprint per project", a1, (rows) => {
    out("", "**(A1) the stored graph, per project, and whether the CURRENT writer produced it** — `mt_rows_not_current_writer` counts multi-tier rows whose `level` differs from `bom_depth`, which `rebuild_supply_chain_lanes` (`20260924000001`) cannot produce:");
    out(...table(rows));
    const stale = rows.filter((r) => Number(r.mt_rows_not_current_writer) > 0);
    const withGraph = rows.filter((r) => Number(r.scd_rows) > 0);
    out("", `- **${stale.length} of ${withGraph.length} project(s) with a graph hold multi-tier rows the current writer did not write.**`);
  });

  section("Audit 2026-09-29 · B — lane share and primary supplier: stored row vs tier-2 recomputed");
  // B1 — `supply_chain_data.sourcing_ratio` on the inbound lane is the supplier's
  // share of its material, by the current rule `rate_to_weekly(volume, time_unit)`.
  // `share_raw` is the RETIRED rule (D150: raw volume, no unit). A stored ratio that
  // matches only `share_raw` was written by the retired writer.
  const b1 = await tryQ(`
    with inb as (
      select project_id, plant_name, btrim(supplier_id) as s, btrim(material_id) as m,
             public.rate_to_weekly(coalesce(volume, 0), time_unit) as wk,
             coalesce(volume, 0)::numeric as raw
        from public.inbound_logistics
       where coalesce(btrim(supplier_id), '') <> '' and coalesce(btrim(material_id), '') <> ''),
    ex as (select project_id, plant_name, s, m, sum(wk) as wk, sum(raw) as raw from inb group by 1,2,3,4),
    tot as (select project_id, plant_name, m, sum(wk) as twk, sum(raw) as traw from ex group by 1,2,3),
    e as (
      select ex.project_id, ex.plant_name, ex.s, ex.m,
             case when t.twk  > 0 then ex.wk  / t.twk  else 1.0 end as share_wk,
             case when t.traw > 0 then ex.raw / t.traw else 1.0 end as share_raw
        from ex join tot t using (project_id, plant_name, m)),
    st as (
      select project_id, plant_name, from_location as s, to_location as m,
             count(*)::int as copies, max(sourcing_ratio)::numeric as r
        from public.supply_chain_data where data_source = 'inbound'
       group by 1,2,3,4),
    j as (
      select coalesce(e.project_id, st.project_id) as project_id,
             e.s is not null as in_src, st.s is not null as in_graph,
             st.copies, st.r, e.share_wk, e.share_raw
        from e full join st using (project_id, plant_name, s, m))
    select p.name as project,
           count(*) filter (where in_src)::int as src_lanes,
           count(*) filter (where in_graph)::int as graph_lanes,
           count(*) filter (where in_src and not in_graph)::int as src_not_in_graph,
           count(*) filter (where in_graph and not in_src)::int as graph_not_in_src,
           count(*) filter (where copies > 1)::int as duplicated_in_graph,
           count(*) filter (where in_src and in_graph and abs(r - share_wk) > 1e-6)::int as share_disagrees,
           count(*) filter (where in_src and in_graph and abs(r - share_wk) > 1e-6
                              and abs(r - share_raw) <= 1e-6)::int as share_is_retired_rule
      from j join public.projects p on p.id = j.project_id
     group by p.name order by p.name`);
  report("B1 — inbound lane set and share", b1, (rows) => {
    out("", "**(B1) the inbound lane: the graph's rows against `inbound_logistics`, and the stored share against the share recomputed now:**");
    out(...table(rows));
  });

  // B2 — the PRIMARY supplier of a material: argmax share. Stored graph's argmax
  // (what the Supplier grid ranks by when a lane carries no daily volume) against
  // the argmax of the current rule. Ties broken by supplier id, identically.
  const b2 = await tryQ(`
    with inb as (
      select project_id, plant_name, btrim(supplier_id) as s, btrim(material_id) as m,
             sum(public.rate_to_weekly(coalesce(volume, 0), time_unit)) as wk
        from public.inbound_logistics
       where coalesce(btrim(supplier_id), '') <> '' and coalesce(btrim(material_id), '') <> ''
       group by 1,2,3,4),
    ep as (select distinct on (project_id, plant_name, m) project_id, plant_name, m, s as primary_src
             from inb order by project_id, plant_name, m, wk desc, s),
    sp as (select distinct on (project_id, plant_name, to_location) project_id, plant_name, to_location as m,
                  from_location as primary_graph
             from public.supply_chain_data where data_source = 'inbound'
            order by project_id, plant_name, to_location, sourcing_ratio desc nulls last, from_location),
    multi as (select project_id, plant_name, m from inb group by 1,2,3 having count(*) > 1)
    select p.name as project,
           count(*)::int as multi_sourced_materials,
           count(*) filter (where sp.primary_graph is null)::int as not_in_graph,
           count(*) filter (where sp.primary_graph is not null and sp.primary_graph <> ep.primary_src)::int as primary_disagrees
      from multi mu
      join ep using (project_id, plant_name, m)
      left join sp using (project_id, plant_name, m)
      join public.projects p on p.id = mu.project_id
     group by p.name order by p.name`);
  report("B2 — primary supplier", b2, (rows) => {
    out("", "**(B2) the primary supplier of every multi-sourced material — the stored graph's highest-share lane against the current rule's:**");
    out(...table(rows));
  });

  // B3 — the outbound lane, the same comparison.
  const b3 = await tryQ(`
    with o as (
      select project_id, plant_name, btrim(product_id) as pr, btrim(customer_id) as c,
             sum(public.rate_to_weekly(coalesce(volume, 0), time_unit)) as wk
        from public.outbound_logistics
       where coalesce(btrim(product_id), '') <> '' and coalesce(btrim(customer_id), '') <> ''
       group by 1,2,3,4),
    d as (select project_id, plant_name, pr, sum(wk) as dwk from o group by 1,2,3),
    e as (select o.project_id, o.plant_name, o.pr, o.c,
                 case when d.dwk > 0 then o.wk / d.dwk else 1.0 end as share, o.wk
            from o join d using (project_id, plant_name, pr)),
    st as (select project_id, plant_name, from_location as pr, to_location as c,
                  count(*)::int as copies, max(sourcing_ratio)::numeric as r, max(weighted)::numeric as w
             from public.supply_chain_data where data_source = 'outbound' group by 1,2,3,4),
    j as (select coalesce(e.project_id, st.project_id) as project_id, e.pr is not null as in_src,
                 st.pr is not null as in_graph, st.r, st.w, e.share, e.wk
            from e full join st using (project_id, plant_name, pr, c))
    select p.name as project,
           count(*) filter (where in_src)::int as src_lanes,
           count(*) filter (where in_graph)::int as graph_lanes,
           count(*) filter (where in_src and not in_graph)::int as src_not_in_graph,
           count(*) filter (where in_graph and not in_src)::int as graph_not_in_src,
           count(*) filter (where in_src and in_graph and abs(r - share) > 1e-6)::int as share_disagrees,
           count(*) filter (where in_src and in_graph and abs(w - wk) > 1e-6)::int as weekly_volume_disagrees
      from j join public.projects p on p.id = j.project_id
     group by p.name order by p.name`);
  report("B3 — outbound lane", b3, (rows) => {
    out("", "**(B3) the outbound lane: the stored `sourcing_ratio`/`weighted` against the current rule (weekly volume, share of product demand):**");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · C — labels against the rows they describe");
  // C1 — `projects.bom_level` against which BOM table holds rows.
  const c1 = await tryQ(`
    select p.name as project, p.bom_level,
           (select count(*) from public.bom_single_level b where b.project_id = p.id)::int as single_rows,
           (select count(*) from public.bom_multi_level b where b.project_id = p.id)::int as multi_rows,
           case
             when p.bom_level is null then 'label missing'
             when p.bom_level not in ('single', 'multi') then 'label not a known value'
             when p.bom_level = 'single' and exists(select 1 from public.bom_multi_level b where b.project_id = p.id)
                  and not exists(select 1 from public.bom_single_level b where b.project_id = p.id) then 'MISMATCH: says single, rows are multi'
             when p.bom_level = 'multi' and exists(select 1 from public.bom_single_level b where b.project_id = p.id)
                  and not exists(select 1 from public.bom_multi_level b where b.project_id = p.id) then 'MISMATCH: says multi, rows are single'
             when exists(select 1 from public.bom_single_level b where b.project_id = p.id)
                  and exists(select 1 from public.bom_multi_level b where b.project_id = p.id) then 'BOTH tables hold rows'
             else 'agrees (or no BOM)' end as verdict
      from public.projects p order by p.name`);
  report("C1 — bom_level vs rows", c1, (rows) => {
    out("", "**(C1) `projects.bom_level` against the BOM rows** — every reader that branches on the label (`get_project_datasets`, `datamap.py`, the Supplier stage before D178) reads the table the label names:");
    out(...table(rows));
  });

  // C2 — node_list's stored echelon / bom_depth against the classifier NOW.
  const c2 = await tryQ(`
    select p.name as project, count(*)::int as node_list_rows,
           count(*) filter (where n.echelon is distinct from public.classify_node_echelon(n.project_id, n.node_id))::int as echelon_stale,
           count(*) filter (where n.bom_depth is distinct from public.node_bom_depth(n.project_id, n.node_id))::int as bom_depth_stale,
           count(*) filter (where n.node_type is distinct from public.classify_node_type(n.project_id, n.node_id))::int as node_type_stale
      from public.node_list n join public.projects p on p.id = n.project_id
     group by p.name order by p.name`);
  report("C2 — node_list vs its classifier", c2, (rows) => {
    out("", "**(C2) `node_list`'s stored `echelon`/`bom_depth`/`node_type` against `classify_node_echelon`/`node_bom_depth`/`classify_node_type` evaluated now over the stored graph:**");
    out(...table(rows));
  });

  // C3 — graph nodes with no node_list row, and node_list rows with no graph node.
  const c3 = await tryQ(`
    with g as (
      select project_id, from_location as id from public.supply_chain_data
      union select project_id, to_location from public.supply_chain_data
      union select project_id, from_location from public.supply_chain_data_multi_tier
      union select project_id, to_location from public.supply_chain_data_multi_tier)
    select p.name as project,
           (select count(*) from g where g.project_id = p.id)::int as graph_nodes,
           (select count(*) from public.node_list n where n.project_id = p.id)::int as node_list_rows,
           (select count(*) from g where g.project_id = p.id
               and not exists (select 1 from public.node_list n where n.project_id = g.project_id and n.node_id = g.id))::int as graph_not_in_node_list,
           (select count(*) from public.node_list n where n.project_id = p.id
               and not exists (select 1 from g where g.project_id = n.project_id and g.id = n.node_id))::int as node_list_not_in_graph
      from public.projects p order by p.name`);
  report("C3 — node_list coverage", c3, (rows) => {
    out("", "**(C3) `node_list` against the node set of both edge tables:**");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · D — reads that can silently truncate: per-project rows against PostgREST's cap");
  // D1 — PostgREST answers a `.from()` read with at most `max_rows` rows and says
  // nothing about the rest. A client read without `.range()` paging is therefore
  // complete only while the project is below the cap.
  const cfg = await apiGet("/postgrest");
  const maxRows = cfg.rows?.max_rows ?? null;
  out(cfg.error ? `- PostgREST config unreadable: \`${cfg.error}\`` : `- PostgREST \`max_rows\` = **${maxRows}**`);
  const d1 = await tryQ(`
    select p.name as project,
           (select count(*) from public.supply_chain_data x where x.project_id = p.id)::int as supply_chain_data,
           (select count(*) from public.supply_chain_data_multi_tier x where x.project_id = p.id)::int as multi_tier,
           (select count(*) from public.node_list x where x.project_id = p.id)::int as node_list,
           (select count(*) from public.bom_single_level x where x.project_id = p.id)::int as bom_single_level,
           (select count(*) from public.bom_multi_level x where x.project_id = p.id)::int as bom_multi_level,
           (select count(*) from public.inbound_logistics x where x.project_id = p.id)::int as inbound_logistics,
           (select count(*) from public.materials x where x.project_id = p.id)::int as materials,
           (select count(*) from public.network_nodes x where x.project_id = p.id)::int as network_nodes,
           (select count(*) from public.network_edges x where x.project_id = p.id)::int as network_edges
      from public.projects p order by p.name`);
  report("D1 — per-project row counts", d1, (rows) => {
    out(...table(rows));
    if (maxRows != null) {
      const over = [];
      for (const r of rows) for (const [k, v] of Object.entries(r)) if (k !== "project" && Number(v) > Number(maxRows)) over.push(`${r.project}.${k} = ${v}`);
      out("", `- **${over.length} (project, table) pair(s) exceed \`max_rows\`**: ${over.join(" · ") || "none"}`);
    }
  });

  section("Audit 2026-09-29 · E — repository vs production: migrations and edge functions");
  // E1 — set equality of migration VERSIONS, not max+count (a gap and an extra
  // cancel in a count).
  let repoVersions = [];
  try {
    const { readdirSync } = await import("node:fs");
    repoVersions = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
      .filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]);
  } catch (e) { out(`- could not list supabase/migrations: ${e.message}`); }
  const led = await tryQ(`select version from supabase_migrations.schema_migrations order by version`);
  report("E1 — migration ledger vs repository", led, (rows) => {
    const prod = new Set(rows.map((r) => String(r.version)));
    const repo = new Set(repoVersions);
    const notApplied = [...repo].filter((v) => !prod.has(v)).sort();
    const notInRepo = [...prod].filter((v) => !repo.has(v)).sort();
    out(`- repository: **${repo.size}** versions · production ledger: **${prod.size}**`,
        `- in the repository, NOT applied: **${notApplied.length}** ${sample(notApplied).join(", ")}`,
        `- applied, NOT in the repository: **${notInRepo.length}** ${sample(notInRepo).join(", ")}`);
  });

  // E2 — each edge function's live build date against the last commit that touched
  // its source (or `_shared`). A live build older than its source is running code
  // the repository no longer holds.
  const fns = await apiGet("/functions");
  if (fns.error) { out(`- function list unreadable: \`${fns.error}\``); }
  else {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const lastCommit = (p) => {
      try { const d = execSync(`git log -1 --format=%cI -- ${p}`, { encoding: "utf8" }).trim(); return d ? new Date(d).toISOString() : null; }
      catch { return null; }
    };
    const shared = lastCommit("supabase/functions/_shared");
    const rows = (fns.rows ?? []).map((f) => {
      const dir = `supabase/functions/${f.slug}`;
      const inRepo = existsSync(new URL(`../../${dir}`, import.meta.url));
      const src = inRepo ? lastCommit(dir) : null;
      const live = f.updated_at ? new Date(f.updated_at).toISOString() : null;
      const verdict = !inRepo ? "LIVE, NO SOURCE" :
        !src ? "source date unknown (shallow clone?)" :
        live && live < src ? "LIVE BUILD OLDER THAN ITS SOURCE" : "current";
      return { slug: f.slug, live_build: live?.slice(0, 16) ?? "", source_commit: src?.slice(0, 16) ?? "", verdict };
    });
    out(`- \`_shared\` last changed: ${shared ?? "unknown"}`);
    out(...table(rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.slug.localeCompare(b.slug))));
  }

  // D2 — did a RUN see the whole project? The worker reads every tier-2 table as
  // one PostgREST GET with no paging (`datamap.py::rows`), so a project over
  // `max_rows` is simulated on whatever slice came back. `run_item_series` holds
  // one row per simulated material/product, which is the engine's own count.
  const d2 = await tryQ(`
    with last_run as (
      select distinct on (r.project_id) r.project_id, r.id, r.code_version, r.created_at
        from public.simulation_runs r where r.status = 'done'
       order by r.project_id, r.created_at desc)
    select p.name as project, lr.code_version, to_char(lr.created_at, 'YYYY-MM-DD') as run_date,
           (select count(*) from public.run_item_series s where s.run_id = lr.id and s.kind = 'material')::int as run_materials,
           (select count(*) from public.run_item_series s where s.run_id = lr.id and s.kind = 'product')::int as run_products,
           (select count(distinct m) from (
               select material_id as m from public.bom_single_level b where b.project_id = p.id
               union select material_id from public.bom_multi_level b where b.project_id = p.id) u)::int as bom_materials_now,
           (select count(distinct product_id) from public.bom_single_level b where b.project_id = p.id)::int as bom_single_products_now,
           (select count(*) from public.bom_single_level b where b.project_id = p.id)::int as bom_single_rows_now,
           (select count(*) from public.inbound_logistics i where i.project_id = p.id)::int as inbound_rows_now
      from last_run lr join public.projects p on p.id = lr.project_id
     order by p.name`);
  report("D2 — what the last run simulated vs the project now", d2, (rows) => {
    out("", "**(D2) each project's latest completed run: materials/products the engine simulated (`run_item_series`) against the project's BOM now** — series exist only for a 1-replication `full_debug` run (`scsim_bridge.py`), so a 0 here says nothing about coverage:");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · F — one tier-2 value, several rules: where the rows make the rules disagree");
  // F1 — a blank or zero BOM consumption rate. The contract declares 1.0
  // (`missing_default`), the engine reads `or 1.0`, the Supplier grid `rate > 0 ?
  // rate : 1`, and the lane writer `COALESCE(consumption_rate, 0)` — which drops the
  // row from the product graph. Every such row is a material the graph and the run
  // disagree about.
  const f1 = await tryQ(`
    select p.name as project, t.tbl, t.rows, t.rate_null, t.rate_zero_or_negative
      from (
        select project_id, 'bom_single_level' as tbl, count(*)::int as rows,
               count(*) filter (where consumption_rate is null)::int as rate_null,
               count(*) filter (where consumption_rate <= 0)::int as rate_zero_or_negative
          from public.bom_single_level group by project_id
        union all
        select project_id, 'bom_multi_level', count(*)::int,
               count(*) filter (where consumption_rate is null)::int,
               count(*) filter (where consumption_rate <= 0)::int
          from public.bom_multi_level group by project_id) t
      join public.projects p on p.id = t.project_id
     order by p.name, t.tbl`);
  report("F1 — BOM rate null/zero", f1, (rows) => {
    out("", "**(F1) BOM rows whose consumption rate is NULL or ≤ 0** — lane writer reads 0, engine and grid read 1.0:");
    out(...table(rows));
  });

  // F2 — lanes with NULL economics (the `assign_*` / grid-fallback signature) and
  // lead-time units the grid ignores. The grid multiplies `lead_time` by 7
  // unconditionally; the engine converts by `lead_time_unit`.
  const f2 = await tryQ(`
    select p.name as project, count(*)::int as inbound_rows,
           count(*) filter (where volume is null and lead_time is null and unit_price is null)::int as all_three_null,
           count(*) filter (where lead_time is null)::int as lead_time_null,
           count(*) filter (where unit_price is null)::int as price_null,
           count(*) filter (where lead_time_unit is null)::int as lt_unit_null,
           count(*) filter (where lower(btrim(lead_time_unit)) in ('week','weeks','wk','w','weekly'))::int as lt_unit_week,
           count(*) filter (where lead_time_unit is not null
                             and lower(btrim(lead_time_unit)) not in ('week','weeks','wk','w','weekly'))::int as lt_unit_not_week,
           string_agg(distinct lead_time_unit, ',') as lt_units,
           count(*) filter (where supplier_id <> btrim(supplier_id) or material_id <> btrim(material_id))::int as untrimmed_ids
      from public.inbound_logistics i join public.projects p on p.id = i.project_id
     group by p.name order by p.name`);
  report("F2 — inbound economics and lead-time unit", f2, (rows) => {
    out("", "**(F2) inbound lanes: NULL economics, and `lead_time_unit` values the Supplier grid ignores** (`lt_unit_not_week` rows render 7× wrong or better on the grid, correctly in the engine):");
    out(...table(rows));
  });

  // F3 — DEMAND: authored twice. `products.demand_mean` (weekly) is what the
  // engine prefers; the lane writer and the grid's placeholder use the outbound
  // volume (sum, and the grid an AVERAGE per product row). Count products where
  // both exist and differ.
  const f3 = await tryQ(`
    with o as (
      select project_id, btrim(product_id) as pr,
             sum(public.rate_to_weekly(coalesce(volume, 0), time_unit)) as wk_sum,
             avg(public.rate_to_weekly(coalesce(volume, 0), time_unit)) as wk_avg,
             count(*)::int as rows
        from public.outbound_logistics group by 1,2)
    select p.name as project,
           count(*)::int as products_with_outbound,
           count(*) filter (where pm.demand_mean is not null)::int as with_demand_mean,
           count(*) filter (where pm.demand_mean is not null and abs(pm.demand_mean - o.wk_sum) > 1e-6)::int as demand_mean_ne_outbound_sum,
           count(*) filter (where o.rows > 1)::int as products_with_several_customers,
           count(*) filter (where abs(o.wk_sum - o.wk_avg) > 1e-6)::int as grid_avg_ne_sum
      from o
      join public.projects p on p.id = o.project_id
      left join public.products pm on pm.project_id = o.project_id and pm.product_id = o.pr
     group by p.name order by p.name`);
  report("F3 — demand", f3, (rows) => {
    out("", "**(F3) weekly demand per product: `products.demand_mean` against the outbound sum (engine vs lane writer), and the outbound sum against the per-row average (the grid's placeholder basis):**");
    out(...table(rows));
  });

  // F4 — plant identity. The natural key includes `plant_name`, some writers stamp
  // `projects.plant_name` and some take the payload's.
  const f4 = await tryQ(`
    with pl as (
      select project_id, 'inbound' as t, plant_name from public.inbound_logistics
      union all select project_id, 'outbound', plant_name from public.outbound_logistics
      union all select project_id, 'bom_single', plant_name from public.bom_single_level
      union all select project_id, 'bom_multi', plant_name from public.bom_multi_level
      union all select project_id, 'node_list', plant_name from public.node_list)
    select p.name as project, p.plant_name as project_plant,
           count(distinct pl.plant_name)::int as distinct_plants_in_rows,
           count(*) filter (where pl.plant_name is distinct from p.plant_name)::int as rows_not_on_project_plant,
           string_agg(distinct pl.t, ',') filter (where pl.plant_name is distinct from p.plant_name) as in_tables
      from pl join public.projects p on p.id = pl.project_id
     group by p.name, p.plant_name order by p.name`);
  report("F4 — plant name", f4, (rows) => {
    out("", "**(F4) `plant_name` on tier-2 rows against `projects.plant_name`** — every ETL join is on plant, so a row on another plant is a separate graph:");
    out(...table(rows));
  });

  // F5 — masters the side-effect writer never creates.
  const f5 = await tryQ(`
    select p.name as project,
           (select count(distinct b.material_id) from public.bom_multi_level b where b.project_id = p.id
               and not exists (select 1 from public.materials m where m.project_id = p.id and m.material_id = b.material_id)
               and not exists (select 1 from public.products x where x.project_id = p.id and x.product_id = b.material_id))::int as bom_multi_ids_no_master,
           (select count(distinct o.customer_id) from public.outbound_logistics o where o.project_id = p.id
               and not exists (select 1 from public.customers c where c.project_id = p.id and c.customer_id = o.customer_id))::int as customers_no_master,
           (select count(distinct i.supplier_id) from public.inbound_logistics i where i.project_id = p.id
               and not exists (select 1 from public.suppliers s where s.project_id = p.id and s.supplier_id = i.supplier_id))::int as suppliers_no_master
      from public.projects p order by p.name`);
  report("F5 — masters", f5, (rows) => {
    out("", "**(F5) ids used by a lane or BOM with no master row** — `ensure_item_masters` reads inbound, `bom_single_level` and outbound, never `bom_multi_level`, and never writes `customers`:");
    out(...table(rows));
  });

  // F6 — derived analysis state that the lane rebuild erases.
  const f6 = await tryQ(`
    select p.name as project,
           (select count(*) from public.supply_chain_data s where s.project_id = p.id and s.is_critical_node)::int as scd_critical_rows,
           (select count(*) from public.supply_chain_data s where s.project_id = p.id and s.critical_node_score is not null)::int as scd_scored_rows,
           (select count(*) from public.analysis_runs r where r.project_id = p.id)::int as analysis_runs,
           (select count(*) from public.node_list n where n.project_id = p.id and n.is_critical_node)::int as node_list_critical
      from public.projects p order by p.name`);
  report("F6 — critical-node state", f6, (rows) => {
    out("", "**(F6) critical-node state on the lane rows (erased by every rebuild) against the analysis store and `node_list`:**");
    out(...table(rows));
  });

  // F7 — network_edges duplicates (plain INSERT, no natural key).
  const f7 = await tryQ(`
    select p.name as project, count(*)::int as edges,
           (count(*) - count(distinct (e.src_uid, e.dst_uid, e.relation_type)))::int as duplicate_edges
      from public.network_edges e join public.projects p on p.id = e.project_id
     group by p.name order by p.name`);
  report("F7 — network_edges duplicates", f7, (rows) => {
    out("", "**(F7) `network_edges` rows that repeat a (source, target) pair** — each inflates degree and weighted centrality:");
    out(...table(rows));
  });

  // F8 — triggers on `projects` and the lane tables, as production holds them.
  const f8 = await tryQ(`
    select c.relname as tbl, t.tgname, p.proname as fn,
           case when t.tgenabled = 'D' then 'disabled' else 'enabled' end as state
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
     where n.nspname = 'public' and not t.tgisinternal
       and c.relname in ('projects', 'supply_chain_data', 'supply_chain_data_multi_tier',
                         'inbound_logistics', 'outbound_logistics', 'bom_single_level', 'bom_multi_level')
     order by 1, 2`);
  report("F8 — triggers", f8, (rows) => {
    out("", "**(F8) every non-internal trigger on `projects` and the lane tables** — is `auto_combine_on_completion` attached to anything?");
    out(...table(rows));
  });

  // F9 — `projects.bom_level` values actually held.
  const f9 = await tryQ(`select coalesce(bom_level, '<null>') as bom_level, count(*)::int as projects from public.projects group by 1 order by 1`);
  report("F9 — bom_level values", f9, (rows) => {
    out("", "**(F9) `projects.bom_level` values** — DataManager writes `multi`, the admin editor writes and tests for `multi_level`, and there is no CHECK:");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · G — 'primary supplier' and 'demand model', each answered by three authors");
  // G1 — the primary supplier of a multi-sourced material, three ways:
  //   engine  (`context.py` primary_link): min (cost, rounded lead-time weeks, supplier)
  //           with cost = unit_price, ≤0/NULL → 1.0; lead time via lead_time_unit, NULL/0 → 2
  //   grid    (`useStageRows` matMeta):     max weekly volume, then min price, then min lead time
  //   stress  (`stressTargets.resolvePrimarySupplier`): ONE supplier per project — the largest
  //           total weekly volume across every material
  const g1 = await tryQ(`
    with inb as (
      select project_id, btrim(supplier_id) as s, btrim(material_id) as m,
             public.rate_to_weekly(coalesce(volume, 0), time_unit) as wk,
             case when coalesce(unit_price, 0) <= 0 then 1.0 else unit_price end as cost,
             least(51, greatest(1, round(case when coalesce(lead_time, 0) = 0 then 2.0
                   else public.duration_to_weeks(lead_time, lead_time_unit) end))) as ltw,
             unit_price, lead_time
        from public.inbound_logistics
       where coalesce(btrim(supplier_id), '') <> '' and coalesce(btrim(material_id), '') <> ''),
    multi as (select project_id, m from inb group by 1,2 having count(distinct s) > 1),
    eng as (select distinct on (project_id, m) project_id, m, s as engine_primary
              from inb order by project_id, m, cost, ltw, s),
    grid as (select distinct on (project_id, m) project_id, m, s as grid_primary
               from inb order by project_id, m, wk desc, unit_price asc nulls last, lead_time asc nulls last, s),
    stress as (select distinct on (project_id) project_id, s as stress_primary
                 from (select project_id, s, sum(wk) as wk from inb group by 1,2) x
                order by project_id, wk desc, s)
    select p.name as project,
           count(*)::int as multi_sourced_materials,
           count(*) filter (where e.engine_primary <> g.grid_primary)::int as engine_ne_grid,
           st.stress_primary,
           (select count(*) from eng e2 where e2.project_id = mu.project_id and e2.engine_primary = st.stress_primary)::int as materials_engine_orders_from_stress_primary,
           (select count(distinct m) from inb i2 where i2.project_id = mu.project_id and i2.s = st.stress_primary)::int as materials_stress_primary_supplies
      from multi mu
      join eng e using (project_id, m) join grid g using (project_id, m)
      join stress st using (project_id)
      join public.projects p on p.id = mu.project_id
     group by p.name, mu.project_id, st.stress_primary order by p.name`);
  report("G1 — primary supplier, three authors", g1, (rows) => {
    out("", "**(G1) multi-sourced materials whose ENGINE primary (cheapest link) differs from the GRID's suggested primary (highest volume); and the ONE supplier the `supplier:primary` stress preset disrupts, against how many materials the engine actually orders from it:**");
    out(...table(rows));
  });

  // G2 — demand model. `_resolve_demand_kind`: product `demand_distribution`, else
  // the SCENARIO's `demand_model.kind`, else triangular. The Data Map states the
  // default as "triangular, cv 0.30". App-created scenarios default to poisson.
  const g2 = await tryQ(`
    select p.name as project,
           (select count(*) from public.products x where x.project_id = p.id)::int as products,
           (select count(*) from public.products x where x.project_id = p.id and x.demand_distribution is null)::int as products_no_distribution,
           (select string_agg(distinct coalesce(s.demand_model->>'kind', '<none>'), ',') from public.scenarios s where s.project_id = p.id) as scenario_kinds,
           (select count(*) from public.simulation_runs r join public.scenarios s on s.id = r.scenario_id
             where r.project_id = p.id and r.status = 'done' and s.demand_model->>'kind' = 'poisson')::int as done_runs_on_poisson_scenario,
           (select count(*) from public.simulation_runs r where r.project_id = p.id and r.status = 'done')::int as done_runs
      from public.projects p order by p.name`);
  report("G2 — demand model", g2, (rows) => {
    out("", "**(G2) products with no `demand_distribution` (the engine takes the SCENARIO's kind for them, the Data Map says triangular) and the scenario kinds each project holds:**");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · H — what `anon` can read: the browser's direct `.from()` reads against production's policies");
  // H1 — every request the app sends goes out as `anon` (D155, D169). A table whose
  // SELECT policies name no `anon`/PUBLIC role, or whose only policy tests the
  // `app.*` GUC org context no PostgREST request sets, answers the browser with ZERO
  // rows and no error — and a page that renders "none" from that is D169's shape.
  const h1 = await tryQ(`
    select c.relname as tbl,
           coalesce(string_agg(distinct pol.polname || ' → ' ||
             case when pol.polroles = '{0}' then 'PUBLIC'
                  else (select string_agg(r.rolname, '+') from pg_roles r where r.oid = any(pol.polroles)) end, ' · '), '(none)') as select_policies,
           bool_or(pol.polroles = '{0}' or exists (select 1 from pg_roles r where r.oid = any(pol.polroles) and r.rolname = 'anon')) as anon_has_a_policy,
           has_table_privilege('anon', c.oid, 'SELECT') as anon_grant
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      left join pg_policy pol on pol.polrelid = c.oid and pol.polcmd in ('r', '*')
     where c.relname in ('ingest_runs','ingest_files','ingest_staged_rows','analysis_runs','supply_chain_data',
                         'supply_chain_data_multi_tier','node_list','network_nodes','network_edges','projects',
                         'bom_multi_level','bom_single_level','inbound_logistics','outbound_logistics','materials',
                         'products','suppliers','customers','run_item_series','experiments','recovery_playbooks',
                         'scenario_templates')
     group by c.relname, c.oid order by c.relname`);
  report("H1 — anon read surface", h1, (rows) => {
    out("", "**(H1) SELECT policies on every table the browser reads by `.from()`, as production holds them:**");
    out(...table(rows));
  });

  // I1 — the run-results workbook's `run_meta` sheet reads the LIVE scenario's seed
  // and schedule; the reproducibility sheet reads the run's stamped copy (audit WP 8).
  // Where the scenario moved after the run, one workbook carries two answers. A
  // seed of 0 also runs as 42 (`datamap.py`: `or 42`).
  const i1 = await tryQ(`
    select count(*)::int as done_runs,
           count(*) filter (where r.seed is not null)::int as runs_with_stamped_seed,
           count(*) filter (where r.seed is not null and r.seed is distinct from s.seed)::int as live_seed_differs,
           count(*) filter (where r.disruption_schedule is not null
                              and r.disruption_schedule::jsonb is distinct from coalesce(s.disruption_schedule::jsonb, '[]'::jsonb))::int as live_schedule_differs,
           count(*) filter (where coalesce(r.seed, s.seed) = 0)::int as seed_zero_runs_as_42
      from public.simulation_runs r left join public.scenarios s on s.id = r.scenario_id
     where r.status = 'done'`);
  report("I1 — run_meta vs the run's own binding", i1, (rows) => {
    out("", "**(I1) completed runs whose scenario has since changed seed or schedule** — the workbook's `run_meta` sheet then contradicts its `reproducibility` sheet:");
    out(...table(rows));
  });

  // J1 — the critical-node analyser reads `supply_chain_data` in ONE unpaged
  // PostgREST read (`predict-critical-nodes`). A project whose scored-row count
  // sits exactly on a round cap was scored on a slice.
  const j1 = await tryQ(`
    select p.name as project,
           count(*)::int as lane_rows,
           count(*) filter (where s.critical_node_score is not null)::int as scored,
           left(min(s.prediction_timestamp)::text, 16) as first_scored,
           left(max(s.prediction_timestamp)::text, 16) as last_scored,
           left(max(s.created_at)::text, 16) as lanes_written
      from public.supply_chain_data s join public.projects p on p.id = s.project_id
     group by p.name having count(*) filter (where s.critical_node_score is not null) > 0
     order by p.name`);
  report("J1 — critical-node scoring coverage", j1, (rows) => {
    out("", "**(J1) lanes the critical-node analyser scored, per project:**");
    out(...table(rows));
  });

  // F4b — the project whose rows sit on two plants: which plant, which table.
  const f4b = await tryQ(`
    with pl as (
      select project_id, 'inbound' as t, plant_name from public.inbound_logistics
      union all select project_id, 'outbound', plant_name from public.outbound_logistics
      union all select project_id, 'bom_multi', plant_name from public.bom_multi_level
      union all select project_id, 'bom_single', plant_name from public.bom_single_level
      union all select project_id, 'node_list', plant_name from public.node_list
      union all select project_id, 'supply_chain_data', plant_name from public.supply_chain_data
      union all select project_id, 'multi_tier', plant_name from public.supply_chain_data_multi_tier
      union all select project_id, 'network_nodes', plant_name from public.network_nodes)
    select p.name as project, p.plant_name as project_plant, pl.t, pl.plant_name as row_plant, count(*)::int as rows
      from pl join public.projects p on p.id = pl.project_id
     where exists (select 1 from pl x where x.project_id = p.id and x.plant_name is distinct from p.plant_name)
     group by 1,2,3,4 order by 1,3,4`);
  report("F4b — plants per table", f4b, (rows) => {
    out("", "**(F4b) for every project with a row off its own plant: each table's plant values:**");
    out(...table(rows));
  });

  // K1 — the default fulfillment mode, authored twice. The worker reads
  // `projects.supply_chain_model` (`worker.py::_fetch_project_model`); the browser
  // engine passes the POLICY's `fulfillment_strategy` (`RunValidateStage` →
  // `projectModel`). Neither is in `graph_hash`. Where they disagree, the two
  // engines simulate a product with no `fulfillment_mode` differently under one hash.
  const k1 = await tryQ(`
    select p.name as project, p.supply_chain_model as project_model,
           pd.fulfillment_strategy as policy_strategy,
           (select count(*) from public.products x where x.project_id = p.id and x.fulfillment_mode is null)::int as products_without_mode,
           (select count(*) from public.simulation_runs r where r.project_id = p.id and r.status = 'done'
               and r.aggregate_kpis->'_meta'->>'engine' = 'pyodide')::int as browser_runs,
           (select count(*) from public.simulation_runs r where r.project_id = p.id and r.status = 'done'
               and coalesce(r.aggregate_kpis->'_meta'->>'engine', '') <> 'pyodide')::int as worker_runs
      from public.projects p left join public.policy_defaults pd on pd.project_id = p.id
     order by p.name`);
  report("K1 — fulfillment default", k1, (rows) => {
    out("", "**(K1) the default fulfillment mode as the worker reads it (`projects.supply_chain_model`) and as the browser engine reads it (`policy_defaults.fulfillment_strategy`):**");
    out(...table(rows));
  });

  // K2 — firm prominence: stored, or invented client-side. `FirmLevelNetwork`
  // computes its own composite for a node with no stored `prominence`.
  const k2 = await tryQ(`
    select p.name as project, count(*)::int as network_nodes,
           count(*) filter (where n.prominence is null)::int as prominence_null
      from public.network_nodes n join public.projects p on p.id = n.project_id
     group by p.name order by p.name`);
  report("K2 — network_nodes prominence", k2, (rows) => {
    out("", "**(K2) `network_nodes.prominence` NULL — the nodes whose Firm-level size and stats come from the page's own composite:**");
    out(...table(rows));
  });

  section("Audit 2026-09-29 · L — the policy grid and the defaults cards: what is STORED, what the engine is SENT");
  // L1 — `policy_defaults` is seeded as `{}` per family (`create_default_policy_defaults`)
  // and the page shows each family through the Zod bundle, which fills every missing
  // key with the UI's default (`parseFamily`). The run's snapshot copies the stored
  // JSON raw (`_build_policy_snapshot`) and `project_map.py::_map_policies` reads a
  // missing key with ITS OWN default — `backorder_allowed` False (UI true),
  // `backorder_cost_per_day` 0 (UI 2), `allocation` '' (UI priority), `coverage_weeks`
  // absent → the 8/10/12 strip (UI 8). So a family never saved shows one policy and
  // runs another.
  const l1 = await tryQ(`
    select p.name as project,
           (select count(*) from jsonb_object_keys(coalesce(d.fulfillment, '{}'::jsonb)))::int as fulfil_keys,
           d.fulfillment->>'backorder_allowed' as backorder_allowed,
           d.fulfillment->>'backorder_cost_per_day' as bo_cost,
           d.fulfillment->>'allocation' as allocation,
           (select count(*) from jsonb_object_keys(coalesce(d.inventory, '{}'::jsonb)))::int as inv_keys,
           d.inventory->>'type' as inv_type,
           d.inventory->>'safety_stock_method' as ss_method,
           d.inventory->>'safety_stock_days' as ss_days,
           d.inventory->>'coverage_weeks' as kappa,
           d.inventory->>'holding_cost_pct' as hold_pct,
           (select count(*) from jsonb_object_keys(coalesce(d.sourcing, '{}'::jsonb)))::int as src_keys,
           d.sourcing->>'strategy' as src_strategy,
           (select count(*) from jsonb_object_keys(coalesce(d.recovery, '{}'::jsonb)))::int as rec_keys,
           d.recovery->>'response' as rec_response,
           (select count(*) from jsonb_object_keys(coalesce(d.production, '{}'::jsonb)))::int as prod_keys,
           d.fulfillment_strategy
      from public.projects p left join public.policy_defaults d on d.project_id = p.id
     order by p.name`);
  report("L1 — stored defaults", l1, (rows) => {
    out("", "**(L1) the project defaults AS STORED — an empty cell is a key the page fills with the UI default and the engine reads with its own:**");
    out(...table(rows));
  });

  // L2 — every override the grid has written, by scope, family and key: the
  // engine applies some per row and drops others (`_map_policies`).
  const l2 = await tryQ(`
    select o.scope, o.family, k.key,
           case when o.target_key like '%::%' then 'a::b' else 'single' end as key_shape,
           count(*)::int as overrides, count(distinct o.project_id)::int as projects
      from public.policy_overrides o
      cross join lateral jsonb_object_keys(coalesce(o.patch, '{}'::jsonb)) as k(key)
     group by 1,2,3,4 order by 1,2,3,4`);
  report("L2 — overrides by key", l2, (rows) => {
    out("", "**(L2) every stored override, by scope / family / key:**");
    out(...table(rows));
  });

  // L3 — what the last completed run's policy snapshot actually carried.
  const l3 = await tryQ(`
    with last_run as (
      select distinct on (r.project_id) r.project_id, r.policy_version_id, r.created_at
        from public.simulation_runs r where r.status = 'done'
       order by r.project_id, r.created_at desc)
    select p.name as project, to_char(lr.created_at, 'YYYY-MM-DD') as run_date,
           lr.policy_version_id is not null as has_version,
           v.snapshot->'defaults'->'fulfillment'->>'backorder_allowed' as snap_backorder,
           (select count(*) from jsonb_object_keys(coalesce(v.snapshot->'defaults'->'fulfillment', '{}'::jsonb)))::int as snap_fulfil_keys,
           (select count(*) from jsonb_object_keys(coalesce(v.snapshot->'defaults'->'inventory', '{}'::jsonb)))::int as snap_inv_keys,
           jsonb_array_length(coalesce(v.snapshot->'overrides', '[]'::jsonb))::int as snap_overrides
      from last_run lr join public.projects p on p.id = lr.project_id
      left join public.policy_versions v on v.id = lr.policy_version_id
     order by p.name`);
  report("L3 — last run's policy snapshot", l3, (rows) => {
    out("", "**(L3) the policy snapshot each project's last completed run was SENT:**");
    out(...table(rows));
  });
}


/**
 * §15 · BOM usability, Phase 1 — WHAT SHAPE ARE THE MULTI-LEVEL BOMS WE HAVE?
 *
 * Before the Supplier stage's BOM tree (§4 D177) is redesigned, the design has
 * to be sized against the real uploads, not the fixtures: how deep, how wide,
 * how many materials sit under several parents, which sub-assemblies carry
 * their own inbound lanes, how many rows are orphans or root rows, and whether
 * the numbers the tree shows (the derived deep lane) agree with the numbers the
 * engine actually runs (`datamap._flatten_multi_level_bom`). D178 and D179 were
 * both lost by trusting a count, so this prints SHAPES and bounded samples per
 * project, and cross-checks the two sources of "how much M does one P need".
 *
 * EVERY project holding `bom_multi_level` rows is measured (§4 D42). Read-only.
 * Vocabulary, from the upload only (no second classifier — D127):
 *   edge         a row with a non-blank `higher_level_component_id`
 *   top parent   a parent that is nobody's child — the ENGINE's roots
 *   demanded     a product with outbound volume — the DERIVATION's roots
 *   leaf         a child that is nobody's parent — the engine's purchased set
 *   intermediate a child that is also a parent — a sub-assembly
 */
const BOM_CTE = `
  b AS (
    SELECT project_id, plant_name,
           btrim(material_id) AS child,
           NULLIF(btrim(higher_level_component_id), '') AS parent,
           level, consumption_rate AS rate
      FROM public.bom_multi_level
     WHERE COALESCE(btrim(material_id), '') <> ''
  ),
  bproj AS (SELECT DISTINCT project_id FROM b),
  e   AS (SELECT DISTINCT project_id, child, parent FROM b WHERE parent IS NOT NULL AND parent <> child),
  par AS (SELECT DISTINCT project_id, parent AS id FROM e),
  chi AS (SELECT DISTINCT project_id, child AS id FROM e),
  top AS (SELECT * FROM par p WHERE NOT EXISTS (SELECT 1 FROM chi c WHERE c.project_id = p.project_id AND c.id = p.id)),
  leaf AS (SELECT * FROM chi c WHERE NOT EXISTS (SELECT 1 FROM par p WHERE p.project_id = c.project_id AND p.id = c.id)),
  mid AS (SELECT * FROM chi c WHERE EXISTS (SELECT 1 FROM par p WHERE p.project_id = c.project_id AND p.id = c.id)),
  dem AS (
    SELECT project_id, btrim(product_id) AS id,
           SUM(public.rate_to_weekly(COALESCE(volume, 0), time_unit)) AS wk
      FROM public.outbound_logistics
     WHERE COALESCE(btrim(product_id), '') <> ''
       AND project_id IN (SELECT project_id FROM bproj)
     GROUP BY 1, 2
  ),
  prod AS (
    SELECT DISTINCT project_id, btrim(product_id) AS id FROM public.products
     WHERE COALESCE(btrim(product_id), '') <> '' AND project_id IN (SELECT project_id FROM bproj)
  ),
  lane AS (
    SELECT project_id, btrim(material_id) AS id,
           COUNT(DISTINCT btrim(supplier_id))::int AS sups,
           MIN(lead_time) AS lt_min, MAX(lead_time) AS lt_max,
           COUNT(*) FILTER (WHERE lead_time IS NULL)::int AS lt_null
      FROM public.inbound_logistics
     WHERE COALESCE(btrim(material_id), '') <> '' AND COALESCE(btrim(supplier_id), '') <> ''
       AND project_id IN (SELECT project_id FROM bproj)
     GROUP BY 1, 2
  )`;

// The derivation's edge set, as rebuild_supply_chain_lanes' deep-lane CTE builds
// it (20260924000001): uploaded edges, plus a blank-parent row hung under every
// demanded product UNLESS its child is itself a product (D129 + D171).
const DERIVED_EDGES_CTE = `
  ex AS (
    SELECT project_id, parent, child FROM e
    UNION
    SELECT r.project_id, d.id, r.child
      FROM b r JOIN dem d ON d.project_id = r.project_id
     WHERE r.parent IS NULL
       AND NOT EXISTS (SELECT 1 FROM prod x WHERE x.project_id = r.project_id AND x.id = r.child)
       AND NOT EXISTS (SELECT 1 FROM dem x WHERE x.project_id = r.project_id AND x.id = r.child)
       AND d.id <> r.child
  ),
  walk AS (
    SELECT d.project_id, d.id AS root, d.id AS node, ARRAY[d.id] AS path
      FROM dem d
    UNION ALL
    SELECT w.project_id, w.root, x.child, w.path || x.child
      FROM walk w JOIN ex x ON x.project_id = w.project_id AND x.parent = w.node
     WHERE x.child <> ALL (w.path) AND array_length(w.path, 1) < 64
  )`;

async function bomShapeProbe() {
  section("§15 · BOM usability Phase 1 — the multi-level BOMs production actually holds");
  out("Every project with `bom_multi_level` rows. Vocabulary: **top parent** = a parent that is nobody's child (the engine's roots); **demanded** = a product with outbound volume (the derivation's and the tree's roots); **leaf** = a child that is nobody's parent (what the engine buys); **intermediate** = a child that is also a parent (a sub-assembly).");

  report("(B1) shape per project", await tryQ(`
    WITH ${BOM_CTE}
    SELECT p.name AS project,
      (SELECT COUNT(*) FROM b WHERE b.project_id = p.id)::int AS bom_rows,
      (SELECT COUNT(DISTINCT plant_name) FROM b WHERE b.project_id = p.id)::int AS plants,
      (SELECT COUNT(*) FROM b WHERE b.project_id = p.id AND b.parent IS NULL)::int AS blank_parent_rows,
      (SELECT COUNT(*) FROM b WHERE b.project_id = p.id AND b.parent IS NULL
          AND (EXISTS (SELECT 1 FROM prod x WHERE x.project_id = b.project_id AND x.id = b.child)
               OR EXISTS (SELECT 1 FROM dem x WHERE x.project_id = b.project_id AND x.id = b.child)))::int AS root_rows_naming_a_product,
      (SELECT COUNT(*) FROM b WHERE b.project_id = p.id AND b.parent = b.child)::int AS self_rows,
      (SELECT COUNT(*) FROM (SELECT 1 FROM b WHERE b.project_id = p.id AND parent IS NOT NULL
          GROUP BY child, parent HAVING COUNT(*) > 1) x)::int AS pairs_on_2plus_rows,
      (SELECT COUNT(*) FROM e WHERE e.project_id = p.id)::int AS edges,
      (SELECT COUNT(*) FROM (SELECT child FROM b WHERE b.project_id = p.id UNION SELECT parent FROM b WHERE b.project_id = p.id AND parent IS NOT NULL) n)::int AS nodes,
      (SELECT COUNT(*) FROM top WHERE top.project_id = p.id)::int AS top_parents,
      (SELECT COUNT(*) FROM top t WHERE t.project_id = p.id AND EXISTS (SELECT 1 FROM dem d WHERE d.project_id = t.project_id AND d.id = t.id))::int AS top_demanded,
      (SELECT COUNT(*) FROM dem d WHERE d.project_id = p.id)::int AS demanded,
      (SELECT COUNT(*) FROM dem d WHERE d.project_id = p.id AND NOT EXISTS (SELECT 1 FROM par x WHERE x.project_id = d.project_id AND x.id = d.id))::int AS demanded_not_a_bom_parent,
      (SELECT COUNT(*) FROM dem d WHERE d.project_id = p.id AND EXISTS (SELECT 1 FROM chi x WHERE x.project_id = d.project_id AND x.id = d.id))::int AS demanded_and_consumed,
      (SELECT COUNT(*) FROM mid WHERE mid.project_id = p.id)::int AS intermediates,
      (SELECT COUNT(*) FROM mid m WHERE m.project_id = p.id AND EXISTS (SELECT 1 FROM prod x WHERE x.project_id = m.project_id AND x.id = m.id))::int AS intermediates_in_product_master,
      (SELECT COUNT(*) FROM leaf WHERE leaf.project_id = p.id)::int AS leaves,
      (SELECT MAX(updated_at) FROM public.bom_multi_level x WHERE x.project_id = p.id)::text AS bom_updated
    FROM public.projects p WHERE p.id IN (SELECT project_id FROM bproj) ORDER BY p.name`), (rows) => {
    out("", "**(B1) shape per project** — `pairs_on_2plus_rows`: the same child→parent pair on several rows (different `level`), which BOTH the engine and the derivation count once per row:");
    out(...table(rows));
  });

  report("(B2) levels", await tryQ(`
    WITH ${BOM_CTE}
    SELECT p.name AS project, b.level,
           COUNT(*)::int AS rows,
           COUNT(DISTINCT b.child)::int AS children,
           COUNT(DISTINCT b.parent)::int AS parents,
           COUNT(*) FILTER (WHERE b.parent IS NULL)::int AS blank_parent,
           COUNT(*) FILTER (WHERE b.rate IS NULL)::int AS rate_null,
           COUNT(*) FILTER (WHERE b.rate = 0)::int AS rate_zero,
           COUNT(*) FILTER (WHERE b.rate <> 1)::int AS rate_not_1,
           MIN(b.rate)::text AS rate_min, MAX(b.rate)::text AS rate_max
      FROM b JOIN public.projects p ON p.id = b.project_id
     GROUP BY p.name, b.level ORDER BY p.name, b.level`), (rows) => {
    out("", "**(B2) rows per uploaded `level`** — a NULL or zero rate is read as 1.0 by the engine (`_num(rate) or 1.0`) and as 0 by the derivation (`COALESCE(rate, 0)`):");
    out(...table(rows));
  });

  report("(B3) level consistency", await tryQ(`
    WITH ${BOM_CTE},
    plevel AS (SELECT project_id, child AS id, MIN(level) AS lmin, MAX(level) AS lmax FROM b GROUP BY 1, 2)
    SELECT p.name AS project,
      COUNT(*) FILTER (WHERE b.parent IS NOT NULL AND pl.id IS NULL)::int AS edge_rows_parent_has_no_row,
      COUNT(*) FILTER (WHERE pl.id IS NOT NULL AND b.level IS DISTINCT FROM pl.lmax + 1 AND b.level IS DISTINCT FROM pl.lmin + 1)::int AS edge_rows_level_not_parent_plus_1,
      (SELECT COUNT(*) FROM plevel x WHERE x.project_id = p.id AND x.lmin <> x.lmax)::int AS children_on_2plus_levels,
      (SELECT MIN(level) FROM b y WHERE y.project_id = p.id AND y.parent IN (SELECT id FROM top t WHERE t.project_id = p.id))::int AS min_level_under_top,
      (SELECT MAX(level) FROM b y WHERE y.project_id = p.id AND y.parent IN (SELECT id FROM top t WHERE t.project_id = p.id))::int AS max_level_under_top
    FROM b JOIN public.projects p ON p.id = b.project_id
    LEFT JOIN plevel pl ON pl.project_id = b.project_id AND pl.id = b.parent
    GROUP BY p.id, p.name ORDER BY p.name`), (rows) => {
    out("", "**(B3) does the uploaded `level` agree with the edges?** — a tree can indent by path depth or by `level`; this says whether the two ever differ:");
    out(...table(rows));
  });

  report("(B4) fan-out", await tryQ(`
    WITH ${BOM_CTE},
    fo AS (SELECT e.project_id, e.parent, COUNT(*)::int AS n,
                  EXISTS (SELECT 1 FROM top t WHERE t.project_id = e.project_id AND t.id = e.parent) AS is_top
             FROM e GROUP BY 1, 2)
    SELECT p.name AS project, CASE WHEN fo.is_top THEN 'top parent' ELSE 'intermediate' END AS parent_kind,
           COUNT(*)::int AS parents, MIN(n) AS min_children,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS median,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY n) AS p90, MAX(n) AS max_children
      FROM fo JOIN public.projects p ON p.id = fo.project_id
     GROUP BY p.name, fo.is_top ORDER BY p.name, parent_kind DESC`), (rows) => {
    out("", "**(B4) fan-out — distinct children per parent:**");
    out(...table(rows));
  });

  report("(B5) where-used", await tryQ(`
    WITH ${BOM_CTE},
    pc AS (SELECT e.project_id, e.child, COUNT(*)::int AS n,
                  EXISTS (SELECT 1 FROM par x WHERE x.project_id = e.project_id AND x.id = e.child) AS is_mid
             FROM e GROUP BY 1, 2)
    SELECT p.name AS project, CASE WHEN pc.is_mid THEN 'intermediate' ELSE 'leaf' END AS child_kind,
           COUNT(*)::int AS children,
           COUNT(*) FILTER (WHERE n = 1)::int AS one_parent,
           COUNT(*) FILTER (WHERE n = 2)::int AS two,
           COUNT(*) FILTER (WHERE n BETWEEN 3 AND 5)::int AS three_to_five,
           COUNT(*) FILTER (WHERE n > 5)::int AS six_plus,
           MAX(n) AS max_parents
      FROM pc JOIN public.projects p ON p.id = pc.project_id
     GROUP BY p.name, pc.is_mid ORDER BY p.name, child_kind`), (rows) => {
    out("", "**(B5) where-used — distinct parents per child.** An intermediate under 2+ parents repeats its WHOLE subtree in a path-expanded tree:");
    out(...table(rows));
  });

  report("(B6) sourcing", await tryQ(`
    WITH ${BOM_CTE},
    bomids AS (SELECT project_id, child AS id FROM b UNION SELECT project_id, parent FROM b WHERE parent IS NOT NULL),
    scd AS (SELECT DISTINCT project_id, btrim(from_location) AS sup, btrim(to_location) AS mat
              FROM public.supply_chain_data WHERE data_source = 'inbound' AND project_id IN (SELECT project_id FROM bproj)),
    paired AS (SELECT DISTINCT project_id, mat AS id FROM scd),
    rowchild AS (SELECT DISTINCT project_id, child AS id FROM b)
    SELECT p.name AS project,
      (SELECT COUNT(*) FROM leaf l WHERE l.project_id = p.id AND EXISTS (SELECT 1 FROM lane x WHERE x.project_id = l.project_id AND x.id = l.id))::int AS leaves_with_lane,
      (SELECT COUNT(*) FROM leaf l WHERE l.project_id = p.id AND NOT EXISTS (SELECT 1 FROM lane x WHERE x.project_id = l.project_id AND x.id = l.id))::int AS leaves_no_lane,
      (SELECT COUNT(*) FROM mid m WHERE m.project_id = p.id AND EXISTS (SELECT 1 FROM lane x WHERE x.project_id = m.project_id AND x.id = m.id))::int AS intermediates_with_lane,
      (SELECT COUNT(*) FROM top t WHERE t.project_id = p.id AND EXISTS (SELECT 1 FROM lane x WHERE x.project_id = t.project_id AND x.id = t.id))::int AS top_with_lane,
      (SELECT COUNT(*) FROM lane l WHERE l.project_id = p.id AND NOT EXISTS (SELECT 1 FROM bomids x WHERE x.project_id = l.project_id AND x.id = l.id))::int AS lane_materials_not_in_bom,
      (SELECT COUNT(*) FROM leaf l JOIN lane x ON x.project_id = l.project_id AND x.id = l.id WHERE l.project_id = p.id AND x.sups = 1)::int AS leaf_1_sup,
      (SELECT COUNT(*) FROM leaf l JOIN lane x ON x.project_id = l.project_id AND x.id = l.id WHERE l.project_id = p.id AND x.sups = 2)::int AS leaf_2_sup,
      (SELECT COUNT(*) FROM leaf l JOIN lane x ON x.project_id = l.project_id AND x.id = l.id WHERE l.project_id = p.id AND x.sups >= 3)::int AS leaf_3plus_sup,
      (SELECT COALESCE(MAX(x.sups), 0) FROM lane x WHERE x.project_id = p.id)::int AS max_sups,
      (SELECT COUNT(*) FROM scd WHERE scd.project_id = p.id)::int AS grid_lane_lines,
      (SELECT COUNT(*) FROM rowchild r WHERE r.project_id = p.id
          AND NOT EXISTS (SELECT 1 FROM par x WHERE x.project_id = r.project_id AND x.id = r.id)
          AND NOT EXISTS (SELECT 1 FROM paired x WHERE x.project_id = r.project_id AND x.id = r.id))::int AS grid_unassigned_lines,
      (SELECT COUNT(*) FROM rowchild r WHERE r.project_id = p.id
          AND EXISTS (SELECT 1 FROM par x WHERE x.project_id = r.project_id AND x.id = r.id)
          AND NOT EXISTS (SELECT 1 FROM dem x WHERE x.project_id = r.project_id AND x.id = r.id)
          AND NOT EXISTS (SELECT 1 FROM paired x WHERE x.project_id = r.project_id AND x.id = r.id))::int AS grid_in_house_lines,
      (SELECT COUNT(DISTINCT btrim(m.material_id)) FROM public.materials m WHERE m.project_id = p.id
          AND NOT EXISTS (SELECT 1 FROM paired x WHERE x.project_id = m.project_id AND x.id = btrim(m.material_id))
          AND NOT EXISTS (SELECT 1 FROM rowchild x WHERE x.project_id = m.project_id AND x.id = btrim(m.material_id)))::int AS grid_not_in_bom_lines
    FROM public.projects p WHERE p.id IN (SELECT project_id FROM bproj) ORDER BY p.name`), (rows) => {
    out("", "**(B6) sourcing.** `leaves_no_lane` is what the engine refuses a run over (`materials with no supplier link`); `intermediates_with_lane` are BOUGHT sub-assemblies whose lanes the engine's flatten walks straight past. The four `grid_*` columns re-derive the Supplier grid's line classes from `useStageRows` rules (lanes · unassigned · made in-house · not in BOM) as a cross-check on the `N/N lines` the page prints:");
    out(...table(rows));
  });

  report("(B7) path-expanded size", await tryQ(`
    WITH RECURSIVE ${BOM_CTE}, ${DERIVED_EDGES_CTE},
    per_root AS (SELECT project_id, root, COUNT(*) - 1 AS occ, COUNT(DISTINCT node) - 1 AS nodes, MAX(array_length(path, 1)) - 1 AS depth
                   FROM walk GROUP BY 1, 2)
    SELECT p.name AS project,
      COUNT(*)::int AS demanded_roots,
      COUNT(*) FILTER (WHERE occ = 0)::int AS roots_with_no_bom,
      SUM(occ)::int AS node_rows_fully_expanded,
      MIN(occ) AS min_per_root, percentile_disc(0.5) WITHIN GROUP (ORDER BY occ) AS median_per_root, MAX(occ) AS max_per_root,
      MAX(nodes) AS max_distinct_under_one_root, MAX(depth) AS max_depth,
      (SELECT COUNT(DISTINCT n.id) FROM (SELECT child AS id FROM b WHERE b.project_id = p.id UNION SELECT parent FROM b WHERE b.project_id = p.id AND parent IS NOT NULL) n
        WHERE NOT EXISTS (SELECT 1 FROM walk w WHERE w.project_id = p.id AND w.node = n.id))::int AS bom_nodes_no_demanded_root_reaches,
      (SELECT COUNT(*) FROM walk w JOIN ex x ON x.project_id = w.project_id AND x.parent = w.node
        WHERE w.project_id = p.id AND x.child = ANY (w.path))::int AS cycle_hits
    FROM per_root r JOIN public.projects p ON p.id = r.project_id
    GROUP BY p.id, p.name ORDER BY p.name`), (rows) => {
    out("", "**(B7) the tree as the Supplier stage builds it** (demanded roots, D129/D171 edge rules). `node_rows_fully_expanded` is how many structural rows a user scrolls through with everything open, before any supplier line — the number a redesign has to beat:");
    out(...table(rows));
  });

  report("(B8) engine vs derivation", await tryQ(`
    WITH RECURSIVE ${BOM_CTE},
    ew AS (
      SELECT t.project_id, t.id AS root, t.id AS node, 1.0::numeric AS eff, ARRAY[t.id] AS path FROM top t
      UNION ALL
      SELECT w.project_id, w.root, r.child, w.eff * COALESCE(NULLIF(r.rate, 0), 1), w.path || r.child
        FROM ew w JOIN b r ON r.project_id = w.project_id AND r.parent = w.node
       WHERE r.child <> ALL (w.path) AND array_length(w.path, 1) < 64
    ),
    eng AS (SELECT w.project_id, w.root, w.node AS leaf, SUM(w.eff) AS qty
              FROM ew w JOIN leaf l ON l.project_id = w.project_id AND l.id = w.node GROUP BY 1, 2, 3),
    mt AS (SELECT project_id, data_source, btrim(from_location) AS f, btrim(path_root) AS root, weighted
             FROM public.supply_chain_data_multi_tier WHERE project_id IN (SELECT project_id FROM bproj)),
    rd AS (SELECT project_id, f AS root, SUM(weighted) AS wk FROM mt WHERE data_source = 'outbound' GROUP BY 1, 2),
    der AS (SELECT m.project_id, m.root, m.f AS leaf, SUM(m.weighted) / NULLIF(MAX(rd.wk), 0) AS qty
              FROM mt m JOIN rd ON rd.project_id = m.project_id AND rd.root = m.root
             WHERE m.data_source = 'bom' GROUP BY 1, 2, 3),
    cmp AS (SELECT eng.project_id, eng.root, eng.leaf, eng.qty AS engine_qty, der.qty AS derived_qty
              FROM eng JOIN dem d ON d.project_id = eng.project_id AND d.id = eng.root AND d.wk > 0
              LEFT JOIN der ON der.project_id = eng.project_id AND der.root = eng.root AND der.leaf = eng.leaf)
    SELECT p.name AS project, COUNT(*)::int AS root_leaf_pairs,
      COUNT(*) FILTER (WHERE derived_qty IS NOT NULL AND abs(engine_qty - derived_qty) <= 1e-6 * GREATEST(1, abs(engine_qty)))::int AS agree,
      COUNT(*) FILTER (WHERE derived_qty IS NULL)::int AS no_derived_row,
      COUNT(*) FILTER (WHERE derived_qty IS NOT NULL AND abs(engine_qty - derived_qty) > 1e-6 * GREATEST(1, abs(engine_qty)))::int AS disagree,
      MAX(abs(engine_qty - derived_qty))::text AS max_abs_diff,
      COUNT(*) FILTER (WHERE engine_qty <> 1)::int AS qty_not_1,
      MAX(engine_qty)::text AS max_qty_per_unit
    FROM cmp JOIN public.projects p ON p.id = cmp.project_id
    GROUP BY p.name ORDER BY p.name`), (rows) => {
    out("", "**(B8) \"how much M does one P need?\" — the engine's flatten (Σ over paths of Π rate, NULL/0 rate → 1) against the derived deep lane (Σ `weighted` of M's edges under root P ÷ P's demand)**, for every (demanded top parent, leaf) pair. The tree shows the second; the simulation runs the first:");
    out(...table(rows));
  });

  report("(B9) derived lane health", await tryQ(`
    WITH ${BOM_CTE},
    mt AS (SELECT * FROM public.supply_chain_data_multi_tier WHERE project_id IN (SELECT project_id FROM bproj))
    SELECT p.name AS project,
      (SELECT COUNT(*) FROM mt WHERE mt.project_id = p.id AND data_source = 'bom')::int AS bom_rows,
      (SELECT COUNT(*) FROM mt WHERE mt.project_id = p.id AND data_source = 'bom' AND COALESCE(btrim(path_root), '') = '')::int AS no_path_root,
      (SELECT COUNT(*) FROM mt WHERE mt.project_id = p.id AND data_source = 'outbound')::int AS outbound_rows,
      (SELECT COUNT(*) FROM mt WHERE mt.project_id = p.id AND data_source = 'inbound')::int AS inbound_rows,
      (SELECT COUNT(*) FROM e WHERE e.project_id = p.id AND NOT EXISTS (SELECT 1 FROM mt WHERE mt.project_id = e.project_id AND mt.data_source = 'bom'
          AND btrim(mt.from_location) = e.child AND btrim(mt.to_location) = e.parent))::int AS uploaded_edges_not_derived,
      (SELECT COUNT(*) FROM (SELECT DISTINCT btrim(from_location) f, btrim(to_location) t FROM mt WHERE mt.project_id = p.id AND data_source = 'bom') d
        WHERE NOT EXISTS (SELECT 1 FROM e WHERE e.project_id = p.id AND e.child = d.f AND e.parent = d.t))::int AS derived_edges_not_uploaded,
      (SELECT MAX(bom_depth) FROM mt WHERE mt.project_id = p.id)::int AS max_bom_depth,
      (SELECT COUNT(*) FROM dem d WHERE d.project_id = p.id AND COALESCE(d.wk, 0) = 0)::int AS demanded_rows_zero_volume,
      (SELECT MAX(created_at) FROM mt WHERE mt.project_id = p.id)::text AS derived_at,
      (SELECT MAX(updated_at) FROM public.bom_multi_level x WHERE x.project_id = p.id)::text AS bom_updated
    FROM public.projects p WHERE p.id IN (SELECT project_id FROM bproj) ORDER BY p.name`), (rows) => {
    out("", "**(B9) derived deep lane vs the upload** — `derived_edges_not_uploaded` should be only the D129 blank-parent hangs; `derived_at` older than `bom_updated` means the tree's numbers describe an older BOM:");
    out(...table(rows));
  });

  report("(B10) node_list echelon vs the upload's shape", await tryQ(`
    WITH ${BOM_CTE},
    shape AS (
      SELECT project_id, id, 'top' AS kind FROM top
      UNION ALL SELECT project_id, id, 'intermediate' FROM mid
      UNION ALL SELECT project_id, id, 'leaf' FROM leaf
    )
    SELECT p.name AS project, s.kind AS upload_shape, COALESCE(n.echelon, '(no node_list row)') AS echelon, COUNT(*)::int AS ids
      FROM shape s JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN LATERAL (SELECT echelon FROM public.node_list nl WHERE nl.project_id = s.project_id AND btrim(nl.node_id) = s.id LIMIT 1) n ON true
     GROUP BY p.name, s.kind, n.echelon ORDER BY p.name, s.kind, 3`), (rows) => {
    out("", "**(B10) the one classifier (`node_list.echelon`, D127) against the upload's own shape** — any cell off the diagonal (top→product, intermediate→subassembly, leaf→material) is a node a tree would label differently from every other page:");
    out(...table(rows));
  });

  report("(B11) lead time", await tryQ(`
    WITH ${BOM_CTE}
    SELECT p.name AS project,
      (SELECT COUNT(*) FROM public.inbound_logistics i WHERE i.project_id = p.id)::int AS lanes,
      (SELECT COUNT(*) FROM public.inbound_logistics i WHERE i.project_id = p.id AND i.lead_time IS NULL)::int AS lead_time_null,
      (SELECT MIN(lead_time) FROM public.inbound_logistics i WHERE i.project_id = p.id)::text AS lt_min,
      (SELECT MAX(lead_time) FROM public.inbound_logistics i WHERE i.project_id = p.id)::text AS lt_max,
      (SELECT string_agg(DISTINCT COALESCE(lead_time_unit, '(null)'), ', ') FROM public.inbound_logistics i WHERE i.project_id = p.id) AS lead_time_units,
      (SELECT COUNT(*) FROM public.products x WHERE x.project_id = p.id)::int AS product_master_rows,
      (SELECT COUNT(*) FROM public.materials x WHERE x.project_id = p.id)::int AS material_master_rows,
      (SELECT COUNT(*) FROM public.materials x WHERE x.project_id = p.id AND COALESCE(btrim(x.name), '') NOT IN ('', btrim(x.material_id)))::int AS materials_with_a_name
    FROM public.projects p WHERE p.id IN (SELECT project_id FROM bproj) ORDER BY p.name`), (rows) => {
    out("", "**(B11) lead times and names** — what a \"longest lead-time path\" or a human-readable label could be built from (the BOM carries no assembly lead time for an intermediate):");
    out(...table(rows));
  });

  // ── bounded samples, per project, for designing against real ids ─────────
  report("(B12) demanded roots", await tryQ(`
    WITH RECURSIVE ${BOM_CTE}, ${DERIVED_EDGES_CTE},
    per_root AS (SELECT project_id, root, COUNT(*) - 1 AS occ, COUNT(DISTINCT node) - 1 AS nodes, MAX(array_length(path, 1)) - 1 AS depth FROM walk GROUP BY 1, 2),
    ranked AS (SELECT r.*, d.wk, ROW_NUMBER() OVER (PARTITION BY r.project_id ORDER BY d.wk DESC NULLS LAST, r.root) AS rn
                 FROM per_root r JOIN dem d ON d.project_id = r.project_id AND d.id = r.root)
    SELECT p.name AS project, root, round(wk, 2)::text AS demand_wk, occ AS node_rows, nodes AS distinct_nodes, depth
      FROM ranked JOIN public.projects p ON p.id = ranked.project_id
     WHERE rn <= 10 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B12) the 10 largest-demand roots per project** (sample):");
    out(...table(rows));
  });

  report("(B13) multi-parent materials", await tryQ(`
    WITH ${BOM_CTE},
    pc AS (SELECT e.project_id, e.child, COUNT(*)::int AS n,
                  string_agg(e.parent, ', ' ORDER BY e.parent) AS parents,
                  EXISTS (SELECT 1 FROM par x WHERE x.project_id = e.project_id AND x.id = e.child) AS is_mid
             FROM e GROUP BY 1, 2),
    ranked AS (SELECT pc.*, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY n DESC, child) AS rn FROM pc WHERE n > 1)
    SELECT p.name AS project, child, CASE WHEN is_mid THEN 'intermediate' ELSE 'leaf' END AS kind, n AS parents_n,
           left(parents, 120) AS parents,
           COALESCE((SELECT sups FROM lane l WHERE l.project_id = ranked.project_id AND l.id = ranked.child), 0) AS suppliers
      FROM ranked JOIN public.projects p ON p.id = ranked.project_id
     WHERE rn <= 10 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B13) the most-shared children per project** (sample) — the \"where used\" cases:");
    out(...table(rows));
  });

  report("(B14) widest parents", await tryQ(`
    WITH ${BOM_CTE},
    fo AS (SELECT e.project_id, e.parent, COUNT(*)::int AS n FROM e GROUP BY 1, 2),
    ranked AS (SELECT fo.*, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY n DESC, parent) AS rn FROM fo)
    SELECT p.name AS project, parent,
           CASE WHEN EXISTS (SELECT 1 FROM top t WHERE t.project_id = ranked.project_id AND t.id = ranked.parent) THEN 'top' ELSE 'intermediate' END AS kind,
           n AS children,
           (SELECT MIN(level) FROM b WHERE b.project_id = ranked.project_id AND b.parent = ranked.parent)::int AS child_level
      FROM ranked JOIN public.projects p ON p.id = ranked.project_id
     WHERE rn <= 8 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B14) the widest parents per project** (sample):");
    out(...table(rows));
  });

  report("(B15) attention samples", await tryQ(`
    WITH ${BOM_CTE},
    cls AS (
      SELECT l.project_id, 'leaf, no inbound lane' AS what, l.id FROM leaf l
       WHERE NOT EXISTS (SELECT 1 FROM lane x WHERE x.project_id = l.project_id AND x.id = l.id)
      UNION ALL
      SELECT m.project_id, 'intermediate WITH a lane (' || x.sups || ' sup)', m.id FROM mid m
        JOIN lane x ON x.project_id = m.project_id AND x.id = m.id
      UNION ALL
      SELECT t.project_id, 'top parent, not demanded', t.id FROM top t
       WHERE NOT EXISTS (SELECT 1 FROM dem d WHERE d.project_id = t.project_id AND d.id = t.id)
      UNION ALL
      SELECT d.project_id, 'demanded, no BOM below', d.id FROM dem d
       WHERE NOT EXISTS (SELECT 1 FROM par x WHERE x.project_id = d.project_id AND x.id = d.id)
         AND NOT EXISTS (SELECT 1 FROM b WHERE b.project_id = d.project_id AND b.parent IS NULL
                           AND NOT EXISTS (SELECT 1 FROM prod x WHERE x.project_id = b.project_id AND x.id = b.child))
      UNION ALL
      SELECT r.project_id, 'blank-parent row', r.child || ' @L' || COALESCE(r.level::text, '?') FROM b r WHERE r.parent IS NULL
    ),
    ranked AS (SELECT cls.*, COUNT(*) OVER (PARTITION BY project_id, what) AS total,
                      ROW_NUMBER() OVER (PARTITION BY project_id, what ORDER BY id) AS rn FROM cls)
    SELECT p.name AS project, ranked.what, ranked.total::int AS total, string_agg(ranked.id, ', ' ORDER BY ranked.id) AS first_ids
      FROM ranked JOIN public.projects p ON p.id = ranked.project_id
     WHERE ranked.rn <= 8 GROUP BY p.name, ranked.what, ranked.total ORDER BY p.name, ranked.what`), (rows) => {
    out("", "**(B15) lines that need a user's attention, per class** (first 8 ids each):");
    out(...table(rows));
  });

  report("(B16) one real branch", await tryQ(`
    WITH RECURSIVE ${BOM_CTE}, ${DERIVED_EDGES_CTE},
    pick AS (SELECT DISTINCT ON (project_id) project_id, id FROM dem d
              WHERE EXISTS (SELECT 1 FROM par x WHERE x.project_id = d.project_id AND x.id = d.id)
              ORDER BY project_id, wk DESC NULLS LAST, id),
    br AS (SELECT w.*, ROW_NUMBER() OVER (PARTITION BY w.project_id ORDER BY array_to_string(w.path, '/')) AS rn
             FROM walk w JOIN pick k ON k.project_id = w.project_id AND k.id = w.root)
    SELECT p.name AS project, array_length(path, 1) - 1 AS depth, node,
           (SELECT MIN(r.rate) FROM b r WHERE r.project_id = br.project_id AND r.child = br.node AND r.parent = path[array_length(path, 1) - 1])::text AS rate,
           COALESCE((SELECT sups FROM lane l WHERE l.project_id = br.project_id AND l.id = br.node), 0) AS suppliers,
           array_to_string(path, ' > ') AS path
      FROM br JOIN public.projects p ON p.id = br.project_id
     WHERE rn <= 45 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B16) the first 45 path-ordered rows under each project's largest-demand root** — the real subtree a mockup is drawn from:");
    out(...table(rows));
  });
}

/**
 * §15 · BOM usability Phase 1, second read — WHAT DOES A TREE CELL ACTUALLY READ?
 *
 * The first read (B1–B16, run `36555596249`) found both multi-level projects'
 * derived deep lanes PREDATE WP 8.2 (`bom_depth` NULL on every row; derived
 * 2025-10-10 and 2026-07-05), and on `Project AA - ver3` not one of 195
 * (product, leaf) pairs joined to a derived row by `path_root`. The Supplier
 * tree (D177) keys every number on (child, parent, path_root) and every root on
 * the outbound rows' `from_location`, so this reads exactly those keys — the
 * values a cell renders, not a count of them.
 */
async function bomDerivedLaneDetail() {
  section("§15 · BOM usability Phase 1 — what the Supplier tree's cells read from the derived lane");
  const MT = `
    bp AS (SELECT DISTINCT project_id FROM public.bom_multi_level),
    mt AS (SELECT m.* FROM public.supply_chain_data_multi_tier m WHERE m.project_id IN (SELECT project_id FROM bp))`;

  report("(B17) path_root per data_source", await tryQ(`
    WITH ${MT}
    SELECT p.name AS project, mt.data_source,
           COALESCE(NULLIF(btrim(mt.path_root), ''), '(blank)') AS path_root,
           COUNT(*)::int AS rows,
           COUNT(*) FILTER (WHERE mt.bom_depth IS NULL)::int AS bom_depth_null,
           string_agg(DISTINCT COALESCE(mt.level::text, 'null'), ',') AS level_values,
           round(SUM(mt.weighted), 4)::text AS sum_weighted,
           COUNT(*) FILTER (WHERE COALESCE(mt.weighted, 0) = 0)::int AS weighted_zero_or_null,
           MIN(mt.created_at)::text AS first_created, MAX(mt.created_at)::text AS last_created
      FROM mt JOIN public.projects p ON p.id = mt.project_id
     GROUP BY p.name, mt.data_source, 3
     ORDER BY p.name, mt.data_source, rows DESC
     LIMIT 60`), (rows) => {
    out("", "**(B17) derived-lane rows per `data_source` × `path_root`** — the tree reads a bom row's numbers only when its `path_root` equals an outbound row's `from_location`:");
    out(...table(rows));
  });

  report("(B18) outbound rows", await tryQ(`
    WITH ${MT}
    SELECT p.name AS project, mt.from_location, mt.to_location, mt.path_root, mt.weighted::text, mt.level, mt.bom_depth
      FROM mt JOIN public.projects p ON p.id = mt.project_id
     WHERE mt.data_source = 'outbound' ORDER BY p.name LIMIT 20`), (rows) => {
    out("", "**(B18) the derived lane's outbound rows** — the tree's roots and their demand:");
    out(...table(rows));
  });

  report("(B19) key match", await tryQ(`
    WITH ${MT},
    roots AS (SELECT project_id, btrim(from_location) AS r FROM mt WHERE data_source = 'outbound'),
    e AS (SELECT DISTINCT project_id, btrim(material_id) AS c, btrim(higher_level_component_id) AS pa
            FROM public.bom_multi_level WHERE COALESCE(btrim(higher_level_component_id), '') <> '')
    SELECT p.name AS project,
      (SELECT COUNT(*) FROM e WHERE e.project_id = p.id)::int AS uploaded_edges,
      (SELECT COUNT(*) FROM e WHERE e.project_id = p.id AND EXISTS (
          SELECT 1 FROM mt JOIN roots ON roots.project_id = mt.project_id AND roots.r = btrim(mt.path_root)
           WHERE mt.project_id = e.project_id AND mt.data_source = 'bom'
             AND btrim(mt.from_location) = e.c AND btrim(mt.to_location) = e.pa))::int AS edges_a_tree_cell_can_read,
      (SELECT COUNT(*) FROM (SELECT 1 FROM mt WHERE mt.project_id = p.id AND data_source = 'bom'
          GROUP BY btrim(from_location), btrim(to_location), btrim(path_root) HAVING COUNT(*) > 1) d)::int AS bom_keys_on_2plus_rows,
      (SELECT COUNT(*) FROM (SELECT 1 FROM mt WHERE mt.project_id = p.id AND data_source = 'inbound'
          GROUP BY btrim(from_location), btrim(to_location) HAVING COUNT(*) > 1) d)::int AS inbound_pairs_on_2plus_rows,
      (SELECT COUNT(*) FROM mt WHERE mt.project_id = p.id AND data_source NOT IN ('bom', 'inbound', 'outbound'))::int AS other_source_rows
    FROM public.projects p WHERE p.id IN (SELECT project_id FROM bp) ORDER BY p.name`), (rows) => {
    out("", "**(B19) how many uploaded BOM edges would show a NUMBER in the tree** (a derived row keyed (child, parent, a root the tree knows)); the rest render `not derived — run Combine`:");
    out(...table(rows));
  });

  report("(B20) bom-row sample", await tryQ(`
    WITH ${MT},
    s AS (SELECT mt.*, ROW_NUMBER() OVER (PARTITION BY mt.project_id ORDER BY mt.from_location, mt.to_location) AS rn
            FROM mt WHERE data_source = 'bom'
             AND btrim(from_location) IN ('WP1', 'DSC71N', 'E539.15112.000.00', 'ASNA2050DCJ3208', 'E539.14519.000.00'))
    SELECT p.name AS project, s.from_location, s.to_location, s.path_root, s.level, s.bom_depth,
           s.material_consumption_rate::text AS rate, s.weighted::text
      FROM s JOIN public.projects p ON p.id = s.project_id WHERE rn <= 30 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B20) the derived rows behind the first branch of B16** (`DB366 (S14A) > WP1 > DSC71N > … > ASNA2050DCJ3208`) — exactly what those tree cells print:");
    out(...table(rows));
  });

  report("(B21) engine/derivation disagreements", await tryQ(`
    WITH RECURSIVE
    b AS (SELECT project_id, btrim(material_id) AS child, NULLIF(btrim(higher_level_component_id), '') AS parent, consumption_rate AS rate
            FROM public.bom_multi_level WHERE COALESCE(btrim(material_id), '') <> ''),
    par AS (SELECT DISTINCT project_id, parent AS id FROM b WHERE parent IS NOT NULL),
    chi AS (SELECT DISTINCT project_id, child AS id FROM b WHERE parent IS NOT NULL),
    top AS (SELECT * FROM par p WHERE NOT EXISTS (SELECT 1 FROM chi c WHERE c.project_id = p.project_id AND c.id = p.id)),
    ew AS (
      SELECT t.project_id, t.id AS root, t.id AS node, 1.0::numeric AS eff, ARRAY[t.id] AS path FROM top t
      UNION ALL
      SELECT w.project_id, w.root, r.child, w.eff * COALESCE(NULLIF(r.rate, 0), 1), w.path || r.child
        FROM ew w JOIN b r ON r.project_id = w.project_id AND r.parent = w.node
       WHERE r.child <> ALL (w.path) AND array_length(w.path, 1) < 64),
    eng AS (SELECT w.project_id, w.root, w.node AS leaf, SUM(w.eff) AS qty, COUNT(*)::int AS paths
              FROM ew w WHERE NOT EXISTS (SELECT 1 FROM par x WHERE x.project_id = w.project_id AND x.id = w.node) AND w.node <> w.root
             GROUP BY 1, 2, 3),
    mt AS (SELECT project_id, data_source, btrim(from_location) AS f, btrim(to_location) AS t, btrim(path_root) AS root, weighted
             FROM public.supply_chain_data_multi_tier WHERE project_id IN (SELECT project_id FROM top)),
    rd AS (SELECT project_id, f AS root, SUM(weighted) AS wk FROM mt WHERE data_source = 'outbound' GROUP BY 1, 2),
    der AS (SELECT m.project_id, m.root, m.f AS leaf, SUM(m.weighted) AS w, COUNT(*)::int AS rows
              FROM mt m WHERE m.data_source = 'bom' GROUP BY 1, 2, 3),
    ranked AS (SELECT eng.*, der.w, der.rows, rd.wk, der.w / NULLIF(rd.wk, 0) AS derived_qty,
                      ROW_NUMBER() OVER (PARTITION BY eng.project_id ORDER BY abs(eng.qty - COALESCE(der.w / NULLIF(rd.wk, 0), 0)) DESC, eng.leaf) AS rn
                 FROM eng
                 LEFT JOIN rd ON rd.project_id = eng.project_id AND rd.root = eng.root
                 LEFT JOIN der ON der.project_id = eng.project_id AND der.root = eng.root AND der.leaf = eng.leaf)
    SELECT p.name AS project, root, leaf, paths, qty::text AS engine_qty, derived_qty::text, rows AS derived_rows, w::text AS sum_weighted, wk::text AS root_demand
      FROM ranked JOIN public.projects p ON p.id = ranked.project_id WHERE rn <= 5 ORDER BY p.name, rn`), (rows) => {
    out("", "**(B21) the five largest engine-vs-derived gaps per project** (engine = Σ paths Π rate; derived = Σ `weighted` over the leaf's rows under that root ÷ root demand):");
    out(...table(rows));
  });
}

/**
 * §15 measures ONE project. Phase 3's scope depends on how much D5/D7/D8 damage
 * exists AT ALL, and a single clean project is not that answer — least of all if
 * it is the seeded one. This sweep runs the three counting defects across every
 * project in the database, which is what makes a clean result mean something.
 */
async function allProjectsSweep() {
  section("Across EVERY project — what one project cannot tell you");

  for (const [label, lane, key] of [
    ["inbound_logistics", "inbound_logistics", "supplier_id, material_id"],
    ["outbound_logistics", "outbound_logistics", "customer_id, product_id"],
    ["bom_single_level", "bom_single_level", "product_id, material_id"],
    ["bom_multi_level", "bom_multi_level", "material_id, higher_level_component_id, level"],
  ]) {
    const res = await tryQ(`
      select count(*)::int as rows,
             count(distinct project_id)::int as projects,
             (select coalesce(sum(copies - 1), 0)::int from (
                select count(*)::int as copies from public.${lane}
                group by project_id, plant_name, ${key} having count(*) > 1) d)
               as rows_the_unique_index_would_reject
      from public.${lane}`);
    report(label, res, (rows) => {
      out(`**\`${label}\`** — natural key \`project_id + plant_name + ${key}\`:`);
      table(rows).forEach((l) => out(l));
      out("");
    });
  }

  // WP 3.2 described these three, which is what brought them inside the rules.
  // `tier2_suppliers` and `tier3_suppliers` are now promotion targets, so their
  // duplicate counts are WP 3.3's before-numbers exactly as the four lanes' are.
  // `multi_tier_supply_chain` is here for a different reason: its sidecar says no
  // code in `src/` or `supabase/functions/` reads or writes it, and whoever
  // decides whether to drop it should be deciding against a row count.
  for (const [label, lane, key] of [
    ["tier2_suppliers", "tier2_suppliers", "supplier_id, upstream_supplier_id, material_id"],
    ["tier3_suppliers", "tier3_suppliers", "supplier_id, upstream_supplier_id, material_id"],
    ["multi_tier_supply_chain", "multi_tier_supply_chain", "from_firm_id, to_firm_id"],
  ]) {
    const res = await tryQ(`
      select count(*)::int as rows,
             count(distinct project_id)::int as projects,
             (select coalesce(sum(copies - 1), 0)::int from (
                select count(*)::int as copies from public.${lane}
                group by project_id, plant_name, ${key} having count(*) > 1) d)
               as rows_the_unique_index_would_reject
      from public.${lane}`);
    report(label, res, (rows) => {
      out(`**\`${label}\`** (described in WP 3.2) — natural key \`project_id + plant_name + ${key}\`:`);
      table(rows).forEach((l) => out(l));
      out("");
    });
  }

  // The sidecar for `bom_multi_level` said `integer >= 1` and both live parsers
  // admitted 0 as the root level. WP 3.2 resolved it in favour of the parsers and
  // this is the measurement that says whether that was the right call: every
  // level-0 row is a row the stricter reading would have rejected.
  report("bom_multi_level rows at level 0 (WP 3.2's contract contradiction)", await tryQ(`
    select count(*) filter (where level = 0)::int as level_0,
           count(*) filter (where level < 0)::int as level_negative,
           min(level)::int as min_level,
           count(*)::int as total
    from public.bom_multi_level`),
    (rows) => { out(""); table(rows).forEach((l) => out(l)); });

  report("untrimmed / blank ids across every project", await tryQ(`
    select count(*)::int as rows_with_untrimmed_or_blank_ids
    from public.inbound_logistics
    where supplier_id is null or btrim(supplier_id) = ''
       or material_id is null or btrim(material_id) = ''
       or supplier_id is distinct from btrim(supplier_id)
       or material_id is distinct from btrim(material_id)`),
    (rows) => table(rows).forEach((l) => out(l)));

  report("null numerics across every project", await tryQ(`
    select count(*) filter (where volume is null)::int as null_volume,
           count(*) filter (where lead_time is null)::int as null_lead_time,
           count(*) filter (where unit_price is null)::int as null_price,
           count(*)::int as total
    from public.inbound_logistics`),
    (rows) => { out(""); table(rows).forEach((l) => out(l)); });

  report("unrecognized time_unit across every project", await tryQ(`
    select coalesce(time_unit,'<null>') as time_unit, count(*)::int as rows
    from public.inbound_logistics
    where lower(btrim(coalesce(time_unit,''))) not in
      ('day','days','d','daily','week','weeks','wk','w','weekly','month','months','mo','m',
       'monthly','quarter','quarters','quarterly','year','years','yr','y','yearly',
       'annual','annually')
    group by 1 order by 2 desc`),
    (rows) => {
      out("");
      out(`- **${rows.length}** unrecognized \`time_unit\` token(s) database-wide, each silently read as weekly.`);
      if (rows.length) table(rows.slice(0, SAMPLE_CAP)).forEach((l) => out(l));
    });

  report("the row the dual read's text branch still carries", await tryQ(`
    select p.id as project_id, (p.organization_id is null) as org_uuid_missing,
           (a.id is null) as modeler_has_no_account
    from public.projects p
    left join public.approved_users a on a.id = p.modeler_id
    where p.organization_id is null or (p.modeler_id is not null and a.id is null)`),
    (rows) => {
      out("");
      out(`**Which rows are actually unresolved** — D29's text branch cannot be removed while any \`org_uuid_missing\` row exists:`);
      table(rows).forEach((l) => out(l));
    });

  report("D1 — auto-seeded zeros, by project", await tryQ(`
    select count(distinct target_key)::int as distinct_targets,
           count(*)::int as rows
    from public.policy_overrides
    where family = 'inventory' and patch ? 'safety_stock_days'
      and (patch->>'safety_stock_days')::numeric = 0`),
    (rows) => {
      out("");
      out("**D1's surviving damage.** WP 0.1 closed the WRITE path; it did not clean what the path had already written:");
      table(rows).forEach((l) => out(l));
    });
}

// ── WP 8.0: the graph layer, measured BEFORE anything is changed ───────────
//
// WHY THIS PROBE EXISTS, and it is the whole of WP 8.0. The diagnosis of the
// Process- and Product-level network pages BRANCHES on a number nothing in this
// repository knows: how deep the BOM of the project a user is looking at is.
//
// `ProcessLevelNetwork.tsx`'s classifier is a fixed ladder — level 5 means
// supplier, 2–4 mean material, 1 means "work station" — and the ETL writes
// `supply_chain_data_multi_tier.level` as BOM TREE DEPTH on the bom lane and as
// that depth PLUS ONE on the inbound lane (§4 D112). So the ladder is correct on
// exactly one shape of data: a BOM four levels deep. On any other shape every
// supplier lands at a level the ladder calls a material, and the page renders
// and LABELS it as one. Whether that is what a given user is seeing, or a latent
// defect on their project and something else on their screen, is a fact about
// production and not about the code — so it is measured here first.
//
// Six questions, each one sized rather than described:
//
//   1. `projects.bom_level` for EVERY project. `single` writes no multi-tier
//      rows at all (D115), so a Process page that is empty needs no further
//      explanation, and one that is full rules the defect out.
//   2. the `level` histogram per lane. `max(level) = 5` means the ladder
//      happens to be right; anything else means D112 is live.
//   3. `to_location = ''` in the multi-tier table — D114, the severed BOM root,
//      as a row count.
//   4. one node id at more than one `level` — the blast radius of D113, the
//      dedup guard that tests a key it never writes.
//   5. one node id in more than one lane ROLE — D116, the firm that is both a
//      supplier and a customer and collapses into one node.
//   6. `node_list` against the multi-tier node set — how much of the graph the
//      typed projection WP 8.1 extends cannot currently see.
//
// Every one is a `select`. None of them needs the project §15 measures, because
// D42's lesson is that the largest project is the seeded one: all six run across
// every project in the database and print per-project rows.
async function graphLayerBefore() {
  section("WP 8.0 — the graph layer, measured before it is changed (D127–D133)");

  // 1 ── the shape the ladder depends on, per project.
  const shape = await tryQ(`
    select p.name as project,
           coalesce(p.bom_level, '(null)') as bom_level,
           (select count(*)::int from public.bom_single_level t where t.project_id = p.id) as bom_single,
           (select count(*)::int from public.bom_multi_level  t where t.project_id = p.id) as bom_multi,
           (select coalesce(max(t.level), 0)::int from public.bom_multi_level t where t.project_id = p.id) as max_bom_depth,
           (select count(*)::int from public.inbound_logistics  t where t.project_id = p.id) as inbound,
           (select count(*)::int from public.outbound_logistics t where t.project_id = p.id) as outbound,
           (select count(*)::int from public.supply_chain_data t where t.project_id = p.id) as scd_rows,
           (select count(*)::int from public.supply_chain_data_multi_tier t where t.project_id = p.id) as scdmt_rows
      from public.projects p order by p.created_at`);
  report("the shape every classifier depends on, per project (D130, D127)", shape, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const single = rows.filter((r) => r.bom_level === "single");
    const singleWithTier = single.filter((r) => Number(r.scdmt_rows) > 0);
    const singleNoTier = single.filter((r) => Number(r.scdmt_rows) === 0);
    out("");
    out(
      `- **${single.length} of ${rows.length} project(s) are \`bom_level = 'single'\`**, and ${singleNoTier.length} ` +
        "of those hold ZERO `supply_chain_data_multi_tier` rows. That was **D130**: the edge function built the " +
        "multi-tier lanes only inside its multi-level branch, so a single-level project's Process-level page was " +
        "permanently empty and no error said why. **WP 8.2 CLOSED IT IN THE WRITER, AND A NON-ZERO COUNT HERE IS " +
        "NOT THE EXIT CHECK** — the surviving ETL never reads `projects.bom_level` and builds both lanes from " +
        "whichever BOM rows exist, but it changed what a combine WRITES and backfilled nothing. A single-level " +
        "project still reads ZERO here until somebody presses Combine on it. **This line measures ADOPTION, not " +
        "the fix**, which is the distinction §4 D88 cost three packages to learn.",
    );
    if (singleWithTier.length) {
      out(
        `- **${singleWithTier.length} single-level project(s) DO hold multi-tier rows**, which the current ETL ` +
          "cannot produce — they predate a change, or were written by another path. Read them before WP 8.2 " +
          "backfills the lane, because a backfill that assumes the table is empty would double the graph.",
      );
    }
    // THE LADDER'S PRECONDITION, stated per project rather than in general.
    const deep = rows.filter((r) => Number(r.bom_multi) > 0);
    const ladderHolds = deep.filter((r) => Number(r.max_bom_depth) === 4);
    out(
      `- **${deep.length} project(s) have a multi-level BOM at all; ${ladderHolds.length} of them are exactly ` +
        "4 levels deep.** `ProcessLevelNetwork.tsx`'s ladder calls level 5 a supplier and the inbound lane writes " +
        "`max BOM depth + 1`, so the ladder is right on the 4-deep ones and wrong on every other one — suppliers " +
        "there are rendered and labelled `material level N`. That is **D127** as a count of affected projects.",
    );
  });

  // 2 ── the histogram itself, because "max is not 5" does not say what a
  //      reader would see; the level a supplier actually lands on does.
  const levels = await tryQ(`
    select p.name as project, t.data_source, t.level,
           count(*)::int as rows,
           count(distinct t.from_location)::int as distinct_from,
           count(distinct t.to_location)::int   as distinct_to
      from public.supply_chain_data_multi_tier t
      join public.projects p on p.id = t.project_id
     group by 1, 2, 3 order by 1, 2, 3`);
  report("the `level` histogram per lane — what the ladder is actually reading", levels, (rows) => {
    if (!rows?.length) { out("- `supply_chain_data_multi_tier` is empty in every project."); return; }
    out(...table(rows));
    const inboundLevels = [...new Set(rows.filter((r) => r.data_source === "inbound").map((r) => r.level))].sort();
    out("");
    out(
      `- The inbound lane — every row of which is a SUPPLIER edge by construction — occupies level(s) ` +
        `**${inboundLevels.join(", ") || "(none)"}**. The ladder recognises a supplier at 5 and above only. Any ` +
        "other value in that list is a supplier the page types as a material.",
    );
  });

  // 3 ── D129, the severed BOM root, in both edge tables. `''` and NULL are
  //      counted apart because the page's own falsiness test cannot tell them
  //      apart and a migration would have to.
  const blanks = await tryQ(`
    select 'supply_chain_data_multi_tier' as tbl, p.name as project,
           count(*) filter (where t.to_location = '')::int   as to_empty,
           count(*) filter (where t.to_location is null)::int as to_null,
           count(*) filter (where t.from_location = '')::int  as from_empty,
           count(*) filter (where t.from_location is null)::int as from_null,
           count(*) filter (where t.data_source = 'bom' and t.level = 1)::int as bom_level_1_rows
      from public.supply_chain_data_multi_tier t
      join public.projects p on p.id = t.project_id
     group by 1, 2
    union all
    select 'supply_chain_data', p.name,
           count(*) filter (where t.to_location = '')::int,
           count(*) filter (where t.to_location is null)::int,
           count(*) filter (where t.from_location = '')::int,
           count(*) filter (where t.from_location is null)::int,
           count(*) filter (where t.data_source = 'bom')::int
      from public.supply_chain_data t
      join public.projects p on p.id = t.project_id
     group by 1, 2
     order by 1, 2`);
  report("D129 — edges pointing at the empty string, where the BOM root should be", blanks, (rows) => {
    if (!rows?.length) { out("- Both edge tables are empty."); return; }
    out(...table(rows));
    const empties = rows.reduce((a, r) => a + Number(r.to_empty || 0) + Number(r.from_empty || 0), 0);
    out("");
    out(
      empties > 0
        ? `- **${empties} edge endpoint(s) are the empty string.** \`bom_multi_level.higher_level_component_id\` is ` +
          "blank at the top of the tree, where the parent IS the finished product, and the ETL writes that blank " +
          "straight through. The page treats `''` as falsy, so it creates no node and skips the edge: every " +
          "material→finished-product edge is dropped, which is **D129**."
        : "- **No empty endpoints.** Either the BOM roots reach the product already, or no project has a level-1 " +
          "BOM row for the defect to act on — the `bom_level_1_rows` column above says which, and a zero there " +
          "makes D129 latent rather than absent.",
    );
  });

  // 4 ── D128. The dedup guard computes `nodeId::level::data_source` and tests
  //      `nodeMap[dedupKey]` while writing `nodeMap[nodeId]`, so the guard never
  //      fires and the LAST row read wins the node's level, type and lane. This
  //      counts the nodes for which "last row wins" is a real choice.
  const multiLevel = await tryQ(`
    with per_node as (
      select t.project_id, n.node_id,
             count(distinct t.level)::int       as levels,
             count(distinct t.data_source)::int as lanes,
             count(*)::int                      as rows
        from public.supply_chain_data_multi_tier t
        cross join lateral (values (t.from_location), (t.to_location)) as n(node_id)
       where n.node_id is not null and n.node_id <> ''
       group by 1, 2
    )
    select p.name as project,
           count(*)::int                                     as nodes,
           count(*) filter (where levels > 1)::int            as nodes_at_many_levels,
           count(*) filter (where lanes  > 1)::int            as nodes_in_many_lanes,
           sum(rows) filter (where levels > 1)::int           as rows_behind_them,
           max(levels)::int                                   as worst_level_spread
      from per_node
      join public.projects p on p.id = per_node.project_id
     group by 1 order by 1`);
  report("D128 — nodes whose level depends on which row was read last", multiLevel, (rows) => {
    if (!rows?.length) { out("- No multi-tier nodes to count."); return; }
    out(...table(rows));
    const affected = rows.reduce((a, r) => a + Number(r.nodes_at_many_levels || 0), 0);
    out("");
    out(
      `- **${affected} node(s) appear at more than one \`level\`.** For every one of them the page's node map is ` +
        "written by whichever row the loop reached last — its level, its type, its lane and its colour. The guard " +
        "meant to prevent that tests a key the map is never keyed by, so it has never fired once. `levelNodeCounts` " +
        "is incremented in the same unreachable-guard block, which is why the legend counts and the \"BOM levels\" " +
        "tile count ROWS rather than nodes: **D128**.",
    );
  });

  // 5 ── D131. Node identity is a bare string shared by three lanes, so a role
  //      is not part of it. The pairs that matter are the ones a supply-chain
  //      reader would refuse to merge: a firm that sells to the plant and buys
  //      from it is two roles on one legal entity, not one node.
  const roles = await tryQ(`
    with roles as (
      select t.project_id,
             case when t.data_source = 'inbound'  then t.from_location end as supplier,
             case when t.data_source = 'outbound' then t.to_location   end as customer,
             case when t.data_source = 'inbound'  then t.to_location   end as material_in,
             case when t.data_source = 'bom'      then t.from_location end as material_bom,
             case when t.data_source = 'bom'      then t.to_location   end as product_bom,
             case when t.data_source = 'outbound' then t.from_location end as product_out
        from public.supply_chain_data t
    ), per_node as (
      select project_id, node_id,
             bool_or(is_supplier) as is_supplier, bool_or(is_customer) as is_customer,
             bool_or(is_material) as is_material, bool_or(is_product)  as is_product
        from (
          select project_id, supplier    as node_id, true  as is_supplier, false as is_customer, false as is_material, false as is_product from roles where supplier    is not null and supplier    <> ''
          union all
          select project_id, customer,               false, true,  false, false from roles where customer    is not null and customer    <> ''
          union all
          select project_id, material_in,            false, false, true,  false from roles where material_in is not null and material_in <> ''
          union all
          select project_id, material_bom,           false, false, true,  false from roles where material_bom is not null and material_bom <> ''
          union all
          select project_id, product_bom,            false, false, false, true  from roles where product_bom is not null and product_bom <> ''
          union all
          select project_id, product_out,            false, false, false, true  from roles where product_out is not null and product_out <> ''
        ) u
       group by 1, 2
    )
    select p.name as project,
           count(*)::int as nodes,
           count(*) filter (where is_supplier and is_customer)::int as supplier_and_customer,
           count(*) filter (where is_supplier and is_material)::int as supplier_and_material,
           count(*) filter (where is_material and is_product)::int  as material_and_product,
           count(*) filter (where (is_supplier::int + is_customer::int + is_material::int + is_product::int) > 1)::int as any_dual_role
      from per_node
      join public.projects p on p.id = per_node.project_id
     group by 1 order by 1`);
  report("D131 / D127 — nodes holding more than one lane role, which eight classifiers resolve eight ways", roles, (rows) => {
    if (!rows?.length) { out("- `supply_chain_data` is empty in every project."); return; }
    out(...table(rows));
    const dual = rows.reduce((a, r) => a + Number(r.any_dual_role || 0), 0);
    const bothFirm = rows.reduce((a, r) => a + Number(r.supplier_and_customer || 0), 0);
    const supMat = rows.reduce((a, r) => a + Number(r.supplier_and_material || 0), 0);
    const matProd = rows.reduce((a, r) => a + Number(r.material_and_product || 0), 0);
    out("");
    out(
      `- **${dual} node(s) hold more than one lane role**, and each one is where the classifiers diverge by ` +
        "construction: `classify_node_type` resolves a supplier-and-material node to `material` by its priority " +
        "order, `ProductLevelNetwork` resolves it to A or B depending on which row it read last, " +
        "`ProcessLevelNetwork` resolves it to `supplier` through its `inbound` override, and `MapView`'s binary " +
        "supplier-else-customer test drops it from the map. Same node, four answers, one screen apart (**D127**).",
    );
    out(
      `- ${bothFirm} are BOTH a supplier and a customer — **D131**: identity is a bare string with no role in it, ` +
        `so the two collapse into one node. ${supMat} are a supplier and a material; ${matProd} are a material and ` +
        "a product, which is the `subassembly` the SQL classifier has no value for and WP 8.1 adds.",
    );
  });

  // 6 ── the projection WP 8.1 extends, against the graph it is meant to type.
  //      `rebuild_node_list` reads `supply_chain_data` ONLY, so every node that
  //      exists just in the multi-tier lane is outside the typed projection —
  //      which is why Process-level has nothing to read and infers instead.
  const projection = await tryQ(`
    with scdmt_nodes as (
      select distinct t.project_id, n.node_id
        from public.supply_chain_data_multi_tier t
        cross join lateral (values (t.from_location), (t.to_location)) as n(node_id)
       where n.node_id is not null and n.node_id <> ''
    ), scd_nodes as (
      select distinct t.project_id, n.node_id
        from public.supply_chain_data t
        cross join lateral (values (t.from_location), (t.to_location)) as n(node_id)
       where n.node_id is not null and n.node_id <> ''
    )
    select p.name as project,
           (select count(*)::int from public.node_list l where l.project_id = p.id) as node_list_rows,
           (select count(*)::int from scd_nodes   s where s.project_id = p.id)      as scd_nodes,
           (select count(*)::int from scdmt_nodes m where m.project_id = p.id)      as scdmt_nodes,
           (select count(*)::int from scdmt_nodes m
             where m.project_id = p.id
               and not exists (select 1 from public.node_list l
                                where l.project_id = m.project_id and l.node_id = m.node_id)) as scdmt_nodes_untyped,
           (select count(*)::int from public.node_list l
             where l.project_id = p.id and (l.node_type is null or l.node_type = 'unknown')) as node_list_untyped
      from public.projects p order by p.created_at`);
  report("D132 — how much of the graph the typed projection cannot see", projection, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const missing = rows.reduce((a, r) => a + Number(r.scdmt_nodes_untyped || 0), 0);
    const unknown = rows.reduce((a, r) => a + Number(r.node_list_untyped || 0), 0);
    out("");
    out(
      `- **${missing} multi-tier node(s) have no \`node_list\` row.** \`rebuild_node_list\` reads ` +
        "`supply_chain_data` and nothing else, so the deep-tier half of the graph — the half Process-level renders " +
        "— is outside the one typed projection this repository has. That is **D132**, and it is why WP 8.1's " +
        "derivation has to read both edge tables before WP 8.3 can make a page read a type instead of guessing one.",
    );
    out(
      `- ${unknown} \`node_list\` row(s) are typed \`unknown\` or NULL. \`classify_node_type\` returns \`unknown\` ` +
        "when a node appears in no lane it recognises, and `ProductLevelNetwork.tsx` defaults an unrecognised " +
        "group to **Supplier** rather than rendering it as unknown — a value displayed for data that does not " +
        "carry it, which is T1.",
    );
  });

  // 7 ── the two columns a page filters on and a report reads, both measured
  //      rather than assumed: `data_source_group` (D133) and a NULL `level`,
  //      which `COALESCE(level, 0)` serves to the ladder as a PRODUCT (D134).
  //
  // WRITTEN FOR BOTH SHAPES, DELIBERATELY. WP 8.2 DROPS `data_source_group` and
  // ADDS `bom_depth`, and its migrations deploy on MERGE — so this probe must
  // answer against production before that deploy and after it, and a §15 report
  // taken from a branch measures the shape WITHOUT the branch's migrations. A
  // probe that names a column unconditionally is a probe that errors on one side
  // of a deploy and reports nothing, which is the state the answer cannot be read
  // out of. The two columns are detected first and the report SAYS WHICH SHAPE IT
  // MEASURED.
  const columnShape = await tryQ(`
    select (select count(*)::int from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_chain_data'
               and column_name = 'data_source_group')            as has_group,
           (select count(*)::int from information_schema.columns
             where table_schema = 'public' and table_name = 'supply_chain_data_multi_tier'
               and column_name = 'bom_depth')                    as has_bom_depth`);
  const hasGroup = Number(columnShape.rows?.[0]?.has_group ?? 0) > 0;
  const hasDepth = Number(columnShape.rows?.[0]?.has_bom_depth ?? 0) > 0;

  const columns = await tryQ(`
    select (select count(*)::int from public.supply_chain_data)                               as scd_rows,
           ${hasGroup
             ? "(select count(*)::int from public.supply_chain_data where data_source_group is not null)"
             : "null::int"}                                                                   as scd_group_written,
           (select count(*)::int from public.supply_chain_data_multi_tier)                     as scdmt_rows,
           (select count(*)::int from public.supply_chain_data_multi_tier where level is null) as scdmt_level_null,
           (select count(*)::int from public.supply_chain_data_multi_tier where level = 0)     as scdmt_level_zero,
           ${hasDepth
             ? "(select count(*)::int from public.supply_chain_data_multi_tier where bom_depth is distinct from level)"
             : "null::int"}                                                                   as depth_alias_broken`);
  report("D133 / D134 — the documented filter column, and the NULL level the RPC types as a product", columns, (rows) => {
    if (!rows?.length) { out("- No rows returned."); return; }
    out(...table(rows));
    const r = rows[0];
    out("");
    out(
      `- **Shape measured:** \`data_source_group\` ${hasGroup ? "EXISTS" : "is GONE"}, ` +
        `\`bom_depth\` ${hasDepth ? "EXISTS" : "is ABSENT"}. WP 8.2 drops the first and adds the second, ` +
        "and its migrations deploy on MERGE — so a report taken from a feature branch measures the schema " +
        "WITHOUT them, and this line says which one this run saw rather than leaving it to be inferred.",
    );
    out(
      !hasGroup
        ? "- **`data_source_group` is gone, with its contract claim, and that closes D133.** It was written on 0 " +
          "of 5 445 rows while its sidecar told readers the network pages filter on it. Writing it was the worse " +
          "of the two outcomes D133 allowed: `data_source` holds three values and a \"coarser grouping\" of three " +
          "is not a grouping."
        : Number(r.scd_group_written) === 0
          ? `- **\`data_source_group\` is written on 0 of ${r.scd_rows} rows.** Its sidecar says the network pages ` +
            "filter on it and no writer anywhere sets it, so the filter is a documented fact about a column that is " +
            "always NULL — **D133**. WP 8.2 deletes it and its contract claim together; this run predates that deploy."
          : `- \`data_source_group\` is written on ${r.scd_group_written} of ${r.scd_rows} rows — the sidecar's ` +
            "claim is partly true, and WP 8.2 owns which rows it is false for.",
    );
    out(
      `- **${r.scdmt_level_null} row(s) carry a NULL \`level\`** and ${r.scdmt_level_zero} carry 0. ` +
        (hasDepth
          ? "The read path no longer substitutes 0 for a NULL (D134 closed by WP 8.2), so a NULL here now reaches " +
            "the page as a NULL. **A non-zero count is no longer a defect — it is an unknown depth arriving as " +
            "unknown**, which is what the column is for."
          : "`COALESCE(scdmt.level, 0)` in the multi-tier RPC serves a NULL as 0, and the ladder calls 0 a " +
            "**product**: an unknown depth is answered with a confident wrong type rather than with `unknown` " +
            "(**D134**). A zero count makes it latent, not closed — nothing stops the next NULL."),
    );
    if (hasDepth) {
      out(
        Number(r.depth_alias_broken) === 0
          ? "- `level` and `bom_depth` agree on every row, which is what a DEPRECATED ALIAS means: the same value, " +
            "NULLs included, for one release. **This is the number to watch while the readers move** — the day it " +
            "is non-zero, `level` has stopped being an alias and started being a second authoring."
          : `- **${r.depth_alias_broken} row(s) have \`level\` different from \`bom_depth\`.** ` +
            "`level` is supposed to be a deprecated ALIAS carrying the same value. Something wrote one without the " +
            "other, and every page still reading `level` is reading a value the honest column disagrees with.",
      );
      out(
        "- **AND THE ROWS THIS DEPLOY DID NOT FIX ARE THE POINT.** WP 8.2 changed what a combine WRITES, not what " +
          "is stored: every project still holds the graph its last combine produced, at whatever `level` that " +
          "writer meant. `Project AA - ver3` needs Combine re-run. Probe 8's histogram is where to check it.",
      );
    }
  });
}

// ── WP 8.0, probes 8–11: WHICH ETL wrote this project's graph? ──────────────
//
// THE FIRST SEVEN PROBES ANSWERED A QUESTION THAT TURNED OUT TO BE THE WRONG ONE,
// and the report is what said so. Run 35433237514 read the `level` histogram and
// two projects with the SAME 396-row, 4-deep `bom_multi_level` disagreed about
// their own lane: one held bom levels 1, 2, 3 and 4 as the ETL's `row.level || 1`
// would write them, and the other held **397 bom rows all at level 2**, with its
// inbound lane split across levels 1 and 5.
//
// No reading of `combine-project/index.ts` can produce that, because a second
// ETL exists. `combine_project_into_supply_chain` is a SQL RPC called from three
// client sites, it writes BOTH edge tables, and it writes `level` by a fourth
// rule that is nothing like the edge function's: outbound `0`, `bom_single_level`
// a literal `1`, **`bom_multi_level` a literal `2` — ignoring `b.level`
// entirely** — and inbound `GREATEST(1, max_level + 1)` per material. That is
// D140, and it is the ninth classifier of the eight D127 counts, one layer down:
// two live writers disagreeing about what the column MEANS, where D127 is eight
// live readers disagreeing about what it SAYS.
//
// It also changes D129 from "an edge is dropped" to something worse. The RPC
// writes `COALESCE(b.higher_level_component_id, 'ROOT')` — so where the BOM root
// has no parent it does not drop the edge, it **invents a node called `ROOT`** and
// points every root material at it. The first seven probes found zero empty
// endpoints and read that as D129 being latent. It is not latent; it is a
// different shape, and a count of `''` could never have seen it.
//
// So: four more probes, all `select`, all every-project. Which writer wrote each
// lane (probe 8), whether `ROOT` is in the data (probe 9), whether the lane still
// agrees with the tables it was derived from (probe 10), and how many BOM roots
// there are for the defect to act on (probe 11).
async function graphLayerWhoWroteIt() {
  section("WP 8.0 — WHICH ETL wrote this graph, and what it invented (D140, D141)");

  // 8 ── the signature. The two writers leave different fingerprints in the bom
  //      lane, and the BOM's own depth is the control.
  const signature = await tryQ(`
    select p.name as project,
           (select coalesce(max(b.level), 0)::int from public.bom_multi_level b where b.project_id = p.id) as bom_table_max_depth,
           (select count(distinct b.level)::int    from public.bom_multi_level b where b.project_id = p.id) as bom_table_depths,
           (select string_agg(distinct t.level::text, ',' order by t.level::text)
              from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.data_source = 'bom')      as lane_bom_levels,
           (select string_agg(distinct t.level::text, ',' order by t.level::text)
              from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.data_source = 'inbound')  as lane_inbound_levels
      from public.projects p order by p.created_at`);
  report("D140 — the bom lane's levels against the BOM table's own depths", signature, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const withLane = rows.filter((r) => r.lane_bom_levels);
    const flattened = withLane.filter((r) => Number(r.bom_table_depths) > 1 && r.lane_bom_levels === "2");
    const laddered = withLane.filter((r) => (r.lane_bom_levels ?? "").includes(","));
    out("");
    out(
      `- **${flattened.length} project(s) have a multi-depth BOM whose entire bom lane sits at level 2**, and ` +
        `${laddered.length} carry a ladder of several levels. Those are the two ETLs' fingerprints: the SQL RPC ` +
        "writes a LITERAL `2` for every `bom_multi_level` row and the edge function writes `row.level || 1`, so the " +
        "histogram says which one last ran — and a page reading a fixed echelon ladder is reading a column whose " +
        "meaning depends on that. **D140**: two live writers, one column, two definitions.",
    );
    out(
      "- The `lane_inbound_levels` column is the same story on the other lane. Both writers use a `max BOM depth + 1` " +
        "shape there, so a material absent from `bom_multi_level` lands at **1** and one at depth 4 lands at **5** — " +
        "two suppliers, four levels apart, in the same upload. The page's ladder calls the first a material.",
    );
  });

  // 9 ── the invented node. `'ROOT'` is not a material, a product, a supplier or
  //      a customer; it is a string the RPC substitutes for a missing parent.
  const root = await tryQ(`
    select p.name as project,
           (select count(*)::int from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and (t.to_location = 'ROOT' or t.from_location = 'ROOT')) as scdmt_root_edges,
           (select count(*)::int from public.supply_chain_data t
             where t.project_id = p.id and (t.to_location = 'ROOT' or t.from_location = 'ROOT')) as scd_root_edges,
           (select count(*)::int from public.node_list l
             where l.project_id = p.id and l.node_id = 'ROOT')                                    as node_list_root,
           (select count(*)::int from public.bom_multi_level b
             where b.project_id = p.id
               and (b.higher_level_component_id is null or btrim(b.higher_level_component_id) = '')) as bom_roots
      from public.projects p order by p.created_at`);
  report("D141 — `ROOT`, the node no upload contains", root, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const edges = rows.reduce((a, r) => a + Number(r.scdmt_root_edges || 0) + Number(r.scd_root_edges || 0), 0);
    const typed = rows.reduce((a, r) => a + Number(r.node_list_root || 0), 0);
    const roots = rows.reduce((a, r) => a + Number(r.bom_roots || 0), 0);
    out("");
    out(
      edges > 0
        ? `- **${edges} edge(s) name a node called \`ROOT\`, and ${typed} of them reached \`node_list\` as a typed ` +
          "node.** `COALESCE(b.higher_level_component_id, 'ROOT')` invents it where the BOM root has no parent — the " +
          "place the sidecar says the parent IS the finished product. So the finished product is still severed from " +
          "its own BOM, and in its place there is a node that no CSV contains, that no user can explain, and that " +
          "every centrality on the page is computed over. **T1 in one string**: a node on screen sourced to nothing."
        : `- **No \`ROOT\` edges.** The substitution is in the live RPC and has produced nothing measurable — either ` +
          `no project has a parentless BOM row (the \`bom_roots\` column says: ${roots} across all projects), or the ` +
          "lane predates it. A zero here makes D141 latent, not absent: the `COALESCE` is still what the next " +
          "parentless row meets.",
    );
    out(
      `- ${roots} \`bom_multi_level\` row(s) have no parent at all, which is how many finished-product edges the ` +
        "two writers have to get right. The edge function drops them (the demand walk finds no parent, so the child " +
        "gets no root and the row is never emitted); the RPC points them at `ROOT`. **Neither writes the product** — " +
        "which is D129, restated against what the data actually shows rather than against the `|| ''` a reader sees " +
        "first.",
    );
  });

  // 10 ── is the lane still true? Neither writer is triggered by an upload, so a
  //       later CSV changes the source tables and leaves the graph alone.
  const stale = await tryQ(`
    select p.name as project,
           (select count(*)::int from public.inbound_logistics  s where s.project_id = p.id) as inbound_src,
           (select count(*)::int from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.data_source = 'inbound')                        as inbound_lane,
           (select count(*)::int from public.outbound_logistics s where s.project_id = p.id) as outbound_src,
           (select count(*)::int from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.data_source = 'outbound')                       as outbound_lane,
           (select count(*)::int from public.bom_multi_level b where b.project_id = p.id)
             + (select count(*)::int from public.bom_single_level b where b.project_id = p.id) as bom_src,
           (select count(*)::int from public.supply_chain_data_multi_tier t
             where t.project_id = p.id and t.data_source = 'bom')                            as bom_lane,
           (select max(t.updated_at) from public.supply_chain_data_multi_tier t where t.project_id = p.id) as lane_written,
           (select max(s.updated_at) from public.inbound_logistics s where s.project_id = p.id)            as inbound_touched
      from public.projects p order by p.created_at`);
  report("D142 — the lane against the tables it was derived from", stale, (rows) => {
    if (!rows?.length) { out("- No projects."); return; }
    out(...table(rows));
    const drifted = rows.filter(
      (r) => Number(r.inbound_lane) > 0 && Number(r.inbound_lane) !== Number(r.inbound_src),
    );
    out("");
    out(
      drifted.length
        ? `- **${drifted.length} project(s) have an inbound lane whose row count does not match ` +
          "`inbound_logistics`.** Neither writer is a trigger: both are invoked by a client, so a CSV uploaded after " +
          "the last combine changes the source table and leaves the graph exactly as it was. The page then renders a " +
          "graph of a world that no longer exists, with no staleness signal on it — **D142**, and it is the one " +
          "defect in this phase that a user would describe as \"the map looks wrong\" without any classifier being " +
          "involved at all."
        : "- Every non-empty inbound lane matches its source row count. That does not make the lane fresh — a " +
          "same-size edit moves no count — but it removes the largest and cheapest explanation.",
    );
    out(
      "- `lane_written` beside `inbound_touched` is the direct comparison. A source touched AFTER the lane was " +
        "written is a graph derived from data that has since changed, and `project_freshness` is shown on " +
        "Product-level and on no other network page.",
    );
  });
}

// ── THE 2026-09-22 USER AUDIT — WP 1: the shape, measured before anything moves ──
//
// The audit (F-01…F-37) was written against the REPOSITORY, and said so: no
// browser, no database, no worker. Five of its findings cannot be sized and three
// cannot be designed until production answers the questions below — which engine
// actually runs (F-18), how many stored runs carry the fabricated 1.0 baseline and
// the censored TTR sentinel (F-03/F-04/F-05), whether `holding_cost_pct` is a
// fraction everywhere (F-21), whether any upload ever landed (F-01), and whether
// `node_list.echelon` is in production (F-09). Every probe is every-project (D42)
// and each is a `tryQ`, so a column the audit guessed wrong reports as a failure
// line rather than killing the run.
//
// ONE PROBE IS NOT SQL. F-16 turns on whether an UNDEPLOYED function is absent or
// a stale build is live, and SQL cannot see edge functions. The Management API's
// `GET /v1/projects/{ref}/functions` can, with the token this script already holds.
// It is a GET — read-only by the verb, as `assertReadOnly` makes the SQL read-only
// by the keyword — and `apiGet` refuses to be anything else.
async function apiGet(path) {
  queryCount += 1;
  const res = await fetch(`${API}/${ref}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  try {
    return { rows: JSON.parse(text) };
  } catch {
    return { error: `non-JSON response: ${text.slice(0, 200)}` };
  }
}

async function userAuditShape() {
  section("Audit 2026-09-22 · WP 1 — the shape, before anything moves (F-01…F-37)");

  // Q5 — F-18: which engine ran. `worker-legacy` is the frozen engine.
  out("**Q5 · F-18 — which engine produced the stored runs** (every status):");
  report("Q5", await tryQ(`
    select coalesce(nullif(code_version, ''), '(blank)') as code_version, status,
           count(*)::int as runs,
           count(*) filter (where rep_count_done > 0)::int as claiming_reps,
           min(created_at)::date as first_seen, max(created_at)::date as last_seen
      from public.simulation_runs
     group by 1, 2 order by runs desc`), (r) => out(...table(r)));

  // Q6 — F-18: rep_count_done with no evidence rows behind it.
  out("", "**Q6 · F-18 — `rep_count_done` against the replication rows that exist:**");
  report("Q6", await tryQ(`
    with per as (
      select r.id, coalesce(nullif(r.code_version, ''), '(blank)') as code_version,
             r.status, r.rep_count_done, count(rr.id)::int as persisted
        from public.simulation_runs r
        left join public.run_replications rr on rr.run_id = r.id
       group by r.id)
    select code_version, status, count(*)::int as runs,
           count(*) filter (where persisted <> rep_count_done)::int as count_disagrees,
           count(*) filter (where persisted = 0 and rep_count_done > 0)::int as claims_over_empty,
           sum(rep_count_done)::int as claimed, sum(persisted)::int as persisted
      from per group by 1, 2 order by runs desc`), (r) => out(...table(r)));

  // Q2 — F-04: the fabricated 1.0 baseline.
  out("", "**Q2 · F-04 — replications whose `pre_disruption_fill_rate` is exactly 1.0**",
      "(the substituted value when `pre` is empty; a genuine perfect pre-window is also",
      "1.0, so Q1 below is what separates the two):");
  report("Q2", await tryQ(`
    select count(distinct rr.run_id)::int as runs_with_baseline,
           count(*)::int as reps_with_baseline,
           count(*) filter (where (rr.kpis->>'pre_disruption_fill_rate')::numeric = 1)::int as reps_at_exactly_1,
           count(distinct rr.run_id) filter (where (rr.kpis->>'pre_disruption_fill_rate')::numeric = 1)::int as runs_touched
      from public.run_replications rr
     where rr.kpis ? 'pre_disruption_fill_rate'
       and jsonb_typeof(rr.kpis->'pre_disruption_fill_rate') = 'number'`), (r) => out(...table(r)));

  // Q3 — F-05: TTR/TTS censored at the window.
  out("", "**Q3 · F-05 — TTR/TTS values, and how many sit at the censoring sentinel**",
      "(the engine window is 52 weeks, so a value ≥ 52 is \"never recovered\"):");
  report("Q3", await tryQ(`
    select count(distinct rr.run_id)::int as runs,
           count(*)::int as reps,
           count(*) filter (where (rr.kpis->>'ttr_weeks')::numeric >= 52)::int as ttr_at_window,
           count(*) filter (where (rr.kpis->>'tts_weeks')::numeric >= 52)::int as tts_at_window,
           count(*) filter (where (rr.kpis->>'ttr_weeks')::numeric = 0)::int as ttr_zero,
           round(avg((rr.kpis->>'ttr_weeks')::numeric), 2) as mean_ttr,
           max((rr.kpis->>'ttr_weeks')::numeric) as max_ttr
      from public.run_replications rr
     where rr.kpis ? 'ttr_weeks' and jsonb_typeof(rr.kpis->'ttr_weeks') = 'number'`), (r) => out(...table(r)));

  // Q1 — F-03: disruptions that start inside the warm-up. The audit named
  // `sim_scenarios`; the table is `scenarios` (the export reads `.from("scenarios")`).
  // `project_map` maps start_day → max(1, round(d/7)); both the RUN's detected
  // warm-up and the SCENARIO's authored one are compared, because a scenario that
  // never ran is where the next user meets the default.
  out("", "**Q1 · F-03 — scheduled disruptions whose mapped start week is inside the warm-up:**");
  report("Q1 runs", await tryQ(`
    select count(distinct r.id)::int as done_runs_with_disruptions,
           count(*)::int as disruptions,
           count(*) filter (where greatest(1, round((d->>'start_day')::numeric / 7.0)) <= r.warmup_detected_at)::int as start_in_detected_warmup,
           count(distinct r.id) filter (where greatest(1, round((d->>'start_day')::numeric / 7.0)) <= r.warmup_detected_at)::int as runs_affected,
           min(r.warmup_detected_at) as min_t_w, max(r.warmup_detected_at) as max_t_w,
           round(avg(r.warmup_detected_at), 1) as mean_t_w
      from public.simulation_runs r
      join public.scenarios s on s.id = r.scenario_id
     cross join lateral jsonb_array_elements(
       case when jsonb_typeof(s.disruption_schedule) = 'array' then s.disruption_schedule else '[]'::jsonb end) d
     where r.status = 'done' and r.warmup_detected_at is not null
       and (d->>'start_day') ~ '^[0-9.]+$'`), (r) => out(...table(r)));
  report("Q1 scenarios", await tryQ(`
    select count(distinct s.id)::int as scenarios_with_disruptions,
           count(*)::int as disruptions,
           count(*) filter (where (d->>'start_day')::numeric = 10 and (d->>'duration_days')::numeric = 5)::int as still_the_default,
           count(*) filter (where (d->>'start_day')::numeric <= coalesce(s.warmup_days, 0))::int as start_inside_authored_warmup,
           count(*) filter (where (d->>'duration_days')::numeric < 7)::int as shorter_than_one_tick
      from public.scenarios s
     cross join lateral jsonb_array_elements(
       case when jsonb_typeof(s.disruption_schedule) = 'array' then s.disruption_schedule else '[]'::jsonb end) d
     where (d->>'start_day') ~ '^[0-9.]+$'`), (r) => out(...table(r)));

  // Q4 — F-06/F-07/F-30: cancelled-then-done, stuck, and partial results on failure.
  out("", "**Q4 · F-06/F-07/F-30 — run states that should not exist:**");
  report("Q4", await tryQ(`
    select count(*) filter (where status = 'running' and coalesce(started_at, created_at) < now() - interval '2 hours')::int as running_over_2h,
           count(*) filter (where status = 'queued' and created_at < now() - interval '2 hours')::int as queued_over_2h,
           count(*) filter (where status in ('failed','cancelled') and rep_count_done > 0)::int as failed_or_cancelled_with_reps,
           count(*) filter (where status = 'cancelled')::int as cancelled,
           count(*) filter (where status = 'done' and error_message ilike '%cancel%')::int as done_mentioning_cancel,
           count(*)::int as total
      from public.simulation_runs`), (r) => out(...table(r)));

  // Q7 — F-19(a): how often the gate failed open.
  out("", "**Q7 · F-19(a) — runs dispatched with the gate skipped:**");
  report("Q7", await tryQ(`
    select count(*)::int as runs, count(*) filter (where gate_skipped)::int as gate_skipped_runs,
           count(distinct project_id) filter (where gate_skipped)::int as projects
      from public.simulation_runs`), (r) => out(...table(r)));

  // Q8 — F-19(b): the 50 000-row gate ceiling. Reported as the LARGEST project per
  // table rather than only those over, so a zero is a margin and not a silence.
  out("", "**Q8 · F-19(b) — the largest project per gate table against the 50 000-row ceiling:**");
  report("Q8", await tryQ(`
    select t, max(n)::int as largest_project_rows, count(*) filter (where n >= 50000)::int as projects_over
      from (
        select 'inbound_logistics' as t, count(*) as n from public.inbound_logistics group by project_id
        union all select 'outbound_logistics', count(*) from public.outbound_logistics group by project_id
        union all select 'bom_multi_level', count(*) from public.bom_multi_level group by project_id
        union all select 'bom_single_level', count(*) from public.bom_single_level group by project_id
        union all select 'materials', count(*) from public.materials group by project_id
      ) x group by t order by t`), (r) => out(...table(r)));

  // Q9/Q10 — F-09: has `echelon` landed, and what does it say?
  out("", "**Q9/Q10 · F-09 — `node_list.echelon` in production, beside the legacy `node_type`:**");
  report("Q10", await tryQ(`
    select coalesce(echelon, '(null)') as echelon, coalesce(node_type, '(null)') as node_type,
           count(*)::int as nodes, count(distinct project_id)::int as projects
      from public.node_list group by 1, 2 order by nodes desc`), (r) => out(...table(r)));
  report("Q9", await tryQ(`
    select data_source, count(*)::int as edges,
           count(*) filter (where bom_depth is null)::int as bom_depth_null,
           count(*) filter (where level is distinct from bom_depth)::int as level_ne_depth,
           count(distinct level)::int as distinct_levels, min(level) as min_level, max(level) as max_level
      from public.supply_chain_data_multi_tier group by 1 order by 1`), (r) => out(...table(r)));

  // Q11 — open question 4 / F-21: is holding_cost_pct a fraction everywhere?
  out("", "**Q11 · F-21 — `materials.holding_cost_pct`: fraction or percent?** (`project_map` multiplies by 100 and clamps to [5, 50])");
  report("Q11", await tryQ(`
    select count(*)::int as rows_set, count(distinct project_id)::int as projects,
           count(*) filter (where holding_cost_pct > 1)::int as looks_like_a_percent,
           count(*) filter (where holding_cost_pct > 0 and holding_cost_pct < 0.05)::int as below_clamp_floor,
           count(*) filter (where holding_cost_pct > 0.5 and holding_cost_pct <= 1)::int as above_clamp_ceiling,
           min(holding_cost_pct) as min, max(holding_cost_pct) as max
      from public.materials where holding_cost_pct is not null`), (r) => out(...table(r)));

  // Q12 — open question 9: runs with no hash of their own.
  out("", "**Q12 · F-11 — runs that carry no binding of their own:**");
  report("Q12", await tryQ(`
    select count(*) filter (where graph_hash is null)::int as runs_without_hash,
           count(*) filter (where dataset_version_id is null)::int as runs_without_dsv,
           count(*)::int as total
      from public.simulation_runs where status = 'done'`), (r) => out(...table(r)));

  // Q14 — F-01: did anything ever land through ingest_runs, by any source?
  out("", "**Q14 · F-01 — every `ingest_runs` row by source, ever:**");
  report("Q14", await tryQ(`
    select source_kind, count(*)::int as runs, min(created_at)::date as first, max(created_at)::date as last
      from public.ingest_runs group by 1 order by runs desc`), (r) => out(...table(r)));

  // Q15 — F-15: project-scoped rows whose project is gone.
  out("", "**Q15 · F-15 — rows whose project no longer exists** (every table with a `project_id` column):");
  const tabs = await tryQ(`
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'project_id' and t.table_type = 'BASE TABLE'
     order by 1`);
  if (tabs.error) {
    out(`- **Q15** — QUERY FAILED: \`${tabs.error.slice(0, 200)}\``);
  } else {
    const names = tabs.rows.map((r) => r.table_name).filter((n) => /^[a-z0-9_]+$/.test(n));
    const union = names.map((n) =>
      `select '${n}' as t, count(*)::int as orphans from public.${n} x
        where x.project_id is not null
          and not exists (select 1 from public.projects p where p.id::text = x.project_id::text)`).join("\nunion all ");
    report("Q15", await tryQ(`select * from (${union}) o where orphans > 0 order by orphans desc`), (r) => {
      out(...table(r));
      out(`- ${names.length} table(s) swept; ${r.length} hold orphaned rows.`);
    });
  }

  // F-16 / open question 1: which edge functions production actually serves.
  out("", "**F-16 · open question 1 — edge functions deployed in production** (Management API, GET):");
  const fns = await apiGet("/functions");
  report("functions", fns, (r) => {
    const rows = (Array.isArray(r) ? r : []).map((f) => ({
      slug: f.slug, version: f.version, status: f.status, verify_jwt: f.verify_jwt,
      updated_at: f.updated_at ? new Date(f.updated_at).toISOString().slice(0, 10) : "",
    })).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
    out(...table(rows));
    let deferred = [];
    try {
      const cov = readFileSync(new URL("./coverage.yaml", import.meta.url), "utf8");
      const block = cov.split(/^functions_not_deployed:/m)[1] ?? "";
      deferred = [...block.matchAll(/^\s+- fn:\s*(\S+)/gm)].map((m) => m[1]);
    } catch { /* the register is optional to this read */ }
    const live = new Set(rows.map((x) => x.slug));
    for (const fn of deferred) {
      out(`- \`${fn}\` (registered as not deployed): ${live.has(fn) ? "**A BUILD IS LIVE** — the register is wrong about the product" : "absent"}`);
    }
  });
}

// ── WP 6.5 (a) — THE LANDING SWITCH, measured either side of it ────────────
//
// Publishing `ingest-file` (§4 D123) switches every CSV upload in production onto
// the WP 3.2–3.4 landing path at once, and PLAN.md's 6.5a sequence asks for a read
// BEFORE and a read AFTER, over every project (D42). This section is both: the same
// probes, run once before the merge that publishes the function and once in a push
// AFTER it (never on the merge commit itself — D153).
//
// Four questions, each of which a rehearsal cannot answer:
//
//   (1) THE PRECONDITION (D156), positively. 0.9 above asks "which keys still point
//       at `auth.users`" and passes when `ingest_runs` is absent from the answer. That
//       is necessary and not sufficient: a migration that DROPPED the keys without
//       re-adding them would pass it too. So this reads the actor columns' keys by
//       TARGET, and fails the run unless both `ingest_runs` actor columns and
//       `ingest_files.uploaded_by` key to `approved_users`.
//   (2) THE BUCKET. `ingest-file` writes the bytes to storage bucket `ingest` BEFORE it
//       opens a run. The migration that creates it (`20260916000014`) is guarded on
//       `to_regclass('storage.buckets')`, so a database with no storage schema skips it
//       silently — and every rehearsal database is one. Only production can say.
//   (3) THE BASELINE, per project and per landable table: rows, rows carrying
//       `ingest_run_id`, rows carrying `source_row_id`; and `ingest_runs`,
//       `ingest_files`, `ingest_staged_rows` per project. The after-read is compared
//       against this, and "no table lost rows" is a claim about THIS table.
//   (4) THE EXIT, once there is anything to read: a tier-2 row whose `source_row_id`
//       resolves through `ingest_value_chain` — called as the function, with the run's
//       own promoter as the reader, because the exit names that function and a join
//       that imitates it would prove the imitation.
const LANDABLE = [
  // The ten the contract describes (`INGEST_DATASETS`), which land through `ingest-file`.
  "inbound_logistics", "outbound_logistics", "bom_single_level", "bom_multi_level",
  "materials", "products", "suppliers", "customers", "tier2_suppliers", "tier3_suppliers",
];
// Uploaded through the wizard but NOT landed — `ingest-file` only PARSES them (mode
// `parse`) and the client promotes through the bulk RPCs (D56). Counted for the
// no-data-loss half only: publishing the function changes their parse path too.
const PARSED_ONLY = ["multi_tier_supply_chain", "node_list", "network_nodes", "network_edges"];

async function wp65aLandingSwitch() {
  section("WP 6.5 (a) — the landing switch: precondition, bucket, baseline, exit");

  // (1) The actor keys, by target.
  const keys = await tryQ(`
    select rel.relname as table_name,
           (select string_agg(att.attname, ', ' order by att.attnum)
              from unnest(con.conkey) k
              join pg_attribute att on att.attrelid = rel.oid and att.attnum = k) as columns,
           con.conname as constraint_name,
           fns.nspname || '.' || fre.relname as references_table,
           case con.confdeltype when 'n' then 'SET NULL' when 'c' then 'CASCADE'
                                when 'r' then 'RESTRICT' when 'a' then 'NO ACTION'
                                else con.confdeltype::text end as on_delete
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_class fre on fre.oid = con.confrelid
      join pg_namespace fns on fns.oid = fre.relnamespace
     where con.contype = 'f' and ns.nspname = 'public'
       and rel.relname in ('ingest_runs', 'ingest_files')
       and fre.relname in ('users', 'approved_users')
     order by 1, 2`);
  report("(1) D156 — the landing's actor keys, by target", keys, (rows) => {
    out("**(1) D156 — which table each landing actor column keys to:**");
    out(...table(rows));
    const want = [
      ["ingest_runs", "triggered_by_user_id"],
      ["ingest_runs", "applied_by_user_id"],
      ["ingest_files", "uploaded_by"],
    ];
    const bad = [];
    for (const [t, c] of want) {
      const hit = rows.filter((r) => r.table_name === t && r.columns === c);
      if (!hit.length || hit.some((r) => r.references_table !== "public.approved_users")) {
        bad.push(`${t}.${c} → ${hit.map((r) => r.references_table).join(", ") || "(no key)"}`);
      }
    }
    if (bad.length) {
      out(`- **NOT MET**: ${bad.join("; ")}. Publishing \`ingest-file\` over this makes every landing by a real user abort (D156).`);
      gateFailures.push(
        `WP 6.5 (a)'s precondition (PLAN.md §4 D156) is not met: ${bad.join("; ")}. ` +
          "Every landing actor column must key to `public.approved_users`, because that is " +
          "the table this application authenticates against and `auth.users` holds none of them.",
      );
    } else {
      out("- **MET.** All three actor columns key to `public.approved_users`, none to `auth.users`, so a real uploader satisfies the landing's non-NULL actor AND its foreign key.");
    }
  });

  // (2) The bucket, and what it holds.
  const bucket = await tryQ(`
    select b.id, b.public,
           (select count(*)::int from storage.objects o where o.bucket_id = b.id) as objects
      from storage.buckets b where b.id = 'ingest'`);
  report("(2) storage bucket `ingest`", bucket, (rows) => {
    out("", "**(2) the storage bucket `ingest-file` writes to:**");
    out(...table(rows));
    if (!rows.length) {
      out("- **ABSENT.** `ingest-file` uploads the bytes before it opens a run, so every landing would fail at stage `store`.");
      gateFailures.push(
        "Storage bucket `ingest` does not exist in production. `ingest-file` stores the " +
          "bytes before it opens a run, so every CSV landing would fail at stage `store` " +
          "(WP 6.5 (a); the bucket is created by `20260916000014`, guarded on `storage.buckets`).",
      );
    } else if (rows[0].public === true || rows[0].public === "true") {
      out("- **The bucket is PUBLIC.** A tier-0 artifact is reached through its manifest row or not at all; a public bucket serves raw uploads to anyone with the path.");
      gateFailures.push("Storage bucket `ingest` is public; tier-0 uploads must not be world-readable (`20260916000014`).");
    } else {
      out("- Present and private.");
    }
  });

  // (3) The baseline, per project. One statement per table so a missing column in one
  // table reports as that table's failure rather than blanking the section.
  out("", "**(3) the baseline — every project, every landable table** (`rows / with ingest_run_id / with source_row_id`):");
  const all = [];
  for (const t of LANDABLE) {
    const res = await tryQ(`
      select '${t}'::text as tbl, x.project_id::text as project_id, count(*)::int as rows,
             count(x.ingest_run_id)::int as with_run, count(x.source_row_id)::int as with_row
        from public.${t} x group by x.project_id`);
    if (res.error) out(`- \`${t}\` — QUERY FAILED: \`${res.error.slice(0, 200)}\``);
    else all.push(...res.rows);
  }
  for (const t of PARSED_ONLY) {
    const res = await tryQ(`
      select '${t}'::text as tbl, x.project_id::text as project_id, count(*)::int as rows,
             null::int as with_run, null::int as with_row
        from public.${t} x group by x.project_id`);
    if (res.error) out(`- \`${t}\` — QUERY FAILED: \`${res.error.slice(0, 200)}\``);
    else all.push(...res.rows);
  }
  const projects = await tryQ(`select id::text as id, name from public.projects order by created_at`);
  const pname = new Map((projects.rows ?? []).map((p) => [p.id, p.name]));
  all.sort((a, b) => String(a.tbl).localeCompare(String(b.tbl)) ||
                     String(pname.get(a.project_id) ?? a.project_id).localeCompare(String(pname.get(b.project_id) ?? b.project_id)));
  out(...table(all.map((r) => ({
    tbl: r.tbl,
    project: `${pname.get(r.project_id) ?? "(no project row)"} · ${String(r.project_id).slice(0, 8)}`,
    rows: r.rows, with_run: r.with_run ?? "—", with_row: r.with_row ?? "—",
  }))));
  const totals = {};
  for (const r of all) {
    totals[r.tbl] ??= { tbl: r.tbl, projects: 0, rows: 0, with_run: 0, with_row: 0 };
    totals[r.tbl].projects += 1;
    totals[r.tbl].rows += Number(r.rows);
    totals[r.tbl].with_run += Number(r.with_run ?? 0);
    totals[r.tbl].with_row += Number(r.with_row ?? 0);
  }
  out("", "Totals (the line the after-read is compared against — a table whose `rows` falls lost data):");
  out(...table([...LANDABLE, ...PARSED_ONLY].map((t) => totals[t] ?? { tbl: t, projects: 0, rows: 0, with_run: 0, with_row: 0 })));

  const ingest = await tryQ(`
    select p.id::text as project_id, p.name as project,
           (select count(*)::int from public.ingest_runs r where r.project_id = p.id) as ingest_runs,
           (select count(*)::int from public.ingest_runs r where r.project_id = p.id and r.source_kind = 'csv') as csv_runs,
           (select count(*)::int from public.ingest_runs r where r.project_id = p.id and r.status = 'applied') as applied_runs,
           (select count(*)::int from public.ingest_files f join public.ingest_runs r on r.id = f.ingest_run_id
             where r.project_id = p.id) as ingest_files,
           (select count(*)::int from public.ingest_staged_rows s join public.ingest_runs r on r.id = s.ingest_run_id
             where r.project_id = p.id) as ingest_staged_rows
      from public.projects p order by p.created_at`);
  report("(3) ingestion tables per project", ingest, (rows) => {
    out("", "**(3) the ingestion tables, per project:**");
    out(...table(rows.map((r) => ({ ...r, project_id: String(r.project_id).slice(0, 8) }))));
    const any = rows.filter((r) => Number(r.ingest_files) > 0 && Number(r.ingest_staged_rows) > 0);
    out(any.length
      ? `- **${any.length} project(s)** hold both a landed file and staged rows — the first half of WP 6.5 (a)'s exit.`
      : "- **No project holds a landed file and staged rows.** Before the switch that is expected; after it, it means no upload reached the landing.");
  });
  const unowned = await tryQ(`
    select (select count(*)::int from public.ingest_runs) as ingest_runs_total,
           (select count(*)::int from public.ingest_files) as ingest_files_total,
           (select count(*)::int from public.ingest_staged_rows) as ingest_staged_rows_total,
           (select count(*)::int from public.audit_logs where action = 'ingest_file_landed') as landing_audit_rows`);
  report("(3) ingestion totals", unowned, (rows) => out(...table(rows)));

  // (4) The exit: a tier-2 row that resolves through `ingest_value_chain`.
  const union = LANDABLE.map((t) => `
      select '${t}'::text as tbl, x.source_row_id
        from public.${t} x where x.source_row_id is not null`).join("\n      union all ");
  const chain = await tryQ(`
    with traced as (${union}),
         pick as (
           select distinct on (t.tbl) t.tbl, t.source_row_id,
                  coalesce(r.applied_by_user_id, r.triggered_by_user_id) as reader
             from traced t
             join public.ingest_staged_rows s on s.id = t.source_row_id
             join public.ingest_runs r on r.id = s.ingest_run_id
            order by t.tbl, r.applied_at desc nulls last)
    select p.tbl, (select count(*)::int from traced tr where tr.tbl = p.tbl) as traced_rows,
           vc.has_provenance, vc.source_kind, vc.original_filename, vc.source_row_number,
           vc.uploaded_by_name, vc.promoted_at::text as promoted_at, vc.run_status
      from pick p
      cross join lateral public.ingest_value_chain(p.reader, p.source_row_id) vc
     order by p.tbl`);
  report("(4) the exit — `ingest_value_chain`", chain, (rows) => {
    out("", "**(4) the exit — one tier-2 row per table, resolved through `ingest_value_chain`:**");
    out(...table(rows));
    const ok = rows.filter((r) => (r.has_provenance === true || r.has_provenance === "true") && r.original_filename);
    out(ok.length
      ? `- **MET for ${ok.length} table(s)**: a tier-2 row names its source file and line through the function the review screen calls.`
      : "- **Not met.** No tier-2 row carries a `source_row_id` that resolves — expected before the switch, the whole exit after it.");
  });

  // (4b) EVERY APPLIED RUN, AND WHERE ITS ROWS WENT. (4) proves one row per table;
  // this proves the other direction — that a run the database calls `applied` left
  // rows in the table it names. Added after the first after-read showed a run with
  // 271 staged rows, status `applied`, whose project holds no tier-2 row at all.
  const perTarget = LANDABLE.map((t) => `
      select '${t}'::text as tbl, x.source_row_id from public.${t} x where x.source_row_id is not null`)
    .join("\n      union all ");
  const landed = await tryQ(`
    with traced as (${perTarget})
    select r.id::text as run, p.name as project, s.target_table,
           r.status, r.applied_at::text as applied_at,
           count(*)::int as staged,
           count(*) filter (where exists (select 1 from traced t where t.source_row_id = s.id))::int as in_tier2,
           count(*) filter (where s.findings @> '[{"level": "error"}]'::jsonb)::int as held
      from public.ingest_runs r
      join public.ingest_staged_rows s on s.ingest_run_id = r.id
      left join public.projects p on p.id = r.project_id
     where r.status = 'applied'
     group by 1, 2, 3, 4, 5
     order by 5`);
  report("(4b) applied runs — where their rows are", landed, (rows) => {
    out("", "**(4b) every applied run, and how many of its staged rows a tier-2 row still names:**");
    out(...table(rows.map((r) => ({ ...r, run: String(r.run).slice(0, 8) }))));
    const lost = rows.filter((r) => Number(r.in_tier2) + Number(r.held) < Number(r.staged));
    out(lost.length
      ? `- **${lost.length} applied run(s) name fewer tier-2 rows than they staged** — either the rows were removed after the promotion, or the promotion wrote them without \`source_row_id\`. Read the run before reading this as a loss.`
      : "- Every applied run's staged rows are either held or named by a tier-2 row.");
  });

  // (4c) THE WRITES THEMSELVES, from the data-plane audit (one row per statement, D45):
  // every insert/update/delete on a landable table since `ingest-file` went live. When
  // (4b) shows an applied run whose rows no tier-2 row names, this says whether they
  // were never written or written and then deleted — and by whom.
  const writes = await tryQ(`
    select a.created_at::text as at, a.target_type as tbl, a.action,
           (a.after->>'rows_after')::int as rows_after, (a.after->>'rows_before')::int as rows_before,
           coalesce(u.email, a.actor_user_id::text, '(unknown)') as actor
      from public.audit_logs a
      left join public.approved_users u on u.id = a.actor_user_id
     where a.plane = 'data'
       and a.created_at >= '2026-09-22 20:46:29+00'
       and a.target_type in (${LANDABLE.map((t) => `'${t}'`).join(", ")})
     order by a.created_at
     limit 60`);
  report("(4c) writes to landable tables since the switch", writes, (rows) => {
    out("", "**(4c) every statement that wrote a landable table since `ingest-file` went live** (`audit_logs`, plane `data`):");
    out(...table(rows));
  });

  // Whether production SERVES `ingest-file`, which SQL cannot see (D123, D168).
  const fns = await apiGet("/functions");
  report("(5) is `ingest-file` published?", fns, (r) => {
    const f = (Array.isArray(r) ? r : []).find((x) => x.slug === "ingest-file");
    out("", "**(5) is `ingest-file` published?** (Management API, GET):");
    out(f
      ? `- **LIVE** — version ${f.version}, status ${f.status}, verify_jwt ${f.verify_jwt}, updated ${f.updated_at ? new Date(f.updated_at).toISOString() : "?"}.`
      : "- **ABSENT.** The upload wizard calls it on file-select with no fallback, so every upload on /project-manager fails there (D123, D168).");
  });

  // (6) WHAT THE FUNCTION ITSELF SAID — its invocations and its console, from the
  // Management API's log endpoint (a GET, read-only by the verb, like F-16's).
  //
  // Added after the first production upload failed in the browser with "Failed to
  // send a request to the Edge Function" on `mode=land`, while `mode=parse` on the
  // same file had succeeded. That message is supabase-js's FETCH error: the request
  // never produced a response the browser could read — typically a gateway answer
  // with no CORS headers (a worker that crashed, hit a resource limit or timed out).
  // Nothing in the database can show that, and no session can reach the function
  // (the egress proxy denies it), so the function's own logs are the only witness.
  const list = Array.isArray(fns.rows) ? fns.rows : [];
  const fn = list.find((x) => x.slug === "ingest-file");
  if (!fn?.id) return;
  // (7) is below; it reuses this window and the `logs` helper for `delete-project`.
  const end = new Date();
  const start = new Date(end.getTime() - 23 * 3600 * 1000);
  const logs = async (sql) => {
    const qs = new URLSearchParams({
      iso_timestamp_start: start.toISOString(),
      iso_timestamp_end: end.toISOString(),
      sql,
    });
    const res = await apiGet(`/analytics/endpoints/logs.all?${qs}`);
    if (res.error) return res;
    const body = res.rows ?? {};
    if (body.error) return { error: JSON.stringify(body.error).slice(0, 300) };
    return { rows: Array.isArray(body.result) ? body.result : [] };
  };
  const fid = String(fn.id).replace(/[^A-Za-z0-9-]/g, "");
  const edge = await logs(`
    select cast(t.timestamp as string) as ts, request.method as method, response.status_code as status,
           m.execution_time_ms as ms, request.url as url
      from function_edge_logs t
      cross join unnest(t.metadata) as m
      cross join unnest(m.response) as response
      cross join unnest(m.request) as request
     where m.function_id = '${fid}'
     order by t.timestamp desc limit 40`);
  report("(6) `ingest-file` invocations", edge, (rows) => {
    out("", "**(6) `ingest-file` — every invocation in the last 23 h** (`function_edge_logs`, newest first):");
    out(...table(rows.map((r) => ({ ...r, url: String(r.url ?? "").replace(/\?.*$/, "") }))));
  });
  const con = await logs(`
    select cast(t.timestamp as string) as ts, m.level as level, m.event_type as event, t.event_message as message
      from function_logs t
      cross join unnest(t.metadata) as m
     where m.function_id = '${fid}'
     order by t.timestamp desc limit 60`);
  report("(6) `ingest-file` console", con, (rows) => {
    out("", "**(6) `ingest-file` — its console and runtime events** (`function_logs`, newest first):");
    out(...table(rows.map((r) => ({ ...r, message: String(r.message ?? "").replace(/\s+/g, " ").slice(0, 400) }))));
  });

  // (7) `delete-project` — WHY A PROJECT DID NOT GO AWAY. The after-read found project
  // `dsds` with its `bom_single_level` rows deleted in 200-row batches with no actor and
  // the project row itself still present, so the live function (the 2026-03-17 build,
  // §4 D168) stopped part-way. Its own console says where; errors first.
  const del = list.find((x) => x.slug === "delete-project");
  if (del?.id) {
    const did = String(del.id).replace(/[^A-Za-z0-9-]/g, "");
    const dedge = await logs(`
      select cast(t.timestamp as string) as ts, request.method as method, response.status_code as status,
             m.execution_time_ms as ms
        from function_edge_logs t
        cross join unnest(t.metadata) as m
        cross join unnest(m.response) as response
        cross join unnest(m.request) as request
       where m.function_id = '${did}'
       order by t.timestamp desc limit 20`);
    report("(7) `delete-project` invocations", dedge, (rows) => {
      out("", `**(7) \`delete-project\` (version ${del.version}, updated ${del.updated_at ? new Date(del.updated_at).toISOString().slice(0, 10) : "?"}) — invocations, last 23 h:**`);
      out(...table(rows));
    });
    const dcon = await logs(`
      select cast(t.timestamp as string) as ts, m.level as level, m.event_type as event, t.event_message as message
        from function_logs t
        cross join unnest(t.metadata) as m
       where m.function_id = '${did}'
       order by t.timestamp desc limit 80`);
    report("(7) `delete-project` console", dcon, (rows) => {
      out("", "**(7) `delete-project` — its console (newest first):**");
      out(...table(rows.map((r) => ({ ...r, message: String(r.message ?? "").replace(/\s+/g, " ").slice(0, 300) }))));
    });
  }
}

// (8) §4 D170 — THE DELETION STILL FAILS IN THE BROWSER, AFTER THE FIX SHIPPED.
// "Failed to send a request to the Edge Function" is supabase-js's FETCH error: no
// response the browser could read. The fixed function answers every refusal with a
// CORS-bearing JSON, so that message means the worker did not answer at all — it
// ran past a limit, crashed, or the database call never returned. (7) now shows every
// runtime event, not only `Log`; this reads the three things only production knows:
// the triggers that fire under `delete_project`'s deletes, the time budget the
// service role runs under, and what Postgres itself logged about the call.
async function d170DeleteStillFails() {
  out("", "## (8) §4 D170 — why a deletion still fails after the fix shipped", "");
  const T = ["disruption_scenarios", "simulation_results", "network_edges", "network_nodes",
    "inbound_logistics", "outbound_logistics", "bom_single_level", "bom_multi_level",
    "multi_tier_supply_chain", "supply_chain_data", "supply_chain_data_multi_tier", "node_list", "projects"];
  const trg = await tryQ(`
    select c.relname as tbl, t.tgname as trigger,
           case when t.tgtype & 1 = 1 then 'row' else 'statement' end as level,
           case when t.tgtype & 2 = 2 then 'before' when t.tgtype & 64 = 64 then 'instead' else 'after' end as timing,
           concat_ws('/', case when t.tgtype & 4 = 4 then 'ins' end, case when t.tgtype & 8 = 8 then 'del' end,
                          case when t.tgtype & 16 = 16 then 'upd' end, case when t.tgtype & 32 = 32 then 'trunc' end) as events,
           p.proname as fn, t.tgenabled as enabled
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal
       and c.relname in (${T.map((t) => `'${t}'`).join(", ")})
       and t.tgtype & 8 = 8
     order by 1, 2`);
  report("(8a) delete triggers under delete_project", trg, (rows) => {
    out("", "**(8a) every trigger that fires on a DELETE of a table `delete_project` empties:**");
    out(...table(rows));
  });
  const fk = await tryQ(`
    select cl.relname as child, pc.relname as parent, c.confdeltype as on_delete,
           exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]) as child_indexed
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_class pc on pc.oid = c.confrelid
     where c.contype = 'f'
       and pc.relname in (${T.map((t) => `'${t}'`).join(", ")})
     order by 2, 1`);
  report("(8b) foreign keys into those tables", fk, (rows) => {
    out("", "**(8b) foreign keys pointing INTO them** (`on_delete`: a=no action, r=restrict, c=cascade, n=set null; an unindexed child makes every parent delete a scan):");
    out(...table(rows));
  });
  const budget = await tryQ(`
    select r.rolname as role, s.setconfig::text as settings
      from pg_roles r
      left join pg_db_role_setting s on s.setrole = r.oid
     where r.rolname in ('service_role', 'authenticator', 'anon', 'authenticated', 'postgres')
     order by 1`);
  report("(8c) role time budgets", budget, (rows) => {
    out("", "**(8c) the time budget each role runs under** (`statement_timeout` in `settings`):");
    out(...table(rows));
  });
  const sizes = await tryQ(`
    select p.name, p.id::text as id, p.updated_at::text as updated,
           (select count(*) from public.network_nodes x where x.project_id = p.id) as nn,
           (select count(*) from public.network_edges x where x.project_id = p.id) as ne,
           (select count(*) from public.supply_chain_data x where x.project_id = p.id) as scd,
           (select count(*) from public.supply_chain_data_multi_tier x where x.project_id = p.id) as scdmt,
           (select count(*) from public.node_list x where x.project_id = p.id) as nl,
           (select count(*) from public.bom_single_level x where x.project_id = p.id) as bsl,
           (select count(*) from public.simulation_results x where x.project_id = p.id) as sr
      from public.projects p
     order by p.name`);
  report("(8d) every project and its size", sizes, (rows) => {
    out("", "**(8d) every project still present, with the rows a deletion must remove:**");
    out(...table(rows));
  });
  const aud = await tryQ(`
    select a.created_at::text as at, a.target_type as tbl, a.action,
           coalesce(u.email, a.actor_user_id::text, '(unknown)') as actor
      from public.audit_logs a
      left join public.approved_users u on u.id = a.actor_user_id
     where a.created_at >= '2026-09-22 22:47:00+00'
       and (a.action ilike '%delete%' or a.target_type = 'projects')
     order by a.created_at desc
     limit 40`);
  report("(8e) deletions audited since the fix deployed", aud, (rows) => {
    out("", "**(8e) every delete the audit recorded since `delete-project` was republished (22:47Z):**");
    out(...table(rows));
  });
  // Postgres's own log: a statement cancelled, a lock wait, an error raised inside the call.
  const end = new Date();
  const start = new Date(end.getTime() - 23 * 3600 * 1000);
  const qs = new URLSearchParams({
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
    sql: `select cast(t.timestamp as string) as ts, p.error_severity as severity, p.user_name as usr, t.event_message as message
            from postgres_logs t
            cross join unnest(t.metadata) as m
            cross join unnest(m.parsed) as p
           where t.timestamp > '2026-09-22T22:47:00Z'
             and (p.error_severity in ('ERROR', 'FATAL', 'PANIC')
                  or t.event_message ilike '%delete_project%'
                  or t.event_message ilike '%statement timeout%'
                  or t.event_message ilike '%canceling statement%')
           order by t.timestamp desc limit 60`,
  });
  const pl = await apiGet(`/analytics/endpoints/logs.all?${qs}`);
  const plRes = pl.error ? pl : (pl.rows?.error ? { error: JSON.stringify(pl.rows.error).slice(0, 300) } : { rows: Array.isArray(pl.rows?.result) ? pl.rows.result : [] });
  report("(8f) postgres log since the fix deployed", plRes, (rows) => {
    out("", "**(8f) Postgres's own log since 22:47Z — errors, cancellations, and anything naming `delete_project`:**");
    out(...table(rows.map((r) => ({ ...r, message: String(r.message ?? "").replace(/\s+/g, " ").slice(0, 300) }))));
  });
}

// ── Phase 10 · WP 10.2 + WP 10.1 — versions by content, the stored graph state ──
//
// Readings, not gates. Taken BEFORE the merge they measure production WITHOUT
// `20261001000006`/`…07` (the new columns and tables read as "QUERY FAILED", which
// is the expected shape, not a finding); taken in the push AFTER the merge (D153)
// they are the after-reading §16 owes. Every project, never one (D42).
async function phase10Versions() {
  section("Phase 10 · WP 10.1–10.8 — versions by content, the stored graph state, Validated Models, engines and RunKeys, D248, result tiers, capacity, the training set");

  report("(1) D241 — policy versions vs distinct contents, every project",
    await tryQ(`
      select count(*) as versions,
             count(distinct (project_id, policy_hash)) as distinct_contents,
             count(*) - count(distinct (project_id, policy_hash)) as same_content_duplicates,
             count(*) filter (where policy_hash is null) as no_hash
        from public.policy_versions`),
    (rows) => { out("**(1) D241 — policy versions vs the contents they hold:**"); out(...table(rows)); });

  report("(2) D242 — active cards sharing one content triple (the new unique index refuses >1)",
    await tryQ(`
      select count(*) as active_cards,
             count(distinct (project_id, policy_hash, graph_hash, scenario_hash)) as distinct_triples
        from public.model_validations where status = 'active'`),
    (rows) => { out("**(2) D242 — active model cards and the content triples they cover:**"); out(...table(rows)); });

  report("(3) WP 10.2 — policy_versions.version_no assigned",
    await tryQ(`
      select count(*) as versions, count(version_no) as numbered,
             count(distinct (project_id, version_no)) as distinct_numbers
        from public.policy_versions`),
    (rows) => { out("**(3) policy version numbers (after the merge):**"); out(...table(rows)); });

  report("(4) D234 — graph versions vs distinct contents, numbering and level hashes",
    await tryQ(`
      select count(*) as versions,
             count(distinct (project_id, graph_hash)) as distinct_contents,
             count(version_no) as numbered,
             count(hash_firm) as with_firm_level,
             count(hash_process) as with_process_level
        from public.dataset_versions`),
    (rows) => { out("**(4) graph versions (after the merge: every row numbered, levels where the snapshot supports them):**"); out(...table(rows)); });

  report("(5) D233 — project_graph_state rows, by dirtiness",
    await tryQ(`
      select count(*) as projects_with_state,
             count(*) filter (where dirty) as dirty,
             count(*) filter (where not dirty and graph_hash is not null) as stored_clean,
             (select count(*) from public.projects) as projects
        from public.project_graph_state`),
    (rows) => { out("**(5) the stored graph state:**"); out(...table(rows)); });

  report("(6) D235 — analysis runs by the level they keyed on",
    await tryQ(`
      select analysis_kind, input_scope, status, count(*) as runs,
             count(dataset_version_id) as with_graph_version
        from public.analysis_runs group by 1, 2, 3 order by 1, 2, 3`),
    (rows) => { out("**(6) analysis runs by kind and level:**"); out(...table(rows)); });

  report("(7) D243 — Validated Models: protocols, backfilled ones and their unknown keys",
    await tryQ(`
      select status,
             count(*) as models,
             count(protocol) as with_protocol,
             count(*) filter (where protocol ? 'backfilled') as backfilled,
             coalesce(sum(jsonb_array_length(protocol -> 'unknown')) filter (where protocol ? 'unknown'), 0)
               as unknown_keys_total,
             count(engine_id) as with_engine
        from public.model_validations group by 1 order by 1`),
    (rows) => { out("**(7) Validated Models (before the merge this errors: the columns deploy with it):**"); out(...table(rows)); });

  report("(8) D245 — the engine registry and what the worker reported",
    await tryQ(`select slug, status, version, code_version, reported_at from public.sim_engines order by slug`),
    (rows) => { out("**(8) `sim_engines` (after the merge, scsim should carry the worker's build):**"); out(...table(rows)); });

  report("(9) D245 — runs carrying the binding on the row",
    await tryQ(`
      select count(*) as runs,
             count(engine_id) as with_engine,
             count(run_key) as with_run_key,
             count(*) filter (where exploratory) as exploratory,
             count(*) filter (where protocol_overrides <> '{}'::jsonb) as with_overrides,
             count(*) filter (where created_at > now() - interval '7 days') as last_7_days
        from public.simulation_runs`),
    (rows) => { out("**(9) run rows and their bindings (history has no RunKey by design):**"); out(...table(rows)); });

  report("(10) D248 — internal SECURITY DEFINER helpers executable through the API (must be none after the merge)",
    await tryQ(`
      select p.oid::regprocedure::text as function,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef and p.proname like '\\_%'
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       order by 1`),
    (rows) => { out("**(10) D248 — `_`-prefixed SECURITY DEFINER functions the API roles can execute:**"); out(...table(rows)); });

  // WP 10.6–10.8. Before the merge each of these errors or reads empty — the
  // bucket, the columns, the tables and the view deploy with it (CLAUDE.md: a
  // branch's §15 reading measures production WITHOUT the branch). WP 10.9 reads
  // them in the push after the merge (D153).
  report("(11) D246 — the run-results bucket (must exist and be private)",
    await tryQ(`select id, public, file_size_limit from storage.buckets where id = 'run-results'`),
    (rows) => { out("**(11) the `run-results` bucket:**"); out(...table(rows)); });

  report("(12) D246 — the series sweep's schedule",
    await tryQ(`select jobname, schedule, active from cron.job where jobname = 'run-series-sweep'`),
    (rows) => { out("**(12) `cron.job` — the series sweep (no row and no error: pg_cron present, job missing):**"); out(...table(rows)); });

  report("(13) D246 — where runs keep their series, and for how long",
    await tryQ(`
      select retention,
             count(*) as runs,
             count(series_object) as in_parquet,
             count(series_expires_at) as with_expiry,
             count(series_expired_at) as expired,
             coalesce(sum(series_bytes) filter (where series_object is not null), 0) as parquet_bytes,
             coalesce(sum(series_bytes) filter (where series_object is null and series_expired_at is null), 0) as jsonb_bytes
        from public.simulation_runs where status = 'done' group by 1 order by 1`),
    (rows) => { out("**(13) completed runs by retention — Parquet objects against JSONB-era series:**"); out(...table(rows)); });

  report("(14) D247 — the organization plans' capacity columns",
    await tryQ(`
      select count(*) as organizations,
             count(compute_quota_rep_weeks_month) as with_compute_quota,
             count(storage_quota_bytes) as with_storage_quota,
             count(max_concurrent_runs) as with_concurrency_cap,
             count(*) filter (where series_retention_days = 90) as retention_90_days,
             count(*) filter (where series_retention_days is null) as retention_unlimited
        from public.organizations`),
    (rows) => { out("**(14) organization plans (after the merge every organization starts at 90 days):**"); out(...table(rows)); });

  report("(15) D247 — the role shares and the usage ledger",
    await tryQ(`
      select 'plan_role_allowances' as source, coalesce(org_id::text, 'default') as scope, project_role as kind,
             count(*) as rows, null::bigint as rep_weeks
        from public.plan_role_allowances group by 1, 2, 3
      union all
      select 'run_usage', 'all', kind, count(*), sum(rep_weeks) from public.run_usage group by 1, 2, 3
      order by 1, 2, 3`),
    (rows) => { out("**(15) role shares, and the ledger by kind (a post-merge run with no `dispatch` row skipped admission — D252):**"); out(...table(rows)); });

  report("(16) D249 — the surrogate training set, per project, and the feature kind",
    await tryQ(`
      select t.project_id::text as project_id,
             count(distinct t.validated_model_id) as models,
             count(distinct t.graph_version_id) as graph_versions,
             count(distinct t.run_id) as runs,
             count(*) as replications,
             (select count(*) from public.analysis_kinds where kind = 'feature_spec') as feature_kind_seeded
        from public.surrogate_training_runs t group by 1 order by 5 desc`),
    (rows) => { out("**(16) the training set (empty is a true reading until a Validated Model's runs complete after the merge):**"); out(...table(rows)); });
}

// ── Phase 15 · WP 15.7 — the engine ledger, read before and after the merge (§25) ──
//
// (0) reads only what exists today, so a run from the branch is the BEFORE reading:
// which engine labels the runs carry. (1)–(5) read `sim_engine_builds`, which
// `20261004000001` creates, so before the merge they error — a fact about the
// sequence, not a finding. The AFTER reading is taken in the push after the merge (D153).
async function phase15EngineLedger() {
  section("Phase 15 · WP 15.7 — the engine build ledger and archive");

  report("(0) every engine label the runs carry, with counts (before and after)",
    await tryQ(`
      select coalesce(nullif(btrim(code_version), ''), '(none yet)') as code_version,
             (position('+' in coalesce(code_version, '')) > 0) as names_a_build,
             count(*) as runs,
             min(created_at)::date as first_run, max(created_at)::date as last_run
        from public.simulation_runs group by 1, 2 order by max(created_at) desc nulls last`),
    (rows) => { out("**(0) engine labels on runs (`names_a_build` is true for every run computed since WP 15.1 deployed):**"); out(...table(rows)); });

  report("(1) D292 — every engine label a run carries has its ledger row",
    await tryQ(`
      select count(distinct r.code_version) as labels_on_runs,
             count(distinct r.code_version) filter (where b.id is null) as labels_missing_from_ledger
        from public.simulation_runs r
        left join public.sim_engine_builds b
          on b.engine_id = coalesce(r.engine_id, public._engine_for_code_version(r.code_version))
         and b.code_version = btrim(r.code_version)
       where btrim(coalesce(r.code_version, '')) <> ''
         and coalesce(r.engine_id, public._engine_for_code_version(r.code_version)) is not null`),
    (rows) => { out("**(1) labels on runs vs the ledger (`labels_missing_from_ledger` must be 0 — the backfill and the run trigger record every one):**"); out(...table(rows)); });

  report("(2) D292 — the ledger by how each build was first seen",
    await tryQ(`
      select first_seen_by, count(*) as builds,
             count(*) filter (where position('+' in code_version) > 0) as content_named,
             count(scsim_digest) as with_digests, count(commit_sha) as with_commit,
             count(image_digest) as with_image, count(withdrawn_at) as withdrawn
        from public.sim_engine_builds group by 1 order by 1`),
    (rows) => { out("**(2) the ledger (`backfill` rows are history and carry no digests; a `worker_report` row after the merge carries digests, commit and image):**"); out(...table(rows)); });

  report("(3) D293 — the registry's current build and its ledger row",
    await tryQ(`
      select e.slug, e.status, e.code_version, e.reported_at,
             b.first_seen_by, b.commit_sha, b.image_digest is not null as has_image, b.withdrawn_at
        from public.sim_engines e
        left join public.sim_engine_builds b on b.engine_id = e.id and b.code_version = e.code_version
       order by e.slug`),
    (rows) => { out("**(3) registry vs ledger (after the worker deploys, scsim's `code_version` names a build and its row carries the deploy's commit):**"); out(...table(rows)); });

  report("(4) runs computed since the ledger, and whether each names a build",
    await tryQ(`
      select (position('+' in code_version) > 0) as names_a_build, status, count(*) as runs
        from public.simulation_runs
       where created_at >= (select min(first_seen_at) from public.sim_engine_builds where first_seen_by <> 'backfill')
       group by 1, 2 order by 1, 2`),
    (rows) => { out("**(4) runs since the first non-backfill build (every completed one names a build):**"); out(...table(rows)); });

  report("(5) D295 — the engine bucket: the two indexes and the archived wheels",
    await tryQ(`
      select count(*) filter (where name = 'index.json') as index_json,
             count(*) filter (where name = 'versions.json') as versions_json,
             count(*) filter (where name like '%.whl') as wheels,
             count(*) filter (where name like 'scsim-%' or name like '%/scsim-%') as scsim_wheels
        from storage.objects where bucket_id = 'engine'`),
    (rows) => { out("**(5) the bucket (after the first publish with `--backfill`, `versions_json` is 1 and every committed wheel set is archived):**"); out(...table(rows)); });
}

// ── Phase 18 · WP 18.2 — the run calendar, read after the merge (§28, §4 D318) ──
//
// `20261101000001` stamps `simulation_runs.calendar_start` at insert and backfilled
// every earlier run from its project's start. Read in the push AFTER the merge (D153).
// Three numbers are gates: a run whose project has a start but no calendar; a
// backfilled run whose calendar is not its project's start (nothing may have moved
// it yet); and a RunKey spec that names the calendar (it must move no key).
async function phase18RunCalendar() {
  section("Phase 18 · WP 18.2 — the run calendar and the project window (§4 D318)");

  report("(1) runs by how their calendar was recorded",
    await tryQ(`
      select coalesce(calendar_start_source, '(none)') as source, count(*)::int as runs,
             count(calendar_start)::int as with_calendar,
             min(created_at)::date as first_run, max(created_at)::date as last_run
        from public.simulation_runs group by 1 order by 1`),
    (rows) => { out("**(1) runs by calendar source (`backfill` = runs before the migration; `dispatch` = runs since; `(none)` only where the project has no start):**"); out(...table(rows)); });

  const gate = async (label, sql, why) => {
    const rows = report(label, await tryQ(sql), (r) => { out(`**${label}** (must be 0):`); out(...table(r)); });
    const n = Number(rows?.[0]?.n ?? NaN);
    if (!Number.isFinite(n)) gateFailures.push(`${label}: unreadable, so the WP 18.2 reading is not taken (§4 D318).`);
    else if (n !== 0) gateFailures.push(`${label}: ${n} — ${why} (§4 D318).`);
  };

  await gate("(2) a run whose project has a start but which carries no calendar",
    `select count(*)::int as n from public.simulation_runs r join public.projects p on p.id = r.project_id
      where p.simulation_start is not null and r.calendar_start is null`,
    "the insert stamp or the backfill missed runs");
  // WP 18.3 (`20261101000002`) moved the day-early project starts from 31 December to
  // 1 January and, by decision, left each run's recorded calendar alone — so a backfilled
  // run may now read the 31 December its project used to have, and nothing else.
  await gate("(3) a backfilled run whose calendar is neither its project's start nor the 31 December WP 18.3 replaced",
    `select count(*)::int as n from public.simulation_runs r join public.projects p on p.id = r.project_id
      where r.calendar_start_source = 'backfill'
        and r.calendar_start is distinct from p.simulation_start
        and not (extract(month from p.simulation_start) = 1 and extract(day from p.simulation_start) = 1
                 and r.calendar_start = p.simulation_start - 1)`,
    "a backfilled run was given a start its project does not have, or the project start was edited since");
  await gate("(4) a RunKey spec that names the calendar",
    `select count(*)::int as n from public.simulation_runs
      where run_spec is not null and (run_spec ? 'calendar_start' or (run_spec -> 'scenario') ? 'calendar_start')`,
    "the calendar reached the RunKey spec, so identical simulations would get new keys");

  // WP 18.4 — after `20261101000002`, no project may still carry the day-early window.
  await gate("(7) a project still carrying the day-early window (31 Dec → 30 Dec)",
    `select count(*)::int as n from public.projects
      where extract(month from simulation_start) = 12 and extract(day from simulation_start) = 31
        and simulation_end = (simulation_start + 1) + interval '1 year' - interval '2 days'`,
    "the date correction missed a project, or a new one was saved with the old bug");

  report("(5) per project: the window and its runs",
    await tryQ(`
      select p.name, p.simulation_start, p.simulation_end,
             case when p.simulation_start is null or p.simulation_end is null or p.simulation_end <= p.simulation_start
                  then null else ceil((p.simulation_end - p.simulation_start) / 7.0)::int end as window_weeks,
             count(r.id)::int as runs,
             count(r.id) filter (where r.calendar_start_source = 'backfill')::int as backfilled,
             count(r.id) filter (where r.calendar_start_source = 'dispatch')::int as dispatched
        from public.projects p left join public.simulation_runs r on r.project_id = p.id
       group by p.id, p.name, p.simulation_start, p.simulation_end
       order by count(r.id) desc, p.name`),
    (rows) => { out("**(5) every project — its window in weeks (the engine runs 52–520) and its runs by calendar source:**"); out(...table(rows)); });

  report("(6) scenarios: calendar-entered starts, and horizons that differ from the window",
    await tryQ(`
      select p.name, count(s.id)::int as scenarios,
             count(s.id) filter (where exists (select 1 from jsonb_array_elements(
               case when jsonb_typeof(s.disruption_schedule) = 'array' then s.disruption_schedule else '[]'::jsonb end) e
               where e ? 'start_anchor'))::int as with_calendar_start,
             count(s.id) filter (where p.simulation_start is not null and p.simulation_end > p.simulation_start
               and round(s.horizon_days / 7.0) <> least(520, greatest(52, ceil((p.simulation_end - p.simulation_start) / 7.0))))::int
               as horizon_differs_from_window
        from public.projects p join public.scenarios s on s.project_id = p.id
       group by p.name order by count(s.id) desc, p.name`),
    (rows) => { out("**(6) per project — scenarios with a start entered in calendar time (adoption), and scenarios the Lab will warn run another length than the window (informational):**"); out(...table(rows)); });
}

// ── Phase 11 · WP 11.5 — the levels, read after the merge (§21) ───────────
//
// Every query here reads tables and columns `20261001000019`–`22` create, so before
// the merge each one errors — a fact about the sequence (migrations deploy on merge),
// not a finding. The reading is taken in the push AFTER the merge (D153).
async function phase11Levels() {
  section("Phase 11 · WP 11.1–11.4 — a version per level, the simulation scope, the bindings, the lineage");

  report("(1) D258 — level versions per project: how many, and the highest number per level",
    await tryQ(`
      select project_id::text as project_id, level,
             count(*) as versions, max(version_no) as highest_no,
             count(*) filter (where first_dataset_version_id is null) as first_snapshot_gone
        from public.graph_level_versions group by 1, 2 order by 1, 2`),
    (rows) => { out("**(1) level versions per project and level (numbers are per LEVEL; a project with history has every level from v1):**"); out(...table(rows)); });

  report("(2) D258 — snapshots whose tuple has a NULL, by level",
    await tryQ(`
      select count(*) as snapshots,
             count(*) filter (where product_version_id is null) as no_product,
             count(*) filter (where process_version_id is null) as no_process,
             count(*) filter (where firm_version_id is null) as no_firm,
             count(*) filter (where simulation_version_id is null) as no_simulation,
             count(*) filter (where firm_version_id is null and hash_firm is not null) as firm_hash_unregistered,
             count(*) filter (where simulation_version_id is null and hash_inputs is not null) as sim_hash_unregistered
        from public.dataset_versions`),
    (rows) => { out("**(2) snapshot tuples (a NULL is right only where the hash is NULL; the two `_unregistered` columns must be 0):**"); out(...table(rows)); });

  report("(3) D259 — Validated Models by which hash they bind",
    await tryQ(`
      select status,
             count(*) as models,
             count(hash_simulation) as bind_simulation_scope,
             count(*) filter (where hash_simulation is null) as composite_only,
             count(*) filter (where hash_simulation is null and dataset_version_id is not null) as could_have_learnt
        from public.model_validations group by 1 order by 1`),
    (rows) => { out("**(3) Validated Models (`could_have_learnt` must be 0 — the backfill read every model's own snapshot):**"); out(...table(rows)); });

  report("(4) D260 — runs by RunKey version and whether they bind the simulation scope",
    await tryQ(`
      select coalesce(run_spec ->> 'run_key_version', 'none') as run_key_version,
             count(*) as runs,
             count(hash_simulation) as with_simulation_hash,
             count(simulation_version_id) as with_simulation_version,
             count(*) filter (where created_at > now() - interval '1 day') as last_day
        from public.simulation_runs group by 1 order by 1`),
    (rows) => { out("**(4) runs (every run dispatched after the merge is RunKey v2 with a simulation version):**"); out(...table(rows)); });

  report("(5) D261 — analysis runs by scope and whether they name their level version",
    await tryQ(`
      select input_scope, status, count(*) as runs,
             count(level_version_id) as with_level_version
        from public.analysis_runs group by 1, 2 order by 1, 2`),
    (rows) => { out("**(5) analysis runs (scope `all` names no level version by design):**"); out(...table(rows)); });

  report("(6) D264 — the stored simulation hash agrees with the newest snapshot that carries it",
    await tryQ(`
      select s.project_id::text as project_id,
             s.dirty,
             (s.hash_inputs = dv.hash_inputs) as stored_equals_newest,
             (select count(*) from public.graph_level_versions g
               where g.project_id = s.project_id and g.level = 'simulation' and g.level_hash = s.hash_inputs) as live_is_a_version
        from public.project_graph_state s
        left join lateral (select hash_inputs from public.dataset_versions d
                            where d.project_id = s.project_id order by created_at desc, id desc limit 1) dv on true
       order by 1`),
    (rows) => { out("**(6) the simulation scope now vs the newest snapshot (`false` with `dirty` true is an edit not yet captured, not a fault):**"); out(...table(rows)); });

  report("(7) D262 — the training set by simulation version, per project",
    await tryQ(`
      select project_id::text as project_id,
             count(distinct simulation_version_id) as simulation_versions,
             count(distinct graph_version_id) as composites,
             count(distinct run_id) as runs,
             count(*) as replications
        from public.surrogate_training_runs group by 1 order by 5 desc`),
    (rows) => { out("**(7) the training set (simulation versions ≤ composites; equal when no deep-tier-only change separated two runs):**"); out(...table(rows)); });

  report("(8) D265 + the reads — doors after the merge",
    await tryQ(`
      select has_table_privilege('anon', 'public.dataset_versions', 'INSERT') as anon_inserts_snapshot,
             has_table_privilege('anon', 'public.graph_level_versions', 'INSERT') as anon_inserts_level,
             has_function_privilege('anon', 'public._graph_level_register(uuid)', 'EXECUTE') as anon_registers,
             has_function_privilege('anon', 'public.dataset_version_tuple(uuid)', 'EXECUTE') as anon_reads_tuple,
             (select count(*) from pg_policies where tablename = 'dataset_versions' and cmd = 'INSERT') as insert_policies`),
    (rows) => { out("**(8) doors (the first three and `insert_policies` must be false/0; the tuple read must be true):**"); out(...table(rows)); });

  report("(9) D240 — network-keyed analyses since the merge (the shim's drop waits for one)",
    await tryQ(`
      select analysis_kind, input_scope, count(*) as runs, max(started_at) as latest
        from public.analysis_runs
       where analysis_kind in ('network_metrics', 'prominence') and input_scope in ('firm', 'process')
       group by 1, 2 order by 1, 2`),
    (rows) => { out("**(9) `network_metrics` / `prominence` runs keyed on a level (any row here is what D240's drop waits for):**"); out(...table(rows)); });
}

async function phase12Library() {
  section("Phase 12 · WP 12.2–12.3 — what a library would pull, and who a key is");

  report("(1) WP 12.2 — dataset snapshot sizes per project (the response a library pulls)",
    await tryQ(`
      select project_id::text as project_id, count(*) as versions,
             max(octet_length(snapshot::text)) as max_json_bytes,
             round(avg(octet_length(snapshot::text))) as avg_json_bytes,
             max(pg_column_size(snapshot)) as max_stored_bytes
        from public.dataset_versions group by 1 order by max_json_bytes desc nulls last`),
    (rows) => { out("**(1) dataset snapshots by project — `max_json_bytes` is the uncompressed response body:**"); out(...table(rows)); });

  report("(2) WP 12.2 — the five largest dataset snapshots, and which domain carries the weight",
    await tryQ(`
      select id::text as id, project_id::text as project_id,
             coalesce(snapshot ->> 'schema_version', '1') as schema_version,
             octet_length(snapshot::text) as json_bytes,
             octet_length(coalesce(snapshot -> 'inputs', snapshot)::text) as inputs_bytes,
             octet_length(coalesce(snapshot -> 'network', '{}'::jsonb)::text) as network_bytes
        from public.dataset_versions order by octet_length(snapshot::text) desc nulls last limit 5`),
    (rows) => { out("**(2) largest dataset snapshots (`inputs` is what a simulation needs; `network` only the analyses):**"); out(...table(rows)); });

  report("(3) WP 12.2 — policy snapshot sizes",
    await tryQ(`
      select count(*) as versions, max(octet_length(snapshot::text)) as max_json_bytes,
             round(avg(octet_length(snapshot::text))) as avg_json_bytes
        from public.policy_versions`),
    (rows) => { out("**(3) policy snapshots:**"); out(...table(rows)); });

  report("(4) WP 12.3 — API keys by whether they name a creator (a personal key needs one)",
    await tryQ(`
      select env, count(*) as keys, count(created_by) as with_creator,
             count(*) filter (where revoked_at is null) as not_revoked
        from public.api_keys group by 1 order by 1`),
    (rows) => { out("**(4) API keys (`with_creator` < `keys` means some keys could not become personal):**"); out(...table(rows)); });
}

// §4 D278 — an account role change now moves the ACTIVE organization's member/admin role.
// Before `20261002000006` it moved nothing, so production may hold both leftovers. Counted
// across EVERY organization (D42), by organization name only — no person is named. The
// first is what /admin/users marks with "Make organization admin"; the second is the half
// that HOLDS a right (`_api_key_management_org` admits an organization admin whatever the
// account role), and no badge marks it.
async function d278AccountRoleGaps() {
  section("D278 — account role vs the active organization's role, every organization");

  report("(1) D278 — accounts whose role is admin while their active-organization role is member",
    await tryQ(`
      select coalesce(o.name, '(none)') as organization, count(*)::int as account_admins_at_member
        from public.approved_users u
        join public.organization_members m on m.user_id = u.id and m.org_id = u.organization_id
        left join public.organizations o on o.id = m.org_id
       where u.role = 'admin'::public.app_role and m.org_role = 'member'
       group by 1 order by 2 desc, 1`),
    (rows) => { out("**(1) account admins left at organization `member` (what `admin_list_account_role_gaps` lists; empty is clean):**"); out(...table(rows)); });

  report("(2) D278 — accounts that are NOT admin while their active-organization role is admin",
    await tryQ(`
      select coalesce(o.name, '(none)') as organization, u.role::text as account_role,
             count(*)::int as accounts
        from public.approved_users u
        join public.organization_members m on m.user_id = u.id and m.org_id = u.organization_id
        left join public.organizations o on o.id = m.org_id
       where u.role in ('user'::public.app_role, 'modeler'::public.app_role) and m.org_role = 'admin'
       group by 1, 2 order by 3 desc, 1, 2`),
    (rows) => { out("**(2) non-admin accounts holding an organization `admin` row — they manage the organization's API keys (a demotion before D278 left these; an explicit `admin_set_user_org_role` also makes them):**"); out(...table(rows)); });

  report("(3) D278 — totals",
    await tryQ(`
      select count(*) filter (where u.role = 'admin'::public.app_role and m.org_role = 'member')::int as admin_at_member,
             count(*) filter (where u.role in ('user'::public.app_role, 'modeler'::public.app_role) and m.org_role = 'admin')::int as non_admin_at_admin,
             count(*) filter (where u.role = 'admin'::public.app_role)::int as account_admins,
             count(*)::int as accounts_with_an_active_membership
        from public.approved_users u
        join public.organization_members m on m.user_id = u.id and m.org_id = u.organization_id`),
    (rows) => { out("**(3) totals:**"); out(...table(rows)); });
}

async function tronV2Readiness() {
  // Owner request 2026-10-27: the anonymised Tronico files were uploaded into a new project
  // (§16 · D314). Is it complete, typed and ready for the Nexus stress battery, which runs
  // only on the project's active Validated Model? One project by name, read-only.
  section("TRON v2 readiness — Project TRON - version 2 (§16 · D314)");
  const P = `(select id from public.projects where name = 'Project TRON - version 2')`;

  report("(1) the project row", await tryQ(`
      select p.id::text, p.name, p.organization, p.plant_name, p.bom_level, p.completed, p.created_at
        from public.projects p where p.name ilike 'Project TRON%' order by p.created_at`),
    (rows) => { out("**(1) projects named like TRON (the probe reads the exact name `Project TRON - version 2`):**"); out(...table(rows)); });

  report("(2) rows per table", await tryQ(`
      select 'suppliers' as tbl, count(*)::int as n from public.suppliers where project_id = ${P}
      union all select 'materials', count(*)::int from public.materials where project_id = ${P}
      union all select 'products', count(*)::int from public.products where project_id = ${P}
      union all select 'customers', count(*)::int from public.customers where project_id = ${P}
      union all select 'bom_single_level', count(*)::int from public.bom_single_level where project_id = ${P}
      union all select 'inbound_logistics', count(*)::int from public.inbound_logistics where project_id = ${P}
      union all select 'outbound_logistics', count(*)::int from public.outbound_logistics where project_id = ${P}
      union all select 'supply_chain_data', count(*)::int from public.supply_chain_data where project_id = ${P}
      union all select 'supply_chain_data_multi_tier', count(*)::int from public.supply_chain_data_multi_tier where project_id = ${P}
      union all select 'node_list', count(*)::int from public.node_list where project_id = ${P}`),
    (rows) => { out("**(2) rows per table** — expected 61 / 560 / 17 / 1 / 599 / 635 / 17 from the seven CSVs:"); out(...table(rows)); });

  report("(3) node types", await tryQ(`
      select coalesce(echelon, '(null)') as echelon, count(*)::int as nodes
        from public.node_list where project_id = ${P} group by 1 order by 2 desc`),
    (rows) => { out("**(3) `node_list.echelon`** — a NULL is a node the refresh never typed:"); out(...table(rows)); });

  report("(4) supply consistency", await tryQ(`
      select (select count(*)::int from public.bom_single_level b where b.project_id = ${P}
                and not exists (select 1 from public.materials m where m.project_id = b.project_id and m.material_id = b.material_id)) as bom_material_not_in_master,
             (select count(*)::int from public.inbound_logistics i where i.project_id = ${P}
                and not exists (select 1 from public.suppliers s where s.project_id = i.project_id and s.supplier_id = i.supplier_id)) as lane_supplier_not_in_master,
             (select count(distinct b.material_id)::int from public.bom_single_level b where b.project_id = ${P}
                and not exists (select 1 from public.inbound_logistics i where i.project_id = b.project_id and i.material_id = b.material_id)) as bom_material_with_no_supplier,
             (select count(*)::int from public.outbound_logistics o where o.project_id = ${P}
                and not exists (select 1 from public.products pr where pr.project_id = o.project_id and pr.product_id = o.product_id)) as outbound_product_not_in_master`),
    (rows) => { out("**(4) cross-table consistency** — every value should be 0:"); out(...table(rows)); });

  report("(5) policy defaults", await tryQ(`
      select fulfillment_strategy, inventory::text, fulfillment::text, sourcing::text, recovery::text, updated_at
        from public.policy_defaults where project_id = ${P}`),
    (rows) => { out("**(5) `policy_defaults`** — the study's baseline is min_max · coverage 8 weeks · safety stock 0 days · backorder off · single sourcing · recovery off:"); out(...table(rows)); });

  report("(6) policy versions, Validated Models, scenarios", await tryQ(`
      select 'policy_version' as kind, coalesce(v.version_code, v.label) as name, null::text as status, v.created_at
        from public.policy_versions v where v.project_id = ${P}
      union all
      select 'validated_model', coalesce(m.name, '') || ' v' || coalesce(m.version_no::text, '?'), m.status || ' · ' || coalesce(m.verdict, ''), m.created_at
        from public.model_validations m where m.project_id = ${P}
      union all
      select 'scenario', s.name, coalesce(s.role, ''), s.created_at
        from public.scenarios s where s.project_id = ${P}
      order by 1, 4`),
    (rows) => { out("**(6) what the stress battery needs** — it runs on the project's ACTIVE Validated Model:"); out(...table(rows)); });

  report("(6b) the active Validated Model's policy version", await tryQ(`
      select coalesce(m.name, '') || ' v' || coalesce(m.version_no::text, '?') as model, m.status, m.verdict,
             m.validated_at, coalesce(v.version_code, v.label) as policy_version, v.policy_hash,
             (select string_agg(k, ',') from jsonb_object_keys(v.snapshot) k) as snapshot_keys,
             coalesce(v.snapshot #>> '{defaults,inventory,safety_stock_days}', v.snapshot #>> '{inventory,safety_stock_days}') as safety_stock_days,
             coalesce(v.snapshot #>> '{defaults,inventory,type}', v.snapshot #>> '{inventory,type}') as inventory_type,
             coalesce(v.snapshot #>> '{defaults,inventory,coverage_weeks}', v.snapshot #>> '{inventory,coverage_weeks}') as coverage_weeks,
             coalesce(v.snapshot #>> '{defaults,fulfillment,backorder_allowed}', v.snapshot #>> '{fulfillment,backorder_allowed}') as backorder_allowed,
             coalesce(v.snapshot #>> '{defaults,recovery,response}', v.snapshot #>> '{recovery,response}') as recovery_response
        from public.model_validations m
        left join public.policy_versions v on v.id = m.policy_version_id
       where m.project_id = ${P} order by m.created_at`),
    (rows) => { out("**(6b) each Validated Model's policy version** — the study's baseline is safety stock 0 days, min_max, coverage 8, backorder false, no recovery response:"); out(...table(rows)); });

  report("(7) upload runs", await tryQ(`
      select (select string_agg(k, ',') from jsonb_object_keys(coalesce(r.rows_fetched, '{}'::jsonb)) k) as target,
             r.status, count(*)::int as runs, max(r.created_at) as latest
        from public.ingest_runs r where r.project_id = ${P} group by 1, 2 order by 1, 2`),
    (rows) => { out("**(7) `ingest_runs`** — the inbound run that timed out is the one left `staged`:"); out(...table(rows)); });
}

async function main() {
  out(`# PLAN.md §15 — verification SQL, executed`);
  out("");
  out(`- project ref: \`${ref}\``);
  out(`- run at: ${new Date().toISOString()}`);
  out(`- route: Supabase Management API \`/database/query\` (the route §16 · WP 2.1 follow-up and \`seed-project.yml\` prove)`);
  out(`- every statement is a \`select\`; \`assertReadOnly()\` refuses anything else.`);

  await migrationFenceOpen();

  await rqScenarioDiagnostic();
  await d205AdminUsers();
  await wp94ScenarioRole();
  await phase10Versions();
  await phase11Levels();
  await phase12Library();
  await phase15EngineLedger();
  await phase18RunCalendar();
  await d278AccountRoleGaps();
  await tronV2Readiness();

  await schemaProbe();
  await viewSecurity();
  await d30();
  await d29();
  await boundaryDecisions();
  await ingestTables();
  await wp65aLandingSwitch();
  await d170DeleteStillFails();
  await graphHashBlastRadius();
  await wp42Smear();
  await wp42Landed();
  await wp43and44Counts();
  await wp62and64Before();
  await graphLayerBefore();
  await graphLayerWhoWroteIt();
  await wp71Stage0();
  await userAuditShape();

  const project = await pickProject();
  if (!project) {
    section("§15 · per-project queries — SKIPPED");
    out("- `inbound_logistics` holds no rows in any project, so there is no project to measure.");
  } else {
    section(`§15 · the project measured`);
    out(`- \`project_id\` = \`${project.id}\` — **${project.name}** — chosen because it has the ${project.why}.`);
    await section15(project.id);
  }

  await d175MaterialVisibility();
  await bomShapeProbe();
  await bomDerivedLaneDetail();
  await mappingAudit();
  await allProjectsSweep();
  await migrationFenceClose();

  out("");
  out(`_${queryCount} statements, all \`SELECT\`._`);

  if (gateFailures.length) {
    section("GATE — this run FAILS");
    for (const f of gateFailures) out(`- ${f}`);
    out("");
    out("_The report above is complete; the run exits non-zero so the workflow is red._");
  }

  if (outPath) writeFileSync(outPath, lines.join("\n") + "\n");
  if (gateFailures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nverification-sql FAILED: ${err.message ?? err}`);
  if (outPath) writeFileSync(outPath, lines.join("\n") + `\n\n**RUN FAILED:** ${err.message ?? err}\n`);
  process.exit(1);
});

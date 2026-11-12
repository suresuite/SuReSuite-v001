#!/usr/bin/env node
// Applies plan.json (scripts/demo/cleanup_plan.py) through the app's own paths, as each project's
// owner: revoke_model_validation, scenarios DELETE (the call useScenarios.remove makes), and
// delete_policy_version — which refuses a version a run or a Validated Model still names.
//   node scripts/demo/cleanup_demo.mjs plan.json [--dry-run]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const client = readFileSync(join(root, "src/integrations/supabase/client.ts"), "utf8");
const URL_ = client.match(/SUPABASE_URL = "([^"]+)"/)[1];
const KEY = client.match(/SUPABASE_PUBLISHABLE_KEY = "([^"]+)"/)[1];
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const DRY = process.argv.includes("--dry-run");
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));

async function call(method, path, body, extra = {}) {
  const res = await fetch(`${URL_}${path}`, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
let failed = 0;
for (const p of plan) {
  console.log(`\n== ${p.project}`);
  for (const m of p.revoke_models) {
    if (DRY) { console.log(`  [dry] revoke model "${m.name}" ${m.id}`); continue; }
    const r = await call("POST", "/rest/v1/rpc/revoke_model_validation", {
      p_validation_id: m.id, _actor_user_id: p.user_id,
      p_reason: "Superseded by the latest Validated Model (customer terms, 104-week horizon). Demo clean-up.",
    });
    console.log(`  revoke model "${m.name}": ${r.status < 300 ? "ok" : `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`}`);
    if (r.status >= 300) failed++;
  }
  for (const s of p.delete_scenarios) {
    if (DRY) { console.log(`  [dry] delete scenario "${s.name}" ${s.id} (its runs go with it)`); continue; }
    const r = await call("DELETE", `/rest/v1/scenarios?id=eq.${s.id}`, undefined, { Prefer: "return=representation" });
    const n = Array.isArray(r.body) ? r.body.length : 0;
    console.log(`  delete scenario "${s.name}": ${r.status < 300 && n === 1 ? "ok" : `HTTP ${r.status}, ${n} row(s) ${JSON.stringify(r.body).slice(0, 200)}`}`);
    if (r.status >= 300 || n !== 1) failed++;
  }
  for (const v of p.delete_policy_versions) {
    if (DRY) { console.log(`  [dry] delete policy version "${v.name}" ${v.id}`); continue; }
    const r = await call("POST", "/rest/v1/rpc/delete_policy_version", { p_version_id: v.id, _actor_user_id: p.user_id });
    console.log(`  delete policy version "${v.name}": ${r.status < 300 ? "ok" : `refused — HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`}`);
    if (r.status >= 300) failed++;
  }
}
console.log(failed ? `\n${failed} step(s) did not apply` : "\nall steps applied");
process.exit(failed ? 1 : 0);

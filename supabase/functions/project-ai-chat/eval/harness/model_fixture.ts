// A properly VALIDATED project for the Phase V suites (ai-agents.md §27).
//
// The cl-01 fixture's model card names a DISRUPTED run as its evidence and
// carries no protocol — fine for the cache tests it was written for, wrong
// as a picture of the platform's storyline. This patch makes the stub
// project what a validated project is: a no-disruption baseline scenario,
// the baseline run that is the model's evidence, and a model whose protocol
// states 3 replications, a 2-week warm-up and a 52-week horizon.

import type { Row } from "./stub_db.ts";

export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const MODEL = "88888888-8888-4888-8888-888888888802";
export const BASE_SCEN = "55555555-5555-4555-8555-555555555500";
export const BASE_RUN = "99999999-9999-4999-8999-999999999900";
export const OUTAGE_SCEN = "55555555-5555-4555-8555-555555555502";
export const OUTAGE_RUN = "99999999-9999-4999-8999-999999999901";
export const VER = "44444444-4444-4444-8444-444444444401";

export function validatedProject(t: Record<string, Row[]>): void {
  const outage = t.scenarios.find((s) => String(s.id) === OUTAGE_SCEN)!;
  Object.assign(outage, { horizon_days: 364, seed: 42, crn: true, warmup_mode: "manual", warmup_days: 14, replications: 3, recovery_overrides: {} });
  t.scenarios.push({
    ...structuredClone(outage),
    id: BASE_SCEN,
    name: "Baseline",
    disruption_schedule: [],
    created_at: 10,
  });
  const outageRun = t.simulation_runs.find((r) => String(r.id) === OUTAGE_RUN)!;
  Object.assign(outageRun, { rep_count_done: 3, rep_count_target: 3, seed: 42, model_validation_id: MODEL });
  t.simulation_runs.push({
    ...structuredClone(outageRun),
    id: BASE_RUN,
    scenario_id: BASE_SCEN,
    scenario_hash: `scen-${BASE_SCEN}`,
    aggregate_kpis: { fill_rate: 0.97, backlog_peak: 100 },
    created_at: 95,
  });
  for (const [i, f] of [0.96, 0.97, 0.98].entries()) {
    t.run_replications.push({ run_id: BASE_RUN, rep_index: i + 1, status: "done", kpis: { fill_rate: f } });
  }
  const card = t.model_validations.find((c) => String(c.id) === MODEL)!;
  Object.assign(card, {
    name: "Q4 baseline",
    evidence_run_id: BASE_RUN,
    adopted_warmup_days: 14,
    recommended_replications: 3,
    scenario_hash: `scen-${BASE_SCEN}`,
    protocol: { replications: 3, root_seed: 42, crn: true, warmup_week: 2, horizon_weeks: 52, stopping_rule: "fixed_horizon" },
  });
}

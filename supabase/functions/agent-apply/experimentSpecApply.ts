// experiment_spec apply mapping — Stage 4, single-run subset
// (ai-agents.md §4.4 row 4, §9.5, §13.3 row 4).
//
// The exact §4.4 sequence, every step an interface that already exists:
//   (1) if the spec creates a scenario: insert via the existing scenarios
//       write path used by the Lab (the same defaulted row useScenarios.tsx
//       inserts), reuse-or-create keyed on (project, name) so a retry after a
//       failed enqueue never duplicates the scenario; for an existing
//       scenario, the spec's replication count is written to the scenario row
//       — the identical write the Lab's scenario editor performs before its
//       own dispatch;
//   (2) dispatch through dispatchExperimentRun (_shared/dispatch.ts) — the
//       ONLY dispatch path, never a parallel one. It enforces policy-version
//       binding, the §8.1 validation gate (ValidationRejection ⇒ gate_blocked
//       with findings surfaced on the card), dataset snapshot, credibility
//       stamp, queued row, enqueue (fail-loudly). The queued run row carries
//       policy_version_id, policy_hash, dataset_version_id, graph_hash,
//       scenario_hash, model_validation_id exactly as a Lab dispatch would
//       (ed-08 provenance indistinguishability).
//
// acknowledge_warnings: the stored payload always carries false (the draft
// tool forces it, §5.4). The approving human's acknowledgment arrives with
// the apply request and is honored ONLY when the card DISPLAYED warn findings
// (payload.findings_preview) and none of them is a block — the §5.4 rule made
// mechanical.
//
// Reuse-or-rerun (dispatch.ts G17): when an identical completed run already
// exists the dispatcher answers ReuseAvailable instead of recomputing; the
// apply records that run as the result with reused:true — the card says so,
// nothing is silently skipped, and no compute is spent re-deriving identical
// numbers (§10 Q29c landing note).
//
// Pure orchestration over an injected supabase-like client + upstash runner:
// no Deno.env, no module-level clients — the deterministic eval tier drives
// it with the stateful stub, and index.ts drives it with the service role.

import {
  dispatchExperimentRun,
  CapacityRefusal,
  ReuseAvailable,
  ValidationRejection,
  canonicalJson,
  sha256Hex,
} from "../_shared/dispatch.ts";
import { ApplyFailure } from "./itemMasterApply.ts";

/** §4.4 `applied_result` shape for experiment_spec (+ the full provenance
 * stamps for the card and the §13.4 quota join). */
export interface ExperimentSpecApplyResult {
  run_id: string;
  scenario_id: string;
  policy_version_id: string;
  policy_hash: string | null;
  graph_hash: string | null;
  dataset_version_id: string | null;
  scenario_hash: string | null;
  model_validation_id: string | null;
  replications: number;
  /** true when dispatch answered "identical completed results exist" (G17)
   * and the stored run was surfaced instead of recomputed. */
  reused?: boolean;
  /** §26 M.2 comparison: one entry per arm, in the spec's order (the first
   * is the reference). `run_id` above is the LAST arm's run — the one the
   * chat plan binds to, because arms are enqueued in order. */
  experiment_type?: "comparison";
  arms?: Array<{ label: string; scenario_id: string; run_id: string; reused?: boolean }>;
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export interface ExperimentApplyDeps {
  /** Upstash REST command runner (owned by the caller, which holds the env). */
  upstash: (args: (string | number)[]) => Promise<unknown>;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Lab's scenario defaults (useScenarios.tsx::SCENARIO_DEFAULTS) — the
 * new_scenario write path inserts exactly what the Lab inserts, with the
 * spec's fields layered on top. */
function labScenarioDefaults(projectId: string, name: string): Record<string, unknown> {
  return {
    project_id: projectId,
    name,
    description: "",
    horizon_days: 90,
    time_step: "day",
    warmup_mode: "auto",
    warmup_days: 14,
    replications: 10,
    seed: 42,
    crn: true,
    demand_model: { kind: "poisson", lambda: 50 },
    disruption_schedule: [],
    recovery_overrides: {},
    stopping_rule: { kind: "fixed_horizon", max_wall_seconds: 600 },
    primary_kpi: "fill_rate",
  };
}

function findingsSummary(findings: Array<{ severity: string; field: string; message: string }>): string {
  const gating = findings.filter((f) => f.severity === "block" || f.severity === "warn");
  return gating.slice(0, 3).map((f) => `[${f.severity}] ${f.field}: ${f.message}`).join(" | ") +
    (gating.length > 3 ? ` (+${gating.length - 3} more)` : "");
}

async function readRunStamps(
  db: Db,
  runId: string,
  fallback: { scenarioId: string; policyVersionId: string; replications: number },
): Promise<ExperimentSpecApplyResult> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await db.from("simulation_runs").select("*").eq("id", runId).maybeSingle();
    row = (data as Record<string, unknown>) ?? null;
  } catch { /* stamps below fall back */ }
  return {
    run_id: runId,
    scenario_id: String(row?.scenario_id ?? fallback.scenarioId),
    policy_version_id: String(row?.policy_version_id ?? fallback.policyVersionId),
    policy_hash: (row?.policy_hash as string | null) ?? null,
    graph_hash: (row?.graph_hash as string | null) ?? null,
    dataset_version_id: (row?.dataset_version_id as string | null) ?? null,
    scenario_hash: (row?.scenario_hash as string | null) ?? null,
    model_validation_id: (row?.model_validation_id as string | null) ?? null,
    replications: Number(row?.rep_count_target ?? fallback.replications),
  };
}

/**
 * Apply one approved experiment_spec proposal. Throws ApplyFailure with a
 * §4.4 code (stale_values / gate_blocked / rpc_error); on success the queued
 * run is visible in /simulation-lab like any other. Top-level idempotency
 * rides the proposal (index.ts returns the stored applied_result for an
 * already-applied proposal without calling this).
 */
/** §26 M.2: a comparison card applies as one single-run apply per arm —
 * the SAME scenario write path and the SAME dispatchExperimentRun, so every
 * arm is gated, stamped and reusable exactly like a Lab run. Arms share the
 * Lab's default seed, which is what makes them CRN-paired. An arm that fails
 * stops the loop: the arms already dispatched keep running (they are real
 * runs, visible in the Lab), and the failure names how many were dispatched. */
async function applyComparison(
  db: Db,
  deps: ExperimentApplyDeps,
  args: Parameters<typeof applyExperimentSpec>[2],
): Promise<ExperimentSpecApplyResult> {
  const payload = args.payload ?? {};
  const base = (payload.new_scenario ?? null) as Record<string, unknown> | null;
  const arms = Array.isArray(payload.arms) ? (payload.arms as Array<Record<string, unknown>>) : [];
  if (!base || arms.length < 2 || arms.length > 6) {
    throw new ApplyFailure("rpc_error", "stored payload failed validation: a comparison needs new_scenario and 2-6 arms");
  }
  const done: NonNullable<ExperimentSpecApplyResult["arms"]> = [];
  let last: ExperimentSpecApplyResult | null = null;
  for (const arm of arms) {
    const label = String(arm.label ?? "").trim().slice(0, 60);
    const armPayload: Record<string, unknown> = {
      ...payload,
      experiment_type: undefined,
      arms: undefined,
      new_scenario: {
        name: `${String(base.name ?? "Comparison").slice(0, 57)} · ${label}`.slice(0, 120),
        horizon_days: base.horizon_days,
        disruption_schedule: Array.isArray(arm.disruption_schedule) ? arm.disruption_schedule : base.disruption_schedule,
        recovery_overrides: (arm.recovery_overrides as Record<string, unknown> | undefined) ?? base.recovery_overrides ?? {},
        ...(typeof arm.recovery_playbook_id === "string" ? { recovery_playbook_id: arm.recovery_playbook_id } : {}),
      },
    };
    try {
      last = await applyExperimentSpec(db, deps, { ...args, payload: armPayload });
    } catch (e) {
      if (e instanceof ApplyFailure && done.length > 0) {
        throw new ApplyFailure(
          e.code,
          `${e.message} — arm "${label}" failed after ${done.length} of ${arms.length} arms were dispatched ` +
            `(${done.map((d) => d.label).join(", ")}); those runs continue in the Lab.`,
        );
      }
      throw e;
    }
    done.push({ label, scenario_id: last.scenario_id, run_id: last.run_id, ...(last.reused ? { reused: true } : {}) });
  }
  return { ...last!, experiment_type: "comparison", arms: done };
}

export async function applyExperimentSpec(
  db: Db,
  deps: ExperimentApplyDeps,
  args: {
    projectId: string;
    payload: Record<string, unknown>;
    grounding: Record<string, unknown>;
    userId?: string | null;
    /** The approving human's card acknowledgment (§5.4) — never the model's. */
    acknowledgeWarnings?: boolean;
  },
): Promise<ExperimentSpecApplyResult> {
  const payload = args.payload ?? {};
  if (payload.experiment_type === "comparison") return await applyComparison(db, deps, args);

  // (0) Re-validate the stored payload — a manually forged row must never
  // reach the dispatcher (same posture as the other apply modules).
  const policyVersionId = String(payload.policy_version_id ?? "");
  if (!uuidRe.test(policyVersionId)) {
    throw new ApplyFailure("rpc_error", "stored payload failed validation: policy_version_id missing or malformed");
  }
  const rawReps = Number(payload.replications);
  if (!Number.isFinite(rawReps)) {
    throw new ApplyFailure("rpc_error", "stored payload failed validation: replications missing");
  }
  const replications = Math.max(1, Math.min(200, Math.floor(rawReps)));
  const specScenarioId = typeof payload.scenario_id === "string" ? payload.scenario_id : null;
  const newScenario = payload.new_scenario && typeof payload.new_scenario === "object" && !Array.isArray(payload.new_scenario)
    ? (payload.new_scenario as Record<string, unknown>)
    : null;
  if (Boolean(specScenarioId) === Boolean(newScenario)) {
    throw new ApplyFailure("rpc_error", "stored payload failed validation: exactly one of scenario_id / new_scenario required");
  }

  // Grounding freshness (§4.2 approved→applied precondition, §8 T8). Policy
  // versions are immutable, so the only drift possible is the version row
  // vanishing or the grounding hash disagreeing with what is stored.
  const { data: version } = await db
    .from("policy_versions")
    .select("id,project_id,snapshot,policy_hash")
    .eq("id", policyVersionId)
    .maybeSingle();
  if (!version || String(version.project_id) !== args.projectId) {
    throw new ApplyFailure("stale_values", "the bound policy version no longer exists in this project — ask for a fresh draft");
  }
  const groundedHash = typeof args.grounding?.policy_hash === "string" ? String(args.grounding.policy_hash) : null;
  if (groundedHash) {
    const versionHash: string = (version.policy_hash as string | null) ??
      (await sha256Hex(canonicalJson(version.snapshot ?? {})));
    if (versionHash !== groundedHash) {
      throw new ApplyFailure("stale_values", "the bound policy version's hash no longer matches the draft — ask for a fresh draft");
    }
  }

  // §5.4: acknowledgment is honored only if the card displayed warn findings
  // (findings_preview stored at draft) and nothing in the preview blocks.
  const preview = Array.isArray(payload.findings_preview)
    ? (payload.findings_preview as Array<{ severity: string; field: string; message: string }>)
    : [];
  const previewHasWarn = preview.some((f) => f?.severity === "warn");
  const previewHasBlock = preview.some((f) => f?.severity === "block");
  const acknowledgeWarnings = args.acknowledgeWarnings === true && previewHasWarn && !previewHasBlock;

  // (1) Scenario write path — the Lab's own.
  let scenarioId: string;
  if (specScenarioId) {
    const { data: scenario } = await db.from("scenarios").select("*").eq("id", specScenarioId).maybeSingle();
    if (!scenario || String(scenario.project_id) !== args.projectId) {
      throw new ApplyFailure("stale_values", `the scenario this spec targets (${specScenarioId}) no longer exists in this project`);
    }
    scenarioId = String(scenario.id);
    if (Number(scenario.replications) !== replications) {
      // The same scenarios-table update the Lab's editor performs before its
      // own dispatch — dispatchExperimentRun reads replications off the row.
      const { error } = await db.from("scenarios").update({ replications }).eq("id", scenarioId);
      if (error) throw new ApplyFailure("rpc_error", `scenario replication update failed: ${error.message}`);
    }
  } else {
    const name = String(newScenario!.name ?? "").trim().slice(0, 120);
    const horizon = Number(newScenario!.horizon_days);
    const schedule = Array.isArray(newScenario!.disruption_schedule)
      ? (newScenario!.disruption_schedule as Array<Record<string, unknown>>)
      : [];
    if (!name || !Number.isFinite(horizon) || horizon < 7 || horizon > 3650 || schedule.length > 5) {
      throw new ApplyFailure("rpc_error", "stored payload failed validation: new_scenario out of bounds");
    }
    const fields = {
      horizon_days: Math.floor(horizon),
      replications,
      disruption_schedule: schedule,
      recovery_overrides: (newScenario!.recovery_overrides as Record<string, unknown>) ?? {},
      // §26 M.2: a comparison arm records the playbook it runs, as the Lab's
      // design-of-experiments rows do (playbookFactor.ts).
      ...(typeof newScenario!.recovery_playbook_id === "string"
        ? { recovery_playbook_id: newScenario!.recovery_playbook_id }
        : {}),
    };
    // Reuse-or-create on (project, name): a retry after a failed dispatch
    // must not litter the Lab with duplicate scenarios (§4.4 idempotency).
    const { data: existing } = await db
      .from("scenarios")
      .select("id")
      .eq("project_id", args.projectId)
      .eq("name", name)
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      scenarioId = String(existing.id);
      const { error } = await db.from("scenarios").update(fields).eq("id", scenarioId);
      if (error) throw new ApplyFailure("rpc_error", `scenario update failed: ${error.message}`);
    } else {
      const { data: created, error } = await db
        .from("scenarios")
        .insert({ ...labScenarioDefaults(args.projectId, name), ...fields })
        .select()
        .single();
      if (error || !created) {
        throw new ApplyFailure("rpc_error", `scenario insert failed: ${error?.message ?? "no row returned"}`);
      }
      scenarioId = String(created.id);
    }
  }

  // (2) The ONLY dispatch path. ValidationRejection surfaces findings on the
  // card as gate_blocked; enqueue failure is already failed loudly on the run
  // row by dispatch.ts and lands here as rpc_error.
  try {
    const { run_id } = await dispatchExperimentRun(
      { reader: db, svc: db, upstash: deps.upstash },
      {
        project_id: args.projectId,
        scenario_id: scenarioId,
        kind: "experiment.run",
        payload: { policy_version_id: policyVersionId, acknowledge_warnings: acknowledgeWarnings },
      },
      // The approving account: the run's actor and quota owner (actor_user_id).
      args.userId ?? null,
      // …but NOT `created_by`: that column references auth.users, and an
      // approved_users id is not one (38(ag)). The approver is on the card.
      { createdBy: null },
    );
    return await readRunStamps(db, run_id, { scenarioId, policyVersionId, replications });
  } catch (e) {
    if (e instanceof ValidationRejection) {
      throw new ApplyFailure(
        "gate_blocked",
        `the pre-dispatch validation gate rejected this run (${e.gate.status}): ${findingsSummary(e.gate.findings)}`,
      );
    }
    if (e instanceof ReuseAvailable) {
      const result = await readRunStamps(db, e.candidate.run_id, { scenarioId, policyVersionId, replications });
      return { ...result, reused: true };
    }
    // WP 10.7 · §4 D247: the organization's capacity refused it, with its numbers.
    if (e instanceof CapacityRefusal) throw new ApplyFailure("quota_exceeded", e.message);
    if (e instanceof ApplyFailure) throw e;
    throw new ApplyFailure("rpc_error", e instanceof Error ? e.message : "experiment dispatch failed");
  }
}

// Shared run-dispatch path — API Phase 2 / G15 / §4.
//
// Extracted verbatim from sim-command so the browser dispatcher (sim-command)
// and the public /v1 gateway (functions/api) drive the exact same pipeline to
// the Fly worker: policy-version binding → validation gate → dataset snapshot
// → credibility stamp → queued run row → Upstash enqueue. One code path, two
// authenticated front doors (docs/design/public-api-and-access-control.md §3.1).
//
// Callers own authentication and authorization; this module assumes the
// command has already been authorized for its project. CAPACITY is not the
// caller's since WP 10.7 (§4 D247): `create_simulation_run` admits or refuses
// every run that will actually be computed against the organization's pool and
// the member's role share, and a refusal leaves here as a `CapacityRefusal`
// carrying its HTTP status (402 quota, 403 replications per run, 429 in flight).
// A caller with caps of its own (/v1's key-scoped limits) passes them in
// `opts.limits`; they can only tighten the plan's.

import {
  gateDatasetFromSnapshot,
  loadGateDataset,
  runValidationGate,
  type GateResult,
} from "./validationGate.ts";
import { fireWakeWorker } from "./wakeWorker.ts";
import { isMissingStampColumn, runStamp } from "./runStamp.ts";

// Matches sim-command's Zod CommandSchema output; the API gateway constructs
// these directly from its own validated request bodies.
export interface DispatchCommand {
  project_id: string;
  scenario_id?: string;
  kind: string;
  payload: Record<string, unknown>;
  client_ts?: number;
}

export interface DispatchDeps {
  /** Client for scenario/policy reads. sim-command passes its RLS-aware
   * client (anon reads are granted on these tables); the API gateway passes
   * the service client scoped by its own tenancy check. */
  // deno-lint-ignore no-explicit-any
  reader: any;
  /** Service-role client: authoritative creator of the queued run row. */
  // deno-lint-ignore no-explicit-any
  svc: any;
  /** Upstash REST command runner (owned by the caller, which holds the env). */
  upstash: (args: (string | number)[]) => Promise<unknown>;
}

export interface ResolvedRecovery {
  enabled: boolean;
  response: string[];
  detection_lag_days: number;
  trigger_magnitude_pct: number;
  trigger_duration_days: number;
  recovery_target_days: number;
  cost_cap: number;
}

export const DEFAULT_RECOVERY: ResolvedRecovery = {
  enabled: true,
  response: [],
  detection_lag_days: 1,
  trigger_magnitude_pct: 25,
  trigger_duration_days: 2,
  recovery_target_days: 21,
  cost_cap: 25000,
};

export function resolveRecovery(
  defaults: Record<string, unknown> | null,
  overrides: Record<string, unknown> | null,
): ResolvedRecovery {
  const base: Record<string, unknown> = { ...DEFAULT_RECOVERY, ...(defaults ?? {}) };
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === null) continue;
      base[k] = v;
    }
  }
  return base as unknown as ResolvedRecovery;
}

/** Recursively key-sorted JSON, approximating Postgres jsonb::text ordering.
 * Only used as a fallback hash for legacy versions without a stored policy_hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}: ${canonicalJson(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** PostgREST's answer when a function (or this overload of it) is not in the
 *  schema yet — a function deployed ahead of its migration. */
export function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("could not find the function") || (msg.includes("function") && msg.includes("does not exist"));
}

/** Carries a §8.1 gate result out of dispatchExperimentRun as a 422 response. */
export class ValidationRejection extends Error {
  constructor(public gate: GateResult) {
    super(`run rejected by the required-data manifest (${gate.status})`);
  }
}

/** A run the organization's capacity does not admit (WP 10.7 · §4 D247). The
 *  database names the numbers; the status is the SQLSTATE's: P0402 a quota
 *  (compute or storage) → 402, P0403 replications per run → 403, P0429 runs in
 *  flight → 429. */
export class CapacityRefusal extends Error {
  constructor(public status: 402 | 403 | 429, message: string) {
    super(message);
  }
}

const CAPACITY_STATUS: Record<string, 402 | 403 | 429> = { P0402: 402, P0403: 403, P0429: 429 };

/** A caller's own caps, folded into the plan's inside the database. */
export interface DispatchLimits {
  max_concurrent_runs?: number | null;
  max_replications?: number | null;
}

/** A completed run identical to the requested one (reuse-or-rerun, §9.2). */
export interface ReuseCandidate {
  run_id: string;
  ended_at: string | null;
  created_at: string;
  code_version: string | null;
  rep_count_done: number | null;
}

/** The G17 run identity, resolved to its comparable parts. Callers compute
 * the three hashes their own way (the dispatcher from the snapshot it just
 * took; the ai-agents.md §20.2 read tool from the current-state RPCs) — the
 * PREDICATE below is the single shared implementation, so read-hit and
 * apply-hit can never disagree (§20.1 law 2). */
export interface ReuseIdentity {
  /** The scenario row's id + updated_at (the seed-spec/disruption-schedule
   * row-unchanged guard input). */
  scenario: { id: string; updated_at?: unknown };
  policyHash: string;
  graphHash: string;
  /** WP 11.2 · §4 D260 — the simulation scope's hash (`hash_inputs`): what the
   * RunKey hashes since v2. Null when the caller could not read it; the key then
   * names no inputs and matches nothing, which is the safe direction. */
  simulationHash?: string | null;
  scenarioHash: string;
  replications: number;
  /** WP 10.4 — the engine the run would use (null = the single active one). */
  engineId?: string | null;
  /** WP 10.4 — deviations from the Validated Model's protocol (`{}` = faithful). */
  protocolOverrides?: Record<string, unknown>;
}

/**
 * The G17 reuse predicate (ai-agents.md §20.2), extracted verbatim from
 * dispatchExperimentRun so the §20.2 `find_completed_run` read tool and the
 * apply-time reuse check share ONE implementation. A candidate matches when
 * ALL hold: status='done' ∧ the three stamped hashes equal the identity's ∧
 * rep_count_done ≥ replications ∧ the scenario row unchanged since the
 * candidate was dispatched (scenarios.updated_at ≤ candidate.created_at).
 * Newest first; errors propagate — the callers own their failure posture.
 */
export async function findReuseCandidates(
  // deno-lint-ignore no-explicit-any
  svc: any,
  identity: ReuseIdentity,
  opts?: { limit?: number },
): Promise<ReuseCandidate[]> {
  const limit = Math.max(1, Math.min(5, opts?.limit ?? 1));
  // WP 10.4 · §4 D245 — THE predicate is now a RunKey, computed in SQL by the same
  // `simulation_run_spec` the dispatcher's `create_simulation_run` uses, so the
  // engine build and the seed spec are part of identity and a scenario rename is
  // not. The three-hash predicate below is the fallback for a database without
  // `20261001000009` (a function deployed ahead of its migration).
  // WP 11.2 — the key's graph term is the simulation scope (RunKey v2); a database
  // before `20261001000020` answers "function not found" to this argument name and
  // takes the three-hash fallback below, which is the deploy window.
  const { data: keyed, error: keyErr } = await svc.rpc("find_reusable_runs", {
    p_scenario_id: identity.scenario.id,
    p_policy_hash: identity.policyHash,
    p_simulation_hash: identity.simulationHash ?? null,
    p_replications: identity.replications,
    p_engine_id: identity.engineId ?? null,
    p_protocol_overrides: identity.protocolOverrides ?? {},
    p_limit: limit,
  });
  if (!keyErr) {
    return ((keyed ?? []) as Array<Record<string, unknown>>).map((cand) => ({
      run_id: String(cand.run_id),
      ended_at: (cand.ended_at as string | null) ?? null,
      created_at: String(cand.created_at),
      code_version: (cand.code_version as string | null) ?? null,
      rep_count_done: (cand.rep_count_done as number | null) ?? null,
    }));
  }
  if (!isMissingFunction(keyErr)) throw keyErr;
  const { data: rows, error } = await svc
    .from("simulation_runs")
    .select("id,ended_at,created_at,code_version,rep_count_done")
    .eq("scenario_id", identity.scenario.id)
    .eq("status", "done")
    .eq("policy_hash", identity.policyHash)
    .eq("graph_hash", identity.graphHash)
    .eq("scenario_hash", identity.scenarioHash)
    .gte("rep_count_done", identity.replications)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const updatedAt = identity.scenario.updated_at;
  return ((rows ?? []) as Array<Record<string, unknown>>)
    .filter((cand) =>
      // Row-unchanged guard: the stamped scenario_hash is the events-excluded
      // baseline fingerprint, so any scenario edit after the candidate's
      // dispatch invalidates it. Candidates come newest-first, so filtering
      // is equivalent to the original take-newest-then-guard check.
      !updatedAt ||
      (cand.created_at &&
        new Date(String(cand.created_at)).getTime() >= new Date(String(updatedAt)).getTime())
    )
    .map((cand) => ({
      run_id: String(cand.id),
      ended_at: (cand.ended_at as string | null) ?? null,
      created_at: String(cand.created_at),
      code_version: (cand.code_version as string | null) ?? null,
      rep_count_done: (cand.rep_count_done as number | null) ?? null,
    }));
}

/** Carries the reuse candidate out of dispatchExperimentRun as a 409 response.
 *  Reuse is ALWAYS a user choice: the dispatcher never silently skips a run —
 *  it answers "identical results exist" and the caller either surfaces the
 *  stored run (reuse) or re-dispatches with payload.force_rerun=true. */
export class ReuseAvailable extends Error {
  constructor(public candidate: ReuseCandidate) {
    super(`identical completed run exists (${candidate.run_id})`);
  }
}

/** The Validated Model a run follows, as dispatch reads it (§23 WP 13.3). */
interface FollowedModel {
  id: string;
  project_id: string;
  status: string;
  policy_version_id: string | null;
  dataset_version_id: string | null;
  graph_hash: string | null;
  hash_simulation: string | null;
}

export async function dispatchExperimentRun(
  deps: DispatchDeps,
  cmd: DispatchCommand,
  userId: string | null,
  opts: {
    limits?: DispatchLimits;
    /** `simulation_runs.created_by`, a foreign key to `auth.users`. Defaults to
     * `userId` (the Lab passes the Supabase Auth user, usually null — D28). A
     * caller whose `userId` is an `approved_users` id — agent-apply, where the
     * approving account is the actor and quota owner — passes null here: that
     * id is not an auth user, and writing it failed every agent dispatch with
     * `simulation_runs_created_by_fkey` (ai-agents.md §10 entry 38(ag)). */
    createdBy?: string | null;
  } = {},
): Promise<{ run_id: string; attached?: boolean }> {
  const { reader: sb, svc, upstash } = deps;
  if (!cmd.scenario_id) throw new Error("experiment.run requires scenario_id");

  // PLAN.md §23 WP 13.3 — a run of a Validated Model is dispatched with the
  // MODEL's two versions: its policy version and its dataset version, whatever
  // the caller sent and whatever the live project holds now. Resolved first, so
  // everything below — the gate, the binding, the RunKey — reads those.
  const payload0 = cmd.payload as Record<string, unknown>;
  const followedModelId =
    payload0.exploratory !== true && typeof payload0.validated_model_id === "string" && payload0.validated_model_id
      ? payload0.validated_model_id
      : null;
  let followedModel: FollowedModel | null = null;
  if (followedModelId) {
    const { data: m } = await svc
      .from("model_validations")
      .select("id,project_id,status,policy_version_id,dataset_version_id,graph_hash,hash_simulation")
      .eq("id", followedModelId)
      .maybeSingle();
    if (!m || m.project_id !== cmd.project_id) throw new Error("validated model not found in this project");
    if (m.status === "revoked") throw new Error("this Validated Model was revoked and cannot be run");
    followedModel = m as unknown as FollowedModel;
  }
  const policyVersionId = String(
    followedModel?.policy_version_id ?? payload0.policy_version_id ?? "",
  );
  if (!policyVersionId) {
    throw new Error("experiment.run requires a saved policy version (policy_version_id)");
  }

  // Load scenario
  // deno-lint-ignore no-explicit-any
  const { data: scenario, error: scErr } = await (sb as any)
    .from("scenarios")
    .select("*")
    .eq("id", cmd.scenario_id)
    .maybeSingle();
  if (scErr || !scenario) throw new Error("scenario not found");
  if (scenario.project_id !== cmd.project_id) {
    throw new Error("scenario does not belong to this project");
  }

  // Load the immutable policy version. Policies come from the saved version,
  // never from the live tables, so a run is fully reproducible against its
  // version (the graph itself is not versioned).
  // deno-lint-ignore no-explicit-any
  const { data: version, error: verErr } = await (sb as any)
    .from("policy_versions")
    .select("id,project_id,snapshot,policy_hash")
    .eq("id", policyVersionId)
    .maybeSingle();
  if (verErr || !version) throw new Error("policy version not found");
  if (version.project_id !== scenario.project_id) {
    throw new Error("policy version does not belong to this project");
  }

  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
  // v2 snapshots nest families under "defaults"; v1 snapshots are flat.
  const snapshotDefaults = (
    "defaults" in snapshot ? snapshot.defaults : snapshot
  ) as Record<string, unknown>;
  const policyHash: string =
    (version.policy_hash as string | null) ?? (await sha256Hex(canonicalJson(snapshot)));

  const recovery = resolveRecovery(
    (snapshotDefaults?.recovery as Record<string, unknown> | null) ?? null,
    (scenario.recovery_overrides as Record<string, unknown> | null) ?? null,
  );

  // Snapshot the dataset (graph + economics) and bind this run to it, so a
  // later CSV re-upload is detectable rather than silently changing history
  // (Phase A / G5 / §8.4). Deduped server-side by content: an unchanged dataset
  // reuses its version. Since WP 13.2 the worker COMPUTES from this version, so
  // a server run without one is refused below rather than run unbound.
  let datasetVersionId: string | null = null;
  let graphHash: string | null = null;
  let simulationHash: string | null = null;
  // §23 WP 13.3 — the frozen dataset a MODEL run reads, for the gate below.
  let frozenDataset: Record<string, unknown> | null = null;
  try {
    // A followed model that names its dataset version is run on THAT version —
    // nothing is snapshotted, because the live project is not what it replays.
    let dsId: string | null = followedModel?.dataset_version_id ?? null;
    if (!dsId) {
      // deno-lint-ignore no-explicit-any
      const { data, error: dsErr } = await (sb as any).rpc("snapshot_dataset", {
        p_project_id: scenario.project_id,
      });
      if (dsErr) throw dsErr;
      dsId = (data as string | null) ?? null;
    }
    datasetVersionId = dsId;
    if (datasetVersionId) {
      // deno-lint-ignore no-explicit-any
      const { data: dv } = await (svc as any)
        .from("dataset_versions")
        .select(followedModel?.dataset_version_id ? "graph_hash,hash_inputs,snapshot" : "graph_hash,hash_inputs")
        .eq("id", datasetVersionId)
        .maybeSingle();
      if (followedModel?.dataset_version_id) {
        frozenDataset = (dv?.snapshot as Record<string, unknown> | null) ?? null;
      }
      graphHash = (dv?.graph_hash as string | null) ?? null;
      // WP 11.2 · §4 D260 — the simulation scope of the same snapshot, which the
      // RunKey hashes. `create_simulation_run` reads it off the snapshot row itself;
      // it travels here only for a database that cannot (the deploy window).
      simulationHash = (dv?.hash_inputs as string | null) ?? null;
    }
  } catch (e) {
    console.error("snapshot_dataset failed", e);
  }
  // §23 WP 13.3 — a model recorded before models named their dataset version
  // (WP 10.3) can only be run on the live data, and only while that data is
  // still the data it was validated on. Otherwise its run would claim a
  // validation it does not have: the caller is told to run current data as an
  // exploratory run instead.
  if (followedModel && !followedModel.dataset_version_id && datasetVersionId) {
    const same = followedModel.hash_simulation
      ? simulationHash === followedModel.hash_simulation
      : graphHash === followedModel.graph_hash;
    if (!same) {
      throw new Error(
        "your project's data changed since this model was validated, and the model does not name " +
          "the dataset version it was validated on, so it cannot be replayed — run current data as " +
          "exploratory, or re-validate the model",
      );
    }
  }
  // PLAN.md §23 WP 13.2 · §4 D280 — the worker computes from the FROZEN dataset
  // version and nothing else, so a server run that could not be frozen is not
  // dispatched: there would be nothing for it to read. (Before WP 13.2 it ran
  // "unbound", from the live tables.) A browser run computes from what the page
  // loaded and is not refused here.
  if ((cmd.payload as Record<string, unknown>).compute !== "client" && !datasetVersionId) {
    throw new Error(
      "the project's data could not be frozen as a dataset version, so the run was not " +
        "dispatched — the server computes only from frozen versions. Try again; if it repeats, " +
        "the dataset snapshot is failing.",
    );
  }

  // Pre-dispatch validation gate (§8.1–8.2): grade the required-data manifest
  // — compiled from the engine registry for THIS policy configuration —
  // against the live project tables, read with the SERVICE ROLE (grading is a
  // read-only completeness check; anon-context reads silently miss rows and
  // once produced false blocks). `block` findings reject the run; `warn`
  // findings reject unless the caller acknowledged them after seeing the
  // findings (the /policies verification stage does; the Lab offers a
  // "Run anyway"). Fail-open on read errors — a gate that cannot load data
  // must not take run dispatch down with it — but the skip is recorded on
  // the run row (gate_skipped) instead of vanishing into the logs.
  let gateSkipped = false;
  try {
    // §23 WP 13.3 — a model run is graded on the frozen data it will READ.
    const gateDataset = frozenDataset
      ? gateDatasetFromSnapshot(frozenDataset, snapshot)
      : await loadGateDataset(svc, scenario.project_id as string);
    const gate = runValidationGate({
      dataset: gateDataset,
      snapshotDefaults: snapshotDefaults ?? {},
      disruptionSchedule:
        (scenario.disruption_schedule as Array<Record<string, unknown>>) ?? [],
      acknowledgeWarnings:
        (cmd.payload as Record<string, unknown>).acknowledge_warnings === true,
      // PLAN.md §24 WP 14.2 — a forecast shorter than the run is warned.
      horizonWeeks: Number(scenario.horizon_days) > 0
        ? Math.max(1, Math.round(Number(scenario.horizon_days) / 7))
        : undefined,
    });
    if (gate) throw new ValidationRejection(gate);
  } catch (e) {
    if (e instanceof ValidationRejection) throw e;
    gateSkipped = true;
    console.error("validation gate skipped (data load failed)", e);
  }

  const replications = Math.max(1, Math.min(200, Number(scenario.replications) || 10));

  // Stamp the credibility provenance (Phase B0 / G13 / §9.5): the scenario's
  // baseline fingerprint hash and — when the exact triple has an active card —
  // the model_validation in force at dispatch. Best-effort like the dataset
  // binding above: a missing card (or a DB without the migration) never
  // blocks a run; it just runs labeled unvalidated (§9.5 labels, not gates).
  let scenarioHash: string | null = null;
  let modelValidationId: string | null = null;
  try {
    // deno-lint-ignore no-explicit-any
    const { data: sh, error: shErr } = await (sb as any).rpc("scenario_fingerprint_hash", {
      p_scenario_id: scenario.id,
    });
    if (shErr) throw shErr;
    scenarioHash = (sh as string | null) ?? null;
    if (scenarioHash && graphHash) {
      // WP 10.2 · §4 D242 — matched by CONTENT: the card whose policy_hash is this
      // version's, whichever version row it was recorded under. Matching by id is
      // what left every run dispatched after a "Save version & run" unstamped.
      // The id-keyed RPC is the fallback for the window in which this function is
      // deployed ahead of `20261001000006` (it too matches by content once that
      // migration has run).
      // deno-lint-ignore no-explicit-any
      const rpc = (fn: string, args: Record<string, unknown>) => (sb as any).rpc(fn, args);
      let { data: card, error: cardErr } = await rpc("active_model_validation_by_content", {
        p_project_id: scenario.project_id,
        p_policy_hash: policyHash,
        p_graph_hash: graphHash,
        p_scenario_hash: scenarioHash,
      });
      if (cardErr && isMissingFunction(cardErr)) {
        ({ data: card, error: cardErr } = await rpc("active_model_validation", {
          p_policy_version_id: policyVersionId,
          p_graph_hash: graphHash,
          p_scenario_hash: scenarioHash,
        }));
      }
      if (cardErr) throw cardErr;
      const row = Array.isArray(card) ? card[0] : card;
      modelValidationId = (row?.id as string | null) ?? null;
    }
  } catch (e) {
    console.error("model-validation stamp failed (run continues unstamped)", e);
  }

  // WP 10.4 · §4 D245 — what the run is bound to beyond the content hashes: the
  // engine (dispatch refuses a retired one and defaults to the single active one),
  // the Validated Model it follows when the caller chose one (it must be this
  // project's and not revoked; otherwise the content-matched model in force
  // above), the deviations from that model's protocol, and whether the run is
  // exploratory — never false for a run with no model.
  const payload = cmd.payload as Record<string, unknown>;
  const engineId = typeof payload.engine_id === "string" && payload.engine_id ? payload.engine_id : null;
  const protocolOverrides =
    payload.protocol_overrides && typeof payload.protocol_overrides === "object" &&
      !Array.isArray(payload.protocol_overrides)
      ? (payload.protocol_overrides as Record<string, unknown>)
      : {};
  // The chosen model was resolved (and checked) before anything else, above.
  if (followedModel) modelValidationId = String(followedModel.id);
  const exploratory = payload.exploratory === true || !modelValidationId;
  // Whose share this run draws on: the app's asserted user (D28 — the app
  // authenticates against `approved_users`, so `userId`, the Supabase Auth
  // user, is usually null), and the bytes its series are expected to keep.
  const isUuid = (v: unknown): v is string =>
    typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const actorUserId = isUuid(payload.actor_user_id) ? payload.actor_user_id : userId;
  const bytesEstimate =
    typeof payload.bytes_estimate === "number" && Number.isFinite(payload.bytes_estimate) && payload.bytes_estimate > 0
      ? Math.round(payload.bytes_estimate)
      : 0;

  // Reuse-or-rerun (G17, §9.2) and the run row, in ONE statement since WP 10.4:
  // `create_simulation_run` computes the RunKey from engine ∥ graph ∥ policy ∥ the
  // scenario's whole run spec ∥ the overrides, and under an advisory lock on it
  // either offers a completed identical run (→ 409, never silent), attaches an
  // identical in-flight one (two clicks are one run — never for a browser run,
  // whose browser computes it), or inserts the queued row with every binding on
  // it. What ran is stamped on the run (audit F-11): the seed and the schedule.
  const forceRerun = payload.force_rerun === true;
  const clientComputeRun = payload.compute === "client";
  const stamp = runStamp(scenario as Record<string, unknown>);
  const runRow: Record<string, unknown> = {
    ...stamp,
    scenario_id: scenario.id,
    project_id: scenario.project_id,
    rep_count_target: replications,
    policy_version_id: policyVersionId,
    policy_hash: policyHash,
    dataset_version_id: datasetVersionId,
    graph_hash: graphHash,
    hash_simulation: simulationHash,
    created_by: opts.createdBy === undefined ? userId : opts.createdBy,
    scenario_hash: scenarioHash,
    model_validation_id: modelValidationId,
    gate_skipped: gateSkipped,
    engine_id: engineId,
    protocol_overrides: protocolOverrides,
    exploratory,
    actor_user_id: actorUserId,
    bytes_estimate: bytesEstimate,
    limits: opts.limits ?? {},
  };
  // `svc` is the dispatcher's service client (typed loosely in DispatchDeps).
  const created = await svc.rpc("create_simulation_run", {
    p_run: runRow,
    p_force_rerun: forceRerun,
    p_attach_inflight: !clientComputeRun,
    _actor_user_id: userId,
  });
  let run: { id: string } | null = null;
  let engine: Record<string, unknown> | null = null;
  if (!created.error) {
    const res = (created.data ?? {}) as Record<string, unknown>;
    if (res.reuse) {
      const c = res.reuse as Record<string, unknown>;
      throw new ReuseAvailable({
        run_id: String(c.run_id),
        ended_at: (c.ended_at as string | null) ?? null,
        created_at: String(c.created_at),
        code_version: (c.code_version as string | null) ?? null,
        rep_count_done: (c.rep_count_done as number | null) ?? null,
      });
    }
    if (res.attached === true) {
      // An identical run is already queued or running: this submission IS it.
      return { run_id: String(res.run_id), attached: true };
    }
    run = { id: String(res.run_id) };
    engine = (res.engine as Record<string, unknown> | null) ?? null;
  } else if (CAPACITY_STATUS[String(created.error.code ?? "")]) {
    throw new CapacityRefusal(CAPACITY_STATUS[String(created.error.code)], String(created.error.message ?? ""));
  } else if (!isMissingFunction(created.error)) {
    // An engine refusal (retired, unknown, ambiguous) is the caller's to see.
    throw new Error(`run not created: ${created.error.message ?? created.error}`);
  } else {
    // A database without `20261001000009`: the pre-WP-10.4 path, unchanged.
    console.error("create_simulation_run missing — dispatching on the pre-RunKey path (migration pending?)");
    if (!forceRerun && graphHash && scenarioHash) {
      try {
        const [cand] = await findReuseCandidates(svc, {
          scenario: { id: scenario.id as string, updated_at: scenario.updated_at },
          policyHash,
          graphHash,
          scenarioHash,
          replications,
        });
        if (cand) throw new ReuseAvailable(cand);
      } catch (e) {
        if (e instanceof ReuseAvailable) throw e;
        console.error("reuse check skipped (lookup failed)", e);
      }
    }
    const insertRun = (withStamp: boolean) =>
      // deno-lint-ignore no-explicit-any
      (svc as any).from("simulation_runs").insert({
        ...(withStamp ? stamp : {}),
        scenario_id: scenario.id,
        project_id: scenario.project_id,
        status: "queued",
        rep_count_target: replications,
        rep_count_done: 0,
        code_version: "",
        policy_version_id: policyVersionId,
        policy_hash: policyHash,
        dataset_version_id: datasetVersionId,
        graph_hash: graphHash,
        created_by: opts.createdBy === undefined ? userId : opts.createdBy,
        // Spread-guarded so a database without the B0 migration still inserts.
        ...(scenarioHash ? { scenario_hash: scenarioHash } : {}),
        ...(modelValidationId ? { model_validation_id: modelValidationId } : {}),
        ...(gateSkipped ? { gate_skipped: true } : {}),
      }).select().single();
    let { data: inserted, error: runErr } = await insertRun(true);
    if (runErr && isMissingStampColumn(runErr)) {
      console.error("run stamp columns missing — dispatching unstamped (migration pending?)", runErr);
      ({ data: inserted, error: runErr } = await insertRun(false));
    }
    if (runErr || !inserted) throw new Error(`run insert failed: ${runErr?.message}`);
    run = { id: String(inserted.id) };
  }

  // Browser/offline runs (payload.compute === "client") go through the same
  // gate + version binding + queued row, but the CLIENT computes and persists
  // the results itself — so don't wake the worker, or two writers would race
  // on the same run. Server runs (the default) enqueue for the Fly worker.
  const clientCompute = clientComputeRun;

  // Push command to worker queue for the real engine. The policy snapshot is
  // embedded so the worker runs the saved version, not the live tables; if the
  // envelope would exceed Upstash limits, the worker fetches it by version id.
  if (!clientCompute) {
    const workerEnvelope: Record<string, unknown> = {
      ...cmd,
      run_id: run.id,
      scenario,
      recovery,
      policy_version_id: policyVersionId,
      policy_hash: policyHash,
      policy_snapshot: snapshot,
      // §23 WP 13.2 — the key is ALWAYS present: the worker reads its absence
      // as an envelope from before the binding (the legacy live path).
      dataset_version_id: datasetVersionId,
      // WP 10.4 — the engine the run is bound to; the worker refuses a mismatch.
      ...(engine ? { engine } : {}),
      server_ts: Date.now(),
    };
    if (JSON.stringify(workerEnvelope).length > 700_000) {
      delete workerEnvelope.policy_snapshot;
    }
    const stream = `sim.cmd.${cmd.project_id}`;
    try {
      // Ensure the consumer group exists BEFORE the XADD: the worker creates
      // it at "$" when it first discovers a stream, so a message added before
      // that moment would never be delivered (the first command on any fresh
      // stream — the classic lost-first-run). BUSYGROUP means it's already
      // there, which is fine.
      await upstash([
        "XGROUP", "CREATE", stream, "sim-workers", "$", "MKSTREAM",
      ]).catch((e) => {
        if (!String(e).includes("BUSYGROUP")) throw e;
      });
      await upstash([
        "XADD", stream, "MAXLEN", "~", "1000", "*",
        "data", JSON.stringify(workerEnvelope),
      ]);
    } catch (e) {
      // A run that never reached the queue must not sit "queued" forever —
      // that black hole is indistinguishable from a dead worker. Fail loudly.
      console.error("enqueue failed", e);
      await (svc as any)
        .from("simulation_runs")
        .update({
          status: "failed",
          error_message: `enqueue to worker queue failed: ${String(e).slice(0, 300)}`,
          ended_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      throw new Error(`enqueue to worker queue failed: ${String(e).slice(0, 300)}`);
    }

    // Scale-to-zero: the command is on the stream — wake a stopped Fly worker
    // so it gets consumed. No-op when the worker is always-on or the wake creds
    // are unset; runs on both front doors (browser + /v1 API) via this path.
    fireWakeWorker();
  }

  // The worker is the SOLE authoritative writer of results: it sets the run to
  // running, upserts per-replication rows, and writes the aggregates + mapping
  // warnings. The dispatcher only creates the queued row and enqueues the
  // command — no stub KPIs (which previously masked bad data with fake numbers).
  return { run_id: run.id };
}

export async function dispatchExperimentCancel(
  deps: DispatchDeps,
  cmd: DispatchCommand,
): Promise<void> {
  const { svc, upstash } = deps;
  const runId = String((cmd.payload as Record<string, unknown>).run_id ?? "");
  if (!runId) throw new Error("run_id required");
  // Service role for the same reason as the run insert: the status flip must
  // not silently no-op on a database missing the anon-grants migration.
  // deno-lint-ignore no-explicit-any
  await (svc as any)
    .from("simulation_runs")
    .update({ status: "cancelled", ended_at: new Date().toISOString() })
    .eq("id", runId)
    .in("status", ["queued", "running"]);
  await upstash([
    "XADD",
    `sim.cmd.${cmd.project_id}`,
    "*",
    "data",
    JSON.stringify({ ...cmd, server_ts: Date.now() }),
  ]).catch((e) => console.error("xadd cancel failed", e));
  fireWakeWorker();  // wake a slept worker so it can act on the cancel
}

/** Enqueue a raw command envelope (add-reps and echo-style commands). */
export async function enqueueEnvelope(
  deps: Pick<DispatchDeps, "upstash">,
  projectId: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  await deps.upstash([
    "XADD",
    `sim.cmd.${projectId}`,
    "MAXLEN", "~", "1000",
    "*",
    "data",
    JSON.stringify(envelope),
  ]);
}

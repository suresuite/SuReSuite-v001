// The Simulation Lab's Model → Engine → Scenario → Settings → Run flow, as pure
// rules. Phase 10 / WP 10.5 / blueprint §9.1, §9.5.1.
//
// The Lab used to start from a scenario and attach whatever model happened to
// match it. It now starts from a CHOICE of Validated Model, and four rules decide
// everything the screen says about that choice — so the desktop page, the phone
// composition and the tests all read one answer:
//   - which models are offered, and which is chosen when nobody chose;
//   - what a run would deviate from the model's PROTOCOL, read off the scenario
//     the run would use (the engine runs the scenario row; the protocol is what
//     the model says that row should be) — the deviations are what the run records
//     as `protocol_overrides`, and what its results and exports show (T2, T4);
//   - how big the run is — replication-weeks, and the storage it will take;
//   - which runs a comparison defaults to: the same model's, never an
//     exploratory run as the baseline side.
import type { ModelValidationCard } from "@/hooks/useModelValidation";
import { REPLICATION_SERIES_FACTS } from "@/components/docs/generated/policy.generated";
import {
  defaultModel,
  modelChoices,
  modelRunOffer,
  overridesOf,
  protocolDeviations,
  type Deviation,
  type ModelRunOffer,
  type ScenarioRunSettings,
} from "../../../supabase/functions/_shared/modelRules";
import { modelCodeLine } from "@/lib/versions/versionLabels";

// ── the model choice ─────────────────────────────────────────────────────────

// `modelChoices` and `defaultModel` are stated once, in
// `supabase/functions/_shared/modelRules.ts`, and read by the chat as well
// (ai-agents.md §27 WP V.1).
export { modelChoices, defaultModel };

/** One line per model in the picker: its code, its data and policy codes when
 *  loaded, and its name — "2026Q3 - Data 20260915 - Policy 20261004 · Q4 baseline".
 *  The protocol is the line under the picker, not part of the name. */
export function modelOptionLabel(
  c: ModelValidationCard,
  refs?: { data?: string | null; policy?: string | null } | null,
): string {
  return modelCodeLine(c, refs);
}

// ── deviations from the protocol ─────────────────────────────────────────────

// The deviation rule is stated once, in `_shared/modelRules.ts` (§27 WP V.1).
export { protocolDeviations, overridesOf };
export type { ScenarioRunSettings, Deviation };

// ── how big the run is ───────────────────────────────────────────────────────

/** Replication-weeks: the unit compute is measured in (WP 10.7 meters it). */
export function replicationWeeks(replications: number, horizonDays: number): number {
  return Math.max(0, Math.round(replications)) * Math.max(0, Math.ceil(horizonDays / 7));
}

/** The weekly series every replication persists — scsim's `WEEKLY_SERIES`,
 *  published ones, read from the generated declaration (not restated). */
export const SERIES_PER_REPLICATION = REPLICATION_SERIES_FACTS.declared.filter((s) => s.published).length;

/** Bytes one weekly value costs in `run_replications.time_series` (jsonb number
 *  text plus separator) and one replication's fixed cost (its KPI row and keys).
 *  Declared, so the estimate says what it assumed. */
export const BYTES_PER_POINT = 10;
export const BYTES_PER_REPLICATION_FIXED = 2048;

export interface StorageEstimate {
  bytes: number;
  /** How the figure was computed, in words — the estimate's source (T1). */
  basis: string;
}

export function storageEstimate(replications: number, horizonDays: number): StorageEstimate {
  const weeks = Math.max(0, Math.ceil(horizonDays / 7));
  const reps = Math.max(0, Math.round(replications));
  const bytes = reps * (BYTES_PER_REPLICATION_FIXED + SERIES_PER_REPLICATION * weeks * BYTES_PER_POINT);
  return {
    bytes,
    basis:
      `${reps} replication(s) × (${SERIES_PER_REPLICATION} weekly series × ${weeks} weeks × ` +
      `${BYTES_PER_POINT} B + ${BYTES_PER_REPLICATION_FIXED} B for the KPI row)`,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── which runs compare ───────────────────────────────────────────────────────

export interface CompareCandidate {
  scenarioId: string;
  modelId: string | null;
  exploratory: boolean;
}

/** The scenarios a comparison offers by default: those whose newest completed run
 *  followed `modelId`. With `includeOtherModels`, every scenario with results, and
 *  each one from another model (or none) is labelled — allowed, never hidden. An
 *  exploratory run is never offered as the baseline side. */
export function compareScope(
  candidates: CompareCandidate[],
  modelId: string | null,
  includeOtherModels: boolean,
): { offered: CompareCandidate[]; baselineEligible: CompareCandidate[]; labelOf: (c: CompareCandidate) => string | null } {
  const same = (c: CompareCandidate) => modelId !== null && c.modelId === modelId && !c.exploratory;
  const offered = includeOtherModels || modelId === null ? candidates : candidates.filter(same);
  return {
    offered,
    baselineEligible: offered.filter((c) => !c.exploratory),
    labelOf: (c) =>
      c.exploratory ? "exploratory" : modelId !== null && c.modelId !== modelId ? "different model" : null,
  };
}

/**
 * run id → the model whose EVIDENCE it is. One run can be the evidence of
 * several models: a model saved again from the same run (a new name or period)
 * supersedes the old card and keeps its evidence. The run belongs to `chosenId`
 * when that is one of them, else to the NEWEST — `cards` arrive newest first,
 * and a last-wins map over them used to hand the run to the OLDEST, labelling
 * the chosen model's own validation baseline "different model".
 */
export function evidenceOwners(
  cards: { id: string; evidence_run_id: string | null }[],
  chosenId: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cards) {
    if (!c.evidence_run_id) continue;
    if (out[c.evidence_run_id] === undefined || c.id === chosenId) out[c.evidence_run_id] = c.id;
  }
  return out;
}

// ── what the plan leaves (WP 10.7 · §4 D247) ─────────────────────────────────

/** `get_my_capacity`'s answer: the organization's pool and the member's role
 *  share, with what each has used. NULL quota = unlimited. */
export interface CapacityState {
  org_id: string | null;
  role: string | null;
  pool: {
    compute_quota_rep_weeks_month: number | null;
    compute_used_rep_weeks: number;
    storage_quota_bytes: number | null;
    storage_used_bytes: number;
    max_concurrent_runs: number | null;
    active_runs: number;
    max_replications_per_run: number | null;
  };
  share: {
    compute_share_pct: number | null;
    storage_share_pct: number | null;
    max_concurrent: number | null;
    compute_used_rep_weeks: number;
    storage_used_bytes: number;
    active_runs: number;
  } | null;
}

export interface CapacityVerdict {
  /** what is left, in words, for the Run card */
  line: string;
  /** the refusal the database will give this run, forecast in its own order — null when it fits */
  refusal: string | null;
}

/** A quota and its use → what is left of the pool and of the role's share.
 *  The share is a percentage OF the pool, floored as the database floors it. */
function leftOf(quota: number | null, poolUsed: number, pct: number | null | undefined, shareUsed: number | undefined) {
  if (quota == null) return null;
  const pool = Math.max(0, quota - poolUsed);
  if (pct == null || shareUsed == null) return { left: pool, by: "organization" as const, cap: quota };
  const cap = Math.floor((quota * pct) / 100);
  const share = Math.max(0, cap - shareUsed);
  return share < pool ? { left: share, by: "share" as const, cap } : { left: pool, by: "organization" as const, cap: quota };
}

/** The Run card's forecast of `_capacity_admit`, which stays the authority: the
 *  same checks in the same order, so the card says before the click what the
 *  dispatcher would answer after it. */
export function capacityVerdict(
  s: CapacityState | null,
  run: { replications: number; repWeeks: number; bytes: number },
): CapacityVerdict {
  if (!s) return { line: "capacity unknown — the plan could not be read", refusal: null };
  const p = s.pool;
  const sh = s.share;
  const role = s.role ?? "member";
  const compute = leftOf(p.compute_quota_rep_weeks_month, p.compute_used_rep_weeks, sh?.compute_share_pct, sh?.compute_used_rep_weeks);
  const storage = leftOf(p.storage_quota_bytes, p.storage_used_bytes, sh?.storage_share_pct, sh?.storage_used_bytes);
  const parts: string[] = [];
  if (compute) {
    parts.push(
      `${compute.left.toLocaleString()} of ${compute.cap.toLocaleString()} replication-weeks left this month` +
        (compute.by === "share" ? ` (your ${role} share)` : ""),
    );
  }
  if (storage) {
    parts.push(`${formatBytes(storage.left)} of ${formatBytes(storage.cap)} storage left` + (storage.by === "share" ? ` (your ${role} share)` : ""));
  }
  const line = parts.length > 0 ? parts.join(" · ") : "no compute or storage limit on this plan";

  let refusal: string | null = null;
  const inFlightCap = p.max_concurrent_runs;
  if (p.max_replications_per_run != null && run.replications > p.max_replications_per_run) {
    refusal = `this run asks for ${run.replications} replications; the limit is ${p.max_replications_per_run} per run`;
  } else if (inFlightCap != null && p.active_runs >= inFlightCap) {
    refusal = `the organization has ${p.active_runs} runs queued or running; the limit is ${inFlightCap}`;
  } else if (inFlightCap != null && sh?.max_concurrent != null && sh.active_runs >= sh.max_concurrent) {
    refusal = `you have ${sh.active_runs} runs queued or running; your ${role} role allows ${sh.max_concurrent}`;
  } else if (compute && run.repWeeks > compute.left) {
    refusal = `this run needs ${run.repWeeks.toLocaleString()} replication-weeks; ${compute.left.toLocaleString()} are left`;
  } else if (storage && run.bytes > storage.left) {
    refusal = `this run is expected to keep ${formatBytes(run.bytes)}; ${formatBytes(storage.left)} is left — release pinned runs or let runs expire`;
  }
  return { line, refusal };
}

/**
 * PLAN.md §23 WP 13.3 — what the Lab may offer for a run of a Validated Model.
 *
 * A run of a model is dispatched with the MODEL's own dataset version and policy
 * version (the dispatcher enforces it), so a live project that has MOVED since
 * validation no longer makes the run unfaithful: it replays the validated data.
 * The user chooses — *run the validated versions*, or *run current data as
 * exploratory* (the model's policies on today's data, never a validated result).
 * Only what a replay cannot hold still blocks: the scenario's world or the engine
 * changed, or the model is no longer in force. A model recorded before models
 * named their dataset version cannot be replayed on moved data at all.
 */
export { modelRunOffer };
export type { ModelRunOffer };

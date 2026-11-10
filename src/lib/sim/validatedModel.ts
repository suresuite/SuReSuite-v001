// The Validated Model — what Run & Validate produces and the Lab consumes.
// Phase 10 / WP 10.3 / blueprint §9.5 · G13 · §4 D243, D244.
//
// Three things live here because both the save action and the card that shows
// the model need them, and a rule restated in a component is a rule with two
// authors:
//   - the PROTOCOL: how the model is run (seeds, CRN, warm-up, horizon, window,
//     CI, stopping rule). `protocolProblems` mirrors the database's one
//     statement of a complete protocol, `validated_model_protocol_problems`
//     (`20261001000008`); the database refuses what this refuses, and the
//     client only says so first.
//   - the WARM-UP across KPIs: the adopted week is the MAXIMUM detected over
//     the selected KPIs, each KPI's own week kept beside it — a model that is
//     steady for fill rate and still filling its backlog is not steady.
//   - the ADOPTION RULE: every selected KPI ran and passed, or — when no test
//     could run — an explicit, recorded face-validation statement. It used to
//     be "any one KPI passed" (§4 D244).
import { mser5, welchWarmup } from "./validationStats";
import type { ModelValidationCard } from "@/hooks/useModelValidation";
import { dataRef, modelCodeLine, policyRef, protocolText } from "@/lib/versions/versionLabels";

export type StoppingRule = "fixed_horizon" | "ci_halfwidth";

export interface ValidatedModelProtocol {
  replications: number;
  root_seed: number;
  crn: boolean;
  warmup_week: number;
  horizon_weeks: number;
  analysis_window_weeks: number;
  ci_level: number;
  ci_halfwidth_target: number | null;
  stopping_rule: StoppingRule;
  /** Set only on a card that predates protocols (backfilled by the migration). */
  backfilled?: boolean;
  /** The keys a backfilled protocol could not recover. */
  unknown?: string[];
}

/** The engine's clamp on replications in one run (sim-command). */
export const MAX_REPLICATIONS = 200;

export function buildProtocol(input: {
  replications: number;
  rootSeed: number;
  crn: boolean;
  warmupWeek: number;
  horizonWeeks: number;
  ciLevel: number;
  ciHalfwidthTarget: number | null;
  stoppingRule: StoppingRule;
}): ValidatedModelProtocol {
  return {
    replications: Math.round(input.replications),
    root_seed: Math.round(input.rootSeed),
    crn: input.crn,
    warmup_week: Math.round(input.warmupWeek),
    horizon_weeks: Math.round(input.horizonWeeks),
    analysis_window_weeks: Math.round(input.horizonWeeks) - Math.round(input.warmupWeek),
    ci_level: input.ciLevel,
    ci_halfwidth_target: input.ciHalfwidthTarget,
    stopping_rule: input.stoppingRule,
  };
}

const REQUIRED: Array<keyof ValidatedModelProtocol> = [
  "replications",
  "root_seed",
  "crn",
  "warmup_week",
  "horizon_weeks",
  "analysis_window_weeks",
  "ci_level",
  "ci_halfwidth_target",
  "stopping_rule",
];
const WHOLE: Array<keyof ValidatedModelProtocol> = [
  "replications",
  "root_seed",
  "warmup_week",
  "horizon_weeks",
  "analysis_window_weeks",
];

/** What is wrong with a protocol — `[]` when the database would accept it.
 *  Mirrors `validated_model_protocol_problems`, message for message. */
export function protocolProblems(p: Partial<ValidatedModelProtocol> | null | undefined): string[] {
  if (!p || typeof p !== "object") return ["protocol is not an object"];
  const rec = p as Record<string, unknown>;
  const unknown = new Set(Array.isArray(p.unknown) ? p.unknown : []);
  const backfilled = p.backfilled === true;
  const probs: string[] = [];
  for (const k of REQUIRED) {
    if (!(k in rec)) probs.push(`${k} is missing`);
    else if (rec[k] === null && !unknown.has(k) && k !== "ci_halfwidth_target") probs.push(`${k} is null`);
  }
  if (probs.length) return probs;
  for (const k of WHOLE) {
    const v = rec[k];
    if (typeof v === "number" && !Number.isInteger(v)) probs.push(`${k} is not a whole number`);
    else if (v !== null && typeof v !== "number") probs.push(`${k} is not a number`);
  }
  if (probs.length) return probs;
  const n = (k: keyof ValidatedModelProtocol) => (typeof rec[k] === "number" ? (rec[k] as number) : null);
  const reps = n("replications");
  if (reps !== null && reps < 1) probs.push("replications must be at least 1");
  else if (!backfilled && reps !== null && reps > MAX_REPLICATIONS)
    probs.push(`replications must be at most ${MAX_REPLICATIONS} (the engine's clamp)`);
  if ((n("root_seed") ?? 0) < 0) probs.push("root_seed must be non-negative");
  if (rec.crn !== null && typeof rec.crn !== "boolean") probs.push("crn must be true or false");
  if ((n("warmup_week") ?? 0) < 0) probs.push("warmup_week must be non-negative");
  const horizon = n("horizon_weeks");
  const window = n("analysis_window_weeks");
  const warm = n("warmup_week");
  if (horizon !== null && horizon < 1) probs.push("horizon_weeks must be at least 1");
  if (window !== null && window < 1) probs.push("analysis_window_weeks must be at least 1");
  if (!backfilled && horizon !== null && window !== null && warm !== null && warm + window > horizon)
    probs.push("warm-up plus analysis window exceeds the horizon");
  const ci = rec.ci_level;
  if (typeof ci === "number" && !(ci > 0.5 && ci < 1)) probs.push("ci_level must be between 0.5 and 1");
  else if (ci !== null && typeof ci !== "number") probs.push("ci_level is not a number");
  const eps = rec.ci_halfwidth_target;
  if (typeof eps === "number" && eps <= 0) probs.push("ci_halfwidth_target must be positive");
  else if (eps !== null && typeof eps !== "number") probs.push("ci_halfwidth_target is not a number");
  const rule = rec.stopping_rule;
  if (typeof rule === "string" && rule !== "fixed_horizon" && rule !== "ci_halfwidth")
    probs.push("stopping_rule must be fixed_horizon or ci_halfwidth");
  else if (rule !== null && typeof rule !== "string") probs.push("stopping_rule is not a string");
  if (rule === "ci_halfwidth" && typeof eps !== "number")
    probs.push("a ci_halfwidth stopping rule needs a ci_halfwidth_target");
  return probs;
}

/** The protocol in one line, as the Lab's model header shows it. */
export function protocolLine(p: Pick<ValidatedModelProtocol, "replications" | "warmup_week" | "horizon_weeks">): string {
  return protocolText(p);
}

// ── warm-up across KPIs ──────────────────────────────────────────────────────

export interface WarmupAcrossKpis {
  /** Each KPI's detected week; `null` when the run persisted no weekly series. */
  perKpi: Record<string, number | null>;
  /** The adopted week: the maximum over KPIs that HAVE a series (null if none). */
  adoptedWeek: number | null;
  /** The KPIs that could not be measured — said, never counted as week 0. */
  withoutSeries: string[];
}

export function warmupAcrossKpis(
  seriesByKpi: Record<string, number[][]>,
  method: "welch" | "mser5",
): WarmupAcrossKpis {
  const perKpi: Record<string, number | null> = {};
  const withoutSeries: string[] = [];
  for (const [kpi, series] of Object.entries(seriesByKpi)) {
    if (!series || series.length === 0 || series.every((s) => s.length === 0)) {
      perKpi[kpi] = null;
      withoutSeries.push(kpi);
      continue;
    }
    perKpi[kpi] = method === "welch" ? welchWarmup(series) : mser5(series);
  }
  const weeks = Object.values(perKpi).filter((w): w is number => w !== null);
  return { perKpi, adoptedWeek: weeks.length ? Math.max(...weeks) : null, withoutSeries };
}

// ── the adoption rule ────────────────────────────────────────────────────────

export interface AdoptionTest {
  kpi: string;
  /** Simulated sample size the test ran on; 0 means it could not run. */
  n: number;
  pass: boolean;
}

export interface AdoptionDecision {
  ready: boolean;
  basis: "statistical" | "face";
  /** Selected KPIs with no test that ran. */
  untested: string[];
  /** Selected KPIs whose test ran and failed. */
  failing: string[];
  /** Why it is not ready, in one sentence; `null` when ready. */
  reason: string | null;
}

export function adoptionDecision(input: {
  selectedKpis: string[];
  tests: AdoptionTest[];
  faceStatement: string;
}): AdoptionDecision {
  const ran = input.tests.filter((t) => t.n > 0);
  const byKpi = new Map(ran.map((t) => [t.kpi, t]));
  const untested = input.selectedKpis.filter((k) => !byKpi.has(k));
  const failing = input.selectedKpis.filter((k) => byKpi.get(k)?.pass === false);
  const statement = input.faceStatement.trim();
  if (ran.length === 0) {
    return statement
      ? { ready: true, basis: "face", untested, failing, reason: null }
      : {
          ready: false,
          basis: "face",
          untested,
          failing,
          reason: "No KPI could be tested — record a face-validation statement to adopt on face validity.",
        };
  }
  if (input.selectedKpis.length === 0) {
    return { ready: false, basis: "statistical", untested, failing, reason: "No KPI is selected." };
  }
  if (failing.length > 0) {
    return {
      ready: false,
      basis: "statistical",
      untested,
      failing,
      reason: `${failing.join(", ")} failed — a statement does not override a failing test.`,
    };
  }
  if (untested.length > 0) {
    return {
      ready: false,
      basis: "statistical",
      untested,
      failing,
      reason: `${untested.join(", ")} has no test — every selected KPI must pass, or be deselected.`,
    };
  }
  return { ready: true, basis: "statistical", untested, failing, reason: null };
}

// ── the Lab's opened-model line ──────────────────────────────────────────────

/** Why a model is stale, in words — one phrasing for the summary card and the
 *  Lab. Newer data or policy never mutates a model; it makes it stale. */
// Stated once in `supabase/functions/_shared/modelRules.ts` (ai-agents.md §27 WP V.1).
export { driftReasons } from "../../../supabase/functions/_shared/modelRules";
import { driftReasons } from "../../../supabase/functions/_shared/modelRules";

/** WP 11.3 — what a credibility's informational notes SAY. Never a reason to
 *  re-validate: `network` is a change the simulation does not read. */
export function noteReasons(notes: string[] | undefined): string[] {
  return (notes ?? []).map((n) => (n === "network" ? "the deep tier changed — not read by the simulation" : n));
}

/** A model's state in one phrase — the Lab's pill and the opened-model line say
 *  the same words. "valid" is the model's own word; a policy version that equals the
 *  live policies is "live", never this (the two used to share "in force"). */
export function modelStatusText(
  card: { status: "active" | "superseded" | "revoked" },
  credibility: { state: "validated" | "stale" | "unvalidated"; drift?: string[]; notes?: string[] } | null,
  supersededBy?: string | null,
): string {
  if (card.status === "revoked") return "revoked — not usable";
  if (card.status === "superseded") return supersededBy ? `superseded by ${supersededBy}` : "superseded by a newer model";
  if (credibility?.state === "stale" && (credibility.drift ?? []).every((d) => d === "data"))
    return "data changed since validation → a run replays the validated data";
  if (credibility?.state === "stale") return `${driftReasons(credibility.drift ?? []).join(" · ") || "stale"} → re-validate`;
  if (credibility?.state === "validated") return "valid";
  return "not matched to the live policy, data and scenario";
}

/** What the Lab says about the model a `?model=` link opened: its code, its
 *  protocol in one line, and its state (status, and derived drift — never stored). */
export function openedModelLine(
  card: {
    name?: string | null;
    version_no?: number | null;
    model_code?: string | null;
    status: "active" | "superseded" | "revoked";
    protocol?: Partial<ValidatedModelProtocol> | null;
  },
  credibility: { state: "validated" | "stale" | "unvalidated"; drift?: string[]; notes?: string[] },
): string {
  const proto = card.protocol
    ? protocolLine({
        replications: card.protocol.replications as number,
        warmup_week: card.protocol.warmup_week as number,
        horizon_weeks: card.protocol.horizon_weeks as number,
      })
    : "no protocol recorded";
  let state = modelStatusText(card, credibility);
  if (state === "valid") {
    const notes = noteReasons(credibility.notes);
    if (notes.length) state = `valid (${notes.join("; ")})`;
  }
  return `Model ${modelCodeLine(card)} · ${proto} · ${state}`;
}

// ── the summary card's lines (T1: no number without a source) ────────────────

export interface SummaryLine {
  label: string;
  /** What is shown; `null` = not recorded, and `reason` says why. */
  value: string | null;
  /** The column(s) the value is read from. */
  source: string;
  reason?: string;
}

export interface VersionRefs {
  /** The snapshot's own number (`dataset_versions.version_no`) — "snapshot v9". */
  graphVersionNo: number | null;
  policyVersionNo: number | null;
  /** WP 11.3 — the simulation scope's level version, "simulation inputs v4". */
  simulationVersionNo?: number | null;
  /** WP 10.5 follow-up — the stored codes, "Policy 20261004" / "Data 20260915". */
  policyCode?: string | null;
  simulationCode?: string | null;
}

export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 7) : null);
const short = shortHash;

/** The card's lines. Pure: every value is a field of `card` or `refs`. */
export function validatedModelLines(card: ModelValidationCard, refs: VersionRefs): SummaryLine[] {
  const p = card.protocol ?? null;
  const unknown = new Set(p?.unknown ?? []);
  const backfilled = p?.backfilled === true;
  const fromProtocol = (
    label: string,
    key: keyof NonNullable<ModelValidationCard["protocol"]>,
    fmt: (v: never) => string,
  ): SummaryLine => {
    const v = p?.[key];
    if (p == null) return { label, value: null, source: `model_validations.protocol`, reason: "no protocol on this model" };
    if (v == null)
      return {
        label,
        value: null,
        source: `model_validations.protocol.${String(key)}`,
        reason: unknown.has(String(key)) || backfilled ? "not recorded — the model predates protocols" : "not set",
      };
    return { label, value: fmt(v as never), source: `model_validations.protocol.${String(key)}` };
  };

  const lines: SummaryLine[] = [
    // WP 11.3 · §4 D259 — what the model BINDS first: the simulation's inputs, the
    // scope the engine reads. The snapshot it was validated on is kept, second.
    {
      label: "Data (simulation inputs)",
      value: card.hash_simulation
        ? refs.simulationVersionNo != null || refs.simulationCode
          ? `${dataRef({ version_code: refs.simulationCode, version_no: refs.simulationVersionNo })} · ${short(card.hash_simulation)}`
          : `${short(card.hash_simulation)} (version not loaded)`
        : null,
      source: "model_validations.simulation_version_id → graph_level_versions.version_code · hash_simulation",
      reason: "not recorded — the model has no snapshot to read its simulation inputs from, so it is matched on its snapshot",
    },
    {
      label: "Snapshot",
      value:
        refs.graphVersionNo != null
          ? `Snapshot v${refs.graphVersionNo} · ${short(card.graph_hash)}`
          : card.graph_hash
            ? `${short(card.graph_hash)} (version number not loaded)`
            : null,
      source: "model_validations.dataset_version_id → dataset_versions.version_no · graph_hash",
      reason: "no graph hash on this model",
    },
    {
      label: "Policy",
      value:
        refs.policyVersionNo != null || refs.policyCode
          ? `${policyRef({ version_code: refs.policyCode, version_no: refs.policyVersionNo })} · ${short(card.policy_hash)}`
          : card.policy_hash
            ? `${short(card.policy_hash)} (version not loaded)`
            : null,
      source: "model_validations.policy_version_id → policy_versions.version_code · policy_hash",
      reason: "no policy hash on this model",
    },
    {
      label: "Engine",
      value: card.engine_id ?? card.engine_fingerprint ?? null,
      source: "model_validations.engine_id · engine_fingerprint",
      reason: "not recorded — the evidence run carried no code_version",
    },
    fromProtocol("Run", "replications", (v: number) =>
      `${v} ${v === 1 ? "replication" : "replications"}${p?.root_seed != null ? ` · root seed ${p.root_seed}` : ""}${p?.crn != null ? ` · CRN ${p.crn ? "on" : "off"}` : ""}`,
    ),
    fromProtocol("Steady state from", "warmup_week", (v: number) => `week ${v}`),
    fromProtocol("Horizon", "horizon_weeks", (v: number) => `${v} weeks`),
    fromProtocol("Analysis window", "analysis_window_weeks", (v: number) => `${v} weeks`),
    fromProtocol("CI level / ε", "ci_level", (v: number) =>
      `${+(v * 100).toFixed(2)}%` +
        (p?.ci_halfwidth_target != null ? ` · ε ±${+(p.ci_halfwidth_target * 100).toFixed(2)}% of mean` : " · ε not set"),
    ),
    fromProtocol("Stopping rule", "stopping_rule", (v: string) =>
      v === "ci_halfwidth" ? "stop when the CI half-width reaches ε" : "fixed horizon",
    ),
    {
      label: "Validated",
      value: `${card.author_email ?? "author not recorded"} · ${new Date(card.validated_at).toLocaleString()} · basis ${card.basis}`,
      source: "model_validations.author_email · validated_at · basis",
    },
    {
      label: "Evidence",
      value:
        card.basis === "face"
          ? card.face_validation
            ? `statement: “${card.face_validation}”`
            : null
          : `${card.validation_tests.length} KPI test(s), all passed${card.evidence_run_id ? ` · run ${card.evidence_run_id.slice(0, 8)}` : ""}`,
      source:
        card.basis === "face"
          ? "model_validations.face_validation"
          : "model_validations.validation_tests · evidence_run_id → model_validation_evidence",
      reason: "not recorded — the model predates recorded statements",
    },
  ];
  // A line with a value carries no reason; only an unrecorded one explains itself.
  return lines.map((l) => (l.value == null ? l : { label: l.label, value: l.value, source: l.source }));
}

/** "newer graph/policy exists → re-validate", from the derived drift (never stored). */
export function staleMessage(
  credibility: { state: string; drift?: string[]; card?: unknown; engineChange?: string },
): string | null {
  if (credibility.state !== "stale") return null;
  // WP 15.6 · §4 D297 — "the engine changed" says WHAT changed when the change
  // record can. Never a reason to stay validated: an engine change still re-validates (O3).
  const parts = driftReasons(credibility.drift ?? []).map((p) =>
    p === "the engine changed" && credibility.engineChange ? `the engine changed (${credibility.engineChange})` : p,
  );
  return parts.length ? `${parts.join(" · ")} → re-validate` : null;
}

export function modelDeepLink(projectId: string, modelId: string): string {
  return `/simulation-lab?project=${encodeURIComponent(projectId)}&model=${encodeURIComponent(modelId)}`;
}


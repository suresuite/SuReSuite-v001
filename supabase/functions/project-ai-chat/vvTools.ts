// B3 V&V Analyst draft-tool family — Stage 3 (ai-agents.md §5.3, §4.5, §9.4).
//
// Three tools, registered into the shared executeTool registry (bridge 2):
//   * get_validation_status — read: list_model_validations + current_policy_hash
//     + current_graph_hash + scenario_fingerprint_hash, with the badge DERIVED
//     exactly as useModelValidation.tsx derives it (validated/stale/unvalidated
//     — computed, never stored).
//   * get_run_results — read: the reads useSimulationRun.tsx performs
//     (simulation_runs row + run_replications per-rep KPIs/series summary).
//   * draft_model_card_narrative — draft: the payload's `computed` block is
//     HANDLER-READ from the evidence run via _shared/vvEvidence.ts (§5.3
//     cardinal rule: computed, never asserted); the model contributes only
//     verdict/basis/narrative, downgraded to the honest combination by
//     applyVerdictDowngrade (§5.3 hard gate 3).
//
// Module layout note (ai-agents.md §10 Q21a/Q22): §9.4 homes these tools in
// draftTools.ts; they live in this sibling module for testability and are
// registered via the agentTurn.ts import — no contract change.

import {
  registerToolHandler,
  type ToolContext,
  type ToolDeclaration,
  type ToolEnvelope,
} from "./tools.ts";
import { loadGateDataset } from "../_shared/validationGate.ts";
import { flattenFindings } from "../_shared/grading.ts";
import { gradeDataset, loadPolicyDefaults } from "../_shared/itemMasterCandidates.ts";
import {
  applyVerdictDowngrade,
  buildComputedBlock,
  VV_CONFIDENCE,
  VV_TARGET_PRECISION,
  type ComputedBlock,
  type EvidenceRepRow,
  type EvidenceRunRow,
  type ValidationTest,
} from "../_shared/vvEvidence.ts";
import { canonicalJson, sha256Hex } from "./telemetry.ts";
import { deploymentEnabledAgents } from "./router.ts";
import {
  AGENT_COMMON,
  failureEnvelope,
  MAX_CITATIONS,
  MAX_PAYLOAD_BYTES,
  proposalEnvelope,
} from "./draftTools.ts";
import {
  getProjectMemoryDeclaration,
  loadActiveMemories,
  loadStaleContext,
  memoryContextBlock,
  memoryEnabled,
} from "./memory.ts";

export const VV_AGENT_ID = "vv-analyst";
export const VV_ARTIFACT_TYPE = "model_card_draft";
/** §10 Q10: prompt versioning — bumped on any §5.3 template change. */
export const VV_PROMPT_VERSION = 1;

/** §5.3 grounding-context budget (DEFAULT): 64 KB; per-rep series downsampled
 * to ≤ 200 points per rep (presentation only — the statistics in `computed`
 * come from FULL series via vvEvidence.ts). */
export const VV_CONTEXT_BUDGET = 64 * 1024;
export const VV_SERIES_MAX_POINTS = 200;
export const VV_NARRATIVE_MAX = 8000;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- declarations (§5.3 schemas, provider-safe subset) ----------

export const getValidationStatusDeclaration: ToolDeclaration = {
  name: "get_validation_status",
  description:
    "List the project's model-validation cards with their DERIVED badge (validated / stale / unvalidated, computed against the current policy/graph hashes — staleness is never stored). Includes verdict, basis, adopted warm-up, recommended replications and the evidence run id per card.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "superseded", "revoked", "all"],
        description: "Restrict by card lifecycle status. Default 'active'.",
      },
    },
  },
};

export const getRunResultsDeclaration: ToolDeclaration = {
  name: "get_run_results",
  description:
    "Read a simulation run's persisted results: status, provenance hashes, warm-up week, aggregate KPIs with CI half-widths, per-replication KPI rows, and which weekly series were recorded. Omit run_id for the project's most recent runs.",
  parameters: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "A specific simulation_runs id. Omit to list recent runs." },
      limit: { type: "number", description: "Max recent runs when run_id is omitted (1-20). Default 5." },
    },
  },
};

export const draftModelCardNarrativeDeclaration: ToolDeclaration = {
  name: "draft_model_card_narrative",
  description:
    "File ONE reviewable model-validation-card proposal for a COMPLETED evidence run. Every number on the card is computed by the platform from the run's persisted output — you contribute the verdict recommendation, the basis, and the narrative only. Call this once per adoption ask.",
  parameters: {
    type: "object",
    properties: {
      evidence_run_id: { type: "string", description: "The completed simulation_runs id the card adopts evidence from." },
      verdict: {
        type: "string",
        enum: ["validated", "rejected"],
        description: "Your recommendation. 'validated' only if all persisted tests passed and adequacy is met.",
      },
      basis: {
        type: "string",
        enum: ["statistical", "face"],
        description: "'statistical' requires persisted validation tests; otherwise 'face'.",
      },
      narrative_md: { type: "string", description: "Plain-language interpretation, citing each number to its source (max 8000 chars)." },
      title: { type: "string", description: "Card title (max 140 chars)." },
    },
    required: ["evidence_run_id", "verdict", "basis", "narrative_md"],
  },
};

/** The Analyst's complete least-privilege tool surface (§5.3): nothing else
 * is declared to the model. get_project_memory joins when M2 is on (§14.4). */
export function vvToolDeclarations(): ReadonlyArray<ToolDeclaration> {
  return [
    getValidationStatusDeclaration,
    getRunResultsDeclaration,
    ...(memoryEnabled() ? [getProjectMemoryDeclaration] : []),
    draftModelCardNarrativeDeclaration,
  ];
}

// ---------- §5.3 system-prompt template (verbatim) ----------

export function buildVvPrompt(args: {
  projectId: string;
  utterance: string;
  runSummaryJson: string;
  warmupJson: string;
  adequacyJson: string;
  testsJson: string;
  policyHash: string;
  graphHash: string;
  scenarioHash: string;
  activeCardJson: string;
  memoryBlock?: string;
}): string {
  const memory = args.memoryBlock ? `\n${args.memoryBlock}` : "";
  return `You are the V&V Analyst, the SuReSuite agent that interprets verification &
validation evidence and drafts model-validation cards for one project.

CONTEXT
- Project: ${args.projectId}
- Evidence run: ${args.runSummaryJson}
- Computed statistics (produced by the platform, not by you):
  warm-up: ${args.warmupJson}   replication adequacy: ${args.adequacyJson}
  validation tests: ${args.testsJson}
- Current hashes: policy ${args.policyHash}, graph ${args.graphHash}, scenario ${args.scenarioHash}
- Active card: ${args.activeCardJson}${memory}

TASK
- The user asked: "${args.utterance}"
- Interpretation: explain what the computed statistics mean for trusting this
  model, in plain language, citing each number to its source. You never
  recompute or adjust statistics; if a needed statistic is absent, say so.
- Adoption asks: call draft_model_card_narrative ONCE, copying every numeric
  field of "computed" EXACTLY from CONTEXT. Your contribution is the
  narrative and the recommendation, not the numbers. Recommend verdict
  "validated" only if all validation tests passed and adequacy is met;
  otherwise recommend "rejected" or basis "face" and say why.
- If there is no COMPLETED evidence run to adopt (none in CONTEXT, or the
  run-results read says there are none), do NOT call
  draft_model_card_narrative at all: say a card needs a completed run and
  offer to set one up. A card with no run id is refused, never filed.
- Reply in 2-6 sentences; end adoption replies with: the card must be
  reviewed and approved before it governs Lab runs.

${AGENT_COMMON}`;
}

// ---------- evidence loading (shared by context builder + draft handler) ----

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export async function loadEvidenceRun(
  db: Db,
  projectId: string,
  runId: string | null,
): Promise<{ run: EvidenceRunRow | null; reps: EvidenceRepRow[] }> {
  let run: EvidenceRunRow | null = null;
  if (runId) {
    const { data } = await db
      .from("simulation_runs")
      .select("*")
      .eq("id", runId)
      .eq("project_id", projectId)
      .maybeSingle();
    run = (data as EvidenceRunRow) ?? null;
  } else {
    const { data } = await db
      .from("simulation_runs")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(1);
    run = ((data ?? []) as EvidenceRunRow[])[0] ?? null;
  }
  if (!run) return { run: null, reps: [] };
  const { data: reps } = await db
    .from("run_replications")
    .select("rep_index,status,kpis,time_series")
    .eq("run_id", run.id)
    .order("rep_index", { ascending: true });
  return { run, reps: (reps ?? []) as EvidenceRepRow[] };
}

/** Tests already persisted from THIS evidence run (a prior card recorded from
 * the same run) — the only persisted source of statistical tests (§5.3;
 * see _shared/vvEvidence.ts header). */
export async function loadPersistedTests(
  db: Db,
  projectId: string,
  evidenceRunId: string,
): Promise<ValidationTest[]> {
  try {
    const { data } = await db
      .from("model_validations")
      .select("validation_tests,created_at")
      .eq("project_id", projectId)
      .eq("evidence_run_id", evidenceRunId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = ((data ?? []) as Array<{ validation_tests: unknown }>)[0];
    return Array.isArray(row?.validation_tests) ? (row!.validation_tests as ValidationTest[]) : [];
  } catch {
    return [];
  }
}

/** Exported for the §20.2 find_completed_run badge column (Phase H2) — one
 * derivation, one reader of the hash RPCs. */
export async function currentHashes(
  db: Db,
  projectId: string,
): Promise<{ policy: string; graph: string; simulation: string }> {
  const out = { policy: "unknown", graph: "unknown", simulation: "unknown" };
  try {
    const { data } = await db.rpc("current_policy_hash", { p_project_id: projectId });
    if (typeof data === "string" && data) out.policy = data;
  } catch { /* shown as unknown */ }
  try {
    const { data } = await db.rpc("current_graph_hash", { p_project_id: projectId });
    if (typeof data === "string" && data) out.graph = data;
  } catch { /* shown as unknown */ }
  // WP 11.2 · §4 D259 — the scope the engine READS, which a card's inputs are matched on.
  try {
    const { data } = await db.rpc("current_level_hash", { p_project_id: projectId, p_scope: "simulation" });
    if (typeof data === "string" && data) out.simulation = data;
  } catch { /* shown as unknown */ }
  return out;
}

function runSummary(run: EvidenceRunRow, repCount: number): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    reps_done: repCount,
    warmup_detected_at_weeks: run.warmup_detected_at,
    gate_skipped: Boolean(run.gate_skipped),
    policy_version_id: run.policy_version_id,
    policy_hash: run.policy_hash,
    scenario_id: run.scenario_id ?? null,
    scenario_hash: run.scenario_hash ?? null,
    dataset_version_id: run.dataset_version_id ?? null,
    code_version: run.code_version ?? null,
    aggregate_kpis: run.aggregate_kpis ?? {},
  };
}

/** Deterministic grounding-context builder (bridge 3, §5.3): the evidence
 * run's aggregates + computed stats + current hashes + the active card. */
export async function buildVvContext(
  ctx: ToolContext,
  args: { utterance: string },
): Promise<string> {
  const db = ctx.supabase as unknown as Db;
  const { run, reps } = await loadEvidenceRun(db, ctx.projectId, null);
  const hashes = await currentHashes(db, ctx.projectId);

  let warmupJson = "null";
  let adequacyJson = "null";
  let testsJson = "[]";
  let runJson = "null";
  if (run) {
    const persistedTests = await loadPersistedTests(db, ctx.projectId, run.id);
    const computed = buildComputedBlock({ run, reps, findings: [], persistedTests });
    warmupJson = JSON.stringify({
      adopted_warmup_days: computed.adopted_warmup_days,
      method: computed.warmup_method,
    });
    adequacyJson = JSON.stringify({
      confidence: VV_CONFIDENCE,
      target_precision: VV_TARGET_PRECISION,
      per_kpi: computed.replication_basis.per_kpi,
      recommended_replications: computed.recommended_replications,
      adequacy_met: computed.adequacy_met,
    });
    testsJson = JSON.stringify(computed.validation_tests);
    runJson = JSON.stringify(runSummary(run, reps.filter((r) => r.status === "done").length));
  }

  let activeCardJson = "null";
  let scenarioHash = "unknown";
  try {
    const { data: cards } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
    const active = (Array.isArray(cards) ? cards : []).find(
      (c: Record<string, unknown>) => c.status === "active",
    );
    if (active) activeCardJson = JSON.stringify(active);
  } catch { /* card is context, not a gate */ }
  if (run?.scenario_id) {
    try {
      const { data } = await db.rpc("scenario_fingerprint_hash", { p_scenario_id: run.scenario_id });
      if (typeof data === "string" && data) scenarioHash = data;
    } catch { /* shown as unknown */ }
  }

  let memoryBlock = "";
  if (memoryEnabled()) {
    try {
      const [rows, stale] = await Promise.all([
        loadActiveMemories(db, ctx.projectId),
        loadStaleContext(db, ctx.projectId),
      ]);
      memoryBlock = memoryContextBlock(rows, stale).block;
    } catch { /* memory is context, not a gate */ }
  }

  const prompt = buildVvPrompt({
    projectId: ctx.projectId,
    utterance: args.utterance.slice(0, 4000),
    runSummaryJson: runJson,
    warmupJson,
    adequacyJson,
    testsJson,
    policyHash: hashes.policy,
    graphHash: hashes.graph,
    scenarioHash,
    activeCardJson,
    memoryBlock,
  });
  return prompt.length <= VV_CONTEXT_BUDGET ? prompt : prompt.slice(0, VV_CONTEXT_BUDGET);
}

// ---------- read handlers ----------

/** Badge derivation exactly as useModelValidation.tsx::deriveCredibility:
 * active+validated card, drift computed against the CURRENT hashes. The ONE
 * implementation behind get_validation_status and the §20.2
 * find_completed_run "Validated" column (Phase H2). */
export function deriveValidationBadge(
  c: Record<string, unknown>,
  hashes: { policy: string; graph: string; simulation?: string },
): string {
  let badge = "unvalidated";
  if (c.status === "active" && c.verdict === "validated") {
    const drift: string[] = [];
    if (hashes.policy !== "unknown" && String(c.policy_hash) !== hashes.policy) drift.push("policy");
    // WP 11.2 · §4 D259 — the browser's rule (`cardInputsMatch`): a card that binds the
    // simulation scope drifts when THAT moves, never when only the deep tier did; a card
    // with no simulation hash keeps the composite rule. Unknown is never drift.
    const sim = typeof c.hash_simulation === "string" && c.hash_simulation ? c.hash_simulation : null;
    if (sim !== null) {
      const live = hashes.simulation ?? "unknown";
      if (live !== "unknown" && sim !== live) drift.push("data");
    } else if (hashes.graph !== "unknown" && String(c.graph_hash) !== hashes.graph) drift.push("data");
    badge = drift.length === 0 ? "validated" : `stale (${drift.join("+")} drift)`;
  }
  return badge;
}

async function getValidationStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "get_validation_status";
  const statusArg = ["active", "superseded", "revoked"].includes(String(args.status))
    ? String(args.status)
    : "active";
  const wantAll = String(args.status) === "all";
  try {
    const db = ctx.supabase as unknown as Db;
    const { data: cards, error } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
    if (error) throw new Error(error.message);
    const hashes = await currentHashes(db, ctx.projectId);
    const rows = (Array.isArray(cards) ? cards : []).filter(
      (c: Record<string, unknown>) => wantAll || String(c.status) === statusArg,
    );
    if (rows.length === 0) {
      return {
        kind: "text",
        data: "No model-validation cards on this project yet — run the Run & Validate pipeline on /policies to establish one.",
        meta: { tool, row_count: 0, note: "empty" },
      };
    }
    const derived = rows.map((c: Record<string, unknown>) => {
      const badge = deriveValidationBadge(c, hashes);
      return [
        String(c.id),
        badge,
        String(c.status),
        String(c.verdict),
        String(c.basis),
        Number(c.adopted_warmup_days ?? 0),
        Number(c.recommended_replications ?? 0),
        String(c.evidence_run_id ?? "-"),
        String(c.validated_at ?? "-"),
      ];
    });
    return {
      kind: "table",
      data: {
        columns: ["card_id", "badge", "status", "verdict", "basis", "adopted_warmup_days", "recommended_replications", "evidence_run_id", "validated_at"],
        rows: derived,
      },
      meta: { tool, row_count: derived.length },
    };
  } catch (e) {
    console.warn("get_validation_status failed:", (e as Error).message);
    return { kind: "text", data: "Validation-status read failed.", meta: { tool, row_count: 0, note: "error" } };
  }
}

/** A run's scalar KPI means as one readable cell ("fill_rate 0.9512 ·
 * max_backlog 104"), values verbatim. The underscore keys (`_meta`, `_range`)
 * are run metadata, not KPIs, and stay out — they were what rendered as a
 * JSON blob in the chat (ai-agents.md §20.8). */
export function kpiText(aggregate: unknown): string {
  if (!aggregate || typeof aggregate !== "object") return "-";
  const parts = Object.entries(aggregate as Record<string, unknown>)
    .filter(([k, v]) => !k.startsWith("_") && typeof v === "number" && Number.isFinite(v))
    .slice(0, 8)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(" · ") : "-";
}

async function getRunResults(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "get_run_results";
  const db = ctx.supabase as unknown as Db;
  try {
    if (typeof args.run_id === "string" && args.run_id) {
      if (!uuidRe.test(args.run_id)) {
        return { kind: "text", data: "run_id must be a uuid.", meta: { tool, row_count: 0, note: "error" } };
      }
      const { run, reps } = await loadEvidenceRun(db, ctx.projectId, args.run_id);
      if (!run) {
        return { kind: "text", data: `No run ${args.run_id} in this project.`, meta: { tool, row_count: 0, note: "empty" } };
      }
      const done = reps.filter((r) => r.status === "done");
      const kpiKeys = [...new Set(done.flatMap((r) => Object.keys(r.kpis ?? {})))].slice(0, 12);
      const rows: unknown[][] = [
        ["run", JSON.stringify(runSummary(run, done.length))],
        ...done.slice(0, 50).map((r) => [
          `rep ${r.rep_index}`,
          JSON.stringify(Object.fromEntries(kpiKeys.map((k) => [k, r.kpis?.[k]]))),
        ]),
      ];
      return {
        kind: "table",
        data: { columns: ["item", "value"], rows },
        meta: { tool, row_count: rows.length },
      };
    }

    const rawLimit = typeof args.limit === "number" ? args.limit : Number(args.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.floor(rawLimit))) : 5;
    const { data } = await db
      .from("simulation_runs")
      .select("*")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(limit);
    const runs = (data ?? []) as EvidenceRunRow[];
    if (runs.length === 0) {
      return { kind: "text", data: "No simulation runs on this project yet.", meta: { tool, row_count: 0, note: "empty" } };
    }
    // Which scenario each run simulated — without it a reader (person or
    // model) cannot tell a disruption run from a baseline, which is what sent
    // the persona digging through unrelated reads (ai-agents.md §20.8).
    const scenarioNames = new Map<string, string>();
    try {
      const ids = [...new Set(runs.map((r) => r.scenario_id).filter(Boolean))] as string[];
      if (ids.length > 0) {
        const { data: sc } = await db.from("scenarios").select("id,name").in("id", ids);
        for (const s of (sc ?? []) as Array<Record<string, unknown>>) scenarioNames.set(String(s.id), String(s.name ?? s.id));
      }
    } catch { /* the id column still identifies it */ }
    return {
      kind: "table",
      data: {
        columns: ["run_id", "scenario", "status", "reps_done", "warmup_week", "gate_skipped", "policy_version_id", "kpis"],
        rows: runs.map((r) => [
          r.id,
          r.scenario_id ? scenarioNames.get(String(r.scenario_id)) ?? String(r.scenario_id) : "-",
          r.status,
          Number(r.rep_count_done ?? 0),
          r.warmup_detected_at ?? "-",
          Boolean(r.gate_skipped),
          r.policy_version_id ?? "-",
          kpiText(r.aggregate_kpis),
        ]),
      },
      meta: { tool, row_count: runs.length },
    };
  } catch (e) {
    console.warn("get_run_results failed:", (e as Error).message);
    return { kind: "text", data: "Run-results read failed.", meta: { tool, row_count: 0, note: "error" } };
  }
}

// ---------- draft_model_card_narrative handler ----------

/** §4.5 idempotency core: evidence run + the substantive recommendation
 * (narrative/title are free-text and excluded, so re-phrasings converge). */
export async function vvIdempotencyKey(
  evidenceRunId: string,
  verdict: string,
  basis: string,
  computed: ComputedBlock,
): Promise<string> {
  const core = {
    schema_version: 1,
    evidence_run_id: evidenceRunId,
    verdict,
    basis,
    computed: {
      adopted_warmup_days: computed.adopted_warmup_days,
      warmup_method: computed.warmup_method,
      recommended_replications: computed.recommended_replications,
    },
  };
  return await sha256Hex(`${VV_AGENT_ID} ${VV_ARTIFACT_TYPE} ${canonicalJson(core)}`);
}

async function draftModelCardNarrative(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "draft_model_card_narrative";

  // §13.2 checkpoints 2-3: deployment kill switch + agent_proposals capability.
  if (!deploymentEnabledAgents().includes(VV_AGENT_ID)) {
    return failureEnvelope(tool, "agent_disabled", "The V&V Analyst agent is not enabled in this deployment.");
  }
  if (!ctx.draft || !ctx.draft.canProposals) {
    return failureEnvelope(tool, "agent_disabled", "Proposal drafting is not enabled for this account (agent_proposals).");
  }

  for (const k of Object.keys(args)) {
    if (!["evidence_run_id", "verdict", "basis", "narrative_md", "title"].includes(k)) {
      return failureEnvelope(tool, "invalid_params", `unknown parameter "${k}"`);
    }
  }
  const evidenceRunId = String(args.evidence_run_id ?? "");
  if (!uuidRe.test(evidenceRunId)) {
    return failureEnvelope(tool, "invalid_params", "evidence_run_id must be a uuid");
  }
  const claimedVerdict = String(args.verdict ?? "");
  if (claimedVerdict !== "validated" && claimedVerdict !== "rejected") {
    return failureEnvelope(tool, "invalid_params", `verdict must be "validated" or "rejected" (got "${claimedVerdict}")`);
  }
  const claimedBasis = String(args.basis ?? "");
  if (claimedBasis !== "statistical" && claimedBasis !== "face") {
    return failureEnvelope(tool, "invalid_params", `basis must be "statistical" or "face" (got "${claimedBasis}")`);
  }
  const narrative = String(args.narrative_md ?? "");
  if (!narrative.trim() || narrative.length > VV_NARRATIVE_MAX) {
    return failureEnvelope(tool, "invalid_params", `narrative_md must be a non-empty string (max ${VV_NARRATIVE_MAX} chars)`);
  }

  const db = ctx.supabase as unknown as Db;

  // §5.3 hard gate 1: a COMPLETED run of this project with per-rep rows.
  const { run, reps } = await loadEvidenceRun(db, ctx.projectId, evidenceRunId);
  if (!run) {
    return failureEnvelope(tool, "dependency_missing", `No run ${evidenceRunId} exists in this project.`);
  }
  if (run.status !== "done") {
    return failureEnvelope(
      tool,
      "dependency_missing",
      `Run ${evidenceRunId} is ${run.status} — a card needs a completed evidence run.`,
    );
  }
  const doneReps = reps.filter((r) => r.status === "done");
  if (doneReps.length === 0) {
    return failureEnvelope(
      tool,
      "dependency_missing",
      `Run ${evidenceRunId} has no completed replications — nothing to adopt evidence from.`,
    );
  }

  // §5.3 hard gate 2: the computed block is HANDLER-READ from persisted run
  // output — a hallucinated number cannot exist in the payload by construction.
  let findings: Array<Record<string, unknown>> = [];
  try {
    const [dataset, defaults] = await Promise.all([
      loadGateDataset(ctx.supabase, ctx.projectId),
      loadPolicyDefaults(ctx.supabase, ctx.projectId),
    ]);
    findings = flattenFindings(gradeDataset(dataset, defaults)).map(
      ({ severity, field, policy, rows, message }) => ({ severity, field, policy, rows, message }),
    );
  } catch { /* findings are card metadata; the grader may be re-run at adoption */ }
  const persistedTests = await loadPersistedTests(db, ctx.projectId, run.id);
  const computed = buildComputedBlock({ run, reps, findings, persistedTests });

  // §5.3 hard gate 3: verdict/basis consistency — downgrade to the honest
  // combination and note it (vv-03).
  const honest = applyVerdictDowngrade(
    { verdict: claimedVerdict as "validated" | "rejected", basis: claimedBasis as "statistical" | "face" },
    computed,
  );

  const payload = {
    schema_version: 1,
    prompt_version: VV_PROMPT_VERSION,
    evidence_run_id: run.id,
    verdict: honest.verdict,
    basis: honest.basis,
    downgrade_note: honest.downgrade_note,
    narrative_md: narrative,
    computed: {
      adopted_warmup_days: computed.adopted_warmup_days,
      warmup_method: computed.warmup_method,
      recommended_replications: computed.recommended_replications,
      replication_basis: computed.replication_basis,
      validation_tests: computed.validation_tests,
      findings: computed.findings,
    },
  };
  if (canonicalJson(payload).length > MAX_PAYLOAD_BYTES) {
    return failureEnvelope(tool, "too_large", "The card payload exceeds the 256 KB limit.");
  }

  // Citations (§4.3): the evidence run + the user's ask.
  const citations: Array<Record<string, unknown>> = [
    { kind: "run", ref: run.id },
    {
      kind: "user_message",
      ref: `thread:${ctx.draft.threadId ?? "current"}`,
      quote: ctx.draft.utterance.slice(0, 500),
    },
  ];
  if (persistedTests.length > 0) {
    citations.unshift({ kind: "table_rows", ref: "model_validations", rows: [run.id] });
  }
  if (citations.length > MAX_CITATIONS) citations.length = MAX_CITATIONS;

  // Grounding (§5.3): the evidence run's provenance triple.
  const grounding: Record<string, unknown> = {};
  if (run.policy_hash) grounding.policy_hash = run.policy_hash;
  if (run.scenario_hash) grounding.scenario_hash = run.scenario_hash;
  try {
    const { data: gh } = await db.rpc("current_graph_hash", { p_project_id: ctx.projectId });
    if (typeof gh === "string" && gh) grounding.graph_hash = gh;
  } catch { /* TTL still bounds the card */ }

  const idemKey = await vvIdempotencyKey(run.id, honest.verdict, honest.basis, computed);
  const title = (typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : `Model card: ${honest.verdict} (${honest.basis}) from run ${run.id.slice(0, 8)}`)
    .slice(0, 140);
  const summary =
    `verdict ${honest.verdict} · basis ${honest.basis} · warm-up ${computed.adopted_warmup_days}d (${computed.warmup_method}) · ` +
    `n* ${computed.recommended_replications}` +
    (honest.downgrade_note ? ` · downgraded: ${honest.downgrade_note}` : "");

  try {
    const { data: existing } = await ctx.supabase
      .from("proposals")
      .select("id,status,title")
      .eq("project_id", ctx.projectId)
      .eq("idempotency_key", idemKey)
      .in("status", ["draft", "proposed", "approved"])
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      return proposalEnvelope(tool, {
        proposal_id: String(existing.id),
        status: String(existing.status ?? "proposed"),
        title: String(existing.title ?? title),
        artifact_type: VV_ARTIFACT_TYPE,
        summary,
        provenance: "deterministic",
        duplicate: true,
      });
    }
  } catch { /* the RPC's own idempotency check still converges below */ }

  const { data: proposalId, error } = await ctx.supabase.rpc("create_agent_proposal", {
    p_project_id: ctx.projectId,
    p_agent_id: VV_AGENT_ID,
    p_artifact_type: VV_ARTIFACT_TYPE,
    p_title: title,
    p_payload: payload,
    p_citations: citations,
    // §5.3: `computed` is deterministic (handler-read); the card marks
    // narrative_md as AI-drafted next to the machine-printed verdict/basis.
    p_provenance: "deterministic",
    p_grounding: grounding,
    p_idempotency_key: idemKey,
    p_thread_id: ctx.draft.threadId,
    p_model_code: ctx.draft.modelCode,
    p_provider_code: ctx.draft.providerCode,
    p_user_id: ctx.userId,
    p_user_email: ctx.draft.userEmail,
    p_status: "proposed",
  });
  if (error) {
    const msg = String(error.message ?? "proposal creation failed");
    if (msg.includes("too_large")) return failureEnvelope(tool, "too_large", msg);
    console.error("create_agent_proposal failed:", msg);
    return { kind: "text", data: "Filing the proposal failed — try again.", meta: { tool, row_count: 0, note: "error" } };
  }

  return proposalEnvelope(tool, {
    proposal_id: String(proposalId),
    status: "proposed",
    title,
    artifact_type: VV_ARTIFACT_TYPE,
    summary,
    provenance: "deterministic",
  });
}

// Register into the shared executeTool registry (bridge 2).
registerToolHandler("get_validation_status", getValidationStatus);
registerToolHandler("get_run_results", getRunResults);
registerToolHandler("draft_model_card_narrative", draftModelCardNarrative);

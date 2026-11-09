// B4 Experiment Designer draft-tool family — Stage 4, single-run subset
// (ai-agents.md §5.4, §4.5, §9.5, §9.8 Phase 1).
//
// One new tool, registered into the shared executeTool registry (bridge 2):
//   * draft_experiment_spec — draft: compiles a decision question into a typed
//     experiment specification bound to a SAVED policy version. Hard gates at
//     draft time (§5.4): the policy version exists and belongs to the project;
//     replications clamp 1-200 (the dispatch.ts clamp restated); disruption
//     schedule ≤ 5 events (engine G11 boundary); acknowledge_warnings is
//     FORCED false regardless of what the model sends — only the approving
//     human can flip it, on the card; a READ-ONLY validation-gate preview
//     (the same runValidationGate the dispatcher enforces) is attached as
//     findings_preview so the reviewer sees what apply will face.
//   * Reads are the Stage 2/3 shared tools (§5.4 least-privilege table):
//     get_run_results + get_validation_status (vvTools.ts), get_policy_config
//     (configuratorTools.ts) — declared here, registered by their modules.
//
// Apply = scenario write path + dispatchExperimentRun (§4.4 experiment_spec
// row) in agent-apply/experimentSpecApply.ts — NEVER a parallel dispatch.
// Simulation results, KPIs and rankings are never LLM-generated: the spec
// dispatches, the engine computes.
//
// Module layout note (ai-agents.md §10 Q21a/Q22): §9.5 homes this tool in
// draftTools.ts; it lives in this sibling module for testability and is
// registered via the agentTurn.ts import — no contract change.

import {
  registerToolHandler,
  type ToolContext,
  type ToolDeclaration,
  type ToolEnvelope,
} from "./tools.ts";
import { loadGateDataset, runValidationGate, type GateFinding } from "../_shared/validationGate.ts";
import { findReuseCandidates, type ReuseCandidate } from "../_shared/dispatch.ts";
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
  currentHashes,
  deriveValidationBadge,
  getRunResultsDeclaration,
  getValidationStatusDeclaration,
} from "./vvTools.ts";
import { getPolicyConfigDeclaration } from "./configuratorTools.ts";
import {
  getProjectMemoryDeclaration,
  loadActiveMemories,
  loadStaleContext,
  memoryContextBlock,
  memoryEnabled,
} from "./memory.ts";
// H3 (§21): the plan tool joins the closed-loop set behind PLAN_TOOL_ENABLED
// (which itself requires CHAT_STORE_ENABLED — planTools.ts refuses
// otherwise), and the §20.4 PLAN block is serialized from the thread's
// active chat_plans row. Importing planTools registers update_task_plan
// into the shared executeTool registry (bridge 2).
import { buildPlanBlock, planToolEnabled, updateTaskPlanDeclaration } from "./planTools.ts";

export const EXPERIMENT_AGENT_ID = "experiment-designer";
export const EXPERIMENT_ARTIFACT_TYPE = "experiment_spec";
/** §10 Q10: prompt versioning — bumped on any §5.4 template change. */
export const EXPERIMENT_PROMPT_VERSION = 1;

/** §5.4 grounding-context budgets (DEFAULT): scenarios ≤ 16 KB, saved policy
 * versions ≤ 8 KB, validation cards + hashes ≤ 8 KB, recent runs ≤ 24 KB;
 * total 64 KB. */
export const EXPERIMENT_SCENARIOS_BUDGET = 16 * 1024;
export const EXPERIMENT_VERSIONS_BUDGET = 8 * 1024;
export const EXPERIMENT_VALIDATION_BUDGET = 8 * 1024;
export const EXPERIMENT_RUNS_BUDGET = 24 * 1024;
export const EXPERIMENT_CONTEXT_BUDGET = 64 * 1024;

/** §5.4 hard gates (restated dispatch.ts bounds). */
export const REPLICATIONS_MIN = 1;
export const REPLICATIONS_MAX = 200;
export const DISRUPTION_EVENTS_MAX = 5;

/** OWNER DECISION 2026-11-09 (ai-agents.md §10 entry 38(ad)): a run proposed
 * from the chat uses at most this many replications unless the user's own
 * message states a count — then that count is used (still ≤ the 200 clamp).
 * Enforced in the draft handler, so neither the §20.8 loop nor the
 * model-driven B4 turn can exceed it on its own judgement (before this, the
 * default was the validated card's recommendation: 161 on the owner's project). */
export const AGENT_REPLICATIONS_DEFAULT_CAP = 5;

/** A replication count the user stated in their own words ("with 30
 * replications", "50 reps"), or null. Only the user's message counts —
 * never the model's arguments. */
export function statedReplications(utterance: string | null | undefined): number | null {
  const m = String(utterance ?? "").match(/\b(\d{1,3})\s*(?:replications?|reps?)\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : null;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §9.5 experiment-type flag: `AGENT_EXPERIMENT_TYPES=single` grows to
 * `single,comparison,doe,battery` as blueprint Phase C lands each. Default
 * OFF (empty) — flag off ⇒ the draft tool refuses and Stage 0-3 behavior is
 * untouched. */
export function experimentTypesEnabled(): string[] {
  return (Deno.env.get("AGENT_EXPERIMENT_TYPES") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** §20 closed decision loop flag (Phase H2). Off ⇒ §5.4 v1 behavior
 * byte-identically: the v1 prompt, the v1 tool surface, no draft-time
 * cache-hit guard (the §9 kill-switch convention). */
export function closedLoopEnabled(): boolean {
  return (Deno.env.get("CLOSED_LOOP_ENABLED") ?? "").trim().toLowerCase() === "true";
}

// ---------- §5.4 output contract (verbatim JSON Schema) ----------

/** The §5.4 `draft_experiment_spec` parameter schema, VERBATIM. The handler
 * below enforces it deterministically (providers get the provider-safe
 * declaration; this constant is the contract fixtures pin). */
export const DRAFT_EXPERIMENT_SPEC_SCHEMA = {
  "$id": "https://suresuite.dev/schemas/draft_experiment_spec.v1.json",
  "type": "object",
  "required": ["policy_version_id", "replications"],
  "properties": {
    "scenario_id": { "type": "string", "format": "uuid" },
    "new_scenario": {
      "type": "object",
      "required": ["name", "horizon_days"],
      "properties": {
        "name": { "type": "string", "maxLength": 120 },
        "horizon_days": { "type": "integer", "minimum": 7, "maximum": 3650 },
        "disruption_schedule": { "type": "array", "maxItems": 5, "items": { "type": "object" } },
        "recovery_overrides": { "type": "object" }
      },
      "additionalProperties": false
    },
    "policy_version_id": { "type": "string", "format": "uuid" },
    "replications": { "type": "integer", "minimum": 1, "maximum": 200 },
    "acknowledge_warnings": { "type": "boolean", "default": false },
    "title": { "type": "string", "maxLength": 140 },
    "question": { "type": "string", "maxLength": 500 }
  },
  "oneOf": [{ "required": ["scenario_id"] }, { "required": ["new_scenario"] }],
  "additionalProperties": false
} as const;

// ---------- declarations (§5.4 schema, provider-safe subset) ----------

export const draftExperimentSpecDeclaration: ToolDeclaration = {
  name: "draft_experiment_spec",
  description:
    "File ONE reviewable experiment-specification proposal: a single scenario run bound to a SAVED policy version (never live tables). Provide EITHER scenario_id (an existing scenario from CONTEXT) OR new_scenario (name + horizon_days, optional disruption_schedule of at most 5 events). Replications: use 5 unless the user's message states a count, then use that count (1-200); the platform caps an unstated count at 5. The platform pre-checks the dispatch gate and attaches the findings; you cannot acknowledge warnings — only the approving reviewer can. Call this once per design ask.",
  parameters: {
    type: "object",
    properties: {
      scenario_id: {
        type: "string",
        description: "An existing scenarios id from CONTEXT. Mutually exclusive with new_scenario.",
      },
      new_scenario: {
        type: "object",
        description: "Define a new scenario instead of reusing one. Mutually exclusive with scenario_id.",
        properties: {
          name: { type: "string", description: "Scenario name (max 120 chars)." },
          horizon_days: { type: "number", description: "Simulation horizon in days (7-3650)." },
          disruption_schedule: {
            type: "array",
            description:
              "At most 5 disruption events: {target, target_type ('node'|'edge'), start_day, duration_days, magnitude_pct}.",
            items: { type: "object" },
          },
          recovery_overrides: { type: "object", description: "Recovery-policy overrides for this scenario." },
        },
        required: ["name", "horizon_days"],
      },
      policy_version_id: {
        type: "string",
        description: "The SAVED policy version to bind (from CONTEXT). Runs never use live policy tables.",
      },
      replications: { type: "number", description: "Replication count (1-200)." },
      acknowledge_warnings: {
        type: "boolean",
        description: "Always send false. Warning acknowledgment belongs to the human reviewer on the card.",
      },
      title: { type: "string", description: "Card title (max 140 chars)." },
      question: { type: "string", description: "The decision question this run answers (max 500 chars)." },
    },
    required: ["policy_version_id", "replications"],
  },
};

/** §20.2 (Phase H2): the cache-first read — the read-path twin of the G17
 * reuse check. Same identity, same tables, zero mutation: no parameter can
 * cause a dispatch. Joins the B4 closed-loop set always (below) and the
 * persona set when the router says cache_checkable (§6.6 rule 1, index.ts). */
export const findCompletedRunDeclaration: ToolDeclaration = {
  name: "find_completed_run",
  description:
    "Check whether a COMPLETED simulation run already answers the asked result, BEFORE proposing anything: matches the stored runs' provenance hashes (policy/graph/scenario) against the project's current state — the same identity the dispatcher's reuse check uses. Returns the matching runs (newest first, with their validation badge) on a hit; note cache_miss when nothing matches; note cache_stale naming the drifted hash when the data changed since a stored run. Read-only — it never dispatches anything.",
  parameters: {
    type: "object",
    properties: {
      scenario: {
        type: "string",
        description:
          "Scenario id or name fragment (resolved against this project's scenarios). May be omitted when the project has a single scenario.",
      },
      policy_version_id: {
        type: "string",
        description:
          "A SAVED policy version id (from CONTEXT). Defaults to the project's newest saved version.",
      },
      replications: {
        type: "number",
        description:
          "Minimum completed replications required (1-200). Default 1 — any completed run of at least n reps.",
      },
    },
  },
};

/** The Designer's complete least-privilege tool surface (§5.4): nothing else
 * is declared to the model. get_project_memory joins when M2 is on (§14.4);
 * find_completed_run joins the closed-loop set always (§20.2 — flag off ⇒
 * the v1 surface byte-identically). */
export function experimentToolDeclarations(): ReadonlyArray<ToolDeclaration> {
  return [
    // H3 (§21.1): the plan tool leads the set — the §20.4 loop calls it
    // before any other tool when the work spans a step boundary. Only the
    // closed-loop turn ever sees it (PLAN_TOOL_ENABLED ∧ CLOSED_LOOP_ENABLED;
    // both off ⇒ the pre-H3 surface byte-identically).
    ...(closedLoopEnabled() && planToolEnabled() ? [updateTaskPlanDeclaration] : []),
    ...(closedLoopEnabled() ? [findCompletedRunDeclaration] : []),
    getRunResultsDeclaration,
    getValidationStatusDeclaration,
    getPolicyConfigDeclaration,
    ...(memoryEnabled() ? [getProjectMemoryDeclaration] : []),
    draftExperimentSpecDeclaration,
  ];
}

// ---------- §5.4 system-prompt template (verbatim) ----------

export function buildExperimentPrompt(args: {
  projectId: string;
  utterance: string;
  scenariosJson: string;
  policyVersionsJson: string;
  validationJson: string;
  runsJson: string;
  memoryBlock?: string;
}): string {
  const memory = args.memoryBlock ? `\n${args.memoryBlock}` : "";
  return `You are the Experiment Designer, the SuReSuite agent that compiles decision
questions into reviewable experiment specifications for one project.

CONTEXT
- Project: ${args.projectId}
- Scenarios: ${args.scenariosJson}
- Saved policy versions: ${args.policyVersionsJson}
- Validation cards and current hashes: ${args.validationJson}
- Recent runs: ${args.runsJson}${memory}

TASK
- The user asked: "${args.utterance}"
- Design asks: choose or define the scenario, bind a SAVED policy version
  (never live tables), set replications (5, unless the user stated a
  count — then that count, 1-200), and call draft_experiment_spec
  ONCE.
- Do NOT draft, and do not reshape the ask into one you can draft:
  If the ask needs an experiment type the platform has not shipped
  (comparison, DOE, battery), say exactly that and offer the nearest single
  run. "Compare A against B" is a comparison — offering it as one run is
  the failure this rule exists to prevent, not a workaround for it. So is
  drafting ONE arm of it now (a "baseline", a "control arm", a "checkpoint
  for a later comparison"): say the comparison is not shipped, and draft
  nothing unless the user then asks for that single run on its own.
- Brief asks: report ONLY numbers present in run results from CONTEXT or
  tools, each with its run id and credibility badge. Differences between
  runs are DESCRIPTIVE unless a paired statistic is persisted — say which.
- Reply in 2-6 sentences. Never present a projection as a result.

${AGENT_COMMON}`;
}

// ---------- §20.4 closed-loop system prompt (verbatim; Phase H2) ----------

/** The §20.4 template, verbatim, superseding §5.4's when CLOSED_LOOP_ENABLED.
 * Written for the weakest enabled model (law 7): one decision per numbered
 * rule, every branch named, all facts arriving in CONTEXT or tool results.
 * `planBlock` is the §21.3 PLAN block, serialized from the thread's active
 * chat_plans row when PLAN_TOOL_ENABLED (H3) — empty otherwise, keeping the
 * H2 prompt byte-identical. */
export function buildClosedLoopPrompt(args: {
  projectId: string;
  scenariosJson: string;
  policyVersionsJson: string;
  validationJson: string;
  runsJson: string;
  planBlock?: string;
}): string {
  const plan = args.planBlock ? `\n${args.planBlock}` : "";
  return `You are the Experiment Designer, the SuReSuite agent that answers decision
questions from simulation evidence for one project. You follow a fixed loop.

CONTEXT
- Project: ${args.projectId}
- Scenarios: ${args.scenariosJson}
- Saved policy versions: ${args.policyVersionsJson}
- Validation cards and current hashes: ${args.validationJson}
- Recent runs: ${args.runsJson}${plan}

THE LOOP — follow these steps IN ORDER, one at a time:
1. UNDERSTAND. Identify the scenario and policy version the question needs.
   If an entity name matches more than one candidate, ask ONE short
   "did you mean" question and stop.
2. PLAN. If answering needs more than one step (an approval, a new run),
   call update_task_plan ONCE with every step you foresee, before any other
   tool. If the answer may already exist, step 1 of the plan is the cache
   check. Single-step answers need no plan.
3. CHECK THE CACHE. Call find_completed_run for the scenario + policy
   version BEFORE drafting anything.
   - HIT: do NOT draft a proposal. Call get_run_results (and
     get_validation_status) for that run and go to step 5.
   - STALE (note cache_stale): say the data changed since that run, name
     which hash drifted, and ask whether to re-run. Do not draft unless the
     user already asked to proceed.
   - MISS: go to step 4.
4. PROPOSE THE RUN. Call draft_experiment_spec ONCE (rules of your §5.4
   contract: bind a SAVED policy version, replications 1-200, never set
   acknowledge_warnings). Mark the plan step awaiting_approval. Tell the
   user the card must be approved before anything runs, then STOP — the
   conversation resumes after approval and run completion.
5. ANSWER FROM EVIDENCE. Report ONLY numbers present in tool results from
   THIS turn. Cite every factual sentence with [n] markers bound to the
   evidence list (run id + hashes). Name the run's credibility badge, and
   name the engine that produced it in the words "engine version
   <the Engine column>" — you are not told which engine is deployed now,
   so say the result is from that engine version, never that it is current.
   Close every plan step (done / failed / refused) via update_task_plan.

${AGENT_COMMON}`;
}

// ---------- grounding-context builder (bridge 3, §5.4) ----------

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

function clampJson(value: unknown, budget: number): string {
  const s = JSON.stringify(value ?? null);
  return s.length <= budget ? s : s.slice(0, budget) + "…";
}

interface ScenarioRow {
  id: string;
  name: string;
  horizon_days?: number;
  replications?: number;
  disruption_schedule?: Array<Record<string, unknown>>;
  project_id?: string;
  [k: string]: unknown;
}

function scenarioSummary(s: ScenarioRow): Record<string, unknown> {
  const events = Array.isArray(s.disruption_schedule) ? s.disruption_schedule : [];
  return {
    id: s.id,
    name: s.name,
    horizon_days: s.horizon_days ?? null,
    replications: s.replications ?? null,
    disruption_events: events.length,
    disruption_summary: events.slice(0, DISRUPTION_EVENTS_MAX).map((e) => ({
      target: e.target ?? null,
      start_day: e.start_day ?? null,
      duration_days: e.duration_days ?? null,
      magnitude_pct: e.magnitude_pct ?? null,
    })),
  };
}

/** Deterministic grounding-context builder (§5.4): scenario list ≤ 16 KB,
 * saved policy versions ≤ 8 KB, active validation cards + current hashes
 * ≤ 8 KB, recent runs ≤ 24 KB; 64 KB total. Project artifacts only — never
 * chat history (statelessness law §3.4-5). */
export async function buildExperimentContext(
  ctx: ToolContext,
  args: { utterance: string },
): Promise<string> {
  const db = ctx.supabase as unknown as Db;

  let scenariosJson = "[]";
  try {
    const { data } = await db
      .from("scenarios")
      .select("*")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(20);
    scenariosJson = clampJson(((data ?? []) as ScenarioRow[]).map(scenarioSummary), EXPERIMENT_SCENARIOS_BUDGET);
  } catch { /* shown as empty */ }

  let versionsJson = "[]";
  try {
    const { data } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
    const rows = (Array.isArray(data) ? data : []).slice(0, 10).map((v: Record<string, unknown>) => ({
      id: v.id,
      label: v.label ?? null,
      policy_hash: v.policy_hash ?? null,
      created_at: v.created_at ?? null,
    }));
    versionsJson = clampJson(rows, EXPERIMENT_VERSIONS_BUDGET);
  } catch { /* shown as empty */ }

  let validationJson = "null";
  try {
    const hashes: Record<string, string> = {};
    try {
      const { data } = await db.rpc("current_policy_hash", { p_project_id: ctx.projectId });
      if (typeof data === "string" && data) hashes.policy_hash = data;
    } catch { /* omitted */ }
    try {
      const { data } = await db.rpc("current_graph_hash", { p_project_id: ctx.projectId });
      if (typeof data === "string" && data) hashes.graph_hash = data;
    } catch { /* omitted */ }
    const { data: cards } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
    const active = (Array.isArray(cards) ? cards : [])
      .filter((c: Record<string, unknown>) => c.status === "active")
      .slice(0, 5)
      .map((c: Record<string, unknown>) => ({
        id: c.id,
        verdict: c.verdict,
        basis: c.basis,
        policy_version_id: c.policy_version_id,
        policy_hash: c.policy_hash,
        graph_hash: c.graph_hash,
        scenario_hash: c.scenario_hash,
        adopted_warmup_days: c.adopted_warmup_days,
        recommended_replications: c.recommended_replications,
      }));
    validationJson = clampJson({ current_hashes: hashes, active_cards: active }, EXPERIMENT_VALIDATION_BUDGET);
  } catch { /* shown as null */ }

  let runsJson = "[]";
  try {
    const { data } = await db
      .from("simulation_runs")
      .select("*")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(10);
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      status: r.status,
      reps_done: r.rep_count_done ?? 0,
      scenario_id: r.scenario_id ?? null,
      policy_version_id: r.policy_version_id ?? null,
      model_validation_id: r.model_validation_id ?? null,
      aggregate_kpis: r.aggregate_kpis ?? {},
    }));
    runsJson = clampJson(rows, EXPERIMENT_RUNS_BUDGET);
  } catch { /* shown as empty */ }

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

  // H3 (§21.2/§21.4): the PLAN block — serialized fresh from the thread's
  // active chat_plans row on EVERY turn (thread state, not model memory; a
  // mid-plan model switch re-reads the same row). Empty until a plan exists.
  let planBlock = "";
  if (closedLoopEnabled() && planToolEnabled()) {
    planBlock = await buildPlanBlock(db, ctx.draft?.threadId ?? null, ctx.userId);
  }

  // §20.4 (Phase H2): behind CLOSED_LOOP_ENABLED the closed-loop template
  // supersedes §5.4's — same grounding context, the ordered-loop discipline
  // in place of the TASK block. Flag off ⇒ the v1 prompt byte-identically.
  const prompt = closedLoopEnabled()
    ? buildClosedLoopPrompt({
      projectId: ctx.projectId,
      scenariosJson,
      policyVersionsJson: versionsJson,
      validationJson,
      runsJson,
      planBlock,
    })
    : buildExperimentPrompt({
      projectId: ctx.projectId,
      utterance: args.utterance.slice(0, 4000),
      scenariosJson,
      policyVersionsJson: versionsJson,
      validationJson,
      runsJson,
      memoryBlock,
    });
  return prompt.length <= EXPERIMENT_CONTEXT_BUDGET ? prompt : prompt.slice(0, EXPERIMENT_CONTEXT_BUDGET);
}

// ---------- §20.2 find_completed_run handler (Phase H2) ----------

/** The read-path identity inputs (§20.2): the bound version's policy_hash,
 * `current_graph_hash(project)` (20260703000001) and
 * `scenario_fingerprint_hash(scenario)` (20260710000001). Unlike the
 * dispatcher this NEVER snapshots — a pure read of current state. Returns
 * null when a hash RPC is unavailable (a pre-migration database). */
async function resolveRunIdentity(
  db: Db,
  projectId: string,
  scenario: ScenarioRow,
  version: { policy_hash?: unknown; snapshot?: unknown },
): Promise<{ policyHash: string; graphHash: string; simulationHash: string | null; scenarioHash: string } | null> {
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
  const policyHash: string = (version.policy_hash as string | null) ??
    (await sha256Hex(canonicalJson(snapshot)));
  let graphHash = "";
  let simulationHash: string | null = null;
  let scenarioHash = "";
  try {
    const { data } = await db.rpc("current_graph_hash", { p_project_id: projectId });
    if (typeof data === "string" && data) graphHash = data;
  } catch { /* reported as unavailable below */ }
  // WP 11.2 · §4 D260 — what RunKey v2 hashes: the simulation scope. A database
  // without the scope answers nothing here, and the reuse lookup then falls back to
  // the three-hash predicate on the composite (the deploy window).
  try {
    const { data } = await db.rpc("current_level_hash", { p_project_id: projectId, p_scope: "simulation" });
    if (typeof data === "string" && data) simulationHash = data;
  } catch { /* the composite fallback still applies */ }
  try {
    const { data } = await db.rpc("scenario_fingerprint_hash", { p_scenario_id: scenario.id });
    if (typeof data === "string" && data) scenarioHash = data;
  } catch { /* reported as unavailable below */ }
  if (!graphHash || !scenarioHash) return null;
  return { policyHash, graphHash, simulationHash, scenarioHash };
}

/** §19.5/§22.5 disambiguation shape (as tools.ts::ambiguousEnvelope): the ≤5
 * candidates as rows, never a guess — the reply instantiates the template. */
function scenarioDisambiguation(
  tool: string,
  fragment: string,
  hits: ScenarioRow[],
): ToolEnvelope {
  const candidates = hits.slice(0, 5).map((s) => ({ id: String(s.id), label: String(s.name ?? s.id) }));
  return {
    kind: "table",
    data: { columns: ["id", "label"], rows: candidates.map((c) => [c.id, c.label]) },
    meta: {
      tool,
      row_count: candidates.length,
      note: `ambiguous: "${fragment || "(no scenario named)"}" matches ${hits.length} scenarios — ask which one`,
    },
  };
}

const shortHex = (h: string): string => h.slice(0, 12);

async function findCompletedRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "find_completed_run";
  const db = ctx.supabase as unknown as Db;
  // §20.2: replications 1-200 (clamp), default 1 — "any completed run of at
  // least n reps".
  const rawReps = typeof args.replications === "number" ? args.replications : Number(args.replications);
  const replications = Number.isFinite(rawReps)
    ? Math.max(REPLICATIONS_MIN, Math.min(REPLICATIONS_MAX, Math.floor(rawReps)))
    : 1;

  try {
    // Scenario resolution against `scenarios` (id or name fragment; §19.5:
    // ambiguity yields the disambiguation candidates, never a guess).
    const { data: scenarioRows } = await db
      .from("scenarios")
      .select("*")
      .eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false })
      .limit(50);
    const scenarios = (scenarioRows ?? []) as ScenarioRow[];
    if (scenarios.length === 0) {
      return {
        kind: "text",
        data: "This project has no scenarios yet — there is no completed run to find.",
        meta: { tool, row_count: 0, note: "empty" },
      };
    }
    const fragment = String(args.scenario ?? "").trim();
    let scenario: ScenarioRow | null = null;
    if (fragment) {
      const frag = fragment.toLowerCase();
      const exact = scenarios.find((s) => String(s.id).toLowerCase() === frag);
      if (exact) scenario = exact;
      else {
        const hits = scenarios.filter((s) =>
          String(s.id).toLowerCase().includes(frag) ||
          String(s.name ?? "").toLowerCase().includes(frag)
        );
        if (hits.length === 1) scenario = hits[0];
        else if (hits.length === 0) {
          return {
            kind: "text",
            data: `No scenario matching "${fragment}" in this project.`,
            meta: { tool, row_count: 0, note: "empty" },
          };
        } else {
          return scenarioDisambiguation(tool, fragment, hits);
        }
      }
    } else if (scenarios.length === 1) {
      scenario = scenarios[0];
    } else {
      return scenarioDisambiguation(tool, fragment, scenarios);
    }

    // Policy version: an explicit id, else the project's newest saved
    // version (`list_policy_versions`, §20.2 default).
    let versionId = String(args.policy_version_id ?? "").trim();
    if (versionId && !uuidRe.test(versionId)) {
      return {
        kind: "text",
        data: "policy_version_id must be a uuid of a SAVED policy version.",
        meta: { tool, row_count: 0, note: "error" },
      };
    }
    if (!versionId) {
      const { data: versions } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
      versionId = String((Array.isArray(versions) ? versions : [])[0]?.id ?? "");
    }
    if (!versionId) {
      return {
        kind: "text",
        data:
          "This project has no saved policy version yet — save/snapshot the policy configuration on /policies first; runs never bind live tables.",
        meta: { tool, row_count: 0, note: "dependency_missing" },
      };
    }
    const { data: version } = await db
      .from("policy_versions")
      .select("id,project_id,label,snapshot,policy_hash")
      .eq("id", versionId)
      .maybeSingle();
    if (!version || String(version.project_id) !== ctx.projectId) {
      return {
        kind: "text",
        data: `policy version ${versionId} is not in this project.`,
        meta: { tool, row_count: 0, note: "error" },
      };
    }

    const identity = await resolveRunIdentity(db, ctx.projectId, scenario, version);
    if (!identity) {
      return {
        kind: "text",
        data: "The provenance hashes are unavailable on this project — the run cache cannot be checked.",
        meta: { tool, row_count: 0, note: "error" },
      };
    }
    // §20.2 ordering, made deterministic: record the consultation so the
    // draft_experiment_spec cache-hit guard knows this turn already checked.
    (ctx.cacheChecks ??= []).push({
      scenario_id: String(scenario.id),
      policy_version_id: versionId,
    });

    // THE predicate — the single extracted G17 implementation the dispatcher
    // also calls, so read-hit and apply-hit can never disagree (§20.1 law 2).
    const candidates = await findReuseCandidates(ctx.supabase, {
      scenario: { id: String(scenario.id), updated_at: scenario.updated_at },
      policyHash: identity.policyHash,
      graphHash: identity.graphHash,
      simulationHash: identity.simulationHash,
      scenarioHash: identity.scenarioHash,
      replications,
    }, { limit: 5 });

    const triple =
      `policy_hash=${shortHex(identity.policyHash)} graph_hash=${shortHex(identity.graphHash)} ` +
      `scenario_hash=${shortHex(identity.scenarioHash)}`;

    if (candidates.length > 0) {
      // Hit: one row per matching run (newest first, ≤ 5); Validated is the
      // §9.5-derived badge (deriveValidationBadge — get_validation_status's
      // own logic); meta.note carries the resolved triple so §22 citations
      // can bind to it.
      const badges = new Map<string, string>();
      try {
        const hashes = await currentHashes(db, ctx.projectId);
        const { data: cards } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
        const { data: runRows } = await db
          .from("simulation_runs")
          .select("id,model_validation_id")
          .in("id", candidates.map((c) => c.run_id));
        for (const r of (runRows ?? []) as Array<Record<string, unknown>>) {
          const card = (Array.isArray(cards) ? cards : []).find(
            (c: Record<string, unknown>) => String(c.id) === String(r.model_validation_id ?? ""),
          );
          badges.set(String(r.id), card ? deriveValidationBadge(card, hashes) : "unvalidated");
        }
      } catch { /* badge is enrichment — hits still answer */ }
      const rows = candidates.map((c: ReuseCandidate) => [
        c.run_id,
        c.ended_at ?? "-",
        c.rep_count_done ?? 0,
        (version.label as string | null) ?? versionId.slice(0, 8),
        c.code_version || "-",
        badges.get(c.run_id) ?? "unvalidated",
      ]);
      return {
        kind: "table",
        data: {
          columns: ["Run", "Finished", "Replications", "Policy version", "Engine", "Validated"],
          rows,
        },
        meta: { tool, row_count: rows.length, note: `cache_hit: ${triple}` },
      };
    }

    // No candidate: distinguish cache_stale (a done run exists but the
    // project state drifted — §9.5 staleness law, spoken) from cache_miss.
    const { data: doneRows } = await db
      .from("simulation_runs")
      .select("id,policy_hash,graph_hash,scenario_hash,rep_count_done,created_at")
      .eq("scenario_id", String(scenario.id))
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(5);
    const done = (doneRows ?? []) as Array<Record<string, unknown>>;
    if (done.length === 0) {
      return {
        kind: "text",
        data:
          `no completed run matches this scenario + policy version + current data ` +
          `(scenario "${scenario.name}" has no completed runs).`,
        meta: { tool, row_count: 0, note: "cache_miss" },
      };
    }
    const newest = done[0];
    const drifted: string[] = [];
    if (String(newest.policy_hash ?? "") !== identity.policyHash) {
      drifted.push(
        `policy_hash (run: ${shortHex(String(newest.policy_hash ?? "?"))} vs current: ${shortHex(identity.policyHash)})`,
      );
    }
    if (String(newest.graph_hash ?? "") !== identity.graphHash) {
      drifted.push(
        `graph_hash (run: ${shortHex(String(newest.graph_hash ?? "?"))} vs current: ${shortHex(identity.graphHash)})`,
      );
    }
    if (String(newest.scenario_hash ?? "") !== identity.scenarioHash) {
      drifted.push(
        `scenario_hash (run: ${shortHex(String(newest.scenario_hash ?? "?"))} vs current: ${shortHex(identity.scenarioHash)})`,
      );
    } else if (
      scenario.updated_at && newest.created_at &&
      new Date(String(newest.created_at)).getTime() < new Date(String(scenario.updated_at)).getTime()
    ) {
      // The row-unchanged guard's gap: the stamped scenario_hash excludes
      // events/estimation settings, so a scenario edit is drift even when
      // the baseline fingerprint still matches.
      drifted.push("scenario (the scenario row was edited after that run was dispatched)");
    }
    if (drifted.length > 0) {
      return {
        kind: "text",
        data:
          `the data changed since run ${newest.id} completed — drifted: ${drifted.join("; ")}. ` +
          `The stored result no longer reflects current project state; a re-run is needed for a current answer.`,
        meta: { tool, row_count: 0, note: "cache_stale" },
      };
    }
    if (Number(newest.rep_count_done ?? 0) < replications) {
      return {
        kind: "text",
        data:
          `no completed run matches this scenario + policy version + current data at the requested ` +
          `replication count: run ${newest.id} matches but has only ${Number(newest.rep_count_done ?? 0)} ` +
          `completed replications (< ${replications} requested) — a new run is needed.`,
        meta: { tool, row_count: 0, note: "cache_miss" },
      };
    }
    return {
      kind: "text",
      data: "no completed run matches this scenario + policy version + current data.",
      meta: { tool, row_count: 0, note: "cache_miss" },
    };
  } catch (e) {
    console.warn("find_completed_run failed:", (e as Error).message);
    return { kind: "text", data: "Run-cache lookup failed.", meta: { tool, row_count: 0, note: "error" } };
  }
}

// ---------- draft_experiment_spec handler ----------

interface NormalizedNewScenario {
  name: string;
  horizon_days: number;
  disruption_schedule: Array<Record<string, unknown>>;
  recovery_overrides: Record<string, unknown>;
}

/** §4.5 idempotency core: the substantive spec minus free-text (title,
 * question) — re-phrasings of the same run converge on one card. */
export async function experimentIdempotencyKey(core: {
  scenario_id?: string;
  new_scenario?: NormalizedNewScenario;
  policy_version_id: string;
  replications: number;
}): Promise<string> {
  return await sha256Hex(
    `${EXPERIMENT_AGENT_ID} ${EXPERIMENT_ARTIFACT_TYPE} ${canonicalJson({ schema_version: 1, ...core })}`,
  );
}

function validateNewScenario(raw: unknown): { ok: true; value: NormalizedNewScenario } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "new_scenario must be an object" };
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["name", "horizon_days", "disruption_schedule", "recovery_overrides"].includes(k)) {
      return { ok: false, reason: `unknown new_scenario field "${k}"` };
    }
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || name.length > 120) {
    return { ok: false, reason: "new_scenario.name must be a non-empty string (max 120 chars)" };
  }
  const horizon = Number(o.horizon_days);
  if (!Number.isFinite(horizon) || !Number.isInteger(horizon) || horizon < 7 || horizon > 3650) {
    return { ok: false, reason: "new_scenario.horizon_days must be an integer between 7 and 3650" };
  }
  const schedule = o.disruption_schedule ?? [];
  if (!Array.isArray(schedule)) {
    return { ok: false, reason: "new_scenario.disruption_schedule must be an array" };
  }
  if (schedule.length > DISRUPTION_EVENTS_MAX) {
    // §5.4 hard gate: the engine G11 boundary — never negotiable at draft time.
    return { ok: false, reason: `disruption_schedule allows at most ${DISRUPTION_EVENTS_MAX} events (got ${schedule.length})` };
  }
  for (const e of schedule) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, reason: "disruption_schedule items must be objects" };
    }
  }
  const recovery = o.recovery_overrides ?? {};
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return { ok: false, reason: "new_scenario.recovery_overrides must be an object" };
  }
  return {
    ok: true,
    value: {
      name,
      horizon_days: horizon,
      disruption_schedule: schedule as Array<Record<string, unknown>>,
      recovery_overrides: recovery as Record<string, unknown>,
    },
  };
}

async function draftExperimentSpec(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "draft_experiment_spec";

  // §13.2 checkpoints 2-3: deployment kill switches + agent_proposals capability.
  if (!deploymentEnabledAgents().includes(EXPERIMENT_AGENT_ID)) {
    return failureEnvelope(tool, "agent_disabled", "The Experiment Designer agent is not enabled in this deployment.");
  }
  if (!experimentTypesEnabled().includes("single")) {
    return failureEnvelope(
      tool,
      "agent_disabled",
      "Single-run experiment dispatch is not enabled in this deployment (AGENT_EXPERIMENT_TYPES).",
    );
  }
  if (!ctx.draft || !ctx.draft.canProposals) {
    return failureEnvelope(tool, "agent_disabled", "Proposal drafting is not enabled for this account (agent_proposals).");
  }

  // §5.4 schema, enforced deterministically (additionalProperties: false).
  for (const k of Object.keys(args)) {
    if (!["scenario_id", "new_scenario", "policy_version_id", "replications", "acknowledge_warnings", "title", "question"].includes(k)) {
      return failureEnvelope(tool, "invalid_params", `unknown parameter "${k}"`);
    }
  }
  const hasScenarioId = args.scenario_id !== undefined && args.scenario_id !== null && args.scenario_id !== "";
  const hasNewScenario = args.new_scenario !== undefined && args.new_scenario !== null;
  if (hasScenarioId === hasNewScenario) {
    // the §5.4 oneOf: exactly one of the two.
    return failureEnvelope(tool, "invalid_params", "provide exactly ONE of scenario_id or new_scenario");
  }
  const policyVersionId = String(args.policy_version_id ?? "");
  if (!uuidRe.test(policyVersionId)) {
    return failureEnvelope(tool, "invalid_params", "policy_version_id must be a uuid of a SAVED policy version");
  }
  const rawReps = typeof args.replications === "number" ? args.replications : Number(args.replications);
  if (!Number.isFinite(rawReps)) {
    return failureEnvelope(tool, "invalid_params", "replications must be a number (1-200)");
  }
  // §5.4 hard gate: the dispatch.ts clamp restated at draft time.
  // §10 entry 38(ad): an unstated count is capped at the owner's default.
  const stated = statedReplications(ctx.draft.utterance);
  const replications = Math.max(
    REPLICATIONS_MIN,
    Math.min(stated === null ? AGENT_REPLICATIONS_DEFAULT_CAP : REPLICATIONS_MAX, Math.floor(rawReps)),
  );

  let newScenario: NormalizedNewScenario | null = null;
  if (hasNewScenario) {
    const v = validateNewScenario(args.new_scenario);
    if (!v.ok) return failureEnvelope(tool, "invalid_params", v.reason);
    newScenario = v.value;
  }

  const db = ctx.supabase as unknown as Db;

  // §5.4 hard gate 1: the policy version exists and belongs to this project —
  // no dispatch without a SAVED policy_version_id (mirrors dispatch.ts's own
  // refusal: no version, no run).
  const { data: version } = await db
    .from("policy_versions")
    .select("id,project_id,label,snapshot,policy_hash,created_at")
    .eq("id", policyVersionId)
    .maybeSingle();
  if (!version || String(version.project_id) !== ctx.projectId) {
    const { data: any } = await db
      .from("policy_versions")
      .select("id")
      .eq("project_id", ctx.projectId)
      .limit(1);
    if (!Array.isArray(any) || any.length === 0) {
      return failureEnvelope(
        tool,
        "dependency_missing",
        "This project has no saved policy version yet — save/snapshot the policy configuration on /policies first; runs never bind live tables.",
      );
    }
    return failureEnvelope(tool, "project_scope_violation", `policy version ${policyVersionId} is not in this project`);
  }

  // Scenario resolution (existing id must be in-project).
  let scenario: ScenarioRow | null = null;
  if (hasScenarioId) {
    const scenarioId = String(args.scenario_id ?? "");
    if (!uuidRe.test(scenarioId)) {
      return failureEnvelope(tool, "invalid_params", "scenario_id must be a uuid");
    }
    const { data } = await db.from("scenarios").select("*").eq("id", scenarioId).maybeSingle();
    if (!data || String((data as ScenarioRow).project_id) !== ctx.projectId) {
      return failureEnvelope(tool, "project_scope_violation", `scenario ${scenarioId} is not in this project`);
    }
    scenario = data as ScenarioRow;
  }

  // §20.2 deterministic cache-hit guard (Phase H2, CLOSED_LOOP_ENABLED): the
  // §20.4 prompt ORDERS find_completed_run before drafting, and the ordering
  // is also enforced here — when the turn's cache-check record shows no prior
  // find_completed_run for this scenario+version, the handler runs the SAME
  // extracted G17 lookup itself; a hit returns `cache_hit` (success-like,
  // §4.5) pointing at the stored run and files NO proposal. A weak model
  // that forgets the order cannot waste an approval on an already-answered
  // question. New scenarios have no runs by construction — the guard only
  // applies to existing-scenario specs.
  if (closedLoopEnabled() && scenario) {
    const consulted = (ctx.cacheChecks ?? []).some(
      (c) => c.scenario_id === String(scenario!.id) && c.policy_version_id === policyVersionId,
    );
    if (!consulted) {
      try {
        const identity = await resolveRunIdentity(db, ctx.projectId, scenario, version);
        if (identity) {
          const [cand] = await findReuseCandidates(ctx.supabase, {
            scenario: { id: String(scenario.id), updated_at: scenario.updated_at },
            policyHash: identity.policyHash,
            graphHash: identity.graphHash,
            simulationHash: identity.simulationHash,
            scenarioHash: identity.scenarioHash,
            replications,
          }, { limit: 1 });
          if (cand) {
            return failureEnvelope(
              tool,
              "cache_hit",
              `An identical completed run already answers this — run ${cand.run_id} ` +
                `(${cand.rep_count_done ?? "?"} replications done` +
                `${cand.ended_at ? `, finished ${cand.ended_at}` : ""}; ` +
                `policy_hash ${identity.policyHash.slice(0, 12)}, ` +
                `graph_hash ${identity.graphHash.slice(0, 12)}, ` +
                `scenario_hash ${identity.scenarioHash.slice(0, 12)}). ` +
                `No proposal was filed — report the stored run (get_run_results ${cand.run_id}).`,
            );
          }
        }
      } catch (e) {
        // The guard is an optimization — never let it take drafting down.
        console.warn("cache-hit guard skipped (lookup failed):", e instanceof Error ? e.message : e);
      }
    }
  }

  // §5.4 hard gate 4: read-only gate preview — the SAME runValidationGate the
  // dispatcher enforces, run with acknowledgeWarnings=false and stored as
  // findings_preview so acknowledgment on the card is informed (§5.4:
  // acknowledge_warnings is only honored at apply if the card DISPLAYED the
  // warn findings).
  let findingsPreview: GateFinding[] = [];
  let gateStatus = "pass";
  const disruptionSchedule = newScenario
    ? newScenario.disruption_schedule
    : ((scenario?.disruption_schedule as Array<Record<string, unknown>>) ?? []);
  try {
    const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
    const snapshotDefaults = ("defaults" in snapshot ? snapshot.defaults : snapshot) as Record<string, unknown>;
    const dataset = await loadGateDataset(ctx.supabase, ctx.projectId);
    const gate = runValidationGate({
      dataset,
      snapshotDefaults: snapshotDefaults ?? {},
      disruptionSchedule,
      acknowledgeWarnings: false,
    });
    if (gate) {
      gateStatus = gate.status;
      findingsPreview = gate.findings.slice(0, 200);
    }
  } catch {
    gateStatus = "preview_unavailable"; // preview only — apply re-runs the authoritative gate
  }

  // Grounding = {policy_hash} of the bound version (§5.4). Versions are
  // immutable, so this hash cannot drift — it documents what the spec binds.
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
  const policyHash: string = (version.policy_hash as string | null) ?? (await sha256Hex(canonicalJson(snapshot)));

  // Stale-version visibility (§5.4 failure modes): allowed, but the card shows
  // the version's age and whether a newer one exists.
  let newerVersionExists = false;
  try {
    const { data: siblings } = await db
      .from("policy_versions")
      .select("id,created_at")
      .eq("project_id", ctx.projectId);
    const t = (v: Record<string, unknown>): number => {
      const c = v?.created_at;
      return typeof c === "number" ? c : Date.parse(String(c ?? "")) || 0;
    };
    const own = t(version as Record<string, unknown>);
    newerVersionExists = (Array.isArray(siblings) ? siblings : []).some(
      (s: Record<string, unknown>) => String(s.id) !== policyVersionId && t(s) > own,
    );
  } catch { /* visibility only */ }

  const specCore = {
    ...(scenario ? { scenario_id: scenario.id } : {}),
    ...(newScenario ? { new_scenario: newScenario } : {}),
    policy_version_id: policyVersionId,
    replications,
  };
  const title = (typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : `Run: ${scenario ? scenario.name : newScenario!.name} × ${version.label ?? policyVersionId.slice(0, 8)} (${replications} reps)`)
    .slice(0, 140);
  const question = typeof args.question === "string" ? args.question.slice(0, 500) : null;

  const payload: Record<string, unknown> = {
    schema_version: 1,
    prompt_version: EXPERIMENT_PROMPT_VERSION,
    ...specCore,
    // §5.4 failure mode, hard rule: the tool FORCES acknowledge_warnings
    // false regardless of what the model sent — only the approving human can
    // flip it, on the card (recorded with their review).
    acknowledge_warnings: false,
    title,
    ...(question ? { question } : {}),
    // card display (deterministic, computed here — never by the model):
    ...(scenario ? { scenario_name: scenario.name } : {}),
    policy_version_label: version.label ?? null,
    policy_version_created_at: version.created_at ?? null,
    newer_version_exists: newerVersionExists,
    gate_status: gateStatus,
    findings_preview: findingsPreview,
  };
  if (canonicalJson(payload).length > MAX_PAYLOAD_BYTES) {
    return failureEnvelope(tool, "too_large", "The spec payload exceeds the 256 KB limit — narrow the disruption schedule.");
  }

  const citations: Array<Record<string, unknown>> = [
    { kind: "table_rows", ref: "policy_versions", rows: [policyVersionId] },
    ...(scenario ? [{ kind: "table_rows", ref: "scenarios", rows: [scenario.id] }] : []),
    {
      kind: "user_message",
      ref: `thread:${ctx.draft.threadId ?? "current"}`,
      quote: ctx.draft.utterance.slice(0, 500),
    },
  ];
  if (citations.length > MAX_CITATIONS) citations.length = MAX_CITATIONS;

  const warnCount = findingsPreview.filter((f) => f.severity === "warn").length;
  const blockCount = findingsPreview.filter((f) => f.severity === "block").length;
  const gateNote = gateStatus === "pass"
    ? "gate pre-check: pass"
    : gateStatus === "preview_unavailable"
    ? "gate pre-check unavailable (apply re-runs it)"
    : `gate pre-check: ${gateStatus} (${blockCount} block / ${warnCount} warn)`;
  const summary =
    `scenario "${scenario ? scenario.name : newScenario!.name}"${newScenario ? " (new)" : ""} · ` +
    `policy version ${version.label ?? policyVersionId.slice(0, 8)} (${policyHash.slice(0, 12)}) · ` +
    `${replications} replications · ${gateNote}`;

  const idemKey = await experimentIdempotencyKey(specCore);
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
        artifact_type: EXPERIMENT_ARTIFACT_TYPE,
        summary,
        provenance: "llm_drafted",
        duplicate: true,
      });
    }
  } catch { /* the RPC's own idempotency check still converges below */ }

  const { data: proposalId, error } = await ctx.supabase.rpc("create_agent_proposal", {
    p_project_id: ctx.projectId,
    p_agent_id: EXPERIMENT_AGENT_ID,
    p_artifact_type: EXPERIMENT_ARTIFACT_TYPE,
    p_title: title,
    p_payload: payload,
    p_citations: citations,
    // §5.4: the spec (scenario choice, version binding, replications) is the
    // LLM's — human must verify. Results are never drafted: the engine computes.
    p_provenance: "llm_drafted",
    p_grounding: { policy_hash: policyHash },
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
    artifact_type: EXPERIMENT_ARTIFACT_TYPE,
    summary,
    provenance: "llm_drafted",
  });
}

// Register into the shared executeTool registry (bridge 2). The read tools of
// the §5.4 surface are registered by vvTools.ts / configuratorTools.ts.
// find_completed_run is registered always (like every §2.3 read); it is only
// DECLARED to models per §20.2's exposure rules (closed-loop B4 set; persona
// set when the router says cache_checkable — §6.6 rule 1 in index.ts).
registerToolHandler("draft_experiment_spec", draftExperimentSpec);
registerToolHandler("find_completed_run", findCompletedRun);

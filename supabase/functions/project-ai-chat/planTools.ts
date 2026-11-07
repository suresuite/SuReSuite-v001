// §21 agent harness — the plan tool, plan runtime, and resume pre-step
// (Phase H3; design: docs/design/ai-agents.md §21.1–§21.4, D2/D3 in §10
// Q33/Q34). One tool, `update_task_plan`, handled like a draft tool
// (attribution from ctx.draft) and writing ONLY chat_plans — owner-scoped
// thread state that can never touch project data, so it sits outside the
// §13.3 rights matrix by construction.
//
// Execution locus (§21.4/D2): nowhere long. Each request completes within the
// edge function; waits are persisted step statuses (awaiting_approval /
// awaiting_run); resumes are CLIENT-caused turns carrying resume_plan_id. No
// server-side timer, queue, or background continuation exists — the resume
// pre-step here is called by index.ts inside an ordinary request, and its
// zero-LLM progress branch is exactly "a poll costs nothing".
//
// Flag: PLAN_TOOL_ENABLED — requires CHAT_STORE_ENABLED (D3/Q34: the plan row
// lives in the server chat store's world; in legacy/unsynced threads the
// closed loop caps itself to single-turn shapes and files no plan). Both
// default off ⇒ byte-identical pre-H3 behavior (golden-transcript pinned).

import {
  registerToolHandler,
  type ToolContext,
  type ToolDeclaration,
  type ToolEnvelope,
} from "./tools.ts";
import { failureEnvelope } from "./draftTools.ts";

/** §21.5 plan budgets. */
export const PLAN_MAX_STEPS = 12;
export const PLAN_MAX_RESUMES = 10;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PLAN_TOOL_ENABLED requires CHAT_STORE_ENABLED (D3/Q34) — without the
 * server chat store there is nowhere durable for the plan's thread binding,
 * so the tool refuses to register (stated degradation, never half-persisted). */
export function planToolEnabled(): boolean {
  const on = (k: string) => (Deno.env.get(k) ?? "").trim().toLowerCase() === "true";
  return on("PLAN_TOOL_ENABLED") && on("CHAT_STORE_ENABLED");
}

// ---------- §21.1 parameter schema (verbatim JSON Schema) ----------

/** The §21.1 `update_task_plan` parameter schema, VERBATIM. The handler below
 * validates, clamps, and enforces every rule deterministically (providers get
 * the provider-safe declaration; this constant is the contract fixtures pin). */
export const UPDATE_TASK_PLAN_SCHEMA = {
  "$id": "https://suresuite.dev/schemas/update_task_plan.v1.json",
  "type": "object",
  "required": ["steps"],
  "properties": {
    "plan_id": { "type": "string", "format": "uuid" },
    "title": { "type": "string", "maxLength": 140 },
    "steps": {
      "type": "array",
      "minItems": 1,
      "maxItems": 12,
      "items": {
        "type": "object",
        "required": ["id", "label", "status"],
        "properties": {
          "id": { "type": "string", "maxLength": 40 },
          "label": { "type": "string", "maxLength": 120 },
          "status": {
            "enum": ["pending", "active", "done", "failed", "refused", "awaiting_approval", "awaiting_run"],
          },
          "note": { "type": "string", "maxLength": 200 },
          "ref": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "proposal_id": { "type": "string", "format": "uuid" },
              "run_id": { "type": "string", "format": "uuid" },
            },
          },
        },
        "additionalProperties": false,
      },
    },
  },
  "additionalProperties": false,
} as const;

export type PlanStepStatus =
  | "pending"
  | "active"
  | "done"
  | "failed"
  | "refused"
  | "awaiting_approval"
  | "awaiting_run";

export interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  note?: string;
  ref?: { proposal_id?: string; run_id?: string };
}

export interface PlanRow {
  id: string;
  thread_id: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  title: string;
  status: "active" | "done" | "failed" | "abandoned" | "expired";
  steps: PlanStep[];
  resume_count: number;
  model_code: string | null;
  expires_at?: string;
}

const STEP_STATUSES: readonly PlanStepStatus[] = [
  "pending", "active", "done", "failed", "refused", "awaiting_approval", "awaiting_run",
];

/** §21.1 rule 3 — the only legal transitions:
 * pending → active → done|failed|refused, and
 * active → awaiting_approval|awaiting_run → active|done|failed.
 * (Terminal statuses never move again; the §21.4 approval advance
 * awaiting_approval → awaiting_run is the deterministic RPC path, not a
 * model-driven tool update.) */
export const STEP_TRANSITIONS: Record<PlanStepStatus, readonly PlanStepStatus[]> = {
  pending: ["active"],
  active: ["done", "failed", "refused", "awaiting_approval", "awaiting_run"],
  awaiting_approval: ["active", "done", "failed"],
  awaiting_run: ["active", "done", "failed"],
  done: [],
  failed: [],
  refused: [],
};

// ---------- declaration (provider-safe subset of the §21.1 schema) ----------

export const updateTaskPlanDeclaration: ToolDeclaration = {
  name: "update_task_plan",
  description:
    "Create or update THIS thread's visible task plan. Call it ONCE with every step you foresee " +
    "before any other tool when the work spans more than one step boundary (an approval, a run, a " +
    "multi-part decomposition) — single-step answers need no plan. Steps are append-only (never drop " +
    "an id; a step that turned out wrong goes to 'refused' with a note); at most one step is 'active'; " +
    "'awaiting_approval' steps must carry ref.proposal_id and 'awaiting_run' steps ref.run_id. " +
    "A step's status moves ONLY along pending → active → done|failed|refused, or active → " +
    "awaiting_approval|awaiting_run → active|done|failed. Each call is checked against the SAVED " +
    "plan, so set a step 'active' in one update_task_plan call and move it on (done, or " +
    "awaiting_approval with its card) in a LATER call; pending → done or pending → " +
    "awaiting_approval in one call is refused (§21.1 rule 3). " +
    "Omit plan_id to create; pass it to update the thread's active plan. Close every step " +
    "(done / failed / refused) before you finish.",
  parameters: {
    type: "object",
    properties: {
      plan_id: {
        type: "string",
        description: "The active plan's id (from the PLAN block). Omit to create a new plan.",
      },
      title: { type: "string", description: "Plan title (max 140 chars)." },
      steps: {
        type: "array",
        description:
          "The COMPLETE step list (1-12 items) — every existing step id plus any new ones. " +
          "Each: {id (max 40 chars), label (max 120), status " +
          "(pending|active|done|failed|refused|awaiting_approval|awaiting_run), note? (max 200), " +
          "ref? ({proposal_id?, run_id?})}.",
        items: { type: "object" },
      },
    },
    required: ["steps"],
  },
};

// ---------- deterministic validation (§21.1 handler rules 1-4) ----------

interface ValidatedArgs {
  planId: string | null;
  title: string | null;
  steps: PlanStep[];
}

function invalid(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Schema + rules 3/4, stated so the model can correct (§21.1: violations
 * return invalid_params with the rule named). */
export function validatePlanArgs(args: Record<string, unknown>): { ok: true; value: ValidatedArgs } | { ok: false; reason: string } {
  for (const k of Object.keys(args)) {
    if (!["plan_id", "title", "steps"].includes(k)) return invalid(`unknown parameter "${k}"`);
  }
  const planId = args.plan_id == null || args.plan_id === "" ? null : String(args.plan_id);
  if (planId !== null && !uuidRe.test(planId)) return invalid("plan_id must be a uuid");
  const title = args.title == null ? null : String(args.title);
  if (title !== null && title.length > 140) return invalid("title exceeds 140 chars");
  if (!Array.isArray(args.steps) || args.steps.length < 1) {
    return invalid("steps must be a non-empty array");
  }
  if (args.steps.length > PLAN_MAX_STEPS) {
    // §21.5 plan-step cap, named so the model narrows scope.
    return invalid(`a plan allows at most ${PLAN_MAX_STEPS} steps (got ${args.steps.length}) — narrow the scope`);
  }
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  let activeCount = 0;
  for (const raw of args.steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("each step must be an object");
    const s = raw as Record<string, unknown>;
    for (const k of Object.keys(s)) {
      if (!["id", "label", "status", "note", "ref"].includes(k)) {
        return invalid(`unknown step field "${k}"`);
      }
    }
    const id = typeof s.id === "string" ? s.id : "";
    if (!id || id.length > 40) return invalid("step.id must be a non-empty string (max 40 chars)");
    if (seen.has(id)) return invalid(`duplicate step id "${id}"`);
    seen.add(id);
    const label = typeof s.label === "string" ? s.label : "";
    if (!label || label.length > 120) return invalid(`step "${id}": label must be a non-empty string (max 120 chars)`);
    const status = String(s.status ?? "") as PlanStepStatus;
    if (!STEP_STATUSES.includes(status)) {
      return invalid(`step "${id}": unknown status "${s.status}"`);
    }
    if (status === "active") activeCount += 1;
    const note = s.note == null ? undefined : String(s.note);
    if (note !== undefined && note.length > 200) return invalid(`step "${id}": note exceeds 200 chars`);
    let ref: PlanStep["ref"];
    if (s.ref !== undefined && s.ref !== null) {
      if (typeof s.ref !== "object" || Array.isArray(s.ref)) return invalid(`step "${id}": ref must be an object`);
      const r = s.ref as Record<string, unknown>;
      for (const k of Object.keys(r)) {
        if (!["proposal_id", "run_id"].includes(k)) return invalid(`step "${id}": unknown ref field "${k}"`);
      }
      ref = {};
      if (r.proposal_id != null) {
        if (!uuidRe.test(String(r.proposal_id))) return invalid(`step "${id}": ref.proposal_id must be a uuid`);
        ref.proposal_id = String(r.proposal_id);
      }
      if (r.run_id != null) {
        if (!uuidRe.test(String(r.run_id))) return invalid(`step "${id}": ref.run_id must be a uuid`);
        ref.run_id = String(r.run_id);
      }
    }
    // Rule 4: waiting states carry their ref — the binding that lets the UI
    // render live card/run state and the resume pre-step advance.
    if (status === "awaiting_approval" && !ref?.proposal_id) {
      return invalid(`step "${id}": awaiting_approval requires ref.proposal_id (§21.1 rule 4)`);
    }
    if (status === "awaiting_run" && !ref?.run_id) {
      return invalid(`step "${id}": awaiting_run requires ref.run_id (§21.1 rule 4)`);
    }
    steps.push({ id, label, status, ...(note !== undefined ? { note } : {}), ...(ref ? { ref } : {}) });
  }
  // Rule 3: at most one active step.
  if (activeCount > 1) {
    return invalid(`at most one step may be "active" (got ${activeCount}) — §21.1 rule 3`);
  }
  return { ok: true, value: { planId, title, steps } };
}

/** Rules 2 + 3 against the stored row: an update carries every existing step
 * id (append-only — steps never vanish; a wrong step goes to refused, the A5
 * discipline applied to plans), and every status change is a legal §21.1
 * transition. */
export function validateAgainstStored(
  stored: PlanStep[],
  next: PlanStep[],
): { ok: true } | { ok: false; reason: string } {
  const nextById = new Map(next.map((s) => [s.id, s]));
  for (const prev of stored) {
    const now = nextById.get(prev.id);
    if (!now) {
      return invalid(
        `step "${prev.id}" is missing — steps are append-only (§21.1 rule 2): keep every existing id ` +
          `and mark a wrong step "refused" with a note instead of dropping it`,
      );
    }
    if (now.status !== prev.status && !STEP_TRANSITIONS[prev.status].includes(now.status)) {
      return invalid(
        `step "${prev.id}": ${prev.status} → ${now.status} is not a legal transition (§21.1 rule 3)` +
          (prev.status === "pending"
            ? ` — save it as "active" in this call, then set "${now.status}" in a later call`
            : ""),
      );
    }
  }
  return { ok: true };
}

// ---------- persistence (structural db type — no supabase-js import) ----------

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

function asPlanRow(raw: unknown): PlanRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    thread_id: String(r.thread_id ?? ""),
    project_id: (r.project_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    agent_id: (r.agent_id as string | null) ?? null,
    title: String(r.title ?? "Task plan"),
    status: (r.status as PlanRow["status"]) ?? "active",
    steps: Array.isArray(r.steps) ? (r.steps as PlanStep[]) : [],
    resume_count: Number(r.resume_count ?? 0) || 0,
    model_code: (r.model_code as string | null) ?? null,
    expires_at: r.expires_at == null ? undefined : String(r.expires_at),
  };
}

export async function loadPlan(db: Db, planId: string): Promise<PlanRow | null> {
  const { data } = await db.from("chat_plans").select("*").eq("id", planId).maybeSingle();
  return asPlanRow(data);
}

/** The thread's newest active plan (one live plan per thread — rule 1). */
export async function loadActivePlan(db: Db, threadId: string, userId: string): Promise<PlanRow | null> {
  const { data } = await db
    .from("chat_plans")
    .select("*")
    .eq("thread_id", threadId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(5);
  const rows = (Array.isArray(data) ? data : []).map(asPlanRow).filter((p): p is PlanRow => p !== null);
  return rows.find((p) => p.user_id === userId) ?? null;
}

async function writePlan(
  db: Db,
  userId: string,
  plan: {
    id?: string;
    thread_id: string;
    project_id?: string | null;
    agent_id?: string | null;
    title?: string | null;
    status?: string;
    steps: PlanStep[];
    model_code?: string | null;
    increment_resume?: boolean;
  },
): Promise<PlanRow> {
  const { data, error } = await db.rpc("upsert_chat_plan", { p_plan: plan, p_user_id: userId });
  if (error) throw new Error(String(error.message ?? "upsert_chat_plan failed"));
  const row = asPlanRow(data);
  if (!row) throw new Error("upsert_chat_plan returned no row");
  return row;
}

// ---------- lifecycle (§21.3) ----------

/** Deterministic plan-status recompute from its steps (§21.3 state machine):
 * all steps done ⇒ done; all terminal with any failed ⇒ failed; all terminal
 * without failures (done/refused mixes) ⇒ done; a waiting step keeps the plan
 * active; pending steps after a failure with nothing waiting cannot proceed
 * ⇒ failed; otherwise the plan stays active. */
export function recomputePlanStatus(steps: PlanStep[]): "active" | "done" | "failed" {
  const terminal = new Set(["done", "failed", "refused"]);
  const allTerminal = steps.every((s) => terminal.has(s.status));
  const anyFailed = steps.some((s) => s.status === "failed");
  if (allTerminal) return anyFailed ? "failed" : "done";
  const anyWaiting = steps.some((s) => s.status === "awaiting_approval" || s.status === "awaiting_run");
  if (anyWaiting) return "active";
  if (anyFailed) return "failed"; // pending remainder, nothing waiting — no step can proceed
  return "active";
}

/** Step counts by status — the §7.5-safe telemetry payload shape (ids and
 * counts only). */
export function stepsByStatus(steps: PlanStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) out[s.status] = (out[s.status] ?? 0) + 1;
  return out;
}

export interface PlanPart {
  kind: "plan";
  data: { plan_id: string; title: string; status: string; steps: PlanStep[] };
}

/** The {kind:"plan"} part: {plan_id} plus a render snapshot; PlanCard
 * subscribes to the row for live state (§21.2). */
export function planPart(plan: PlanRow): PlanPart {
  return {
    kind: "plan",
    data: { plan_id: plan.id, title: plan.title, status: plan.status, steps: plan.steps },
  };
}

export interface SweepResult {
  plan: PlanRow | null;
  changed: boolean;
  /** true when this sweep moved the plan out of 'active' (emit plan.closed). */
  closed: boolean;
}

/**
 * The §21.3 integrity law, enforced deterministically after every request
 * that touched a plan: any step still 'active' is set failed with note
 * 'interrupted' (the cause — budget exhaustion, provider error, a model that
 * stopped mid-step — lands in the note), and the plan status is recomputed
 * from its steps. The model is INVITED to close its steps (§20.4 rule 5);
 * the platform GUARANTEES it.
 */
export async function sweepPlanIntegrity(
  db: Db,
  args: { planId?: string | null; threadId?: string | null; userId: string; cause?: string },
): Promise<SweepResult> {
  let plan: PlanRow | null = null;
  try {
    if (args.planId) plan = await loadPlan(db, args.planId);
    else if (args.threadId) plan = await loadActivePlan(db, args.threadId, args.userId);
  } catch {
    return { plan: null, changed: false, closed: false };
  }
  if (!plan || plan.user_id !== args.userId || plan.status !== "active") {
    return { plan, changed: false, closed: false };
  }
  const note = `interrupted${args.cause ? `: ${args.cause.slice(0, 180)}` : ""}`;
  let changed = false;
  const steps = plan.steps.map((s) => {
    if (s.status !== "active") return s;
    changed = true;
    return { ...s, status: "failed" as PlanStepStatus, note };
  });
  const status = recomputePlanStatus(steps);
  if (status !== plan.status) changed = true;
  if (!changed) return { plan, changed: false, closed: false };
  try {
    const fresh = await writePlan(db, args.userId, {
      id: plan.id,
      thread_id: plan.thread_id,
      steps,
      status,
    });
    return { plan: fresh, changed: true, closed: fresh.status !== "active" };
  } catch (e) {
    console.warn("[plan] integrity sweep write failed:", e instanceof Error ? e.message : e);
    return { plan, changed: false, closed: false };
  }
}

/** Deterministic step-failure writer (checkpoint failures, run failures,
 * §21.5 caps): marks ONE step failed with the note and recomputes. */
export async function markPlanStepFailed(
  db: Db,
  plan: PlanRow,
  stepId: string,
  note: string,
  userId: string,
): Promise<PlanRow> {
  const steps = plan.steps.map((s) =>
    s.id === stepId ? { ...s, status: "failed" as PlanStepStatus, note: note.slice(0, 200) } : s
  );
  return await writePlan(db, userId, {
    id: plan.id,
    thread_id: plan.thread_id,
    steps,
    status: recomputePlanStatus(steps),
  });
}

// ---------- the §20.4 PLAN block ----------

/** Serialized from the row — thread state, not model memory (D3: the plan is
 * data, not context; a model switch mid-plan re-reads the same row). */
export function formatPlanBlock(plan: PlanRow): string {
  const lines = plan.steps.map((s) => {
    const ref = s.ref?.proposal_id
      ? ` (proposal ${s.ref.proposal_id})`
      : s.ref?.run_id
      ? ` (run ${s.ref.run_id})`
      : "";
    const note = s.note ? ` — ${s.note}` : "";
    return `  - [${s.status}] ${s.id}: ${s.label}${ref}${note}`;
  });
  return `- PLAN (plan_id ${plan.id}, status ${plan.status}) — update it via update_task_plan:\n${lines.join("\n")}`;
}

export async function buildPlanBlock(db: Db, threadId: string | null, userId: string): Promise<string> {
  if (!planToolEnabled() || !threadId || !uuidRe.test(threadId)) return "";
  try {
    const plan = await loadActivePlan(db, threadId, userId);
    return plan ? formatPlanBlock(plan) : "";
  } catch {
    return "";
  }
}

// ---------- the update_task_plan handler (§21.1 rules 1-5) ----------

async function updateTaskPlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
  const tool = "update_task_plan";
  if (!planToolEnabled()) {
    return failureEnvelope(tool, "agent_disabled", "The plan tool is not enabled in this deployment (PLAN_TOOL_ENABLED requires CHAT_STORE_ENABLED).");
  }
  // D3/Q34: unsynced/legacy threads file no plan — the closed loop caps
  // itself to single-turn shapes there (stated degradation, never a
  // half-persisted plan).
  const threadId = ctx.draft?.threadId ?? null;
  if (!threadId || !uuidRe.test(threadId)) {
    return failureEnvelope(
      tool,
      "dependency_missing",
      "This thread isn't synced to the server chat store, so no plan can be filed — answer in a single turn instead (propose and stop, or answer from the cache).",
    );
  }

  const v = validatePlanArgs(args);
  if (!v.ok) return failureEnvelope(tool, "invalid_params", v.reason);
  const { planId, title, steps } = v.value;

  const db = ctx.supabase as unknown as Db;
  try {
    let row: PlanRow;
    let created = false;
    if (planId) {
      // Rule 1 (update): the row must belong to this thread and be active.
      const stored = await loadPlan(db, planId);
      if (!stored || stored.user_id !== ctx.userId) {
        return failureEnvelope(tool, "invalid_params", `plan ${planId} not found (§21.1 rule 1)`);
      }
      if (stored.thread_id !== threadId) {
        return failureEnvelope(tool, "invalid_params", `plan ${planId} is not in this thread (§21.1 rule 1)`);
      }
      if (stored.status !== "active") {
        return failureEnvelope(tool, "invalid_params", `plan ${planId} is ${stored.status} — only the active plan can be updated (§21.1 rule 1)`);
      }
      const chk = validateAgainstStored(stored.steps, steps);
      if (!chk.ok) return failureEnvelope(tool, "invalid_params", chk.reason);
      row = await writePlan(db, ctx.userId, {
        id: planId,
        thread_id: threadId,
        title,
        steps,
        model_code: ctx.draft?.modelCode ?? null,
      });
    } else {
      // Rule 1 (create): one live plan per thread — the RPC supersedes any
      // other active plan ('abandoned', §4.2-style, never deleted).
      created = true;
      row = await writePlan(db, ctx.userId, {
        thread_id: threadId,
        project_id: ctx.projectId,
        agent_id: ctx.draft?.agentId ?? null,
        title,
        steps,
        model_code: ctx.draft?.modelCode ?? null,
      });
    }
    // §21.3 telemetry (ids and counts only, §7.5) — recorded on the request
    // context; the orchestrator emits after the turn.
    (ctx.planEvents ??= []).push({
      kind: created ? "plan.created" : "plan.step_changed",
      payload: {
        plan_id: row.id,
        steps_by_status: stepsByStatus(row.steps),
        resume_count: row.resume_count,
      },
    });
    ctx.planTouchedId = row.id;
    // Rule 5: the plan envelope — the "plan" part kind renders as PlanCard,
    // exactly the "proposal" precedent.
    return {
      kind: "plan",
      data: { plan_id: row.id, title: row.title, status: row.status, steps: row.steps },
      meta: { tool, row_count: 1 },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "plan write failed";
    if (msg.startsWith("invalid_params")) return failureEnvelope(tool, "invalid_params", msg);
    console.error("update_task_plan failed:", msg);
    return { kind: "text", data: "Filing the plan failed — try again.", meta: { tool, row_count: 0, note: "error" } };
  }
}

// ---------- §21.4 resume mechanics ----------

/** §21.2 progress line, verbatim — the awaiting_run render AND the zero-LLM
 * templated progress reply (a poll costs nothing). */
export function progressLine(done: number, target: number): string {
  return `run dispatched — ${done}/${target} replications`;
}

export function progressReply(done: number, target: number): string {
  return `Still working: ${progressLine(done, target)}. The thread resumes automatically when the run completes — waiting is a plan state, nothing is hung.`;
}

/** The deterministic resume instruction (§21.4: the resumed agent turn's
 * input is this instruction, the grounding context rebuilt fresh, and the
 * PLAN block serialized from the row — never model memory). */
export function resumeInstruction(args: { stepId: string; runId: string }): string {
  return (
    `Plan step "${args.stepId}" was waiting on simulation run ${args.runId}, which has now COMPLETED. ` +
    `Execute step 5 of your loop: call get_run_results (and get_validation_status) for run ${args.runId}, ` +
    `answer the original question from that evidence with [n] citations, and close every plan step ` +
    `(done / failed / refused) via update_task_plan.`
  );
}

export type ResumeOutcome =
  | { kind: "error"; error: string; reply: string; plan: PlanRow | null }
  /** Zero-LLM branches: templated reply + plan part; nothing reaches a model. */
  | { kind: "progress"; reply: string; plan: PlanRow }
  | { kind: "closed"; reply: string; plan: PlanRow }
  /** The run finished: the request executes the read-and-cite step (§20.4
   * step 5) as its agent turn, with the deterministic instruction below. */
  | { kind: "run_done"; plan: PlanRow; stepId: string; runId: string; utterance: string };

/**
 * The §21.4 server pre-step — deterministic, before any LLM call. Owner
 * check, TTL, the bound artifact's status, and the §21.5 resume cap.
 * Checkpoints 1-2 (project access, capability resolution) are re-run by the
 * caller (index.ts) exactly like any request — §13.6 rule 5: a plan is never
 * a pre-authorization.
 */
export async function runResumePreStep(
  db: Db,
  args: { planId: string; userId: string; modelCode?: string | null },
): Promise<ResumeOutcome> {
  let plan: PlanRow | null = null;
  try {
    plan = await loadPlan(db, args.planId);
  } catch { /* falls through to not-found */ }
  if (!plan) {
    return { kind: "error", error: "plan_not_found", reply: "That plan no longer exists — nothing to resume.", plan: null };
  }
  // Owner check (Q20 posture): a resume grants nothing and reads nothing
  // that isn't yours.
  if (plan.user_id !== args.userId) {
    return { kind: "error", error: "forbidden", reply: "forbidden: that plan belongs to another user.", plan: null };
  }
  // Lazy TTL (§21.5): the proposals default, swept on read.
  if (plan.status === "active" && plan.expires_at && Date.parse(plan.expires_at) < Date.now()) {
    try {
      plan = await writePlan(db, args.userId, { id: plan.id, thread_id: plan.thread_id, steps: plan.steps, status: "expired" });
    } catch { /* report the stored state */ }
    return { kind: "closed", reply: "This plan expired (14-day TTL) — ask again to start fresh.", plan };
  }
  if (plan.status !== "active") {
    return { kind: "closed", reply: `This plan is already ${plan.status} — nothing to resume.`, plan };
  }

  let step = plan.steps.find((s) => s.status === "awaiting_run") ??
    plan.steps.find((s) => s.status === "awaiting_approval");
  if (!step) {
    // Nothing waits. If the steps already tell a terminal story (e.g. the
    // client's advance_chat_plan_step failed the bound step on a quota
    // denial, §13.6 rule 3), recompute and close the plan honestly.
    const status = recomputePlanStatus(plan.steps);
    if (status !== "active") {
      try {
        plan = await writePlan(db, args.userId, { id: plan.id, thread_id: plan.thread_id, steps: plan.steps, status });
      } catch { /* report the stored state */ }
      const failedSteps = plan.steps.filter((s) => s.status === "failed");
      const failedNote = failedSteps.length > 0
        ? ` Step "${failedSteps[0].id}" failed${failedSteps[0].note ? `: ${failedSteps[0].note}` : ""}.`
        : "";
      return { kind: "closed", reply: `This plan is ${status} — nothing left to resume.${failedNote}`, plan };
    }
    return { kind: "progress", reply: "No plan step is waiting — nothing to resume.", plan };
  }

  // awaiting_approval: read the bound card. The client normally advances this
  // step itself (§21.4 approval resume via advance_chat_plan_step); this
  // server-side twin converges the same way when the resume turn arrives
  // first, so the two paths can never disagree.
  if (step.status === "awaiting_approval") {
    const proposalId = step.ref?.proposal_id;
    let proposal: Record<string, unknown> | null = null;
    if (proposalId) {
      try {
        const { data } = await db.from("proposals").select("id,status,applied_result,apply_error").eq("id", proposalId).maybeSingle();
        proposal = (data as Record<string, unknown> | null) ?? null;
      } catch { /* treated as still-pending below */ }
    }
    const status = String(proposal?.status ?? "proposed");
    const runId = (proposal?.applied_result as Record<string, unknown> | null)?.run_id;
    if (status === "applied" && typeof runId === "string" && uuidRe.test(runId)) {
      const steps = plan.steps.map((s) =>
        s.id === step!.id
          ? { ...s, status: "awaiting_run" as PlanStepStatus, ref: { ...(s.ref ?? {}), run_id: runId } }
          : s
      );
      plan = await writePlan(db, args.userId, { id: plan.id, thread_id: plan.thread_id, steps });
      step = plan.steps.find((s) => s.id === step!.id)!;
      // fall through to the awaiting_run branch below
    } else if (status === "rejected" || status === "expired") {
      const fresh = await markPlanStepFailed(db, plan, step.id, status === "rejected" ? "rejected" : "proposal expired", args.userId);
      return {
        kind: "closed",
        reply: `The proposal bound to plan step "${step.id}" was ${status} — that step failed and the plan is ${fresh.status}.`,
        plan: fresh,
      };
    } else {
      return {
        kind: "progress",
        reply: "The proposal card is still awaiting review — approve or reject it to continue the plan.",
        plan,
      };
    }
  }

  // awaiting_run: read the bound run row (the worker is the sole writer of
  // its status — asset A11; we only read).
  const runId = step.ref?.run_id;
  if (!runId) {
    const fresh = await markPlanStepFailed(db, plan, step.id, "run binding lost", args.userId);
    return { kind: "closed", reply: `Plan step "${step.id}" lost its run binding — the step failed.`, plan: fresh };
  }
  let run: Record<string, unknown> | null = null;
  try {
    const { data } = await db
      .from("simulation_runs")
      .select("id,status,rep_count_done,rep_count_target,error_message")
      .eq("id", runId)
      .maybeSingle();
    run = (data as Record<string, unknown> | null) ?? null;
  } catch { /* handled as missing */ }
  if (!run) {
    const fresh = await markPlanStepFailed(db, plan, step.id, "run not found", args.userId);
    return { kind: "closed", reply: `Run ${runId} no longer exists — plan step "${step.id}" failed.`, plan: fresh };
  }
  const runStatus = String(run.status ?? "");
  if (runStatus === "queued" || runStatus === "running") {
    // §21.4: zero LLM calls — a poll costs nothing.
    return {
      kind: "progress",
      reply: progressReply(Number(run.rep_count_done ?? 0), Number(run.rep_count_target ?? 0)),
      plan,
    };
  }
  if (runStatus !== "done") {
    // Run failed ⇒ honest step failure with the run's error; no retry
    // without a fresh user ask (§21.4).
    const errMsg = String(run.error_message ?? `run ended with status "${runStatus}"`);
    const fresh = await markPlanStepFailed(db, plan, step.id, errMsg.slice(0, 200), args.userId);
    return {
      kind: "closed",
      reply:
        `The run bound to plan step "${step.id}" failed: ${errMsg.slice(0, 300)}. ` +
        `The step is marked failed — ask again if you want me to set up a fresh run.`,
      plan: fresh,
    };
  }

  // Run done ⇒ this resume reaches the LLM: §21.5 cap 10, then advance the
  // step (awaiting_run → active is a legal §21.1 transition) and record the
  // model that advances it (D3: informational; pi-06).
  if (plan.resume_count >= PLAN_MAX_RESUMES) {
    const fresh = await markPlanStepFailed(db, plan, step.id, "resume_cap", args.userId);
    return {
      kind: "closed",
      reply:
        `This plan hit its resume cap (${PLAN_MAX_RESUMES} resumes) — plan step "${step.id}" is marked failed. ` +
        `Ask again to start a fresh plan.`,
      plan: fresh,
    };
  }
  const steps = plan.steps.map((s) => (s.id === step!.id ? { ...s, status: "active" as PlanStepStatus } : s));
  const fresh = await writePlan(db, args.userId, {
    id: plan.id,
    thread_id: plan.thread_id,
    steps,
    model_code: args.modelCode ?? null,
    increment_resume: true,
  });
  return {
    kind: "run_done",
    plan: fresh,
    stepId: step.id,
    runId,
    utterance: resumeInstruction({ stepId: step.id, runId }),
  };
}

// Register into the shared executeTool registry (bridge 2). Like every staged
// tool the handler is registered unconditionally and gates itself; it is only
// DECLARED to models via experimentToolDeclarations() when PLAN_TOOL_ENABLED
// (and CLOSED_LOOP_ENABLED) — flag off ⇒ no model can see or call it.
registerToolHandler("update_task_plan", updateTaskPlan);

// Shared machinery for the Phase M modeler skills (ai-agents.md §26).
//
// A SKILL is a fixed procedure for one modeler task, in code (§26.2):
// recognizer → resolver → procedure through the registered handlers →
// deterministic answer (+ at most one verified interpretation call) → the
// next step. This module holds what more than one skill needs: the skill
// contract, paired statistics, run reads, formatting, and the finding →
// fixing-surface map (WP M.5).

import { executeTool, type ToolContext, type ToolEnvelope } from "../tools.ts";
import type { ProposalPartData } from "../draftTools.ts";

// ── the contract ────────────────────────────────────────────────────────────

export type SkillId =
  | "whatif"
  | "mitigation"
  | "results"
  | "readiness"
  | "sensitivity"
  | "setup"
  | "howto"
  | "explain"
  | "critical"
  | "centrality"
  | "network"
  | "model"
  | "optimize"
  | "predict"
  | "outofscope"
  | "significance"
  | "stress"
  | "criticalwhatif"
  | "status"
  | "capabilities";

export interface SkillInput {
  /** The message being answered (a bare "do it" already re-routed). */
  utterance: string;
  /** Prior turns, oldest first — a skill may take its subject from them
   * ("how do I mitigate it?" after a what-if). */
  history: Array<{ role: string; content: string }>;
}

export interface SkillOptions {
  /** false ⇒ never file a card (Ask mode, or the Designer not routable). */
  canDraft: boolean;
  draftBlockedReason?: string;
  /** Agents routable for this caller — next-step offers name only these. */
  enabledAgents: string[];
}

export interface SkillResult {
  /** Deterministic answer — always shippable on its own. */
  reply: string;
  parts: Array<{ kind: string; data: unknown }>;
  calls: Array<{ name: string; args: Record<string, unknown>; envelope: ToolEnvelope }>;
  /** A card this skill filed (the plan binds to it, §26 M.3). */
  proposal?: ProposalPartData | null;
  /** The internal handoff for the ONE optional interpretation call, or null. */
  interpretation?: string | null;
  /** Machine-readable outcome for telemetry and the M.0 benchmark. */
  outcome: string;
  /** When the verified interpretation exists, it LEADS and `footer` follows
   * (the how-to answer: prose first, citations after); otherwise the
   * interpretation is appended to `reply`. */
  leadWithInterpretation?: boolean;
  footer?: string;
  /** The earlier user message the subject came from, when it was not this
   * one ("how do I mitigate it?" after a what-if). The plan stores it with
   * the question, so the resume — which has no conversation — still knows
   * what "it" was (§10 entry 38(ak)). */
  subjectText?: string;
  /** Runs of a multi-arm study still running: a resume that finds the study
   * unfinished waits on one of them instead of failing the answer. */
  pendingRunIds?: string[];
}

export interface Skill {
  id: SkillId;
  /** Drafting skills route to the Experiment Designer; the rest are reads. */
  drafts: boolean;
  /** One-line description for the capabilities answer (M.6). */
  describe: string;
  example: string;
  /** Conservative: return a match only when sure; null falls through. */
  recognize(input: SkillInput): unknown | null;
  run(ctx: ToolContext, match: unknown, input: SkillInput, opts: SkillOptions): Promise<SkillResult>;
}

/** Calls a registered handler and records it (meters + scoping unchanged). */
export async function callTool(
  calls: SkillResult["calls"],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const envelope = await executeTool(name, args, ctx);
  calls.push({ name, args, envelope });
  return envelope;
}

// deno-lint-ignore no-explicit-any
export type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };
export const dbOf = (ctx: ToolContext): Db => ctx.supabase as unknown as Db;

// ── statistics: a mirror of src/lib/sim/stats.ts (held equal by
// eval/modeler_skills_test.ts, which imports both) ──────────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};

export function tCritical95(df: number): number {
  if (df <= 0) return 0;
  if (df <= 30) return T95[df];
  return 1.96;
}

export function ciHalfWidth95(xs: number[]): number {
  if (xs.length < 2) return 0;
  return (tCritical95(xs.length - 1) * std(xs)) / Math.sqrt(xs.length);
}

/** Paired difference a − b over the replications both runs share (CRN pairs
 * by replication index). null when fewer than 2 pairs exist. */
export function pairedDelta(
  a: Map<number, number>,
  b: Map<number, number>,
): { mean: number; ci: number; n: number } | null {
  const diffs: number[] = [];
  for (const [rep, va] of a) {
    const vb = b.get(rep);
    if (vb !== undefined && Number.isFinite(va) && Number.isFinite(vb)) diffs.push(va - vb);
  }
  if (diffs.length < 2) return null;
  return { mean: mean(diffs), ci: ciHalfWidth95(diffs), n: diffs.length };
}

// ── formatting ──────────────────────────────────────────────────────────────

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString("en-US");
  if (a >= 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 10000) / 10000);
}

export function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${fmt(n)}`;
}

/** Headline KPIs first — the order a decision reader expects. */
export const KPI_ORDER = [
  "fill_rate", "service_level", "otif", "backlog", "max_backlog", "lost_sales",
  "ttr_weeks", "tts_weeks", "pvar", "total_cost", "revenue", "profit", "capacity_utilization",
];

/** KPIs where a LOWER value is better (a difference is read inverted). */
export const LOWER_IS_BETTER = /backlog|lost|cost|ttr|tts|pvar|stockout|delay|shortage/i;

export function orderKpis(keys: Iterable<string>, max = 8): string[] {
  const rank = (k: string) => {
    const i = KPI_ORDER.indexOf(k);
    return i < 0 ? KPI_ORDER.length : i;
  };
  return [...new Set(keys)].filter((k) => !k.startsWith("_"))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, max);
}

// ── run reads ───────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  project_id: string;
  scenario_id: string | null;
  status: string;
  rep_count_done: number;
  rep_count_target: number;
  policy_version_id: string | null;
  seed: number | null;
  code_version: string | null;
  aggregate_kpis: Record<string, unknown>;
  ci_half_widths: Record<string, unknown>;
  warmup_detected_at: number | null;
  disruption_schedule: Array<Record<string, unknown>> | null;
  created_at: unknown;
  ended_at: unknown;
  /** §27: the Validated Model the run followed (null = it followed none). */
  model_validation_id: string | null;
}

const RUN_COLS =
  "id,project_id,scenario_id,status,rep_count_done,rep_count_target,policy_version_id,seed,code_version," +
  "aggregate_kpis,ci_half_widths,warmup_detected_at,disruption_schedule,created_at,ended_at,model_validation_id";

function asRun(r: Record<string, unknown>): RunRow {
  return {
    id: String(r.id),
    project_id: String(r.project_id ?? ""),
    scenario_id: r.scenario_id ? String(r.scenario_id) : null,
    status: String(r.status ?? ""),
    rep_count_done: Number(r.rep_count_done ?? 0),
    rep_count_target: Number(r.rep_count_target ?? 0),
    policy_version_id: r.policy_version_id ? String(r.policy_version_id) : null,
    seed: r.seed === null || r.seed === undefined ? null : Number(r.seed),
    code_version: r.code_version ? String(r.code_version) : null,
    aggregate_kpis: (r.aggregate_kpis ?? {}) as Record<string, unknown>,
    ci_half_widths: (r.ci_half_widths ?? {}) as Record<string, unknown>,
    warmup_detected_at: r.warmup_detected_at === null || r.warmup_detected_at === undefined
      ? null
      : Number(r.warmup_detected_at),
    disruption_schedule: Array.isArray(r.disruption_schedule)
      ? (r.disruption_schedule as Array<Record<string, unknown>>)
      : null,
    created_at: r.created_at,
    ended_at: r.ended_at,
    model_validation_id: r.model_validation_id ? String(r.model_validation_id) : null,
  };
}

export async function loadRun(db: Db, projectId: string, runId: string): Promise<RunRow | null> {
  try {
    const { data } = await db.from("simulation_runs").select(RUN_COLS).eq("id", runId).maybeSingle();
    if (!data || String((data as Record<string, unknown>).project_id) !== projectId) return null;
    return asRun(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function loadRecentRuns(db: Db, projectId: string, limit = 20): Promise<RunRow[]> {
  try {
    const { data } = await db.from("simulation_runs").select(RUN_COLS).eq("project_id", projectId)
      .order("created_at", { ascending: false }).limit(limit);
    return ((data ?? []) as Array<Record<string, unknown>>).map(asRun);
  } catch {
    return [];
  }
}

/** Per-replication KPI values: kpi → (rep_index → value). */
export async function loadRepKpis(db: Db, runId: string): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();
  try {
    const { data } = await db.from("run_replications").select("rep_index,status,kpis").eq("run_id", runId).limit(500);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const st = String(r.status ?? "done");
      if (st !== "done" && st !== "completed") continue;
      const rep = Number(r.rep_index);
      const kpis = (r.kpis ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(kpis)) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n) || k.startsWith("_")) continue;
        if (!out.has(k)) out.set(k, new Map());
        out.get(k)!.set(rep, n);
      }
    }
  } catch { /* no replication rows ⇒ aggregates only */ }
  return out;
}

export function scalarKpis(run: RunRow): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(run.aggregate_kpis)) {
    if (k.startsWith("_")) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) m.set(k, n);
  }
  return m;
}

export function runCi(run: RunRow, kpi: string): number | null {
  const n = Number(run.ci_half_widths?.[kpi]);
  return Number.isFinite(n) ? n : null;
}

/** Are two runs like-for-like (common random numbers pair them by replication)?
 * ONE definition, read by the results comparison and the significance answer:
 * same recorded seed, same finished replication count, same policy version. */
export function pairingOf(a: RunRow, b: RunRow): { paired: boolean; why: string } {
  const paired = a.seed !== null && a.seed === b.seed && a.rep_count_done === b.rep_count_done &&
    a.policy_version_id === b.policy_version_id;
  const why = paired ? "" : [
    a.seed === null || b.seed === null ? "a run does not record its seed" : a.seed !== b.seed ? "different seeds" : "",
    a.rep_count_done !== b.rep_count_done ? "different replication counts" : "",
    a.policy_version_id !== b.policy_version_id ? "different policy versions" : "",
  ].filter(Boolean).join(", ");
  return { paired, why };
}

// ── WP M.5: finding → the surface that fixes it ─────────────────────────────

/** The table a gate finding's `field` names decides who fixes it. Derived
 * from the field's own table prefix (the gate's vocabulary), not a list of
 * fields kept by hand. */
const ITEM_MASTER_TABLES = new Set([
  "products", "materials", "suppliers", "customers", "inbound_logistics", "outbound_logistics",
  "bom_single_level", "bom_multi_level", "demand_forecasts",
]);

export function fixFor(
  finding: { field?: string; policy?: string },
  enabledAgents: string[],
): string {
  const field = String(finding.field ?? "");
  const table = field.includes(".") ? field.slice(0, field.indexOf(".")) : field;
  if (ITEM_MASTER_TABLES.has(table)) {
    if (enabledAgents.includes("data-steward")) {
      return `say "fill missing ${field}" and the Data Steward drafts the values for your approval`;
    }
    if (enabledAgents.includes("cost-estimator")) {
      return `say "estimate ${field}" and the Cost Estimator drafts a method-cited value`;
    }
    return `fill \`${field}\` in Project Manager (/project-manager), then ask again`;
  }
  if (table.startsWith("policy") || table === "policy_defaults" || table === "policy_overrides" || (finding.policy && finding.policy !== "engine" && !table)) {
    return enabledAgents.includes("policy-configurator")
      ? `say "configure ${field || finding.policy}" and the Policy Configurator drafts the change`
      : `set it on /policies and save a new policy version`;
  }
  if (table === "scenarios") return "adjust the scenario in the Simulation Lab";
  return "see the pre-run check in the Simulation Lab for where to change it";
}

/** The most recent earlier user message, for skills that take their
 * subject from the conversation. */
export function previousUserMessages(history: SkillInput["history"], max = 6): string[] {
  return history.filter((h) => h.role === "user" && typeof h.content === "string")
    .map((h) => h.content).slice(-max).reverse();
}

/** §27 rows 12–13: what kind of result a run is, said wherever one is shown. */
export async function runKindLabel(db: Db, run: RunRow): Promise<string> {
  if (!run.model_validation_id) return "exploratory — followed no Validated Model";
  try {
    const { data } = await db.from("model_validations").select("id,name,model_code,status").eq("id", run.model_validation_id).maybeSingle();
    const c = data as Record<string, unknown> | null;
    if (c) {
      const name = [c.model_code, c.name].filter((v) => typeof v === "string" && v).join(" · ") || String(c.id).slice(0, 8);
      return `follows Validated Model "${name}"${c.status !== "active" ? ` (now ${String(c.status)})` : ""}`;
    }
  } catch { /* the id still says it followed one */ }
  return "follows a Validated Model";
}

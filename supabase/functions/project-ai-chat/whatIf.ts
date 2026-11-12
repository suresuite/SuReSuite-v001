// The deterministic what-if loop (ai-agents.md §20.8, added v1.6).
//
// WHY THIS EXISTS. §20 specified the closed decision loop as a fixed sequence
// — understand, check the cache, propose on a miss, read results, answer — and
// then left every step of that sequence to the model's tool choice. A real
// ask ("what if disruption with S001 at week 22 and duration of 4 weeks") went
// to the persona surface, which spent seven tool hops on background reads
// (supplier list, material rows, recovery playbooks, lanes), hit the 60-second
// wall budget before reaching the cache check, and returned the raw tool
// tables under "I stopped at this request's time budget". Two defects sat
// under that, and neither is a prompt problem:
//
//   1. UNDERSTANDING WAS THE MODEL'S. Every fact needed to act — the target,
//      the start week, the duration — was in the sentence. Extracting them is
//      a parse, not a judgement, so it is done here in code.
//   2. THE CACHE COULD NOT MATCH THE ASK. `find_completed_run` resolves a
//      scenario by id or NAME. An ad-hoc disruption has no name; the only
//      honest key is the disruption itself. This module compares the asked
//      event with every scenario's schedule BY CONTENT (target, start week,
//      duration, effect — the engine's own rounding), then hands each match
//      to the unchanged §20.2 identity check.
//
// The LLM keeps exactly one job on this path: phrasing a hit's interpretation
// (index.ts, tools withdrawn, verified by §22.3 when on). Everything that
// decides — routing, resolution, cache identity, the draft — is code, so the
// loop costs 0–1 model calls instead of 7+, and still works when the model
// provider is rate-limiting (every non-hit branch is answered with no LLM).
//
// Nothing here bypasses a gate: reads go through the registered handlers via
// executeTool (same meters, same scoping); a draft goes through the
// draft_experiment_spec handler, whose §5.4 hard gates, kill switches and
// capability check are unchanged, and a card still needs a human's Approve.

import { executeTool, type ToolContext, type ToolEnvelope } from "./tools.ts";
import type { ProposalPartData } from "./draftTools.ts";
import { loadRepKpis, pairedDelta } from "./skills/common.ts";
import {
  AGENT_REPLICATIONS_DEFAULT_CAP,
  AGENT_REPLICATIONS_HARD_CAP,
  experimentTypesEnabled,
  DISRUPTION_EVENTS_MAX,
  REPLICATIONS_MAX,
  REPLICATIONS_MIN,
} from "./experimentTools.ts";
import registry from "../_shared/registry.generated.json" with { type: "json" };
import { engineTargetOf, type DisruptionRule } from "../_shared/disruptionRules.ts";
import type { RoutedDecision } from "./router.ts";
import {
  decideRun,
  parseRunChoice,
  resolveModelContext,
  type ModelContext,
  type RunChoice,
  type RunMode,
} from "./modelContext.ts";

/** The engine's event rule, exported by scsim (`registry_export.disruption_rule`). */
export const WHATIF_RULE = (registry as unknown as { disruption: DisruptionRule }).disruption;
/** Days per engine tick — the mapper rounds a schedule's days to these weeks. */
const DAYS_PER_TICK: number =
  ((registry as unknown as { run_window?: { days_per_tick?: number } }).run_window?.days_per_tick) ?? 7;

/** Kill switch, default ON. Unlike the staged agent flags this is a fix to a
 * shipped path (the persona already answered these asks, badly), and it is
 * reachable only with a project attached AND a message that parses as a
 * disruption what-if, so the flag-off golden transcripts are untouched.
 * `WHATIF_LOOP_ENABLED=false` restores the model-driven path. */
export function whatIfLoopEnabled(): boolean {
  return (Deno.env.get("WHATIF_LOOP_ENABLED") ?? "").trim().toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// 1. Understand — a pure parse. No project data, no model.
// ---------------------------------------------------------------------------

export interface WhatIfAsk {
  /** Raw target tokens as written ("S001", "Acme", "plant"). Resolved later. */
  targets: string[];
  startWeek: number | null;
  durationWeeks: number | null;
  /** The engine's reading: ≥ full_outage_pct is a lead-time delay (outage);
   * below it, capacity is cut BY that share. null ⇒ not stated. */
  magnitudePct: number | null;
  replications: number | null;
  /** The user explicitly asked for a fresh run ("re-run", "run it again"). */
  rerun: boolean;
}

const DISRUPTION_WORDS =
  /\b(disrupt\w*|outages?|shut\s*downs?|shuts?\s+down|goes\s+down|go\s+down|down\s+for|offline|fail(?:s|ed|ure)?|stops?\s+(?:supplying|shipping|delivering)|strikes?|closures?|closed|capacity\s+(?:cut|reduction|drop|loss)|cuts?\s+capacity|loses?\s+capacity)\b/i;
const QUESTION_WORDS =
  /\b(what\s+if|what\s+happens|what\s+would|what\s+will|what'?s\s+the\s+(?:impact|effect)|impact\s+of|effect\s+of|simulate|stress[-\s]?test|run\s+(?:a\s+)?(?:scenario|simulation|what-?if)|how\s+(?:bad|much|would))\b/i;

/** Tokens that look like ids but are time words ("w22", "wk4", "d10", "q3"). */
const TIME_TOKEN = /^(?:w|wk|wks|week|weeks|d|day|days|q|m|mo|month|months|h|hr|rep|reps)\d+$/i;

/** Read one disruption what-if out of a message, or null when it is not one.
 * Deliberately conservative: it needs a disruption word AND a question/run
 * word AND a target; anything else goes to the router as before. */
export function parseWhatIf(message: string, opts?: { requireQuestion?: boolean }): WhatIfAsk | null {
  const text = String(message ?? "").slice(0, 2000);
  // §26 M2/M5 read a disruption out of an EARLIER message ("how do I
  // mitigate it?"), which need not be phrased as a question.
  if (!DISRUPTION_WORDS.test(text) || (opts?.requireQuestion !== false && !QUESTION_WORDS.test(text))) return null;

  // --- targets: "the plant", "supplier X", or id-shaped tokens (S001, S-104)
  const targets: string[] = [];
  const push = (t: string) => {
    const v = t.replace(/^[("'`]+|[)"'`.,;:!?]+$/g, "").trim();
    if (v && !TIME_TOKEN.test(v) && !targets.some((x) => x.toLowerCase() === v.toLowerCase())) targets.push(v);
  };
  if (/\b(?:the\s+)?(?:plant|factory)\b/i.test(text)) push("plant");
  for (const m of text.matchAll(/\bsuppliers?\s+(?:named\s+|called\s+)?["'`]?([A-Za-z0-9][\w.-]{0,40})/gi)) {
    const word = m[1];
    // "supplier outage", "supplier at week" — a word, not a name.
    if (!/^(?:outage|disruption|failure|at|in|on|for|of|is|goes|shuts?|with|and|the|a|an|that|which|down)$/i.test(word)) push(word);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{1,4}[-_]?\d{1,6})\b/g)) push(m[1]);
  if (targets.length === 0) return null;

  // --- timing. A RANGE first ("weeks 22-25", "week 22 to 25"), then the start
  // ("week 22": unit BEFORE the number) and the duration ("4 weeks": number
  // BEFORE the unit) — the word order is what tells them apart.
  let startWeek: number | null = null;
  let durationWeeks: number | null = null;
  const range = text.match(/\b(?:weeks?|wks?)\s*#?\s*(\d{1,3})\s*(?:-|–|—|to|through|thru|until)\s*(?:weeks?\s*|wks?\s*)?(\d{1,3})\b/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b >= a) {
      startWeek = a;
      durationWeeks = b - a + 1;
    }
  }
  if (startWeek === null) {
    const s = text.match(/\b(?:weeks?|wks?|w)\s*#?\s*(\d{1,3})\b(?!\s*(?:weeks?|wks?|days?)\b)/i);
    if (s) startWeek = Number(s[1]);
    else {
      const d = text.match(/\bday\s*#?\s*(\d{1,4})\b/i);
      if (d) startWeek = Math.max(1, pyRound(Number(d[1]) / DAYS_PER_TICK));
    }
  }
  if (durationWeeks === null) {
    const dur = text.match(/\b(\d{1,3})\s*[- ]?\s*(weeks?|wks?|days?|months?)\b/i);
    if (dur) {
      const n = Number(dur[1]);
      const unit = dur[2].toLowerCase();
      durationWeeks = unit.startsWith("day")
        ? Math.max(1, pyRound(n / DAYS_PER_TICK))
        : unit.startsWith("month")
        ? Math.max(1, pyRound((n * 30.4375) / DAYS_PER_TICK))
        : n;
    }
  }

  // --- effect. "40% capacity cut" / "cut capacity by 40%" ⇒ a capacity
  // reduction BY that share; "outage", "shut down", "goes down" ⇒ full outage.
  let magnitudePct: number | null = null;
  const cut =
    text.match(/\b(\d{1,3})\s*%\s*(?:of\s+)?(?:capacity\s*)?(?:cut|reduction|drop|loss|less|lower)/i) ??
    text.match(/\b(?:cut|reduc\w*|drop\w*|lose|loses|losing)\s+(?:its\s+|their\s+)?(?:capacity\s+)?(?:by\s+)?(\d{1,3})\s*%/i);
  if (cut) {
    const pct = Number(cut[1]);
    if (pct > 0 && pct <= 100) magnitudePct = pct;
  } else if (/\b(outages?|shut\s*downs?|shuts?\s+down|goes\s+down|go\s+down|offline|fails?|failure|full(?:y)?\s+down|stops?\s+(?:supplying|shipping|delivering))\b/i.test(text)) {
    magnitudePct = WHATIF_RULE.full_outage_pct;
  }

  const reps = text.match(/\b(\d{1,3})\s*(?:replications?|reps?)\b/i);
  return {
    targets,
    startWeek,
    durationWeeks,
    magnitudePct,
    replications: reps ? Number(reps[1]) : null,
    rerun: /\b(re-?run|run\s+(?:it\s+)?again|fresh\s+run|new\s+run)\b/i.test(text),
  };
}

/** Python's round() (half to even) — the mapper's rounding of days to weeks
 * (`src/lib/sim/runWindow.ts::pyRound` is the browser's copy of the same rule). */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The route a parsed what-if takes — decided here, with NO classifier call
 * (the ask is already understood; spending a model call to re-learn it is
 * the latency this module exists to remove). Owned by the Experiment
 * Designer when the caller can route to it (§6.3: "SIMULATION RUNS …
 * scenarios and what-if questions"); otherwise advisory, and the loop still
 * answers the read half. The mode gate (applyModeToRoute) applies after. */
export function whatIfRouteDecision(designerRoutable: boolean): RoutedDecision {
  return {
    route: designerRoutable ? "artifact" : "advisory",
    agent_id: designerRoutable ? "experiment-designer" : null,
    intent: designerRoutable ? "exp.design" : null,
    confidence: 1,
    advisory_part: null,
    artifact_part: null,
    needs_run: true,
    cache_checkable: true,
    short_circuit: "whatif_parser",
  };
}

// ---------------------------------------------------------------------------
// 2–4. Resolve, check the cache by content, read or propose.
// ---------------------------------------------------------------------------

export interface ResolvedEvent {
  /** As stored in scenarios.disruption_schedule. */
  target: string;
  label: string;
  start_day: number;
  duration_days: number;
  magnitude_pct: number;
  startWeek: number;
  durationWeeks: number;
}

/** What the loop did, as data — index.ts turns it into the reply. */
export type WhatIfOutcome =
  | { kind: "needs_target"; ask: WhatIfAsk; message: string; candidates: string[] }
  | { kind: "invalid"; ask: WhatIfAsk; message: string }
  | { kind: "no_policy_version"; ask: WhatIfAsk; events: ResolvedEvent[]; message: string }
  | {
    kind: "hit";
    ask: WhatIfAsk;
    events: ResolvedEvent[];
    defaults: string[];
    runId: string;
    scenarioName: string;
    engine: string | null;
    badge: string | null;
    reps: number;
    kpis: KpiRow[];
    baselineRunId: string | null;
    /** §27: "follows Validated Model …" or "EXPLORATORY — …". */
    followLabel?: string;
    modeNote?: string | null;
    /** true when the differences are paired per replication (same seed). */
    paired?: boolean;
  }
  | {
    kind: "proposed";
    ask: WhatIfAsk;
    events: ResolvedEvent[];
    defaults: string[];
    proposal: ProposalPartData;
    staleNote: string | null;
    reusedScenario: string | null;
    followLabel?: string;
    modeNote?: string | null;
    /** The card also runs the model's baseline (no usable one existed). */
    withBaseline?: boolean;
  }
  // §27 guardrails: the loop stopped BEFORE drafting, and says what to do.
  | {
    kind: "no_model" | "needs_choice" | "model_blocked" | "needs_horizon";
    ask: WhatIfAsk;
    message: string;
  }
  | {
    kind: "not_proposed";
    ask: WhatIfAsk;
    events: ResolvedEvent[];
    defaults: string[];
    reason: string;
    staleNote: string | null;
    labSpec: string;
  };

export interface KpiRow {
  kpi: string;
  value: number;
  ci: number | null;
  baseline: number | null;
  /** Paired difference vs the baseline (per replication), when available. */
  delta?: { mean: number; ci: number; n: number } | null;
}

export interface WhatIfRun {
  outcome: WhatIfOutcome;
  /** Every tool call the loop made, for telemetry and the §22.3 verifier. */
  calls: Array<{ name: string; args: Record<string, unknown>; envelope: ToolEnvelope }>;
  /** Display parts (a KPI table on a hit; the proposal card on a draft). */
  parts: Array<{ kind: string; data: unknown }>;
}

export interface WhatIfOptions {
  /** false ⇒ never draft (Ask mode, or the Designer not routable for this
   * caller); the miss is answered with the exact Lab spec instead. */
  canDraft: boolean;
  /** One sentence for why no card was filed when canDraft is false. */
  draftBlockedReason?: string;
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export interface ScenarioRow {
  id: string;
  name?: string;
  horizon_days?: number;
  warmup_days?: number;
  replications?: number;
  disruption_schedule?: Array<Record<string, unknown>>;
  recovery_overrides?: Record<string, unknown>;
  created_at?: unknown;
}

/** The disruption a schedule entry means to the ENGINE, as one comparable key:
 * the target the mapper keeps, the start and duration in the weeks it rounds
 * to, and the effect. Two entries with the same key run identically. */
export function eventKey(
  e: Record<string, unknown>,
  supplierIds: ReadonlySet<string>,
): string | null {
  const t = engineTargetOf(String(e.target ?? e.target_id ?? ""), supplierIds, WHATIF_RULE);
  if (t.kind !== "supplier" && t.kind !== "plant") return null;
  const startDay = Number(e.start_day ?? 0);
  const durDays = Number(e.duration_days ?? 0);
  if (!Number.isFinite(startDay) || !Number.isFinite(durDays)) return null;
  const startWeek = Math.max(WHATIF_RULE.start_week_min, pyRound(startDay / DAYS_PER_TICK));
  const durWeeks = Math.min(
    WHATIF_RULE.duration_weeks_max,
    Math.max(WHATIF_RULE.duration_weeks_min, pyRound(durDays / DAYS_PER_TICK)),
  );
  const mag = Number(e.magnitude_pct ?? e.magnitude ?? WHATIF_RULE.full_outage_pct);
  // At or above the threshold every magnitude is the same lead-time delay.
  const effect = mag >= WHATIF_RULE.full_outage_pct ? "outage" : `cut${mag}`;
  return `${t.kind}:${t.id}|w${startWeek}|d${durWeeks}|${effect}`;
}

export function scheduleKey(
  schedule: Array<Record<string, unknown>> | undefined,
  supplierIds: ReadonlySet<string>,
): string | null {
  const events = (Array.isArray(schedule) ? schedule : []).slice(0, WHATIF_RULE.event_cap);
  const keys: string[] = [];
  for (const e of events) {
    const k = eventKey(e ?? {}, supplierIds);
    if (k) keys.push(k); // the mapper skips an event it cannot target
  }
  return keys.sort().join(";");
}

/** The Lab's default start: four measured weeks after the warm-up
 * (`src/lib/sim/disruptionTiming.ts::defaultDisruptionStartDay`, audit F-03). */
function defaultStartWeek(warmupDays: number | undefined): number {
  return Math.round((warmupDays ?? 0) / DAYS_PER_TICK) + 4;
}
/** The Lab's default duration (`disruptionEvents.ts::newEvent`). */
const DEFAULT_DURATION_WEEKS = 4;
/** Weeks after an event's end a new scenario keeps simulating, so recovery
 * (TTR/TTS) has a window to be measured in. */
const RECOVERY_TAIL_WEEKS = 8;

function effectWords(mag: number): string {
  return mag >= WHATIF_RULE.full_outage_pct ? "outage (lead-time delay)" : `${mag}% capacity reduction`;
}

export function describeEvents(events: ResolvedEvent[]): string {
  return events.map((e) => {
    const end = e.startWeek + e.durationWeeks - 1;
    const window = e.durationWeeks <= 1 ? `week ${e.startWeek}` : `weeks ${e.startWeek}–${end}`;
    return `${e.label} ${effectWords(e.magnitude_pct)}, ${window} (${e.durationWeeks} wk)`;
  }).join("; ");
}

async function loadSuppliers(db: Db, projectId: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const { data } = await db.from("suppliers").select("supplier_id,name").eq("project_id", projectId).limit(5000);
    return ((data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({ id: String(r.supplier_id ?? ""), name: String(r.name ?? "") }))
      .filter((r) => r.id);
  } catch {
    return [];
  }
}

/** One written target → one engine target, by exact id, exact name, then a
 * unique fragment. Ambiguity is returned, never guessed (§19.5). */
function resolveTarget(
  raw: string,
  suppliers: Array<{ id: string; name: string }>,
): { ok: true; target: string; label: string } | { ok: false; candidates: string[] } | null {
  const r = raw.toLowerCase();
  if (r === "plant") return { ok: true, target: "node:plant", label: "the plant" };
  const exact = suppliers.find((s) => s.id.toLowerCase() === r) ??
    suppliers.find((s) => s.name && s.name.toLowerCase() === r);
  if (exact) return { ok: true, target: `supplier:${exact.id}`, label: `supplier ${exact.id}` };
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const nr = norm(raw);
  const loose = suppliers.filter((s) => norm(s.id) === nr);
  if (loose.length === 1) return { ok: true, target: `supplier:${loose[0].id}`, label: `supplier ${loose[0].id}` };
  if (nr.length >= 3) {
    const frag = suppliers.filter((s) => norm(s.id).includes(nr) || (s.name && norm(s.name).includes(nr)));
    if (frag.length === 1) return { ok: true, target: `supplier:${frag[0].id}`, label: `supplier ${frag[0].id}` };
    if (frag.length > 1) return { ok: false, candidates: frag.slice(0, 5).map((s) => s.name ? `${s.id} (${s.name})` : s.id) };
  }
  return null; // not a supplier of this project — maybe not a target at all
}

async function call(
  run: WhatIfRun,
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const envelope = await executeTool(name, args, ctx);
  run.calls.push({ name, args, envelope });
  return envelope;
}

/** Headline KPIs first, then the rest, at most 8 — the display order a
 * decision reader expects, not the persisted object's key order. */
const KPI_ORDER = ["fill_rate", "service_level", "otif", "backlog", "max_backlog", "lost_sales", "ttr_weeks", "tts_weeks", "pvar", "total_cost", "revenue", "profit", "capacity_utilization"];

function readKpis(row: Record<string, unknown> | null): Map<string, { value: number; ci: number | null }> {
  const out = new Map<string, { value: number; ci: number | null }>();
  if (!row) return out;
  const agg = (row.aggregate_kpis ?? {}) as Record<string, unknown>;
  const ci = (row.ci_half_widths ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(agg)) {
    if (k.startsWith("_")) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    const c = Number(ci[k]);
    out.set(k, { value: n, ci: Number.isFinite(c) ? c : null });
  }
  return out;
}

function orderKpis(keys: string[]): string[] {
  const rank = (k: string) => {
    const i = KPI_ORDER.indexOf(k);
    return i < 0 ? KPI_ORDER.length : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 8);
}

/** The loop. Every branch ends in a WhatIfOutcome; nothing here throws past
 * the caller (a failed read degrades to the honest branch it implies). */
/** Everything the disruption skills (§20.8 what-if, §26 M2 mitigation, M5
 * sensitivity) share before they diverge: targets resolved by the engine's
 * rule, defaults named, the schedule built, scenarios loaded, the saved
 * policy version and the replication count chosen. A refusal comes back as
 * the outcome to answer with; nothing here reads a run or files a card. */
export interface PreparedWhatIf {
  events: ResolvedEvent[];
  schedule: Array<Record<string, unknown>>;
  askedKey: string | null;
  defaults: string[];
  scenarios: ScenarioRow[];
  supplierIds: Set<string>;
  base: ScenarioRow | null;
  isBaseline: (s: ScenarioRow) => boolean;
  versionId: string;
  replications: number;
  durationWeeks: number;
  magnitude: number;
  /** §27: "model" = the run follows the Validated Model; else exploratory. */
  mode: RunMode;
  model: ModelContext;
  /** One sentence the reply carries about HOW this is run (or null). */
  modeNote: string | null;
  /** The scenario length a NEW scenario gets (the model's, unless extended). */
  horizonDays: number;
  /** The scenario whose world an exploratory scenario copies (or null). */
  seedScenarioId: string | null;
}

export async function prepareWhatIf(
  ctx: ToolContext,
  ask: WhatIfAsk,
  choice: RunChoice = { mode: null, extendHorizon: false },
): Promise<{ ok: true; prep: PreparedWhatIf } | { ok: false; outcome: WhatIfOutcome }> {
  const run = { outcome: null as unknown as WhatIfOutcome };
  const db = ctx.supabase as unknown as Db;

  // --- resolve targets against THIS project's suppliers (the engine's rule)
  const suppliers = await loadSuppliers(db, ctx.projectId);
  const supplierIds = new Set(suppliers.map((s) => s.id));
  const resolved: Array<{ target: string; label: string }> = [];
  for (const raw of ask.targets) {
    const r = resolveTarget(raw, suppliers);
    if (r === null) continue;
    if (!r.ok) {
      run.outcome = {
        kind: "needs_target",
        ask,
        message: `"${raw}" matches more than one supplier — which did you mean?`,
        candidates: r.candidates,
      };
      return { ok: false, outcome: run.outcome };
    }
    if (!resolved.some((x) => x.target === r.target)) resolved.push(r);
  }
  if (resolved.length === 0) {
    const named = ask.targets.filter((t) => t !== "plant").join(", ");
    run.outcome = {
      kind: "needs_target",
      ask,
      message: named
        ? `I can't find a supplier called ${named} in this project, and the engine can only disrupt a supplier of this project or the plant.`
        : "Which supplier (or the plant) should be disrupted?",
      candidates: suppliers.slice(0, 5).map((s) => s.name ? `${s.id} (${s.name})` : s.id),
    };
    return { ok: false, outcome: run.outcome };
  }
  if (resolved.length > DISRUPTION_EVENTS_MAX) {
    run.outcome = {
      kind: "invalid",
      ask,
      message: `That's ${resolved.length} disrupted nodes; the engine runs at most ${DISRUPTION_EVENTS_MAX} events per scenario.`,
    };
    return { ok: false, outcome: run.outcome };
  }

  // --- scenarios (base settings + the content-addressed cache)
  let scenarios: ScenarioRow[] = [];
  try {
    const { data } = await db.from("scenarios").select("*").eq("project_id", ctx.projectId)
      .order("created_at", { ascending: false }).limit(50);
    scenarios = (data ?? []) as ScenarioRow[];
  } catch { /* no scenarios: every lookup misses */ }
  const isBaseline = (s: ScenarioRow) => scheduleKey(s.disruption_schedule, supplierIds) === "";
  const base = scenarios.find(isBaseline) ?? scenarios[0] ?? null;

  // --- §27: the Validated Model, and the ONE decision about how to run.
  const model = await resolveModelContext(ctx, ctx.draft?.utterance ?? "");
  const decision = decideRun(model, choice);
  if (decision.kind === "stop") {
    run.outcome = { kind: decision.code, ask, message: decision.message };
    return { ok: false, outcome: run.outcome };
  }
  const mode: RunMode = decision.kind === "follow" ? "model" : "exploratory";
  const modeNote = decision.kind === "follow" ? decision.note : `Exploratory run (${decision.why}) — not a validated result.`;
  // The world a new scenario starts in: the model's baseline, else the
  // project's own baseline row — never generic defaults when either exists.
  const seedScenario = model.evidenceScenario ?? base;
  const warmupWeek = mode === "model" && model.protocol.warmup_week != null ? model.protocol.warmup_week : null;
  const warmupDays = warmupWeek !== null ? warmupWeek * DAYS_PER_TICK : seedScenario?.warmup_days;

  // --- defaults, each one NAMED in the reply (T2: substitution is visible)
  const defaults: string[] = [];
  let startWeek = ask.startWeek;
  if (startWeek === null) {
    startWeek = defaultStartWeek(warmupDays);
    defaults.push(`start week ${startWeek} (four weeks after the warm-up — the Lab's default)`);
  }
  let durationWeeks = ask.durationWeeks;
  if (durationWeeks === null) {
    durationWeeks = DEFAULT_DURATION_WEEKS;
    defaults.push(`a ${DEFAULT_DURATION_WEEKS}-week duration (the Lab's default)`);
  }
  let magnitude = ask.magnitudePct;
  if (magnitude === null) {
    magnitude = WHATIF_RULE.full_outage_pct;
    defaults.push("a full outage (no capacity share was given)");
  }
  if (startWeek < WHATIF_RULE.start_week_min) {
    run.outcome = { kind: "invalid", ask, message: `A disruption can start at week ${WHATIF_RULE.start_week_min} at the earliest.` };
    return { ok: false, outcome: run.outcome };
  }
  if (durationWeeks < WHATIF_RULE.duration_weeks_min || durationWeeks > WHATIF_RULE.duration_weeks_max) {
    run.outcome = {
      kind: "invalid",
      ask,
      message: `The engine runs a disruption of ${WHATIF_RULE.duration_weeks_min}–${WHATIF_RULE.duration_weeks_max} weeks; ${durationWeeks} weeks is outside that.`,
    };
    return { ok: false, outcome: run.outcome };
  }
  // --- §27 rows 7: the disruption against the model's measured window.
  const endWeekIncl = startWeek + durationWeeks - 1;
  let horizonDays: number;
  if (mode === "model") {
    if (warmupWeek !== null && startWeek <= warmupWeek) {
      run.outcome = {
        kind: "invalid",
        ask,
        message: `Week ${startWeek} is inside the model's warm-up (results are measured from week ${warmupWeek + 1}), so the engine could not measure this disruption. ` +
          `Try a start at week ${warmupWeek + 4} or later — for example "…at week ${warmupWeek + 4}".`,
      };
      return { ok: false, outcome: run.outcome };
    }
    const modelWeeks = model.horizonDays ? Math.ceil(model.horizonDays / DAYS_PER_TICK) : null;
    if (modelWeeks !== null && endWeekIncl > modelWeeks) {
      const needed = endWeekIncl + Math.max(RECOVERY_TAIL_WEEKS, durationWeeks);
      if (!choice.extendHorizon) {
        // Owner decision 2: a longer run changes the validated setup — ask first.
        run.outcome = {
          kind: "needs_horizon",
          ask,
          message: `"${model.name}" simulates ${modelWeeks} weeks, and this disruption runs to week ${endWeekIncl}. ` +
            `Choose one: an earlier start (so it ends by week ${modelWeeks}), or say "extend the horizon" and I'll run ${needed} weeks — ` +
            `shown on the card as a deviation from the validated model.`,
        };
        return { ok: false, outcome: run.outcome };
      }
      horizonDays = Math.min(3650, needed * DAYS_PER_TICK);
    } else {
      horizonDays = model.horizonDays ??
        Math.max(Number(seedScenario?.horizon_days ?? 0) || 0, (endWeekIncl + Math.max(RECOVERY_TAIL_WEEKS, durationWeeks)) * DAYS_PER_TICK);
    }
  } else {
    horizonDays = Math.min(
      3650,
      Math.max(Number(seedScenario?.horizon_days ?? 0) || 0, (endWeekIncl + 1 + Math.max(RECOVERY_TAIL_WEEKS, durationWeeks)) * DAYS_PER_TICK),
    );
  }

  const events: ResolvedEvent[] = resolved.map((r) => ({
    target: r.target,
    label: r.label,
    start_day: startWeek! * DAYS_PER_TICK,
    duration_days: durationWeeks! * DAYS_PER_TICK,
    magnitude_pct: magnitude!,
    startWeek: startWeek!,
    durationWeeks: durationWeeks!,
  }));
  const schedule = events.map((e) => ({
    target: e.target,
    target_type: "node",
    start_day: e.start_day,
    duration_days: e.duration_days,
    magnitude_pct: e.magnitude_pct,
  }));
  const askedKey = scheduleKey(schedule, supplierIds);

  // --- the saved policy version the run binds: the MODEL's when following it
  // (§27), else the project's newest (§20.2's default).
  let versionId = mode === "model" ? String(model.card?.policy_version_id ?? "") : "";
  if (!versionId) {
    try {
      const { data } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
      versionId = String((Array.isArray(data) ? data : [])[0]?.id ?? "");
    } catch { /* handled below */ }
  }
  if (!versionId) {
    run.outcome = {
      kind: "no_policy_version",
      ask,
      events,
      message:
        "This project has no saved policy version yet, and every run binds one. Save a version on /policies, then ask again.",
    };
    return { ok: false, outcome: run.outcome };
  }
  // §27.3 decision 1: a run that follows the model takes the PROTOCOL's
  // replications — capped at 38(al)'s 30; a count the user states is used and
  // shown as a deviation. An exploratory run keeps 38(ad)'s 5-unless-stated.
  const protocolReps = mode === "model"
    ? Math.min(AGENT_REPLICATIONS_HARD_CAP, Number(model.protocol.replications) || 0) || null
    : null;
  const replications = Math.max(
    REPLICATIONS_MIN,
    Math.min(REPLICATIONS_MAX, Math.floor(ask.replications ?? protocolReps ?? AGENT_REPLICATIONS_DEFAULT_CAP)),
  );

  return {
    ok: true,
    prep: {
      events, schedule, askedKey, defaults, scenarios, supplierIds, base, isBaseline,
      versionId, replications, durationWeeks: durationWeeks!, magnitude: magnitude!,
      mode, model, modeNote, horizonDays, seedScenarioId: seedScenario?.id ?? null,
    },
  };
}

/** A finished run of THIS model on one of the given scenarios (§27 WP V.5):
 * the cache for a model-following ask only ever answers with a run that
 * followed the same model — never an exploratory one. */
async function findModelRun(
  db: Db,
  scenarioIds: string[],
  cardId: string,
  minReps: number,
): Promise<Record<string, unknown> | null> {
  if (scenarioIds.length === 0) return null;
  try {
    const { data } = await db.from("simulation_runs")
      .select("id,scenario_id,status,rep_count_done,model_validation_id,exploratory,code_version,created_at")
      .in("scenario_id", scenarioIds).eq("status", "done").order("created_at", { ascending: false }).limit(40);
    return ((data ?? []) as Array<Record<string, unknown>>).find((r) =>
      String(r.model_validation_id ?? "") === cardId && r.exploratory !== true && Number(r.rep_count_done ?? 0) >= minReps
    ) ?? null;
  } catch {
    return null;
  }
}

/** The model's own baseline run: its evidence run when that simulated no
 * disruption, else the newest finished no-disruption run that followed it. */
async function modelBaselineRunId(db: Db, prep: PreparedWhatIf): Promise<string | null> {
  const { model, scenarios, isBaseline, supplierIds } = prep;
  if (!model.card) return null;
  const ev = model.evidenceScenario;
  if (model.evidenceRunId && ev && scheduleKey(ev.disruption_schedule, supplierIds) === "") {
    try {
      const { data } = await db.from("simulation_runs").select("id,status").eq("id", model.evidenceRunId).maybeSingle();
      if (data && String((data as Record<string, unknown>).status) === "done") return model.evidenceRunId;
    } catch { /* fall through */ }
  }
  const hit = await findModelRun(db, scenarios.filter(isBaseline).map((x) => String(x.id)), String(model.card.id), 1);
  return hit ? String(hit.id) : null;
}

export async function runWhatIfLoop(
  ctx: ToolContext,
  ask: WhatIfAsk,
  opts: WhatIfOptions,
): Promise<WhatIfRun> {
  const run: WhatIfRun = { outcome: null as unknown as WhatIfOutcome, calls: [], parts: [] };
  const db = ctx.supabase as unknown as Db;
  const p = await prepareWhatIf(ctx, ask, parseRunChoice(ctx.draft?.utterance ?? ""));
  if (!p.ok) {
    run.outcome = p.outcome;
    return run;
  }
  const prep = p.prep;
  const { events, schedule, askedKey, defaults, scenarios, supplierIds, isBaseline, versionId, replications, mode, model } = prep;
  const matching = scenarios.filter((s) => scheduleKey(s.disruption_schedule, supplierIds) === askedKey).slice(0, 5);
  const followLabel = mode === "model" ? `follows Validated Model "${model.name}"` : "EXPLORATORY — not a validated result";

  const answerFrom = async (runId: string, scenarioName: string, baselineRunId: string | null, paired: boolean) => {
    const runRow = await loadRunRow(db, ctx.projectId, runId);
    await call(run, ctx, "get_run_results", { run_id: runId });
    const baselineRow = baselineRunId ? await loadRunRow(db, ctx.projectId, baselineRunId) : null;
    const kp = readKpis(runRow);
    const bk = readKpis(baselineRow);
    const reps = paired && baselineRunId ? await loadRepKpis(db, runId) : new Map();
    const breps = paired && baselineRunId ? await loadRepKpis(db, baselineRunId) : new Map();
    const kpis: KpiRow[] = orderKpis([...kp.keys()]).map((k) => {
      const d = reps.get(k) && breps.get(k) ? pairedDelta(reps.get(k)!, breps.get(k)!) : null;
      return { kpi: k, value: kp.get(k)!.value, ci: kp.get(k)!.ci, baseline: bk.get(k)?.value ?? null, delta: d };
    });
    run.outcome = {
      kind: "hit",
      ask,
      events,
      defaults,
      runId,
      scenarioName,
      engine: runRow?.code_version ? String(runRow.code_version) : null,
      badge: null,
      reps: Number(runRow?.rep_count_done ?? 0),
      kpis,
      baselineRunId,
      followLabel,
      modeNote: prep.modeNote,
      paired: kpis.some((k) => k.delta),
    };
    if (kpis.length > 0) run.parts.push(kpiPart(kpis, baselineRunId !== null));
  };

  // ── FOLLOWING THE MODEL (§27) ─────────────────────────────────────────────
  if (mode === "model") {
    const cardId = String(model.card!.id);
    const hit = ask.rerun ? null : await findModelRun(db, matching.map((x) => String(x.id)), cardId, ask.replications ?? 1);
    const baselineRunId = await modelBaselineRunId(db, prep);
    if (hit) {
      const sc = matching.find((x) => String(x.id) === String(hit.scenario_id));
      await answerFrom(String(hit.id), String(sc?.name ?? hit.scenario_id), baselineRunId, true);
      return run;
    }
    const shortName = describeEvents(events).replace(/ \(\d+ wk\)/g, "");
    const labSpec = `In the Simulation Lab, choose the model "${model.name}", add this disruption — ${shortName} — and run it with ${replications} replications.`;
    if (!opts.canDraft) {
      run.outcome = {
        kind: "not_proposed", ask, events, defaults,
        reason: opts.draftBlockedReason ?? "drafting a run proposal isn't available to you here",
        staleNote: null, labSpec,
      };
      return run;
    }
    // No usable baseline run of this model ⇒ the card runs the baseline too
    // (one approval, two runs, a paired comparison) when comparisons are on.
    const withBaseline = baselineRunId === null && experimentTypesEnabled().includes("comparison");
    const scenarioName = `What-if: ${shortName}`.slice(0, 120);
    const args: Record<string, unknown> = {
      new_scenario: { name: scenarioName, horizon_days: prep.horizonDays, disruption_schedule: schedule },
      ...(withBaseline
        ? {
          experiment_type: "comparison",
          arms: [
            { label: "Baseline (no disruption)", disruption_schedule: [] },
            { label: "With disruption", disruption_schedule: schedule },
          ],
        }
        : {}),
      validated_model_id: cardId,
      policy_version_id: versionId,
      replications,
      title: `What-if: ${shortName}`.slice(0, 140),
      ...(ctx.draft?.utterance ? { question: ctx.draft.utterance.slice(0, 500) } : {}),
    };
    const env = await call(run, ctx, "draft_experiment_spec", args);
    if (env.kind === "proposal") {
      const proposal = env.data as ProposalPartData;
      run.parts.push({ kind: "proposal", data: proposal });
      run.outcome = {
        kind: "proposed", ask, events, defaults, proposal, staleNote: null, reusedScenario: null,
        followLabel, modeNote: prep.modeNote, withBaseline,
      };
      return run;
    }
    run.outcome = {
      kind: "not_proposed", ask, events, defaults,
      reason: String(env.data ?? "the draft was refused"), staleNote: null, labSpec,
    };
    return run;
  }

  // ── EXPLORATORY (the user asked for it; §27.8 decision 1) ─────────────────
  // The §20.2 identity on the project's CURRENT versions, as before.
  let staleNote: string | null = null;
  for (const s of matching.slice(0, 3)) {
    const env = await call(run, ctx, "find_completed_run", {
      scenario: s.id,
      policy_version_id: versionId,
      replications: ask.replications ?? 1,
    });
    const note = String(env.meta.note ?? "");
    if (note.startsWith("cache_hit") && env.kind === "table" && !ask.rerun) {
      const runId = String(((env.data as { rows?: unknown[][] })?.rows ?? [])[0]?.[0] ?? "");
      let baselineRunId: string | null = null;
      const baseScenario = scenarios.find(isBaseline);
      if (baseScenario) {
        const b = await call(run, ctx, "find_completed_run", { scenario: baseScenario.id, policy_version_id: versionId });
        if (String(b.meta.note ?? "").startsWith("cache_hit") && b.kind === "table") {
          baselineRunId = String(((b.data as { rows?: unknown[][] })?.rows ?? [])[0]?.[0] ?? "") || null;
        }
      }
      await answerFrom(runId, String(s.name ?? s.id), baselineRunId, false);
      return run;
    }
    if (note === "cache_stale" && !staleNote) staleNote = String(env.data ?? "");
  }

  const reuse = matching[0] ?? null;
  const labSpec = labInstructions(events, versionId, replications, reuse?.name ?? null);
  if (!opts.canDraft) {
    run.outcome = {
      kind: "not_proposed", ask, events, defaults,
      reason: opts.draftBlockedReason ?? "drafting a run proposal isn't available to you here",
      staleNote, labSpec,
    };
    return run;
  }
  const shortName = describeEvents(events).replace(/ \(\d+ wk\)/g, "");
  const args: Record<string, unknown> = reuse
    ? { scenario_id: reuse.id }
    : {
      new_scenario: {
        name: `What-if: ${shortName}`.slice(0, 120),
        horizon_days: prep.horizonDays,
        disruption_schedule: schedule,
      },
      ...(prep.seedScenarioId ? { base_scenario_id: prep.seedScenarioId } : {}),
    };
  Object.assign(args, {
    exploratory: true,
    policy_version_id: versionId,
    replications,
    title: `What-if (exploratory): ${shortName}`.slice(0, 140),
    ...(ctx.draft?.utterance ? { question: ctx.draft.utterance.slice(0, 500) } : {}),
  });
  const env = await call(run, ctx, "draft_experiment_spec", args);
  if (env.kind === "proposal") {
    const proposal = env.data as ProposalPartData;
    run.parts.push({ kind: "proposal", data: proposal });
    run.outcome = {
      kind: "proposed", ask, events, defaults, proposal, staleNote,
      reusedScenario: reuse ? String(reuse.name ?? reuse.id) : null,
      followLabel, modeNote: prep.modeNote, withBaseline: false,
    };
    return run;
  }
  run.outcome = {
    kind: "not_proposed", ask, events, defaults,
    reason: String(env.data ?? "the draft was refused"), staleNote, labSpec,
  };
  return run;
}

async function loadRunRow(db: Db, projectId: string, runId: string): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await db.from("simulation_runs")
      .select("id,project_id,aggregate_kpis,ci_half_widths,code_version,rep_count_done")
      .eq("id", runId).maybeSingle();
    if (!data || String((data as Record<string, unknown>).project_id) !== projectId) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString("en-US");
  if (a >= 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 10000) / 10000);
}

function kpiPart(kpis: KpiRow[], withBaseline: boolean): { kind: string; data: unknown } {
  const paired = kpis.some((k) => k.delta);
  const columns = withBaseline
    ? ["KPI", "With disruption", "± CI", "Baseline", paired ? "Difference (paired, 95% CI)" : "Difference"]
    : ["KPI", "With disruption", "± CI"];
  const rows = kpis.map((k) => {
    const base = [k.kpi, fmt(k.value), k.ci === null ? "—" : fmt(k.ci)];
    if (!withBaseline) return base;
    const diff = k.delta
      ? `${k.delta.mean >= 0 ? "+" : ""}${fmt(k.delta.mean)} ± ${fmt(k.delta.ci)}`
      : k.baseline === null ? "—" : fmt(k.value - k.baseline);
    return [...base, k.baseline === null ? "—" : fmt(k.baseline), diff];
  });
  return { kind: "table", data: { columns, rows } };
}

function labInstructions(events: ResolvedEvent[], versionId: string, reps: number, scenario: string | null): string {
  const ev = events.map((e) =>
    `${e.label}: start week ${e.startWeek}, duration ${e.durationWeeks} weeks, ` +
    (e.magnitude_pct >= WHATIF_RULE.full_outage_pct ? "lead-time delay (full outage)" : `capacity reduction ${e.magnitude_pct}%`)
  ).join("; ");
  return scenario
    ? `In the Simulation Lab, run the existing scenario "${scenario}" against policy version ${versionId.slice(0, 8)} with ${reps} replications.`
    : `In the Simulation Lab, add a scenario with this disruption — ${ev} — and run it against policy version ${versionId.slice(0, 8)} with ${reps} replications.`;
}

// ---------------------------------------------------------------------------
// 5. The words. Deterministic for every branch; index.ts may ask the model
// for an interpretation paragraph on a hit only.
// ---------------------------------------------------------------------------

export function whatIfReply(outcome: WhatIfOutcome): string {
  const assumed = "defaults" in outcome && outcome.defaults.length > 0
    ? ` I assumed ${outcome.defaults.join(", ")} — tell me if you meant something else.`
    : "";
  switch (outcome.kind) {
    case "needs_target":
      return outcome.candidates.length > 0
        ? `${outcome.message}\n${outcome.candidates.map((c) => `- ${c}`).join("\n")}`
        : outcome.message;
    case "invalid":
    case "no_policy_version":
    case "no_model":
    case "needs_choice":
    case "model_blocked":
    case "needs_horizon":
      return outcome.message;
    case "hit": {
      const headline = outcome.kpis[0];
      const d = headline?.delta ?? null;
      const lead = headline
        ? ` ${headline.kpi} came out at ${fmt(headline.value)}` +
          (headline.baseline !== null
            ? ` against ${fmt(headline.baseline)} with no disruption` +
              (d ? ` (${d.mean >= 0 ? "+" : ""}${fmt(d.mean)} ± ${fmt(d.ci)}, paired over ${d.n} replications; baseline run ${outcome.baselineRunId})` : ` (run ${outcome.baselineRunId})`)
            : "") + "."
        : "";
      const compare = outcome.baselineRunId
        ? (outcome.paired
          ? " The difference is paired: both runs use the same random numbers, so it is the disruption's effect."
          : " Differences are descriptive — the two runs are not paired.")
        : " No baseline run exists to compare against yet.";
      return `A completed run already answers this: run ${outcome.runId} (scenario "${outcome.scenarioName}", ` +
        `${outcome.reps} replications${outcome.followLabel ? `, ${outcome.followLabel}` : ""}` +
        `${outcome.engine ? `, engine version ${outcome.engine}` : ""}) simulated ${describeEvents(outcome.events)}.` +
        lead + compare +
        (outcome.modeNote ? ` ${outcome.modeNote}` : "") +
        assumed;
    }
    case "proposed": {
      const what = describeEvents(outcome.events);
      const why = outcome.staleNote
        ? `There was a run of this, but it's out of date: ${outcome.staleNote} `
        : "No completed run covers this yet. ";
      const where = outcome.reusedScenario
        ? `re-run the existing scenario "${outcome.reusedScenario}"`
        : outcome.withBaseline
        ? `run ${what} together with the model's no-disruption baseline (two runs on the same random numbers, so the difference is the disruption's effect)`
        : `run a new scenario with ${what}`;
      return `${why}I've drafted a proposal to ${where} — ${outcome.proposal.summary}. ` +
        `Nothing runs until you approve the card below; the answer arrives here when the run finishes.` +
        (outcome.modeNote ? ` ${outcome.modeNote}` : "") +
        assumed;
    }
    case "not_proposed": {
      const why = outcome.staleNote
        ? `There was a run of this, but it's out of date: ${outcome.staleNote} `
        : "No completed run covers this yet, so there are no results to report. ";
      return `${why}I couldn't draft the run for you (${outcome.reason.replace(/\.$/, "")}). ${outcome.labSpec}` + assumed;
    }
  }
}

/** System prompt for the interpretation call: no tools, no project block —
 * every number it may use is in the handoff message. */
export const WHATIF_INTERPRETER_SYSTEM =
  "You are the Supply Chain assistant, briefing a teammate on a simulation result. " +
  "You have no tools. Use only the numbers given in the message, write plain sentences " +
  "(no headers, no tables, no bullet lists), and never present a difference as statistically significant.";

/** The internal handoff for the one optional model call (a hit only): the
 * deterministic answer + the KPI rows; the model may add interpretation but
 * no number that is not in it. */
export function whatIfInterpretationMessage(utterance: string, outcome: WhatIfOutcome): string | null {
  if (outcome.kind !== "hit" || outcome.kpis.length === 0) return null;
  const rows = outcome.kpis.map((k) =>
    `${k.kpi}: ${fmt(k.value)}${k.ci !== null ? ` ±${fmt(k.ci)}` : ""}` +
    (k.baseline !== null
      ? ` (baseline ${fmt(k.baseline)}, difference ${k.delta ? `${fmt(k.delta.mean)} ±${fmt(k.delta.ci)} paired` : fmt(k.value - k.baseline)})`
      : "")
  ).join("\n");
  return `[internal handoff — this is not a user message]
The user asked: "${utterance.slice(0, 1000)}"
The platform found a completed simulation run and wrote this answer:
"${whatIfReply(outcome)}"
KPI results of that run:
${rows}
Write 1-3 sentences that interpret these results for the user: which KPI
moved most and what it means for them. Use ONLY numbers listed above, name
the run id once, and do not call the difference significant. Do not repeat
the table.`;
}

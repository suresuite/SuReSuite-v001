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
import { DISRUPTION_EVENTS_MAX, REPLICATIONS_MAX, REPLICATIONS_MIN } from "./experimentTools.ts";
import registry from "../_shared/registry.generated.json" with { type: "json" };
import { engineTargetOf, type DisruptionRule } from "../_shared/disruptionRules.ts";
import type { RoutedDecision } from "./router.ts";

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
export function parseWhatIf(message: string): WhatIfAsk | null {
  const text = String(message ?? "").slice(0, 2000);
  if (!DISRUPTION_WORDS.test(text) || !QUESTION_WORDS.test(text)) return null;

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
  }
  | {
    kind: "proposed";
    ask: WhatIfAsk;
    events: ResolvedEvent[];
    defaults: string[];
    proposal: ProposalPartData;
    staleNote: string | null;
    reusedScenario: string | null;
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

interface ScenarioRow {
  id: string;
  name?: string;
  horizon_days?: number;
  warmup_days?: number;
  replications?: number;
  disruption_schedule?: Array<Record<string, unknown>>;
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
export async function runWhatIfLoop(
  ctx: ToolContext,
  ask: WhatIfAsk,
  opts: WhatIfOptions,
): Promise<WhatIfRun> {
  const run: WhatIfRun = { outcome: null as unknown as WhatIfOutcome, calls: [], parts: [] };
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
      return run;
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
    return run;
  }
  if (resolved.length > DISRUPTION_EVENTS_MAX) {
    run.outcome = {
      kind: "invalid",
      ask,
      message: `That's ${resolved.length} disrupted nodes; the engine runs at most ${DISRUPTION_EVENTS_MAX} events per scenario.`,
    };
    return run;
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

  // --- defaults, each one NAMED in the reply (T2: substitution is visible)
  const defaults: string[] = [];
  let startWeek = ask.startWeek;
  if (startWeek === null) {
    startWeek = defaultStartWeek(base?.warmup_days);
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
    return run;
  }
  if (durationWeeks < WHATIF_RULE.duration_weeks_min || durationWeeks > WHATIF_RULE.duration_weeks_max) {
    run.outcome = {
      kind: "invalid",
      ask,
      message: `The engine runs a disruption of ${WHATIF_RULE.duration_weeks_min}–${WHATIF_RULE.duration_weeks_max} weeks; ${durationWeeks} weeks is outside that.`,
    };
    return run;
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

  // --- the saved policy version every run binds (newest, §20.2's default)
  let versionId = "";
  let recommendedReps: number | null = null;
  try {
    const { data } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
    versionId = String((Array.isArray(data) ? data : [])[0]?.id ?? "");
  } catch { /* handled below */ }
  if (!versionId) {
    run.outcome = {
      kind: "no_policy_version",
      ask,
      events,
      message:
        "This project has no saved policy version yet, and every run binds one. Save a version on /policies, then ask again.",
    };
    return run;
  }
  try {
    const { data } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
    const card = (Array.isArray(data) ? data : []).find(
      (c: Record<string, unknown>) => c.status === "active" && String(c.policy_version_id ?? "") === versionId,
    );
    const n = Number(card?.recommended_replications);
    if (Number.isFinite(n) && n > 0) recommendedReps = n;
  } catch { /* the base scenario's count is the fallback */ }
  const replications = Math.max(
    REPLICATIONS_MIN,
    Math.min(REPLICATIONS_MAX, Math.floor(ask.replications ?? recommendedReps ?? (Number(base?.replications) || 10))),
  );

  // --- CACHE, by content: scenarios whose schedule runs identically, each
  // checked with the unchanged §20.2 identity (find_completed_run).
  const matching = scenarios.filter((s) => scheduleKey(s.disruption_schedule, supplierIds) === askedKey).slice(0, 3);
  let staleNote: string | null = null;
  for (const s of matching) {
    const env = await call(run, ctx, "find_completed_run", {
      scenario: s.id,
      policy_version_id: versionId,
      replications: ask.replications ?? 1,
    });
    const note = String(env.meta.note ?? "");
    if (note.startsWith("cache_hit") && env.kind === "table" && !ask.rerun) {
      const rows = ((env.data as { rows?: unknown[][] })?.rows ?? []);
      const hit = rows[0] ?? [];
      const runId = String(hit[0] ?? "");
      const runRow = await loadRunRow(db, ctx.projectId, runId);
      await call(run, ctx, "get_run_results", { run_id: runId });
      // The baseline: a no-disruption scenario's matching run, for a
      // descriptive difference (§5.4: differences are descriptive unless a
      // paired statistic is persisted — the reply says so).
      let baselineRow: Record<string, unknown> | null = null;
      let baselineRunId: string | null = null;
      const baseScenario = scenarios.find(isBaseline);
      if (baseScenario) {
        const b = await call(run, ctx, "find_completed_run", { scenario: baseScenario.id, policy_version_id: versionId });
        if (String(b.meta.note ?? "").startsWith("cache_hit") && b.kind === "table") {
          baselineRunId = String(((b.data as { rows?: unknown[][] })?.rows ?? [])[0]?.[0] ?? "") || null;
          if (baselineRunId) baselineRow = await loadRunRow(db, ctx.projectId, baselineRunId);
        }
      }
      const kp = readKpis(runRow);
      const bk = readKpis(baselineRow);
      const kpis: KpiRow[] = orderKpis([...kp.keys()]).map((k) => ({
        kpi: k,
        value: kp.get(k)!.value,
        ci: kp.get(k)!.ci,
        baseline: bk.get(k)?.value ?? null,
      }));
      run.outcome = {
        kind: "hit",
        ask,
        events,
        defaults,
        runId,
        scenarioName: String(s.name ?? s.id),
        engine: (hit[4] as string | null) && hit[4] !== "-" ? String(hit[4]) : null,
        badge: (hit[5] as string | null) ? String(hit[5]) : null,
        reps: Number(hit[2] ?? 0),
        kpis,
        baselineRunId,
      };
      if (kpis.length > 0) run.parts.push(kpiPart(kpis, baselineRunId !== null));
      return run;
    }
    if (note === "cache_stale" && !staleNote) staleNote = String(env.data ?? "");
  }

  // --- MISS (or stale): propose the run — through the unchanged §5.4 handler.
  const reuse = matching[0] ?? null;
  const labSpec = labInstructions(events, versionId, replications, reuse?.name ?? null);
  if (!opts.canDraft) {
    run.outcome = {
      kind: "not_proposed",
      ask,
      events,
      defaults,
      reason: opts.draftBlockedReason ?? "drafting a run proposal isn't available to you here",
      staleNote,
      labSpec,
    };
    return run;
  }
  const endWeek = events.reduce((m, e) => Math.max(m, e.startWeek + e.durationWeeks), 0);
  const neededWeeks = endWeek + Math.max(RECOVERY_TAIL_WEEKS, durationWeeks);
  const horizonDays = Math.min(
    3650,
    Math.max(Number(base?.horizon_days ?? 0) || 0, neededWeeks * DAYS_PER_TICK),
  );
  const shortName = describeEvents(events).replace(/ \(\d+ wk\)/g, "");
  const args: Record<string, unknown> = reuse
    ? { scenario_id: reuse.id }
    : {
      new_scenario: {
        name: `What-if: ${shortName}`.slice(0, 120),
        horizon_days: horizonDays,
        disruption_schedule: schedule,
      },
    };
  Object.assign(args, {
    policy_version_id: versionId,
    replications,
    title: `What-if: ${shortName}`.slice(0, 140),
    question: (ctx.draft?.utterance ?? "").slice(0, 500) || undefined,
  });
  if (args.question === undefined) delete args.question;
  const env = await call(run, ctx, "draft_experiment_spec", args);
  if (env.kind === "proposal") {
    const proposal = env.data as ProposalPartData;
    run.parts.push({ kind: "proposal", data: proposal });
    run.outcome = {
      kind: "proposed",
      ask,
      events,
      defaults,
      proposal,
      staleNote,
      reusedScenario: reuse ? String(reuse.name ?? reuse.id) : null,
    };
    return run;
  }
  run.outcome = {
    kind: "not_proposed",
    ask,
    events,
    defaults,
    reason: String(env.data ?? "the draft was refused"),
    staleNote,
    labSpec,
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
  const columns = withBaseline ? ["KPI", "With disruption", "± CI", "Baseline", "Difference"] : ["KPI", "With disruption", "± CI"];
  const rows = kpis.map((k) => {
    const base = [k.kpi, fmt(k.value), k.ci === null ? "—" : fmt(k.ci)];
    if (!withBaseline) return base;
    return [...base, k.baseline === null ? "—" : fmt(k.baseline), k.baseline === null ? "—" : fmt(k.value - k.baseline)];
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
      return outcome.message;
    case "hit": {
      const headline = outcome.kpis[0];
      const lead = headline
        ? ` ${headline.kpi} came out at ${fmt(headline.value)}` +
          (headline.baseline !== null ? ` against ${fmt(headline.baseline)} with no disruption (run ${outcome.baselineRunId})` : "") + "."
        : "";
      return `A completed run already answers this: run ${outcome.runId} (scenario "${outcome.scenarioName}", ` +
        `${outcome.reps} replications${outcome.badge ? `, ${outcome.badge}` : ""}` +
        `${outcome.engine ? `, engine version ${outcome.engine}` : ""}) simulated ${describeEvents(outcome.events)}.` +
        lead +
        (outcome.baselineRunId ? " Differences are descriptive — no paired test is stored." : "") +
        assumed;
    }
    case "proposed": {
      const what = describeEvents(outcome.events);
      const why = outcome.staleNote
        ? `There was a run of this, but it's out of date: ${outcome.staleNote} `
        : "No completed run covers this yet. ";
      const where = outcome.reusedScenario
        ? `re-run the existing scenario "${outcome.reusedScenario}"`
        : `run a new scenario with ${what}`;
      return `${why}I've drafted a proposal to ${where} — ${outcome.proposal.summary}. ` +
        `Nothing runs until you approve the card below; once the run finishes, ask again and I'll answer from its results.` +
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
    (k.baseline !== null ? ` (baseline ${fmt(k.baseline)}, difference ${fmt(k.value - k.baseline)})` : "")
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

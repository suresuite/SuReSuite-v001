// Comparison studies (ai-agents.md §26 M.2) — shared by M2 mitigation and
// M5 sensitivity. A study is ONE experiment_spec card of experiment_type
// "comparison" whose arms differ only in their disruption schedule and/or
// recovery overrides; agent-apply dispatches one single run per arm through
// the same path a Lab run takes, on the Lab's shared default seed, so the
// arms are CRN-paired by construction and compared per replication.

import type { ToolContext } from "../tools.ts";
import type { ProposalPartData } from "../draftTools.ts";
import { canonicalJson } from "../telemetry.ts";
import { scheduleKey, type PreparedWhatIf, type ScenarioRow } from "../whatIf.ts";
import {
  callTool,
  ciHalfWidth95,
  dbOf,
  fmt,
  LOWER_IS_BETTER,
  loadRepKpis,
  loadRun,
  mean,
  orderKpis,
  pairedDelta,
  scalarKpis,
  signed,
  type RunRow,
  type SkillResult,
} from "./common.ts";

export interface StudyArm {
  label: string;
  disruption_schedule: Array<Record<string, unknown>>;
  recovery_overrides: Record<string, unknown>;
  recovery_playbook_id?: string;
  /** What this arm costs if adopted, when a playbook states it (cost_cap). */
  stated_cost?: number | null;
}

export type ArmState =
  | { state: "done"; runId: string; scenario: ScenarioRow }
  | { state: "pending"; runId: string; scenario: ScenarioRow; repsDone: number; repsTarget: number }
  | { state: "stale"; scenario: ScenarioRow; note: string }
  | { state: "missing" };

function armKey(schedule: Array<Record<string, unknown>>, overrides: Record<string, unknown>, ids: Set<string>): string {
  return `${scheduleKey(schedule, ids) ?? ""}#${canonicalJson(overrides ?? {})}`;
}

/** Each arm's run, found BY CONTENT: a scenario whose schedule runs
 * identically and whose recovery overrides are equal, then the unchanged
 * §20.2 identity (find_completed_run) at the study's replication count. */
export async function locateArms(
  ctx: ToolContext,
  calls: SkillResult["calls"],
  prep: PreparedWhatIf,
  arms: StudyArm[],
): Promise<ArmState[]> {
  const db = dbOf(ctx);
  const out: ArmState[] = [];
  for (const arm of arms) {
    const key = armKey(arm.disruption_schedule, arm.recovery_overrides, prep.supplierIds);
    const scenario = prep.scenarios.find((s) =>
      armKey(s.disruption_schedule ?? [], (s.recovery_overrides ?? {}) as Record<string, unknown>, prep.supplierIds) === key
    );
    if (!scenario) {
      out.push({ state: "missing" });
      continue;
    }
    let note = "";
    let staleText = "";
    if (prep.mode === "model") {
      // §27 WP V.5: only a finished run that followed THIS model counts.
      let modelRun: Record<string, unknown> | null = null;
      try {
        const { data } = await db.from("simulation_runs")
          .select("id,status,rep_count_done,model_validation_id,exploratory,created_at")
          .eq("scenario_id", scenario.id).eq("status", "done").order("created_at", { ascending: false }).limit(10);
        modelRun = ((data ?? []) as Array<Record<string, unknown>>).find((r) =>
          String(r.model_validation_id ?? "") === String(prep.model.card!.id) && r.exploratory !== true &&
          Number(r.rep_count_done ?? 0) >= prep.replications
        ) ?? null;
      } catch { /* treated as missing */ }
      if (modelRun) {
        out.push({ state: "done", runId: String(modelRun.id), scenario });
        continue;
      }
    } else {
      const env = await callTool(calls, ctx, "find_completed_run", {
        scenario: scenario.id,
        policy_version_id: prep.versionId,
        replications: prep.replications,
      });
      note = String(env.meta.note ?? "");
      staleText = String(env.data ?? "");
      if (note.startsWith("cache_hit") && env.kind === "table") {
        const runId = String(((env.data as { rows?: unknown[][] })?.rows ?? [])[0]?.[0] ?? "");
        if (runId) {
          out.push({ state: "done", runId, scenario });
          continue;
        }
      }
    }
    // A run already queued or running for this arm: the study is in flight.
    try {
      const { data } = await db.from("simulation_runs").select("id,status,rep_count_done,rep_count_target")
        .eq("scenario_id", scenario.id).in("status", ["queued", "running"]).limit(1);
      const live = ((data ?? []) as Array<Record<string, unknown>>)[0];
      if (live) {
        out.push({
          state: "pending",
          runId: String(live.id),
          scenario,
          repsDone: Number(live.rep_count_done ?? 0),
          repsTarget: Number(live.rep_count_target ?? 0),
        });
        continue;
      }
    } catch { /* treated as missing */ }
    if (note === "cache_stale") {
      out.push({ state: "stale", scenario, note: staleText });
      continue;
    }
    out.push({ state: "missing" });
  }
  return out;
}

export interface ArmResult {
  label: string;
  run: RunRow;
  kpis: Map<string, number>;
  reps: Map<string, Map<number, number>>;
  stated_cost: number | null;
}

export async function loadArmResults(ctx: ToolContext, arms: StudyArm[], states: ArmState[]): Promise<ArmResult[]> {
  const db = dbOf(ctx);
  const out: ArmResult[] = [];
  for (let i = 0; i < arms.length; i++) {
    const st = states[i];
    if (st.state !== "done") continue;
    const run = await loadRun(db, ctx.projectId, st.runId);
    if (!run) continue;
    out.push({
      label: arms[i].label,
      run,
      kpis: scalarKpis(run),
      reps: await loadRepKpis(db, run.id),
      stated_cost: arms[i].stated_cost ?? null,
    });
  }
  return out;
}

export interface ArmComparison {
  label: string;
  value: number | null;
  delta: { mean: number; ci: number; n: number } | null;
  /** improves | worsens | unresolved (CI spans 0) | reference | no_pairs */
  verdict: "improves" | "worsens" | "unresolved" | "reference" | "no_pairs";
}

/** Paired comparison of every arm against the FIRST (the reference), on one
 * KPI. A difference whose 95% interval spans zero is "unresolved" — the
 * answer says so instead of ranking it. */
export function compareOnKpi(results: ArmResult[], kpi: string): ArmComparison[] {
  const ref = results[0];
  const lower = LOWER_IS_BETTER.test(kpi);
  return results.map((r, i) => {
    const value = r.kpis.get(kpi) ?? (r.reps.get(kpi) ? mean([...r.reps.get(kpi)!.values()]) : null);
    if (i === 0) return { label: r.label, value, delta: null, verdict: "reference" as const };
    const a = r.reps.get(kpi);
    const b = ref.reps.get(kpi);
    const d = a && b ? pairedDelta(a, b) : null;
    if (!d) return { label: r.label, value, delta: null, verdict: "no_pairs" as const };
    const lo = d.mean - d.ci;
    const hi = d.mean + d.ci;
    const better = lower ? hi < 0 : lo > 0;
    const worse = lower ? lo > 0 : hi < 0;
    return { label: r.label, value, delta: d, verdict: better ? "improves" as const : worse ? "worsens" as const : "unresolved" as const };
  });
}

/** The study's display table: one row per arm, the headline KPIs as columns
 * with the paired difference against the reference. */
export function studyTable(results: ArmResult[]): { kind: string; data: unknown } | null {
  if (results.length === 0) return null;
  const kpis = orderKpis(results.flatMap((r) => [...r.kpis.keys()]), 4);
  if (kpis.length === 0) return null;
  const columns = ["Arm", ...kpis.flatMap((k) => [k, `Δ ${k} (95% CI)`]), "Stated cost"];
  const per = kpis.map((k) => compareOnKpi(results, k));
  const rows = results.map((r, i) => [
    r.label,
    ...per.flatMap((cmp) => {
      const c = cmp[i];
      const delta = c.verdict === "reference"
        ? "reference"
        : c.delta
        ? `${signed(c.delta.mean)} ± ${fmt(c.delta.ci)}${c.verdict === "unresolved" ? " (unresolved)" : ""}`
        : "—";
      return [fmt(c.value), delta];
    }),
    r.stated_cost === null ? "—" : fmt(r.stated_cost),
  ]);
  return { kind: "table", data: { columns, rows } };
}

/** File the study card through the unchanged draft handler. */
export async function draftStudy(
  ctx: ToolContext,
  calls: SkillResult["calls"],
  prep: PreparedWhatIf,
  args: { name: string; horizonDays: number; arms: StudyArm[]; title: string },
): Promise<{ proposal: ProposalPartData | null; refusal: string | null }> {
  const env = await callTool(calls, ctx, "draft_experiment_spec", {
    experiment_type: "comparison",
    new_scenario: {
      name: args.name.slice(0, 120),
      horizon_days: args.horizonDays,
      disruption_schedule: prep.schedule,
    },
    arms: args.arms.map((a) => ({
      label: a.label,
      disruption_schedule: a.disruption_schedule,
      recovery_overrides: a.recovery_overrides,
      ...(a.recovery_playbook_id ? { recovery_playbook_id: a.recovery_playbook_id } : {}),
    })),
    // §27: every arm follows the model, or the whole study is exploratory.
    ...(prep.mode === "model"
      ? { validated_model_id: String(prep.model.card!.id) }
      : { exploratory: true, ...(prep.seedScenarioId ? { base_scenario_id: prep.seedScenarioId } : {}) }),
    policy_version_id: prep.versionId,
    replications: prep.replications,
    title: args.title.slice(0, 140),
    ...(ctx.draft?.utterance ? { question: ctx.draft.utterance.slice(0, 500) } : {}),
  });
  if (env.kind === "proposal") return { proposal: env.data as ProposalPartData, refusal: null };
  return { proposal: null, refusal: String(env.data ?? "the study draft was refused") };
}

/** A new scenario's length: the latest event end plus a recovery window. */
export function studyHorizonDays(prep: PreparedWhatIf, schedules: Array<Array<Record<string, unknown>>>): number {
  let endDay = 0;
  for (const sched of schedules) {
    for (const e of sched) endDay = Math.max(endDay, Number(e.start_day ?? 0) + Number(e.duration_days ?? 0));
  }
  // §27: a study that follows the model keeps the model's horizon (the
  // guardrail in prepareWhatIf already asked before extending it).
  if (prep.mode === "model" && endDay <= prep.horizonDays) return prep.horizonDays;
  const tail = Math.max(8 * 7, ...schedules.flat().map((e) => Number(e.duration_days ?? 0)));
  return Math.min(3650, Math.max(Number(prep.base?.horizon_days ?? 0) || 0, Math.ceil((endDay + tail) / 7) * 7));
}

/** Progress line for a study in flight. */
export function progressLine(arms: StudyArm[], states: ArmState[]): string {
  const done = states.filter((s) => s.state === "done").length;
  const pending = states.filter((s) => s.state === "pending") as Array<Extract<ArmState, { state: "pending" }>>;
  const reps = pending.map((p) => `${p.repsDone}/${p.repsTarget || "?"}`).join(", ");
  return `${done} of ${arms.length} arms have finished${pending.length ? ` (still running: ${pending.length}, replications ${reps})` : ""}. ` +
    `Ask again when they finish and I'll compare them.`;
}

export { ciHalfWidth95 };

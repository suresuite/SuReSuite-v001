import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { withRunSeries, type RunSeriesState } from "@/lib/sim/runSeries";
import { dispatchExperiment, type RunDispatchResult } from "@/lib/sim/dispatch";

/** Engine fallback report (scsim MappingWarning, written by the worker). */
export interface MappingWarning {
  level: "info" | "warn" | "error";
  entity: string;
  field: string;
  reason: string;
}

export interface SimulationRun {
  id: string;
  scenario_id: string;
  project_id: string;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  started_at: string | null;
  ended_at: string | null;
  aggregate_kpis: Record<string, number>;
  ci_half_widths: Record<string, number>;
  warmup_detected_at: number | null;
  rep_count_target: number;
  rep_count_done: number;
  error_message: string | null;
  code_version: string | null;
  policy_version_id: string | null;
  policy_hash: string | null;
  /** The frozen dataset version the run was computed from (§23 WP 13.2). */
  dataset_version_id?: string | null;
  mapping_warnings: MappingWarning[] | null;
  created_at: string;
  /** Touched by every worker write, including the per-replication counter —
   *  what `runStatus.ts` reads to notice a run that stopped moving (F-30). */
  updated_at?: string | null;
  /** Baseline fingerprint stamped at dispatch (Phase B0 / G13 / §9.5). */
  scenario_hash?: string | null;
  /** Seed and disruption schedule stamped at dispatch (audit WP 8) — what a
   *  paired comparison reads, rather than the live scenario row. */
  seed?: number | null;
  disruption_schedule?: unknown[] | null;
  /** The model-validation card in force at dispatch — immutable history. */
  model_validation_id?: string | null;
  /** The pre-run gate could not load its data and dispatch proceeded unchecked
   *  (`20260707000001_run_gate_skipped.sql`). Rendered by `gateNotice` (F-19a). */
  gate_skipped?: boolean | null;
  // ── WP 10.6 · §4 D246 — the result tiers (`20261001000010`) ──
  /** The run's weekly series object in the private `run-results` bucket; when
   *  set, its replication rows hold `time_series = {}` (`runSeries.ts` hydrates). */
  series_object?: string | null;
  series_bytes?: number | null;
  retention?: "standard" | "pinned" | "evidence" | null;
  series_expires_at?: string | null;
  /** When the sweep removed the series; the KPIs and aggregates are kept. */
  series_expired_at?: string | null;
  // ── WP 11.2 · §4 D260 — what the engine READ (`20261001000020`) ──
  /** The simulation scope's hash — the run snapshot's `inputs` domain; RunKey v2 hashes it. */
  hash_simulation?: string | null;
  /** That scope's level version (`graph_level_versions`). */
  simulation_version_id?: string | null;
  // ── WP 10.4 · §4 D245 — the binding on the row (`20261001000009`) ──
  /** The registered engine the run was dispatched to (`sim_engines.id`). */
  engine_id?: string | null;
  /** sha256 of `run_spec` — the run's identity; identical submissions share it. */
  run_key?: string | null;
  /** Everything the RunKey hashes, as data: engine, hashes, the scenario's run
   *  spec, overrides. Every binding resolves from here without a live read. */
  run_spec?: Record<string, unknown> | null;
  /** Deviations from the Validated Model's protocol; `{}` = faithful. */
  protocol_overrides?: Record<string, unknown> | null;
  /** Ran under no Validated Model, or explicitly as an exploratory model. */
  exploratory?: boolean | null;
  /** §4 D318 — run week 0's calendar date, as the run recorded it. */
  calendar_start?: string | null;
  /** 'dispatch' (stamped at insert) or 'backfill' (filled later from the project). */
  calendar_start_source?: "dispatch" | "backfill" | null;
}

/**
 * A run row WITHOUT its four heavy JSON columns. The Run queue lists up to 20 runs and
 * re-reads them on every change while a run streams, and `run_spec` (the whole run
 * identity), `disruption_schedule`, `mapping_warnings` and `protocol_overrides` are
 * the bulk of each row. The queue shows none of them; whoever inspects ONE run reads
 * the full row (`loadRun`). The type omits them so a caller cannot read a field the
 * row does not carry.
 */
export type RunSummary = Omit<
  SimulationRun,
  "run_spec" | "disruption_schedule" | "mapping_warnings" | "protocol_overrides"
>;

// Every `simulation_runs` column the SimulationRun type names, minus the four above.
// An explicit list because PostgREST cannot say "all but"; `runSummaryColumns.test.ts`
// holds it equal to the type, so a column added to one cannot be forgotten in the other.
export const RUN_SUMMARY_COLUMNS = [
  "id", "scenario_id", "project_id", "status", "started_at", "ended_at",
  "aggregate_kpis", "ci_half_widths", "warmup_detected_at", "rep_count_target",
  "rep_count_done", "error_message", "code_version", "policy_version_id", "policy_hash",
  "dataset_version_id", "created_at", "updated_at", "scenario_hash", "seed",
  "model_validation_id", "gate_skipped", "series_object", "series_bytes", "retention",
  "series_expires_at", "series_expired_at", "hash_simulation", "simulation_version_id",
  "engine_id", "run_key", "exploratory", "calendar_start", "calendar_start_source",
].join(",");

// The dispatch types and client live in lib/sim/dispatch.ts (WP 9.4 slice 8),
// shared with Run & Validate; re-exported here for existing importers.
export type { GateResponseFinding, ReuseCandidate, RunDispatchResult } from "@/lib/sim/dispatch";

export interface Replication {
  id: string;
  run_id: string;
  rep_index: number;
  seed_used: number;
  status: string;
  kpis: Record<string, number>;
  time_series: Record<string, number[]>;
  warmup_at: number | null;
  started_at: string | null;
  ended_at: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

export function useSimulationRun(scenarioId: string | null | undefined) {
  const [latestRun, setLatestRun] = useState<SimulationRun | null>(null);
  const [reps, setReps] = useState<Replication[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  // WP 10.6 — where the latest run's weekly series are: in its rows, in its
  // Parquet object (hydrated into the rows), or expired (said, with the RunKey).
  const [seriesState, setSeriesState] = useState<RunSeriesState>({ state: "inline" });

  const loadLatest = useCallback(async () => {
    if (!scenarioId) return;
    // Two reads at once: the newest run in full (the page shows it), and the last 20
    // without their heavy JSON (the queue lists them). The newest appears in both;
    // the full row stands for it in the list so the two never disagree.
    const [{ data: newest }, { data: runs }] = await Promise.all([
      sb.from("simulation_runs").select("*").eq("scenario_id", scenarioId)
        .order("created_at", { ascending: false }).limit(1),
      sb.from("simulation_runs").select(RUN_SUMMARY_COLUMNS).eq("scenario_id", scenarioId)
        .order("created_at", { ascending: false }).limit(20),
    ]);
    const full = ((newest ?? [])[0] ?? null) as SimulationRun | null;
    const list = ((runs ?? []) as RunSummary[]).map((r) => (full && r.id === full.id ? full : r));
    if (full && !list.some((r) => r.id === full.id)) list.unshift(full); // a run created between the two reads
    setHistory(list);
    setLatestRun(full);
    if (full) {
      const { data: rs } = await sb
        .from("run_replications")
        .select("*")
        .eq("run_id", full.id)
        .order("rep_index", { ascending: true });
      const rows = (rs ?? []) as Replication[];
      // A running run has no object yet (its rows stream KPIs only); the object
      // is read once the run is done, and cached for the page's life.
      if (full.status === "done") {
        const { reps: hydrated, series } = await withRunSeries(full, rows);
        setReps(hydrated);
        setSeriesState(series);
      } else {
        setReps(rows);
        setSeriesState({ state: "inline" });
      }
    } else {
      setReps([]);
      setSeriesState({ state: "inline" });
    }
  }, [scenarioId]);

  // The worker streams run_replications rows live while the engine runs, so
  // realtime events arrive in bursts — coalesce reloads instead of refetching
  // per row.
  const reloadTimer = useRef<number | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void loadLatest();
    }, 400);
  }, [loadLatest]);

  useEffect(() => {
    if (!scenarioId) {
      setLatestRun(null);
      setReps([]);
      setHistory([]);
      return;
    }
    void loadLatest();
    const ch = sb
      .channel(`sim_runs:${scenarioId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "simulation_runs", filter: `scenario_id=eq.${scenarioId}` },
        scheduleReload,
      )
      .subscribe();
    return () => {
      if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
      sb.removeChannel(ch);
    };
  }, [scenarioId, loadLatest, scheduleReload]);

  // Replication rows of the run this hook SHOWS, and no other (audit F-33).
  // This used to subscribe to `run_replications` with no filter, so every
  // replication of every project woke every open Lab. `run_replications` has no
  // `scenario_id`; the displayed run's id is the exact filter, and a new run
  // arrives through the `simulation_runs` subscription above, which re-keys this.
  const latestRunId = latestRun?.id ?? null;
  useEffect(() => {
    if (!latestRunId) return;
    const ch = sb
      .channel(`sim_reps:${latestRunId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "run_replications", filter: `run_id=eq.${latestRunId}` },
        scheduleReload,
      )
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [latestRunId, scheduleReload]);

  const runExperiment = useCallback(
    async (
      projectId: string,
      policyVersionId: string,
      acknowledgeWarnings = false,
      forceRerun = false,
    ): Promise<RunDispatchResult> => {
      if (!scenarioId) throw new Error("no scenario selected");
      return dispatchExperiment({
        projectId,
        scenarioId,
        policyVersionId,
        acknowledgeWarnings,
        forceRerun,
      });
    },
    [scenarioId],
  );

  const cancelRun = useCallback(
    async (projectId: string, runId: string) => {
      const { error } = await supabase.functions.invoke("sim-command", {
        body: {
          project_id: projectId,
          kind: "experiment.cancel",
          payload: { run_id: runId },
          client_ts: Date.now(),
        },
      });
      if (error) throw error;
    },
    [],
  );

  // Load one run's replications on demand — for the Run-queue console's
  // "View" (6.E), which inspects a historical run other than the latest (the
  // realtime path only keeps the latest run's reps hot). Read-only.
  const loadReps = useCallback(async (runId: string): Promise<Replication[]> => {
    const [{ data }, { data: run }] = await Promise.all([
      sb.from("run_replications").select("*").eq("run_id", runId).order("rep_index", { ascending: true }),
      sb.from("simulation_runs").select("id,project_id,status,series_object,series_expired_at,run_key")
        .eq("id", runId).maybeSingle(),
    ]);
    const rows = (data ?? []) as Replication[];
    return run && run.status === "done" ? (await withRunSeries(run, rows)).reps : rows;
  }, []);

  /** One run in full — the row the queue's "View" inspects. Null if it is gone. */
  const loadRun = useCallback(async (runId: string): Promise<SimulationRun | null> => {
    const { data } = await sb.from("simulation_runs").select("*").eq("id", runId).maybeSingle();
    return (data ?? null) as SimulationRun | null;
  }, []);

  const addReps = useCallback(async (projectId: string, runId: string, n: number) => {
    const { error } = await supabase.functions.invoke("sim-command", {
      body: {
        project_id: projectId,
        kind: "experiment.add_reps",
        payload: { run_id: runId, n },
        client_ts: Date.now(),
      },
    });
    if (error) throw error;
  }, []);

  return { latestRun, reps, history, seriesState, runExperiment, cancelRun, addReps, loadReps, loadRun, refresh: loadLatest };
}

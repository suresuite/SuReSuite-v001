// Pure derivations for the Run & Job-Queue console (6.E). Kept in a plain
// module (no JSX) so the queue logic — tally, filter, active-job selection,
// queue position, segment cells — is unit-testable in isolation and doesn't
// trip react-refresh's "only export components" rule.
import type { RunSummary as SimulationRun, Replication } from "@/hooks/useSimulationRun";
import { formatMoney } from '@/lib/sim/money';

export type JobStatus = SimulationRun["status"]; // queued | running | done | cancelled | failed
export type QueueFilter = "all" | "active" | "done" | "failed";
export type CellState = "done" | "running" | "pending" | "failed";

export interface JobTally {
  running: number;
  queued: number;
  done: number;
  failed: number;
  cancelled: number;
  active: number; // running + queued
}

/** Count jobs by status — drives the toolbar tally and the filter counts. */
export function jobTally(jobs: SimulationRun[]): JobTally {
  const t: JobTally = { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0, active: 0 };
  for (const j of jobs) {
    if (j.status === "running") t.running++;
    else if (j.status === "queued") t.queued++;
    else if (j.status === "done") t.done++;
    else if (j.status === "failed") t.failed++;
    else if (j.status === "cancelled") t.cancelled++;
  }
  t.active = t.running + t.queued;
  return t;
}

/** Is this job active (occupying the worker / waiting for it)? */
export function isActiveStatus(s: JobStatus): boolean {
  return s === "running" || s === "queued";
}

/** Segmented-control filter. "Failed" folds cancelled in with failed since
 *  both are non-success terminals the user wants to triage together. */
export function matchesFilter(status: JobStatus, filter: QueueFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return status === "running" || status === "queued";
    case "done":
      return status === "done";
    case "failed":
      return status === "failed" || status === "cancelled";
  }
}

/** The job the status hero reflects: the most-recent active job (so a running
 *  or queued run is always front-and-centre), else the most-recent job of any
 *  status. `jobs` is newest-first. Returns null only when there are no jobs. */
export function activeJob(jobs: SimulationRun[]): SimulationRun | null {
  if (jobs.length === 0) return null;
  return jobs.find((j) => isActiveStatus(j.status)) ?? jobs[0];
}

/** 1-based position of a queued job in the worker's FIFO backlog (oldest
 *  queued = position 1). Null for any non-queued job. */
export function queuePosition(jobs: SimulationRun[], job: SimulationRun): number | null {
  if (job.status !== "queued") return null;
  const queued = jobs
    .filter((j) => j.status === "queued")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const idx = queued.findIndex((j) => j.id === job.id);
  return idx < 0 ? null : idx + 1;
}

/** Per-replication cell states for the segmented bar. For the ACTIVE run the
 *  live `reps` rows give exact per-cell state; otherwise cells are derived
 *  from rep_count_done / rep_count_target and the run status. Capped so a
 *  large study renders a compact bar instead of hundreds of cells. */
export function segmentCells(
  job: SimulationRun,
  reps: Replication[] | undefined,
  cap = 40,
): { cells: CellState[]; total: number; done: number } {
  const total = Math.max(job.rep_count_target ?? 0, job.rep_count_done ?? 0, reps?.length ?? 0, 1);
  const done = job.rep_count_done ?? 0;
  const byIndex = new Map<number, string>();
  for (const r of reps ?? []) byIndex.set(r.rep_index, r.status);
  const n = Math.min(total, cap);
  const cells: CellState[] = [];
  for (let i = 0; i < n; i++) {
    const repStatus = byIndex.get(i);
    if (repStatus === "done") cells.push("done");
    else if (repStatus === "running") cells.push("running");
    else if (repStatus === "failed") cells.push("failed");
    else if (i < done) cells.push("done");
    else if (job.status === "failed" || job.status === "cancelled") cells.push("failed");
    else if (job.status === "running" && i === done) cells.push("running");
    else cells.push("pending");
  }
  return { cells, total, done };
}

/** "3m ago" / "just now" — compact relative time for the started column. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 45_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** One-line result summary for a completed job — primary KPI ± CI · revenue. */
export function resultLine(job: SimulationRun): string {
  const agg = job.aggregate_kpis ?? {};
  const ci = job.ci_half_widths ?? {};
  const parts: string[] = [];
  if (agg.fill_rate != null) {
    const half = ci.fill_rate != null ? ` ±${(ci.fill_rate * 100).toFixed(1)}` : "";
    parts.push(`fill ${(agg.fill_rate * 100).toFixed(1)}%${half}`);
  }
  if (agg.revenue != null) parts.push(formatMoney(agg.revenue));
  return parts.length > 0 ? parts.join(" · ") : "no aggregate KPIs";
}

// Run & Job-Queue console (Phase D / 6.E / walkthrough Scene 6.E).
//
// The walkthrough's Scene 6.E gap: RunValidateStage only ever rendered the
// single latest run, even though useSimulationRun already loads `history` (the
// last 20 simulation_runs rows, live over realtime) and cancelRun(projectId,
// runId) already cancels ANY run by id. So a full job queue with per-job
// cancel is a UI gap, not a data or backend gap — this component closes it by
// surfacing `history` and wiring the existing cancel. No backend change.
//
// Layout (the doc's design):
//   1. Status hero — the persistent "did it run?" signal, derived from the
//      ACTIVE job (most-recent queued/running, else most-recent terminal):
//      idle · queued · running (n/N) · succeeded (fill · revenue · engine) ·
//      failed (message). Loud terminal chrome. Never silently vanishes.
//   2. Queue toolbar — status tally, filter (All/Active/Done/Failed), Cancel
//      all active, Clear finished.
//   3. Job rows — one per history row: Type (Single / ×N), status pill
//      (icon + label, colour-blind safe), a segmented replication bar,
//      engine chip, started relative time, result/error, and per-row
//      Cancel / View / Retry (queued rows also show their queue position).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { engineDocHref } from "@/lib/sim/engineChanges";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertOctagon,
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  RotateCcw,
  Server,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunSummary as SimulationRun, Replication } from "@/hooks/useSimulationRun";
import { CredibilityBadge } from "@/components/sim/CredibilityBadge";
import { engineLabel } from "@/components/sim/RunProgressPanel";
import type { Credibility } from "@/hooks/useModelValidation";
import { useConfirm } from "@/components/shared/confirm/useConfirm";
import {
  activeJob,
  isActiveStatus,
  jobTally,
  matchesFilter,
  queuePosition,
  relativeTime,
  resultLine,
  segmentCells,
  type CellState,
  type JobStatus,
  type QueueFilter,
} from "@/components/sim/runQueueLogic";

// ── status pill presentation (icon + label = colour-blind safe) ─────────────

const STATUS_META: Record<
  JobStatus,
  { label: string; Icon: typeof Clock; cls: string; spin?: boolean }
> = {
  queued: { label: "Queued", Icon: Clock, cls: "border-sky-500/50 text-sky-700 dark:text-sky-300 bg-sky-500/10" },
  running: { label: "Running", Icon: Loader2, cls: "border-amber-500/50 text-amber-700 dark:text-amber-300 bg-amber-500/10", spin: true },
  done: { label: "Done", Icon: CheckCircle2, cls: "border-emerald-500/50 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10" },
  failed: { label: "Failed", Icon: AlertOctagon, cls: "border-rose-500/50 text-rose-700 dark:text-rose-300 bg-rose-500/10" },
  cancelled: { label: "Cancelled", Icon: Ban, cls: "border-slate-400/50 text-slate-600 dark:text-slate-300 bg-slate-500/10" },
};

function StatusPill({ status }: { status: JobStatus }) {
  const m = STATUS_META[status];
  const Icon = m.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        m.cls,
      )}
    >
      <Icon className={cn("h-3 w-3", m.spin && "animate-spin")} />
      {m.label}
    </span>
  );
}

const CELL_CLS: Record<CellState, string> = {
  done: "bg-primary/70 border-primary/70",
  running: "bg-amber-500/60 border-amber-500/60 animate-pulse",
  pending: "bg-transparent border-border",
  failed: "bg-rose-500/40 border-rose-500/40",
};

function SegmentBar({ job, reps }: { job: SimulationRun; reps?: Replication[] }) {
  const { cells, total, done } = segmentCells(job, reps);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-0.5">
        {cells.map((c, i) => (
          <span key={i} className={cn("h-2.5 w-2.5 rounded-[2px] border", CELL_CLS[c])} />
        ))}
        {total > cells.length && (
          <span className="text-[9px] text-muted-foreground self-center ml-0.5">
            +{total - cells.length}
          </span>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground">
        {done} / {total} replication{total === 1 ? "" : "s"}
      </span>
    </div>
  );
}

// ── the console ─────────────────────────────────────────────────────────────

interface RunQueueConsoleProps {
  /** All jobs, newest-first — useSimulationRun().history (+ any in-memory
   *  browser run merged in by the parent). */
  jobs: SimulationRun[];
  /** Live per-replication rows for the active/latest run — gives the segment
   *  bar exact per-cell state for the run in flight. */
  activeReps: Replication[];
  /** The run id `activeReps` belong to (the hook loads reps for the latest). */
  activeRepsRunId: string | null;
  /** Currently-inspected run (highlighted + View is a no-op on it). */
  selectedRunId?: string | null;
  /** Derived credibility of the model in force (shown on the hero). */
  credibility?: Credibility | null;
  /** The policy version's name ("s, S 24") by `policy_version_id`, so each row
   *  names the policy it ran under. A run with no saved version says so rather
   *  than staying silent. */
  policyLabels?: Record<string, string>;
  onCancel: (job: SimulationRun) => void;
  onCancelAllActive: (jobs: SimulationRun[]) => void;
  onView: (job: SimulationRun) => void;
  onRetry: (job: SimulationRun) => void;
}

export function RunQueueConsole({
  jobs,
  activeReps,
  activeRepsRunId,
  selectedRunId,
  credibility,
  policyLabels,
  onCancel,
  onCancelAllActive,
  onView,
  onRetry,
}: RunQueueConsoleProps) {
  const confirm = useConfirm();
  const [filter, setFilter] = useState<QueueFilter>("all");
  // Client-side dismissal of finished rows ("Clear finished"). Keyed by id so
  // a realtime reload can't resurrect a cleared row, yet genuinely new runs
  // still appear. No DB delete — this is a view filter, not a mutation.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const tally = useMemo(() => jobTally(jobs), [jobs]);
  const hero = useMemo(() => activeJob(jobs), [jobs]);
  const activeJobs = useMemo(() => jobs.filter((j) => isActiveStatus(j.status)), [jobs]);

  const visible = useMemo(
    () => jobs.filter((j) => !dismissed.has(j.id) && matchesFilter(j.status, filter)),
    [jobs, dismissed, filter],
  );
  const finishedCount = useMemo(
    () => jobs.filter((j) => !isActiveStatus(j.status) && !dismissed.has(j.id)).length,
    [jobs, dismissed],
  );

  const clearFinished = () =>
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const j of jobs) if (!isActiveStatus(j.status)) next.add(j.id);
      return next;
    });

  const cancelAll = async () => {
    if (activeJobs.length === 0) return;
    const message = `Cancel all ${activeJobs.length} active job(s)?`;
    if (!(await confirm({ message, title: message, actionLabel: "Cancel jobs", cancelLabel: "Keep running" }))) return;
    onCancelAllActive(activeJobs);
  };

  return (
    <div className="flex flex-col gap-3">
      <RunStatusHero job={hero} credibility={credibility} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Run queue</CardTitle>
            {/* status tally — icon + colour, colour-blind safe */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1" title="running">
                <Loader2 className="h-3 w-3 text-amber-500" /> {tally.running}
              </span>
              <span className="inline-flex items-center gap-1" title="queued">
                <Clock className="h-3 w-3 text-sky-500" /> {tally.queued}
              </span>
              <span className="inline-flex items-center gap-1" title="done">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" /> {tally.done}
              </span>
              <span className="inline-flex items-center gap-1" title="failed">
                <AlertOctagon className="h-3 w-3 text-rose-500" /> {tally.failed}
              </span>
              {tally.cancelled > 0 && (
                <span className="inline-flex items-center gap-1" title="cancelled">
                  <Ban className="h-3 w-3 text-slate-400" /> {tally.cancelled}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {/* filter segmented control */}
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Filter runs">
              {(["all", "active", "done", "failed"] as QueueFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    "rounded px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                    filter === f
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                disabled={activeJobs.length === 0}
                onClick={cancelAll}
              >
                <Square className="h-3 w-3" /> Cancel all active
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                disabled={finishedCount === 0}
                onClick={clearFinished}
              >
                Clear finished
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {visible.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {jobs.length === 0
                ? "No runs yet — configure a single or multiple run above and launch it."
                : "No runs match this filter."}
            </p>
          ) : (
            <ul className="divide-y">
              {visible.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  reps={job.id === activeRepsRunId ? activeReps : undefined}
                  selected={job.id === selectedRunId}
                  policyLabel={job.policy_version_id ? policyLabels?.[job.policy_version_id] ?? null : null}
                  queuePos={queuePosition(jobs, job)}
                  onCancel={() => onCancel(job)}
                  onView={() => onView(job)}
                  onRetry={() => onRetry(job)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function JobRow({
  job,
  reps,
  selected,
  policyLabel,
  queuePos,
  onCancel,
  onView,
  onRetry,
}: {
  job: SimulationRun;
  reps?: Replication[];
  selected: boolean;
  policyLabel: string | null;
  queuePos: number | null;
  onCancel: () => void;
  onView: () => void;
  onRetry: () => void;
}) {
  const eng = engineLabel(job.code_version);
  const typeLabel = (job.rep_count_target ?? 1) > 1 ? `×${job.rep_count_target}` : "Single";
  const active = isActiveStatus(job.status);

  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5", selected && "bg-primary/5 -mx-2 px-2 rounded")}>
      <div className="flex items-center gap-2 min-w-[9rem]">
        <Badge variant="outline" className="text-[10px] font-mono">{typeLabel}</Badge>
        <StatusPill status={job.status} />
      </div>

      <div className="min-w-[8rem] flex-1">
        <SegmentBar job={job} reps={reps} />
      </div>

      <div className="flex flex-col gap-0.5 min-w-[7rem]">
        <span
          className="text-[11px] font-medium"
          title={job.policy_version_id ? "The policy version this run used" : "This run was not bound to a saved policy version"}
        >
          {job.policy_version_id ? policyLabel ?? "Policy …" : <span className="text-muted-foreground">No saved policy</span>}
        </span>
        <Link to={engineDocHref(job.code_version)} title="What this engine version changed" className="w-fit">
          <Badge variant="outline" className={cn("text-[10px] w-fit", eng.cls)}>
            <Server className="h-3 w-3 mr-1" />
            {eng.label}
          </Badge>
        </Link>
        <span className="text-[10px] text-muted-foreground">{relativeTime(job.started_at ?? job.created_at)}</span>
      </div>

      <div className="min-w-[10rem] flex-1 text-[11px]">
        {job.status === "done" ? (
          <span className="text-emerald-700 dark:text-emerald-300">{resultLine(job)}</span>
        ) : job.status === "failed" ? (
          <span className="text-rose-700 dark:text-rose-300 break-words">
            {job.error_message ?? "the worker reported a failure"}
          </span>
        ) : job.status === "queued" ? (
          <span className="text-muted-foreground">
            {queuePos != null ? `queue position ${queuePos}` : "waiting for the worker…"}
          </span>
        ) : job.status === "running" ? (
          <span className="text-muted-foreground">computing…</span>
        ) : (
          <span className="text-muted-foreground">cancelled</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {active && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onCancel}>
            <Square className="h-3 w-3" /> Cancel
          </Button>
        )}
        {job.status === "done" && (
          <Button
            size="sm"
            variant={selected ? "secondary" : "outline"}
            className="h-7 gap-1 text-xs"
            onClick={onView}
          >
            <Eye className="h-3 w-3" /> View
          </Button>
        )}
        {job.status === "failed" && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onRetry}>
            <RotateCcw className="h-3 w-3" /> Retry
          </Button>
        )}
      </div>
    </li>
  );
}

/** The persistent "did it run?" hero — five states, loud terminal chrome,
 *  driven by the active job so it survives reloads (unlike a launch-time
 *  toast). Idle only when there are no jobs at all. */
function RunStatusHero({ job, credibility }: { job: SimulationRun | null; credibility?: Credibility | null }) {
  if (!job) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
        <Clock className="h-4 w-4" />
        <span>Idle — no runs yet. Launch a single or multiple run above.</span>
      </div>
    );
  }

  if (job.status === "queued") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-2.5 text-sm">
        <Clock className="h-4 w-4 text-sky-600 dark:text-sky-400" />
        <span className="font-semibold text-sky-700 dark:text-sky-300">Queued</span>
        <span className="text-xs text-muted-foreground">waiting for the simulation worker…</span>
        <div className="flex-1" />
        {credibility && <CredibilityBadge credibility={credibility} />}
      </div>
    );
  }

  if (job.status === "running") {
    const pct = job.rep_count_target ? Math.round((job.rep_count_done / job.rep_count_target) * 100) : 0;
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400" />
        <span className="font-semibold text-amber-800 dark:text-amber-200">
          Running — {job.rep_count_done} / {job.rep_count_target || "?"} ({pct}%)
        </span>
        <div className="flex-1" />
        {credibility && <CredibilityBadge credibility={credibility} />}
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive ring-1 ring-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
        <AlertOctagon className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-semibold text-destructive">Failed</div>
          <div className="text-xs text-destructive/90 mt-0.5 break-words">
            {job.error_message ?? "the worker reported a failure — see the run history"}
          </div>
        </div>
      </div>
    );
  }

  if (job.status === "cancelled") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-400/50 bg-slate-500/10 px-3 py-2.5 text-sm">
        <Ban className="h-4 w-4 text-slate-500" />
        <span className="font-semibold text-slate-600 dark:text-slate-300">Cancelled</span>
        <span className="text-xs text-muted-foreground">the last run was cancelled — launch again above.</span>
      </div>
    );
  }

  // done
  const eng = engineLabel(job.code_version);
  return (
    <div className="flex items-start gap-2 rounded-md border border-emerald-500/50 ring-1 ring-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm">
      <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-emerald-700 dark:text-emerald-300">Succeeded</div>
        <div className="text-xs text-foreground/80 mt-0.5">
          {resultLine(job)} · {job.rep_count_done} replication{job.rep_count_done === 1 ? "" : "s"} · {eng.label}
        </div>
      </div>
      {credibility && <CredibilityBadge credibility={credibility} />}
    </div>
  );
}

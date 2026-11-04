import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { resultsHeader, type ResultsHeader } from "@/lib/sim/runStatus";
import { gateNotice } from "@/lib/sim/gateNotice";
import { KpiStatTable } from "./KpiStatTable";
import { ConvergencePlot, InventoryOverTime, CapacityOverTime, ReplicationSeedExplorer } from "./lazyCharts";
import type { CapacityBinding } from "./CapacityOverTime";
import { ItemSeriesExplorer } from "./ItemSeriesExplorer";
import type { Replication, SimulationRun } from "@/hooks/useSimulationRun";
import type { RecoveryConfig, DisruptionEvent } from "@/lib/sim/recovery";
import { CredibilityBadge } from "./CredibilityBadge";
import { RunRetentionLine } from "./RunRetentionLine";
import { M, MobileChip, MobilePanel, MobileRow } from "@/components/mobile";
import { cn } from "@/lib/utils";
import type { Credibility } from "@/hooks/useModelValidation";

interface Props {
  run: SimulationRun | null;
  reps: Replication[];
  primaryKpi: string;
  scenario?: { disruption_schedule?: DisruptionEvent[]; horizon_days?: number } | null;
  /** B0b (§9.5): badge from the run's stamped card + engine-fingerprint check. */
  credibility?: Credibility | null;
  /**
   * Wear the mobile skin (v2 §4C).
   *
   * This component is mounted by both platforms, so the skin arrives as a
   * prop rather than as an edit: `skin` is false everywhere desktop renders
   * and the desktop tree below is byte-identical to what it has always been.
   * What it changes is this component's OWN chrome — the two badges become
   * chips, the engine notes become a panel — and it opens a container query
   * (`.m-cq`) so the charts and tables it hosts size to the panel they are in
   * rather than to the viewport, which stops being the same thing the moment
   * the wide band goes two-column (v2 §5.5).
   */
  skin?: boolean;
  /** The project's name, for the inventory explorer's workbook. */
  projectName?: string | null;
}

interface RunMeta {
  recovery?: RecoveryConfig;
  disruption_count?: number;
  horizon_days?: number;
  engine?: string;
  scsim_notes?: string[];
  /** Which products/suppliers capacity held back (§4 D167). Written by the
   *  worker from `ScenarioResult.capacity_binding`; absent on a run that
   *  predates the measurement, which the panel says rather than assumes. */
  capacity_binding?: CapacityBinding;
  /** "sequential_ci" when the replication count was chosen by the CI rule (F-13). */
  stopping_rule?: string;
}

function extractMeta(run: SimulationRun | null, reps: Replication[]): RunMeta | null {
  const fromRun = (run?.aggregate_kpis as unknown as { _meta?: RunMeta } | null)?._meta;
  if (fromRun) return fromRun;
  const fromRep = (reps[0]?.kpis as unknown as { _meta?: RunMeta } | null)?._meta;
  return fromRep ?? null;
}

const HEADER_TONE: Record<ResultsHeader["tone"], string> = {
  ok: "border-green-500 text-green-700 bg-green-50",
  warn: "border-yellow-400 text-yellow-700 bg-yellow-50",
  bad: "border-red-400 text-red-700 bg-red-50",
  pending: "border-yellow-400 text-yellow-700 bg-yellow-50",
};

export function ResultsDashboard({
  run,
  reps,
  primaryKpi,
  scenario,
  credibility,
  skin = false,
  projectName,
}: Props) {
  if (!run) {
    return (
      <div className="rounded-sm border border-[--hair-rule] bg-white px-3 py-[10px] text-[12.5px] text-[--zinc-quiet]">
        No run yet
      </div>
    );
  }
  const meta = extractMeta(run, reps);
  const codeVersion = run.code_version ?? "";
  const gateText = gateNotice(run);
  // What the run IS, from its status (audit F-07/F-18/F-30) — not inferred from
  // whether `code_version` happens to be set.
  const header = resultsHeader(run);
  // The recovery card scores the SCENARIO's schedule. When this view is not
  // given it, the card is not drawn: it used to invent N events of 40% / 5 days
  // / day 10 from `_meta.disruption_count` and score those (a number with no
  // source — T1; audit WP 5 handoff). Its horizon likewise came from a 90-day
  // default; it now needs a real one.
  return (
    <div className={cn('flex flex-col', skin ? 'm-cq gap-2' : 'gap-3')}>
      {skin ? (
        // A state, in the skin's vocabulary: a chip, never a coloured panel
        // (§3). The stub case is amber because it is the firm-level "derived"
        // meaning; a finished run is the process teal.
        <div className="flex flex-wrap items-center gap-1.5">
          <MobileChip
            fill={header.tone === 'ok' ? undefined : M.warnFill}
            ink={header.tone === 'ok' ? M.body : M.warnInk}
          >
            {header.text}
          </MobileChip>
          {credibility && <CredibilityBadge credibility={credibility} />}
          {gateText && <MobileChip fill={M.warnFill} ink={M.warnInk}>{gateText}</MobileChip>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("text-[11px] gap-1", HEADER_TONE[header.tone])}>
            {header.text}
          </Badge>
          {credibility && <CredibilityBadge credibility={credibility} />}
          {gateText && (
            <Badge variant="outline" className="text-[11px] gap-1 border-yellow-400 text-yellow-700 bg-yellow-50">
              {gateText}
            </Badge>
          )}
        </div>
      )}

      {/* WP 10.6 — how long this run keeps its weekly series; expired says so. */}
      <RunRetentionLine run={run} />

      {meta?.scsim_notes && meta.scsim_notes.length > 0 && (
        skin ? (
          // A disclosure triangle is not in the skin's control inventory, and
          // the notes are not optional reading — they are what the engine had
          // to change about the model. So they are a panel, open.
          <MobilePanel
            label="Engine conversion notes"
            counter={`${meta.scsim_notes.length}`}
            accent={M.firm}
          >
            {meta.scsim_notes.map((n, i) => (
              <MobileRow key={i} chevron={false} label={n} />
            ))}
          </MobilePanel>
        ) : (
          <details className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
            <summary className="flex min-h-11 cursor-pointer select-none items-center md:min-h-0 md:list-item">
              Engine conversion notes ({meta.scsim_notes.length})
            </summary>
            <ul className="list-disc pl-4 pt-1 space-y-0.5">
              {meta.scsim_notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        )
      )}

      {/* The "Recovery impact" card stood here: its with/without KPIs were computed
          from hand-set weights, not by a run (§4 D114). A real comparison is a paired
          run without the playbook — Compare scenarios. */}
      {!header.showAggregates ? null : (<>
      {/* Inventory over time (G19 / WP 9.1): materials and finished goods,
          in units or value. Plain weekly scalars, so — unlike the per-item
          panel at the bottom — this renders on every run. */}
      <InventoryOverTime
        reps={reps.filter((r) => r.status === "done")}
        warmupWeeks={run.warmup_detected_at}
      />
      {/* Capacity utilization (§4 D167): the engine's own weekly capacity and the
          part of it the run used, with the per-entity binding behind it. Same
          shape as the inventory chart above — plain weekly scalars, so it
          renders on every run, unlike the per-item panel at the bottom. The
          run-level `capacity_utilization` KPI in the table below is the window
          aggregate of exactly these two series. */}
      <CapacityOverTime
        reps={reps.filter((r) => r.status === "done")}
        binding={meta?.capacity_binding ?? null}
        warmupWeeks={run.warmup_detected_at}
      />
      <ConvergencePlot reps={reps} primaryKpi={primaryKpi} warmupAt={run.warmup_detected_at} />
      {/* Per-seed filter over the persisted weekly traces (W1 / G17): default
          is the cross-rep mean ± CI band; selecting a seed overlays or
          isolates that replication and shows its KPI row. */}
      <ReplicationSeedExplorer
        reps={reps.filter((r) => r.status === "done" && r.kpis)}
        warmupWeeks={run.warmup_detected_at}
      />
      <KpiStatTable reps={reps} primaryKpi={primaryKpi} codeVersion={codeVersion} stoppingRule={meta?.stopping_rule} />
      </>)}
      {/* `UtilizationHeatmap` WAS HERE AND IS REMOVED — §4 D113.
          It read a per-node `utilization` series from each replication and NO
          ENGINE WRITES ONE: `extra_series` carries exactly the four
          `ReplicationSeedExplorer` offers. So it rendered "Run a simulation that
          emits per-node utilization to see it here" on every run, forever — a
          sentence that reads as something a different run could fix. A panel that
          can only ever be empty is a placeholder, not a state, and removing it is
          a smaller change than emitting a series no policy needs. The run-level
          measure exists and now renders in the table above, as
          `capacity_utilization`, which the same defect had been hiding.

          AND THAT LAST SENTENCE WAS FALSE FOR THE WHOLE OF ITS LIFE — §4 D167.
          `capacity_utilization` read `trace.Q`, which exists only under
          `full_debug`, so on every ordinary run it was NaN, the bridge mapped
          NaN to null, and the row never appeared in the table this comment
          points at. It is computed from always-on weekly series now, and
          `CapacityOverTime` above is the panel this comment judged not worth
          building — which it was not, until the series it needs existed. */}
      {/* Inventory explorer (W3 / G17): inspection runs only. This page
          dispatches no inspection run, so before WP 9.1 the panel was empty
          here on every run and said nothing about why — the dead end §4 D113
          warns about. It names where an inspection run is started, and links
          there: a Lab scenario carries its own replication count, and the
          worker honours `inspection` only on a one-replication scenario, so a
          "Run inspection" here would have to write a scenario of its own —
          which is what Run & Validate's Single tab already does. The inventory
          chart above needs none of this: its series are plain weekly scalars
          present on every run. */}
      <ItemSeriesExplorer
        runId={run.id}
        warmupWeeks={run.warmup_detected_at}
        projectName={projectName}
        emptyHint={
          <>
            this run has none. Every material&apos;s and finished good&apos;s stock week by week
            comes from an inspection run (one replication, full trace):{" "}
            <Link
              to="/policies?stage=run_validate"
              className="-my-[11px] inline-flex min-h-11 items-center py-[11px] font-medium text-primary underline underline-offset-2 md:my-0 md:min-h-0 md:py-0"
            >
              Policies {"\u2192"} Run &amp; validate {"\u2192"} Single, with Inspection mode on
            </Link>
            . It then appears here too.
          </>
        }
      />
    </div>
  );
}

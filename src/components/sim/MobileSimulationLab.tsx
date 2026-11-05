/**
 * Simulation Lab — the phone tree (PAGES.md 14 · 15, mobile skin spec).
 *
 * WHY A SEPARATE TREE, not `md:` classes on SimulationLab. Below 768px this is a
 * different composition, not a reflow of the desktop one: the lettered stage
 * rail, the 256px scenario aside, the stress-test drawer and the per-pane card
 * stacks all fold into a title band, a five-way segmented control, one pane at
 * a time, and a pinned action bar whose Run button is always on screen.
 * `use-is-mobile.ts` reserves the hook for exactly this case (a different
 * component tree); the desktop tree is untouched.
 *
 * WHAT IT DOES NOT OWN. Every value here arrives as a prop from the page, which
 * already computed it. This adds no query, no RPC and no state shape — the only
 * state it owns is which sheet is open, which is purely visual.
 *
 * MATCHING THE SPEC MUST NOT DELETE PRODUCT CAPABILITY (skin spec §8: the
 * product shows a control, disables it, and explains why — it never hides one).
 * Every place a value is shown read-only, that row opens a bottom sheet holding
 * the REAL existing editor — `ScenarioSetupForm` sectioned by its `section`
 * prop, `DisruptionScheduleEditor`, `DisruptionRecoveryPane`'s playbook card,
 * `PreRunValidationPanel`, `MappingWarningsCard`, `ScenarioList` and
 * `StressTestDrawer`. One editor, two chromes: a control cannot drift between
 * platforms because there is only one of it.
 *
 * THE SKIN (docs/mobile-skin-spec.md). Every container on this screen is the
 * black-headed panel; there is no second container style. Three deliberate
 * readings of the spec are worth naming, because each is a place a reviewer
 * will look:
 *
 *  - §4 reserves the segmented control for "2-3 peer views" and the Lab has
 *    five panes. The inventory is not ours to reduce — the skin changes how a
 *    screen looks, never what it holds — so the five ride one segmented control
 *    rather than the old scrolling chip strip, which the skin has no vocabulary
 *    for. Measured at 320px each cell is ~55px against a widest label
 *    ("Compare", 11.5px/600) of ~47px, so nothing truncates at the narrowest
 *    reachable width.
 *  - §9.5 forbids horizontal scroll outside a deliberate full-table sheet, and
 *    §10 says a dense table summarises with the ledger deferred. The event and
 *    replication tables were sideways-scrolling ledgers; each column now rides
 *    a row instead — label, mono sub-line, value. Every column survives; none
 *    is truncated, and nothing scrolls sideways.
 *  - §6 keeps a confidence line out of a stat cell. The four KPI figures are a
 *    stat grid and their CI half-widths move to a panel of their own directly
 *    beneath it — deferred, not dropped.
 *
 * Sheet catalogue (all through the one MobileSheet shell, which stops above the
 * tab bar per G6): projects · scenarios · scenario · run window · precision ·
 * objective · disruption schedule · recovery playbook · findings · mapping
 * report.
 */
import { suppliedMaterialIds } from "@/lib/sim/disruptionEvents";
import { replicationLabel } from "@/lib/sim/replicationLabel";
import type { RunGateState } from "@/lib/sim/runGate";
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Truck } from "lucide-react";
import { MobileSheet } from "@/components/shared/MobileSheet";
import { cn } from "@/lib/utils";
import {
  M,
  M_LABEL,
  M_MICRO,
  MobileActionBar,
  MobileButton,
  MobileButtonRow,
  MobileGroup,
  MobilePageHeader,
  MobilePanel,
  MobileRow,
  MobileSegmented,
  MobileStatGrid,
  MobileToggle,
  ProjectChip,
  type MobileStat,
  type SegmentedItem,
} from "@/components/mobile";
import { useRowBudget, useStatBudget } from "@/hooks/useViewport";
import { ScenarioSetupForm } from "./ScenarioSetupForm";
import { DisruptionScheduleEditor } from "./DisruptionScheduleEditor";
import { DisruptionRecoveryPane } from "./DisruptionRecoveryPane";
import { PreRunValidationPanel } from "./PreRunValidationPanel";
import { MappingWarningsCard } from "./RunProgressPanel";
import { ResultsDashboard } from "./ResultsDashboard";
import { CompareScenariosPanel } from "./CompareScenariosPanel";
import { ExperimentLibraryBox, ScenarioList } from "./ScenarioRail";
import { StressTestDrawer, type StressTestPreset } from "./StressTestCard";
import { SurrogateCard } from "./SurrogateCard";
import type { TrainingTotals } from "@/lib/sim/surrogateTraining";
import { ReadOnlyFrame, type ReadOnlyAction } from "./ReadOnlyFrame";
import { RESPONSE_LABELS, type InboundLane, type RecoveryConfig, type RecoveryResponseKey } from "@/lib/sim/recovery";
import { kpiDisplay } from "@/lib/sim/kpiDisplay";
import { useTimeUnit, UNIT_LABEL_PLURAL } from "@/hooks/useTimeUnit";
import { formatDuration, formatWeek } from "@/lib/sim/planningTime";
import { effectLabel, targetLabel } from "@/lib/sim/disruptionEvents";
import type { PaneId } from "./StageRail";
import type { Scenario } from "@/hooks/useScenarios";
import type { Replication, SimulationRun } from "@/hooks/useSimulationRun";
import type { Credibility } from "@/hooks/useModelValidation";
import type { Finding } from "@/lib/policies/validationService";

/** Every sheet this screen can show. `null` is the pane itself. */
type Sheet =
  | "scenarios"
  | "scenario"
  | "runWindow"
  | "precision"
  | "objective"
  | "schedule"
  | "playbook"
  | "findings"
  | "mapping"
  | "events"
  | "reps"
  | null;

/** The five panes, in the order the desktop stage rail uses. `recovery` is
 *  "Events"; the pane it opens carries the playbook too, so the playbook keeps
 *  its own name on the panel inside. */
const PANES: ReadonlyArray<SegmentedItem<PaneId>> = [
  { value: "setup", label: "Setup" },
  { value: "recovery", label: "Events" },
  { value: "run", label: "Run" },
  { value: "results", label: "Results" },
  { value: "compare", label: "Compare" },
];

/** Named only so the playbook row can count the levers it is not showing. */
const STRATEGY_COUNT = 6;

/** An empty state is still a panel — there is no bare card in the skin. */
function EmptyBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-9 text-center">
      {children}
    </div>
  );
}

export interface MobileSimulationLabProps {
  /* header */
  projects: Array<{ id: string; name: string }>;
  projectId: string | null;
  onProjectChange: (id: string | null) => void;

  /* scenarios */
  scenarios: Scenario[];
  scenariosLoading: boolean;
  selected: Scenario | null;
  selectedId: string | null;
  credibilityFor: (s: Scenario) => Credibility;
  onSelectScenario: (id: string) => void;
  onCreateScenario: () => void;
  onDuplicateScenario: (s: Scenario) => void;
  onDeleteScenario: (id: string) => void;
  onBrowseLibrary: () => void;
  stressCount: number;
  stressOpen: boolean;
  onToggleStress: () => void;
  onLaunchStress: (preset: StressTestPreset) => void;

  /* panes */
  pane: PaneId;
  onPane: (p: PaneId) => void;

  /* setup + events — the same handlers the desktop panes get */
  onSaveScenario: (patch: Partial<Scenario>) => void;
  projectRecovery: RecoveryConfig | null;
  effectiveRecovery: RecoveryConfig;

  /* run */
  policyVersionLabel: string | null;
  policyDirty: boolean;
  credibility: Credibility;
  runCredibility: Credibility;
  gateFindings: Finding[] | null;
  gateBlocks: number;
  gateWarns: number;
  ackWarnings: boolean;
  onAckWarnings: (v: boolean) => void;
  runBlockedReason: string | null;
  /** the one gate state the desktop rail and Run card read (runGate.ts) */
  runGate: RunGateState;
  /** the capacity line the desktop Run pane shows (§4 D167 / D224) */
  capacity?: React.ReactNode;
  /** non-null when the selected scenario is the validated baseline (§4 D227) */
  readOnlyReason?: string | null;
  /** WP 10.5 — the settings are locked to the Validated Model's protocol until
   *  "Advanced" is open; the disruption schedule never is. */
  settingsLockReason?: string | null;
  /** the lock's way out, on this page (unlock the protocol / new scenario) */
  settingsLockAction?: ReadOnlyAction | null;
  /** whether the lock is /policies' to lift (the baseline) */
  settingsValidateLink?: boolean;
  findingsSource: "pre-run check" | "gate rejection";
  supplierIds: string[];
  /** The project's inbound lanes, for the Backup supplier panel. */
  inboundLanes?: InboundLane[];
  latestRun: SimulationRun | null;
  reps: Replication[];
  runVersionLabel: string | null;
  onRun: () => void;
  onSaveVersionAndRun: () => void;
  onCancel: () => void;
  onAddReps: (n: number) => void;

  /* compare */
  runsByScenario: Record<string, SimulationRun>;
  /** WP 10.5 — compare defaults to this model's runs (null = every run). */
  compareModelId?: string | null;
  /** run id → the model whose evidence it is (the desktop's map, the same rule). */
  compareEvidenceModelOf?: Record<string, string>;

  /* WP 10.5 — the Model and Engine steps (the same node the desktop renders) */
  modelStep?: React.ReactNode;
  /** replication-weeks and expected storage, with its basis */
  runEstimate?: string | null;
  /** WP 10.8 — the surrogate's training set, grouped by model and graph version */
  trainingSet?: TrainingTotals | null;
}

export function MobileSimulationLab(props: MobileSimulationLabProps) {
  const {
    projects,
    projectId,
    onProjectChange,
    scenarios,
    scenariosLoading,
    selected,
    selectedId,
    credibilityFor,
    onSelectScenario,
    onCreateScenario,
    onDuplicateScenario,
    onDeleteScenario,
    onBrowseLibrary,
    stressCount,
    stressOpen,
    onToggleStress,
    onLaunchStress,
    pane,
    onPane,
    onSaveScenario,
    projectRecovery,
    effectiveRecovery,
    policyVersionLabel,
    policyDirty,
    credibility,
    runCredibility,
    gateFindings,
    gateBlocks,
    gateWarns,
    ackWarnings,
    onAckWarnings,
    runBlockedReason,
    modelStep,
    runEstimate,
    trainingSet = null,
    compareModelId,
    compareEvidenceModelOf,
    runGate,
    capacity,
    readOnlyReason = null,
    settingsLockReason = null,
    settingsLockAction = null,
    settingsValidateLink = true,
    findingsSource,
    supplierIds,
    inboundLanes,
    latestRun,
    reps,
    runVersionLabel,
    onRun,
    onSaveVersionAndRun,
    onCancel,
    onAddReps,
    runsByScenario,
  } = props;

  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);

  // How much of a ledger the device can hold before the rest is deferred into
  // a sheet (v2 §5.4). A count is the one decision CSS cannot make; everything
  // else about how these rows look is a clamp.
  const eventBudget = useRowBudget();
  const repBudget = useRowBudget(4, 6, 9);
  const statBudget = useStatBudget();
  // Read-only here, as everywhere in the Lab: the planning unit is set on
  // /policies. This only labels the row (WP 9.4 slice 1).
  const { unit } = useTimeUnit(projectId);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;
  const events = selected?.disruption_schedule ?? [];
  const levers = (effectiveRecovery.response ?? []) as RecoveryResponseKey[];
  const findings = gateFindings ?? [];

  /* ── header — the chrome contract's root header (v3 §1.1) ───────────────── */
  // The project chip and the five-pane segmented control both live on the
  // header's second row, pinned with the title — the scenario, which is what
  // the panes below are about, gets a panel row of its own rather than the
  // subtitle the budget no longer has a band for.
  const header = (
    <MobilePageHeader variant="root" title="Simulation Lab">
      {/* Stacked, not shared on one line: five panes plus the chip would
          crowd below ~375px (Controls.tsx's own 320px measurement assumes
          the segmented control gets the full row). Both still live in the
          one pinned header block (v3 §1.1) — just on their own lines of it. */}
      <div className="flex w-full flex-col gap-2.5">
        <ProjectChip projects={projects} selectedId={projectId} onSelect={onProjectChange} />
        <MobileSegmented
          className="w-full"
          items={PANES}
          value={pane}
          onChange={onPane}
          ariaLabel="Simulation Lab panes"
        />
      </div>
    </MobilePageHeader>
  );

  /* ── the gate — §13.3, the one thing that needs attention ─────────────── */
  // It used to live in the footer. The skin's action bar holds actions and
  // nothing else, and §13 puts what needs attention at the TOP of the content,
  // so the gate is the screen's first panel whenever it has something to say.
  // The blocking case is a red dot on a row, not a red panel: §3 caps a
  // meaning colour at a dot, a 2px rule or a chip.
  const warnSummary =
    findings
      .filter((f) => f.severity === "warn")
      .map((f) => f.field)
      .filter(Boolean)
      .join(" · ") || "the engine applies its defaults";

  const gated = gateBlocks > 0 || gateWarns > 0;

  // v2 §2: the ink head is rationed to ONE panel per screen — the thing that
  // changed or the thing that blocks. On this screen that is the gate whenever
  // it has anything to say; when it does not, the pane's own principal panel
  // takes the voice. `paneTone` below is how each pane asks.
  const paneTone = gated ? "secondary" : "primary";

  const gatePanel = gated ? (
      <MobilePanel
        tone="primary"
        label="Required-data gate"
        counter={gateBlocks > 0 ? `${gateBlocks} blocking` : `${gateWarns} warn`}
      >
        {gateBlocks > 0 ? (
          <MobileRow
            dot={M.blocking}
            label={`Run rejected — ${gateBlocks} blocking ${gateBlocks === 1 ? "gap" : "gaps"}`}
            sub={runBlockedReason ?? "see the findings panel"}
            onClick={() => setSheet("findings")}
          />
        ) : (
          <>
            <MobileRow
              dot={M.firm}
              label={`Acknowledge ${gateWarns} ${gateWarns === 1 ? "warning" : "warnings"}`}
              sub={warnSummary}
              chevron={false}
              trailing={
                <MobileToggle
                  checked={ackWarnings}
                  onChange={onAckWarnings}
                  label={`Acknowledge ${gateWarns} ${gateWarns === 1 ? "warning" : "warnings"}`}
                />
              }
            />
            <MobileRow
              label="View findings"
              sub={findingsSource}
              onClick={() => setSheet("findings")}
            />
          </>
        )}
      </MobilePanel>
  ) : null;

  /* ── the scenario band ────────────────────────────────────────────────── */
  // The dot is the scenario's own credibility, not merely "something is
  // selected": validated reads as healthy, stale as derived, anything else as
  // inactive. Desktop shows the same fact on a badge with a hover tooltip,
  // which a thumb cannot reach.
  const scenarioDot =
    !selected
      ? M.idle
      : credibility.state === "validated"
        ? M.process
        : credibility.state === "stale"
          ? M.firm
          : M.idle;

  const scenarioPanel = (
    <MobilePanel label="Scenario" counter={`${scenarios.length}`}>
      <MobileRow
        dot={scenarioDot}
        label={selected ? selected.name || "Untitled scenario" : "No scenario yet"}
        sub={
          selected
            ? `model ${credibility.state} · ${selected.description || "no description"}`
            : scenariosLoading
              ? "loading…"
              : "choose or create one"
        }
        onClick={() => setSheet("scenarios")}
      />
    </MobilePanel>
  );

  /* ── Setup ────────────────────────────────────────────────────────────── */
  // Read-only fact rows over the REAL editors. Nothing is dropped: Scenario and
  // Primary KPI are product fields with no counterpart in the reference, and
  // they are rows of the same kind rather than hidden.
  const inherited = !!selected?.inherited_validation_id;
  const setupRows: Array<{
    label: string;
    hint: string;
    value: string;
    sheet?: Exclude<Sheet, null>;
    pane?: PaneId;
  }> = selected
    ? [
        {
          label: "Scenario",
          hint: selected.description || "no description",
          value: UNIT_LABEL_PLURAL[unit],
          sheet: "scenario",
        },
        { label: "Horizon", hint: "simulated period", value: formatDuration(selected.horizon_days), sheet: "runWindow" },
        {
          label: "Replications",
          hint: inherited ? "adopted n* · from model validation" : "not adopted — engine default",
          value: String(selected.replications),
          sheet: "precision",
        },
        {
          label: "Warm-up",
          hint: inherited
            ? `adopted · detection ${selected.warmup_mode}`
            : `not adopted · detection ${selected.warmup_mode}`,
          value: formatDuration(selected.warmup_days),
          sheet: "runWindow",
        },
        {
          label: "Random seed",
          hint: selected.crn ? "reproducible stream" : "common random numbers off",
          value: String(selected.seed),
          sheet: "precision",
        },
        {
          label: "Primary KPI",
          hint: `stopping rule ${selected.stopping_rule?.kind ?? "fixed_horizon"}`,
          value: kpiDisplay(selected.primary_kpi).label,
          sheet: "objective",
        },
        {
          label: "Policy version",
          hint: policyDirty ? "unsaved — a run needs a saved version" : "frozen at run time",
          value: policyVersionLabel ?? "—",
        },
        {
          label: "Disruption schedule",
          hint: "edit in Events",
          value: `${events.length} ${events.length === 1 ? "event" : "events"}`,
          pane: "recovery",
        },
      ]
    : [];

  const setupPane = (
    <MobileGroup label="Experiment">
      <MobilePanel tone={paneTone} label="Experiment design" counter={`${setupRows.length}`}>
        {setupRows.map((r) => (
          <MobileRow
            key={r.label}
            label={r.label}
            sub={r.hint}
            value={r.value}
            onClick={r.sheet ? () => setSheet(r.sheet!) : r.pane ? () => onPane(r.pane!) : undefined}
          />
        ))}
      </MobilePanel>

      {/* A cross-screen note WITH A ROUTE, not a dead-end warning. */}
      {selected && !inherited ? (
        <MobilePanel label="Model validation" accent={M.firm}>
          <Link
            to="/policies"
            className="flex min-h-11 w-full items-center gap-2.5 px-3 py-[var(--m-row-y)] text-left active:bg-[#fafafa]"
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: M.firm }}
            />
            <span className="min-w-0 flex-1 text-[length:var(--fs-row)] font-medium leading-tight text-[#171717] [text-wrap:pretty]">
              Warm-up &amp; n* not adopted — set them in Policies
            </span>
            <span aria-hidden className="shrink-0 text-[15px] leading-none text-[#6b6b6b]">
              ›
            </span>
          </Link>
        </MobilePanel>
      ) : null}
    </MobileGroup>
  );

  /* ── Events ───────────────────────────────────────────────────────────── */
  // The ledger was a sideways-scrolling four-column table. Every column is
  // still here — the target, the start day and the duration ride the row's
  // mono sub-line — and nothing scrolls sideways (§9.5, §10).
  const eventsPane = (
    <>
      <MobileGroup label="Schedule">
        <MobilePanel tone={paneTone} label="Disruption schedule" counter={`${events.length}`}>
          {events.length === 0 ? (
            <EmptyBody>
              <span className="max-w-[250px] text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
                No disruption events — this scenario runs undisrupted.
              </span>
            </EmptyBody>
          ) : (
            <>
              {events.slice(0, eventBudget).map((e, i) => (
                <MobileRow
                  key={i}
                  chevron={false}
                  label={`${effectLabel(e.magnitude_pct)} · ${targetLabel(e.target)}`}
                  sub={`${e.target || "—"} · from ${formatWeek(e.start_day)} · ${formatDuration(e.duration_days)}`}
                  value={formatWeek(e.start_day)}
                />
              ))}
              {/* Defer, never truncate (§10, v2 §5.4). What the device cannot
                  hold is one tap away with every column intact — the row is
                  not optional, and it counts what it is deferring. */}
              {events.length > eventBudget ? (
                <MobileRow
                  label={`All ${events.length} disruptions`}
                  sub={`${events.length - eventBudget} more`}
                  onClick={() => setSheet("events")}
                />
              ) : null}
            </>
          )}
        </MobilePanel>

        <MobileButtonRow>
          <MobileButton weight="secondary" onClick={() => setSheet("schedule")}>
            Add disruption event
          </MobileButton>
          <MobileButton weight="secondary" onClick={() => onPane("setup")}>
            Setup
          </MobileButton>
        </MobileButtonRow>
      </MobileGroup>

      {/* The reference's Events pane carries no playbook. The product's does,
          and §8 forbids hiding a control — so it keeps its own panel and its
          row opens the real editor. */}
      <MobileGroup label="Recovery">
        <MobilePanel
          label="Recovery playbook"
          counter={effectiveRecovery.enabled ? "enabled" : "disabled"}
        >
          <MobileRow
            label="Response strategies"
            sub={levers.length ? levers.map((l) => RESPONSE_LABELS[l]).join(" · ") : "none active"}
            value={`${levers.length} / ${STRATEGY_COUNT}`}
            onClick={() => setSheet("playbook")}
          />
        </MobilePanel>
      </MobileGroup>
    </>
  );

  /* ── Run ──────────────────────────────────────────────────────────────── */
  const runStatus = latestRun?.status ?? null;
  const done = runStatus === "done";
  const active = runStatus === "running" || runStatus === "queued";
  const bad = runStatus === "failed" || runStatus === "cancelled";
  const repsDone = latestRun?.rep_count_done ?? 0;
  const repsTarget = latestRun?.rep_count_target ?? selected?.replications ?? 0;
  const pct = repsTarget ? Math.min(100, Math.round((repsDone / repsTarget) * 100)) : 0;
  const statusDot = runStatus === "running" ? M.process : done ? M.process : bad ? M.blocking : M.idle;

  // Scenario name and policy version are the panel's own headline and meta
  // line, so the grid carries the four figures and does not repeat them.
  const runStats: MobileStat[] = selected
    ? [
        { label: "Replications", value: String(repsTarget) },
        { label: "Warm-up", value: formatDuration(selected.warmup_days) },
        { label: "Seed", value: String(selected.seed) },
        { label: "Events", value: String(events.length) },
      ]
    : [];

  const runPane = (
    <>
      {capacity ? <div className="px-3 pt-1">{capacity}</div> : null}
      {runEstimate ? (
        <p className="px-3 font-mono text-[11.5px] text-[#525252] [text-wrap:pretty]" data-testid="run-estimate">
          {runEstimate}
        </p>
      ) : null}
      <MobileGroup label="Progress">
        <MobilePanel tone={paneTone} label="Run" counter={runStatus ?? "not started"}>
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex items-baseline justify-between gap-2.5">
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.006em] text-[#171717]">
              {selected?.name || "Untitled scenario"}
            </span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[12px] font-semibold tabular-nums text-[#171717]">
              {pct}%
            </span>
          </div>
          {/* The one ambient animation in the skin belongs to a running job. */}
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                runStatus === "running" && "animate-pulse motion-reduce:animate-none",
              )}
              style={{ background: statusDot }}
            />
            <span className="block h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[#d4d4d4]">
              <span className="block h-full bg-[#18181b]" style={{ width: `${pct}%` }} />
            </span>
          </span>
          {/* Desktop puts credibility on a badge whose only explanation is a
              hover tooltip — inert on touch. The state is a fact, so it is
              named in words here rather than left as a colour. */}
          <span className={cn(M_MICRO, "[text-wrap:pretty]")}>
            {[
              `${repsDone} / ${repsTarget} replications`,
              latestRun ? `model ${runCredibility.state}` : null,
              runVersionLabel ?? policyVersionLabel ?? "no saved version",
              latestRun?.warmup_detected_at != null
                ? `detected day ${latestRun.warmup_detected_at}`
                : "warm-up pending",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>

          {/* §3.1: an error message is on the never-truncate list. */}
          {latestRun?.error_message ? (
            <p className="text-[12.5px] leading-snug text-[#bf2330] [text-wrap:pretty]">
              {latestRun.error_message}
            </p>
          ) : null}
          {runStatus === "queued" ? (
            <p className="text-[12.5px] leading-snug text-[#525252]">Queued</p>
          ) : null}

          <MobileButtonRow>
            {active ? (
              <MobileButton weight="secondary" onClick={onCancel}>
                Cancel run
              </MobileButton>
            ) : done ? (
              <MobileButton weight="secondary" onClick={() => onAddReps(10)}>
                Add 10 reps
              </MobileButton>
            ) : null}
            <MobileButton weight="secondary" onClick={() => onPane("setup")}>
              {latestRun ? "Run spec" : "Edit spec"}
            </MobileButton>
          </MobileButtonRow>
        </div>

        <MobileRow
          label="Engine mapping report"
          sub={latestRun ? "values the engine derived or defaulted" : "written when a run dispatches"}
          value={String(latestRun?.mapping_warnings?.length ?? 0)}
          onClick={() => setSheet("mapping")}
        />
        </MobilePanel>

        {runStats.length > 0 ? <MobileStatGrid stats={runStats.slice(0, statBudget)} /> : null}
      </MobileGroup>

      <MobileGroup>
        <MobilePanel label="Per replication" counter={`${reps.length} / ${repsTarget}`}>
          {reps.length === 0 ? (
            <EmptyBody>
              <span className="text-[13px] leading-relaxed text-[#525252]">
                Starting…
              </span>
            </EmptyBody>
          ) : (
            <>
              {reps.slice(0, repBudget).map((r) => (
                <MobileRow
                  key={r.id}
                  chevron={false}
                  label={`Rep ${r.rep_index}`}
                  sub={replicationLabel(r)}
                  value={r.status}
                />
              ))}
              {reps.length > repBudget ? (
                <MobileRow
                  label={`All ${reps.length} replications`}
                  sub={`${reps.length - repBudget} more`}
                  onClick={() => setSheet("reps")}
                />
              ) : null}
            </>
          )}
        </MobilePanel>
      </MobileGroup>
    </>
  );

  /* ── Results ──────────────────────────────────────────────────────────── */
  const kpiTiles = useMemo(() => {
    const agg = latestRun?.aggregate_kpis ?? {};
    const ci = latestRun?.ci_half_widths ?? {};
    return Object.keys(agg)
      .filter((k) => typeof agg[k] === "number")
      .slice(0, 4)
      .map((k) => {
        const d = kpiDisplay(k);
        return {
          key: k,
          label: d.label,
          value: d.format(agg[k]),
          ci: typeof ci[k] === "number" ? `± ${d.format(ci[k])} 95% CI` : "no CI recorded",
        };
      });
  }, [latestRun]);

  const credState = runCredibility.state;
  const resultsPane =
    !latestRun || latestRun.status !== "done" ? (
      <MobilePanel tone={paneTone} label="Results">
        <EmptyBody>
          <Truck className="h-[22px] w-[22px] text-[#525252]" strokeWidth={2} />
          <span className="max-w-[250px] text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
            {latestRun && (latestRun.status === "running" || latestRun.status === "queued")
              ? "Run in progress — results appear when it finishes."
              : `No completed replications for ${activeProject?.name ?? "this project"} yet.`}
          </span>
          <MobileButton weight="secondary" onClick={() => onPane("run")}>
            Go to Run
          </MobileButton>
        </EmptyBody>
      </MobilePanel>
    ) : (
      <>
        <MobileGroup label="Headline">
          {kpiTiles.length > 0 ? (
            <MobileStatGrid
              stats={kpiTiles
                .slice(0, statBudget)
                .map((k) => ({ label: k.label, value: k.value }))}
            />
          ) : null}

          {/* §6 keeps the confidence line out of the stat cell; it lands here
              rather than disappearing — every KPI, not only the ones the grid
              had room for. */}
          {kpiTiles.length > 0 ? (
            <MobilePanel label="Confidence" counter={`n = ${repsDone}`}>
              {kpiTiles.map((k) => (
                <MobileRow key={k.key} chevron={false} label={k.label} value={k.ci} />
              ))}
            </MobilePanel>
          ) : null}
        </MobileGroup>

        <MobileGroup label="Evidence">
        <MobilePanel label="Provenance" counter={credState}>
          <MobileRow
            chevron={false}
            dot={credState === "validated" ? M.process : credState === "stale" ? M.firm : M.idle}
            label="Model credibility"
            sub={[
              selected?.name,
              runVersionLabel ?? policyVersionLabel,
              selected ? `warm-up ${formatDuration(selected.warmup_days)}` : null,
              selected ? `seed ${selected.seed}` : null,
              `${events.length} events`,
            ]
              .filter(Boolean)
              .join(" · ")}
            value={credState}
          />
          <div className="px-3 py-[13px]">
            <span className="block font-mono text-[10.5px] leading-relaxed tracking-[0.04em] text-[#525252] [word-break:break-all]">
              {[
                latestRun.policy_hash ? `policy ${latestRun.policy_hash.slice(0, 6)}` : null,
                latestRun.scenario_hash ? `scenario ${latestRun.scenario_hash.slice(0, 6)}` : null,
                latestRun.code_version,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        </MobilePanel>
        </MobileGroup>

        {/* The charts and tables are the product's, unchanged: the same
            components desktop mounts, so no number can differ between them.
            `credibility` is omitted because the Provenance panel above already
            IS the credibility readout — the dashboard's badge explains itself
            only through a hover tooltip, which is inert on touch. Desktop
            still passes it. These two still wear the desktop vocabulary; they
            are on the skin's own list of surfaces still to convert. */}
        <MobileGroup>
          <ResultsDashboard
            run={latestRun}
            reps={reps}
            primaryKpi={selected?.primary_kpi ?? ""}
            scenario={selected}
            skin
          />
        </MobileGroup>
      </>
    );

  /* ── the action bar — the honest gate ─────────────────────────────────── */
  // One gate state, the same one the desktop rail reads (§4 D147).
  const canRun = runGate.canRun;
  const runLabel =
    runGate.kind === "blocked"
      ? `Blocked by ${gateBlocks} ${gateBlocks === 1 ? "finding" : "findings"}`
      : runGate.kind === "ack_required"
        ? "Acknowledge to run"
        : runGate.kind === "baseline"
          ? "Runs in Policies"
          : runGate.kind === "capability"
            ? "Run unavailable"
            : policyDirty
              ? "Save version & run"
              : active
                ? "Running…"
                : done
                  ? "Run again"
                  : "Run simulation";

  // §8: a control that cannot be used is shown, disabled and explained in one
  // line underneath. The policy-binding state is that line whether or not it
  // blocks, because it is what the run will be bound to.
  const actionNote = policyDirty
    ? "Unsaved policy state — saving a version binds the run to it."
    : !canRun && runBlockedReason
      ? runBlockedReason
      : policyVersionLabel
        ? `Binds policy version ${policyVersionLabel}.`
        : "No saved model version — a run requires a saved policy version.";

  /* ── the screen ───────────────────────────────────────────────────────── */
  // Three literals, one screen. These two are the WHOLE body when they render
  // — there is no gate, no scenario band and no pane beneath them — and the
  // gate above renders only when a project and a scenario exist. So exactly
  // one ink head reaches any given screen (v2 §2).
  const body = !projectId ? (
    <MobilePanel tone="primary" label="Project">
      <EmptyBody>
        <span className="text-[13px] leading-relaxed text-[#525252]">No project selected</span>
      </EmptyBody>
    </MobilePanel>
  ) : !selected ? (
    <MobilePanel tone="primary" label="Scenario">
      <EmptyBody>
        <span className="max-w-[250px] text-[13px] leading-relaxed text-[#525252] [text-wrap:pretty]">
          {scenariosLoading ? "Loading scenarios…" : "No scenario selected."}
        </span>
        {!scenariosLoading ? (
          <MobileButton weight="secondary" onClick={() => setSheet("scenarios")}>
            Choose a scenario
          </MobileButton>
        ) : null}
      </EmptyBody>
    </MobilePanel>
  ) : (
    <>
      {modelStep ? <MobileGroup>{modelStep}</MobileGroup> : null}
      <MobileGroup>
        {gatePanel}
        {scenarioPanel}
      </MobileGroup>
      {pane === "setup"
        ? setupPane
        : pane === "recovery"
          ? eventsPane
          : pane === "run"
            ? runPane
            : pane === "results"
              ? resultsPane
              : (
                <MobileGroup>
                  <CompareScenariosPanel
                    scenarios={scenarios}
                    runsByScenario={runsByScenario}
                    modelId={compareModelId ?? null}
                    evidenceModelOf={compareEvidenceModelOf}
                    skin
                  />
                </MobileGroup>
              )}
    </>
  );

  return (
    // Edge to edge on the page canvas, which PageLayout paints. This screen
    // scrolls with the document like every other skinned surface — the Run
    // button no longer needs a fixed-height column to stay on screen, because
    // <MobileActionBar> is pinned to the chrome boundary PageLayout publishes
    // as `--pi-chrome`.
    <div className="flex flex-col pb-4">
      {header}
      {/* The gap is the gap between GROUPS (v2 §2). Panels inside a group sit
          8px apart; a band is 18-24px from the next. */}
      <main className="flex min-w-0 flex-col gap-[var(--m-gap)] px-[var(--m-gutter)]">{body}</main>

      {projectId && selected ? (
        <MobileActionBar
          primary={{
            label: runLabel,
            onClick: policyDirty ? onSaveVersionAndRun : onRun,
            disabled: !canRun,
          }}
          note={actionNote}
        />
      ) : null}

      {/* ── sheets — every one holds the REAL editor ─────────────────────── */}
      {/* Switching projects is the header's <ProjectChip>, which owns its own
          sheet — see the header block above. */}

      <MobileSheet
        open={sheet === "scenarios"}
        title="Scenarios"
        sub="Pick the scenario to design and run, or start one from the stress-test library."
        onClose={close}
      >
        <div className="p-3.5">
          <ExperimentLibraryBox count={stressCount} open={stressOpen} onToggle={onToggleStress} />
          {stressOpen ? <StressTestDrawer onLaunch={onLaunchStress} /> : null}
          <SurrogateCard training={trainingSet} />
          <ScenarioList
            scenarios={scenarios}
            selectedId={selectedId}
            loading={scenariosLoading}
            credibilityFor={credibilityFor}
            onSelect={(id) => {
              onSelectScenario(id);
              close();
            }}
            onBrowseSaved={() => {
              close();
              onBrowseLibrary();
            }}
            onCreate={onCreateScenario}
            onDuplicate={onDuplicateScenario}
            onDelete={onDeleteScenario}
          />
        </div>
      </MobileSheet>

      {/* Setup's four sheets mount the ONE ScenarioSetupForm, sectioned. The
          name, the planning unit, the eight parameters and the objective are
          the same controls the desktop pane renders, with the same commit
          semantics — not a phone-only copy that can drift. */}
      {selected ? (
        <>
          <MobileSheet open={sheet === "scenario"} title="Scenario" onClose={close}>
            <div className="p-3.5">
              <ReadOnlyFrame
                reason={settingsLockReason ?? readOnlyReason}
                action={settingsLockAction}
                validateLink={settingsValidateLink}
              >
                <ScenarioSetupForm
                  section="identity"
                  scenario={selected}
                  projectId={projectId}
                  onSave={onSaveScenario}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>

          <MobileSheet open={sheet === "runWindow"} title="Run window" onClose={close}>
            <div className="p-3.5">
              <ReadOnlyFrame
                reason={settingsLockReason ?? readOnlyReason}
                action={settingsLockAction}
                validateLink={settingsValidateLink}
              >
                <ScenarioSetupForm
                  section="runWindow"
                  scenario={selected}
                  projectId={projectId}
                  onSave={onSaveScenario}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>

          <MobileSheet open={sheet === "precision"} title="Precision" onClose={close}>
            <div className="p-3.5">
              <ReadOnlyFrame
                reason={settingsLockReason ?? readOnlyReason}
                action={settingsLockAction}
                validateLink={settingsValidateLink}
              >
                <ScenarioSetupForm
                  section="precision"
                  scenario={selected}
                  projectId={projectId}
                  onSave={onSaveScenario}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>

          <MobileSheet open={sheet === "objective"} title="Objective" onClose={close}>
            <div className="p-3.5">
              <ReadOnlyFrame
                reason={settingsLockReason ?? readOnlyReason}
                action={settingsLockAction}
                validateLink={settingsValidateLink}
              >
                <ScenarioSetupForm
                  section="objective"
                  scenario={selected}
                  projectId={projectId}
                  onSave={onSaveScenario}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>

          <MobileSheet
            open={sheet === "schedule"}
            title="Disruption schedule"
            sub="In weeks — the engine advances week by week."
            onClose={close}
          >
            <div className="p-3.5">
              <ReadOnlyFrame reason={readOnlyReason}>
                <DisruptionScheduleEditor
                  value={selected.disruption_schedule}
                  onChange={(v) => onSaveScenario({ disruption_schedule: v })}
                  projectId={projectId}
                  warmup={{ days: selected.warmup_days, mode: selected.warmup_mode, horizonDays: selected.horizon_days }}
                  supplierIds={supplierIds}
                  materialIds={suppliedMaterialIds(inboundLanes)}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>

          <MobileSheet open={sheet === "playbook"} title="Recovery playbook" onClose={close}>
            <div className="p-3.5">
              <ReadOnlyFrame reason={readOnlyReason}>
                <DisruptionRecoveryPane
                  sections="playbook"
                  scenario={selected}
                  projectRecovery={projectRecovery}
                  onSave={onSaveScenario}
                  supplierIds={supplierIds}
                  inboundLanes={inboundLanes}
                />
              </ReadOnlyFrame>
            </div>
          </MobileSheet>
        </>
      ) : null}

      <MobileSheet open={sheet === "findings"} title="Required-data gate" onClose={close}>
        <div className="p-3.5">
          {projectId ? (
            <PreRunValidationPanel
              projectId={projectId}
              findings={gateFindings}
              source={findingsSource}
              acknowledged={ackWarnings}
              onAcknowledgedChange={onAckWarnings}
              supplierIds={supplierIds}
            />
          ) : null}
        </div>
      </MobileSheet>

      <MobileSheet open={sheet === "mapping"} title="Engine mapping report" onClose={close}>
        <div className="p-3.5">
          {/* MappingWarningsCard renders nothing until a run finishes or the
              engine writes a fallback, so the sheet says why rather than
              opening empty. */}
          {latestRun && (latestRun.status === "done" || latestRun.mapping_warnings?.length) ? (
            <MappingWarningsCard warnings={latestRun.mapping_warnings} status={latestRun.status} />
          ) : (
            <p className="text-[12.5px] leading-snug text-[#525252] [text-wrap:pretty]">
              The mapping report is written by the engine — it lists every value the mapper had to
              derive or default. It exists once a run has finished.
            </p>
          )}
        </div>
      </MobileSheet>

      {/* ── the deferred ledgers ─────────────────────────────────────────
          "Defer, never truncate" (§10, v2 §5.4): the panels above show what
          the device can hold and these hold the rest, in full, with every
          column the desktop ledger has. Nothing here is a summary. */}
      <MobileSheet
        open={sheet === "events"}
        title="Disruption schedule"
        sub="Every disruption in this scenario, in the order the engine applies them."
        onClose={close}
      >
        <div className="flex flex-col">
          {events.map((e, i) => (
            <MobileRow
              key={i}
              chevron={false}
              label={`${e.target_type === "edge" ? "Lane" : "Node"} · ${e.magnitude_pct}%`}
              sub={`${e.target || "—"} · from ${formatWeek(e.start_day)} · ${formatDuration(e.duration_days)}`}
              value={formatWeek(e.start_day)}
            />
          ))}
        </div>
      </MobileSheet>

      <MobileSheet
        open={sheet === "reps"}
        title="Per replication"
        sub={`${reps.length} of ${repsTarget} replications, with the seed each one used.`}
        onClose={close}
      >
        <div className="flex flex-col">
          {reps.map((r) => (
            <MobileRow
              key={r.id}
              chevron={false}
              label={`Rep ${r.rep_index}`}
              sub={replicationLabel(r)}
              value={r.status}
            />
          ))}
        </div>
      </MobileSheet>
    </div>
  );
}

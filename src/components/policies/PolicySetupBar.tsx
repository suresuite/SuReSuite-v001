/**
 * Model setup bar for /policies — rows A (model version) and B (planning unit)
 * plus the 4-step guardrail track.
 *
 * Renders inside <ProjectPolicies> directly under <PageHeader>.
 *
 * Typography, radius, state colours and the stage cards come from the shared
 * process-rail rule set in components/sim/StageRail.tsx — this rail and the
 * Simulation Lab rail are the same object seen twice. Nothing visual is
 * redefined locally.
 */
import React from "react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  RAIL,
  RAIL_EYEBROW,
  RAIL_EYEBROW_ROW,
  RAIL_LABEL_COL,
  RAIL_SHELL,
  RAIL_STAGE_ROW,
  RailChevron,
  RailChip,
  RailCollapsedRow,
  RailMarker,
  RailReadout,
  RailStageCard,
  type RailState,
} from "@/components/sim/StageRail";
import {
  M,
  MobileActionBar,
  MobileChip,
  MobileGroup,
  MobilePanel,
  MobileRow,
  MobileSegmented,
} from "@/components/mobile";
import { PLANNING_UNIT_NOTE, isSelectableUnit } from "@/hooks/useTimeUnit";

export type StageId = "supplier" | "plant" | "customer" | "run_validate";
export type PlanningUnit = "day" | "week" | "month";

export interface StageGuard {
  id: StageId;
  title: string;
  /** lines in the stage (0 for run_validate) */
  total: number;
  /** lines still needing input; for run_validate, lines blocking the run */
  needs: number;
  /** run_validate only: evidence (reps + warm-up) is complete */
  evidence?: boolean;
}

// Rows A and B put a w-full label column (RAIL_LABEL_COL) beside shrink-0
// controls, so below md they stack; md: restores the desktop row exactly.
const ROW = "flex flex-col items-start gap-2 px-3 py-1.5 md:flex-row md:items-center md:gap-2.5";

/** 26px, 11.5px / 500, radius 4 — primary is ink, secondary is a white hairline. */
function RailButton({
  children,
  onClick,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-[26px] min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-sm px-2.5 text-[11.5px] font-medium leading-none transition-colors md:min-h-0 md:justify-start",
        variant === "primary" ? "text-white hover:opacity-90" : "border hover:bg-[#fafafa]",
      )}
      style={
        variant === "primary"
          ? { background: RAIL.ink }
          : { background: "#ffffff", borderColor: RAIL.rule, color: RAIL.ink }
      }
    >
      {children}
    </button>
  );
}

/** day / week / month — white, 1px #d4d4d4, 3px padding, mono 10.5px items.
 *  Only the selectable unit (week, for now) responds; see useTimeUnit. */
function UnitSegmented({
  value,
  onChange,
}: {
  value: PlanningUnit;
  onChange: (u: PlanningUnit) => void;
}) {
  return (
    <div
      className="flex w-full rounded-sm border bg-white p-[3px] md:inline-flex md:w-auto md:shrink-0"
      style={{ borderColor: RAIL.rule }}
    >
      {(["day", "week", "month"] as PlanningUnit[]).map((u) => {
        const on = u === value;
        // Day and month return with the unit rework; until then they are
        // visible but inert, so nobody reads the fixed week as a choice they
        // made by accident.
        const enabled = isSelectableUnit(u);
        return (
          <button
            key={u}
            type="button"
            disabled={!enabled}
            onClick={() => enabled && onChange(u)}
            title={enabled ? PLANNING_UNIT_NOTE : "Coming later — the planning unit is fixed to weeks for now"}
            className="min-h-11 flex-1 rounded-[2px] px-[7px] py-[2px] font-mono text-[10.5px] leading-normal transition-colors disabled:cursor-not-allowed md:min-h-0 md:flex-none"
            style={on ? { background: RAIL.ink, color: "#ffffff" } : { color: RAIL.muted, opacity: enabled ? 1 : 0.45 }}
          >
            {u}
          </button>
        );
      })}
    </div>
  );
}

export function PolicySetupBar({
  versionName,
  isSnapshot,
  versionStamp,
  versionCount,
  dirty,
  onSaveVersion,
  onOpenHistory,
  unit,
  onUnitChange,
  horizon,
  unitMap,
  stages,
  activeStage,
  onStageChange,
}: {
  versionName: string;
  isSnapshot: boolean;
  /** e.g. "Aug 3, 10:14 · m.langner" */
  versionStamp?: string;
  versionCount: number;
  dirty: boolean;
  onSaveVersion: () => void;
  onOpenHistory: () => void;
  unit: PlanningUnit;
  onUnitChange: (u: PlanningUnit) => void;
  /** e.g. "365 days · 52.1 weeks" */
  horizon: string;
  /** e.g. "Run week 0 = 6 Jan – 12 Jan 2025 (7 days each)" */
  unitMap: string;
  stages: StageGuard[];
  activeStage: StageId;
  onStageChange: (s: StageId) => void;
}) {
  const isMobile = useIsMobile();

  /** Which lettered section is expanded. Exactly one at a time. */
  type OpenSection = "A" | "B" | "C" | "D";
  const openSection: OpenSection = activeStage === "run_validate" ? "D" : "C";

  const setupStages = stages.filter((s) => s.id !== "run_validate");
  const blocking = setupStages.reduce((a, s) => a + s.needs, 0);
  const readyOf = (s: StageGuard) =>
    s.id === "run_validate" ? blocking === 0 && !!s.evidence : s.needs === 0;
  const readyCount = stages.filter(readyOf).length;
  const openStep = Math.max(
    1,
    stages.findIndex((s) => s.id === activeStage) + 1,
  );

  /** Same three states as the Simulation rail; only the active card is current. */
  const stateOf = (s: StageGuard): RailState =>
    s.id === activeStage ? "current" : readyOf(s) ? "done" : "todo";

  /** `value · value · value` — lowercase, mono, never a sentence. */
  const metaOf = (s: StageGuard) =>
    s.id === "run_validate"
      ? s.needs
        ? `${s.needs} line${s.needs === 1 ? "" : "s"} blocking`
        : s.evidence
          ? "evidence complete"
          : "4 steps"
      : s.needs
        ? `${s.total} lines · ${s.needs} need input`
        : `${s.total} lines resolved`;

  /** Section C collapsed — built from setupStages so it never drifts from the data. */
  const cSummary = (
    <>
      <span className="font-mono text-[11px] tabular-nums" style={{ color: RAIL.zinc.body }}>
        <b className="font-medium" style={{ color: RAIL.ink }}>
          {readyCount} / {stages.length}
        </b>{" "}
        ready
      </span>
      {setupStages.map((s) => (
        <React.Fragment key={s.id}>
          <span style={{ color: "#c8c8c8" }}>·</span>
          <span
            className="truncate font-mono text-[11px]"
            style={{ color: s.needs ? "#bf2330" : RAIL.muted }}
          >
            {s.title.toLowerCase()}
          </span>
        </React.Fragment>
      ))}
    </>
  );


  // ── Phone composition ────────────────────────────────────────────────────
  // The lettered A/B/C rail is desktop geometry: it puts a 192px label column
  // beside its controls and lays the four steps out as a horizontal strip, so
  // on a phone the strip scrolls out of the card and the steps are unreadable.
  // The prototype replaces it here with discrete cards and a VERTICAL step
  // list, which is what this branch renders.
  //
  // Structural, so `useIsMobile` rather than `md:` - the two trees do not share
  // a shape, and rendering both would mean two copies of every control in the
  // DOM. Every value below is the same derivation the desktop rail uses above
  // (stateOf, metaOf, readyCount); nothing is recomputed, so the two renderings
  // cannot disagree about what is ready.
  if (isMobile) {
    // Every container is the black-headed panel, and the screen's ONE primary
    // action is the pinned bar (§8) — so "Save model version" leaves the card
    // it used to share with History, and History becomes a row. Nothing else
    // moves: the same four steps, the same three planning units, the same
    // handlers, the same derived state as the desktop rail beside it.
    const stageDot = (state: RailState, needsSetup: boolean) =>
      needsSetup ? M.blocking : state === "done" ? M.process : state === "current" ? M.ink : M.idle;

    return (
      // Two bands: what the model IS (version, planning unit) and what there is
      // left to configure. The band label is the desktop rail's own eyebrow —
      // it names the group without spending a container on it (v2 §2), which is
      // what lets the ink head below be the only one on the screen.
      <div className="mb-3 flex flex-col gap-[var(--m-gap)]">
        <MobileGroup label="Model setup">
        <MobilePanel label="Model version" counter={isSnapshot ? "Snapshot" : "Live"}>
          <MobileRow
            chevron={false}
            dot={dirty ? M.firm : M.process}
            label={versionName}
            sub={versionStamp || undefined}
            value={dirty ? "unsaved" : "saved"}
          />
          <MobileRow
            label="Version history"
            sub="every saved model version"
            value={String(versionCount)}
            onClick={onOpenHistory}
          />
        </MobilePanel>

        <MobilePanel label="Planning unit" counter={unit}>
          <div className="p-3">
            <MobileSegmented<PlanningUnit>
              ariaLabel="Planning unit"
              value={unit}
              onChange={onUnitChange}
              // Only the selectable unit is offered on a phone: a tap that does
              // nothing is worse than a control that says what is fixed.
              items={(
                [
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ] as const
              ).filter((i) => isSelectableUnit(i.value))}
            />
          </div>
          <MobileRow chevron={false} label="Fixed to weeks" sub={PLANNING_UNIT_NOTE} />
          <MobileRow chevron={false} label="Horizon" value={horizon} />
          <MobileRow chevron={false} label="Unit mapping" sub={unitMap} />
        </MobilePanel>
        </MobileGroup>

        {/* The screen's one ink head (v2 §2): the stage list is what the user
            is here to act on, and what still needs setup. */}
        <MobilePanel
          tone="primary"
          label="Configure SC policies"
          counter={`${readyCount} / ${stages.length} ready`}
        >
          {stages.map((stage, i) => {
            const state = stateOf(stage);
            const needsSetup = stage.id !== "run_validate" && stage.needs > 0;
            return (
              <MobileRow
                key={stage.id}
                onClick={() => onStageChange(stage.id)}
                dot={stageDot(state, needsSetup)}
                leading={
                  <MobileChip
                    fill={state === "current" ? M.ink : undefined}
                    ink={state === "current" ? "#ffffff" : M.quiet}
                  >
                    {i + 1}
                  </MobileChip>
                }
                label={stage.title}
                sub={metaOf(stage)}
              />
            );
          })}
        </MobilePanel>

        <MobileActionBar primary={{ label: "Save model version", onClick: onSaveVersion }} />
      </div>
    );
  }

  return (
    <div className={cn(RAIL_SHELL, "mb-[14px]")}>
      {/* eyebrow */}
      <div className={RAIL_EYEBROW_ROW}>
        <span className={RAIL_EYEBROW}>Model setup</span>
        <span className="h-px flex-1" style={{ background: RAIL.rule }} />
        <RailReadout
          dot={RAIL.amber}
          label="step"
          value={`${openStep} open`}
          tail="— set A (B is fixed to weeks), then work steps 1–4"
        />
      </div>

      {/* A — model version */}
      <div className={cn(ROW, "border-b border-[#f0f0f0]")}>
        <span className={cn(RAIL_LABEL_COL, "flex items-center gap-[7px]")}>
          <RailMarker>A</RailMarker>
          <span className={RAIL_EYEBROW}>Model version</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
          <span className="whitespace-nowrap text-[11.5px] font-medium" style={{ color: RAIL.ink }}>
            {versionName}
          </span>
          <RailChip>{isSnapshot ? "Snapshot" : "Live"}</RailChip>
          {versionStamp && (
            <span className="whitespace-nowrap font-mono text-[11px]" style={{ color: RAIL.muted }}>
              {versionStamp}
            </span>
          )}
        </span>
        {dirty && (
          <span className="inline-flex min-w-0 items-center gap-1.5 md:shrink-0">
            <span className="h-[5px] w-[5px] rounded-full" style={{ background: RAIL.amber }} />
            <span className="font-mono text-[11px]" style={{ color: RAIL.amber }}>
              unsaved changes
            </span>
          </span>
        )}
        <div className="hidden flex-1 md:block" />
        <span className="flex w-full items-stretch gap-2 md:contents">
          <RailButton onClick={onSaveVersion}>Save model version</RailButton>
          <RailButton variant="secondary" onClick={onOpenHistory}>
            History
            <RailChip>{versionCount}</RailChip>
          </RailButton>
        </span>
      </div>

      {/* B — planning unit */}
      <div className={ROW}>
        <span className={cn(RAIL_LABEL_COL, "flex items-center gap-[7px]")}>
          <RailMarker>B</RailMarker>
          <span className={RAIL_EYEBROW}>Planning unit</span>
        </span>
        <UnitSegmented value={unit} onChange={onUnitChange} />
        <span className="font-mono text-[11px]" style={{ color: RAIL.muted }} title={PLANNING_UNIT_NOTE}>
          lead times in weeks
        </span>
        <div className="hidden flex-1 md:block" />
        <span className="flex min-w-0 flex-wrap items-center gap-2.5 md:shrink-0 md:flex-nowrap">
          <span className="whitespace-nowrap font-mono text-[11.5px]" style={{ color: RAIL.muted }}>
            Horizon{" "}
            <b className="font-medium" style={{ color: RAIL.ink }}>
              {horizon}
            </b>
          </span>
          <span style={{ color: RAIL.rule }}>·</span>
          <span className="whitespace-nowrap font-mono text-[11.5px]" style={{ color: RAIL.muted }}>
            <b className="font-medium" style={{ color: RAIL.ink }}>
              {unitMap}
            </b>
          </span>
        </span>
      </div>

      {/* C — configure SC policies */}
      {openSection === "C" ? (
        <div className={cn(RAIL_STAGE_ROW, "flex-col border-t border-[#ebebeb] gap-[18px] md:flex-row")}>
          <div className="flex w-full min-w-0 flex-col justify-center gap-[3px] pb-2 md:w-[192px] md:shrink-0 md:pb-0 md:pr-2.5">
            <span className="flex items-center gap-[7px]">
              <RailMarker>C</RailMarker>
              <span className={RAIL_EYEBROW}>Configure SC policies</span>
            </span>
            {/* indented past the marker so it aligns with the eyebrow text */}
            <span className="font-mono text-[11px] tabular-nums" style={{ paddingLeft: 23 }}>
              <b className="font-medium" style={{ color: RAIL.ink }}>
                {readyCount}
              </b>
              <span style={{ color: RAIL.muted }}> / {stages.length} ready</span>
            </span>
          </div>

          <div className="flex min-w-0 flex-1 items-stretch gap-[10px]">
            {stages.map((stage, i) => (
              <React.Fragment key={stage.id}>
                {i > 0 ? <RailChevron /> : null}
                <RailStageCard
                  state={stateOf(stage)}
                  numeral={String(i + 1)}
                  label={stage.title}
                  sub={metaOf(stage)}
                  onSelect={() => onStageChange(stage.id)}
                  needsSetup={stage.id !== "run_validate" && stage.needs > 0}
                  title={
                    stage.id === "run_validate"
                      ? stage.needs
                        ? `Resolve ${stage.needs} line(s) in steps 1–3 before the run is credible`
                        : "Verification · Run simulation · Warm-up detection · Validation"
                      : stage.needs
                        ? `${stage.needs} line(s) still need input in this step`
                        : `All ${stage.total} lines resolved`
                  }
                  trailing={
                    stage.id === "run_validate" && stage.needs > 0 && stage.id !== activeStage ? (
                      <RailChip>LOCKED</RailChip>
                    ) : null
                  }
                />
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : (
        <RailCollapsedRow
          letter="C"
          label="Configure SC policies"
          summary={cSummary}
          last
          onExpand={() => onStageChange(setupStages[0].id)}
        />
      )}
    </div>
  );
}

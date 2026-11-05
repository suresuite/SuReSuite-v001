import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { disruptionWeeks } from "@/lib/sim/runWindow";
import { AUTO_WARMUP_RULE, warmupNote } from "@/lib/sim/disruptionTiming";
import { engineWeeks, isWholeWeeks } from "@/lib/sim/planningTime";
import {
  DISRUPTION_RULE,
  DISRUPTION_TERMS,
  addBlockedReason,
  describeEvent,
  effectMeaning,
  isLeadTimeDelay,
  isMaterialTarget,
  judgeTarget,
  MATERIAL_EVENT_NOTE,
  newEvent,
  targetChoices,
  type ScheduleEvent,
} from "@/lib/sim/disruptionEvents";
import type { Scenario } from "@/hooks/useScenarios";
import { withStart } from "@/lib/sim/startAnchor";
import { useProjectCalendar } from "@/hooks/useProjectCalendar";
import { demandAnchorNote } from "@/lib/sim/calendarWeeks";
import {
  AnchorDriftNote,
  CapacityLostStepper,
  EffectControl,
  FIELD_H,
  Field,
  StartTimeControl,
  TargetSelect,
  WeeksStepper,
  durationHint,
  hintOf,
  startHint,
} from "./DisruptionFields";

interface Props {
  value: Scenario["disruption_schedule"];
  onChange: (next: Scenario["disruption_schedule"]) => void;
  projectId?: string | null;
  /** The scenario's warm-up, so a new disruption starts where KPIs are measured
   *  and a row inside the warm-up says what the engine will do (audit F-03). */
  warmup?: { days: number; mode: string; horizonDays: number };
  /** The project's supplier ids — the targets the engine can disrupt besides the plant. */
  supplierIds?: string[];
  /** Suppliers with no finite weekly capacity: a partial cut on one runs as an outage. */
  uncapacitated?: string[];
  /** Materials with a supply link — targets since engine 0.9.0 (PLAN.md §29 WP 19.2). */
  materialIds?: string[];
  /** Overrides `projects.simulation_start` — run week 0, the anchor for a start
   *  entered as an ISO week or a date (PLAN.md §4 D318). Read from the project
   *  calendar when omitted. */
  projectStart?: string | null;
}

/**
 * The Lab's disruption schedule, authored as the engine runs it (WP 9.4 slice 6).
 *
 * A target is PICKED from what the engine can disrupt — the plant or one of the
 * project's suppliers (`_map_events`' own test) — rather than typed as free text
 * the mapper would then skip. Start and duration are whole weeks. The effect is
 * a lead-time delay or a capacity reduction BY a share, which is what `magnitude_pct`
 * means to the engine; every label is `DISRUPTION_TERMS`. "Add" stops at the engine's event cap and says why. The network pages'
 * dialog builds its event with the same module, so both doors write one shape.
 */
export function DisruptionScheduleEditor({
  value,
  onChange,
  projectId,
  warmup,
  supplierIds = [],
  uncapacitated = [],
  materialIds = [],
  projectStart: projectStartProp,
}: Props) {
  const calendar = useProjectCalendar(projectId);
  const projectStart = projectStartProp !== undefined ? projectStartProp : calendar.projectStart;
  const demandNote = demandAnchorNote(projectStart, calendar.demandStart);
  const [local, setLocal] = useState<ScheduleEvent[]>(value);
  useEffect(() => setLocal(value), [value]);

  const commit = (next: ScheduleEvent[]) => {
    setLocal(next);
    onChange(next);
  };
  const patchNow = (i: number, fields: Partial<ScheduleEvent>) => {
    const next = [...local];
    next[i] = { ...next[i], target_type: "node", ...fields };
    commit(next);
  };

  const replaceAt = (i: number, ev: ScheduleEvent) => {
    const next = [...local];
    next[i] = ev;
    commit(next);
  };

  const horizonWeeks = warmup?.horizonDays ? engineWeeks(warmup.horizonDays) : undefined;
  const blocked = addBlockedReason(local);
  const choices = targetChoices(supplierIds, materialIds);
  const add = () => {
    if (blocked) return;
    commit([...local, newEvent(choices[0]?.value ?? "", warmup?.days)]);
  };

  return (
    <div className="flex flex-col gap-2">
      {local.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No disruption events — this scenario runs undisrupted.
        </p>
      )}
      {local.length > 0 && demandNote ? (
        <p className="text-[11.5px] text-[--warn-ink,#92400e]">{demandNote}</p>
      ) : null}
      {local.length > 0 && warmup && String(warmup.mode).toLowerCase() !== "manual" && (
        <p className="text-[10px] text-muted-foreground">{AUTO_WARMUP_RULE}</p>
      )}
      {local.map((d, i) => {
        const { target, reason } = judgeTarget(d.target, supplierIds, materialIds);
        const isMaterial = target.kind === "material";
        const outageOnly =
          !isLeadTimeDelay(d.magnitude_pct) && target.kind === "supplier" && uncapacitated.includes(target.id);
        return (
          <div key={i} className="overflow-hidden rounded-sm border border-black bg-sky-50/40">
            <div className="flex items-center gap-2 border-b border-black/20 bg-sky-100/70 px-3 py-1">
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                Event {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground" title={describeEvent(d)}>
                {describeEvent(d)}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove event ${i + 1}`}
                title="Remove this event"
                className="h-11 w-11 shrink-0 text-destructive md:h-9 md:w-9"
                onClick={() => commit(local.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex flex-col gap-3 p-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label={DISRUPTION_TERMS.target}>
                  <TargetSelect
                    value={d.target}
                    choices={choices}
                    onChange={(v) =>
                      // A material event is the full outage of its supply (the engine's rule).
                      patchNow(i, isMaterialTarget(v) ? { target: v, magnitude_pct: DISRUPTION_RULE.full_outage_pct } : { target: v })
                    }
                  />
                </Field>
                <Field
                  label={DISRUPTION_TERMS.effect}
                  hint={isLeadTimeDelay(d.magnitude_pct) ? effectMeaning(d.magnitude_pct) : undefined}
                >
                  <EffectControl
                    value={d.magnitude_pct}
                    outageOnly={isMaterial}
                    onChange={(v) => patchNow(i, { magnitude_pct: v })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Field label={DISRUPTION_TERMS.startTime} hint={startHint(horizonWeeks)} className="col-span-2 md:col-span-1">
                  <StartTimeControl
                    event={d}
                    projectStart={projectStart}
                    horizonWeeks={horizonWeeks}
                    onChange={(day, anchor) => replaceAt(i, withStart({ ...d, target_type: "node" }, day, anchor))}
                  />
                </Field>
                <Field label={DISRUPTION_TERMS.duration} {...hintOf(durationHint(d.start_day, d.duration_days, horizonWeeks))}>
                  <WeeksStepper
                    ariaLabel="Disruption event duration"
                    days={d.duration_days}
                    min={DISRUPTION_RULE.duration_weeks_min}
                    max={DISRUPTION_RULE.duration_weeks_max}
                    onDays={(v) => patchNow(i, { duration_days: v })}
                  />
                </Field>
                {!isLeadTimeDelay(d.magnitude_pct) ? (
                  <Field label="Capacity lost" hint={effectMeaning(d.magnitude_pct)} className="col-span-2 md:col-span-1">
                    <CapacityLostStepper value={d.magnitude_pct} onChange={(v) => patchNow(i, { magnitude_pct: v })} />
                  </Field>
                ) : null}
              </div>
              {/* The header already states the engine's weeks; the line returns
                  only when it has a caveat to add (days collapsing, warm-up). */}
              {!isWholeWeeks(d.start_day) || !isWholeWeeks(d.duration_days) ||
              warmupNote(disruptionWeeks(d.start_day, d.duration_days).startWeek, warmup) ? (
                <EngineTicks startDay={d.start_day} durationDays={d.duration_days} warmup={warmup} />
              ) : null}
              <AnchorDriftNote
                event={d}
                projectStart={projectStart}
                horizonWeeks={horizonWeeks}
                onChange={(ev) => replaceAt(i, ev)}
              />
              {reason ? (
                <p className="text-[11.5px] text-[#b3261e]">{reason}</p>
              ) : isMaterial ? (
                <p className="text-[11.5px] text-muted-foreground">
                  {MATERIAL_EVENT_NOTE}
                  {!isLeadTimeDelay(d.magnitude_pct) ? " A capacity reduction on a material runs as this outage." : ""}
                </p>
              ) : outageOnly ? (
                <p className="text-[11.5px] text-[--warn-ink,#92400e]">
                  This supplier has no weekly capacity, so the engine runs a capacity reduction as a lead-time delay.
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className={cn(FIELD_H, "gap-1.5 px-4")}
          onClick={add}
          disabled={!!blocked}
          title={blocked ?? undefined}
        >
          <Plus className="h-3.5 w-3.5" /> Add disruption event
        </Button>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">
          {local.length} of {DISRUPTION_RULE.event_cap} events
        </span>
      </div>
      {blocked ? <p className="text-[10px] text-muted-foreground">{blocked}</p> : null}
    </div>
  );
}

/** What the engine will run for this row (audit F-22). Days are stored; the
 *  engine advances in weekly ticks, so a 3-day and a 10-day disruption are the
 *  same one-week event. The translation comes from the engine's exported rule. */
export function EngineTicks({ startDay, durationDays, warmup }: {
  startDay: number; durationDays: number; warmup?: { days: number; mode: string; horizonDays: number };
}) {
  const { startWeek, durationWeeks } = disruptionWeeks(startDay, durationDays);
  const collapsed = startDay % 7 !== 0 || durationDays !== durationWeeks * 7;
  const note = warmupNote(startWeek, warmup);
  return (
    <p className="text-[11.5px] text-muted-foreground">
      Simulated from week {startWeek} for {durationWeeks} wk
      {collapsed ? " — stored in days; the engine advances in weekly ticks" : ""}
      {note ? <span className="block text-[--warn-ink,#92400e]">{note}</span> : null}
    </p>
  );
}

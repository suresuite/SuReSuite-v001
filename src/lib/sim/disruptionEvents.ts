/**
 * One disruption-event model for every surface that writes one (WP 9.4 slice 6).
 *
 * The Lab's event editor and the network pages' disruption dialog both build
 * `scenarios.disruption_schedule` rows here, and both judge a target by the
 * engine's own rule (`engineTargetOf`, shared with the sim-command gate). The
 * numbers — the cap, the week bounds, the target kinds — are the mapper's,
 * exported as `registry.disruption`; none is restated in `src/` (§4 D226).
 *
 * Rows stay in DAYS (`start_day`, `duration_days`): that is the stored shape the
 * engine, the gate and every existing scenario read. What changes is that every
 * surface authors them in whole engine weeks.
 */
import registry from "@/lib/policies/registry.generated.json";
import type { Scenario } from "@/hooks/useScenarios";
import {
  engineTargetOf,
  engineTargetReason,
  type DisruptionRule,
  type EngineTarget,
} from "../../../supabase/functions/_shared/disruptionRules";
import { defaultDisruptionStartDay } from "./disruptionTiming";
import { DAYS_PER_WEEK } from "./planningTime";
import { disruptionWeeks } from "./runWindow";

export type ScheduleEvent = Scenario["disruption_schedule"][number];

/** The mapper's event rule, as exported. */
export const DISRUPTION_RULE = (registry as unknown as { disruption: DisruptionRule }).disruption;

/** How a target is written: the plant, or `supplier:<id>`. */
export const PLANT_TARGET = "node:plant";
export const supplierTarget = (id: string) => `supplier:${id}`;
/** A material, as the mapper reads it (engine 0.9.0, PLAN.md §29 WP 19.1). */
export const materialTarget = (id: string) => `material:${id}`;

/** A new event: a lead-time delay at `target`, four weeks long, starting four
 *  measured weeks after the warm-up (audit F-03's default). */
export function newEvent(target = "", warmupDays?: number): ScheduleEvent {
  return {
    target,
    target_type: "node",
    start_day: defaultDisruptionStartDay(warmupDays),
    duration_days: 4 * DAYS_PER_WEEK,
    magnitude_pct: DISRUPTION_RULE.full_outage_pct,
  };
}

/** What the engine will do with this target. */
export function judgeTarget(
  target: string,
  supplierIds: readonly string[],
  /** materials with a supply link — the ones a material event can stop */
  materialIds: readonly string[] = [],
): {
  target: EngineTarget;
  reason: string | null;
} {
  const t = engineTargetOf(target, supplierIds, DISRUPTION_RULE, materialIds);
  return { target: t, reason: engineTargetReason(t) };
}

/** Why no further event can be added, or null. */
export function addBlockedReason(schedule: readonly unknown[]): string | null {
  return schedule.length >= DISRUPTION_RULE.event_cap
    ? `The engine runs at most ${DISRUPTION_RULE.event_cap} events per scenario.`
    : null;
}

/**
 * The words every disruption surface uses, so the network pages' dialog, the
 * Lab's schedule editor, the stress presets and the phone sheet cannot name one
 * thing three ways. The terms are the product owner's, and they map one to one
 * onto the engine's model (`scsim/scsim/entities/disruption.py`): a disruption
 * event hits a node with one of two effects — a LEAD-TIME DELAY (`magnitude_pct`
 * at 100, the engine's `lead_time_extension`) or a CAPACITY REDUCTION by a share
 * (below 100, `capacity_reduction`) — from its START TIME for a DURATION, both
 * counted in simulation weeks. A scenario's events are its disruption schedule.
 */
export const DISRUPTION_TERMS = {
  event: "Disruption event",
  schedule: "Disruption schedule",
  target: "Disrupted node",
  effect: "Effect",
  leadTimeDelay: "Lead-time delay",
  capacityReduction: "Capacity reduction",
  startTime: "Disruption event start time",
  duration: "Disruption event duration",
} as const;

/** The engine's reading of `magnitude_pct`: at or above the threshold the event
 *  delays the node's lead time; below it, capacity is reduced BY that share. */
export function isLeadTimeDelay(magnitudePct: number): boolean {
  return magnitudePct >= DISRUPTION_RULE.full_outage_pct;
}

/** "Lead-time delay" or "Capacity reduction 30%". */
export function effectLabel(magnitudePct: number): string {
  return isLeadTimeDelay(magnitudePct)
    ? DISRUPTION_TERMS.leadTimeDelay
    : `${DISRUPTION_TERMS.capacityReduction} ${magnitudePct}%`;
}

/** What the effect does to the node, in one sentence. */
export function effectMeaning(magnitudePct: number): string {
  return isLeadTimeDelay(magnitudePct)
    ? "Deliveries from the node are delayed until the event ends."
    : `${100 - magnitudePct}% of the node's weekly capacity remains.`;
}

/** A target as a person reads it: "Plant", "Supplier S-104", or the raw value. */
export function targetLabel(target: string): string {
  if (!target) return "No node";
  if (target === PLANT_TARGET) return "Plant";
  if (target.startsWith("supplier:")) return `Supplier ${target.slice("supplier:".length)}`;
  if (target.startsWith("material:")) return `Material ${target.slice("material:".length)}`;
  return target;
}

/** The simulation weeks an event covers, as the engine rounds them: "weeks 19–22". */
export function eventWindow(startDay: number, durationDays: number): string {
  const { startWeek, durationWeeks } = disruptionWeeks(startDay, durationDays);
  return durationWeeks <= 1
    ? `week ${startWeek}`
    : `weeks ${startWeek}–${startWeek + durationWeeks - 1}`;
}

/** One line per event: "Lead-time delay · Supplier S-104 · weeks 19–22". */
export function describeEvent(e: Pick<ScheduleEvent, "target" | "start_day" | "duration_days" | "magnitude_pct">): string {
  return `${effectLabel(e.magnitude_pct)} · ${targetLabel(e.target)} · ${eventWindow(e.start_day, e.duration_days)}`;
}

/** Target choices the engine can disrupt, grouped: the plant, the project's
 *  suppliers, then the materials they supply. */
export function targetChoices(
  supplierIds: readonly string[],
  materialIds: readonly string[] = [],
): { value: string; label: string; group: "Plant" | "Suppliers" | "Materials" }[] {
  return [
    { value: PLANT_TARGET, label: "Plant", group: "Plant" },
    ...[...supplierIds].sort().map((id) => ({ value: supplierTarget(id), label: id, group: "Suppliers" as const })),
    ...[...new Set(materialIds)].sort().map((id) => ({ value: materialTarget(id), label: id, group: "Materials" as const })),
  ];
}

/** The materials an event can stop: those with a supply link, i.e. named on an
 *  inbound lane (the mapper's `mat_ids`). */
export function suppliedMaterialIds(inbound: readonly { material_id?: unknown }[] | null | undefined): string[] {
  return [...new Set((inbound ?? []).map((r) => String(r.material_id ?? "").trim()).filter(Boolean))].sort();
}

/** What a material event does, in one sentence (engine 0.9.0). */
export const MATERIAL_EVENT_NOTE =
  "Every supply of this material stops for the event's weeks; its suppliers keep shipping their other materials.";

/** A material event is always the full outage of its supply (the engine's rule). */
export function isMaterialTarget(target: string): boolean {
  return target.toLowerCase().startsWith("material:");
}

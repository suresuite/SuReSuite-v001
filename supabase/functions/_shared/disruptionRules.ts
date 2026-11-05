// The disruption-event rule, read from the engine and graded ONCE (WP 9.4 slice 6).
//
// `scsim/scsim/io/project_map.py::_map_events` is the only place a schedule becomes
// engine events. It keeps at most `event_cap` events, disrupts a supplier id of the
// project or the plant and skips every other target with a warning, rounds start and
// duration to weeks, and reads `magnitude_pct < 100` as a capacity cut BY that share.
// None of that was visible before a run: the Lab's editor offered free-text targets,
// the network pages offered any node, and the first a user heard of a skipped event
// was a mapping warning after the run had spent its compute.
//
// The numbers come from `registry.generated.json`'s `disruption` block — exported by
// `registry_export.disruption_rule()`, never restated here — and the caller passes
// that block in, so this module stays dependency-free and runs unchanged in Deno
// (`validationGate.ts`, the sim-command gate) and in the browser
// (`validationService.compileGateFindings`, the Lab's pre-run check, the event editor
// and the network pages' dialog). One rule, one wording, both sides of the dispatch.
//
// `engineTargetOf` mirrors the mapper's rule for ONE target. It is not a node-type
// classifier (oneClassifier.test.ts): it answers only "will the engine keep this
// event", by the engine's own test — a supplier id in the project, the plant, or
// (engine 0.9.0, PLAN.md §29 WP 19.1) `material:<id>` for a material with a supply
// link, which the engine runs as the full outage of that material's supply.

import { num, type GradedFinding, type Row } from "./grading.ts";

/** The `disruption` block of registry.generated.json. */
export interface DisruptionRule {
  event_cap: number;
  start_week_min: number;
  duration_weeks_min: number;
  duration_weeks_max: number;
  supported_target_kinds: string[];
  unsupported_target_kinds: string[];
  full_outage_pct: number;
  partial_cut_needs_finite_supplier_capacity: boolean;
  /** Engine 0.9.0: a magnitude below 100 on a material runs as its full outage. */
  material_cut_runs_as_outage?: boolean;
}

export type EngineTarget =
  | { kind: "supplier"; id: string }
  | { kind: "plant"; id: "plant" }
  | { kind: "material"; id: string }
  | { kind: "unsupported"; id: string; targetKind: string }
  | { kind: "unknown"; id: string; material?: true };

/** `_is_plant_target`: `plant:X`, `node:plant`, or bare `plant`. */
function isPlantTarget(raw: string, stripped: string): boolean {
  return raw.toLowerCase().startsWith("plant:") || stripped.toLowerCase() === "plant";
}

const asSet = (v: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> =>
  v instanceof Set ? v : new Set((v ?? []) as readonly string[]);

/** What `_map_events` does with one target, by the engine's own test. `materialIds`
 *  are the materials with a supply link (the mapper's `mat_ids`). */
export function engineTargetOf(
  rawTarget: string,
  supplierIds: ReadonlySet<string> | readonly string[],
  rule: Pick<DisruptionRule, "unsupported_target_kinds">,
  materialIds?: ReadonlySet<string> | readonly string[],
): EngineTarget {
  const ids = asSet(supplierIds);
  const raw = String(rawTarget ?? "");
  const id = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  // The mapper reads the `material:` prefix before anything else.
  if (raw.includes(":") && raw.split(":", 1)[0].toLowerCase() === "material") {
    return asSet(materialIds).has(id) ? { kind: "material", id } : { kind: "unknown", id, material: true };
  }
  if (ids.has(id)) return { kind: "supplier", id };
  if (isPlantTarget(raw, id)) return { kind: "plant", id: "plant" };
  const prefix = raw.includes(":") ? raw.split(":", 1)[0].toLowerCase() : "";
  if (rule.unsupported_target_kinds.includes(prefix)) return { kind: "unsupported", id, targetKind: prefix };
  return { kind: "unknown", id };
}

/** One sentence for why an event will not reach the engine, or null when it will. */
export function engineTargetReason(t: EngineTarget): string | null {
  if (t.kind === "unsupported") return `The engine cannot disrupt ${t.targetKind} targets yet — this event is skipped.`;
  if (t.kind === "unknown") {
    if (t.material) {
      return t.id
        ? `No supplied material named "${t.id}" in this project's data — this event is skipped.`
        : "No material — this event is skipped.";
    }
    return t.id
      ? `No supplier or plant named "${t.id}" in this project's data — this event is skipped.`
      : "No target — this event is skipped.";
  }
  return null;
}

/**
 * Every finding a schedule earns before dispatch: events past the cap, targets the
 * engine skips, and partial cuts on a supplier with no finite capacity (moved here
 * from `grading.scenarioCapacityFindings`, and reworded: the engine cuts BY the
 * share, `capacity_factor = (100 − magnitude) / 100` — §4 D223).
 */
export function scheduleFindings(
  suppliers: Row[],
  schedule: Row[],
  rule: DisruptionRule,
  /** inbound lanes — their `material_id`s are the materials an event can stop */
  inbound: Row[] = [],
): GradedFinding[] {
  const events = schedule ?? [];
  const out: GradedFinding[] = [];
  const capBySupplier = new Map(
    (suppliers ?? []).map((s) => [String(s.supplier_id ?? ""), num(s.capacity_per_week)]),
  );
  const ids = new Set([...capBySupplier.keys()].filter(Boolean));
  const materialIds = new Set((inbound ?? []).map((r) => String(r.material_id ?? "")).filter(Boolean));

  if (events.length > rule.event_cap) {
    out.push({
      severity: "warn",
      field: "scenarios.disruption_schedule",
      policy: "engine",
      rows: [],
      message:
        `The scenario has ${events.length} disruption events; the engine runs the first ` +
        `${rule.event_cap} and drops ${events.length - rule.event_cap}.`,
      reason: `The mapper keeps at most ${rule.event_cap} events per scenario.`,
    });
  }

  events.slice(0, rule.event_cap).forEach((ev) => {
    const raw = String(ev.target ?? ev.target_id ?? "");
    const t = engineTargetOf(raw, ids, rule, materialIds);
    const why = engineTargetReason(t);
    if (why) {
      out.push({
        severity: "warn",
        field: "scenarios.disruption_schedule",
        policy: "engine",
        rows: [raw],
        message: `Disruption on "${raw || "(no target)"}": ${why}`,
        reason:
          "The engine disrupts a supplier of this project, a material it is supplied with, or the plant; " +
          "every other target is skipped with a mapping warning.",
      });
      return;
    }
    const magnitude = num(ev.magnitude_pct ?? ev.magnitude ?? rule.full_outage_pct);
    if (t.kind === "material" && magnitude < rule.full_outage_pct && rule.material_cut_runs_as_outage) {
      out.push({
        severity: "warn",
        field: "scenarios.disruption_schedule",
        policy: "engine",
        rows: [raw],
        message:
          `Capacity reduction by ${magnitude}% on material "${t.id}": the engine runs a material ` +
          `event as the full outage of its supply.`,
        reason: "The engine cuts capacity per supplier, not per material; a material event stops every supply of it.",
      });
      return;
    }
    if (
      t.kind === "supplier" &&
      rule.partial_cut_needs_finite_supplier_capacity &&
      magnitude < rule.full_outage_pct &&
      (capBySupplier.get(t.id) ?? 0) <= 0
    ) {
      out.push({
        severity: "warn",
        field: "suppliers.capacity_per_week",
        policy: "engine",
        rows: [t.id],
        message:
          `Capacity reduction by ${magnitude}% on supplier "${t.id}": the supplier has no ` +
          `weekly capacity (capacity_per_week), so the engine runs this event as a lead-time delay.`,
        reason:
          "A capacity reduction throttles a finite weekly capacity; without one the mapper " +
          "runs the event as a lead-time delay.",
      });
    }
  });
  return out;
}

/**
 * What an `experiment_spec` proposal card shows and asks (ai-agents.md §5.4,
 * §20.8). Pure, read straight from the stored payload — never recomputed.
 *
 * Why it exists: the card rendered `payload.rows`, which an experiment spec
 * does not have, so it showed an empty table. Worse, it never displayed
 * `payload.findings_preview`, and `agent-apply` honors the reviewer's
 * acknowledgment ONLY when the card displayed the warn findings
 * (`experimentSpecApply.ts`). So a spec with even one pre-run warning could
 * not be dispatched from the chat: Approve and Retry both ended in
 * `gate_blocked: … (ack_required)`.
 */
import type { ProposalRow } from "@/components/chat/ProposalCardView";

export const EXPERIMENT_SPEC = "experiment_spec";

export interface GateFinding {
  severity: "block" | "warn" | string;
  field: string;
  message: string;
}

export interface SpecGate {
  /** block + warn findings, in stored order (info rows are not gating). */
  findings: GateFinding[];
  /** At least one warning and no block: the reviewer must acknowledge. */
  ackRequired: boolean;
  /** A block finding: the dispatcher refuses whatever the reviewer ticks. */
  blocked: boolean;
}

export function specGate(payload: Record<string, unknown> | undefined): SpecGate {
  const raw = Array.isArray(payload?.findings_preview) ? (payload!.findings_preview as unknown[]) : [];
  const findings = raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({ severity: String(f.severity ?? ""), field: String(f.field ?? ""), message: String(f.message ?? "") }))
    .filter((f) => f.severity === "warn" || f.severity === "block");
  const blocked = findings.some((f) => f.severity === "block");
  return { findings, ackRequired: !blocked && findings.some((f) => f.severity === "warn"), blocked };
}

function weeks(days: unknown): number | null {
  const n = Number(days);
  return Number.isFinite(n) ? Math.round(n / 7) : null;
}

/** "supplier:S001" → "supplier S001"; "node:plant" → "the plant". */
function targetLabel(t: unknown): string {
  const s = String(t ?? "");
  if (s === "node:plant" || s === "plant") return "the plant";
  return s.includes(":") ? `${s.slice(0, s.indexOf(":"))} ${s.slice(s.indexOf(":") + 1)}` : s;
}

function eventText(e: Record<string, unknown>): string {
  const start = weeks(e.start_day);
  const dur = weeks(e.duration_days);
  const mag = Number(e.magnitude_pct ?? 100);
  const effect = mag >= 100 ? "outage (lead-time delay)" : `${mag}% capacity reduction`;
  const window = start !== null && dur !== null
    ? dur <= 1 ? `week ${start}` : `weeks ${start}–${start + dur - 1}`
    : "";
  return [targetLabel(e.target), effect, window].filter(Boolean).join(", ");
}

/** The spec as the card's [table/entity/field/value/source] rows. */
export function experimentSpecRows(payload: Record<string, unknown> | undefined): ProposalRow[] {
  if (!payload) return [];
  const rows: ProposalRow[] = [];
  // §27: FIRST, what kind of result this run is — it follows a Validated
  // Model (with its protocol and any deviation), or it is exploratory.
  const modelName = typeof payload.model_name === "string" ? payload.model_name : null;
  if (payload.validated_model_id) {
    rows.push({ table: "model", entity: modelName ?? String(payload.validated_model_id).slice(0, 8), field: "follows", value: "Validated Model", source: "validated" });
    const p = payload.protocol && typeof payload.protocol === "object" ? (payload.protocol as Record<string, unknown>) : null;
    if (p) {
      const parts = [
        p.replications != null ? `${p.replications} replications` : null,
        p.horizon_weeks != null ? `${p.horizon_weeks} weeks` : null,
        p.warmup_week != null ? `measured from week ${Number(p.warmup_week) + 1}` : null,
        p.root_seed != null ? `seed ${p.root_seed}` : null,
        p.crn === true ? "common random numbers" : null,
      ].filter(Boolean);
      if (parts.length) rows.push({ table: "model", entity: modelName ?? "—", field: "protocol", value: parts.join(" · "), source: "validated" });
    }
    const devs = Array.isArray(payload.deviations) ? (payload.deviations as Array<Record<string, unknown>>) : [];
    for (const d of devs) {
      rows.push({
        table: "model",
        entity: String(d.label ?? d.key ?? ""),
        field: "DEVIATION",
        value: `model ${String(d.model)} → this run ${String(d.run)}`,
        source: "your request",
      });
    }
  } else if (payload.run_mode === "exploratory") {
    rows.push({ table: "model", entity: "—", field: "EXPLORATORY", value: "follows no Validated Model — not a validated result", source: "your request" });
  }
  const ns = payload.new_scenario && typeof payload.new_scenario === "object"
    ? (payload.new_scenario as Record<string, unknown>)
    : null;
  const scenarioName = ns ? String(ns.name ?? "") : String(payload.scenario_name ?? payload.scenario_id ?? "");
  const source = ns ? "new scenario" : "existing scenario";
  // §26 M.2: a comparison card lists its arms; the FIRST is the reference.
  const arms = Array.isArray(payload.arms) ? (payload.arms as Array<Record<string, unknown>>) : null;
  if (payload.experiment_type === "comparison" && ns && arms) {
    const baseEvents = Array.isArray(ns.disruption_schedule) ? (ns.disruption_schedule as Array<Record<string, unknown>>) : [];
    arms.forEach((a, i) => {
      const events = Array.isArray(a.disruption_schedule) ? (a.disruption_schedule as Array<Record<string, unknown>>) : baseEvents;
      const overrides = a.recovery_overrides && typeof a.recovery_overrides === "object" ? Object.keys(a.recovery_overrides as object) : [];
      rows.push({
        table: "scenarios",
        entity: String(a.label ?? `arm ${i + 1}`),
        field: i === 0 ? "reference arm" : `arm ${i + 1}`,
        value: [events.map((e) => eventText(e ?? {})).join("; ") || "no disruption", overrides.length ? "with recovery response" : "no recovery response"].join(" · "),
        source: "comparison",
      });
    });
    const h = weeks(ns.horizon_days);
    if (h !== null) rows.push({ table: "scenarios", entity: scenarioName, field: "simulated length", value: `${h} weeks`, source });
  } else if (ns) {
    const events = Array.isArray(ns.disruption_schedule) ? (ns.disruption_schedule as Array<Record<string, unknown>>) : [];
    if (events.length === 0) {
      rows.push({ table: "scenarios", entity: scenarioName, field: "disruption", value: "none", source });
    }
    for (const e of events) {
      rows.push({ table: "scenarios", entity: scenarioName, field: "disruption", value: eventText(e ?? {}), source });
    }
    const h = weeks(ns.horizon_days);
    if (h !== null) rows.push({ table: "scenarios", entity: scenarioName, field: "simulated length", value: `${h} weeks`, source });
  } else if (scenarioName) {
    rows.push({ table: "scenarios", entity: scenarioName, field: "scenario", value: "re-run as stored", source });
  }
  if (payload.policy_version_id) {
    rows.push({
      table: "policy_versions",
      entity: String(payload.policy_version_label ?? String(payload.policy_version_id).slice(0, 8)),
      field: "policy version",
      value: payload.newer_version_exists === true ? "bound (a newer version exists)" : "bound",
      source: "saved version",
    });
  }
  if (payload.replications != null) {
    const n = Number(payload.replications);
    const value = arms && payload.experiment_type === "comparison"
      ? `${n} per arm × ${arms.length} arms = ${n * arms.length} (same random numbers in every arm)`
      : String(payload.replications);
    rows.push({ table: "simulation_runs", entity: "—", field: "replications", value, source: "spec" });
  }
  return rows;
}

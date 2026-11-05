// Unified validation service — Phase A / G6 / §8.1–8.2.
//
// UI adapter over the ONE grading module shared with the edge pre-dispatch
// gate (supabase/functions/_shared/grading.ts — canonical there because
// Supabase bundles only that tree). Manifest compilation, fallback
// resolution (registry `fallback_spec` → named reducers), and the
// engine-mirroring severity law all live in that module, so the /policies
// verification stage and the sim-command gate grade IDENTICALLY — the
// validation-parity fixtures pin all three surfaces to the engine.
//
// This file only adapts: raw hook rows → GradingDataset, GradedField[] →
// per-row UI findings with stages and hints.

import bridge from "../../../supabase/functions/_shared/engineBridge.json";
import registry from "./registry.generated.json";
import {
  activeEnginePolicies as sharedActivePolicies,
  flattenFindings,
  gradeManifest,
  type BridgeTables,
  type GradedField,
  type GradedFinding,
  type GradingDataset,
  type RegistryPayload,
  type Row,
} from "../../../supabase/functions/_shared/grading.ts";
import {
  scheduleFindings,
  type DisruptionRule,
} from "../../../supabase/functions/_shared/disruptionRules.ts";
import { baseDataRequirements, policyCatalog } from "./registryAccess";
import { findingFieldLabel } from "./columnSpecs";
import type { PolicyBundle } from "./schemas";
import type { StageKey } from "./stages";

export type Severity = "block" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  stage: StageKey;
  rowKey?: string;
  field?: string;
  message: string;
  hint?: string;
  /** Catalog ref of the policy demanding the datum ("engine" for base reqs). */
  policy?: string;
  /** Affected entity ids (aggregated findings) — feeds per-row remediation. */
  rows?: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Engine policies the current family configuration activates (shared logic). */
export function activeEnginePolicies(defaults: PolicyBundle, nCustomers: number): string[] {
  return sharedActivePolicies(
    defaults as unknown as Row,
    nCustomers,
    bridge as unknown as BridgeTables,
  );
}

// ── Input: RAW project rows, exactly as the tables/RPCs return them ─────────
// No pre-imputation: display-level imputed values (useStageRows) must never
// mask a gap from the grader — the gate reads raw tables and would disagree.

export interface ManifestInput {
  defaults: PolicyBundle;
  materials?: Row[];
  products?: Row[];
  suppliers?: Row[];
  /** Raw inbound_logistics rows (fetchProjectLanes / useItemMasters). */
  inbound?: Row[];
  /** Raw outbound_logistics rows. */
  outbound?: Row[];
  /** Raw bom_single_level OR bom_multi_level rows — the shared grader
   * normalizes the shape; powers the unsourced-BOM hard block. */
  bom?: Row[];
  /** `policy_overrides` rows as stored — the values set on /policies, which the
   * engine reads before the item masters. The sim-command gate always passes
   * them (`loadGateDataset`); without them a value set on /policies grades as
   * missing here while the gate and the run use it. */
  overrides?: Row[];
  /** `customers` rows (PLAN.md §24 WP 14.3) — the gate loads them too. */
  customers?: Row[];
}

const STAGE_BY_DATASET: Record<string, StageKey> = {
  materials: "supplier",
  suppliers: "supplier",
  inbound_logistics: "supplier",
  products: "plant",
  outbound_logistics: "customer",
};

/**
 * Static view of the manifest for the Data map grid: every requirement any
 * catalog policy (or the engine) declares on a `dataset.column`, regardless
 * of the current policy selection. Conditional demands carry their condition.
 */
export interface FieldDemand {
  policyRef: string; // "engine" or a catalog ref like "P-P.5"
  policyName: string;
  level: "required" | "recommended" | "defaulted";
  condition: string | null;
}

export function requirementsByField(): Map<string, FieldDemand[]> {
  const out = new Map<string, FieldDemand[]>();
  const push = (field: string, d: FieldDemand) => {
    const list = out.get(field) ?? [];
    list.push(d);
    out.set(field, list);
  };
  for (const r of baseDataRequirements()) {
    push(r.field, { policyRef: "engine", policyName: "engine mechanics", level: r.level, condition: r.condition });
  }
  for (const p of policyCatalog()) {
    for (const r of p.data_requirements ?? []) {
      push(r.field, { policyRef: p.catalog_ref, policyName: p.id, level: r.level, condition: r.condition });
    }
  }
  return out;
}

// ── Grading (delegated) + UI flattening ─────────────────────────────────────

const LEVEL_WHEN_MISSING: Record<string, Severity> = {
  required: "block",
  recommended: "warn",
  defaulted: "info",
};

/**
 * The one grading preamble both entry points share (WP 9.4 slice 8): the raw
 * dataset, graded by the shared module against the same registry and bridge.
 * The two entry points differ only in how they SHAPE the result — per row for
 * the /policies verification stage, per field (the gate's shape) for the Lab.
 */
function gradeInput(input: ManifestInput): { dataset: GradingDataset; graded: GradedField[] } {
  const dataset: GradingDataset = {
    materials: input.materials ?? [],
    products: input.products ?? [],
    suppliers: input.suppliers ?? [],
    inbound: input.inbound ?? [],
    outbound: input.outbound ?? [],
    bom: input.bom ?? [],
    overrides: input.overrides,
    customers: input.customers ?? [],
  };
  const graded = gradeManifest(
    dataset,
    input.defaults as unknown as Row,
    registry as unknown as RegistryPayload,
    bridge as unknown as BridgeTables,
  );
  return { dataset, graded };
}

/**
 * Grade the compiled manifest against the raw project dataset. Same findings
 * on all §8.2 surfaces: this one (the /policies verification stage and the
 * project-manager completeness view) and — through the shared module — the
 * sim-command pre-dispatch gate.
 */
export function compileRequiredDataFindings(input: ManifestInput): Finding[] {
  const { graded } = gradeInput(input);

  const out: Finding[] = [];
  for (const g of graded) {
    if (!g.evaluable) continue;
    out.push(...findingsForField(g));
  }
  return out;
}

// ── Gate mirror (Lab pre-run panel) ─────────────────────────────────────────

export type { GradedFinding };

/**
 * The EXACT findings the sim-command pre-dispatch gate would return for this
 * dataset + policy configuration + scenario: manifest grading via the shared
 * module, flattened to the gate's aggregated per-field shape, plus the
 * scenario-conditional capacity check. The Lab renders these before dispatch
 * (and re-renders the server's own copy after a 422) — same vocabulary, same
 * grader, no second validation surface.
 */
export function compileGateFindings(
  input: ManifestInput,
  disruptionSchedule: Row[] = [],
): GradedFinding[] {
  const { dataset, graded } = gradeInput(input);
  return [
    ...flattenFindings(graded),
    ...scheduleFindings(
      dataset.suppliers,
      disruptionSchedule,
      (registry as unknown as { disruption: DisruptionRule }).disruption,
      dataset.inbound,
    ),
  ];
}

/**
 * Adapt gate-shaped findings (ours pre-dispatch, or the server's from a 422
 * response body) to the UI `Finding` vocabulary the shared findings list
 * renders — one row per field with the affected-row count in the message.
 */
export function gateFindingsToFindings(
  gate: Array<Pick<GradedFinding, "severity" | "field" | "policy" | "rows" | "message"> & { reason?: string }>,
): Finding[] {
  return gate.map((g, i) => {
    const dataset = g.field.split(".")[0];
    return {
      id: `gate-${g.field}-${g.severity}-${i}`,
      severity: (g.severity as Severity) ?? "info",
      stage: STAGE_BY_DATASET[dataset] ?? "run_validate",
      field: g.field,
      policy: g.policy,
      rows: g.rows,
      message: g.message,
      hint: g.rows?.length
        ? `Affected: ${g.rows.slice(0, 6).join(", ")}${g.rows.length > 6 ? ", …" : ""}`
        : undefined,
    };
  });
}

function findingsForField(g: GradedField): Finding[] {
  const dataset = g.field.split(".")[0];
  const label = findingFieldLabel(g.field);
  const stage = STAGE_BY_DATASET[dataset] ?? "run_validate";
  const demandedBy = g.policyRef === "engine"
    ? "the engine"
    : `${g.policyName} (${g.policyRef})`;
  const out: Finding[] = [];

  // Nothing resolves — severity from the manifest level (required → block).
  if (g.missing.length > 0) {
    const severity = LEVEL_WHEN_MISSING[g.level] ?? "info";
    if (severity === "info") {
      out.push({
        id: `req-${g.field}`,
        severity,
        stage,
        field: g.field,
        policy: g.policyRef,
        message: `${label} is empty for ${g.missing.length} row(s) — the engine default applies (${g.fallbackProse ?? "engine default"}).`,
        hint: g.reason,
      });
    } else {
      for (const id of g.missing.slice(0, 25)) {
        out.push({
          id: `req-${g.field}-${id}`,
          severity,
          stage,
          rowKey: id,
          field: g.field,
          policy: g.policyRef,
          message: `"${id}" has no ${label} — required by ${demandedBy}.`,
          hint: g.reason,
        });
      }
      if (g.missing.length > 25) {
        out.push({
          id: `req-${g.field}-more`,
          severity,
          stage,
          field: g.field,
          policy: g.policyRef,
          message: `…and ${g.missing.length - 25} more row(s) missing ${label}.`,
        });
      }
    }
  }

  // Neutral-constant fallbacks — the engine's WARN class (ack-able pre-run).
  const warns = g.resolved.filter((r) => r.grade === "warn");
  if (warns.length > 0) {
    const example = warns[0];
    out.push({
      id: `req-warn-${g.field}`,
      severity: "warn",
      stage,
      field: g.field,
      policy: g.policyRef,
      rowKey: warns.length === 1 ? warns[0].id : undefined,
      message:
        `${label} is unset for ${warns.length} row(s) — the engine will apply its ` +
        `neutral default (${example.value !== undefined ? `≈${round2(example.value)}` : example.via}). ` +
        `Acknowledge to run anyway, or fill the data to make the affected KPIs meaningful.`,
      hint: g.reason,
    });
  }

  // Data-derived fallbacks — provenance notes (§8.3 effective economics).
  // ONE note per field, not one per row: a value derived from the project's own
  // lanes is the normal case, not a defect, and 25 identical lines per field
  // buried the blockers above them. The affected ids still travel in `rows`
  // (per-row remediation) and the first few, with their derived values, in the
  // hint — T2 holds at the point of display without a line per entity.
  const derivedRows = g.resolved.filter((r) => r.grade === "info");
  if (derivedRows.length > 0) {
    const examples = derivedRows
      .slice(0, 6)
      .map((fb) => (fb.value !== undefined ? `${fb.id} ≈${round2(fb.value)}` : fb.id))
      .join(", ");
    out.push({
      id: `req-fb-${g.field}`,
      severity: "info",
      stage,
      rowKey: derivedRows.length === 1 ? derivedRows[0].id : undefined,
      field: g.field,
      policy: g.policyRef,
      rows: derivedRows.map((fb) => fb.id),
      message:
        `${label} is not set for ${derivedRows.length} row(s) — the engine derives it via ` +
        `${g.fallbackProse ?? derivedRows[0].via}. Set it only to override the derived value.`,
      hint: `e.g. ${examples}${derivedRows.length > 6 ? ", …" : ""}`,
    });
  }

  return out;
}

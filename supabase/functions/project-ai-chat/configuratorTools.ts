// B2 Policy Configurator draft-tool family — Stage 2 (ai-agents.md §5.2,
// §4.5, §9.3).
//
// Three tools, registered into the shared executeTool registry (bridge 2):
//   * get_policy_catalog — read: the registry export (blueprint §6.2 SSOT),
//     honest catalog rows incl. planned entries with their milestone.
//   * get_policy_config — read: the reads usePolicies.tsx performs
//     (policy_defaults row, policy_overrides rows, current_policy_hash,
//     latest list_policy_versions entry).
//   * draft_policy_bundle — draft: validates the §5.2 diff against the
//     storage vocabulary (_shared/policyFields.ts — registry-overlaid,
//     same-as-UI editability), resolves override targets in-project,
//     recompiles the required-data manifest against the MERGED defaults and
//     attaches it as findings_preview, then files the proposal through
//     create_agent_proposal.
//
// The diff vocabulary is deliberately the v2 snapshot shape
// (_build_policy_snapshot, 20260612000001): a reviewer reads the same
// structure policy_versions stores, and apply is a mechanical merge
// (apply_policy_bundle, 20260716000001).
//
// Module layout note (ai-agents.md §10 Q21a/Q22): §9.3 homes these tools in
// draftTools.ts; they live in this sibling module for testability and are
// registered via the draftTools.ts import — no contract change.

import {
  registerToolHandler,
  toolDeclarations,
  type ToolContext,
  type ToolDeclaration,
  type ToolEnvelope,
} from "./tools.ts";
import { loadGateDataset } from "../_shared/validationGate.ts";
import { flattenFindings, type GradedFinding } from "../_shared/grading.ts";
import {
  entityIdSets,
  gradeDataset,
  loadPolicyDefaults,
} from "../_shared/itemMasterCandidates.ts";
import {
  catalogSlice,
  mergeDefaults,
  policyCatalogRows,
  REGISTRY_VERSION,
  validatePolicyDiff,
  type PolicyDiff,
  type PolicyFamily,
} from "../_shared/policyFields.ts";
import { canonicalJson, sha256Hex } from "./telemetry.ts";
import { deploymentEnabledAgents } from "./router.ts";
import {
  AGENT_COMMON,
  failureEnvelope,
  getDataCompletenessDeclaration,
  MAX_CITATIONS,
  MAX_PAYLOAD_BYTES,
  proposalEnvelope,
  type ProposalPartData,
} from "./draftTools.ts";
import {
  getProjectMemoryDeclaration,
  loadActiveMemories,
  loadStaleContext,
  memoryContextBlock,
  memoryEnabled,
} from "./memory.ts";

export const CONFIGURATOR_AGENT_ID = "policy-configurator";
export const CONFIGURATOR_ARTIFACT_TYPE = "policy_bundle_diff";
/** §10 Q10: prompt versioning — bumped on any §5.2 template change. */
export const CONFIGURATOR_PROMPT_VERSION = 1;

/** §5.2 grounding-context budgets (DEFAULT): 80 KB total; defaults ≤ 24 KB,
 * overrides ≤ 16 KB, catalog slice ≤ 24 KB, presets ≤ 8 KB. */
export const CONFIGURATOR_DEFAULTS_BUDGET = 24 * 1024;
export const CONFIGURATOR_OVERRIDES_BUDGET = 16 * 1024;
export const CONFIGURATOR_CATALOG_BUDGET = 24 * 1024;
export const CONFIGURATOR_PRESETS_BUDGET = 8 * 1024;

// ---------- declarations (§5.2 schemas, provider-safe subset) ----------

export const getPolicyCatalogDeclaration: ToolDeclaration = {
  name: "get_policy_catalog",
  description:
    "List the engine's policy catalog (generated from the engine registry): id, catalog ref (P-S.x/P-P.x/…), stage, implemented-vs-planned status with milestone, parameter schema summary, and the data each policy requires. Planned policies CANNOT be configured.",
  parameters: {
    type: "object",
    properties: {
      stage: {
        type: "string",
        enum: ["supplier", "plant", "transport", "customer", "cross", "all"],
        description: "Restrict to one echelon. Default 'all'.",
      },
      status: {
        type: "string",
        enum: ["implemented", "planned", "all"],
        description: "Restrict by implementation status. Default 'all'.",
      },
    },
  },
};

export const getPolicyConfigDeclaration: ToolDeclaration = {
  name: "get_policy_config",
  description:
    "Read the project's current policy configuration: the 7 family defaults, per-node/edge override rows, the current policy hash, and the latest saved policy version.",
  parameters: {
    type: "object",
    properties: {
      family: {
        type: "string",
        enum: ["sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand", "all"],
        description: "Restrict to one policy family. Default 'all'.",
      },
    },
  },
};

export const draftPolicyBundleDeclaration: ToolDeclaration = {
  name: "draft_policy_bundle",
  description:
    "File ONE reviewable policy-change proposal. Express the change as the SMALLEST diff: family-level patches in diff.defaults, per-entity patches in diff.overrides (scope + target_key exactly as the policy_overrides table stores them, e.g. scope 'node', target_key 'S1::MAT-4'). Parameters must satisfy the registry schema from CONTEXT. Call this once per ask.",
  parameters: {
    type: "object",
    properties: {
      diff: {
        type: "object",
        description:
          "The v2 snapshot-shaped change: { defaults?: {family: patch}, overrides?: [{scope, target_key, family, patch}] } — at least one of the two.",
        properties: {
          defaults: {
            type: "object",
            description: "Family-level patches, keyed by family (sourcing|inventory|transport|fulfillment|production|recovery|demand).",
          },
          overrides: {
            type: "array",
            description: "Per-entity patches (max 200).",
            items: {
              type: "object",
              properties: {
                scope: { type: "string", description: "'node' or 'edge' — as the grid stores it." },
                target_key: { type: "string", description: "Row key, e.g. 'S1::MAT-4' (supplier::material), 'C1::P1' (customer::product), or a bare entity id." },
                family: {
                  type: "string",
                  enum: ["sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand"],
                },
                patch: { type: "object", description: "Field → value patch for that family." },
              },
              required: ["scope", "target_key", "family", "patch"],
            },
          },
        },
      },
      base_policy_version_id: {
        type: "string",
        description: "The id (a uuid) of the saved policy version the diff was drafted against, as CONTEXT lists it under the latest policy version. It is never the policy hash. Omit it if no version exists or you are unsure.",
      },
      title: { type: "string", description: "Card title (max 140 chars)." },
      rationale: { type: "string", description: "Why this change serves the ask (max 2000 chars)." },
    },
    required: ["diff"],
  },
};

/** The Configurator's complete least-privilege tool surface (§5.2): nothing
 * else is declared to the model. get_project_memory joins when M2 is on
 * (§14.4: all personas and agents). */
export function configuratorToolDeclarations(): ReadonlyArray<ToolDeclaration> {
  return [
    toolDeclarations[0], // list_project_entities (existing read tool)
    getDataCompletenessDeclaration,
    getPolicyCatalogDeclaration,
    getPolicyConfigDeclaration,
    ...(memoryEnabled() ? [getProjectMemoryDeclaration] : []),
    draftPolicyBundleDeclaration,
  ];
}

// ---------- §5.2 system-prompt template (verbatim) ----------

export function buildConfiguratorPrompt(args: {
  projectId: string;
  utterance: string;
  fulfillmentStrategy: string;
  policyDefaultsJson: string;
  overridesJson: string;
  catalogSliceJson: string;
  policyHash: string;
  memoryBlock?: string;
}): string {
  const memory = args.memoryBlock ? `\n${args.memoryBlock}` : "";
  return `You are the Policy Configurator, the SuReSuite agent that turns intent into a
reviewable policy-change proposal for one project.

CONTEXT
- Project: ${args.projectId} (fulfillment strategy: ${args.fulfillmentStrategy})
- Current policy defaults (7 families): ${args.policyDefaultsJson}
- Relevant overrides: ${args.overridesJson}
- Registry catalog for the slots in scope (schemas, ranges, allowed values,
  data each policy requires): ${args.catalogSliceJson}
- Current policy hash: ${args.policyHash}${memory}

TASK
- The user asked: "${args.utterance}"
- Express the change as the SMALLEST diff: family-level patches in "defaults",
  per-entity patches in "overrides" (scope + target_key exactly as the
  policy_overrides table stores them). Parameters must satisfy the registry
  schema for the chosen policy — copy allowed values and ranges from CONTEXT,
  never from memory.
- If the change activates a policy whose data_requirements are not met, keep
  the change but list the newly-required fields in your reply (the Data
  Steward can fill them).
- If the intent is a trade-off ("budget-neutral", "without dropping fill
  rate"), configure the levers and SAY PLAINLY that outcomes must be verified
  by simulation — you must not predict KPI values.
- If the ask names a parameter that is NOT in the registry catalog in CONTEXT,
  do NOT draft and do NOT substitute the nearest real parameter: name the
  unknown parameter and say it is not in the policy schema. Guessing which
  slot the user "meant" is the failure this rule exists to prevent.
- If the ask targets a policy the catalog marks planned/not-yet-implemented,
  do NOT draft: name the catalog id and the milestone the catalog gives it,
  and say it is not configurable yet.
- Call draft_policy_bundle ONCE. Then reply in 2-5 sentences: what changes,
  which slots/entities, what data it newly requires, and that applying will
  create a policy version snapshot for review.

${AGENT_COMMON}`;
}

function clampJson(value: unknown, budget: number): string {
  const s = JSON.stringify(value ?? null);
  return s.length <= budget ? s : s.slice(0, budget) + "…";
}

/** Deterministic grounding-context builder (bridge 3): project artifacts only
 * — current defaults, overrides for entities the utterance names, the catalog
 * slice, the policy hash, preset metadata, and (M2) project memory. */
export async function buildConfiguratorContext(
  ctx: ToolContext,
  args: { utterance: string },
): Promise<string> {
  const db = ctx.supabase;
  const defaults = await loadPolicyDefaults(db, ctx.projectId);
  const fulfillmentStrategy = String(defaults.fulfillment_strategy ?? "make_to_stock");
  const familyDefaults: Record<string, unknown> = {};
  for (const fam of ["sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand"]) {
    if (defaults[fam] != null) familyDefaults[fam] = defaults[fam];
  }

  // Overrides for entities the utterance names (resolved by simple id match —
  // the agent can still call get_policy_config for the full set).
  let overrides: Array<Record<string, unknown>> = [];
  try {
    const { data } = await db
      .from("policy_overrides")
      .select("scope,target_key,family,patch")
      .eq("project_id", ctx.projectId)
      .limit(500);
    const all = (data ?? []) as Array<Record<string, unknown>>;
    const utterance = args.utterance.toLowerCase();
    overrides = all.filter((o) => {
      const key = String(o.target_key ?? "").toLowerCase();
      return key.split("::").some((part) => part && utterance.includes(part));
    });
    if (overrides.length === 0) overrides = all.slice(0, 40);
  } catch { /* overrides are context, not a gate */ }

  let policyHash = "unknown";
  try {
    const { data } = await db.rpc("current_policy_hash", { p_project_id: ctx.projectId });
    if (typeof data === "string" && data) policyHash = data;
  } catch { /* shown as unknown; the draft handler re-reads it */ }

  // The full editable slice for every family — the intent may touch any slot.
  const slice = catalogSlice([
    "sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand",
  ] as PolicyFamily[]);

  let memoryBlock = "";
  if (memoryEnabled()) {
    try {
      const [rows, stale] = await Promise.all([
        loadActiveMemories(db, ctx.projectId),
        loadStaleContext(db, ctx.projectId),
      ]);
      memoryBlock = memoryContextBlock(rows, stale).block;
    } catch { /* memory is context, not a gate */ }
  }

  return buildConfiguratorPrompt({
    projectId: ctx.projectId,
    utterance: args.utterance.slice(0, 4000),
    fulfillmentStrategy,
    policyDefaultsJson: clampJson(familyDefaults, CONFIGURATOR_DEFAULTS_BUDGET),
    overridesJson: clampJson(overrides, CONFIGURATOR_OVERRIDES_BUDGET),
    catalogSliceJson: clampJson(slice, CONFIGURATOR_CATALOG_BUDGET),
    policyHash,
    memoryBlock,
  });
}

// ---------- read handlers ----------

async function getPolicyCatalog(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "get_policy_catalog";
  const stage = ["supplier", "plant", "transport", "customer", "cross"].includes(String(args.stage))
    ? String(args.stage)
    : "all";
  const status = ["implemented", "planned"].includes(String(args.status))
    ? String(args.status)
    : "all";
  const rows = policyCatalogRows().filter(
    (r) => (stage === "all" || r.stage === stage) && (status === "all" || r.status === status),
  );
  if (rows.length === 0) {
    return { kind: "text", data: "No catalog entries match that filter.", meta: { tool, row_count: 0, note: "empty" } };
  }
  return {
    kind: "table",
    data: {
      columns: ["catalog_ref", "id", "stage", "status", "milestone", "summary", "params", "required_data"],
      rows: rows.map((r) => [
        r.catalog_ref, r.id, r.stage, r.status, r.milestone ?? "-",
        r.summary, r.params || "-", r.required_data || "-",
      ]),
    },
    meta: { tool, row_count: rows.length },
  };
}

async function getPolicyConfig(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "get_policy_config";
  const familyArg = [
    "sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand",
  ].includes(String(args.family))
    ? String(args.family)
    : "all";
  try {
    const db = ctx.supabase;
    const defaults = await loadPolicyDefaults(db, ctx.projectId);
    const rows: Array<[string, string, string]> = [];
    rows.push(["project", "fulfillment_strategy", String(defaults.fulfillment_strategy ?? "make_to_stock")]);
    rows.push(["project", "active_preset", String(defaults.active_preset ?? "-")]);

    try {
      const { data: hash } = await db.rpc("current_policy_hash", { p_project_id: ctx.projectId });
      rows.push(["project", "current_policy_hash", String(hash ?? "-")]);
    } catch { rows.push(["project", "current_policy_hash", "-"]); }

    try {
      const { data: versions } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
      const latest = Array.isArray(versions) ? versions[0] : null;
      rows.push([
        "project",
        "latest_policy_version",
        latest ? `${latest.id} · "${latest.label ?? ""}" · hash ${String(latest.policy_hash ?? "").slice(0, 12)}` : "-",
      ]);
    } catch { rows.push(["project", "latest_policy_version", "-"]); }

    for (const fam of ["sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand"]) {
      if (familyArg !== "all" && familyArg !== fam) continue;
      rows.push(["defaults", fam, JSON.stringify(defaults[fam] ?? {})]);
    }

    const { data: overrideRows } = await db
      .from("policy_overrides")
      .select("scope,target_key,family,patch")
      .eq("project_id", ctx.projectId)
      .limit(200);
    for (const o of (overrideRows ?? []) as Array<Record<string, unknown>>) {
      if (familyArg !== "all" && String(o.family) !== familyArg) continue;
      rows.push([
        "override",
        `${o.scope}:${o.target_key} (${o.family})`,
        JSON.stringify(o.patch ?? {}),
      ]);
    }

    return {
      kind: "table",
      data: { columns: ["section", "key", "value"], rows },
      meta: { tool, row_count: rows.length },
    };
  } catch (e) {
    console.warn("get_policy_config failed:", (e as Error).message);
    return { kind: "text", data: "Policy configuration read failed.", meta: { tool, row_count: 0, note: "error" } };
  }
}

// ---------- draft_policy_bundle handler ----------

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const findingKey = (f: GradedFinding) => `${f.severity}|${f.field}|${f.policy}`;

/** §4.5 idempotency core: the payload minus free-text (rationale/title). */
export async function configuratorIdempotencyKey(
  diff: PolicyDiff,
  basePolicyVersionId: string | null,
): Promise<string> {
  const core = { schema_version: 1, diff, base_policy_version_id: basePolicyVersionId };
  return await sha256Hex(
    `${CONFIGURATOR_AGENT_ID} ${CONFIGURATOR_ARTIFACT_TYPE} ${canonicalJson(core)}`,
  );
}

function summarizeDiff(diff: PolicyDiff, newlyRequired: string[]): string {
  const parts: string[] = [];
  const defaults = diff.defaults ?? {};
  const famList = Object.keys(defaults);
  if (famList.length > 0) {
    parts.push(
      famList.map((f) => `${f} defaults: ${Object.keys(defaults[f as PolicyFamily] ?? {}).join(", ")}`).join("; "),
    );
  }
  const overrides = diff.overrides ?? [];
  if (overrides.length > 0) {
    const targets = [...new Set(overrides.map((o) => o.target_key))];
    parts.push(`${overrides.length} override(s) on ${targets.slice(0, 5).join(", ")}${targets.length > 5 ? "…" : ""}`);
  }
  if (newlyRequired.length > 0) {
    parts.push(`newly required data: ${newlyRequired.join(", ")}`);
  }
  return parts.join(" · ");
}

async function draftPolicyBundle(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolEnvelope> {
  const tool = "draft_policy_bundle";

  // §13.2 checkpoints 2-3: deployment kill switch + agent_proposals capability.
  if (!deploymentEnabledAgents().includes(CONFIGURATOR_AGENT_ID)) {
    return failureEnvelope(tool, "agent_disabled", "The Policy Configurator agent is not enabled in this deployment.");
  }
  if (!ctx.draft || !ctx.draft.canProposals) {
    return failureEnvelope(tool, "agent_disabled", "Proposal drafting is not enabled for this account (agent_proposals).");
  }

  // §5.2 output contract: top-level argument shape.
  for (const k of Object.keys(args)) {
    if (!["diff", "base_policy_version_id", "title", "rationale"].includes(k)) {
      return failureEnvelope(tool, "invalid_params", `unknown parameter "${k}"`);
    }
  }
  if (args.rationale != null && (typeof args.rationale !== "string" || args.rationale.length > 2000)) {
    return failureEnvelope(tool, "invalid_params", "rationale must be a string (max 2000 chars)");
  }
  if (args.base_policy_version_id != null &&
      (typeof args.base_policy_version_id !== "string" || !uuidRe.test(args.base_policy_version_id))) {
    return failureEnvelope(tool, "invalid_params", "base_policy_version_id must be a uuid");
  }

  // §5.2 hard gates 1–2: registry-schema validation of every field
  // (unknown ⇒ invalid_params; planned-policy fields ⇒ dependency_missing).
  const validation = validatePolicyDiff(args.diff);
  if (!validation.ok) {
    return failureEnvelope(tool, validation.code!, validation.reason!);
  }
  const diff = args.diff as PolicyDiff;

  // Grounding data: the same tables + live defaults the gate grades.
  let dataset, defaults;
  try {
    [dataset, defaults] = await Promise.all([
      loadGateDataset(ctx.supabase, ctx.projectId),
      loadPolicyDefaults(ctx.supabase, ctx.projectId),
    ]);
  } catch (e) {
    console.warn("draft_policy_bundle dataset load failed:", (e as Error).message);
    return failureEnvelope(tool, "dependency_missing", "Could not load the project's policy configuration — try again.");
  }

  // §5.2 hard gate 3: every override target must resolve in this project.
  const idSets = entityIdSets(dataset);
  const knownIds = new Set<string>([
    ...idSets.materials, ...idSets.products, ...idSets.suppliers,
  ]);
  for (const o of dataset.outbound) {
    const c = String((o as Record<string, unknown>).customer_id ?? "");
    if (c) knownIds.add(c);
  }
  try {
    const { data: nodes } = await ctx.supabase
      .from("node_list")
      .select("node_id")
      .eq("project_id", ctx.projectId)
      .limit(2000);
    for (const nrow of (nodes ?? []) as Array<Record<string, unknown>>) {
      const id = String(nrow.node_id ?? "");
      if (id) knownIds.add(id);
    }
  } catch { /* node_list enrichment is best-effort */ }

  const foreign: string[] = [];
  for (const o of diff.overrides ?? []) {
    const tokens = o.target_key.split("::").map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0 || tokens.some((t) => !knownIds.has(t))) {
      foreign.push(o.target_key);
    }
  }
  if (foreign.length > 0) {
    return failureEnvelope(
      tool,
      "project_scope_violation",
      `These override targets are not in this project: ${[...new Set(foreign)].slice(0, 10).join(", ")}`,
    );
  }

  // Base version lineage: verify a supplied id, else use the latest version.
  let baseVersionId: string | null = null;
  try {
    const { data: versions } = await ctx.supabase.rpc("list_policy_versions", { p_project_id: ctx.projectId });
    const list = Array.isArray(versions) ? versions as Array<Record<string, unknown>> : [];
    if (typeof args.base_policy_version_id === "string") {
      if (!list.some((v) => String(v.id) === args.base_policy_version_id)) {
        return failureEnvelope(
          tool,
          "project_scope_violation",
          `policy version ${args.base_policy_version_id} does not belong to this project`,
        );
      }
      baseVersionId = args.base_policy_version_id;
    } else {
      baseVersionId = list.length > 0 ? String(list[0].id) : null;
    }
  } catch {
    baseVersionId = typeof args.base_policy_version_id === "string" ? args.base_policy_version_id : null;
  }

  // §5.2 hard gate 4: recompile the required-data manifest against the MERGED
  // defaults and attach it (findings_preview) — the §8.1 grader, same snapshot.
  const findingsBefore = flattenFindings(gradeDataset(dataset, defaults));
  const merged = mergeDefaults(defaults, diff.defaults);
  const findingsPreview = flattenFindings(gradeDataset(dataset, merged)).map(
    ({ severity, field, policy, rows, message }) => ({ severity, field, policy, rows, message }),
  );
  const beforeKeys = new Set(findingsBefore.map(findingKey));
  const newlyRequired = [
    ...new Set(
      findingsPreview
        .filter((f) => !beforeKeys.has(findingKey(f as GradedFinding)) && f.severity !== "info")
        .map((f) => f.field),
    ),
  ];

  // Current policy hash — the §4.4 grounding the apply re-checks (pc-08).
  let policyHash: string | null = null;
  try {
    const { data } = await ctx.supabase.rpc("current_policy_hash", { p_project_id: ctx.projectId });
    if (typeof data === "string" && data) policyHash = data;
  } catch { /* TTL still bounds the card */ }

  const rationale = typeof args.rationale === "string" ? args.rationale : "";
  const payload = {
    schema_version: 1,
    prompt_version: CONFIGURATOR_PROMPT_VERSION,
    diff,
    base_policy_version_id: baseVersionId,
    rationale,
    findings_preview: findingsPreview.filter((f) => f.severity !== "info").slice(0, 100),
    newly_required: newlyRequired,
  };
  if (canonicalJson(payload).length > MAX_PAYLOAD_BYTES) {
    return failureEnvelope(tool, "too_large", "The diff exceeds the 256 KB payload limit — narrow the ask.");
  }

  // Citations (§4.3): registry refs for every field the diff sets, the user's
  // ask, and (M2) the memory entries present in the grounding context (mm-04).
  const citations: Array<Record<string, unknown>> = validation.fields.map((f) => ({
    kind: "registry",
    ref: f,
  }));
  citations.push({
    kind: "user_message",
    ref: `thread:${ctx.draft.threadId ?? "current"}`,
    quote: ctx.draft.utterance.slice(0, 500),
  });
  if (memoryEnabled()) {
    try {
      const [rows, stale] = await Promise.all([
        loadActiveMemories(ctx.supabase, ctx.projectId),
        loadStaleContext(ctx.supabase, ctx.projectId),
      ]);
      for (const id of memoryContextBlock(rows, stale).citedIds.slice(0, 8)) {
        citations.push({ kind: "document", ref: `project_memory:${id}` });
      }
    } catch { /* memory citations are additive */ }
  }
  if (citations.length > MAX_CITATIONS) citations.length = MAX_CITATIONS;

  const idemKey = await configuratorIdempotencyKey(diff, baseVersionId);
  const nDefaults = Object.keys(diff.defaults ?? {}).length;
  const nOverrides = (diff.overrides ?? []).length;
  const title = (typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : `Policy change: ${nDefaults} family default(s), ${nOverrides} override(s)`)
    .slice(0, 140);
  const summary = summarizeDiff(diff, newlyRequired);

  // §4.2: an identical live ask converges on the existing card.
  try {
    const { data: existing } = await ctx.supabase
      .from("proposals")
      .select("id,status,title")
      .eq("project_id", ctx.projectId)
      .eq("idempotency_key", idemKey)
      .in("status", ["draft", "proposed", "approved"])
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      return proposalEnvelope(tool, {
        proposal_id: String(existing.id),
        status: String(existing.status ?? "proposed"),
        title: String(existing.title ?? title),
        artifact_type: CONFIGURATOR_ARTIFACT_TYPE,
        summary,
        provenance: "llm_drafted",
        duplicate: true,
      });
    }
  } catch { /* the RPC's own idempotency check still converges below */ }

  const { data: proposalId, error } = await ctx.supabase.rpc("create_agent_proposal", {
    p_project_id: ctx.projectId,
    p_agent_id: CONFIGURATOR_AGENT_ID,
    p_artifact_type: CONFIGURATOR_ARTIFACT_TYPE,
    p_title: title,
    p_payload: payload,
    p_citations: citations,
    // §5.2: llm_drafted always — parameter CHOICES are the LLM's; validity is
    // the gate's.
    p_provenance: "llm_drafted",
    p_grounding: {
      ...(policyHash ? { policy_hash: policyHash } : {}),
      registry_version: REGISTRY_VERSION,
    },
    p_idempotency_key: idemKey,
    p_thread_id: ctx.draft.threadId,
    p_model_code: ctx.draft.modelCode,
    p_provider_code: ctx.draft.providerCode,
    p_user_id: ctx.userId,
    p_user_email: ctx.draft.userEmail,
    p_status: "proposed",
  });
  if (error) {
    const msg = String(error.message ?? "proposal creation failed");
    if (msg.includes("too_large")) return failureEnvelope(tool, "too_large", msg);
    console.error("create_agent_proposal failed:", msg);
    return { kind: "text", data: "Filing the proposal failed — try again.", meta: { tool, row_count: 0, note: "error" } };
  }

  return proposalEnvelope(tool, {
    proposal_id: String(proposalId),
    status: "proposed",
    title,
    artifact_type: CONFIGURATOR_ARTIFACT_TYPE,
    summary,
    provenance: "llm_drafted",
  });
}

// Register into the shared executeTool registry (bridge 2). Personas never see
// these tools — only the Configurator's least-privilege subset declares them.
registerToolHandler("get_policy_catalog", getPolicyCatalog);
registerToolHandler("get_policy_config", getPolicyConfig);
registerToolHandler("draft_policy_bundle", draftPolicyBundle);

export type { ProposalPartData };

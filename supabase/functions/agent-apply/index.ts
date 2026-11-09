// agent-apply — the ONLY writer of proposal apply outcomes (Stage 1;
// ai-agents.md §4.4, §13.2 checkpoint 5, §8 T9).
//
// Deliberately free of business logic: a fixed artifact_type → existing-gate
// dispatch table and the checkpoint-5 authorization sequence, nothing else.
// It holds the service role, calls exactly the RPCs the UI calls, and is the
// sole caller of mark_agent_proposal_applied / _apply_failed (single-writer
// discipline, asset A11). Apply is idempotent end-to-end: a re-POST for an
// already-applied proposal returns the stored applied_result without
// re-executing (§4.4).
//
// Checkpoint 5 (fail closed): proposal status = approved; project ownership;
// `agent_apply` + the artifact's own operation right (§13.3 — item_master_diff
// needs `data_editing`); the project right the same edit needs on THIS project
// (D276, `agent_project_right_refusal`); quota (§13.4); THEN delegate to the gate. Rights
// failures return typed errors WITHOUT burning an apply attempt — attempts
// count real gate/RPC executions only.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { makeTelemetry, telemetryEnabled } from "../project-ai-chat/telemetry.ts";
import {
  ApplyFailure,
  applyItemMasterDiff,
  type ApplyErrorCode,
  type ItemMasterApplyResult,
} from "./itemMasterApply.ts";
import { applyParameterEstimate, type ParameterEstimateApplyResult } from "./parameterEstimateApply.ts";
import { applyNetworkMapDiff, type NetworkMapApplyResult } from "./networkMapDiffApply.ts";
import { applyPolicyBundle, type PolicyBundleApplyResult } from "./policyBundleApply.ts";
import { applyModelCard, type ModelCardApplyResult } from "./modelCardApply.ts";
import { applyExperimentSpec, type ExperimentSpecApplyResult } from "./experimentSpecApply.ts";
import { applyRiskAlert, fillRiskAlertImpact, type RiskAlertApplyResult } from "./riskAlertApply.ts";
import { applyDecisionReport, type DecisionReportApplyResult } from "./decisionReportApply.ts";
import { makeWriters } from "../report-render/writers.ts";
import { cleanEnv } from "../_shared/env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  // Errors ride HTTP 200 with {error, type} — supabase-js `invoke` discards
  // non-2xx bodies (same posture as project-ai-chat).
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** §4.2 DEFAULT: after 3 failed applies the card offers Reject only; the
 * server enforces the same cap fail-closed. */
const APPLY_RETRY_CAP = 3;

/** §13.3 operation-rights matrix: apply never demands less than the
 * equivalent manual action — capability feature keys AND page grants, ALL
 * required (on top of agent_apply). policy_bundle_diff carries the grants a
 * user needs to do this by hand on /policies; model_card_draft adoption lives
 * on Run & Validate (a /policies stage). */
export const ARTIFACT_RIGHTS: Record<string, { features: string[]; pages: string[] }> = {
  item_master_diff: { features: ["data_editing"], pages: [] },
  // §13.3 parameter_estimate row (v1.5): identical to item_master_diff —
  // the apply writes the same item-master fields through the same RPCs.
  parameter_estimate: { features: ["data_editing"], pages: [] },
  // §13.3 network_map_diff row (v1.5 Phase 4b): data_editing gates manual
  // supplier/arc entry, and assign_material_supplier is the exact RPC the
  // /policies grid's "assign supplier" action calls.
  network_map_diff: { features: ["data_editing"], pages: [] },
  policy_bundle_diff: { features: ["data_editing"], pages: ["/policies"] },
  model_card_draft: { features: [], pages: ["/policies"] },
  // §13.3 row 4 — "this is the 'agents can run simulations' right": exactly
  // the feature + page that gate the Lab's own Run button.
  experiment_spec: { features: ["simulation_lab"], pages: ["/simulation-lab"] },
  // §13.3 risk_alert row (v1.5 Phase 4d, §10 note 37h): approving an alert
  // dispatches the linked sizing run, so it demands EXACTLY the experiment
  // row's rights — never less than the equivalent manual action.
  risk_alert: { features: ["simulation_lab"], pages: ["/simulation-lab"] },
  // §13.3 decision_report row — same-as-UI proof: a future manual "Export
  // report" button would demand exactly `reports`. NOT data_editing —
  // rendering mutates no project state.
  decision_report: { features: ["reports"], pages: [] },
};

/** §13.3: the base capability an artifact's apply demands. Everything rides
 * agent_apply except decision_report, which deliberately demands only
 * agent_proposals (+ its `reports` operation right above) — rendering a
 * file mutates no project state, so the mutation right is never required. */
export const ARTIFACT_BASE_FEATURE: Record<string, string> = {
  decision_report: "agent_proposals",
};

/** §13.4 quota caps (DEFAULT, §10 Q15): agent-applied runs per user per
 * project, counted on simulation_runs rows joined through
 * proposals.applied_result→run_id. */
export const EXPERIMENT_CONCURRENT_CAP = 3;
export const EXPERIMENT_DAILY_CAP = 10;

/** §10 Q25 (DEFAULT): render quota — 20 decision-report renders per day per
 * user, counted on applied decision_report proposals across projects. */
export const REPORT_DAILY_CAP = 20;

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** §13.4: compute quotas per artifact. Only experiment_spec dispatches
 * compute: max 3 concurrent queued/running agent-applied runs and 10 per day,
 * per user per project. Returns the human-readable violation naming the
 * remaining allowance, or null when within quota. Quota failures never count
 * as an apply attempt (§10 Q21c — attempts count real gate/RPC executions). */
// deno-lint-ignore no-explicit-any
export async function checkApplyQuota(db: any, args: {
  artifactType: string;
  projectId: string;
  userId: string;
}): Promise<string | null> {
  // §10 Q25: 20 renders/day PER USER (across projects), counted on applied
  // decision_report proposals — one render per apply; the idempotent re-POST
  // of an already-applied proposal never reaches this check.
  if (args.artifactType === "decision_report") {
    try {
      const { data, error } = await db
        .from("proposals")
        .select("applied_at")
        .eq("artifact_type", "decision_report")
        .eq("status", "applied")
        .eq("reviewed_by", args.userId);
      if (error) throw error;
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const ts = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v ?? "")) || 0);
      const today = ((data ?? []) as Array<{ applied_at: unknown }>)
        .filter((r) => ts(r.applied_at) >= dayStart.getTime()).length;
      if (today >= REPORT_DAILY_CAP) {
        return `Daily report-render quota reached: ${today} of ${REPORT_DAILY_CAP} renders today for your account ` +
          `(${Math.max(0, REPORT_DAILY_CAP - today)} remaining). Try again tomorrow.`;
      }
      return null;
    } catch (e) {
      // Fail closed: nothing renders when the quota cannot be counted.
      console.error("report quota check failed:", e);
      return "The report-render quota could not be verified — try again.";
    }
  }
  // §10 note 37h: a risk_alert apply dispatches a run through the linked
  // experiment_spec, so it consumes the SAME §13.4 experiment quota (the
  // counting query below stays on experiment_spec proposals — the linked
  // proposal lands there as applied with the approving user as reviewer).
  if (args.artifactType !== "experiment_spec" && args.artifactType !== "risk_alert") return null;
  try {
    const { data: applied, error } = await db
      .from("proposals")
      .select("applied_result,reviewed_by")
      .eq("project_id", args.projectId)
      .eq("artifact_type", "experiment_spec")
      .eq("status", "applied")
      .eq("reviewed_by", args.userId);
    if (error) throw error;
    // §26 M.2: a comparison counts every arm's run against the DAILY cap, and
    // as ONE card against the concurrent cap (owner decision 4: one card, one
    // approval, one comparable result — counting arms would refuse every
    // study above 3 arms).
    const appliedRows = (applied ?? []) as Array<{ applied_result: Record<string, unknown> | null }>;
    const runIds = appliedRows
      .flatMap((p) => {
        const arms = p.applied_result?.arms;
        return Array.isArray(arms)
          ? (arms as Array<Record<string, unknown>>).map((a) => a.run_id)
          : [p.applied_result?.run_id];
      })
      .filter(isUuid);
    const cardOfRun = new Map<string, number>();
    appliedRows.forEach((p, i) => {
      const arms = p.applied_result?.arms;
      const ids = Array.isArray(arms) ? (arms as Array<Record<string, unknown>>).map((a) => a.run_id) : [p.applied_result?.run_id];
      for (const id of ids) if (isUuid(id)) cardOfRun.set(String(id), i);
    });
    if (runIds.length === 0) return null;
    const { data: runs, error: runsErr } = await db
      .from("simulation_runs")
      .select("id,status,created_at")
      .in("id", runIds);
    if (runsErr) throw runsErr;
    const rows = (runs ?? []) as Array<{ id?: string; status: string; created_at: unknown }>;

    const concurrent = new Set(
      rows.filter((r) => r.status === "queued" || r.status === "running")
        .map((r, i) => cardOfRun.get(String(r.id ?? "")) ?? `run-${i}`),
    ).size;
    if (concurrent >= EXPERIMENT_CONCURRENT_CAP) {
      return `Agent-run quota: ${concurrent} agent-applied runs are already queued or running for you on this project ` +
        `(limit ${EXPERIMENT_CONCURRENT_CAP} concurrent, 0 remaining). Wait for one to finish or cancel it in the Lab.`;
    }

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const ts = (v: unknown): number => (typeof v === "number" ? v : Date.parse(String(v ?? "")) || 0);
    const today = rows.filter((r) => ts(r.created_at) >= dayStart.getTime()).length;
    if (today >= EXPERIMENT_DAILY_CAP) {
      return `Daily agent-run quota reached: ${today} of ${EXPERIMENT_DAILY_CAP} agent-applied runs today for you on this ` +
        `project (${Math.max(0, EXPERIMENT_DAILY_CAP - today)} remaining). Try again tomorrow, or run it manually from the Lab.`;
    }
    return null;
  } catch (e) {
    // Fail closed: compute must not dispatch when the quota cannot be counted.
    console.error("apply quota check failed:", e);
    return "The agent-run quota could not be verified — try again.";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body.", type: "BAD_REQUEST" });
  }
  const proposalId = typeof body.proposalId === "string" ? body.proposalId : null;
  const userId = typeof body.userId === "string" ? body.userId : null;
  const userEmail = typeof body.userEmail === "string" ? body.userEmail : null;
  if (!proposalId || !userId) {
    return jsonResponse({ error: "Missing required parameters: proposalId, userId", type: "BAD_REQUEST" });
  }

  const svc = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const { data: proposal, error: loadErr } = await svc
      .from("proposals")
      .select("*")
      .eq("id", proposalId)
      .maybeSingle();
    if (loadErr) return jsonResponse({ error: `Proposal load failed: ${loadErr.message}`, type: "APPLY_ERROR" });
    if (!proposal) return jsonResponse({ error: "Proposal not found.", type: "NOT_FOUND" });

    // Idempotent re-POST (§4.4): applied is terminal — return the stored result.
    if (proposal.status === "applied") {
      // §18.3 hard gate 8: an applied risk_alert whose linked run has since
      // completed gets its impact range filled FROM run_replications on this
      // on-demand re-POST (never a background job — §18.4 stays unmet).
      if (String(proposal.artifact_type) === "risk_alert") {
        try {
          const refreshed = await fillRiskAlertImpact(svc, {
            id: proposalId,
            applied_result: (proposal.applied_result ?? null) as Record<string, unknown> | null,
          });
          if (refreshed) {
            return jsonResponse({ ok: true, applied_result: refreshed, already_applied: true });
          }
        } catch (e) {
          console.warn("risk-alert impact refresh skipped:", e instanceof Error ? e.message : e);
        }
      }
      return jsonResponse({ ok: true, applied_result: proposal.applied_result ?? null, already_applied: true });
    }
    if (proposal.status !== "approved") {
      return jsonResponse({
        error: `Apply requires an approved proposal (status is ${proposal.status}).`,
        type: "INVALID_STATUS",
      });
    }
    if (Number(proposal.apply_attempts ?? 0) >= APPLY_RETRY_CAP) {
      return jsonResponse({
        error: `Apply retry limit reached (${APPLY_RETRY_CAP}). Reject the card and ask for a fresh draft.`,
        type: "RETRY_LIMIT",
      });
    }

    // ── Checkpoint 5 authorization (fail closed; nothing mutated) ────────────
    const projectId = String(proposal.project_id);
    const { error: accessErr } = await svc.rpc("get_project_dataset_counts", {
      p_project_id: projectId,
      p_user_id: userId,
      p_user_email: userEmail,
    });
    if (accessErr) {
      const m = (accessErr.message || "").toLowerCase();
      const denied = m.includes("forbidden") || m.includes("project_not_found");
      return jsonResponse({
        error: denied
          ? "You don't have access to this proposal's project."
          : `Project access check failed: ${accessErr.message}`,
        type: "FORBIDDEN",
      });
    }

    const { data: caps, error: capsErr } = await svc.rpc("get_my_capabilities", { _user_id: userId });
    if (capsErr || !caps || typeof caps !== "object") {
      return jsonResponse({
        error: "Could not verify your permissions — try again.",
        type: "FORBIDDEN",
      });
    }
    const c = caps as Record<string, unknown>;
    const features = (c.features as Record<string, boolean>) ?? {};
    const pages = (c.pages as Record<string, boolean>) ?? {};
    const isSuper = Boolean(c.is_super_admin);
    if (!isSuper) {
      // §13.3: decision_report rides agent_proposals (rendering mutates no
      // project state); every other artifact demands agent_apply.
      const baseFeature = ARTIFACT_BASE_FEATURE[String(proposal.artifact_type)] ?? "agent_apply";
      if (features[baseFeature] !== true) {
        return jsonResponse({
          error: `Applying this proposal isn't enabled for your account (${baseFeature}). Contact an administrator.`,
          type: "FORBIDDEN",
        });
      }
      const rights = ARTIFACT_RIGHTS[String(proposal.artifact_type)] ?? { features: [], pages: [] };
      for (const right of rights.features) {
        if (features[right] !== true) {
          return jsonResponse({
            error: `This apply also requires the "${right}" capability — the same right the manual edit needs.`,
            type: "FORBIDDEN",
          });
        }
      }
      for (const page of rights.pages) {
        if (pages[page] !== true) {
          return jsonResponse({
            error: `This apply also requires access to the ${page} page — the same right the manual edit needs.`,
            type: "FORBIDDEN",
          });
        }
      }
      // D276: and the PROJECT right the same change needs by hand on this project
      // (`agent_artifact_project_rights`) — the account-wide grants above say nothing about
      // a Viewer member. The same function `review_agent_proposal` refuses an approval with.
      const { data: projectRefusal, error: projectRefusalErr } = await svc.rpc("agent_project_right_refusal", {
        p_user_id: userId,
        p_project_id: projectId,
        p_artifact_type: String(proposal.artifact_type),
      });
      if (projectRefusalErr) {
        return jsonResponse({
          error: "Could not verify your rights on this project — try again.",
          type: "FORBIDDEN",
        });
      }
      if (typeof projectRefusal === "string" && projectRefusal) {
        return jsonResponse({ error: projectRefusal.replace(/^forbidden: /, ""), type: "FORBIDDEN" });
      }
    }

    // §13.4 quota — checked before anything mutates. A quota denial is a
    // typed error that does NOT increment apply_attempts (§10 Q21c: attempts
    // count real gate/RPC executions; the card's Retry stays available).
    const quotaViolation = await checkApplyQuota(svc, {
      artifactType: String(proposal.artifact_type),
      projectId,
      userId,
    });
    if (quotaViolation) {
      return jsonResponse({ error: quotaViolation, code: "quota_exceeded", type: "APPLY_FAILED" });
    }

    // ── Fixed artifact_type dispatch table (§4.4) — one row per GA'd stage ──
    const t0 = Date.now();
    let orgId: string | null = null;
    if (telemetryEnabled()) {
      try {
        const { data: u } = await svc.from("approved_users").select("organization_id").eq("id", userId).maybeSingle();
        orgId = (u as { organization_id?: string } | null)?.organization_id ?? null;
      } catch { /* attribution only */ }
    }
    const telemetry = makeTelemetry(svc, {
      user_id: userId,
      org_id: orgId,
      project_id: projectId,
      thread_id: (proposal.thread_id as string | null) ?? null,
      request_id: crypto.randomUUID(),
      agent_id: (proposal.agent_id as string | null) ?? null,
      model_code: (proposal.model_code as string | null) ?? null,
      provider_code: (proposal.provider_code as string | null) ?? null,
    });

    const fail = async (code: ApplyErrorCode, message: string) => {
      const { error: markErr } = await svc.rpc("mark_agent_proposal_apply_failed", {
        p_proposal_id: proposalId,
        p_error: `${code}: ${message}`,
      });
      if (markErr) console.error("mark_agent_proposal_apply_failed failed:", markErr.message);
      telemetry.emit("proposal.apply_failed", {
        artifact_type: proposal.artifact_type,
        provenance: proposal.provenance,
        status_reason: code,
        apply_attempts: Number(proposal.apply_attempts ?? 0) + 1,
      }, { proposal_id: proposalId, latency_ms: Date.now() - t0 });
      return jsonResponse({ error: message, code, type: "APPLY_FAILED" });
    };

    let result: ItemMasterApplyResult | ParameterEstimateApplyResult | NetworkMapApplyResult | PolicyBundleApplyResult | ModelCardApplyResult | ExperimentSpecApplyResult | DecisionReportApplyResult | RiskAlertApplyResult;
    try {
      switch (String(proposal.artifact_type)) {
        case "item_master_diff":
          result = await applyItemMasterDiff(svc, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
          });
          break;
        case "parameter_estimate":
          // §4.4 row (v1.5): the item_master_diff sequence with the method
          // recomputation swapped in (parameterEstimateApply.ts).
          result = await applyParameterEstimate(svc, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
          });
          break;
        case "network_map_diff":
          // §4.4 row (v1.5 Phase 4b): live evidence re-verification, then
          // the existing supplier/lane mutation paths — no new write path
          // (networkMapDiffApply.ts).
          result = await applyNetworkMapDiff(svc, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
            userId,
            userEmail,
          });
          break;
        case "policy_bundle_diff":
          result = await applyPolicyBundle(svc, {
            projectId,
            title: String(proposal.title ?? "policy bundle"),
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
            userId,
            userEmail,
          });
          break;
        case "model_card_draft":
          result = await applyModelCard(svc, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            userId,
            userEmail,
          });
          break;
        case "experiment_spec": {
          // §4.4 row 4: scenario write path + dispatchExperimentRun — the
          // ONLY dispatch path. The worker-queue env is verified before any
          // write so a misconfigured deployment fails clean.
          const upstashUrl = cleanEnv("UPSTASH_REDIS_REST_URL");
          const upstashToken = cleanEnv("UPSTASH_REDIS_REST_TOKEN");
          if (!upstashUrl || !upstashToken) {
            return await fail("rpc_error", "the worker queue is not configured in this deployment (UPSTASH_REDIS_REST_URL/TOKEN)");
          }
          const upstash = async (cmd: (string | number)[]): Promise<unknown> => {
            const res = await fetch(upstashUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(cmd),
            });
            if (!res.ok) throw new Error(`upstash ${res.status}: ${await res.text()}`);
            return res.json();
          };
          result = await applyExperimentSpec(svc, { upstash }, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
            userId,
            // The approving human's checkbox from the card — honored inside
            // only when the stored findings_preview displayed warn findings.
            acknowledgeWarnings: body.acknowledgeWarnings === true,
          });
          break;
        }
        case "risk_alert": {
          // §4.4 risk_alert row (v1.5 Phase 4d): live re-verification, then
          // the LINKED experiment_spec applies through applyExperimentSpec →
          // dispatchExperimentRun — the ONLY dispatch path, never a parallel
          // one. Impact stays pending until the run completes (§18.3).
          const upstashUrl = cleanEnv("UPSTASH_REDIS_REST_URL");
          const upstashToken = cleanEnv("UPSTASH_REDIS_REST_TOKEN");
          if (!upstashUrl || !upstashToken) {
            return await fail("rpc_error", "the worker queue is not configured in this deployment (UPSTASH_REDIS_REST_URL/TOKEN)");
          }
          const upstash = async (cmd: (string | number)[]): Promise<unknown> => {
            const res = await fetch(upstashUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${upstashToken}`, "Content-Type": "application/json" },
              body: JSON.stringify(cmd),
            });
            if (!res.ok) throw new Error(`upstash ${res.status}: ${await res.text()}`);
            return res.json();
          };
          result = await applyRiskAlert(svc, { upstash }, {
            projectId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            grounding: (proposal.grounding ?? {}) as Record<string, unknown>,
            userId,
            acknowledgeWarnings: body.acknowledgeWarnings === true,
          });
          break;
        }
        case "decision_report": {
          // §16.1 apply row: resolve → render (XLSX/PDF) → workspace upload →
          // user_files rows → {file_ids, paths}. Same module the
          // report-render function serves, executed in-process (the
          // dispatch.ts precedent — one render path, never a parallel one).
          // deno-lint-ignore no-explicit-any
          const storage = (svc as any).storage;
          result = await applyDecisionReport(svc, {
            writers: makeWriters(),
            upload: async (path, bytes, contentType) => {
              const { error } = await storage.from("workspace").upload(path, bytes, { contentType, upsert: false });
              return { error: error ? { message: String(error.message) } : null };
            },
            remove: async (paths) => {
              await storage.from("workspace").remove(paths);
            },
          }, {
            projectId,
            proposalId,
            payload: (proposal.payload ?? {}) as Record<string, unknown>,
            userId,
          });
          break;
        }
        default:
          // Later stages add their §4.4 rows here; an artifact this deployment
          // cannot apply is a typed error, not an attempt.
          return jsonResponse({
            error: `No apply mapping is enabled for artifact type "${proposal.artifact_type}" in this deployment.`,
            type: "UNSUPPORTED_ARTIFACT",
          });
      }
    } catch (e) {
      if (e instanceof ApplyFailure) return await fail(e.code, e.message);
      return await fail("rpc_error", e instanceof Error ? e.message : "apply failed");
    }

    const { error: markErr } = await svc.rpc("mark_agent_proposal_applied", {
      p_proposal_id: proposalId,
      p_result: result,
    });
    if (markErr) {
      // The mutation went through the gates but the bookkeeping write failed;
      // surface loudly — a retry will no-op through the idempotent path.
      console.error("mark_agent_proposal_applied failed:", markErr.message);
      return jsonResponse({ error: `Applied, but recording the outcome failed: ${markErr.message}`, type: "APPLY_ERROR" });
    }
    telemetry.emit("proposal.applied", {
      artifact_type: proposal.artifact_type,
      provenance: proposal.provenance,
    }, { proposal_id: proposalId, latency_ms: Date.now() - t0 });
    if (String(proposal.artifact_type) === "decision_report") {
      // §16.3 report.rendered — structured ids/counts only, never text (§7.5).
      const r = result as DecisionReportApplyResult;
      telemetry.emit("report.rendered", {
        template_id: r.template_id,
        format: r.format,
        files: r.file_ids.length,
        total_bytes: r.total_bytes,
      }, { proposal_id: proposalId, latency_ms: Date.now() - t0 });
    }

    return jsonResponse({ ok: true, applied_result: result });
  } catch (err) {
    console.error("agent-apply error:", err);
    return jsonResponse({
      error: err instanceof Error ? err.message : "Apply failed.",
      type: "APPLY_ERROR",
    });
  }
});

// M4 Readiness and model check (ai-agents.md §26.3) + WP M.5 next steps.
// "Can I run?", "what's missing?", "is my model valid?" — answered by the
// SAME pre-run gate the dispatcher enforces (runValidationGate over the
// newest saved policy version) and the validation status the V&V tools read.
// Every finding ends with the surface that fixes it (fixFor), so a gap is a
// next step, not a dead end.

import { loadGateDataset, runValidationGate } from "../../_shared/validationGate.ts";
import { callTool, dbOf, fixFor, type Skill, type SkillInput, type SkillResult } from "./common.ts";

const READINESS_WORDS =
  /\b((?:can|could|may)\s+i\s+(?:run|simulate|start)|ready\s+to\s+(?:run|simulate)|run[-\s]?ready|what(?:'s|\s+is|\s+data\s+is)\s+missing|missing\s+data|data\s+gaps?|what\s+(?:is\s+)?blocking|blockers?|is\s+(?:my|the|our)\s+model\s+(?:valid(?:ated)?|ready|ok|credible)|pre[-\s]?run\s+check)\b/i;

export const readinessSkill: Skill = {
  id: "readiness",
  drafts: false,
  describe: "runs the same pre-run check the Lab uses, reports blockers and warnings, the validation badge, and how to fix each gap",
  example: "can I run my model?  ·  what data is missing?",
  recognize(input: SkillInput) {
    return READINESS_WORDS.test(input.utterance) ? {} : null;
  },
  async run(ctx, _match, _input, opts): Promise<SkillResult> {
    const db = dbOf(ctx);
    const calls: SkillResult["calls"] = [];
    let version: Record<string, unknown> | null = null;
    try {
      const { data } = await db.rpc("list_policy_versions", { p_project_id: ctx.projectId });
      const id = String((Array.isArray(data) ? data : [])[0]?.id ?? "");
      if (id) {
        const { data: v } = await db.from("policy_versions").select("id,label,snapshot").eq("id", id).maybeSingle();
        version = (v as Record<string, unknown> | null) ?? null;
      }
    } catch { /* handled below */ }
    if (!version) {
      return {
        reply: "Not yet: this project has no saved policy version, and every run binds one. Save a version on /policies (or say \"configure my policies\" if the Policy Configurator is enabled), then ask again.",
        parts: [], calls, outcome: "no_policy_version",
      };
    }
    const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
    const defaults = ("defaults" in snapshot ? snapshot.defaults : snapshot) as Record<string, unknown>;
    let findings: Array<{ severity: string; field: string; policy: string; message: string; rows?: string[] }> = [];
    let status = "pass";
    try {
      const dataset = await loadGateDataset(ctx.supabase, ctx.projectId);
      const gate = runValidationGate({ dataset, snapshotDefaults: defaults ?? {}, disruptionSchedule: [], acknowledgeWarnings: false });
      if (gate) {
        status = gate.status;
        findings = gate.findings.filter((f) => f.severity === "block" || f.severity === "warn");
      }
    } catch (e) {
      return { reply: `I couldn't run the pre-run check: ${e instanceof Error ? e.message : "read failed"}.`, parts: [], calls, outcome: "error" };
    }
    const validation = await callTool(calls, ctx, "get_validation_status", {});
    const badgeRow = (validation.kind === "table"
      ? ((validation.data as { rows?: unknown[][] })?.rows ?? [])[0]
      : null) as unknown[] | null;
    const badge = badgeRow ? String(badgeRow[1] ?? "") : "";

    const blocks = findings.filter((f) => f.severity === "block");
    const warns = findings.filter((f) => f.severity === "warn");
    const label = String(version.label ?? String(version.id).slice(0, 8));
    const verdict = blocks.length > 0
      ? `Not yet — ${blocks.length} blocking item${blocks.length === 1 ? "" : "s"} stop a run on policy version "${label}".`
      : warns.length > 0
      ? `Yes, with ${warns.length} warning${warns.length === 1 ? "" : "s"} you'll be asked to acknowledge on policy version "${label}".`
      : `Yes — the pre-run check passes cleanly on policy version "${label}".`;
    const badgeLine = badge
      ? ` The model's validation badge is **${badge}**${badge === "validated" ? "." : " — say \"what does it take to validate my model?\" for the V&V steps."}`
      : " No validation card exists yet, so results carry no credibility badge.";
    const rows = [...blocks, ...warns].slice(0, 20).map((f) => [
      f.severity,
      f.field,
      f.message.length > 160 ? `${f.message.slice(0, 157)}…` : f.message,
      fixFor(f, opts.enabledAgents),
    ]);
    const first = blocks[0] ?? warns[0];
    return {
      reply: verdict + badgeLine + (first ? ` First fix: ${fixFor(first, opts.enabledAgents)}.` : ""),
      parts: rows.length ? [{ kind: "table", data: { columns: ["Severity", "Field", "Finding", "How to fix"], rows } }] : [],
      calls,
      outcome: status === "pass" ? "ready" : blocks.length ? "blocked" : "warnings",
    };
  },
};

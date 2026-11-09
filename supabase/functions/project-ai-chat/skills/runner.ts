// One skill turn (ai-agents.md §26 WP M.1 + M.3) — what index.ts runs when
// a skill claims the message, and what the §21.4 resume runs when a skill's
// run finishes.
//
//   1. run the skill (code: resolve, read, draft through the handlers);
//   2. if it offers an interpretation, ONE tool-free model call writes it;
//      with the verifier on, the prose is verified (§22.3) and DROPPED on a
//      failure — the deterministic answer always ships, so a rate-limited
//      provider cannot take a skill down;
//   3. if it filed a card, it files a plan (M.3: continuity) so the answer
//      arrives after approval and run completion without a second question.

import { runChat, type ChatRunResult } from "../providers.ts";
import { executeTool, type ToolContext, type ToolEnvelope } from "../tools.ts";
import { planToolEnabled } from "../planTools.ts";
import { verifyWithRetry, type RecordedToolCall, type VerifyWithRetryResult } from "../verifier.ts";
import type { RequestBudget } from "../budgets.ts";
import type { Skill, SkillInput, SkillOptions, SkillResult } from "./common.ts";

/** No tools, no project block — every number it may use is in the handoff. */
export const SKILL_INTERPRETER_SYSTEM =
  "You are the Supply Chain assistant, briefing a teammate on a simulation result or a documented platform fact. " +
  "You have no tools. Use only the numbers and passages given in the message, write plain sentences " +
  "(no headers, no tables, no bullet lists), and never present a difference as statistically significant " +
  "unless the message says it is.";

export type SkillVerdict = VerifyWithRetryResult<{ reply: string; calls: RecordedToolCall[]; result: ChatRunResult }>;

export interface SkillTurn {
  result: SkillResult;
  /** The shipped reply (deterministic + verified interpretation). */
  reply: string;
  parts: Array<{ kind: string; data: unknown }>;
  verdict: SkillVerdict | null;
  planId: string | null;
}

/** The note on a skill plan's answer step: which skill to re-run on resume,
 * and the question it answers (§21.1 caps a note at 200 chars). */
export const SKILL_NOTE_PREFIX = "skill:";
export function skillNote(skillId: string, utterance: string): string {
  return `${SKILL_NOTE_PREFIX}${skillId}|${utterance.replace(/\s+/g, " ").slice(0, 200 - SKILL_NOTE_PREFIX.length - skillId.length - 1)}`;
}
export function parseSkillNote(note: string | undefined): { skillId: string; utterance: string } | null {
  if (!note || !note.startsWith(SKILL_NOTE_PREFIX)) return null;
  const body = note.slice(SKILL_NOTE_PREFIX.length);
  const bar = body.indexOf("|");
  if (bar < 0) return null;
  return { skillId: body.slice(0, bar), utterance: body.slice(bar + 1) };
}

async function filePlan(ctx: ToolContext, skill: Skill, input: SkillInput, proposalId: string, title: string): Promise<{ planId: string | null; part: { kind: string; data: unknown } | null }> {
  if (!planToolEnabled() || !ctx.draft?.threadId) return { planId: null, part: null };
  const note = skillNote(skill.id, input.utterance);
  const steps = (check: string, run: string, ref?: Record<string, string>) => [
    { id: "check", label: "Look for a finished run that already answers it", status: check },
    { id: "run", label: "Run it — waits for your approval", status: run, ...(ref ? { ref } : {}) },
    { id: "answer", label: "Answer from the results", status: "pending", note },
  ];
  const created = await executeTool("update_task_plan", { title: title.slice(0, 140), steps: steps("active", "pending") }, ctx);
  const planId = created.kind === "plan" ? String((created.data as Record<string, unknown>).plan_id ?? "") : "";
  if (!planId) return { planId: null, part: null };
  await executeTool("update_task_plan", { plan_id: planId, steps: steps("done", "active") }, ctx);
  const last: ToolEnvelope = await executeTool(
    "update_task_plan",
    { plan_id: planId, steps: steps("done", "awaiting_approval", { proposal_id: proposalId }) },
    ctx,
  );
  return { planId, part: last.kind === "plan" ? { kind: "plan", data: last.data } : null };
}

export async function runSkillTurn(args: {
  skill: Skill;
  match: unknown;
  input: SkillInput;
  opts: SkillOptions;
  ctx: ToolContext;
  modelId: string | undefined | null;
  personaId: string | null;
  budget: RequestBudget;
  verifierOn: boolean;
  projectId: string;
  /** Resume turns re-run the skill; they never file a second plan. */
  resuming?: boolean;
}): Promise<SkillTurn> {
  const result = await args.skill.run(args.ctx, args.match, args.input, args.opts);
  let reply = result.reply;
  let verdict: SkillVerdict | null = null;

  if (result.interpretation) {
    try {
      const interp = await runChat(args.modelId, result.interpretation, [], null, args.personaId, {
        system: SKILL_INTERPRETER_SYSTEM,
        budget: args.budget,
      });
      let prose = interp.blocked ? "" : (interp.reply ?? "").trim();
      if (prose && args.verifierOn) {
        const v = await verifyWithRetry({
          projectId: args.projectId,
          db: args.ctx.supabase,
          userMessage: args.input.utterance,
          contextText: result.interpretation,
          attempt: { reply: prose, calls: result.calls as RecordedToolCall[], result: interp },
          retry: null,
          nearestAction: null,
        });
        if (v.fallback) prose = "";
        else verdict = { ...v, reply: prose };
      }
      if (prose) {
        reply = result.leadWithInterpretation ? `${prose}${result.footer ? `\n\n${result.footer}` : ""}` : `${reply}\n\n${prose}`;
      }
    } catch (e) {
      console.warn(`[skill:${args.skill.id}] interpretation skipped:`, e instanceof Error ? e.message : e);
    }
  }

  const parts = [...result.parts];
  let planId: string | null = null;
  if (result.proposal && !result.proposal.duplicate && !args.resuming) {
    try {
      const filed = await filePlan(args.ctx, args.skill, args.input, result.proposal.proposal_id, result.proposal.title);
      planId = filed.planId;
      if (filed.part) parts.push(filed.part);
    } catch (e) {
      // A plan is continuity, not a gate: the card stands without it.
      console.warn(`[skill:${args.skill.id}] plan filing skipped:`, e instanceof Error ? e.message : e);
    }
  }
  return { result, reply, parts, verdict, planId };
}

/** §21.4 resume, skill-shaped: the run bound to the plan finished. Re-run
 * the skill on its stored question (now a cache hit), then close the plan:
 * run → done, answer → active → done (two calls: §21.1 rule 3). */
export async function closeSkillPlan(
  ctx: ToolContext,
  plan: { id: string; steps: Array<Record<string, unknown>> },
  answered: boolean,
  /** The step that waited on the run — "run", or an appended "run-retry"
   * when a Retry rebound the plan (planTools.ts, §10 entry 38(ah)). */
  runStepId = "run",
): Promise<{ kind: string; data: unknown } | null> {
  const base = plan.steps.map((s) => ({ ...s }));
  const set = (id: string, status: string) => base.map((s) => (s.id === id ? { ...s, status } : s));
  let steps = set(runStepId, "done");
  await executeTool("update_task_plan", { plan_id: plan.id, steps }, ctx);
  steps = steps.map((s) => (s.id === "answer" ? { ...s, status: "active" } : s));
  await executeTool("update_task_plan", { plan_id: plan.id, steps }, ctx);
  steps = steps.map((s) => (s.id === "answer" ? { ...s, status: answered ? "done" : "failed" } : s));
  const last = await executeTool("update_task_plan", { plan_id: plan.id, steps }, ctx);
  return last.kind === "plan" ? { kind: "plan", data: last.data } : null;
}

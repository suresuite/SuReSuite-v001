import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { postPlanResume } from "@/lib/chat/planResume";

/**
 * Proposal fabric client hooks (ai-agents.md §4.6): fetch via the
 * list_agent_proposals RPC (which lazily expires stale cards), live updates
 * via the realtime publication on public.proposals, actions via
 * review_agent_proposal + the agent-apply edge function (Stage 1).
 */

export type ProposalStatus = "draft" | "proposed" | "approved" | "applied" | "rejected" | "expired";

export interface Proposal {
  id: string;
  project_id: string;
  agent_id: string;
  artifact_type: string;
  schema_version: number;
  title: string;
  payload: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
  provenance: "deterministic" | "llm_drafted" | "user_supplied";
  grounding: Record<string, unknown>;
  status: ProposalStatus;
  status_reason: string | null;
  expires_at: string;
  apply_attempts: number;
  apply_error: string | null;
  applied_result: Record<string, unknown> | null;
  applied_at: string | null;
  thread_id: string | null;
  model_code: string | null;
  provider_code: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Apply retry cap — after this many failed applies the card offers Reject
 * only (DEFAULT 3, ai-agents.md §4.2). */
export const APPLY_RETRY_CAP = 3;

// The proposals table/RPCs postdate the generated supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Reviewer-side apply options (ai-agents.md §5.4): acknowledge_warnings can
 * only be set by the approving human on the card — the server honors it only
 * when the card displayed warn findings (payload.findings_preview). */
export interface ApplyOptions {
  acknowledgeWarnings?: boolean;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BoundPlanStep {
  planId: string;
  threadId: string;
  stepId: string;
  /** "failed" when an earlier apply attempt failed the step (§13.6 rule 3):
   * a later successful Retry then asks the server to rebind (38(ah)). */
  status: "awaiting_approval" | "failed";
}

/**
 * §21.4 approval resume (ai-agents.md, Phase H3): find the thread's active
 * plan step bound (`ref.proposal_id`) to this card. Best-effort — plan wiring
 * must never break the approve/reject UX, so callers swallow failures.
 */
async function findBoundPlanStep(proposalId: string, userId: string): Promise<BoundPlanStep | null> {
  const { data: prop } = await db
    .from("proposals").select("thread_id").eq("id", proposalId).maybeSingle();
  const threadId = (prop as { thread_id?: string | null } | null)?.thread_id ?? null;
  if (!threadId || !uuidRe.test(threadId)) return null;
  const { data: plans } = await db.rpc("list_chat_plans", { p_thread_id: threadId, p_user_id: userId });
  interface PlanRowLite {
    id: string;
    status: string;
    steps?: Array<{ id: string; status: string; ref?: { proposal_id?: string } }>;
  }
  for (const plan of (Array.isArray(plans) ? plans : []) as PlanRowLite[]) {
    if (plan.status !== "active") continue;
    const steps = plan.steps ?? [];
    const waiting = steps.find((s) => s.status === "awaiting_approval" && s.ref?.proposal_id === proposalId);
    if (waiting) return { planId: plan.id, threadId, stepId: waiting.id, status: "awaiting_approval" };
    const failed = steps.find((s) => s.status === "failed" && s.ref?.proposal_id === proposalId);
    if (failed) return { planId: plan.id, threadId, stepId: failed.id, status: "failed" };
  }
  return null;
}

interface ProposalActions {
  approve: (id: string, opts?: ApplyOptions) => Promise<string | null>;
  reject: (id: string, note?: string) => Promise<string | null>;
  retryApply: (id: string, opts?: ApplyOptions) => Promise<string | null>;
  recordViewed: (id: string) => void;
}

function useProposalActions(onChanged?: () => void): ProposalActions & { applyingIds: Set<string> } {
  const { user } = useAuth();
  const [applyingIds, setApplyingIds] = useState<Set<string>>(new Set());
  const viewedRef = useRef<Set<string>>(new Set());

  // §21.4 (H3): after the apply outcome, advance the bound plan step (ONE
  // RPC — advance_chat_plan_step) and, on a dispatched run, post the resume
  // turn. Rejection / typed apply failures (incl. quota_exceeded, §13.6 rule
  // 3) mark the step failed with the message as its note. Best-effort:
  // errors here never surface into the approve/reject UX.
  const advanceBoundStep = useCallback(async (
    id: string,
    outcome: { kind: "applied" } | { kind: "failed"; note: string },
  ): Promise<void> => {
    if (!user?.id) return;
    try {
      const bound = await findBoundPlanStep(id, user.id);
      if (!bound) return;
      if (bound.status === "failed") {
        // An earlier attempt already failed this step (terminal). A Retry
        // that succeeded dispatched a run nothing waits on: post the resume,
        // and the server APPENDS a step bound to that run (planTools.ts
        // runResumePreStep — the client never reopens a failed step).
        if (outcome.kind === "applied") postPlanResume(bound.threadId, bound.planId);
        return;
      }
      if (outcome.kind === "applied") {
        const { data: prop } = await db
          .from("proposals").select("applied_result").eq("id", id).maybeSingle();
        const runId = (prop as { applied_result?: { run_id?: string } } | null)?.applied_result?.run_id;
        if (!runId || !uuidRe.test(runId)) return;
        const { error } = await db.rpc("advance_chat_plan_step", {
          p_plan_id: bound.planId,
          p_step_id: bound.stepId,
          p_status: "awaiting_run",
          p_user_id: user.id,
          p_run_id: runId,
        });
        if (error) throw error;
        postPlanResume(bound.threadId, bound.planId);
      } else {
        const { error } = await db.rpc("advance_chat_plan_step", {
          p_plan_id: bound.planId,
          p_step_id: bound.stepId,
          p_status: "failed",
          p_user_id: user.id,
          p_note: outcome.note.slice(0, 200),
        });
        if (error) throw error;
      }
    } catch (e) {
      console.warn("[plans] bound-step advance failed:", e instanceof Error ? e.message : e);
    }
  }, [user?.id]);

  const invokeApply = useCallback(async (id: string, opts?: ApplyOptions): Promise<string | null> => {
    setApplyingIds((prev) => new Set(prev).add(id));
    try {
      // agent-apply ships in Stage 1; until then approved cards simply wait.
      const { data, error } = await db.functions.invoke("agent-apply", {
        body: {
          proposalId: id,
          userId: user?.id,
          userEmail: user?.email,
          ...(opts?.acknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
        },
      });
      if (error) {
        const msg = error.message ?? "Apply failed.";
        await advanceBoundStep(id, { kind: "failed", note: msg });
        return msg;
      }
      if (data?.error) {
        await advanceBoundStep(id, { kind: "failed", note: String(data.error) });
        return String(data.error);
      }
      await advanceBoundStep(id, { kind: "applied" });
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Apply failed.";
      await advanceBoundStep(id, { kind: "failed", note: msg });
      return msg;
    } finally {
      setApplyingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      onChanged?.();
    }
  }, [user?.id, user?.email, onChanged, advanceBoundStep]);

  const approve = useCallback(async (id: string, opts?: ApplyOptions): Promise<string | null> => {
    const { error } = await db.rpc("review_agent_proposal", {
      p_proposal_id: id,
      p_action: "approve",
      p_user_id: user?.id ?? null,
      p_user_email: user?.email ?? null,
    });
    if (error) return error.message ?? "Approve failed.";
    onChanged?.();
    // §4.2: approval immediately POSTs agent-apply.
    return invokeApply(id, opts);
  }, [user?.id, user?.email, invokeApply, onChanged]);

  const reject = useCallback(async (id: string, note?: string): Promise<string | null> => {
    // §21.4: rejection fails the bound plan step (note "rejected") BEFORE the
    // card leaves awaiting review — the persona acknowledges on the next turn.
    await advanceBoundStep(id, { kind: "failed", note: "rejected" });
    const { error } = await db.rpc("review_agent_proposal", {
      p_proposal_id: id,
      p_action: "reject",
      p_user_id: user?.id ?? null,
      p_user_email: user?.email ?? null,
      p_note: note ?? null,
    });
    onChanged?.();
    return error ? error.message ?? "Reject failed." : null;
  }, [user?.id, user?.email, onChanged, advanceBoundStep]);

  const retryApply = useCallback((id: string, opts?: ApplyOptions) => invokeApply(id, opts), [invokeApply]);

  const recordViewed = useCallback((id: string) => {
    if (viewedRef.current.has(id)) return;
    viewedRef.current.add(id);
    db.rpc("record_proposal_viewed", { p_proposal_id: id, p_user_id: user?.id ?? null })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn("[proposals] view event failed:", error.message);
      });
  }, [user?.id]);

  return { approve, reject, retryApply, recordViewed, applyingIds };
}

/** All proposals of one project (list RPC + realtime refresh). */
export function useProposals(projectId: string | null) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) { setProposals([]); return; }
    setLoading(true);
    try {
      const { data, error } = await db.rpc("list_agent_proposals", { p_project_id: projectId });
      if (!error && Array.isArray(data)) setProposals(data as Proposal[]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!projectId) return;
    const channel = db
      .channel(`proposals-${projectId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "proposals", filter: `project_id=eq.${projectId}` },
        () => refresh())
      .subscribe();
    return () => { db.removeChannel(channel); };
  }, [projectId, refresh]);

  const actions = useProposalActions(refresh);
  return { proposals, loading, refresh, ...actions };
}

/** One proposal by id — what a ProposalCard anchored in a thread renders.
 * Live-updates on realtime status changes, including from another tab (§4.6). */
export function useProposal(proposalId: string | null) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(Boolean(proposalId));

  const refresh = useCallback(async () => {
    if (!proposalId) { setProposal(null); return; }
    const { data, error } = await db
      .from("proposals").select("*").eq("id", proposalId).maybeSingle();
    if (!error) setProposal((data as Proposal) ?? null);
    setLoading(false);
  }, [proposalId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!proposalId) return;
    const channel = db
      .channel(`proposal-${proposalId}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "proposals", filter: `id=eq.${proposalId}` },
        (payload: { new: Proposal }) => setProposal(payload.new))
      .subscribe();
    return () => { db.removeChannel(channel); };
  }, [proposalId]);

  const actions = useProposalActions(refresh);
  const applying = proposalId ? actions.applyingIds.has(proposalId) : false;
  return { proposal, loading, refresh, applying, ...actions };
}

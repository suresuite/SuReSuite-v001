import { runLiveness, type RunLivenessInput } from "../../../supabase/functions/_shared/runLiveness";
import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Hourglass,
  ListChecks,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PART_TREATMENTS } from "@/lib/chat/partStyles";
import { useAuth } from "@/hooks/useAuth";
import { useProposal } from "@/hooks/useProposals";
import { resumeOnRunTransition } from "@/lib/chat/planResume";
import { supabase } from "@/integrations/supabase/client";

/**
 * PlanCard (ai-agents.md §21.2, Phase H3) — the live task-plan checklist.
 * The {kind:"plan"} part carries {plan_id} plus a render snapshot; this card
 * subscribes to the chat_plans row (the D3 pattern: row + part + realtime,
 * like a proposal card) so the checklist is CURRENT on any device and
 * survives reloads — the plan is server state, not client state.
 *
 * §17.2 grammar: plans are a content class (indigo left rail); the status
 * word is always printed next to the glyph; waiting is a visible plan state,
 * never a hung spinner. awaiting_approval steps embed the bound proposal's
 * status pill; awaiting_run steps render the live progress line — "run
 * dispatched — {done}/{target} replications" — read from the same
 * simulation_runs realtime row the Lab already subscribes to
 * (20260709000003; the worker streams rep_count_done per replication).
 */

export interface PlanStepData {
  id: string;
  label: string;
  status: string;
  note?: string;
  ref?: { proposal_id?: string; run_id?: string };
}

export interface PlanPartData {
  plan_id: string;
  title: string;
  status: string;
  steps: PlanStepData[];
}

interface PlanRow extends PlanPartData {
  thread_id: string | null;
}

// The chat_plans table/RPCs postdate the generated supabase types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function usePlanRow(snapshot: PlanPartData): PlanRow {
  const { user } = useAuth();
  const [row, setRow] = useState<PlanRow>({ ...snapshot, thread_id: null });

  const refresh = useCallback(async () => {
    if (!snapshot.plan_id || !user?.id) return;
    const { data, error } = await db.rpc("get_chat_plan", {
      p_plan_id: snapshot.plan_id,
      p_user_id: user.id,
    });
    const r = Array.isArray(data) ? data[0] : data;
    if (!error && r) {
      setRow({
        plan_id: String(r.id),
        title: String(r.title ?? "Task plan"),
        status: String(r.status ?? "active"),
        steps: Array.isArray(r.steps) ? (r.steps as PlanStepData[]) : [],
        thread_id: (r.thread_id as string | null) ?? null,
      });
    }
  }, [snapshot.plan_id, user?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!snapshot.plan_id) return;
    const channel = db
      .channel(`chat-plan-${snapshot.plan_id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_plans", filter: `id=eq.${snapshot.plan_id}` },
        // deno-style payload typing kept loose: REPLICA IDENTITY FULL rows
        (payload: { new: Record<string, unknown> }) => {
          const r = payload.new;
          setRow({
            plan_id: String(r.id),
            title: String(r.title ?? "Task plan"),
            status: String(r.status ?? "active"),
            steps: Array.isArray(r.steps) ? (r.steps as PlanStepData[]) : [],
            thread_id: (r.thread_id as string | null) ?? null,
          });
        })
      .subscribe();
    return () => { db.removeChannel(channel); };
  }, [snapshot.plan_id]);

  return row;
}

const STEP_GLYPHS: Record<string, { Icon: typeof CheckCircle2; className: string; spin?: boolean }> = {
  pending: { Icon: CircleDashed, className: "text-muted-foreground" },
  active: { Icon: Loader2, className: PART_TREATMENTS.plan.icon, spin: true },
  done: { Icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  failed: { Icon: XCircle, className: "text-destructive" },
  refused: { Icon: Ban, className: "text-muted-foreground" },
  awaiting_approval: { Icon: Hourglass, className: "text-amber-600 dark:text-amber-400" },
  awaiting_run: { Icon: Hourglass, className: PART_TREATMENTS.plan.icon },
};

/** The bound card's live status, embedded in the checklist (§21.2). */
function ProposalStatusPill({ proposalId }: { proposalId: string }) {
  const { proposal } = useProposal(proposalId);
  if (!proposal) return null;
  return (
    <span className={cn("rounded-sm px-1.5 py-px text-[10.5px] font-medium", "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
      proposal: {proposal.status}
    </span>
  );
}

/** §21.2 progress line for awaiting_run steps, fed by the simulation_runs
 * realtime row; a status transition to done/failed posts ONE debounced
 * resume turn for this run id (§21.4 run resume). */
function RunProgressLine({ runId, planId, threadId }: { runId: string; planId: string; threadId: string | null }) {
  const [run, setRun] = useState<RunLivenessInput | null>(null);
  // Re-read the clock each minute, so "queued for N min" stays true while
  // the card is on screen (38(ai)).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (r: Record<string, unknown> | null) => {
      if (cancelled || !r) return;
      const next: RunLivenessInput = {
        status: String(r.status ?? ""),
        rep_count_done: Number(r.rep_count_done ?? 0) || 0,
        rep_count_target: Number(r.rep_count_target ?? 0) || 0,
        created_at: (r.created_at as string | null) ?? null,
        started_at: (r.started_at as string | null) ?? null,
      };
      setRun(next);
      if ((next.status === "done" || next.status === "failed") && threadId) {
        resumeOnRunTransition(runId, threadId, planId);
      }
    };
    const load = () =>
      db.from("simulation_runs")
        .select("status,rep_count_done,rep_count_target,created_at,started_at")
        .eq("id", runId)
        .maybeSingle()
        .then(({ data }: { data: Record<string, unknown> | null }) => apply(data));
    load();
    // 38(ai): the realtime UPDATE is not guaranteed to arrive (the owner's
    // S002 run finished while this card sat at 0/5 and never resumed). Re-read
    // the row each minute; a done/failed row posts the resume exactly as the
    // realtime path does (resumeOnRunTransition debounces per run id).
    const poll = setInterval(load, 60_000);
    const channel = db
      .channel(`plan-run-${runId}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "simulation_runs", filter: `id=eq.${runId}` },
        (payload: { new: Record<string, unknown> }) => apply(payload.new))
      .subscribe();
    return () => {
      cancelled = true;
      clearInterval(poll);
      db.removeChannel(channel);
    };
  }, [runId, planId, threadId]);

  if (!run) return null;
  const live = runLiveness(run, now);
  return (
    <span className={cn("text-[11.5px]", live.state === "moving" ? PART_TREATMENTS.plan.accent : "text-[#8a2a30]")}>
      {live.line}
    </span>
  );
}

export function PlanCard({ data }: { data: PlanPartData }) {
  const plan = usePlanRow(data);
  return (
    <div
      role="region"
      aria-label={`Task plan: ${plan.title}`}
      className={cn("my-2 px-3 py-2.5", PART_TREATMENTS.plan.card)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks className={cn("h-4 w-4 shrink-0", PART_TREATMENTS.plan.icon)} />
        <span className="text-[13px] font-semibold">{plan.title}</span>
        <span className="ml-auto text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
          {plan.status}
        </span>
      </div>
      {/* aria-live: step transitions are announced politely (§21.2). */}
      <ol aria-live="polite" className="mt-2 space-y-1">
        {plan.steps.map((s) => {
          const glyph = STEP_GLYPHS[s.status] ?? STEP_GLYPHS.pending;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <glyph.Icon className={cn("h-3.5 w-3.5 shrink-0", glyph.className, glyph.spin && "animate-spin")} />
              <span>{s.label}</span>
              {/* the status word is always printed — never color alone */}
              <span className="text-[11px] text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
              {s.status === "awaiting_approval" && s.ref?.proposal_id && (
                <ProposalStatusPill proposalId={s.ref.proposal_id} />
              )}
              {s.status === "awaiting_run" && s.ref?.run_id && (
                <RunProgressLine runId={s.ref.run_id} planId={plan.plan_id} threadId={plan.thread_id} />
              )}
              {s.note && <span className="text-[11px] text-muted-foreground">— {s.note}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

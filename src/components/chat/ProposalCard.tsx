import { useEffect, useRef, useState } from "react";
import { Lightbulb, Loader2 } from "lucide-react";
import {
  ProposalCardView,
  type Proposal as ProposalView,
  type ProposalRow,
} from "@/components/chat/ProposalCardView";
import { useProposal, type Proposal } from "@/hooks/useProposals";
import { EXPERIMENT_SPEC, experimentSpecRows, specGate } from "@/lib/chat/experimentSpecCard";

/**
 * Proposal card (ai-agents.md §4.6) — the reviewable unit of Layer B output,
 * anchored in-thread at the message that produced it.
 *
 * This is the CONTAINER: it resolves the proposal by id (live status via the
 * realtime publication) and owns the approve / reject / retry-apply actions.
 * The visuals are delegated to the presentational `ProposalCardView` (SuReSuite
 * visual language) — the card never renders numbers that aren't in the resolved
 * payload/applied_result (no client-side recomputation). Every existing call
 * site (`MessageBubble`, `ChatWorkspace`) keeps passing `{ proposalId }`.
 */

/** agent_id → display name (§4.5). */
const AGENT_NAME: Record<string, string> = {
  "data-steward": "Data Steward",
  "cost-estimator": "Cost Estimator",
  "network-cartographer": "Network Cartographer",
  "disruption-sentinel": "Disruption Sentinel",
  "policy-configurator": "Policy Configurator",
  "vv-analyst": "V&V Analyst",
  "experiment-designer": "Experiment Designer",
  explainer: "Explainer",
  "report-builder": "Report Builder",
};

/** provenance → the label the card shows; provenance is never implied (§4.6). */
const PROVENANCE_LABEL: Record<Proposal["provenance"], string> = {
  deterministic: "computed from your data",
  llm_drafted: "AI-drafted — verify",
  user_supplied: "as you specified",
};

function expiresIn(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `expires in ${hours}h`;
}

/** The view knows four states; map draft→proposed (still actionable) and the
 * lazily-expired card to the dimmed rejected treatment. */
function toViewStatus(status: Proposal["status"]): ProposalView["status"] {
  if (status === "expired") return "rejected";
  if (status === "draft") return "proposed";
  return status;
}

/** Flatten the artifact payload rows into the view's [table/entity/field/value/
 * low/high/method/source] shape — straight from the payload, never recomputed. */
function toRows(payload: Record<string, unknown> | undefined): ProposalRow[] {
  const rows = Array.isArray((payload as { rows?: unknown })?.rows)
    ? ((payload as { rows: Array<Record<string, unknown>> }).rows)
    : [];
  return rows.map((r) => {
    const sources = Array.isArray(r.sources)
      ? (r.sources as Array<Record<string, unknown>>)
          .map((s) => `${String(s.dataset ?? "")} (${String(s.vintage ?? "")})`)
          .join("; ")
      : undefined;
    return {
      table: r.table != null ? String(r.table) : undefined,
      entity: String(r.entity_id ?? r.entity ?? ""),
      field: String(r.field ?? ""),
      value: r.value == null ? "—" : String(r.value),
      low: r.low != null ? String(r.low) : undefined,
      high: r.high != null ? String(r.high) : undefined,
      method: r.method != null ? String(r.method) : undefined,
      source: sources ?? (r.source != null ? String(r.source) : undefined),
    };
  });
}

function toCitations(citations: Proposal["citations"]): string[] {
  if (!Array.isArray(citations)) return [];
  return citations
    .map((c) => `${String(c.kind ?? "ref")} ${String(c.ref ?? "")}`.trim())
    .filter(Boolean);
}

interface ProposalCardProps {
  /** Wear the mobile skin (v2 §4C). Passed straight through to the view; the
   *  container itself has no chrome of its own. */
  skin?: boolean;
  proposalId: string | null | undefined;
  /** §17.4: offer a follow-up utterance (prefilled into the composer) — used
   * for the post-apply "save this decision to project memory" suggestion. */
  onSuggestUtterance?: (utterance: string) => void;
}

export function ProposalCard({ proposalId, onSuggestUtterance, skin = false }: ProposalCardProps) {
  const { proposal, loading, approve, reject, retryApply, recordViewed } = useProposal(proposalId ?? null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // §17.4: the save-the-rationale suggestion appears only when THIS session
  // watched the card transition to applied — never retroactively on old cards.
  const [justApplied, setJustApplied] = useState(false);
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (proposal?.id) recordViewed(proposal.id);
  }, [proposal?.id, recordViewed]);

  useEffect(() => {
    if (!proposal) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = proposal.status;
    if (prev && prev !== "applied" && proposal.status === "applied") setJustApplied(true);
  }, [proposal, proposal?.status]);

  if (!proposalId) return null;
  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-sm border border-[--hair-border] px-3 py-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading proposal…
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="mt-2 rounded-sm border border-[--hair-border] px-3 py-2 text-[13px] text-muted-foreground">
        This proposal is no longer available.
      </div>
    );
  }

  const run = async (fn: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const err = await fn();
    if (err) setActionError(err);
    setBusy(false);
  };

  const isSpec = proposal.artifact_type === EXPERIMENT_SPEC;
  const gate = isSpec ? specGate(proposal.payload) : null;
  const view: ProposalView = {
    id: proposal.id,
    title: proposal.title,
    agent: AGENT_NAME[proposal.agent_id] ?? proposal.agent_id,
    agentId: proposal.agent_id,
    artifactType: proposal.artifact_type,
    provenance: PROVENANCE_LABEL[proposal.provenance] ?? proposal.provenance,
    status: toViewStatus(proposal.status),
    applyError: proposal.apply_error,
    appliedAt: proposal.applied_at ? new Date(proposal.applied_at).toLocaleString() : null,
    expiresLabel: expiresIn(proposal.expires_at),
    rows: isSpec ? experimentSpecRows(proposal.payload) : toRows(proposal.payload),
    citations: toCitations(proposal.citations),
    ...(gate ? { findings: gate.findings, ackRequired: gate.ackRequired } : {}),
  };

  return (
    <>
      <ProposalCardView
        skin={skin}
        proposal={view}
        onApprove={(id, opts) => run(() => approve(id, opts))}
        onReject={(id) => run(() => reject(id))}
        onRetry={(id, opts) => run(() => retryApply(id, opts))}
      />
      {actionError && (
        <div className="mt-2 rounded-sm border border-[#f0c7cb] bg-[#fdf2f3] px-2.5 py-1.5 text-[12.5px] text-[#8a2a30]">
          {actionError}
        </div>
      )}
      {/* §17.4: post-apply guidance — prefills a "Remember that…" message; the
          save itself rides the §14.4 consent path when the user sends it. */}
      {justApplied && proposal.status === "applied" && onSuggestUtterance && (
        <button
          type="button"
          onClick={() => onSuggestUtterance(`Remember that we applied "${proposal.title}" because `)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-[--hair-border] bg-background px-2.5 py-1 text-[12px] text-muted-foreground transition hover:text-foreground"
          title="Prefills a 'Remember that…' message — you add the rationale and send"
        >
          <Lightbulb className="h-3 w-3 shrink-0" />
          Save this decision to project memory
        </button>
      )}
    </>
  );
}

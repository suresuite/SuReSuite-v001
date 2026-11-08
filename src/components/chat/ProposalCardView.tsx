/**
 * ProposalCardView — PRESENTATIONAL proposal card for an AI-drafted artifact
 * (ai-agents.md §4.5/§4.6).
 *
 * This does NOT replace src/components/chat/ProposalCard.tsx. That component's
 * contract is `{ proposalId, onSuggestUtterance }` — it resolves the proposal
 * itself and MessageBubble renders it by id. Keep that container and have it
 * render THIS view with the resolved data, so existing call sites keep working
 * and only the visuals change.
 *
 * Provenance is never implied: the chip says "AI-drafted — verify" or
 * "computed from your data", the value table always shows [low, high], method
 * and source, and apply failures surface the server's reason with Retry
 * rather than a silent revert. Rejected cards stay in the thread at reduced
 * opacity — the audit trail is the point.
 */
import React, { useState } from "react";
import { AGENT_COLOR, AGENT_MONO, LAYER, TD, TH, tint } from "../intelligence/piUi";
import { cn } from "@/lib/utils";
import { FROZEN_CELL, FROZEN_CELL_ON_TINT } from '@/components/shared';

export interface ProposalRow {
  table?: string;
  entity: string;
  field: string;
  value: string;
  low?: string;
  high?: string;
  method?: string;
  source?: string;
}

export interface Proposal {
  id: string;
  title: string;
  agent: string;
  agentId?: string;
  artifactType: "parameter_estimate" | "item_master_diff" | string;
  provenance: string;
  status: "proposed" | "approved" | "applied" | "rejected";
  applyError?: string | null;
  appliedAt?: string | null;
  expiresLabel?: string;
  rows: ProposalRow[];
  citations?: string[];
  /** The pre-run check stored on the card at draft time (experiment specs,
   * §5.4 `findings_preview`): block + warn findings only. */
  findings?: Array<{ severity: string; field: string; message: string }>;
  /** Warnings and no block: the reviewer must acknowledge them to run. The
   * server honors the acknowledgment only because the card displayed them. */
  ackRequired?: boolean;
}

/** What the reviewer decided on the card, sent with the apply request. */
export interface ReviewOptions {
  acknowledgeWarnings?: boolean;
}

/**
 * Wear the mobile skin (v2 §4C). The card is already the panel's shape — a
 * hairline box with a 2px agent rule down its left edge — so `skin` only
 * moves it onto the separation model: the outer rule weight, the 4px radius,
 * a chip that is a chip rather than a grey wash, and a container query on the
 * value table so it sizes to the bubble it is inside. Desktop passes nothing
 * and renders exactly what it rendered before.
 */
const STATUS_COLOR = (p: Proposal) => {
  if (p.status === "applied") return LAYER.process;
  if (p.status === "rejected") return "#9a9a9a";
  if (p.status === "approved" && p.applyError) return LAYER.brand;
  return LAYER.firm;
};

export function ProposalCardView({
  proposal,
  onApprove,
  onReject,
  onRetry,
  skin = false,
}: {
  proposal: Proposal;
  onApprove: (id: string, opts?: ReviewOptions) => void;
  onReject: (id: string) => void;
  onRetry: (id: string, opts?: ReviewOptions) => void;
  skin?: boolean;
}) {
  const [ack, setAck] = useState(false);
  const color = AGENT_COLOR[proposal.agentId ?? ""] ?? LAYER.firm;
  const mono = AGENT_MONO[proposal.agentId ?? ""] ?? proposal.agent.slice(0, 2).toUpperCase();
  const isParam = proposal.artifactType === "parameter_estimate";
  const applying = proposal.status === "approved" && !proposal.applyError;
  const failed = proposal.status === "approved" && Boolean(proposal.applyError);
  const findings = proposal.findings ?? [];
  const blocked = findings.some((f) => f.severity === "block");
  const needsAck = Boolean(proposal.ackRequired) && (proposal.status === "proposed" || failed);
  const runOpts: ReviewOptions | undefined = proposal.ackRequired && ack ? { acknowledgeWarnings: true } : undefined;

  return (
    <div
      className={cn(
        "mt-2 border px-3 py-2.5",
        skin ? "m-cq rounded-[4px] border-[#d4d4d4] bg-white" : "rounded-sm border-[--hair-border]",
      )}
      style={{ borderLeft: "2px solid " + color, opacity: proposal.status === "rejected" ? 0.55 : 1 }}
    >
      {/* Inside a two-column wide band this card can be narrower than 320px,
          and the viewport no longer says so — the container query does
          (v2 §5.5). Below that width the head stacks rather than wrapping the
          status onto a line of its own. */}
      <div className={cn('flex flex-wrap items-center gap-2', skin && 'm-cq-stack')}>
        <span
          className="flex h-[22px] w-[22px] items-center justify-center rounded-sm font-mono text-[9px] font-semibold"
          style={{ background: tint(color, 0.12), color }}
        >
          {mono}
        </span>
        <span className="text-[13px] font-semibold text-foreground">{proposal.agent}</span>
        <span
          className={cn(
            "px-[7px] py-px text-[10.5px] font-medium",
            skin
              ? "rounded-[3px] border border-[#d4d4d4] font-mono text-[#525252]"
              : "rounded-sm bg-[#f4f4f4] text-muted-foreground",
          )}
        >
          {proposal.provenance}
        </span>
        <span
          className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em]"
          style={{ color: STATUS_COLOR(proposal) }}
        >
          {proposal.status}
        </span>
      </div>

      <div className="mt-1.5 text-[13.5px] font-medium text-foreground">{proposal.title}</div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {!isParam && <th className={cn(TH, FROZEN_CELL_ON_TINT)}>Table</th>}
              <th className={cn(TH, isParam && FROZEN_CELL_ON_TINT)}>Entity</th>
              <th className={TH}>Field</th>
              <th className={TH}>Value</th>
              {isParam && <th className={TH}>[low, high]</th>}
              {isParam && <th className={TH}>Method</th>}
              <th className={TH}>Source</th>
            </tr>
          </thead>
          <tbody>
            {proposal.rows.map((r, i) => (
              <tr key={i} className="hover:bg-[#fcfcfc]">
                {!isParam && <td className={cn(TD, "font-mono", FROZEN_CELL)}>{r.table}</td>}
                <td className={cn(TD, "font-mono", isParam && FROZEN_CELL)}>{r.entity}</td>
                <td className={TD}>{r.field}</td>
                <td className={cn(TD, "font-mono")}>{r.value}</td>
                {isParam && (
                  <td className={cn(TD, "font-mono")}>
                    [{r.low}, {r.high}]
                  </td>
                )}
                {isParam && <td className={cn(TD, "font-mono")}>{r.method}</td>}
                <td className={TD}>{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {Boolean(proposal.citations?.length) && (
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
          {proposal.citations!.map((c) => (
            <span key={c} className="mr-2">
              {c}
            </span>
          ))}
        </div>
      )}

      {findings.length > 0 && (
        <div className="mt-2 rounded-sm border border-[#ecd9a6] bg-[#fdf8ec] px-2.5 py-1.5 text-[12px] text-[#6b5414]">
          <div className="font-medium">
            Pre-run check: {blocked ? "blocked" : `${findings.length} warning${findings.length === 1 ? "" : "s"}`}
          </div>
          <ul className="mt-1 list-disc pl-4">
            {findings.map((f, i) => (
              <li key={i}>
                <span className="font-mono">{f.field}</span>: {f.message}
              </li>
            ))}
          </ul>
          {needsAck && (
            <label className="mt-1.5 flex items-start gap-1.5">
              <input
                type="checkbox"
                className="mt-[3px]"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>I've read these warnings — run anyway with the stated fallbacks.</span>
            </label>
          )}
          {blocked && (
            <div className="mt-1">The run cannot start until the blocking item is fixed. Reject this card, fix the data, and ask again.</div>
          )}
        </div>
      )}

      {proposal.status === "proposed" && proposal.expiresLabel && (
        <div className="mt-1.5 text-[11px] text-muted-foreground">{proposal.expiresLabel}</div>
      )}

      {applying && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[#8a6d1f]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: LAYER.firm }} />
          applying…
        </div>
      )}

      {failed && (
        <div className="mt-2 rounded-sm border border-[#f0c7cb] bg-[#fdf2f3] px-2.5 py-1.5 text-[12px] text-[#8a2a30]">
          {proposal.applyError}
        </div>
      )}

      {proposal.status === "applied" && (
        <div
          className="mt-2 rounded-sm px-2.5 py-1.5 text-[12px] text-[#0f6b60]"
          style={{ background: tint(LAYER.process, 0.12) }}
        >
          Applied · {proposal.appliedAt}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {proposal.status === "proposed" && (
          <>
            <button
              type="button"
              onClick={() => onApprove(proposal.id, runOpts)}
              disabled={blocked || (Boolean(proposal.ackRequired) && !ack)}
              title={proposal.ackRequired && !ack ? "Tick the box above to run with these warnings" : undefined}
              className="rounded-sm bg-foreground px-3 py-1.5 text-[12.5px] text-background disabled:opacity-40"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(proposal.id)}
              className="rounded-sm border border-[--hair-border] bg-background px-3 py-1.5 text-[12.5px] text-foreground"
            >
              Reject
            </button>
          </>
        )}
        {failed && (
          <>
            <button
              type="button"
              onClick={() => onRetry(proposal.id, runOpts)}
              disabled={blocked || (Boolean(proposal.ackRequired) && !ack)}
              title={proposal.ackRequired && !ack ? "Tick the box above to run with these warnings" : undefined}
              className="rounded-sm bg-foreground px-3 py-1.5 text-[12.5px] text-background disabled:opacity-40"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => onReject(proposal.id)}
              className="rounded-sm border border-[--hair-border] bg-background px-3 py-1.5 text-[12.5px] text-foreground"
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

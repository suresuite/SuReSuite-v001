/**
 * SC Intelligences — proposal (screen 10, handoff §2/§8).
 *
 * The only path from an intelligence to a policy version or a run queue.
 * Kicker → headline → diff panel → expected effect → why → sources, then the
 * two-button footer with the "nothing changes until you do" sentence.
 */
import * as React from "react";
import { MobilePageHeader, MobileActionBar } from "@/components/mobile";
import { IntelBadge } from "../primitives";
import { getIntel } from "../intel";
import { versionOrdinal } from "../format";
import { useProposal } from "@/hooks/useProposals";
import { EXPERIMENT_SPEC, specGate } from "@/lib/chat/experimentSpecCard";
import { usePolicies } from "@/hooks/usePolicies";
import type { PolicyBundle } from "@/lib/policies/schemas";

interface DiffRow {
  label: string;
  oldValue: string | null;
  newValue: string;
}

type PolicyDiff = {
  defaults?: Record<string, Record<string, unknown>>;
  overrides?: Array<{ scope: "node" | "edge"; target_key: string; family: string; patch: Record<string, unknown> }>;
};

function computeDiffRows(
  diff: PolicyDiff,
  defaults: PolicyBundle,
  overrides: Array<{ scope: string; target_key: string; family: string; patch: Record<string, unknown> }>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const fam = defaults as unknown as Record<string, Record<string, unknown> | undefined>;

  for (const [family, patch] of Object.entries(diff.defaults ?? {})) {
    for (const [key, newValue] of Object.entries(patch)) {
      const oldValue = fam[family]?.[key];
      rows.push({
        label: `${family} · ${key}`,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: String(newValue),
      });
    }
  }

  for (const ov of diff.overrides ?? []) {
    const existing = overrides.find(
      (o) => o.scope === ov.scope && o.target_key === ov.target_key && o.family === ov.family,
    );
    for (const [key, newValue] of Object.entries(ov.patch)) {
      const oldValue = existing?.patch?.[key] ?? fam[ov.family]?.[key];
      rows.push({
        label: `${ov.target_key} · ${key}`,
        oldValue: oldValue == null ? null : String(oldValue),
        newValue: String(newValue),
      });
    }
  }

  return rows;
}

export function ProposalScreen({
  proposalId,
  onBack,
  onAccepted,
  onRejected,
}: {
  proposalId: string;
  onBack: () => void;
  onAccepted: (versionLabel: string) => void;
  onRejected: () => void;
}) {
  const { proposal, loading, applying, approve, reject } = useProposal(proposalId);
  const { defaults, overrides, versions } = usePolicies(proposal?.project_id ?? null);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // §5.4: an experiment spec's pre-run warnings must be SHOWN and acknowledged
  // by the reviewer; the server honors the acknowledgment only then.
  const [ack, setAck] = React.useState(false);

  if (loading || !proposal) {
    return (
      <div className="flex h-[calc(100svh-var(--pi-chrome,170px))] flex-col bg-white">
        <MobilePageHeader variant="detail" title="Proposal" onBack={onBack} />
        <div className="px-[var(--m-gutter)] py-6 text-[13.5px] text-[#525252]">
          {loading ? "Loading proposal…" : "This proposal is no longer available."}
        </div>
      </div>
    );
  }

  const intel = getIntel(proposal.agent_id);
  const isPolicyDiff = proposal.artifact_type === "policy_bundle_diff";
  const gate = proposal.artifact_type === EXPERIMENT_SPEC ? specGate(proposal.payload) : null;
  const payload = proposal.payload as { diff?: PolicyDiff; rationale?: string; base_policy_version_id?: string | null };
  const diffRows = isPolicyDiff && payload.diff ? computeDiffRows(payload.diff, defaults, overrides) : [];

  const baseId = payload.base_policy_version_id ?? null;
  const baseOrdinal = versionOrdinal(versions, baseId);
  const fromLabel = baseOrdinal ? `v${baseOrdinal}` : "current";
  const toOrdinal = (baseOrdinal ?? versions.length) + 1;
  const toLabel = `v${toOrdinal}`;

  const why = payload.rationale ?? proposal.status_reason ?? "Computed from this project's own data.";
  const sources = Array.isArray(proposal.citations)
    ? proposal.citations.map((c) => `${String(c.kind ?? "ref")} ${String(c.ref ?? "")}`.trim()).filter(Boolean)
    : [];

  const run = async (fn: () => Promise<string | null>, onOk: () => void) => {
    if (busy || applying) return;
    setBusy(true);
    setActionError(null);
    const err = await fn();
    setBusy(false);
    if (err) setActionError(err);
    else onOk();
  };

  return (
    <div className="flex h-[calc(100svh-var(--pi-chrome,170px))] min-h-[420px] flex-col overflow-hidden bg-white">
      <MobilePageHeader variant="detail" title="Proposal" subtitle={`${intel.badge} · ${intel.name.toLowerCase()}`} onBack={onBack} />

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--m-gutter)] pb-4">
        <div className="mb-1 flex items-center gap-2">
          <IntelBadge id={proposal.agent_id} />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#525252]">
            {proposal.artifact_type.replace(/_/g, " ")}
          </span>
        </div>
        <h2 className="mb-3 text-[20px] font-semibold leading-tight tracking-[-0.019em] text-[#171717]">
          {proposal.title}
        </h2>

        {isPolicyDiff && (
          <div className="mb-4 overflow-hidden rounded-[4px] border border-[#d4d4d4]">
            <div className="flex items-center justify-between bg-[#fafafa] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#525252]">
              <span>change</span>
              <span className="tabular-nums normal-case tracking-normal">
                {fromLabel} → {toLabel}
              </span>
            </div>
            {diffRows.length === 0 && (
              <div className="px-3 py-3 text-[12.5px] text-[#525252]">No parameter changes in this diff.</div>
            )}
            {diffRows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 border-t border-[#e8e8ea] px-3 py-2 first:border-t-0">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#525252]">{r.label}</span>
                {r.oldValue != null && (
                  <>
                    <span className="font-mono text-[12px] text-[#9a9a9a] line-through">{r.oldValue}</span>
                    <span aria-hidden className="text-[#9a9a9a]">→</span>
                  </>
                )}
                <span className="font-mono text-[12px] font-semibold tabular-nums text-[#171717]">{r.newValue}</span>
              </div>
            ))}
            <div className="border-t border-[#e8e8ea] px-3 py-2 font-mono text-[10.5px] text-[#9a9a9a]">
              unchanged — everything else in these families
            </div>
          </div>
        )}

        <div className="mb-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a8a8a]">why</div>
          <p className="text-[13.5px] leading-[1.55] text-[#3f3f46] [text-wrap:pretty]">{why}</p>
        </div>

        {sources.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a8a8a]">sources</div>
            {sources.map((s, i) => (
              <div key={i} className="flex gap-2 border-t border-[#e8e8ea] py-1.5 text-[12px] first:border-t-0">
                <span className="font-mono text-[#bf2330]">[{i + 1}]</span>
                <span className="font-mono text-[#525252]">{s}</span>
              </div>
            ))}
          </div>
        )}

        {gate && gate.findings.length > 0 && (
          <div className="mb-4 rounded-[4px] border border-[#ecd9a6] bg-[#fdf8ec] px-3 py-2 text-[12.5px] text-[#6b5414]">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em]">pre-run check</div>
            {gate.findings.map((f, i) => (
              <div key={i} className="py-0.5">
                <span className="font-mono">{f.field}</span>: {f.message}
              </div>
            ))}
            {gate.ackRequired && (
              <label className="mt-1.5 flex items-start gap-2">
                <input type="checkbox" className="mt-[3px]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I've read these warnings — run anyway with the stated fallbacks.</span>
              </label>
            )}
            {gate.blocked && <div className="mt-1">The run cannot start until the blocking item is fixed.</div>}
          </div>
        )}

        {actionError && (
          <div className="mb-3 rounded-[4px] border border-[#f0c7cb] bg-[#fdf2f3] px-3 py-2 text-[12.5px] text-[#8a2a30]">
            {actionError}
          </div>
        )}
      </div>

      <MobileActionBar
        secondary={{ label: "Reject", onClick: () => run(() => reject(proposal.id), onRejected), disabled: busy }}
        primary={{
          label: isPolicyDiff ? `Save ${toLabel} & run` : "Accept",
          loading: busy || applying,
          disabled: Boolean(gate && (gate.blocked || (gate.ackRequired && !ack))),
          onClick: () =>
            run(
              () => approve(proposal.id, gate?.ackRequired && ack ? { acknowledgeWarnings: true } : undefined),
              () => onAccepted(toLabel),
            ),
        }}
        note={
          isPolicyDiff
            ? `Accepting writes policy version ${toLabel}. Nothing changes until you do.`
            : "Accepting applies this proposal. Nothing changes until you do."
        }
      />
    </div>
  );
}

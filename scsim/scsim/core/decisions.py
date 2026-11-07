# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""Decision traces — policy facet 11 (platform blueprint §6.1, ai-agents.md §5.5).

A decision-trace record is one policy DECISION, written where the decision is
made: the week, the policy, the entity it acted on, the rule that decided
(a ``rationale`` code from the policy's own closed vocabulary), the values the
rule read, and what it did. It is the substrate an explanation must cite —
"why didn't the backup supplier activate in week 14?" is answered by the
record that says ``coverage_above_threshold`` with the coverage it read, not by
a plausible story.

BEHAVIOUR-NEUTRAL BY CONSTRUCTION. Recording reads values the policy already
computed and appends a plain dict: it touches no state, draws no random number
and changes no order, so a run with the log on and the same run with it off
produce identical KPIs, series and frozen digests. The log is ON only for a
single-replication inspection run (``trace_verbosity=full_debug``, one
replication — the same rule ``ScenarioResult.item_series`` follows), so an
ordinary Monte Carlo run pays nothing for it.

CLOSED VOCABULARY. A policy declares ``rationale_codes`` (code → meaning) and
may record only those codes; an undeclared code raises, so the vocabulary the
registry publishes is the vocabulary the records carry.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

# Hard ceiling on records per run. A long horizon × many materials could
# otherwise make an inspection result very large; beyond this the log keeps
# counting but stops storing, and says so (`dropped`).
MAX_RECORDS = 50_000

Scalar = Any  # float | int | str | bool | None — kept JSON-plain on purpose


def _plain(v: Any) -> Scalar:
    """A JSON-plain copy of a value (numpy scalars → Python scalars)."""
    if v is None or isinstance(v, (bool, str)):
        return v
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if isinstance(v, int) or (hasattr(v, "dtype") and getattr(v.dtype, "kind", "") in "iu"):
        return int(v)
    return round(f, 9)


@dataclass
class DecisionLog:
    """Per-replication store of decision-trace records (a no-op when disabled)."""

    enabled: bool
    records: list[dict[str, Any]] = field(default_factory=list)
    dropped: int = 0

    def record(
        self,
        *,
        week: int,
        policy_id: str,
        catalog_ref: str,
        declared: Mapping[str, str],
        rationale: str,
        node_kind: str,
        node: str,
        inputs: Optional[Mapping[str, Any]] = None,
        decision: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if not self.enabled:
            return
        if rationale not in declared:
            raise ValueError(
                f"{policy_id}: rationale '{rationale}' is not in its declared "
                f"rationale_codes {sorted(declared)} (facet 11 closed vocabulary)"
            )
        if len(self.records) >= MAX_RECORDS:
            self.dropped += 1
            return
        self.records.append({
            "week": int(week),
            "policy": policy_id,
            "catalog_ref": catalog_ref,
            "node_kind": node_kind,
            "node": str(node),
            "rationale": rationale,
            "inputs": {k: _plain(v) for k, v in (inputs or {}).items()},
            "decision": {k: _plain(v) for k, v in (decision or {}).items()},
        })

    def export(self) -> dict[str, Any]:
        """The run-level payload: records in emission order, plus the drop count."""
        return {"records": list(self.records), "dropped": self.dropped, "max_records": MAX_RECORDS}

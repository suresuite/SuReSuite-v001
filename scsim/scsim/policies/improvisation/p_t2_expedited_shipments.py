# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-T.2 expedited_shipments — IMPROVISATION (Part IV §4.4). ✅

Context: premium freight pulls EXISTING in-transit forward — the strongest
long-disruption strategy (repeatable, cumulative). The asymmetry is
preserved by construction: it compresses time on goods already moving
(including arrivals deferred by an LT-extension event); it cannot conjure
units held back by a capacity cut (those sit in the supplier queue, which
this policy never touches).

Mechanics (Eqs. 18–19): at PH-90 (after the deferral mechanic, before
landing), pull just enough future in-transit quantity into this week's
landing slot to cover next week's projected requirement, earliest arrivals
first. Premium C^exp = pct · c_m per expedited unit → C^res ``expediting``.
"""
from __future__ import annotations

from typing import ClassVar, Literal

import numpy as np
from pydantic import Field

from scsim.core.context import SimContext
from scsim.core.phases import (
    FIRM_KNOWLEDGE,
    MATERIAL_DEMAND,
    ST_BACKLOG,
    ST_COST_LEDGER,
    ST_ON_HAND,
    ST_PIPELINE,
    Hook,
    PhaseId,
)
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.policies.base import PolicyParams, PolicyPlugin
from scsim.policies.registry import register_plugin


class ExpeditedShipmentsParams(PolicyParams):
    premium_pct_of_cost: float = Field(
        3.0, ge=1.0, le=50.0,
        json_schema_extra={"unit": "% of c_m per unit", "scope": "M", "notes": "C^exp_m."},
    )
    decision: Literal["revenue_positive", "always_during_disruption"] = Field(
        "revenue_positive",
        json_schema_extra={"unit": "enum", "scope": "G", "notes": "revenue_positive ✅."},
    )
    scope: Literal["disrupted_materials", "all"] = Field(
        "disrupted_materials",
        json_schema_extra={"unit": "enum", "scope": "G", "notes": "disrupted_materials ✅."},
    )


@register_plugin
class ExpeditedShipments(PolicyPlugin):
    id: ClassVar[str] = "expedited_shipments"
    catalog_ref: ClassVar[str] = "P-T.2"
    stage: ClassVar[Stage] = Stage.TRANSPORT
    strategy_class: ClassVar[StrategyClass] = StrategyClass.IMPROVISATION
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.RESPONSE_TIME
    requires_predeployment: ClassVar[bool] = False
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Premium freight pulls existing in-transit forward (Eqs. 18–19) — repeatable every "
        "week, hence the strongest long-disruption strategy. Cannot conjure units a capacity "
        "cut never shipped (supplier queue is out of reach)."
    )
    Params: ClassVar[type[PolicyParams]] = ExpeditedShipmentsParams
    # Facet 11: recorded for each in-scope material with a shortfall this week
    # (need > 0) — expedited, or why not. No shortfall is no decision.
    rationale_codes: ClassVar[dict[str, str]] = {
        "expedited_shortfall":
            "Next week's need exceeded stock plus what lands next week, so in-transit units were pulled forward at a premium.",
        "held_value_below_premium":
            "There was a shortfall, but the material's marginal value was not above the expediting premium, so nothing was pulled forward.",
        "held_nothing_in_transit":
            "There was a shortfall, but nothing later in the pipeline could be pulled forward.",
    }

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH90, priority=40,
                reads={FIRM_KNOWLEDGE, MATERIAL_DEMAND, ST_ON_HAND, ST_BACKLOG, ST_PIPELINE},
                writes={ST_PIPELINE, ST_COST_LEDGER},
                resolution="Runs after the deferral mechanic (priority 10) and before landing "
                           "(priority 90): expedited quantities land this week at a premium.",
            ),
        ]

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        p: ExpeditedShipmentsParams = self.params
        m = ctx.model
        visible = ctx.events_visible()
        if p.scope == "disrupted_materials" or p.decision == "always_during_disruption":
            if not visible:
                return

        if p.scope == "disrupted_materials":
            mats = np.unique(m.link_mat[ctx.visible_disrupted_links()])
        else:
            mats = np.arange(m.n_mats)
        if mats.size == 0:
            return

        t = ctx.week
        W = m.ring_width
        landing = ctx.pipeline_arrivals_between(t + 1, t + 2)
        backlog_mat = np.asarray(m.bom.T @ ctx.backlog).ravel()
        need = ctx.material_demand + backlog_mat - ctx.on_hand - landing

        for mat in mats:
            gap = float(need[mat])
            if gap <= 1e-9:
                continue
            seen = {"shortfall": gap, "decision_rule": p.decision}
            if p.decision == "revenue_positive":
                # Marginal value of one unit of m across its consumers vs the premium.
                col = m.bom_csc.getcol(int(mat))
                value = float((m.unit_price[col.indices] / col.data).max()) if col.nnz else 0.0
                premium_unit = m.mat_cost[mat] * p.premium_pct_of_cost / 100.0
                seen.update(unit_value=value, unit_premium=float(premium_unit))
                if value <= premium_unit:
                    self.decide(ctx, rationale="held_value_below_premium", node_kind="material",
                                node=m.mat_ids[mat], inputs=seen, decision={"pulled_forward": 0.0})
                    continue
            pulled = self._pull_forward(ctx, int(mat), gap)
            premium = pulled * m.mat_cost[mat] * p.premium_pct_of_cost / 100.0
            if pulled > 0:
                ctx.cost.add("expediting", premium)
            self.decide(
                ctx, rationale="expedited_shortfall" if pulled > 0 else "held_nothing_in_transit",
                node_kind="material", node=m.mat_ids[mat], inputs=seen,
                decision={"pulled_forward": float(pulled), "premium": float(premium) if pulled > 0 else 0.0},
            )

    def _pull_forward(self, ctx: SimContext, mat: int, qty: float) -> float:
        """Move up to ``qty`` from the earliest future slots into next week's landing."""
        m = ctx.model
        t = ctx.week
        W = m.ring_width
        remaining = qty
        pulled = 0.0
        for w in range(t + 2, t + W - 1):
            if remaining <= 1e-9:
                break
            slot = w % W
            for link in m.links_of_mat[mat]:
                have = ctx.pipeline[link, slot]
                if have <= 0:
                    continue
                take = min(have, remaining)
                ctx.move_pipeline(int(link), w, t + 1, take)
                remaining -= take
                pulled += take
                if remaining <= 1e-9:
                    break
        return pulled

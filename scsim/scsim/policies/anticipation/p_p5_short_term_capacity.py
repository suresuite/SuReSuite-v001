# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-P.5 short_term_capacity (overtime) — ANTICIPATION (Part IV §4.3). ✅

Context: overtime bites only when capacity binds (~2% of weeks in the
material-constrained manuscript case — the UI shows utilization next to
this toggle).

Mechanics (Eq. 22): at PH-40 compare the base-capacity feasible output
Q^base against the overtime-capacity output Q^o (greedy, materials
considered). Activate iff the marginal revenue beats the overtime premium:
(Q^o − Q^base)·u_p > C^o. The granted headroom δ^o feeds the default plan;
the premium is charged on the overtime units actually produced
(production_output − O_p) at PH-99.
"""
from __future__ import annotations

from typing import ClassVar, Literal

import numpy as np
from pydantic import Field

from scsim.core.context import SimContext
from scsim.core.mechanics import greedy_feasible
from scsim.core.phases import (
    DEMAND,
    FIRM_KNOWLEDGE,
    OVERTIME_CAPACITY,
    ST_BACKLOG,
    ST_COST_LEDGER,
    ST_ON_HAND,
    Hook,
    PhaseId,
)
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.policies.base import CostBreakdown, DataRequirement, PolicyParams, PolicyPlugin
from scsim.policies.registry import register_plugin


class ShortTermCapacityParams(PolicyParams):
    overtime_premium_pct_of_price: float = Field(
        5.0, ge=1.0, le=25.0,
        json_schema_extra={"unit": "% of u_p per overtime unit", "scope": "P", "notes": "C^o."},
    )
    max_overtime_factor: float = Field(
        1.5, ge=1.0, le=2.0,
        json_schema_extra={"unit": "× O_p", "scope": "P"},
    )
    activation: Literal["revenue_positive", "always_during_disruption"] = Field(
        "revenue_positive",
        json_schema_extra={"unit": "enum", "scope": "G", "notes": "revenue_positive ✅ (Eq. 22)."},
    )


@register_plugin
class ShortTermCapacity(PolicyPlugin):
    id: ClassVar[str] = "short_term_capacity"
    catalog_ref: ClassVar[str] = "P-P.5"
    stage: ClassVar[Stage] = Stage.PLANT
    strategy_class: ClassVar[StrategyClass] = StrategyClass.ANTICIPATION
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.PRODUCTION_CAPACITY
    requires_predeployment: ClassVar[bool] = False
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Overtime: pay-per-use plant headroom (Eq. 22). Bites only when production capacity "
        "binds — in material-constrained networks that is rare; check utilization first."
    )
    Params: ClassVar[type[PolicyParams]] = ShortTermCapacityParams
    # Facet 11: recorded for each product overtime COULD have raised output for
    # this week (capacity binds) — granted, or why not. A week in which
    # capacity does not bind is no decision and records nothing.
    rationale_codes: ClassVar[dict[str, str]] = {
        "granted_revenue_positive":
            "Overtime would raise output and the extra revenue exceeded the overtime premium, so overtime was granted.",
        "granted_during_disruption":
            "A disruption was visible to the firm and overtime would raise output, so overtime was granted.",
        "held_premium_exceeds_gain":
            "Overtime would raise output, but the overtime premium was not below the extra revenue, so it was not granted.",
    }
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = (
        DataRequirement(
            field="products.production_capacity", level="required",
            reason="Overtime only bites when base capacity binds; the engine "
                   "default max(2*demand, 1000) never binds, making this "
                   "policy a silent no-op.",
            fallback="production policy capacity_units_per_day x 7 x utilization",
        ),
    )

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH40, priority=40,
                reads={DEMAND, FIRM_KNOWLEDGE, ST_ON_HAND, ST_BACKLOG},
                writes={OVERTIME_CAPACITY},
            ),
        ]

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        p: ShortTermCapacityParams = self.params
        m = ctx.model
        if p.activation == "always_during_disruption" and not ctx.events_visible():
            return

        want = ctx.demand + ctx.backlog
        base_cap = np.minimum(want, m.capacity)
        ot_cap = np.minimum(want, m.capacity * p.max_overtime_factor)
        q_base, _ = greedy_feasible(m, base_cap, ctx.on_hand)
        q_ot, _ = greedy_feasible(m, ot_cap, ctx.on_hand)
        extra = q_ot - q_base
        if extra.sum() <= 1e-9:
            return

        gain = cost = None
        if p.activation == "revenue_positive":
            gain = float((extra * m.unit_price).sum())
            cost = float((extra * m.unit_price).sum()) * p.overtime_premium_pct_of_price / 100.0
            if gain <= cost:
                self._record(ctx, "held_premium_exceeds_gain", extra, q_base, gain, cost, None)
                return

        headroom = np.where(extra > 1e-9, m.capacity * (p.max_overtime_factor - 1.0), 0.0)
        ctx.write_overtime_extra(headroom)
        ctx.policy_state.setdefault(self.id, {})["granted"] = headroom > 0
        self._record(
            ctx,
            "granted_revenue_positive" if p.activation == "revenue_positive" else "granted_during_disruption",
            extra, q_base, gain, cost, headroom,
        )

    def _record(self, ctx: SimContext, rationale: str, extra, q_base, gain, cost, headroom) -> None:
        # Reads values on_phase already computed; changes nothing (facet 11).
        m = ctx.model
        for i in np.flatnonzero(extra > 1e-9):
            self.decide(
                ctx, rationale=rationale, node_kind="product", node=m.prod_ids[i],
                inputs={"base_capacity": float(m.capacity[i]), "base_output": float(q_base[i]),
                        "extra_output_possible": float(extra[i]),
                        "week_gain_all_products": gain, "week_premium_all_products": cost},
                decision={"overtime_granted": headroom is not None,
                          "headroom_units": float(headroom[i]) if headroom is not None else 0.0},
            )

    def cost_contribution(self, ctx: SimContext) -> CostBreakdown:
        # Premium on overtime units actually produced this week (Q_p beyond O_p).
        p: ShortTermCapacityParams = self.params
        cb = CostBreakdown()
        granted = ctx.policy_state.get(self.id, {}).get("granted")
        if granted is not None and granted.any():
            # STARTED output used the capacity (P-P.13: equal to `production_output`
            # whenever no product has a production lead time).
            ot_units = np.maximum(0.0, ctx.production_started - ctx.model.capacity) * granted
            premium = float((ot_units * ctx.model.unit_price).sum()) * \
                p.overtime_premium_pct_of_price / 100.0
            if premium > 0:
                cb.add("overtime", premium)
            ctx.policy_state[self.id]["granted"] = None
        return cb

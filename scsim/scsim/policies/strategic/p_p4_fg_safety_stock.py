# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-P.4 fg_safety_stock — STRATEGIC, MTS only (Part IV §4.2). M7 ✅.

Context: the only buffer DOWNSTREAM of production — keeps serving customers
when production is blocked (plant events, or material starvation from a
single-sourced BoM peer), at full COGS per unit held. Versus P-P.3 it is
likely submodular for short disruptions (same window, opposite sides of the
CODP) — run the synergy decomposition.

Mechanics: at PH-70 (priority 55, after the cycle-stock base mechanic) the
policy raises ``state.fg_target`` by the FG safety stock:

* ``service_level``: SS = z^FG · σ_D · √(production cycle = 1 wk)
* ``fixed_days``:    SS = forecast · days / 7
* ``fixed_units``:   SS = constant

``segmentation="abc_by_revenue"`` differentiates the service level by
revenue class (A keeps the configured level, B −2 pp, C −5 pp, floored at
80% — the v1 mapping, documented here and in the catalog). Weekly holding
on the planned buffer at full COGS flows to C^res as ``fg_ss_holding``.
"""
from __future__ import annotations

from typing import ClassVar, Literal, Optional

import numpy as np
from pydantic import Field
from scipy import stats as sps

from scsim.core.context import SimContext
from scsim.core.phases import (
    FORECAST,
    ST_COST_LEDGER,
    ST_FG_TARGET,
    Hook,
    PhaseId,
)
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.entities.scenario import Scenario
from scsim.policies.base import (
    CostBreakdown,
    DataRequirement,
    FeasibilityIssue,
    FeasibilityResult,
    PolicyParams,
    PolicyPlugin,
)
from scsim.policies.registry import register_plugin


class FgSafetyStockParams(PolicyParams):
    sizing: Literal["service_level", "fixed_days", "fixed_units"] = Field(
        "service_level", json_schema_extra={"unit": "enum", "scope": "P"},
    )
    service_level_pct: float = Field(
        95.0, ge=80.0, le=99.9,
        json_schema_extra={"unit": "%", "scope": "P", "notes": "z^FG_p."},
    )
    fixed_days_cover: float = Field(
        2.0, ge=0.0, le=12.0, json_schema_extra={"unit": "days", "scope": "P"},
    )
    fixed_units: Optional[float] = Field(
        None, ge=0,
        json_schema_extra={"unit": "units", "scope": "P", "notes": "sizing=fixed_units."},
    )
    holding_cost_rate: float = Field(
        20.0, ge=5.0, le=50.0,
        json_schema_extra={"unit": "%/yr of COGS", "scope": "P", "notes": "h^FG_p."},
    )
    segmentation: Literal["uniform", "abc_by_revenue"] = Field(
        "uniform",
        json_schema_extra={"unit": "enum", "scope": "G",
                           "notes": "abc_by_revenue: A = configured SL, B −2 pp, C −5 pp (floor 80)."},
    )


@register_plugin
class FgSafetyStock(PolicyPlugin):
    id: ClassVar[str] = "fg_safety_stock"
    catalog_ref: ClassVar[str] = "P-P.4"
    stage: ClassVar[Stage] = Stage.PLANT
    strategy_class: ClassVar[StrategyClass] = StrategyClass.STRATEGIC
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.DEMAND_SIDE
    requires_predeployment: ClassVar[bool] = True
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "The only buffer DOWNSTREAM of production (MTS only): keeps serving customers while "
        "production is blocked, and is the only feasible buffer when suppliers are "
        "single-sourced. Costs full COGS per unit held — versus P-P.3, likely submodular "
        "for short disruptions (same window, opposite sides of the CODP)."
    )
    Params: ClassVar[type[PolicyParams]] = FgSafetyStockParams
    # Facet 11: recorded for each MTS product in the week its buffer is first
    # set and in any week it changes — not every week it stays the same.
    rationale_codes: ClassVar[dict[str, str]] = {
        "buffer_service_level":
            "The FG buffer was sized from the service level and demand variability (z × σ).",
        "buffer_fixed_days":
            "The FG buffer was sized as a fixed number of days of forecast demand.",
        "buffer_fixed_units":
            "The FG buffer was set to a fixed number of units.",
        "buffer_zero_typed_level":
            "The product has a typed FG level (S, (s, S) or D), which IS the target, so no buffer was added on top.",
    }
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = (
        DataRequirement(
            field="products.sell_price", level="required",
            reason="Revenue-based ABC segmentation ranks products by price x "
                   "demand; the 1.0 price default collapses the classes.",
            fallback="demand-weighted average outbound unit_price",
            condition="segmentation=abc_by_revenue",
        ),
        DataRequirement(
            field="products.demand_cv", level="recommended",
            reason="FG buffer sizing scales with demand variability.",
            fallback="scenario demand_model.cv, then 0.30",
        ),
    )

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH70, priority=55,
                reads={FORECAST, ST_FG_TARGET},
                writes={ST_FG_TARGET, ST_COST_LEDGER},
                resolution="Adds the FG safety stock on top of the cycle-stock base target "
                           "written by mech.fg_target_base (priority 45) — ADR 0001.",
            ),
        ]

    def feasibility(self, scenario: Scenario) -> FeasibilityResult:
        from scsim.entities.enums import FulfillmentMode

        mts = [p.id for p in scenario.network.products
               if p.fulfillment_mode == FulfillmentMode.MTS]
        if not mts:
            return FeasibilityResult(False, (FeasibilityIssue(
                "error", "mts_only",
                "fg_safety_stock is MTS-only (§4.6 rule 1) and no product has "
                "fulfillment_mode='mts'"),))
        return FeasibilityResult.ok()

    def setup(self, ctx: SimContext) -> None:
        p: FgSafetyStockParams = self.params
        m = ctx.model
        z_level = np.full(m.n_prods, p.service_level_pct)
        if p.segmentation == "abc_by_revenue":
            revenue = m.mean_demand_p * m.unit_price
            order = np.argsort(-revenue)
            cum = np.cumsum(revenue[order]) / max(revenue.sum(), 1e-12)
            cls_sorted = np.where(cum <= 0.80, 0, np.where(cum <= 0.95, 1, 2))
            cls = np.empty(m.n_prods, dtype=int)
            cls[order] = cls_sorted
            z_level = np.maximum(80.0, p.service_level_pct - np.choose(cls, [0.0, 2.0, 5.0]))
        z = sps.norm.ppf(z_level / 100.0)
        sigma = np.sqrt(m.var_demand_p)
        ctx.policy_state[self.id] = {"z": z, "sigma": sigma, "ss_last": np.zeros(m.n_prods)}

    def _ss(self, ctx: SimContext) -> np.ndarray:
        p: FgSafetyStockParams = self.params
        m = ctx.model
        state = ctx.policy_state[self.id]
        if p.sizing == "service_level":
            ss = state["z"] * state["sigma"]  # √(1-week production cycle)
        elif p.sizing == "fixed_days":
            ss = ctx.forecast * p.fixed_days_cover / 7.0
        else:
            ss = np.full(m.n_prods, p.fixed_units or 0.0)
        # One source per number (WP 14.4, design doc §3.2): a TYPED level (S,
        # (s, S) or D) IS the target — the buffer is never added on top of it.
        return np.where(m.mts_mask & ~m.fg_typed, np.maximum(ss, 0.0), 0.0)

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        ss = self._ss(ctx)
        prev = ctx.policy_state[self.id].get("ss_recorded")
        ctx.policy_state[self.id]["ss_last"] = ss
        base = ctx.fg_target
        ctx.write_fg_target(ctx.fg_target + ss)
        if ctx.decisions.enabled:
            self._record(ctx, ss, base, prev)

    def _record(self, ctx: SimContext, ss: np.ndarray, base: np.ndarray, prev) -> None:
        # Reads values on_phase already computed; changes nothing (facet 11).
        p: FgSafetyStockParams = self.params
        m = ctx.model
        rationale = {"service_level": "buffer_service_level", "fixed_days": "buffer_fixed_days"}.get(
            p.sizing, "buffer_fixed_units")
        state = ctx.policy_state[self.id]
        for i in np.flatnonzero(m.mts_mask):
            if prev is not None and prev[i] == ss[i]:
                continue
            typed = bool(m.fg_typed[i])
            self.decide(
                ctx, rationale="buffer_zero_typed_level" if typed else rationale,
                node_kind="product", node=m.prod_ids[i],
                inputs={"sizing": p.sizing, "base_target": float(base[i]),
                        "z": float(state["z"][i]), "sigma": float(state["sigma"][i]),
                        "forecast": float(ctx.forecast[i])},
                decision={"safety_stock": float(ss[i]), "fg_target": float(base[i] + ss[i])},
            )
        state["ss_recorded"] = ss.copy()

    def cost_contribution(self, ctx: SimContext) -> CostBreakdown:
        # Weekly holding on the planned FG buffer at full COGS (h^FG/52 · COGS · SS).
        p: FgSafetyStockParams = self.params
        ss = ctx.policy_state[self.id]["ss_last"]
        cb = CostBreakdown()
        weekly = float((ctx.model.fg_unit_cogs * ss).sum()) * p.holding_cost_rate / 100.0 / 52.0
        if weekly > 0:
            cb.add("fg_ss_holding", weekly)
        return cb

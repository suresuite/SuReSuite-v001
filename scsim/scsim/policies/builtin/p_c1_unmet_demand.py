# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-C.1 unmet_demand_handling — BUILT_IN (Part IV §4.1). ✅ lost_sales.

Context: does an unservable order die (competitive markets) or wait
(contractual B2B)? Changes the economics of every strategy: backorders
convert lost revenue to delay cost.

Resident at PH-60. MTO: production Q_p is allocated FIFO to existing
backlog first, then to this week's demand; the rule decides what happens
to the remainder. Backorders age in weekly buckets and expire to lost
sales after ``backorder_horizon`` weeks.

PER ROW (WP 14.3, ADR 0002 decisions 4–5). A customer × product row may
carry its own backorder setting, horizon and cost (``row_overrides``, keyed
``<customer>::<product>``), and the project's ONE allocation rule may need
per-row inputs (``revenue_max``; row priorities or service targets, published
by P-C.2 at setup). Then the backlog is kept PER ROW — age buckets
``[rows × (max horizon + 1)]``, each row expiring at its own horizon — and
each product's supply (MTO: production output; MTS: what PH-30 shipped from
stock) is split across its rows by ``core/allocation.py``, oldest backlog
first within a row. ``ctx.backlog`` stays the product sum for every existing
reader, ``ctx.backlog_rows`` carries the rows, and the per-row fill rate,
lost units and backorder cost are reported. Without either, nothing changes:
the product-level path below runs exactly as before, and ``backlog_rows`` is
the product backlog split by share.
"""
from __future__ import annotations

from typing import ClassVar, Literal, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from scsim.core.rowbacklog import step_rows
from scsim.core.context import SimContext
from scsim.core.phases import (
    DEMAND,
    DEMAND_ROWS,
    FG_FULFILLMENT,
    FULFILLMENT,
    PRODUCTION_OUTPUT,
    ST_BACKLOG,
    ST_COST_LEDGER,
    ST_LOST_SALES,
    Hook,
    PhaseId,
)
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.policies.base import PolicyParams, PolicyPlugin
from scsim.policies.registry import register_plugin


class UnmetDemandParams(PolicyParams):
    rule: Literal["lost_sales", "backorder", "partial_backorder"] = Field(
        "lost_sales",
        json_schema_extra={"unit": "enum", "scope": "P", "notes": "lost_sales ✅ (manuscript)."},
    )
    backorder_horizon: int = Field(
        4, ge=0, le=26,
        json_schema_extra={"unit": "weeks", "scope": "P", "notes": "Aged-out backlog becomes lost."},
    )
    backorder_penalty: float = Field(
        0.0, ge=0,
        json_schema_extra={"unit": "€/unit/wk", "scope": "P"},
    )
    partial_accept_prob: float = Field(
        0.5, ge=0.0, le=1.0,
        json_schema_extra={"unit": "-", "scope": "P", "notes": "Share of unmet demand that waits."},
    )
    row_overrides: dict[str, "RowFulfillment"] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "row → settings", "scope": "PC",
                           "notes": "Per customer × product row, keyed '<customer>::<product>': "
                                    "backorder allowed, horizon (weeks), penalty (€/unit/wk). "
                                    "Any row here runs fulfillment per row (WP 14.3)."},
    )


class RowFulfillment(BaseModel):
    """One customer × product row's fulfillment settings (WP 14.3). A field left
    None takes the project's value."""

    model_config = ConfigDict(extra="forbid")

    backorder_allowed: Optional[bool] = None
    backorder_horizon: Optional[int] = Field(None, ge=0, le=26)
    backorder_penalty: Optional[float] = Field(None, ge=0)


UnmetDemandParams.model_rebuild()


@register_plugin
class UnmetDemandHandling(PolicyPlugin):
    id: ClassVar[str] = "unmet_demand_handling"
    catalog_ref: ClassVar[str] = "P-C.1"
    stage: ClassVar[Stage] = Stage.CUSTOMER
    strategy_class: ClassVar[StrategyClass] = StrategyClass.BUILT_IN
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.DEMAND_SIDE
    requires_predeployment: ClassVar[bool] = False
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "What happens to an unservable order: it dies (lost_sales — competitive markets), "
        "waits (backorder — contractual B2B), or splits (partial_backorder). Backorders "
        "convert lost revenue into delay cost, changing the economics of every strategy."
    )
    Params: ClassVar[type[PolicyParams]] = UnmetDemandParams
    # Facet 11: one record per product (or customer × product row, when
    # fulfillment runs per row) whose demand this week was not served in full —
    # what happened to the unmet part. Demand served in full is no decision.
    rationale_codes: ClassVar[dict[str, str]] = {
        "unmet_lost_sales":
            "Demand could not be served this week and the rule is lost sales, so the unmet units were lost.",
        "unmet_backordered":
            "Demand could not be served this week and the rule is backorder, so the unmet units wait in the backlog.",
        "unmet_partially_backordered":
            "Demand could not be served this week; part of the unmet units wait in the backlog and the rest were lost.",
    }

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH60, priority=50,
                reads={DEMAND, DEMAND_ROWS, PRODUCTION_OUTPUT, FG_FULFILLMENT},
                writes={FULFILLMENT, ST_BACKLOG, ST_LOST_SALES, ST_COST_LEDGER},
            ),
        ]

    def setup(self, ctx: SimContext) -> None:
        p: UnmetDemandParams = self.params
        # WP 14.4 — every row's backorder settings, published at setup so the
        # plan (PH-40) carries only what fulfillment would carry (decision 6),
        # before this policy's first PH-60 has run.
        ctx.row_fulfillment = self._row_settings(ctx)
        if p.rule in ("backorder", "partial_backorder") and p.backorder_horizon > 0:
            ctx.policy_state[self.id] = {
                # age_buckets[p, k] = backlog units that have waited k weeks
                "age_buckets": np.zeros((ctx.model.n_prods, p.backorder_horizon + 1)),
            }

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        rows = ctx.policy_state.get(self._ROWS)
        if rows is None:
            rows = ctx.policy_state[self._ROWS] = self._row_setup(ctx)
        if rows["active"]:
            self._on_phase_rows(ctx, rows)
            return
        p: UnmetDemandParams = self.params
        Q = ctx.production_output
        D = ctx.demand
        mts = ctx.model.mts_mask

        # FIFO: clear existing backlog first, then serve this week's demand.
        # CODP-aware availability: MTO ships production output; MTS shipped
        # from FG stock at PH-30 (fg_served_*), production went to stock.
        served_backlog_mto = np.minimum(Q, ctx.backlog)
        served_new_mto = np.minimum(Q - served_backlog_mto, D)
        served_backlog = np.where(mts, ctx.fg_served_backlog, served_backlog_mto)
        served_new = np.where(mts, ctx.fg_served_new, served_new_mto)
        unmet_new = D - served_new
        fulfilled = served_backlog + served_new

        lost = np.zeros_like(D)
        if p.rule == "lost_sales":
            lost = unmet_new
            new_backlog = np.zeros_like(D)
        else:
            waiting = unmet_new if p.rule == "backorder" else unmet_new * p.partial_accept_prob
            lost = unmet_new - waiting
            state = ctx.policy_state.get(self.id)
            if state is not None:
                buckets = state["age_buckets"]
                # Serve oldest first, expire the over-age bucket to lost sales.
                self._drain_fifo(buckets, served_backlog)
                expired = buckets[:, -1].copy()
                lost = lost + expired
                buckets[:, 1:] = buckets[:, :-1]
                buckets[:, 0] = waiting
                new_backlog = buckets.sum(axis=1)
            else:
                # horizon 0: nothing may wait beyond the week — degenerate case.
                new_backlog = ctx.backlog - served_backlog + waiting

            if p.backorder_penalty > 0:
                ctx.cost.add("backorder_penalty", float(new_backlog.sum()) * p.backorder_penalty)

        ctx.write_fulfillment(fulfilled, served_new, lost)
        ctx.set_backlog(new_backlog)
        if ctx.decisions.enabled:
            waits = {"lost_sales": 0.0, "backorder": 1.0}.get(p.rule, p.partial_accept_prob)
            for j in np.flatnonzero(unmet_new > 1e-9):
                self._record(ctx, "product", ctx.model.prod_ids[j], waits, float(D[j]),
                             float(served_new[j]), float(unmet_new[j]), float(lost[j]),
                             float(new_backlog[j]))

    # ------------------------------------------------------------ per row

    _ROWS: ClassVar[str] = "unmet_demand_handling.rows"

    def _row_setup(self, ctx: SimContext) -> dict:
        """Decide once, at the first PH-60, whether fulfillment runs per row.

        Read lazily rather than in ``setup`` because P-C.2 publishes the
        project's rule and row inputs in ITS setup, whose order relative to
        this one is the portfolio's, not a contract."""
        p: UnmetDemandParams = self.params
        m = ctx.model
        alloc = ctx.row_allocation
        active = bool(p.row_overrides) or bool(alloc and alloc.get("row_level"))
        if not active:
            return {"active": False}
        R = m.n_rows
        rs = ctx.row_fulfillment or self._row_settings(ctx)
        accept, horizon, penalty = rs["accept"], rs["horizon"], rs["penalty"]
        H = rs["max_horizon"]
        if alloc is None:
            # No P-C.2: the project rule is P-C.2's own default (fcfs), which at
            # weekly buckets is the equal-fill-rate split.
            alloc = {"rule": "fair_share", "priority": m.row_cust_priority.copy(),
                     "price": m.row_price.copy(), "floor_pct": np.zeros(R)}
        T = m.settings.horizon
        return {
            "active": True, "alloc": alloc, "accept": accept, "horizon": horizon,
            "penalty": penalty, "buckets": np.zeros((R, H + 1)),
            # KPI accumulators, one column per week.
            "demand": np.zeros((R, T)), "served_new": np.zeros((R, T)),
            "lost": np.zeros((R, T)), "cost": np.zeros((R, T)),
        }

    def _row_settings(self, ctx: SimContext) -> dict:
        """Each row's share that waits, horizon (weeks) and penalty: the
        project's rule, overridden row by row (``row_overrides``)."""
        p: UnmetDemandParams = self.params
        m = ctx.model
        R = m.n_rows
        index = {rid: r for r, rid in enumerate(m.row_ids)}
        project_waits = 0.0 if p.rule == "lost_sales" else (
            1.0 if p.rule == "backorder" else p.partial_accept_prob)
        accept = np.full(R, project_waits)
        horizon = np.full(R, p.backorder_horizon, dtype=int)
        penalty = np.full(R, p.backorder_penalty if p.rule != "lost_sales" else 0.0)
        for rid, ov in p.row_overrides.items():
            r = index.get(rid)
            if r is None:
                continue  # the mapper only names rows that exist; a test may not
            if ov.backorder_allowed is not None:
                accept[r] = 1.0 if ov.backorder_allowed else 0.0
            if ov.backorder_horizon is not None:
                horizon[r] = ov.backorder_horizon
            if ov.backorder_penalty is not None:
                penalty[r] = ov.backorder_penalty
        waits = accept > 0
        return {"accept": accept, "horizon": horizon,
                "penalty": np.where(waits, penalty, 0.0),
                "max_horizon": int(horizon[waits].max()) if waits.any() else 0}

    def _on_phase_rows(self, ctx: SimContext, st: dict) -> None:
        m = ctx.model
        P = m.n_prods
        rp = m.row_prod
        # Supply per product: MTO ships production output; MTS ships what PH-30
        # took from finished-goods stock (backlog first at product level — the
        # rows re-split that total below, oldest backlog first within a row).
        supply = np.where(m.mts_mask, ctx.fg_served_backlog + ctx.fg_served_new,
                          ctx.production_output)
        # The ONE row step the plan also projects with (core/rowbacklog.py,
        # WP 14.4): decision 6 holds by construction.
        d_rows = np.maximum(ctx.demand_rows, 0.0)
        wk = step_rows(supply, st["buckets"], d_rows, m.row_ptr, st["alloc"],
                       st["accept"], st["horizon"])
        st["buckets"] = buckets = wk.buckets
        sb_age, s_new, lost = wk.served_backlog, wk.served_new, wk.lost
        backlog_rows = buckets.sum(axis=1)

        cost_rows = backlog_rows * st["penalty"]
        if st["penalty"].any():
            ctx.cost.add("backorder_penalty", float(cost_rows.sum()))

        fulfilled_rows = sb_age.sum(axis=1) + s_new

        def by_prod(x: np.ndarray) -> np.ndarray:
            return np.bincount(rp, weights=x, minlength=P)

        ctx.write_fulfillment(by_prod(fulfilled_rows), by_prod(s_new), by_prod(lost))
        ctx.write_fulfillment_rows(fulfilled_rows, s_new, lost)
        ctx.set_backlog(by_prod(backlog_rows), rows=backlog_rows)
        t = ctx.week
        st["demand"][:, t] = d_rows
        st["served_new"][:, t] = s_new
        st["lost"][:, t] = lost
        st["cost"][:, t] = cost_rows
        if ctx.decisions.enabled:
            for r in np.flatnonzero(s_new < d_rows - 1e-9):
                self._record(ctx, "customer_product", m.row_ids[r], float(st["accept"][r]),
                             float(d_rows[r]), float(s_new[r]), float(d_rows[r] - s_new[r]),
                             float(lost[r]), float(backlog_rows[r]))

    def _record(self, ctx: SimContext, node_kind: str, node: str, waits: float, demanded: float,
                served: float, unmet: float, lost: float, backlog: float) -> None:
        # Reads values on_phase already computed; changes nothing (facet 11).
        why = ("unmet_lost_sales" if waits <= 0.0 else
               "unmet_backordered" if waits >= 1.0 else "unmet_partially_backordered")
        self.decide(
            ctx, rationale=why, node_kind=node_kind, node=node,
            inputs={"demanded": demanded, "served_new": served, "share_that_waits": waits},
            decision={"unmet": unmet, "lost_this_week": lost, "backlog_after": backlog},
        )

    def kpi_contribution(self, ctx: SimContext, t_w: int, window_end: int) -> dict[str, float]:
        """Per row and per customer, only when fulfillment ran per row: a
        project-wide run reports exactly what it reported before WP 14.3."""
        st = ctx.policy_state.get(self._ROWS)
        if not st or not st.get("active"):
            return {}
        m = ctx.model
        w = slice(t_w, window_end)
        dem = st["demand"][:, w].sum(axis=1)
        srv = st["served_new"][:, w].sum(axis=1)
        out: dict[str, float] = {}
        for r, rid in enumerate(m.row_ids):
            out[f"fill_rate_row_{rid}"] = float(srv[r] / dem[r]) if dem[r] > 0 else 1.0
            out[f"lost_units_row_{rid}"] = float(st["lost"][r, w].sum())
            out[f"backorder_cost_row_{rid}"] = float(st["cost"][r, w].sum())
        # Per customer: value-weighted at each row's price (the engine's fill
        # rate convention); an implicit row has no customer and no entry.
        price = m.row_price
        for c, cid in enumerate(m.cust_ids):
            sel = m.row_cust == c
            if not sel.any():
                continue
            d = float((dem[sel] * price[sel]).sum())
            s = float((srv[sel] * price[sel]).sum())
            out[f"fill_rate_customer_{cid}"] = s / d if d > 0 else 1.0
        return out

    @staticmethod
    def _drain_fifo(buckets: np.ndarray, served: np.ndarray) -> None:
        """Remove served units from the oldest age buckets first (in place)."""
        remaining = served.copy()
        for k in range(buckets.shape[1] - 1, -1, -1):
            take = np.minimum(buckets[:, k], remaining)
            buckets[:, k] -= take
            remaining -= take

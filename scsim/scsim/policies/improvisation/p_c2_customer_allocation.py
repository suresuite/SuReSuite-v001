# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-C.2 customer_allocation — IMPROVISATION, who do we disappoint first. ✅

Context: under scarcity the engine's product-level fulfillment (P-C.1,
PH-60) says HOW MUCH ships; this policy says WHO gets it. Each product's
weekly new-demand fulfillment is distributed across the customers that buy
it (``Network.customer_links`` shares, uniform when absent), and per-segment
service KPIs are reported so "protect strategic accounts" becomes a measured
outcome instead of a hope. Inert for single-customer networks.

Rules (weekly-bucket fidelity — within a bucket there is no arrival order,
so ``fcfs``, ``proportional``, and demand-basis ``fair_share`` coincide as a
pro-rata split; they stay separate enum values because they diverge if a
sub-weekly tick ever lands):

- ``fcfs`` / ``proportional`` / ``fair_share``: pro-rata to demand shares —
  every customer of a product gets the same fill rate.
- ``priority``: serve customers in descending priority weight
  (``priority_weights`` param, else ``Customer.priority_weight``); high
  priority fills completely before lower sees a unit.
- ``sla_tier``: two passes — first guarantee each segment's fill floor
  (``sla_tiers``: segment → floor %, scaled down pro-rata when supply
  cannot honor all floors), then distribute the remainder by priority.
- ``revenue_max`` (WP 14.3): serve the highest-priced row first — the row's
  own price (``row_price``, else the outbound row's unit price, else the
  product's).

PER ROW (WP 14.3, ADR 0002 decision 4 — one rule per project, priority /
price / service target per row). ``setup`` PUBLISHES the rule and the per-row
inputs on ``ctx.row_allocation`` (the P-C.6 publish-at-setup pattern), and
P-C.1 — the single writer of fulfillment and backlog — splits each product's
supply with them. A row's priority is ``row_priority`` → ``priority_weights``
→ ``Customer.priority_weight``; its service target is ``row_floor_pct`` →
``Customer.sla_fill_floor_pct`` → the segment's ``sla_tiers`` floor → 0. When
the rule needs a per-row input (``revenue_max``, a row priority, a row or
customer floor under ``sla_tier``) or a row carries its own backorder
settings, fulfillment runs per row and this policy's segment KPIs are summed
from P-C.1's rows, so the two cannot disagree; an implicit row (a product no
customer row names) belongs to no segment. Otherwise the split below runs as
before, read-only.

The split is value-weighted with the product's unit price, matching the
engine's value-based fill-rate convention. Since WP 14.0 the split itself is
``core/allocation.py::allocate_batched`` — the one allocation function per-row
fulfillment (WP 14.3) and the plan's shortfall split (WP 14.4) also call — with
one row per (product, customer); its outputs are the ones this module computed
inline before, pinned by ``tests/test_allocation.py``. Distribution does not alter
product-level physics (totals are conserved); its output is the per-segment
service view — the §7 interaction-8 path made observable.

KPIs (facet 7, via ``kpi_contribution``): ``fill_rate_segment_<segment>``
per customer segment and ``min_segment_fill_rate``, both over the analysis
window. Segments are capped at 10 by the entity contract, so the KPI
surface stays bounded regardless of customer count.
"""
from __future__ import annotations

from typing import ClassVar, Literal

import numpy as np
from pydantic import Field

from scsim.core.allocation import allocate_batched
from scsim.core.context import SimContext
from scsim.core.phases import DEMAND, FULFILLMENT, Hook, PhaseId
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.entities.scenario import Scenario
from scsim.policies.base import (
    DataRequirement,
    FeasibilityIssue,
    FeasibilityResult,
    PolicyParams,
    PolicyPlugin,
)
from scsim.policies.registry import register_plugin


# The helper's rule for each P-C.2 rule. fcfs, proportional and fair_share all
# split pro-rata to demand at weekly buckets (module docstring).
_HELPER_RULE = {
    "fcfs": "fair_share",
    "proportional": "fair_share",
    "fair_share": "fair_share",
    "priority": "priority",
    "sla_tier": "sla_tier",
    "revenue_max": "revenue_max",
}


class CustomerAllocationParams(PolicyParams):
    rule: Literal["fcfs", "proportional", "fair_share", "priority", "sla_tier",
                  "revenue_max"] = Field(
        "fcfs", json_schema_extra={"unit": "enum", "scope": "C",
                                   "notes": "fcfs/proportional/fair_share coincide at weekly "
                                            "buckets (pro-rata); priority, sla_tier and "
                                            "revenue_max (by row price) reorder."})
    priority_weights: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "weight per customer", "scope": "C",
                           "notes": "Overrides Customer.priority_weight; higher serves first."})
    sla_tiers: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "segment → fill floor %", "scope": "C",
                           "notes": "Guaranteed first-pass fill per segment; scaled down "
                                    "pro-rata when supply cannot honor all floors."})
    row_priority: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "weight per row", "scope": "PC",
                           "notes": "'<customer>::<product>' → priority; beats priority_weights "
                                    "and Customer.priority_weight for that row."})
    row_price: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "€/unit per row", "scope": "PC",
                           "notes": "'<customer>::<product>' → price revenue_max orders by; "
                                    "beats the row's own unit price."})
    row_floor_pct: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={"unit": "row → fill floor %", "scope": "PC",
                           "notes": "'<customer>::<product>' → the row's service target under "
                                    "sla_tier; beats Customer.sla_fill_floor_pct and sla_tiers."})


@register_plugin
class CustomerAllocation(PolicyPlugin):
    id: ClassVar[str] = "customer_allocation"
    catalog_ref: ClassVar[str] = "P-C.2"
    stage: ClassVar[Stage] = Stage.CUSTOMER
    strategy_class: ClassVar[StrategyClass] = StrategyClass.IMPROVISATION
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.DEMAND_SIDE
    requires_predeployment: ClassVar[bool] = False
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Under scarcity, 'who do we disappoint first' is deliberate — protect strategic "
        "accounts / SLA tiers / spread pain. Inert for single-customer MTO. Hook: PH-60."
    )
    Params: ClassVar[type[PolicyParams]] = CustomerAllocationParams
    # Facet 11: in a scarce week, one record per customer × product row that
    # was served less than it demanded, naming the allocation rule that put it
    # there. A row served in full is no decision.
    rationale_codes: ClassVar[dict[str, str]] = {
        "short_fair_share":
            "Supply was short; it was split pro rata (fcfs, proportional and fair share coincide at weekly buckets), so this row got its share.",
        "short_priority":
            "Supply was short; higher-priority customers were served first, so this row got what was left.",
        "short_sla_tier":
            "Supply was short; each segment's SLA fill floor was met first, then the rest by priority, so this row got what was left.",
        "short_revenue_max":
            "Supply was short; it went to the highest-price rows first, so this row got what was left.",
    }
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = (
        DataRequirement(
            field="outbound_logistics.volume", level="required",
            reason="Per-customer demand shares come from outbound volumes; "
                   "without them there are no customer segments to allocate "
                   "between (the policy is inert below two customers).",
            fallback=None,
        ),
        # §4 D94 — these two were READ on every run and DECLARED nowhere, so
        # every tool that derives "what the engine reads" from the registry was
        # blind to them: the `customers` sidecar recorded `consumed_by: null`
        # with nothing to contradict it, and `project_map` omitted the table with
        # no requirement naming what it failed to supply. `level="defaulted"`
        # rather than `recommended`: `Customer` carries a default for both, so an
        # absent value is a substitution to REPORT (T2), never a blocked run.
        DataRequirement(
            field="customers.priority_weight", level="defaulted",
            reason="The `priority` rule orders customers by this weight wherever "
                   "the `priority_weights` param does not name the customer "
                   "(SimContext.cust_priority). Only the RATIO between two "
                   "customers means anything, so a table where every row is "
                   "unset cannot order anything.",
            fallback="Customer.priority_weight's own default, 1.0 — every "
                     "customer equal, which makes the `priority` rule inert",
        ),
        DataRequirement(
            field="customers.segment", level="defaulted",
            reason="`sla_tiers` maps segment → fill floor %, so the segment is "
                   "the axis the `sla_tier` rule tiers on "
                   "(SimContext.cust_segment). It is also what the "
                   "`fill_rate_segment_<segment>` KPIs are keyed by.",
            fallback="Customer.segment's own default, \"default\" — every "
                     "customer in one segment, so no `sla_tiers` key can match "
                     "and every declared floor resolves to 0.0",
        ),
    )

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH60, priority=60,
                reads={DEMAND, FULFILLMENT},
                # Read-only resident: distributes the fulfillment P-C.1
                # (priority 50) wrote across customers; product totals are
                # untouched, so no write contract is needed.
            ),
        ]

    # ------------------------------------------------------------ feasibility

    def feasibility(self, scenario: Scenario) -> FeasibilityResult:
        p: CustomerAllocationParams = self.params
        net = scenario.network
        issues: list[FeasibilityIssue] = []
        if len(net.customers) < 2:
            issues.append(FeasibilityIssue(
                "warning", "single_customer",
                "customer_allocation is inert: the network has fewer than two customers — "
                "there is no one to prioritize between",
            ))
        known = {c.id for c in net.customers}
        unknown = sorted(set(p.priority_weights) - known)
        if unknown:
            issues.append(FeasibilityIssue(
                "warning", "unknown_customer_weight",
                f"priority_weights name unknown customer(s): {unknown[:5]}",
            ))
        segments = {c.segment for c in net.customers}
        unknown_seg = sorted(set(p.sla_tiers) - segments)
        if unknown_seg:
            issues.append(FeasibilityIssue(
                "warning", "unknown_sla_segment",
                f"sla_tiers name unknown segment(s): {unknown_seg[:5]}",
            ))
        rows = {f"{cl.customer_id}::{cl.product_id}" for cl in net.customer_links}
        unknown_rows = sorted((set(p.row_priority) | set(p.row_price) | set(p.row_floor_pct))
                              - rows)
        if unknown_rows:
            issues.append(FeasibilityIssue(
                "warning", "unknown_row",
                f"per-row allocation inputs name customer × product row(s) no customer "
                f"link describes: {unknown_rows[:5]}",
            ))
        bad = {k: v for k, v in {**p.sla_tiers, **p.row_floor_pct}.items()
               if not 0.0 <= v <= 100.0}
        if bad:
            return FeasibilityResult(False, tuple(issues) + (FeasibilityIssue(
                "error", "sla_floor_out_of_range",
                f"sla_tiers floors must be in [0, 100]%: {bad}"),))
        return FeasibilityResult(True, tuple(issues))

    # ---------------------------------------------------------------- runtime

    def setup(self, ctx: SimContext) -> None:
        m = ctx.model
        p: CustomerAllocationParams = self.params
        T = m.settings.horizon
        seg_ids = sorted(set(m.cust_segment)) if m.n_custs else []
        seg_index = {s: k for k, s in enumerate(seg_ids)}
        # One-hot customer → segment aggregation matrix (n_segs × n_custs).
        seg_of = np.zeros((len(seg_ids), m.n_custs))
        for c, seg in enumerate(m.cust_segment):
            seg_of[seg_index[seg], c] = 1.0
        weights = np.array([
            p.priority_weights.get(cid, m.cust_priority[c])
            for c, cid in enumerate(m.cust_ids)
        ]) if m.n_custs else np.zeros(0)
        floors_pct = np.array([
            p.sla_tiers.get(seg, 0.0) for seg in m.cust_segment
        ]) if m.n_custs else np.zeros(0)
        P, C = m.n_prods, m.n_custs
        ctx.policy_state[self.id] = {
            "seg_ids": seg_ids,
            "seg_of": seg_of,
            # Rows are (product, customer), product-major, so product p owns
            # rows p·C .. (p+1)·C. Priority: descending weight, customer index
            # (= row order) as the deterministic tiebreak — the helper's rule.
            "row_ptr": np.arange(P + 1) * C,
            "row_priority": np.tile(weights, P),
            "row_floor_pct": np.tile(floors_pct, P),
            "demand_seg": np.zeros((len(seg_ids), T)),
            "served_seg": np.zeros((len(seg_ids), T)),
        }
        ctx.row_allocation = self._publish(m, p, weights, seg_index)

    @staticmethod
    def _publish(m, p: CustomerAllocationParams, weights: np.ndarray,
                 seg_index: dict[str, int]) -> dict:
        """The project's rule and its per-row inputs, over the demand rows
        (WP 14.3). ``row_level`` says whether the rule NEEDS per-row
        fulfillment — without it a project-wide run keeps its product path."""
        R = m.n_rows
        priority = np.array([
            float(weights[c]) if c >= 0 else 1.0 for c in m.row_cust]) if R else np.zeros(0)
        price = m.row_price.copy()
        cust_floor = m.row_cust_floor
        seg_floor = np.array([
            p.sla_tiers.get(m.cust_segment[c], 0.0) if c >= 0 else 0.0 for c in m.row_cust])
        floor = np.where(np.isnan(cust_floor), seg_floor, cust_floor) if R else np.zeros(0)
        for r, rid in enumerate(m.row_ids):
            if rid in p.row_priority:
                priority[r] = float(p.row_priority[rid])
            if rid in p.row_price:
                price[r] = float(p.row_price[rid])
            if rid in p.row_floor_pct:
                floor[r] = float(p.row_floor_pct[rid])
        rule = p.rule
        row_level = (
            rule == "revenue_max"
            or (rule in ("priority", "sla_tier") and bool(p.row_priority))
            or (rule == "sla_tier" and (bool(p.row_floor_pct)
                                       or bool((~np.isnan(cust_floor)).any())))
        )
        return {"rule": _HELPER_RULE[rule], "priority": priority, "price": price,
                "floor_pct": floor, "row_level": row_level}

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        m = ctx.model
        if m.n_custs < 2:
            return
        p: CustomerAllocationParams = self.params
        state = ctx.policy_state[self.id]
        t = ctx.week
        if ctx.served_new_rows is not None:
            # Fulfillment ran per row (P-C.1): the segments are sums of ITS
            # rows, value-weighted at each row's price. Implicit rows (no
            # customer) belong to no segment.
            named = m.row_cust >= 0
            price = m.row_price
            d_c = np.bincount(m.row_cust[named], weights=(ctx.demand_rows * price)[named],
                              minlength=m.n_custs)
            s_c = np.bincount(m.row_cust[named], weights=(ctx.served_new_rows * price)[named],
                              minlength=m.n_custs)
            state["demand_seg"][:, t] = state["seg_of"] @ d_c
            state["served_seg"][:, t] = state["seg_of"] @ s_c
            if ctx.decisions.enabled:
                for r in np.flatnonzero(named & (ctx.served_new_rows < ctx.demand_rows - 1e-9)):
                    self._record(ctx, m.row_ids[r], float(ctx.demand_rows[r]),
                                 float(ctx.served_new_rows[r]), "units")
            return
        P, C = m.n_prods, m.n_custs
        # Value-weighted weekly split (engine fill-rate convention).
        d_pc = (ctx.demand * m.unit_price)[:, None] * m.cust_share       # (P, C)
        avail = ctx.served_new_week * m.unit_price                       # (P,)

        # One row per (product, customer), product-major: the shared
        # allocation helper (core/allocation.py, WP 14.0) splits each
        # product's supply across its rows. fcfs / proportional / fair_share
        # coincide at weekly buckets, so all three are the helper's
        # equal-fill-rate rule.
        _, s_new = allocate_batched(
            avail, np.zeros((P * C, 0)), d_pc.ravel(), state["row_ptr"],
            _HELPER_RULE[p.rule],
            priority=state["row_priority"], floor_pct=state["row_floor_pct"],
        )
        s_pc = s_new.reshape(P, C)

        state["demand_seg"][:, t] = state["seg_of"] @ d_pc.sum(axis=0)
        state["served_seg"][:, t] = state["seg_of"] @ s_pc.sum(axis=0)
        if ctx.decisions.enabled:
            for j, c in zip(*np.nonzero(s_pc < d_pc - 1e-9)):
                self._record(ctx, f"{m.cust_ids[c]}::{m.prod_ids[j]}", float(d_pc[j, c]),
                             float(s_pc[j, c]), "value")

    def _record(self, ctx: SimContext, row: str, demanded: float, served: float, basis: str) -> None:
        # Reads values on_phase already computed; changes nothing (facet 11).
        p: CustomerAllocationParams = self.params
        self.decide(
            ctx, rationale=f"short_{_HELPER_RULE[p.rule]}", node_kind="customer_product", node=row,
            inputs={"rule": p.rule, "demanded": demanded, "basis": basis},
            decision={"served": served, "short_by": demanded - served},
        )

    def kpi_contribution(self, ctx: SimContext, t_w: int, window_end: int) -> dict[str, float]:
        if ctx.model.n_custs < 2:
            return {}
        state = ctx.policy_state[self.id]
        w = slice(t_w, window_end)
        out: dict[str, float] = {}
        fills = []
        for k, seg in enumerate(state["seg_ids"]):
            dem = float(state["demand_seg"][k, w].sum())
            srv = float(state["served_seg"][k, w].sum())
            fr = srv / dem if dem > 0 else 1.0
            out[f"fill_rate_segment_{seg}"] = fr
            fills.append(fr)
        out["min_segment_fill_rate"] = min(fills) if fills else 1.0
        return out

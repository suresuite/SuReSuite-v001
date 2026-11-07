# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-P.1 inventory_control — BUILT_IN buffer (Part IV §4.1). ✅ min_max.

Context: the everyday replenishment rule — the baseline shock absorber every
chain already has; quantifying it prevents over-buying dedicated resilience.

Variants: min-max (ERP discrete manufacturing — the case company),
base-stock (high-value/low-volume), (R,Q) (stable flows), periodic
(consolidated cadence).

Mechanics (Eqs. 2–6): levels at PH-70, release at PH-80 — order
max(S_m − position, MOQ) when position < s_m, on the material's primary
(min-cost) supplier link.

A level the planner states on a /policies row IS the level the run uses: an
absolute s or S replaces its formula, P-P.3 adds no safety stock on top of it,
and a stated S is never raised to a formula s. An (R,Q) material with a lot
orders Q and its S is R + Q, so κ is read only where S comes from the formula.

MRP (WP 14.5, design doc §3.4, ADR 0002 decision 1). A material whose type is
``mrp`` is ordered from the PLAN, not from consumption:

    order(m, t) = need(m, t+1 … t+L) + SS(m) − on hand(m) − on the way(m)
    if order > 0: order = max(order, MOQ)          → the primary link

``need`` is the gross requirement (BOMᵀ × planned production, PH-70), L the
primary lead time, on hand is after this week's production, on the way is in
transit + queued at the supplier, and SS = days/7 × the average weekly need over
the horizon, with the days P-P.3 sizes (counted once — MRP reads no level).
The planning horizon H is set at compile (`configure_model`): the longest MRP
lead time + 1. Reorder-point materials are unchanged.
"""
from __future__ import annotations

from typing import ClassVar, Literal, Optional

import logging

import numpy as np
from pydantic import Field, field_validator, model_validator

from scsim.core.context import SimContext
from scsim.core.phases import (
    ARRIVALS,
    GROSS_REQUIREMENTS,
    INVENTORY_LEVELS,
    MATERIAL_DEMAND,
    PLANNED_PRODUCTION,
    PRODUCTION_OUTPUT,
    PURCHASE_ORDERS,
    ST_ON_HAND,
    ST_PIPELINE,
    ST_QUEUE,
    Hook,
    PhaseId,
)
from scsim.entities.enums import (
    ConstraintTag,
    FulfillmentMode,
    PolicyStatus,
    Stage,
    StrategyClass,
    TransportMode,
)
from scsim.entities.network import Network, primary_rank
from scsim.entities.scenario import Scenario
from scsim.policies.base import (
    DataRequirement,
    FeasibilityIssue,
    FeasibilityResult,
    ModeStrip,
    PolicyParams,
    PolicyPlugin,
)
from scsim.policies.registry import register_plugin

_log = logging.getLogger(__name__)


def _primary_link_lts(net: Network) -> dict[str, int]:
    """Effective primary-link lead time per material id, mirroring
    CompiledModel's primary selection (`primary_rank`) and edge
    lead-time folding — kept in lockstep by a drift test."""
    lane_extra: dict[str, int] = {}
    for lane in sorted(net.lanes, key=lambda l: (l.mode != TransportMode.DEFAULT, l.id)):
        lane_extra.setdefault(lane.supplier_id, int(lane.lead_time_weeks))
    out: dict[str, int] = {}
    for link in sorted(net.supplier_links, key=primary_rank):
        out.setdefault(link.material_id,
                       int(link.lead_time_weeks) + lane_extra.get(link.supplier_id, 0))
    return out


class MaterialInventoryOverride(PolicyParams):
    """Per-material replenishment override (P-P.1, §II.3): the supplier grid's
    row-level adjustments. Every field is optional — an absent field keeps the
    project-default behavior (the Eqs. 2–3 formula levels), so an override row
    never silently replaces a formula it does not name."""

    policy_type: Optional[Literal["min_max", "base_stock", "rop_q", "periodic", "mrp"]] = Field(
        None, json_schema_extra={"unit": "enum", "scope": "M",
                                 "notes": "Row-level policy type; absent → project default. "
                                          "mrp orders from the plan (WP 14.5)."},
    )
    rop_q_quantity: Optional[float] = Field(
        None, gt=0,
        json_schema_extra={"unit": "units", "scope": "M", "notes": "Fixed (R,Q) lot for this material."},
    )
    coverage_weeks: Optional[float] = Field(
        None, ge=0, le=26,
        json_schema_extra={"unit": "weeks", "scope": "M",
                           "notes": "Fixed κ for this material (all modes); absent → the strip."},
    )
    reorder_point: Optional[float] = Field(
        None, ge=0,
        json_schema_extra={"unit": "units", "scope": "M",
                           "notes": "Absolute s (R for rop_q) replacing E[D]·T_s for this material."},
    )
    order_up_to: Optional[float] = Field(
        None, gt=0,
        json_schema_extra={"unit": "units", "scope": "M",
                           "notes": "Absolute S replacing E[D]·(T_s+κ) for this material."},
    )
    periodic_review_weeks: Optional[int] = Field(
        None, ge=1, le=13,
        json_schema_extra={"unit": "weeks", "scope": "M",
                           "notes": "Review period T for this material (periodic); "
                                    "absent → the project's."},
    )

    @model_validator(mode="after")
    def _levels_ordered(self) -> "MaterialInventoryOverride":
        if (self.reorder_point is not None and self.order_up_to is not None
                and self.order_up_to <= self.reorder_point):
            raise ValueError("order_up_to must exceed reorder_point")
        return self


class InventoryControlParams(PolicyParams):
    policy_type: Literal["min_max", "base_stock", "rop_q", "periodic", "mrp"] = Field(
        "min_max",
        json_schema_extra={"unit": "enum", "scope": "M",
                           "notes": "min_max ✅ (manuscript). mrp: BOM × planned production over "
                                    "the lead time, net of stock and the pipeline (WP 14.5)."},
    )
    basis: Literal["days_of_supply", "forward_visible"] = Field(
        "days_of_supply",
        json_schema_extra={
            "unit": "enum", "scope": "G/M",
            "notes": "Policy Basis (§II.4): days_of_supply sizes levels from the stationary "
                     "mean (s = E[D_m]·T_s); forward_visible sums the committed forward "
                     "order book over the coverage window (WSC-2026 MTO) — requires the "
                     "P-C.6 forward_visibility customer policy.",
        },
    )
    coverage_weeks: ModeStrip = Field(
        default_factory=lambda: ModeStrip(nominal=8, alert=10, crisis=12),
        json_schema_extra={
            "unit": "weeks", "scope": "G/M", "range": "[0, 26]",
            "notes": "κ — order-up-to cover beyond lead time. Strip 8/10/12.",
        },
    )
    review_cadence_weeks: Literal[1, 2, 4] = Field(
        1, json_schema_extra={"unit": "weeks", "scope": "G"},
    )
    rop_q_quantity: Optional[float] = Field(
        None, gt=0,
        json_schema_extra={"unit": "units", "scope": "M", "notes": "Fixed (R,Q) lot; ≥ MOQ enforced."},
    )
    periodic_review_weeks: int = Field(
        4, ge=1, le=13, json_schema_extra={"unit": "weeks", "scope": "G"},
    )
    material_overrides: dict[str, MaterialInventoryOverride] = Field(
        default_factory=dict,
        json_schema_extra={
            "unit": "map", "scope": "M",
            "notes": "material_id → row-level override from the supplier grid "
                     "(§II.3). Unknown material ids are ignored at runtime.",
        },
    )

    @field_validator("coverage_weeks")
    @classmethod
    def _kappa_range(cls, v: ModeStrip) -> ModeStrip:
        for mode in ("nominal", "alert", "crisis"):
            k = getattr(v, mode)
            if not (0 <= k <= 26):
                raise ValueError(f"coverage_weeks.{mode} must be in [0, 26]")
        return v

    @model_validator(mode="after")
    def _forward_needs_integral_kappa(self) -> "InventoryControlParams":
        if self.basis == "forward_visible":
            for mode in ("nominal", "alert", "crisis"):
                k = getattr(self.coverage_weeks, mode)
                if k != int(k):
                    raise ValueError(
                        f"basis='forward_visible' sums whole forward weeks: "
                        f"coverage_weeks.{mode} must be integral, got {k}"
                    )
        return self


@register_plugin
class InventoryControl(PolicyPlugin):
    id: ClassVar[str] = "inventory_control"
    catalog_ref: ClassVar[str] = "P-P.1"
    stage: ClassVar[Stage] = Stage.PLANT
    strategy_class: ClassVar[StrategyClass] = StrategyClass.BUILT_IN
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.MATERIAL_AVAILABILITY
    requires_predeployment: ClassVar[bool] = False
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Everyday replenishment rule (min-max / base-stock / (R,Q) / periodic). The baseline "
        "shock absorber every chain already has; quantifying it prevents over-buying "
        "dedicated resilience."
    )
    Params: ClassVar[type[PolicyParams]] = InventoryControlParams
    # Facet 11: one record per material per week an order is released (PH-80),
    # naming the rule that released it, plus the one "why not" a planner asks
    # most — a min-max or periodic material below its reorder point in a week
    # that is not its review week.
    rationale_codes: ClassVar[dict[str, str]] = {
        "ordered_min_max":
            "Inventory position (on hand + on order) fell below the reorder point s in a review week, so an order up to S was released.",
        "ordered_base_stock":
            "Inventory position was below the base-stock level S, so the difference was ordered.",
        "ordered_rop_q":
            "Inventory position fell below the reorder point, so the fixed lot Q was ordered.",
        "ordered_rop_q_no_lot":
            "Inventory position fell below the reorder point and no lot Q was set, so it ordered up to S instead (the declared fallback).",
        "ordered_periodic":
            "A review week for this material, and position was below S, so the difference was ordered.",
        "ordered_mrp":
            "MRP netting: projected need over the lead time plus safety stock exceeded on hand plus on order, so the net was ordered.",
        "held_not_review_week":
            "Inventory position was below the reorder point, but this is not the material's review week, so no order was released.",
    }
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = (
        DataRequirement(
            field="materials.moq", level="defaulted",
            reason="Minimum order quantity rounds up PH-80 order releases.",
            fallback="0 (no minimum)",
        ),
        DataRequirement(
            field="materials.holding_cost_pct", level="defaulted",
            reason="Holding cost rate prices the inventory this policy carries.",
            fallback="policy inventory.holding_cost_pct, then 20%",
        ),
    )

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH70, priority=50,
                reads={MATERIAL_DEMAND},
                writes={INVENTORY_LEVELS},
            ),
            Hook(
                phase=PhaseId.PH80, priority=50,
                reads={INVENTORY_LEVELS, ST_ON_HAND, ST_PIPELINE, ST_QUEUE,
                       GROSS_REQUIREMENTS, PLANNED_PRODUCTION, PRODUCTION_OUTPUT},
                writes={PURCHASE_ORDERS},
            ),
            # WP 14.5 — read-only: what landed this week, for the MRP receipts
            # ledger (late receipts). Inert for a run without MRP materials.
            Hook(phase=PhaseId.PH90, priority=95, reads={ARRIVALS}),
        ]

    # ------------------------------------------------------------ feasibility

    def feasibility(self, scenario: Scenario) -> FeasibilityResult:
        p: InventoryControlParams = self.params
        if p.basis != "forward_visible":
            return FeasibilityResult.ok()
        # §II.4 two-stage contract: the forward basis is selectable only when
        # a customer policy provides τ* ≥ T_s + κ, and only for MTO worlds.
        fv = scenario.policies.get("forward_visibility")
        if fv is None:
            return FeasibilityResult(False, (FeasibilityIssue(
                "error", "forward_basis_needs_visibility",
                "basis='forward_visible' requires the forward_visibility customer policy "
                "(P-C.6): the plant can only read a forward order book a customer commits",
            ),))
        mts = [pr.id for pr in scenario.network.products
               if pr.fulfillment_mode == FulfillmentMode.MTS]
        if mts:
            return FeasibilityResult(False, (FeasibilityIssue(
                "error", "forward_basis_is_mto_only",
                f"basis='forward_visible' is MTO-only (§II.4): MTS products plan material "
                f"demand from the forecast, not the committed book — found MTS: {mts[:5]}",
            ),))
        tau = fv.get("visibility_horizon") or scenario.settings.visibility_horizon
        max_lt = max(_primary_link_lts(scenario.network).values(), default=0)
        kappa_crisis = int(p.coverage_weeks.crisis)
        if max_lt + kappa_crisis > tau:
            return FeasibilityResult(False, (FeasibilityIssue(
                "error", "coverage_beyond_visibility",
                f"forward windows must fit the visible book (T_s + κ ≤ τ*, §II.4): "
                f"max primary lead time {max_lt}w + crisis κ {kappa_crisis}w exceeds "
                f"τ* = {tau}w",
            ),))
        return FeasibilityResult.ok()

    # ---------------------------------------------------------------- runtime

    def _kappa(self, ctx: SimContext) -> float:
        strip: ModeStrip = self.params.coverage_weeks
        return strip.crisis if ctx.events_visible() else strip.nominal

    _TYPE_CODE = {"min_max": 0, "base_stock": 1, "rop_q": 2, "periodic": 3, "mrp": 4}

    # ------------------------------------------------------------------ MRP

    def configure_model(self, m) -> None:
        """At compile, before any context exists: mark the MRP materials and set
        the planning horizon H = the longest MRP primary lead time + 1, so the
        plan (PH-40) projects far enough for every order to net its lead time.
        Also publish which levels a row STATED, for P-P.3 (see the module doc)."""
        type_code, q, k_ov, s_abs, S_abs, _rw = self._override_arrays(m)
        lot = (type_code == self._TYPE_CODE["rop_q"]) & ~np.isnan(q)
        m.stated_s_mask = ~np.isnan(s_abs)
        m.stated_S_mask = ~np.isnan(S_abs) & ~lot
        m.lot_S_mask = lot
        m.kappa_override = k_ov
        mask = type_code == self._TYPE_CODE["mrp"]
        m.mrp_mask = mask
        m.has_mrp = bool(mask.any())
        if m.has_mrp:
            lt = m.link_lt[m.primary_link]
            m.plan_horizon = max(int(m.plan_horizon), int(lt[mask].max()) + 1)

    def setup(self, ctx: SimContext) -> None:
        m = ctx.model
        if not m.has_mrp:
            return
        T = m.settings.horizon
        ctx.policy_state[self.id] = {
            # Due schedule: what MRP ordered, by the week it is due usable.
            "due": np.zeros((m.n_mats, T + m.ring_width)),
            # Received, by the week it became usable (landed at the PH-90 before).
            "received": np.zeros((m.n_mats, T + 1)),
            "late": np.zeros((m.n_mats, T), dtype=bool),
            # Running totals: due by this week, and received by it.
            "due_cum": np.zeros(m.n_mats), "recv_cum": np.zeros(m.n_mats),
            "shortage": np.zeros(T, dtype=bool),
        }
        if ctx.trace.keep_matrices:
            for name in ("MRP_NEED", "MRP_ON_HAND", "MRP_ON_WAY", "MRP_NET"):
                setattr(ctx.trace, name, np.zeros((m.n_mats, T)))

    def _mrp_orders(self, ctx: SimContext, on_way: np.ndarray) -> np.ndarray:
        """The MRP order per material (0 for every other material)."""
        m = ctx.model
        mask = m.mrp_mask
        gr = ctx.gross_requirements
        H = gr.shape[1]
        lt = m.link_lt[m.primary_link].astype(int)
        # need(t+1 … t+L): the cumulative sum of future columns up to each lead time.
        L = np.clip(lt, 0, H - 1)
        cum = np.zeros((m.n_mats, H))
        np.cumsum(gr[:, 1:], axis=1, out=cum[:, 1:])
        need = cum[np.arange(m.n_mats), L]
        days = ctx.material_ss_days if ctx.material_ss_days is not None else np.zeros(m.n_mats)
        avg_need = gr[:, 1:].mean(axis=1) if H > 1 else gr[:, 0]
        ss = days / 7.0 * avg_need
        on_hand = ctx.on_hand
        net = need + ss - on_hand - on_way
        moq = m.link_moq[m.primary_link]
        order = np.where(mask & (net > 1e-9), np.maximum(net, moq), 0.0)
        st = ctx.policy_state[self.id]
        t = ctx.week
        tr = ctx.trace
        if tr.MRP_NEED is not None:
            tr.MRP_NEED[:, t] = np.where(mask, need, 0.0)
            tr.MRP_ON_HAND[:, t] = np.where(mask, on_hand, 0.0)
            tr.MRP_ON_WAY[:, t] = np.where(mask, on_way, 0.0)
            tr.MRP_NET[:, t] = np.where(mask, net, 0.0)
        # Late receipts: an order is due usable at t + L. A material is late in a
        # week when what MRP had due by then exceeds what it has received by then.
        due = st["due"]
        st["due_cum"] += due[:, t]
        st["recv_cum"] += st["received"][:, t]
        st["late"][:, t] = mask & (st["due_cum"] - st["recv_cum"] > 1e-6)
        due[np.arange(m.n_mats), t + np.maximum(lt, 1)] += order
        # Material shortage: the plant built less than it planned this week.
        # The plan is of STARTS (P-P.13), so the shortfall compares starts.
        st["shortage"][t] = bool((ctx.planned_production[:, 0] - ctx.production_started > 1e-9).any())
        return order

    def _override_arrays(
        self, m,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Per-material vectors from `material_overrides`: (type_code, Q, κ,
        absolute s, absolute S, review period T in weeks). NaN means "no
        override" for the float arrays; unknown material ids are skipped (the
        mapping already filtered them)."""
        p: InventoryControlParams = self.params
        n = m.n_mats
        type_code = np.full(n, self._TYPE_CODE[p.policy_type], dtype=int)
        q = np.full(n, p.rop_q_quantity if p.rop_q_quantity is not None else np.nan)
        kappa = np.full(n, np.nan)
        s_abs = np.full(n, np.nan)
        S_abs = np.full(n, np.nan)
        review = np.full(n, int(p.periodic_review_weeks), dtype=int)
        for mid, ov in p.material_overrides.items():
            i = m.mat_index.get(mid)
            if i is None:
                continue
            if ov.policy_type is not None:
                type_code[i] = self._TYPE_CODE[ov.policy_type]
            if ov.rop_q_quantity is not None:
                q[i] = ov.rop_q_quantity
            if ov.coverage_weeks is not None:
                kappa[i] = ov.coverage_weeks
            if ov.reorder_point is not None:
                s_abs[i] = ov.reorder_point
            if ov.order_up_to is not None:
                S_abs[i] = ov.order_up_to
            if ov.periodic_review_weeks is not None:
                review[i] = ov.periodic_review_weeks
        return type_code, q, kappa, s_abs, S_abs, review

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        if phase == PhaseId.PH70:
            self._set_levels(ctx)
        elif phase == PhaseId.PH80:
            self._release(ctx)
        elif phase == PhaseId.PH90 and ctx.model.has_mrp:
            self._receive(ctx)

    def _receive(self, ctx: SimContext) -> None:
        """Arrivals landed at this PH-90 are usable next week. The pipeline the
        warm start primed (one expected week per lead-time slot) was not ordered
        by MRP, so it is not counted as an MRP receipt."""
        m = ctx.model
        st = ctx.policy_state[self.id]
        u = ctx.week + 1
        got = np.asarray(ctx.arrivals, dtype=float).copy()
        lt = m.link_lt[m.primary_link]
        primed = np.where((u >= 1) & (u <= lt), np.maximum(m.exp_demand_m, 0.0), 0.0)
        if u < st["received"].shape[1]:
            st["received"][:, u] += np.maximum(got - primed, 0.0)

    def _set_levels(self, ctx: SimContext) -> None:
        m = ctx.model
        kappa = self._kappa(ctx)
        types, q, k_ov, s_abs, S_abs, _rw = self._override_arrays(m)
        kappa_vec = np.where(np.isnan(k_ov), float(kappa), k_ov)

        # κ diagnostics (9bf05df). DEBUG-level, not print(): PH70 runs every
        # simulated week of every replication, in the worker and the browser.
        if _log.isEnabledFor(logging.DEBUG):
            _log.debug("kappa (strip value): %s", kappa)
            _log.debug("k_ov (per-mat override): %s", k_ov)
            _log.debug("kappa_vec (effective): %s", kappa_vec)

        if self.params.basis == "forward_visible":
            # §II.4 Forward-visible schedule (WSC-2026 MTO), inclusive windows:
            # s_m[t] = Σ_{τ=t}^{t+T_s} D̂_m[τ]; S_m[t] = Σ_{τ=t}^{t+T_s+κ} D̂_m[τ].
            # cover_weeks accepts an (n_mats,) array, so per-material κ folds in.
            lt = m.link_lt[m.primary_link]
            t = ctx.week
            s = ctx.forward_material_demand(t, lt)
            S = ctx.forward_material_demand(t, lt + kappa_vec.astype(int))
        else:
            # Eqs. 2–3: s_m = E[D_m]·T_s ; S_m = E[D_m]·(T_s + κ). P-P.3 adds SS after us.
            exp_d = ctx.material_demand
            lt = m.link_lt[m.primary_link].astype(float)
            s = exp_d * lt
            S = exp_d * (lt + kappa_vec)
        # Absolute row-level levels (supplier grid) replace the formula where
        # present. A STATED S is the level: a formula s above it is lowered to
        # it rather than S raised (write_levels keeps S ≥ s); a lone absolute s
        # still lifts a formula S (both-set inversions are refused at
        # validation). An (R,Q) material with a lot orders Q, so S = R + Q.
        has_s = ~np.isnan(s_abs)
        has_S = ~np.isnan(S_abs)
        lot = (types == self._TYPE_CODE["rop_q"]) & ~np.isnan(q)
        if has_s.any():
            s = np.where(has_s, s_abs, s)
        if has_S.any():
            S = np.where(has_S, S_abs, S)
            s = np.where(has_S & ~lot, np.minimum(s, S), s)
        if lot.any():
            S = np.where(lot, s + np.nan_to_num(q), S)
        S = np.maximum(S, s)
        ctx.write_levels(s, S)

    def _release(self, ctx: SimContext) -> None:
        m = ctx.model
        p: InventoryControlParams = self.params
        on_order = ctx.pipeline_on_order()
        position = ctx.on_hand + on_order
        orders_mat = np.zeros(m.n_mats)
        moq = m.link_moq[m.primary_link]
        type_code, qv, _k, _s, _S, review = self._override_arrays(m)
        short = position < ctx.level_s
        deficit = ctx.level_S - position

        mm = type_code == self._TYPE_CODE["min_max"]
        if ctx.week % p.review_cadence_weeks == 0:
            sel = mm & short
            orders_mat[sel] = np.maximum(deficit[sel], moq[sel])

        bs = (type_code == self._TYPE_CODE["base_stock"]) & (deficit > 1e-12)
        orders_mat[bs] = np.maximum(deficit[bs], moq[bs])

        rq = (type_code == self._TYPE_CODE["rop_q"]) & short
        # DECLARED fallback (T2): an (R,Q) material with no Q orders up to S —
        # the min_max lot — never a silent zero order. The mapping states this
        # substitution as a MappingWarning at dispatch.
        q_sel = qv[rq]
        orders_mat[rq] = np.maximum(np.where(np.isnan(q_sel), deficit[rq], q_sel), moq[rq])

        # Periodic review: each material on its own T (the row's, else the
        # project's).
        pr = (type_code == self._TYPE_CODE["periodic"]) & (ctx.week % review == 0)
        sel = pr & (deficit > 1e-12)
        orders_mat[sel] = np.maximum(deficit[sel], moq[sel])

        if m.has_mrp:
            mrp = m.mrp_mask
            orders_mat[mrp] = self._mrp_orders(ctx, on_order)[mrp]

        orders = np.zeros(m.n_links)
        nonzero = orders_mat > 0
        orders[m.primary_link[nonzero]] = orders_mat[nonzero]
        ctx.write_purchase_orders(orders)
        if ctx.decisions.enabled:
            self._record(ctx, type_code, qv, review, short, deficit, position, on_order, moq, orders_mat)

    def _record(self, ctx: SimContext, type_code, qv, review, short, deficit, position, on_order,
                moq, orders_mat) -> None:
        # Reads values _release already computed; changes nothing (facet 11).
        p: InventoryControlParams = self.params
        m = ctx.model
        tc = self._TYPE_CODE
        mm_review = ctx.week % p.review_cadence_weeks == 0
        for i in range(m.n_mats):
            t_i = int(type_code[i])
            if orders_mat[i] > 0:
                if t_i == tc["min_max"]:
                    why = "ordered_min_max"
                elif t_i == tc["base_stock"]:
                    why = "ordered_base_stock"
                elif t_i == tc["rop_q"]:
                    why = "ordered_rop_q_no_lot" if np.isnan(qv[i]) else "ordered_rop_q"
                elif t_i == tc["periodic"]:
                    why = "ordered_periodic"
                else:
                    why = "ordered_mrp"
            elif short[i] and ((t_i == tc["min_max"] and not mm_review)
                               or (t_i == tc["periodic"] and ctx.week % int(review[i]) != 0)):
                why = "held_not_review_week"
            else:
                continue
            self.decide(
                ctx, rationale=why, node_kind="material", node=m.mat_ids[i],
                inputs={"on_hand": float(ctx.on_hand[i]), "on_order": float(on_order[i]),
                        "position": float(position[i]), "reorder_point": float(ctx.level_s[i]),
                        "order_up_to": float(ctx.level_S[i]), "moq": float(moq[i])},
                decision={"order_qty": float(orders_mat[i]),
                          "supplier": m.sup_ids[m.link_sup[m.primary_link[i]]] if orders_mat[i] > 0 else None,
                          "moq_raised_it": bool(orders_mat[i] > 0 and moq[i] > 0
                                                and orders_mat[i] == moq[i])},
            )

    # ------------------------------------------------------------- MRP KPIs

    def kpi_contribution(self, ctx: SimContext, t_w: int, window_end: int) -> dict[str, float]:
        """Only when the run has MRP materials — a run without keeps its KPIs."""
        m = ctx.model
        if not m.has_mrp:
            return {}
        st = ctx.policy_state[self.id]
        w = slice(t_w, window_end)
        return {
            "mrp_late_receipt_weeks": float(st["late"][:, w].sum()),
            "material_shortage_weeks": float(st["shortage"][w].sum()),
        }


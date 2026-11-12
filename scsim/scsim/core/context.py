# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""Compiled model + SimContext — Part IX §9.3 and Part X §10.2.

``CompiledModel`` turns the validated Scenario into index maps and NumPy
arrays once; replications share it read-only. ``SimContext`` is the typed
accessor policies receive: per-week transient state, persistent arrays, the
keyed policy RNG, and the cost ledger. Inner mechanics are array ops over
materials / products / supplier-links (phase-sweep vectorization, §10.2.1);
the in-transit pipeline is a ring buffer over supplier-material links
(§10.2.2) so a 5,000-material week costs milliseconds, not 5,000 events.

Debug builds (default in tests) enforce each hook's declared write-set at
the mutation helpers — a policy writing state it didn't declare is a bug,
not a feature.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy import sparse

from scsim.core.decisions import DecisionLog
from scsim.core.phases import (
    FG_FULFILLMENT,
    FULFILLMENT,
    GROSS_REQUIREMENTS,
    INVENTORY_LEVELS,
    OVERTIME_CAPACITY,
    PRODUCTION_PLAN,
    PURCHASE_ORDERS,
    ST_BACKLOG,
    ST_FG_TARGET,
    ST_PIPELINE,
    BoundHook,
)
from scsim.entities.enums import (
    LeadTimeDist,
    DemandModel,
    EffectType,
    FulfillmentMode,
    OverflowRule,
    RampProfile,
    TransportMode,
)
from scsim.core.leadtime import draws_uniforms, is_stochastic as is_lt_stochastic
from scsim.entities.enums import BOUNDED_LEAD_TIME_DISTS
from scsim.entities.network import lead_time_bounds_cv, primary_rank
from scsim.entities.scenario import Scenario
from scsim.stats.seeds import ReplicationStreams, lane_leadtime_rng, product_prodtime_rng

# C^res components — Part V cost_of_resilience.
COST_COMPONENTS: tuple[str, ...] = (
    "ss_holding",             # P-P.3 incremental material safety-stock holding
    "backup_premium",         # P-S.1 premium on rerouted orders
    "multi_sourcing_premium", # P-S.2 pay-always premium on non-primary slices
    "expediting",             # P-T.2 premium freight
    "overtime",               # P-P.5 short-term capacity
    "lost_sales",             # Σ u_p · L_p
    "allocation_labor",       # P-P.9 planner time
    "fg_ss_holding",          # P-P.4 FG safety stock at full COGS (MTS)
    "backorder_penalty",      # P-C.1 backorder variant
    "monitoring",             # P-S.4 standing visibility cost
)
COST_INDEX = {name: i for i, name in enumerate(COST_COMPONENTS)}


@dataclass(frozen=True)
class ResolvedEvent:
    """A disruption event with all stochastic fields drawn for one replication."""

    supplier_idx: int
    effect: EffectType
    start: int          # 0-based week, inclusive
    end: int            # exclusive — first unaffected week (t_end)
    capacity_factor: float
    overflow_rule: OverflowRule
    onset_profile: RampProfile
    recovery_profile: RampProfile
    ramp_weeks: int
    # node:plant target — applies to the plant's production, not a supplier's
    # inbound. supplier_idx is -1 for these. The time/severity math below is
    # target-agnostic and shared with supplier events.
    is_plant: bool = False
    # node:material target (PLAN.md §27 WP 17.1) — blocks every supply link of
    # this material and no other link of its suppliers. supplier_idx is -1.
    material_idx: int = -1

    @property
    def is_material(self) -> bool:
        return self.material_idx >= 0

    def cap_factor_at(self, t: int) -> float:
        """Effective capacity multiplier at week t (1.0 = unaffected)."""
        if self.effect != EffectType.CAPACITY_REDUCTION:
            return 1.0
        phi = self.capacity_factor
        if self.start <= t < self.end:
            if self.onset_profile == RampProfile.RAMP_LINEAR and self.ramp_weeks > 0:
                k = t - self.start + 1
                if k < self.ramp_weeks:
                    return 1.0 + (phi - 1.0) * (k / self.ramp_weeks)
            return phi
        if self.recovery_profile == RampProfile.RAMP_LINEAR and self.ramp_weeks > 0:
            if self.end <= t < self.end + self.ramp_weeks:
                k = t - self.end + 1
                return phi + (1.0 - phi) * (k / self.ramp_weeks)
        return 1.0

    def lt_active_at(self, t: int) -> bool:
        return self.effect == EffectType.LEAD_TIME_EXTENSION and self.start <= t < self.end


class CompiledModel:
    """Index maps + arrays + instantiated policies for one scenario."""

    def __init__(self, scenario: Scenario):
        net = scenario.network
        self.scenario = scenario
        self.settings = scenario.settings

        self.mat_ids = [m.id for m in net.materials]
        self.prod_ids = [p.id for p in net.products]
        self.sup_ids = [s.id for s in net.suppliers]
        self.mat_index = {mid: i for i, mid in enumerate(self.mat_ids)}
        self.prod_index = {pid: i for i, pid in enumerate(self.prod_ids)}
        self.sup_index = {sid: i for i, sid in enumerate(self.sup_ids)}
        self.n_mats = len(self.mat_ids)
        self.n_prods = len(self.prod_ids)
        self.n_sups = len(self.sup_ids)

        # Products.
        self.unit_price = np.array([p.unit_price for p in net.products])
        self.capacity = np.array([p.production_capacity for p in net.products])
        # P-P.13 production lead time (PLAN.md §26 WP 16.4). `prod_lt` is the
        # PLANNING lead time per product (whole weeks, 0 = same-week completion);
        # the shape and bounds feed the per-(product, week) draw. `has_prod_lt`
        # False — every product 0 and deterministic — keeps the engine on its
        # pre-Phase-15 path, byte for byte.
        self.prod_lt = np.array([p.production_lead_time_weeks for p in net.products], dtype=int)
        self.prod_lt_dist = [p.production_lead_time_dist for p in net.products]
        self.prod_lt_min = np.array([np.nan if p.production_lead_time_min_weeks is None
                                     else float(p.production_lead_time_min_weeks) for p in net.products])
        self.prod_lt_mode = np.array([np.nan if p.production_lead_time_mode_weeks is None
                                      else float(p.production_lead_time_mode_weeks) for p in net.products])
        self.prod_lt_max = np.array([np.nan if p.production_lead_time_max_weeks is None
                                     else float(p.production_lead_time_max_weeks) for p in net.products])
        self.prod_lt_cv = np.array([
            lead_time_bounds_cv(p.production_lead_time_dist, float(p.production_lead_time_min_weeks),
                                p.production_lead_time_mode_weeks, float(p.production_lead_time_max_weeks))
            if p.production_lead_time_dist in BOUNDED_LEAD_TIME_DISTS else p.production_lead_time_cv
            for p in net.products])
        self.prod_lt_stochastic = np.array([
            is_lt_stochastic(self.prod_lt_dist[j], float(self.prod_lt_cv[j]),
                             None if np.isnan(self.prod_lt_min[j]) else self.prod_lt_min[j],
                             None if np.isnan(self.prod_lt_max[j]) else self.prod_lt_max[j])
            for j in range(len(net.products))], dtype=bool)
        self.has_prod_lt = bool((self.prod_lt > 0).any() or self.prod_lt_stochastic.any())
        # The production pipeline ring: completion slots ahead of the start week,
        # wide enough for the longest planning L and any bound, plus slack for a
        # CV draw's tail; a draw beyond it is bounded and counted (F-36's rule).
        bound_max = np.nanmax(self.prod_lt_max) if np.isfinite(self.prod_lt_max).any() else 0.0
        self.prod_ring_width = int(max(int(self.prod_lt.max(initial=0)), int(np.ceil(bound_max)))) + 30
        nu = self.settings.demand_floor_factor
        tri = np.array([p.triangular_params(nu) for p in net.products])
        self.demand_a, self.demand_b, self.demand_c = tri[:, 0], tri[:, 1], tri[:, 2]
        self.demand_model_of = [p.demand_model for p in net.products]
        self.negbin_k = np.array([p.negbin_dispersion for p in net.products])
        # σ = cv · b for demand_model=normal (WP 14.1); 0 for every other model.
        self.demand_cv_p = np.array([
            float(p.demand_cv or 0.0) if p.demand_model == DemandModel.NORMAL else 0.0
            for p in net.products
        ])
        self.demand_history = [np.asarray(p.demand_history, dtype=float) for p in net.products]
        self.mean_demand_p = np.array([p.mean_demand(nu) for p in net.products])
        self.var_demand_p = self._demand_variances()

        # BoM as sparse CSR (production O(nnz), §10.3).
        rows, cols, vals = [], [], []
        for line in net.bom:
            rows.append(self.prod_index[line.product_id])
            cols.append(self.mat_index[line.material_id])
            vals.append(line.rate)
        self.bom = sparse.csr_matrix(
            (vals, (rows, cols)), shape=(self.n_prods, self.n_mats), dtype=float
        )
        self.bom_csc = self.bom.tocsc()
        consumers = np.diff(self.bom_csc.indptr)
        self.shared_mats = np.flatnonzero(consumers > 1)

        # Materials.
        self.mat_cost = np.array([m.cost for m in net.materials])
        self.mat_holding_weekly = np.array(
            [m.cost * m.holding_cost_rate / 100.0 / 52.0 for m in net.materials]
        )
        self.mat_initial = np.array(
            [-1.0 if m.initial_on_hand is None else m.initial_on_hand for m in net.materials]
        )
        self.exp_demand_m = np.asarray(self.bom.T @ self.mean_demand_p).ravel()  # Eq. 1
        self.var_demand_m = np.asarray((self.bom.power(2)).T @ self.var_demand_p).ravel()

        # Supplier-material links, sorted per material by `primary_rank` so
        # links_of_mat[m][0] is the primary source: the link the user chose on
        # /policies, else min cost (manuscript §3.5).
        links = sorted(
            net.supplier_links,
            key=lambda l: (self.mat_index[l.material_id], *primary_rank(l)),
        )
        self.n_links = len(links)
        self.link_sup = np.array([self.sup_index[l.supplier_id] for l in links], dtype=int)
        self.link_mat = np.array([self.mat_index[l.material_id] for l in links], dtype=int)
        # Edge lead-time split (M7): a lane's transit time composes into the
        # effective link lead time, so planning (s_m/S_m coverage), shipping,
        # and ring sizing all see the same total. Quoting transit on the lane
        # is exactly equivalent to folding it into the supplier link (tested
        # byte-identical). One lane per supplier binds in v1: the default-mode
        # lane wins, then lowest id; per-mode pipelines land with P-T.1.
        lane_extra: dict[str, int] = {}
        for lane in sorted(net.lanes, key=lambda l: (l.mode != TransportMode.DEFAULT, l.id)):
            lane_extra.setdefault(lane.supplier_id, int(lane.lead_time_weeks))
        self.link_lt = np.array(
            [l.lead_time_weeks + lane_extra.get(l.supplier_id, 0) for l in links], dtype=int
        )
        self.link_cost = np.array([l.cost for l in links])
        self.link_moq = np.array([l.moq for l in links])
        # A scenario's backup-only source (P-S.1): never primary, no planned share.
        self.link_backup_only = np.array([l.backup_only for l in links], dtype=bool)
        self.link_lt_dist = [l.lead_time_dist for l in links]
        # The bounded shapes (triangular, uniform; PLAN.md §26 WP 16.1) carry
        # their bounds, shifted by the lane's transit leg exactly as the planning
        # lead time is; NaN where a link has none. Their CV is the shape's own
        # σ/μ, which is what P-P.3's King formula reads for a lognormal or gamma
        # link — one σ_LT whatever the shape. Every other link keeps its input CV,
        # so a project with no bounded shape compiles byte-identically.
        def _bound(l, v):
            return np.nan if v is None else float(v) + lane_extra.get(l.supplier_id, 0)
        self.link_lt_min = np.array([_bound(l, l.lead_time_min_weeks) for l in links])
        self.link_lt_mode = np.array([_bound(l, l.lead_time_mode_weeks) for l in links])
        self.link_lt_max = np.array([_bound(l, l.lead_time_max_weeks) for l in links])
        self.link_lt_cv = np.array([
            lead_time_bounds_cv(l.lead_time_dist, float(l.lead_time_min_weeks),
                                l.lead_time_mode_weeks, float(l.lead_time_max_weeks))
            if l.lead_time_dist in BOUNDED_LEAD_TIME_DISTS else l.lead_time_cv
            for l in links])
        self.link_lt_stochastic = np.array([
            is_lt_stochastic(self.link_lt_dist[k], float(self.link_lt_cv[k]),
                             None if np.isnan(self.link_lt_min[k]) else self.link_lt_min[k],
                             None if np.isnan(self.link_lt_max[k]) else self.link_lt_max[k])
            for k in range(len(links))], dtype=bool)
        self.links_of_mat: list[np.ndarray] = [
            np.flatnonzero(self.link_mat == m) for m in range(self.n_mats)
        ]
        self.primary_link = np.array([idx[0] for idx in self.links_of_mat], dtype=int)
        # Aggregation matrix link → material (CSR for fast pipeline sums).
        self.link_to_mat = sparse.csr_matrix(
            (np.ones(self.n_links), (self.link_mat, np.arange(self.n_links))),
            shape=(self.n_mats, self.n_links),
        )

        self.sup_capacity = np.array(
            [np.inf if s.capacity_per_week is None else s.capacity_per_week for s in net.suppliers]
        )
        self.sup_reliability = np.array([s.reliability_score for s in net.suppliers])
        self.lane_supplier = {l.id: self.sup_index[l.supplier_id] for l in net.lanes}
        self.links_of_sup: list[np.ndarray] = [
            np.flatnonzero(self.link_sup == s) for s in range(self.n_sups)
        ]
        self.demand_groups: list[tuple[DemandModel, np.ndarray]] = []
        for dm in DemandModel:
            idx = np.array(
                [j for j, mdl in enumerate(self.demand_model_of) if mdl == dm], dtype=int
            )
            if idx.size:
                self.demand_groups.append((dm, idx))

        # Fulfillment mode split (CODP, §3.3). MTO stays the no-op PH-30 path.
        self.mts_mask = np.array(
            [p.fulfillment_mode == FulfillmentMode.MTS for p in net.products]
        )
        self.forecast_model_of = [p.forecast_model for p in net.products]
        self.forecast_window = np.array([p.forecast_window for p in net.products], dtype=int)
        self.forecast_bias = np.array([p.forecast_bias for p in net.products]) / 100.0
        self.fg_base_stock_override = np.array(
            [-1.0 if p.fg_base_stock is None else p.fg_base_stock for p in net.products]
        )
        # FG policies (WP 14.4, ADR 0002 decision 3): 0 base_stock, 1 min_max,
        # 2 days_of_cover. `fg_typed` marks a product whose target is a TYPED
        # level (S, (s, S) or D): P-P.4 adds nothing on top of it.
        from scsim.entities.enums import FgPolicy as _Fg
        _code = {_Fg.BASE_STOCK: 0, _Fg.MIN_MAX: 1, _Fg.DAYS_OF_COVER: 2}
        self.fg_policy_code = np.array([_code[p.fg_policy] for p in net.products], dtype=int)
        self.fg_reorder_point = np.array(
            [np.nan if p.fg_reorder_point is None else p.fg_reorder_point for p in net.products])
        self.fg_cover_days = np.array(
            [np.nan if p.fg_cover_days is None else p.fg_cover_days for p in net.products])
        self.fg_initial = np.array(
            [-1.0 if p.fg_initial_on_hand is None else p.fg_initial_on_hand for p in net.products])
        self.fg_typed = (self.fg_policy_code != 0) | (self.fg_base_stock_override >= 0)
        # Planning horizon H (weeks of planned production, week t first). 1 until
        # MRP sets it (WP 14.5): with H = 1 the plan IS this week's production plan.
        self.plan_horizon = 1
        # MRP materials (WP 14.5), set at compile by P-P.1 (`configure_model`),
        # which also raises `plan_horizon` to the longest MRP lead time + 1.
        self.mrp_mask = np.zeros(self.n_mats, dtype=bool)
        self.has_mrp = False
        # Replenishment levels the planner STATED on a /policies row, set at
        # compile by P-P.1 (`configure_model`). A stated level IS the level:
        # P-P.3 adds no buffer on top of it and nothing raises it. An (R,Q)
        # material with a lot orders Q, so its S is R + Q and follows R.
        self.stated_s_mask = np.zeros(self.n_mats, dtype=bool)
        self.stated_S_mask = np.zeros(self.n_mats, dtype=bool)
        self.lot_S_mask = np.zeros(self.n_mats, dtype=bool)
        # A row's κ (NaN = the project's). P-P.3's Eq. 21 reads the same κ the
        # level formula does.
        self.kappa_override = np.full(self.n_mats, np.nan)
        # Full COGS per FG unit (P-P.4 holding basis): Σ_m r_{p,m} · c_m.
        self.fg_unit_cogs = np.asarray(self.bom @ self.mat_cost).ravel()

        # Customers (P-C.2). Share matrix rows are normalized per product;
        # products with no customer_links split uniformly — behavior-neutral
        # until a customer-allocation policy reads it.
        self.cust_ids = [c.id for c in net.customers]
        self.n_custs = len(self.cust_ids)
        self.cust_index = {cid: i for i, cid in enumerate(self.cust_ids)}
        self.cust_priority = np.array([c.priority_weight for c in net.customers])
        self.cust_segment = [c.segment for c in net.customers]
        if self.n_custs:
            W = np.zeros((self.n_prods, self.n_custs))
            for cl in net.customer_links:
                W[self.prod_index[cl.product_id], self.cust_index[cl.customer_id]] = cl.share
            unlinked = W.sum(axis=1) == 0.0
            W[unlinked, :] = 1.0
            self.cust_share = W / W.sum(axis=1, keepdims=True)
        else:
            self.cust_share = np.zeros((self.n_prods, 0))

        # Ring width: longest quoted arrival distance is max(T_link, deferral≤52)
        # plus the recovery ramp; +4 slack (§10.2.2).
        self.ring_width = int(self.link_lt.max()) + 52 + 8 + 4

        # Demand per customer × product row (WP 14.1, ADR 0002 decision 2).
        self._compile_demand_rows(net)

    # Weeks of plan view kept past the drawn schedule, so a planner looking
    # ahead from the last simulated week still reads a defined value.
    PLAN_PAD_WEEKS = 64

    def _compile_demand_rows(self, net) -> None:
        """Rows = customer × product pairs, product-major (CSR ``row_ptr``).

        Every product owns at least one row: a product no customer link names
        gets one IMPLICIT row (customer index −1, share 1). Each row has a
        CENTRE per week — the expected value of that week's distribution and
        the only thing the plan reads (``SimContext.projected_demand_rows``):
        the forecast value, else the row's mean, else (no spec) the product's
        mean × the row's share.

        ``has_row_demand`` is True when ANY link carries a spec; only then is
        demand drawn per row. Otherwise the per-product draw is unchanged and
        the rows exist for the plan's view alone.
        """
        T = self.settings.horizon
        Tc = T + self.settings.visibility_horizon + self.PLAN_PAD_WEEKS
        self.demand_horizon = T + self.settings.visibility_horizon
        links = sorted(net.customer_links,
                       key=lambda cl: (self.prod_index[cl.product_id],
                                       self.cust_index[cl.customer_id]))
        linked = {cl.product_id for cl in links}
        rows: list[tuple[int, int, Optional[object]]] = []
        it = iter(links)
        nxt = next(it, None)
        for j, pid in enumerate(self.prod_ids):
            if pid not in linked:
                rows.append((j, -1, None))
                continue
            while nxt is not None and nxt.product_id == pid:
                rows.append((j, self.cust_index[nxt.customer_id], nxt))
                nxt = next(it, None)
        R = len(rows)
        self.n_rows = R
        self.row_prod = np.array([r[0] for r in rows], dtype=int)
        self.row_cust = np.array([r[1] for r in rows], dtype=int)
        self.row_ptr = np.concatenate([[0], np.cumsum(np.bincount(self.row_prod,
                                                                  minlength=self.n_prods))])
        self.row_ids = [
            f"{self.cust_ids[c] if c >= 0 else ''}::{self.prod_ids[j]}" for j, c, _ in rows
        ]
        raw_share = np.array([1.0 if l is None else float(l.share) for _, _, l in rows])
        tot = np.bincount(self.row_prod, weights=raw_share, minlength=self.n_prods)
        self.row_share = raw_share / tot[self.row_prod]
        self.row_to_prod = sparse.csr_matrix(
            (np.ones(R), (self.row_prod, np.arange(R))), shape=(self.n_prods, R))
        specs = [l for _, _, l in rows]
        # Per-row fulfillment inputs (WP 14.3, ADR 0002 decision 4): the row's
        # price (its own, else the product's), its customer's priority and its
        # customer's contracted floor (NaN = none). An implicit row has no
        # customer: priority 1.0, no floor.
        self.row_price = np.array([
            float(l.unit_price) if l is not None and l.unit_price is not None
            else float(self.unit_price[j]) for j, _c, l in rows])
        self.row_cust_priority = np.array([
            float(self.cust_priority[c]) if c >= 0 else 1.0 for _j, c, _l in rows])
        floors = [c.sla_fill_floor_pct for c in net.customers]
        self.row_cust_floor = np.array([
            np.nan if c < 0 or floors[c] is None else float(floors[c]) for _j, c, _l in rows])
        self.row_has_spec = np.array([l is not None and l.has_demand_spec for l in specs])
        self.has_row_demand = bool(self.row_has_spec.any())
        self.row_forecast_short: list[dict] = []

        # Per-row draw parameters. Kinds reuse DemandModel; triangular rows
        # carry their shape as RATIOS of the centre (a/m, b/m, c/m with m the
        # triangle's mean), so a forecast that moves the centre scales the
        # triangle and its expected value is exactly the forecast.
        kind: list[DemandModel] = []
        tri = np.zeros((R, 3))
        cv = np.zeros(R)
        k_nb = np.ones(R)
        centre = np.zeros((R, Tc))
        for r, (j, _c, link) in enumerate(rows):
            share = self.row_share[r]
            if link is None or not link.has_demand_spec:
                dm = self.demand_model_of[j]
                kind.append(dm)
                m = self.mean_demand_p[j]
                centre[r, :] = m * share
                if dm == DemandModel.TRIANGULAR:
                    a, b, c = self.demand_a[j], self.demand_b[j], self.demand_c[j]
                    tri[r] = (a / m, b / m, c / m) if m > 0 else (0.0, 0.0, 0.0)
                elif dm == DemandModel.NORMAL:
                    cv[r] = self.demand_cv_p[j]
                elif dm == DemandModel.NEGBIN:
                    k_nb[r] = self.negbin_k[j]
                continue
            model = link.demand_model or "deterministic"
            if model == "triangular":
                m3 = (link.demand_min + link.demand_mean + link.demand_max) / 3.0
                tri[r] = ((link.demand_min / m3, link.demand_mean / m3, link.demand_max / m3)
                          if m3 > 0 else (0.0, 0.0, 0.0))
                base = m3
                kind.append(DemandModel.TRIANGULAR)
            elif model == "triangular_av":
                v = float(link.demand_variation)
                tri[r] = (max(0.0, 1.0 - v), 1.0, 1.0 + v)
                base = link.demand_mean
                kind.append(DemandModel.TRIANGULAR)
            elif model == "normal":
                cv[r] = float(link.demand_variation)
                base = link.demand_mean
                kind.append(DemandModel.NORMAL)
            elif model == "poisson":
                base = link.demand_mean
                kind.append(DemandModel.POISSON)
            else:
                base = link.demand_mean
                kind.append(DemandModel.DETERMINISTIC)
            fc = link.forecast
            if fc is None:
                centre[r, :] = float(base)
                continue
            n = min(len(fc), Tc)
            centre[r, :n] = np.asarray(fc[:n], dtype=float)
            if len(fc) < Tc:
                tail = float(base) if base is not None else float(fc[-1])
                centre[r, n:] = tail
                if len(fc) < T:
                    self.row_forecast_short.append({
                        "row": self.row_ids[r], "weeks": len(fc), "horizon": T,
                        "tail": tail, "tail_source": "mean" if base is not None else "last value",
                    })
        self.row_kind = kind
        self.row_tri = tri
        self.row_cv = cv
        self.row_negbin_k = k_nb
        self.row_centre = centre
        self.row_groups: list[tuple[DemandModel, np.ndarray]] = []
        for dm in DemandModel:
            idx = np.array([r for r, km in enumerate(kind) if km == dm], dtype=int)
            if idx.size:
                self.row_groups.append((dm, idx))

        if self.has_row_demand:
            # The product's stationary mean IS the sum of its rows' means over
            # the simulated weeks — what P-P.1 sizes on, the material
            # expectation and the cold-start forecast all read.
            row_mean = centre[:, :T].mean(axis=1)
            self.mean_demand_p = np.asarray(self.row_to_prod @ row_mean).ravel()
            self.var_demand_p = np.asarray(self.row_to_prod @ self._row_variances(row_mean)).ravel()
            self.exp_demand_m = np.asarray(self.bom.T @ self.mean_demand_p).ravel()
            self.var_demand_m = np.asarray((self.bom.power(2)).T @ self.var_demand_p).ravel()

    def _row_variances(self, row_mean: np.ndarray) -> np.ndarray:
        out = np.zeros(self.n_rows)
        for r, dm in enumerate(self.row_kind):
            m = row_mean[r]
            if dm == DemandModel.TRIANGULAR:
                a, b, c = self.row_tri[r] * m
                out[r] = (a * a + b * b + c * c - a * b - a * c - b * c) / 18.0
            elif dm == DemandModel.POISSON:
                out[r] = m
            elif dm == DemandModel.NORMAL:
                out[r] = (self.row_cv[r] * m) ** 2
            elif dm == DemandModel.NEGBIN:
                out[r] = m + m * m / self.row_negbin_k[r]
            elif dm == DemandModel.BOOTSTRAP:
                j = self.row_prod[r]
                h = self.demand_history[j]
                out[r] = float(h.var(ddof=1)) * self.row_share[r] ** 2 if h.size > 1 else 0.0
        return out

    def _demand_variances(self) -> np.ndarray:
        out = np.zeros(self.n_prods)
        for j, model in enumerate(self.demand_model_of):
            a, b, c = self.demand_a[j], self.demand_b[j], self.demand_c[j]
            if model == DemandModel.TRIANGULAR:
                out[j] = (a * a + b * b + c * c - a * b - a * c - b * c) / 18.0
            elif model == DemandModel.POISSON:
                out[j] = b
            elif model == DemandModel.NEGBIN:
                out[j] = b + b * b / self.negbin_k[j]
            elif model == DemandModel.BOOTSTRAP and self.demand_history[j].size > 1:
                out[j] = float(self.demand_history[j].var(ddof=1))
            elif model == DemandModel.NORMAL:
                out[j] = (self.demand_cv_p[j] * b) ** 2
            else:  # deterministic
                out[j] = 0.0
        return out


def _draw_normal(rng: np.random.Generator, mu: np.ndarray, cv: np.ndarray,
                 clips: Optional[np.ndarray], clip_add: Optional[np.ndarray],
                 idx: np.ndarray) -> np.ndarray:
    """N(μ, σ = cv·μ) with negative draws set to 0 (ADR 0002, decision 8).

    ``clips[idx]`` counts the clipped draws and ``clip_add[idx]`` sums what
    clipping added (−x for each x < 0), so the run can report how often it
    happened and how far it raised the realized mean. Pass ``None`` to draw
    without counting (the look-ahead tail beyond the horizon)."""
    raw = rng.normal(mu, np.maximum(cv * mu, 0.0))
    neg = raw < 0.0
    if clips is not None and neg.any():
        clips[idx] += neg
        clip_add[idx] += np.where(neg, -raw, 0.0)
    return np.where(neg, 0.0, raw)


def draw_week_demand(model: CompiledModel, rng: np.random.Generator, out: np.ndarray,
                     clips: Optional[np.ndarray] = None,
                     clip_add: Optional[np.ndarray] = None) -> None:
    """Draw one week of product demand into ``out``.

    The per-group draw sequence is the world-stream consumption contract:
    golden traces byte-compare on it, so schedule pre-generation and the
    former per-week loop must consume ``rng`` in exactly this order. NORMAL
    (WP 14.1) is the last DemandModel, so it is the last group and every
    pre-existing sequence is unchanged.
    """
    for model_type, idx in model.demand_groups:
        if model_type == DemandModel.TRIANGULAR:
            a, b, c = model.demand_a[idx], model.demand_b[idx], model.demand_c[idx]
            spread = c > a + 1e-12
            vals = np.where(spread, 0.0, b)
            if spread.any():
                vals[spread] = rng.triangular(a[spread], b[spread], c[spread])
            out[idx] = vals
        elif model_type == DemandModel.DETERMINISTIC:
            out[idx] = model.demand_b[idx]
        elif model_type == DemandModel.POISSON:
            out[idx] = rng.poisson(model.demand_b[idx]).astype(float)
        elif model_type == DemandModel.NEGBIN:
            b, k = model.demand_b[idx], model.negbin_k[idx]
            p = k / (k + np.maximum(b, 1e-12))
            out[idx] = rng.negative_binomial(k, p).astype(float)
        elif model_type == DemandModel.BOOTSTRAP:
            for j in idx:
                out[j] = float(rng.choice(model.demand_history[j]))
        else:  # NORMAL
            out[idx] = _draw_normal(rng, model.demand_b[idx], model.demand_cv_p[idx],
                                    clips, clip_add, idx)


def draw_week_demand_rows(model: CompiledModel, rng: np.random.Generator, t: int,
                          out: np.ndarray, clips: Optional[np.ndarray] = None,
                          clip_add: Optional[np.ndarray] = None) -> None:
    """Draw week ``t`` of demand PER CUSTOMER × PRODUCT ROW into ``out`` (WP 14.1).

    THE ROW CONSUMPTION CONTRACT — a new world-stream contract, used only when
    some row carries a demand spec (``model.has_row_demand``); a network with
    none keeps ``draw_week_demand`` and its contract byte for byte. Weeks are
    drawn in order 0 … T+τ*−1; within a week, rows are drawn by kind in
    DemandModel order (deterministic, triangular, poisson, negbin, bootstrap,
    normal), and within a kind in row order (product-major, then customer).
    Each row is centred on ``model.row_centre[:, t]``: its forecast, its mean,
    or its product's mean × share. The draw depends only on settings, network
    and the world seed — never on the policy portfolio (G-RNG invariance).
    """
    centre = model.row_centre[:, t]
    for model_type, idx in model.row_groups:
        c = centre[idx]
        if model_type == DemandModel.TRIANGULAR:
            shape = model.row_tri[idx]
            a, b, cc = shape[:, 0] * c, shape[:, 1] * c, shape[:, 2] * c
            spread = cc > a + 1e-12
            vals = np.where(spread, 0.0, b)
            if spread.any():
                vals[spread] = rng.triangular(a[spread], b[spread], cc[spread])
            out[idx] = vals
        elif model_type == DemandModel.DETERMINISTIC:
            out[idx] = c
        elif model_type == DemandModel.POISSON:
            out[idx] = rng.poisson(np.maximum(c, 0.0)).astype(float)
        elif model_type == DemandModel.NEGBIN:
            k = model.row_negbin_k[idx]
            p = k / (k + np.maximum(c, 1e-12))
            out[idx] = rng.negative_binomial(k, p).astype(float)
        elif model_type == DemandModel.BOOTSTRAP:
            for r in idx:
                j = model.row_prod[r]
                out[r] = float(rng.choice(model.demand_history[j])) * model.row_share[r]
        else:  # NORMAL
            out[idx] = _draw_normal(rng, c, model.row_cv[idx], clips, clip_add, idx)


class CostLedger:
    def __init__(self, horizon: int):
        self.weekly = np.zeros((len(COST_COMPONENTS), horizon))
        self._t = 0

    def set_week(self, t: int) -> None:
        self._t = t

    def add(self, component: str, amount: float) -> None:
        self.weekly[COST_INDEX[component], self._t] += amount

    def total_by_component(self, start: int, end: int) -> dict[str, float]:
        window = self.weekly[:, start:end].sum(axis=1)
        return {name: float(window[i]) for i, name in enumerate(COST_INDEX)}


@dataclass(frozen=True)
class WeeklySeries:
    """One always-on weekly scalar, declared once.

    `key` is BOTH the attribute name on `WeeklyTrace` and the name the series
    travels under everywhere downstream — the golden-trace column, the progress
    observer, `ScenarioResult.extra_series`, `run_replications.time_series` and
    the chart that reads it. One name, one place it is written down.

    `aggregation` says what may honestly be done to the series across weeks:

        level  — a stock measured at the end of the week (on-hand, backlog).
                 Averaging is meaningful; summing is not: adding a stock to
                 itself week after week counts the same goods repeatedly.
        flow   — a quantity that happened during the week (revenue, lost units).
                 Summing is meaningful; averaging gives a per-week rate.
        ratio  — a quotient (fill rate). NEITHER sum nor plain mean is correct
                 across weeks; the honest aggregate is the ratio of the summed
                 numerator to the summed denominator.

    `published` marks the series that leave the engine and reach a user. The
    rest stay in the golden trace. Before this declaration existed that subset
    was a second hand-maintained list, and `fg_value` — finished-goods
    inventory, computed on every replication of every run since the trace was
    written — fell into the gap between the two and was discarded for the whole
    of its life (§4 D163 / G19).
    """

    key: str
    unit: str
    aggregation: str       # "level" | "flow" | "ratio"
    published: bool
    doc: str


# THE weekly-series vocabulary. Adding a series is one row here; nothing else
# in the engine keeps a parallel list. `WeeklyTrace.__post_init__` allocates
# from it, `io.traces.trace_frame` orders the golden trace by it, and
# `core.engine` builds both `fr_series` and `extra_series` from it.
WEEKLY_SERIES: tuple[WeeklySeries, ...] = (
    WeeklySeries("demand_value", "currency", "flow", False,
                 "Demand valued at sell price."),
    WeeklySeries("fulfilled_value", "currency", "flow", False,
                 "Demand served, capped at demand — the fill-rate numerator."),
    WeeklySeries("revenue_value", "currency", "flow", True,
                 "Units shipped at sell price, including backlog clearing."),
    WeeklySeries("lost_value", "currency", "flow", False,
                 "Demand lost rather than backlogged, at sell price."),
    WeeklySeries("lost_units", "units", "flow", False,
                 "Demand lost rather than backlogged, in units."),
    WeeklySeries("backlog_units", "units", "level", True,
                 "Unserved demand still owed at the end of the week."),
    WeeklySeries("fill_rate", "fraction", "ratio", True,
                 "Fulfilled value over demand value; 1.0 in a week with no demand."),
    WeeklySeries("inbound_rejected", "units", "flow", False,
                 "Inbound material refused this week."),
    WeeklySeries("on_hand_value", "currency", "level", True,
                 "Material inventory on hand at the end of the week, at unit cost."),
    WeeklySeries("fg_value", "currency", "level", True,
                 "Finished-goods inventory on hand at the end of the week, at unit COGS."),
    WeeklySeries("on_hand_units", "units", "level", True,
                 "Material inventory on hand at the end of the week, in units. "
                 "Summed across materials, which carry no declared unit of "
                 "measure — see the note this obliges at the point of display."),
    WeeklySeries("fg_units", "units", "level", True,
                 "Finished-goods inventory on hand at the end of the week, in units. "
                 "Summed across products, with the same caveat as `on_hand_units`."),
    # ── Capacity (WP 9.3 / §4 D167) ──────────────────────────────────────────
    # `capacity_utilization` has been a KPI since the KPI module was written and
    # it read `trace.Q`, which exists only under `full_debug` — so on every
    # Monte Carlo run it was NaN, and the /policies sanity panel printed "not
    # recorded" for a quantity the engine clips production against every single
    # week. These four are plain weekly scalars, so the measure exists on EVERY
    # run, and the KPI is computed from them.
    #
    # A `flow` and not a `level`: capacity is a quantity the week can pass, and
    # the honest cross-week aggregate of a utilization is Σused / Σavailable —
    # which is why the pair is published rather than the ratio.
    WeeklySeries("plant_capacity_units", "units", "flow", True,
                 "Plant production capacity available this week, summed across "
                 "products — after any disruption throttle and any short-term "
                 "capacity (P-P.5) the portfolio added."),
    WeeklySeries("plant_capacity_used_units", "units", "flow", True,
                 "Units actually produced this week, summed across products. "
                 "Below the line above either because demand did not need the "
                 "capacity or because materials ran out — capacity BINDING is a "
                 "different measure, carried per product in `capacity_binding`."),
    WeeklySeries("supplier_capacity_units", "units", "flow", True,
                 "Weekly shipping capacity of the suppliers that declare a FINITE "
                 "one, after any disruption throttle. A supplier whose "
                 "`capacity_per_week` is empty is unlimited and contributes to "
                 "neither this series nor the one below — so a project that "
                 "declares no capacity at all reports 0/0 rather than a "
                 "utilization computed against infinity."),
    WeeklySeries("supplier_capacity_used_units", "units", "flow", True,
                 "Units shipped this week by those same finite-capacity suppliers."),
)

WEEKLY_SERIES_KEYS: tuple[str, ...] = tuple(s.key for s in WEEKLY_SERIES)
PUBLISHED_SERIES_KEYS: tuple[str, ...] = tuple(
    s.key for s in WEEKLY_SERIES if s.published
)


@dataclass
class WeeklyTrace:
    """Always-on weekly scalars + optional per-entity matrices (full_debug)."""

    horizon: int
    n_prods: int
    n_mats: int
    keep_matrices: bool
    n_sups: int = 0
    demand_value: np.ndarray = field(init=False)
    fulfilled_value: np.ndarray = field(init=False)   # capped at demand (FR numerator)
    revenue_value: np.ndarray = field(init=False)     # u·F including backlog clearing
    lost_value: np.ndarray = field(init=False)
    lost_units: np.ndarray = field(init=False)
    backlog_units: np.ndarray = field(init=False)
    fill_rate: np.ndarray = field(init=False)
    inbound_rejected: np.ndarray = field(init=False)
    on_hand_value: np.ndarray = field(init=False)
    fg_value: np.ndarray = field(init=False)
    on_hand_units: np.ndarray = field(init=False)
    fg_units: np.ndarray = field(init=False)
    plant_capacity_units: np.ndarray = field(init=False)
    plant_capacity_used_units: np.ndarray = field(init=False)
    supplier_capacity_units: np.ndarray = field(init=False)
    supplier_capacity_used_units: np.ndarray = field(init=False)
    # Per-entity capacity BINDING, always on rather than gated on `full_debug`
    # (WP 9.3). 1.0 in the weeks where capacity was the thing that clipped the
    # plan / the shipment, 0.0 otherwise. Two `[n, horizon]` float matrices is
    # the price of answering "for WHICH products" on an ordinary Monte Carlo
    # run, which the `full_debug`-only matrices below cannot: they exist on
    # single-replication inspection runs and nowhere else.
    #
    # Deliberately NOT weekly series: a per-entity matrix is not a scalar, and
    # widening WEEKLY_SERIES to carry one would make every declared aggregation
    # rule ("level"/"flow"/"ratio") a lie about half its rows.
    prod_cap_bound: np.ndarray = field(init=False)
    sup_cap_bound: np.ndarray = field(init=False)
    # Work in progress (P-P.13, PLAN.md §26 WP 16.4): units started and not yet
    # completed, and their material value, after each week's completions. All
    # zero for a run with no production lead time. Deliberately NOT weekly
    # series: publishing one would move every golden digest for a quantity that
    # is zero on every existing project; the run carries a summary instead
    # (`ScenarioResult.work_in_progress`) and inspection runs the per-product
    # matrix `WIP`.
    wip_units: np.ndarray = field(init=False)
    wip_value: np.ndarray = field(init=False)
    WIP: Optional[np.ndarray] = None
    D: Optional[np.ndarray] = None
    PD: Optional[np.ndarray] = None
    # WP 14.5 — the MRP record per material (need over the lead time, on hand
    # after production, on the way, net), allocated by P-P.1 when a run has MRP
    # materials and keeps matrices.
    MRP_NEED: Optional[np.ndarray] = None
    MRP_ON_HAND: Optional[np.ndarray] = None
    MRP_ON_WAY: Optional[np.ndarray] = None
    MRP_NET: Optional[np.ndarray] = None
    REQ: Optional[np.ndarray] = None
    PLAN: Optional[np.ndarray] = None
    Q: Optional[np.ndarray] = None
    F: Optional[np.ndarray] = None
    B: Optional[np.ndarray] = None
    L: Optional[np.ndarray] = None
    I_mat: Optional[np.ndarray] = None
    # Per-material in-transit (pipeline content) and weekly purchase orders,
    # aggregated over supplier links — the inspection-mode companions of
    # I_mat (single-run inspection surface, platform blueprint §9.5.1/G17).
    I_transit: Optional[np.ndarray] = None
    O_mat: Optional[np.ndarray] = None
    # Per-product finished-goods stock and its target S^FG, week by week — the
    # per-item halves of the `fg_units` scalar (inspection only). Zero for a
    # make-to-order product, which holds no FG stock by design (ADR 0001).
    FG: Optional[np.ndarray] = None
    FG_TARGET: Optional[np.ndarray] = None

    def __post_init__(self) -> None:
        T = self.horizon
        # Allocated FROM the declaration, so a series cannot be declared and
        # then not exist — the failure mode this loop used to have when it
        # carried its own copy of the list.
        for name in WEEKLY_SERIES_KEYS:
            setattr(self, name, np.zeros(T))
        self.prod_cap_bound = np.zeros((self.n_prods, T))
        self.sup_cap_bound = np.zeros((self.n_sups, T))
        self.wip_units = np.zeros(T)
        self.wip_value = np.zeros(T)
        if self.keep_matrices:
            self.D = np.zeros((self.n_prods, T))
            # WP 14.4 — the plan's own record per product: projected demand,
            # requirement and planned production for the week (inspection only).
            self.PD = np.zeros((self.n_prods, T))
            self.REQ = np.zeros((self.n_prods, T))
            self.PLAN = np.zeros((self.n_prods, T))
            self.Q = np.zeros((self.n_prods, T))
            self.F = np.zeros((self.n_prods, T))
            self.B = np.zeros((self.n_prods, T))
            self.L = np.zeros((self.n_prods, T))
            self.I_mat = np.zeros((self.n_mats, T))
            self.I_transit = np.zeros((self.n_mats, T))
            self.O_mat = np.zeros((self.n_mats, T))
            self.FG = np.zeros((self.n_prods, T))
            self.FG_TARGET = np.zeros((self.n_prods, T))


class WriteGuardError(RuntimeError):
    pass


class SimContext:
    """The world as one replication sees it. Policies receive exactly this."""

    def __init__(
        self,
        model: CompiledModel,
        streams: ReplicationStreams,
        events: list[ResolvedEvent],
        keep_matrices: bool,
        debug: bool = True,
    ):
        self.model = model
        self.streams = streams
        self.events = events
        self.debug = debug
        T = model.settings.horizon

        # Stochastic lead-time variates, pre-drawn per (link, week) from the WORLD
        # stream before any policy acts (audit F-24). Drawing at ship time made
        # the number of draws — and so every later lead time — depend on how
        # many orders the policy shipped, which broke common random numbers
        # across scenarios. Standardised so the shipment's own mean (a policy
        # may expedite) is applied at use: a standard normal for lognormal
        # links, Gamma(shape=1/cv², 1) for gamma links, 0 for the rest.
        self.lt_variates = np.zeros((model.n_links, T))
        for k in range(model.n_links):
            cv = float(model.link_lt_cv[k])
            dist = model.link_lt_dist[k]
            if cv <= 0 or dist == LeadTimeDist.DETERMINISTIC:
                continue
            if dist == LeadTimeDist.LOGNORMAL:
                self.lt_variates[k] = streams.leadtime.standard_normal(T)
            elif dist == LeadTimeDist.GAMMA:
                self.lt_variates[k] = streams.leadtime.gamma(1.0 / (cv * cv), 1.0, T)
        # The demand-style shapes (normal, triangular, uniform — PLAN.md §26 WP
        # 15.1): standard uniforms from each lane's OWN world stream, so neither
        # the loop above nor the other lanes nor the chosen primary moves them.
        # Drawn after the loop above and from different streams, so a project
        # with none of these shapes consumes exactly what it did before.
        for k in range(model.n_links):
            if model.link_lt_stochastic[k] and draws_uniforms(model.link_lt_dist[k]):
                rng = lane_leadtime_rng(streams.project_seed, streams.model_rep,
                                        model.sup_ids[model.link_sup[k]],
                                        model.mat_ids[model.link_mat[k]])
                self.lt_variates[k] = rng.random(T)

        # Persistent state.
        self.on_hand = np.zeros(model.n_mats)
        self.pipeline = np.zeros((model.n_links, model.ring_width))
        self.queue = np.zeros(model.n_links)
        self.backlog = np.zeros(model.n_prods)
        self.fg_on_hand = np.zeros(model.n_prods)
        self.fg_target = np.zeros(model.n_prods)        # S^FG_p (ADR 0001)
        self.cost = CostLedger(T)
        self.policy_state: dict[str, dict] = {}
        # Facet 11 decision traces — on for single-replication inspection runs
        # only (the `keep_matrices` rule), behaviour-neutral (core/decisions.py).
        self.decisions = DecisionLog(enabled=keep_matrices)
        self.policy_rng_created_week: dict[str, int] = {}
        # Forecast machinery (PH-10 mechanic state; no contract key needed for
        # the raw history — only the `forecast` transient is contractual).
        self.demand_history = np.zeros((model.n_prods, 26))  # ring, max window
        self.demand_history_n = 0
        self.forecast_smooth = model.mean_demand_p.copy()

        # World demand schedule (§II.4 / §III-D.6): the realized trajectory
        # plus a τ*-week forward tail, drawn up front. Weeks 0..H−1 are drawn
        # first, in the exact order the week loop consumed the stream before,
        # so realized demand stays bit-identical; the tail draws come after.
        # The schedule depends only on settings + network + world seed, never
        # on the policy portfolio (G-RNG invariance).
        lookahead = model.settings.visibility_horizon
        # Clip accounting for normal demand (decision 8) — per row when demand
        # is drawn per row, else per product; counted over the simulated weeks
        # only, never the look-ahead tail.
        n_draw = model.n_rows if model.has_row_demand else model.n_prods
        self.demand_clips = np.zeros(n_draw, dtype=int)
        self.demand_clip_add = np.zeros(n_draw)
        if model.has_row_demand:
            # Drawn per row (WP 14.1): product demand IS the row sum.
            self.demand_schedule_rows = np.zeros((model.n_rows, T + lookahead))
            for t in range(T + lookahead):
                counted = t < T
                draw_week_demand_rows(
                    model, streams.demand, t, self.demand_schedule_rows[:, t],
                    self.demand_clips if counted else None,
                    self.demand_clip_add if counted else None)
            self.demand_schedule = np.asarray(model.row_to_prod @ self.demand_schedule_rows)
        else:
            self.demand_schedule_rows = None
            self.demand_schedule = np.zeros((model.n_prods, T + lookahead))
            for t in range(T + lookahead):
                counted = t < T
                draw_week_demand(model, streams.demand, self.demand_schedule[:, t],
                                 self.demand_clips if counted else None,
                                 self.demand_clip_add if counted else None)

        # Weekly transients (rebound each week by the engine/mechanics).
        self.week: int = 0
        self.demand = np.zeros(model.n_prods)
        self.demand_rows = np.zeros(model.n_rows)   # PH-10 (WP 14.1): Σ by product = demand
        # Per-row fulfillment (WP 14.3). `backlog_rows` is the per-row backlog,
        # Σ by product = `backlog`: TRACKED when P-C.1 runs per row, otherwise
        # the product backlog split by row share (a view). The `*_rows`
        # fulfillment outputs are None unless P-C.1 runs per row.
        self.backlog_rows = np.zeros(model.n_rows)
        self.fulfilled_rows: Optional[np.ndarray] = None
        self.served_new_rows: Optional[np.ndarray] = None
        self.lost_rows: Optional[np.ndarray] = None
        # The project's ONE allocation rule and its per-row inputs, published by
        # P-C.2 at setup (the P-C.6 publish-at-setup pattern); None = no P-C.2.
        self.row_allocation: Optional[dict] = None
        # Every row's backorder settings (share that waits, horizon, penalty),
        # published by P-C.1 at setup (WP 14.4); None = no P-C.1 (lost sales).
        self.row_fulfillment: Optional[dict] = None
        # Safety-stock days of cover per material, published by P-P.3 at setup
        # (WP 14.5); None = no P-P.3, so MRP holds no buffer.
        self.material_ss_days: Optional[np.ndarray] = None
        self.forecast = model.mean_demand_p.copy()
        self.fg_served_backlog = np.zeros(model.n_prods)  # PH-30 (MTS)
        self.fg_served_new = np.zeros(model.n_prods)
        self.production_plan = np.zeros(model.n_prods)
        # PH-40 (WP 14.4): planned production over the horizon, [products × H];
        # column 0 is this week's `production_plan`. The requirement behind each
        # column and the projected demand it was planned against ride along.
        H = model.plan_horizon
        self.planned_production = np.zeros((model.n_prods, H))
        self.plan_requirement = np.zeros((model.n_prods, H))
        self.plan_projected_demand = np.zeros((model.n_prods, H))
        # PH-70 (WP 14.5): BOMᵀ × planned production, [materials × H].
        self.gross_requirements = np.zeros((model.n_mats, H))
        self.overtime_extra = np.zeros(model.n_prods)
        self.production_output = np.zeros(model.n_prods)
        # P-P.13 (PLAN.md §26 WP 16.4): what the line STARTED this week (it is
        # what consumed materials and capacity). `production_output` is what
        # COMPLETED — the supply fulfillment ships and FG stock receives. The two
        # are one array's value whenever no product has a production lead time.
        self.production_started = np.zeros(model.n_prods)
        self.prod_pipeline = (np.zeros((model.n_prods, model.prod_ring_width))
                              if model.has_prod_lt else None)
        self.prod_lt_clipped = np.zeros(model.n_prods, dtype=int)
        self.prod_lt_variates = np.zeros((model.n_prods, T)) if model.has_prod_lt else None
        if model.has_prod_lt:
            for j in range(model.n_prods):
                if not model.prod_lt_stochastic[j]:
                    continue
                rng = product_prodtime_rng(streams.project_seed, streams.model_rep,
                                           model.prod_ids[j])
                dist, cv = model.prod_lt_dist[j], float(model.prod_lt_cv[j])
                if dist == LeadTimeDist.LOGNORMAL:
                    self.prod_lt_variates[j] = rng.standard_normal(T)
                elif dist == LeadTimeDist.GAMMA:
                    self.prod_lt_variates[j] = rng.gamma(1.0 / (cv * cv), 1.0, T)
                else:
                    self.prod_lt_variates[j] = rng.random(T)
        self.fulfillment = np.zeros(model.n_prods)
        self.material_demand = np.zeros(model.n_mats)
        self.level_s = np.zeros(model.n_mats)
        self.level_S = np.zeros(model.n_mats)
        self.purchase_orders = np.zeros(model.n_links)
        self.po_lt_override = np.full(model.n_links, -1, dtype=int)  # -1 = link default
        self.arrivals = np.zeros(model.n_mats)
        self.lost_units_week = np.zeros(model.n_prods)
        self.served_new_week = np.zeros(model.n_prods)  # FR numerator (β-service vs D_p[t])
        self.lt_block_end = np.zeros(model.n_sups, dtype=int)   # 0 = no active LT event
        self.cap_factor = np.ones(model.n_sups)
        # node:material disruption state, per LINK (0 = no active event). Composed
        # weekly in the week_start mechanic with the per-supplier state by max
        # deferral end; all zeros on a scenario with no material event.
        self.link_lt_block_end = np.zeros(model.n_links, dtype=int)
        # node:plant disruption state (one plant → scalars). Composed weekly in
        # the week_start mechanic; read by production planning/execute.
        self.plant_lt_block_end = 0   # > week ⇒ plant produces nothing this week
        self.plant_cap_factor = 1.0   # φ throttle on the plant's production capacity
        self.lost_inbound_this_week = 0.0
        # Draws bounded to the in-transit ring, per link (audit F-36). A draw
        # longer than the ring used to wrap and land EARLY with no symptom.
        self.lt_truncated = np.zeros(model.n_links, dtype=int)
        # Normal lead-time draws below one week, raised to one (PLAN.md §26 WP
        # 15.1) — counted like the ring bound, so the shift is stated.
        self.lt_floor_raised = np.zeros(model.n_links, dtype=int)
        # P-S.4 early_warning_failover: monitored detection lag. None → the
        # scenario's settings.detection_lag_weeks applies unchanged.
        self.detection_lag_override: Optional[int] = None
        # P-C.6 forward_visibility: weeks of committed forward order book the
        # plant may read (τ*, §III-D.6). 0 = no customer visibility policy.
        self.visibility_horizon: int = 0
        self._forward_mat_cum: Optional[np.ndarray] = None

        self.trace = WeeklyTrace(T, model.n_prods, model.n_mats, keep_matrices,
                                 n_sups=model.n_sups)
        if model.has_prod_lt:
            # Per product on EVERY replication of a run that has a production lead
            # time (it is what `work_in_progress.by_product` averages); absent,
            # and free, on every run that has none.
            self.trace.WIP = np.zeros((model.n_prods, T))
        self._active_hook: Optional[BoundHook] = None
        self._params: dict[str, object] = {}

    # ------------------------------------------------------------- accessors

    def rng(self, policy_id: str) -> np.random.Generator:
        """Keyed policy stream (§9.4) — the only RNG a policy may consume."""
        if policy_id not in self.streams._policy_cache:
            self.policy_rng_created_week[policy_id] = self.week
        return self.streams.policy_rng(policy_id)

    def params(self, policy_id: str):
        return self._params[policy_id]

    def events_physical(self) -> list[ResolvedEvent]:
        t = self.week
        return [e for e in self.events if e.start <= t < e.end + e.ramp_weeks]

    def events_visible(self) -> list[ResolvedEvent]:
        """Post-detection view (PH-20): events the FIRM knows about (§3.7, P-S.4)."""
        t = self.week
        lag = (self.detection_lag_override
               if self.detection_lag_override is not None
               else self.model.settings.detection_lag_weeks)
        return [e for e in self.events if e.start + lag <= t and t < e.end + e.ramp_weeks]

    def visible_disrupted_suppliers(self) -> np.ndarray:
        mask = np.zeros(self.model.n_sups, dtype=bool)
        for e in self.events_visible():
            if e.is_plant or e.is_material:
                continue  # plant and material events do not disrupt a whole supplier
            if e.lt_active_at(self.week) or e.cap_factor_at(self.week) < 1.0:
                mask[e.supplier_idx] = True
        return mask

    def visible_disrupted_links(self) -> np.ndarray:
        """Per supply link: disrupted as the firm sees it (post-detection). A link
        is disrupted when its supplier is, or when a material event covers its
        material — the view a failover policy needs, since a material outage
        leaves the same supplier's other links healthy (PLAN.md §27 WP 17.1)."""
        m = self.model
        mask = self.visible_disrupted_suppliers()[m.link_sup]
        for e in self.events_visible():
            if e.is_material and e.lt_active_at(self.week):
                mask[m.link_mat == e.material_idx] = True
        return mask

    def write_gross_requirements(self, gr: np.ndarray) -> None:
        self._check_write(GROSS_REQUIREMENTS)
        self.gross_requirements = gr

    def pipeline_on_order(self) -> np.ndarray:
        """Per-material in-transit + supplier-queue quantities (position input)."""
        per_link = self.pipeline.sum(axis=1) + self.queue
        return np.asarray(self.model.link_to_mat @ per_link).ravel()

    def pipeline_arrivals_between(self, start_week: int, end_week: int) -> np.ndarray:
        """Per-material arrivals scheduled in [start_week, end_week) (planning view)."""
        W = self.model.ring_width
        if end_week - start_week >= W:
            per_link = self.pipeline.sum(axis=1)
        else:
            slots = np.arange(start_week, end_week) % W
            per_link = self.pipeline[:, slots].sum(axis=1)
        return np.asarray(self.model.link_to_mat @ per_link).ravel()

    def projected_demand_rows(self, start_week: int, weeks: int) -> np.ndarray:
        """The PLAN's view of demand per customer × product row, weeks
        ``start_week … start_week + weeks − 1`` → ``[rows × weeks]``.

        Each value is the row's forecast for that week, else its mean, else
        its product's mean × share — the centre the world draws around, never
        the draw itself. It reads the COMPILED model only, so no planner can
        learn a realized future demand through it (gate ``plan-from-demand``;
        ``tests/test_demand_rows.py`` perturbs the drawn schedule to prove it).
        """
        cols = np.clip(np.arange(start_week, start_week + weeks), 0,
                       self.model.row_centre.shape[1] - 1)
        return self.model.row_centre[:, cols]

    def projected_demand(self, start_week: int, weeks: int) -> np.ndarray:
        """``projected_demand_rows`` summed per product → ``[products × weeks]``."""
        return np.asarray(self.model.row_to_prod @ self.projected_demand_rows(start_week, weeks))

    def forward_material_demand(self, start_week: int, cover_weeks) -> np.ndarray:
        """Per-material forward-visible demand summed INCLUSIVELY over
        τ = start_week .. start_week + cover_weeks (§II.4): BoM-exploded
        D̂_m[τ] = Σ_p D̂_p[τ]·r_{p,m} over the coverage window.

        ``cover_weeks`` is an int or an (n_mats,) int array (per-material
        lead times). Windows are clamped to the schedule edge; feasibility
        (T_s + κ ≤ τ*) guarantees full windows for every simulated week.
        """
        if self._forward_mat_cum is None:
            mat_sched = np.asarray(self.model.bom.T @ self.demand_schedule)
            cum = np.zeros((self.model.n_mats, mat_sched.shape[1] + 1))
            np.cumsum(mat_sched, axis=1, out=cum[:, 1:])
            self._forward_mat_cum = cum
        cum = self._forward_mat_cum
        width = cum.shape[1] - 1
        lo = min(max(start_week, 0), width)
        hi = np.clip(start_week + np.asarray(cover_weeks, dtype=int) + 1, lo, width)
        rows = np.arange(self.model.n_mats)
        return cum[rows, hi] - cum[rows, lo]

    # ------------------------------------------------------- guarded writers

    def _check_write(self, key: str) -> None:
        if self.debug and self._active_hook is not None:
            if key not in self._active_hook.hook.writes:
                raise WriteGuardError(
                    f"{self._active_hook.owner}: write to {key!r} not declared in its "
                    f"{self._active_hook.hook.phase.value} hook"
                )

    def write_production_plan(self, plan: np.ndarray) -> None:
        self._check_write(PRODUCTION_PLAN)
        self.production_plan = np.maximum(plan, 0.0)

    def write_overtime_extra(self, extra: np.ndarray) -> None:
        self._check_write(OVERTIME_CAPACITY)
        self.overtime_extra = np.maximum(extra, 0.0)

    def write_levels(self, s: np.ndarray, S: np.ndarray) -> None:
        self._check_write(INVENTORY_LEVELS)
        self.level_s = s
        self.level_S = np.maximum(S, s)

    def write_purchase_orders(self, orders: np.ndarray) -> None:
        self._check_write(PURCHASE_ORDERS)
        self.purchase_orders = np.maximum(orders, 0.0)

    def write_po_lt_override(self, link_idx: int, lead_time_weeks: int) -> None:
        """Quote a non-default lead time for this week's order on one link
        (folded into the purchase_orders write-contract)."""
        self._check_write(PURCHASE_ORDERS)
        self.po_lt_override[link_idx] = lead_time_weeks

    def move_pipeline(self, link_idx: int, from_week: int, to_week: int, qty: float) -> None:
        """Reschedule in-transit quantity between arrival weeks (defer/expedite)."""
        self._check_write(ST_PIPELINE)
        W = self.model.ring_width
        src, dst = from_week % W, to_week % W
        take = min(qty, self.pipeline[link_idx, src])
        self.pipeline[link_idx, src] -= take
        self.pipeline[link_idx, dst] += take

    def set_backlog(self, backlog: np.ndarray, rows: Optional[np.ndarray] = None) -> None:
        """Product backlog; ``rows`` is the per-row backlog when P-C.1 tracks it
        (WP 14.3), else the rows are the product backlog split by share."""
        self._check_write(ST_BACKLOG)
        self.backlog = np.maximum(backlog, 0.0)
        m = self.model
        self.backlog_rows = (np.maximum(rows, 0.0) if rows is not None
                             else self.backlog[m.row_prod] * m.row_share)

    def write_fg_target(self, target: np.ndarray) -> None:
        """S^FG_p — MTS stock target, consumed by next week's PH-40 (ADR 0001)."""
        self._check_write(ST_FG_TARGET)
        self.fg_target = np.where(self.model.mts_mask, np.maximum(target, 0.0), 0.0)

    def write_fg_fulfillment(self, served_backlog: np.ndarray, served_new: np.ndarray) -> None:
        self._check_write(FG_FULFILLMENT)
        self.fg_served_backlog = np.maximum(served_backlog, 0.0)
        self.fg_served_new = np.maximum(served_new, 0.0)

    def write_fulfillment(
        self, fulfilled: np.ndarray, served_new: np.ndarray, lost_units: np.ndarray
    ) -> None:
        """``fulfilled`` = total units shipped (incl. backlog clearing);
        ``served_new`` = portion serving THIS week's demand (FR numerator)."""
        self._check_write(FULFILLMENT)
        self.fulfillment = fulfilled
        self.served_new_week = np.clip(served_new, 0.0, None)
        self.lost_units_week = np.maximum(lost_units, 0.0)

    def write_fulfillment_rows(
        self, fulfilled: np.ndarray, served_new: np.ndarray, lost_units: np.ndarray
    ) -> None:
        """Per customer × product row (WP 14.3): Σ by product equals what
        ``write_fulfillment`` wrote. Same contract key, same single writer."""
        self._check_write(FULFILLMENT)
        self.fulfilled_rows = np.maximum(fulfilled, 0.0)
        self.served_new_rows = np.clip(served_new, 0.0, None)
        self.lost_rows = np.maximum(lost_units, 0.0)

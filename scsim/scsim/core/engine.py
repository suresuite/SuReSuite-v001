# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""SCSIM weekly engine — compile, replicate, aggregate.

The week is the phase pipeline of Part IX §9.1; built-in mechanics and
policy hooks are dispatched per phase in priority order, all validated at
compile time. Parallelism is ACROSS replications only (§10.2.3); within a
replication everything is single-threaded and deterministic.

Public entry points:
    compile_scenario(scenario)          → CompiledScenario (validated)
    resolve_warmup(compiled)            → WarmupReport (MSER-5 + Conway)
    run_scenario(scenario, ...)         → ScenarioResult
    run_portfolio_study(scenario, ...)  → PortfolioStudy (CRN deltas vs S0)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import logging

import numpy as np

from scsim import ENGINE_VERSION
from scsim.core.context import (
    COST_COMPONENTS,
    PUBLISHED_SERIES_KEYS,
    CompiledModel,
    ResolvedEvent,
    SimContext,
)
from scsim.core.mechanics import greedy_feasible
from scsim.core.phases import (
    ARRIVALS,
    DEMAND,
    DEMAND_ROWS,
    DISRUPTION_STATE,
    FG_FULFILLMENT,
    FIRM_KNOWLEDGE,
    FORECAST,
    GROSS_REQUIREMENTS,
    KPI_ROWS,
    MATERIAL_DEMAND,
    OVERTIME_CAPACITY,
    PLANNED_PRODUCTION,
    PRODUCTION_OUTPUT,
    PRODUCTION_PLAN,
    PURCHASE_ORDERS,
    ST_BACKLOG,
    ST_COST_LEDGER,
    ST_FG_ON_HAND,
    ST_FG_TARGET,
    ST_ON_HAND,
    ST_PIPELINE,
    ST_QUEUE,
    BoundHook,
    Hook,
    PhaseId,
    validate_hooks,
)
from scsim.core.leadtime import from_variate as lt_from_variate
from scsim.core.planning import fg_gap, fg_target_for, plan_ahead, production_lead_time_offset
from scsim.disruption.injector import any_stochastic, resolve_events, validate_events
from scsim.entities.config import StatisticsReport, WarmupReport
from scsim.entities.enums import (
    EffectType,
    FulfillmentMode,
    SHAPED_LEAD_TIME_DISTS,
    LeadTimeDist,
    OverflowRule,
    RunMode,
    TraceVerbosity,
    WarmupMethod,
)
from scsim.entities.scenario import BUILT_IN_POLICY_IDS, Scenario
from scsim.kpi.compute import compute_replication_kpis
from scsim.policies.base import FeasibilityIssue, PolicyPlugin
from scsim.policies.registry import check_portfolio, instantiate
from scsim.stats.bootstrap import aggregate_mean_ci, t_halfwidth
from scsim.stats.seeds import replication_grid, world_streams
from scsim.stats.warmup import detect_warmup

_log = logging.getLogger(__name__)


class CompileError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Mechanics (engine-owned phase work). Each is registered with a BoundHook so
# hook validation covers mechanics + policies uniformly.
# ---------------------------------------------------------------------------

def _mech_week_start(model: CompiledModel, ctx: SimContext) -> None:
    t = ctx.week
    ctx.cost.set_week(t)
    # Reset weekly transients.
    ctx.demand[:] = 0.0
    ctx.fg_served_backlog[:] = 0.0
    ctx.fg_served_new[:] = 0.0
    ctx.production_plan[:] = 0.0
    ctx.overtime_extra[:] = 0.0
    ctx.production_output[:] = 0.0
    ctx.production_started[:] = 0.0
    ctx.fulfillment[:] = 0.0
    ctx.lost_units_week[:] = 0.0
    ctx.material_demand[:] = 0.0
    ctx.purchase_orders[:] = 0.0
    ctx.po_lt_override[:] = -1
    ctx.arrivals[:] = 0.0
    ctx.lost_inbound_this_week = 0.0
    # Physical disruption state (composition: max severity per target).
    ctx.lt_block_end[:] = 0
    ctx.cap_factor[:] = 1.0
    ctx.plant_lt_block_end = 0
    ctx.plant_cap_factor = 1.0
    if ctx.link_lt_block_end.any():
        ctx.link_lt_block_end[:] = 0
    for e in ctx.events:
        if e.is_material:
            # node:material → every supply link of that material, and only those
            # (lead_time_extension only — validated on the event).
            if e.lt_active_at(t):
                links = model.links_of_mat[e.material_idx]
                ctx.link_lt_block_end[links] = np.maximum(ctx.link_lt_block_end[links], e.end)
            continue
        if e.is_plant:
            # node:plant → throttle/halt the plant's own production.
            if e.lt_active_at(t):
                ctx.plant_lt_block_end = max(ctx.plant_lt_block_end, e.end)
            f = e.cap_factor_at(t)
            if f < 1.0:
                ctx.plant_cap_factor = min(ctx.plant_cap_factor, f)
            continue
        if e.lt_active_at(t):
            s = e.supplier_idx
            ctx.lt_block_end[s] = max(ctx.lt_block_end[s], e.end)
        f = e.cap_factor_at(t)
        if f < 1.0:
            ctx.cap_factor[e.supplier_idx] = min(ctx.cap_factor[e.supplier_idx], f)


def _mech_demand(model: CompiledModel, ctx: SimContext) -> None:
    # Forecast BEFORE reading the week (information timing, ADR 0001):
    # forecast_t = f(D_{t-window..t-1}); falls back to the model mean cold.
    _update_forecast(model, ctx)
    # Realized demand is this week's column of the pre-drawn world schedule
    # (§III-D.6: D_{p}[t] = D̃_{p}[t] — the committed order book realizes).
    ctx.demand = ctx.demand_schedule[:, ctx.week].copy()
    # Per customer × product row (WP 14.1). Drawn per row when a row carries a
    # spec; otherwise the product's demand split by share — a view, no draw.
    if model.has_row_demand:
        ctx.demand_rows = ctx.demand_schedule_rows[:, ctx.week].copy()
    else:
        ctx.demand_rows = ctx.demand[model.row_prod] * model.row_share
    # Append the realization to the history ring (consumed by next week's forecast).
    ctx.demand_history[:, ctx.demand_history_n % 26] = ctx.demand
    ctx.demand_history_n += 1


def _update_forecast(model: CompiledModel, ctx: SimContext) -> None:
    from scsim.entities.enums import ForecastModel

    n = ctx.demand_history_n
    fc = model.mean_demand_p.copy()
    if n > 0:
        last = ctx.demand_history[:, (n - 1) % 26]
        for j in range(model.n_prods):
            fm = model.forecast_model_of[j]
            if fm == ForecastModel.PERFECT:
                continue  # true model mean
            if fm == ForecastModel.NAIVE:
                fc[j] = last[j]
            elif fm == ForecastModel.MA:
                w = min(int(model.forecast_window[j]), n, 26)
                idx = [(n - 1 - k) % 26 for k in range(w)]
                fc[j] = float(ctx.demand_history[j, idx].mean())
            else:  # EXP_SMOOTHING: s_t = α·D_{t−1} + (1−α)·s_{t−1}
                alpha = 2.0 / (model.forecast_window[j] + 1.0)
                ctx.forecast_smooth[j] = alpha * last[j] + (1 - alpha) * ctx.forecast_smooth[j]
                fc[j] = float(ctx.forecast_smooth[j])
    ctx.forecast = np.maximum(fc * (1.0 + model.forecast_bias), 0.0)


def _mech_detection(model: CompiledModel, ctx: SimContext) -> None:
    # firm_knowledge is served on demand via ctx.events_visible() (detection
    # lag applied there); the phase slot is where P-S.4 / P-X.1 will live.
    return


def _mech_fulfill_from_stock(model: CompiledModel, ctx: SimContext) -> None:
    """§3.3 MTS step ①: F_p = min(D_p + B_p, I^FG_p), backlog served first.
    The shortfall flows to P-C.1 at PH-60. No-op for MTO products."""
    mts = model.mts_mask
    if not mts.any():
        return
    want = np.where(mts, ctx.demand + ctx.backlog, 0.0)
    served = np.minimum(want, ctx.fg_on_hand)
    served_backlog = np.minimum(served, ctx.backlog)
    served_new = served - served_backlog
    ctx.fg_on_hand = ctx.fg_on_hand - served
    ctx.fg_served_backlog = served_backlog
    ctx.fg_served_new = served_new


def _effective_prod_capacity(model: CompiledModel, ctx: SimContext) -> np.ndarray:
    """Plant production capacity for this week, after any node:plant disruption.

    Identical to ``model.capacity + overtime`` when no plant event is active
    (plant_cap_factor = 1.0, plant_lt_block_end = 0). A plant lead-time
    extension halts production outright (overtime cannot override a halt); a
    plant capacity_reduction throttles base capacity by φ.
    """
    if ctx.plant_lt_block_end > ctx.week:
        return np.zeros_like(model.capacity)
    return model.capacity * ctx.plant_cap_factor + ctx.overtime_extra


def _mech_default_plan(model: CompiledModel, ctx: SimContext) -> None:
    # MTO: produce to order (D + backlog). MTS step ②: replenish toward last
    # week's S^FG plus any backlog PH-30 could not serve from stock.
    want_mto = ctx.demand + ctx.backlog
    # P-P.13 (PLAN.md §26 WP 16.4): a start this week completes at t + L, so it is
    # planned against the requirement THEN, net of the work in progress that
    # completes before it — offset by the EXPECTED (planning) L only, never by a
    # drawn one (gate `plan-from-demand`). Every product with L = 0 keeps the
    # arithmetic below exactly.
    stock_now = ctx.fg_on_hand
    if model.has_prod_lt:
        want_mto, stock_now = production_lead_time_offset(model, ctx, want_mto)
    if model.mts_mask.any():
        backlog_unserved = ctx.backlog - ctx.fg_served_backlog
        # The FG policy's ask (WP 14.4): base-stock and days of cover fill to the
        # target, min-max only below s — `max(target − stock, 0)` for the first two,
        # exactly as before.
        gap = fg_gap(model, ctx.fg_target, stock_now) + backlog_unserved
        want = np.where(model.mts_mask, gap, want_mto)
    else:
        want = want_mto
    cap = _effective_prod_capacity(model, ctx)
    # CAPACITY BINDING IS MEASURED HERE AND NOWHERE ELSE (WP 9.3 / §4 D167).
    #
    # This is the only point in the week where the UNCLIPPED want still exists:
    # `ctx.production_plan` is the clipped figure, so `plan > cap` downstream is
    # false by construction and an "did capacity bind" test written there would
    # answer no on every week of every run. The flag is what lets a result say
    # WHICH products the capacity held back, rather than only that utilization
    # was high — those are different statements and only one of them is an
    # answer to "should I buy another line".
    ctx.trace.prod_cap_bound[:, ctx.week] = (want > cap + 1e-9) & (cap > 0.0)
    ctx.production_plan = np.minimum(want, cap)
    # Planned production over the horizon (WP 14.4): column 0 is the plan above.
    plan_ahead(model, ctx, want, ctx.production_plan)


def _mech_production_execute(model: CompiledModel, ctx: SimContext) -> None:
    # Eq. 8: greedy in fixed product order; P-P.9 pre-shapes the plan when active.
    cap = _effective_prod_capacity(model, ctx)
    plan = np.minimum(ctx.production_plan, cap)
    Q, remaining = greedy_feasible(model, plan, ctx.on_hand)
    # Materials are consumed at the START (P-P.13): `remaining` is the stock after
    # this week's starts, whatever their lead time.
    ctx.production_started = Q.copy()
    ctx.on_hand = remaining
    # The capacity the week offered, and the output that used it. Recorded from
    # the SAME `cap` the clip above used, so the two can never describe
    # different weeks — including under a plant disruption, where `cap` is the
    # throttled figure and a utilization against the nominal one would read as
    # a collapse in demand rather than a loss of capacity.
    ctx.trace.plant_capacity_units[ctx.week] = float(cap.sum())
    ctx.trace.plant_capacity_used_units[ctx.week] = float(Q.sum())
    if model.has_prod_lt:
        ctx.production_output = _production_completions(model, ctx, Q)
    else:
        ctx.production_output = Q
    if model.mts_mask.any():
        # Eq. 9: MTS completions replenish FG — this week's starts when the
        # product has no production lead time (W^FG = 0, the default), else what
        # started L weeks ago (P-P.13).
        ctx.fg_on_hand = ctx.fg_on_hand + np.where(model.mts_mask, ctx.production_output, 0.0)


def _production_completions(model: CompiledModel, ctx: SimContext, Q: np.ndarray) -> np.ndarray:
    """P-P.13 (PLAN.md §26 WP 16.4): put this week's starts in the production
    pipeline at t + L and take out what completes this week.

    L is the product's planning lead time, or — for a product with a shape — a
    draw from the variate pre-drawn for this (product, week) from the world
    production-time stream (the one inverse CDF, ``core/leadtime``). A draw below
    0 or beyond the ring is bounded and counted. A product with L = 0 completes
    in the week it starts, exactly as an engine without this feature."""
    t, W = ctx.week, model.prod_ring_width
    lt = model.prod_lt.astype(np.int64).copy()
    for j in np.flatnonzero(model.prod_lt_stochastic):
        lo, mo, hi = model.prod_lt_min[j], model.prod_lt_mode[j], model.prod_lt_max[j]
        x = lt_from_variate(model.prod_lt_dist[j], int(model.prod_lt[j]), float(model.prod_lt_cv[j]),
                            float(ctx.prod_lt_variates[j, t]),
                            lo=None if np.isnan(lo) else lo, mode=None if np.isnan(mo) else mo,
                            hi=None if np.isnan(hi) else hi, nominal=float(model.prod_lt[j]))
        if x < 0 or x > W - 2:
            ctx.prod_lt_clipped[j] += 1
            x = min(max(x, 0), W - 2)
        lt[j] = x
    np.add.at(ctx.prod_pipeline, (np.arange(model.n_prods), (t + lt) % W), Q)
    done = ctx.prod_pipeline[:, t % W].copy()
    ctx.prod_pipeline[:, t % W] = 0.0
    # Work in progress after this week's completions: traced in units and at
    # material value (COGS) — and charged NO holding cost (§26.2 rule 8: the page
    # shows no WIP rate, so the engine charges none).
    wip = ctx.prod_pipeline.sum(axis=1)
    ctx.trace.wip_units[t] = float(wip.sum())
    ctx.trace.wip_value[t] = float((wip * model.fg_unit_cogs).sum())
    if ctx.trace.WIP is not None:
        ctx.trace.WIP[:, t] = wip
    return done


def _mech_material_demand(model: CompiledModel, ctx: SimContext) -> None:
    # Eq. 1 — stationary expectation for MTO; forecast projection for MTS (§3.3).
    if model.mts_mask.any():
        exp_p = np.where(model.mts_mask, ctx.forecast, model.mean_demand_p)
        ctx.material_demand = np.asarray(model.bom.T @ exp_p).ravel()
    else:
        ctx.material_demand = model.exp_demand_m.copy()


def _mech_gross_requirements(model: CompiledModel, ctx: SimContext) -> None:
    """GR = BOMᵀ × planned production, [materials × H] (WP 14.5, design doc
    §3.4) — what MRP nets. It reads the PLAN only, so it inherits the plan's
    honesty: no realized future draw reaches it."""
    ctx.write_gross_requirements(np.asarray(model.bom.T @ ctx.planned_production))


def _mech_fg_target_base(model: CompiledModel, ctx: SimContext) -> None:
    """Base S^FG = forecast over the production cycle (1 week, v1) — the thin
    cycle stock. P-P.4 adds the real FG safety stock on top (priority 55)."""
    if not model.mts_mask.any():
        return
    # WP 14.4: a typed S, D/7 × next week's projected demand (days of cover), else
    # this week's forecast (today's derivation). Read at next week's PH-40.
    base = fg_target_for(model, ctx.forecast, ctx.projected_demand(ctx.week + 1, 1)[:, 0])
    ctx.fg_target = np.where(model.mts_mask, base, 0.0)


def _mech_orders_to_queue(model: CompiledModel, ctx: SimContext) -> None:
    np.add.at(ctx.queue, np.arange(model.n_links), ctx.purchase_orders)


def _mech_defer_arrivals(model: CompiledModel, ctx: SimContext) -> None:
    """Eqs. 11–12: arrivals usable inside an LT-extension window land at its end."""
    t = ctx.week
    W = model.ring_width
    blocked = np.flatnonzero(ctx.lt_block_end > t + 1)  # end > t+1 ⇒ t+1 in window
    for s in blocked:
        end = int(ctx.lt_block_end[s])
        links = np.flatnonzero(model.link_sup == s)
        src = (t + 1) % W
        qty = ctx.pipeline[links, src]
        moving = qty > 0
        if moving.any():
            dst = end % W
            ctx.pipeline[links[moving], dst] += qty[moving]
            ctx.pipeline[links[moving], src] = 0.0
    # node:material — the same deferral, per link. Runs after the supplier pass;
    # a unit the supplier pass moved to an earlier window end is deferred again
    # in the week it would land, so the two compose to the later end.
    for link in np.flatnonzero(ctx.link_lt_block_end > t + 1):
        src = (t + 1) % W
        qty = ctx.pipeline[link, src]
        if qty > 0:
            ctx.pipeline[link, int(ctx.link_lt_block_end[link]) % W] += qty
            ctx.pipeline[link, src] = 0.0


def _mech_ship_queue(model: CompiledModel, ctx: SimContext) -> None:
    """Move supplier-held orders into the in-transit pipeline under capacity gating."""
    t = ctx.week
    W = model.ring_width
    reject_sups = {
        e.supplier_idx
        for e in ctx.events
        if e.effect == EffectType.CAPACITY_REDUCTION
        and e.overflow_rule == OverflowRule.REJECT
        and e.cap_factor_at(t) < 1.0
    }
    ship_links: list[np.ndarray] = []
    ship_qty: list[np.ndarray] = []
    # An UNLIMITED supplier ships its whole queue: nothing to ration, nothing to
    # record (an infinite capacity is on neither side of the utilization ratio,
    # below). Done for all of them at once — the per-supplier loop is kept for
    # the finite ones, whose arithmetic it is (WP 14.5: MRP queues an order at
    # every supplier every week).
    cap_eff_all = model.sup_capacity * ctx.cap_factor
    inf_sup = np.isinf(cap_eff_all)
    if inf_sup.any():
        inf_links = np.flatnonzero(inf_sup[model.link_sup] & (ctx.queue > 0))
        if inf_links.size:
            ship_links.append(inf_links)
            ship_qty.append(ctx.queue[inf_links].copy())
            ctx.queue[inf_links] = 0.0
    for s in range(model.n_sups):
        if inf_sup[s]:
            continue
        links = model.links_of_sup[s]
        total_q = float(ctx.queue[links].sum())
        cap_eff = model.sup_capacity[s] * ctx.cap_factor[s]
        # A FINITE capacity is the only one that can be utilized, and an empty
        # `suppliers.capacity_per_week` is `np.inf` by construction
        # (`context.py`), which is the declared meaning of the blank rather
        # than a missing value. So an unlimited supplier contributes to NEITHER
        # side of the ratio: counting its shipments against an infinite
        # denominator would report 0% forever, and against its own shipments
        # would report 100% forever. Both are answers to a question nobody asked.
        finite = not np.isinf(cap_eff)
        if finite:
            ctx.trace.supplier_capacity_units[t] += float(cap_eff)
        if total_q <= 0:
            continue
        if finite:
            ctx.trace.sup_cap_bound[s, t] = float(total_q > cap_eff + 1e-9)
        if np.isinf(cap_eff):
            shipped = ctx.queue[links].copy()
            ctx.queue[links] = 0.0
        else:
            ship_total = min(total_q, float(cap_eff))
            ctx.trace.supplier_capacity_used_units[t] += ship_total
            factor = ship_total / total_q
            shipped = ctx.queue[links] * factor
            ctx.queue[links] -= shipped
            if s in reject_sups:
                rejected = float(ctx.queue[links].sum())
                if rejected > 0:
                    ctx.lost_inbound_this_week += rejected
                    ctx.queue[links] = 0.0
        ship_links.append(np.asarray(links))
        ship_qty.append(np.asarray(shipped, dtype=float))
    # Assign arrival weeks per link — vectorized (WP 14.5: MRP ships every
    # material every week, and a Python loop per shipped link was most of a
    # replication). Each link belongs to one supplier, so it is shipped at most
    # once per week and every (link, slot) cell below is written once: the
    # arithmetic is the per-link loop's, element by element.
    if not ship_links:
        return
    L = np.concatenate(ship_links)
    Q = np.concatenate(ship_qty)
    keep = Q > 0
    if not keep.any():
        return
    L, Q = L[keep], Q[keep]
    ovr = ctx.po_lt_override[L]
    lt = np.where(ovr > 0, ovr, model.link_lt[L]).astype(np.int64)
    stoch = np.flatnonzero(model.link_lt_stochastic[L])
    for i in stoch:
        link = int(L[i])
        dist = model.link_lt_dist[link]
        if dist in SHAPED_LEAD_TIME_DISTS:
            lo, mo, hi = (model.link_lt_min[link], model.link_lt_mode[link],
                          model.link_lt_max[link])
            raw = lt_from_variate(
                dist, int(lt[i]), float(model.link_lt_cv[link]), float(ctx.lt_variates[link, t]),
                lo=None if np.isnan(lo) else lo, mode=None if np.isnan(mo) else mo,
                hi=None if np.isnan(hi) else hi, nominal=float(model.link_lt[link]))
            # A normal draw below one week is raised to one (the arrival floor
            # below) — counted so the shift is stated (PLAN.md §26 WP 16.1).
            if raw < 1:
                ctx.lt_floor_raised[link] += 1
            lt[i] = raw
        else:
            lt[i] = _lt_from_variate(dist, int(lt[i]), float(model.link_lt_cv[link]),
                                     float(ctx.lt_variates[link, t]))
    arrival = t + np.maximum(1, lt)
    block = np.maximum(ctx.lt_block_end[model.link_sup[L]], ctx.link_lt_block_end[L])
    arrival = np.where(block > 0, np.maximum(arrival, block), arrival)
    # The ring holds W slots; a delay of W or more writes a slot that is read
    # EARLIER than the arrival week — the shipment lands early and nothing
    # downstream can tell (audit F-36). Bound it, and count it:
    # `lead_time_truncations` on the result, a warning on the run.
    trunc = arrival - t > W - 2
    if trunc.any():
        arrival = np.where(trunc, t + W - 2, arrival)
        np.add.at(ctx.lt_truncated, L[trunc], 1)
    np.add.at(ctx.pipeline, (L, arrival % W), Q)


def _lt_from_variate(dist: LeadTimeDist, mean: float, cv: float, v: float,
                     rounded: bool = True) -> float:
    """A lead time with the link's distribution and the shipment's mean, from a
    variate pre-drawn for this (link, week) (audit F-24). The one implementation
    is ``core/leadtime.from_variate`` (PLAN.md §26 WP 16.1); this is its CV-shape
    entry, kept for the callers that have always used it."""
    return lt_from_variate(dist, mean, cv, v, rounded=rounded)


def _mech_land_arrivals(model: CompiledModel, ctx: SimContext) -> None:
    slot = (ctx.week + 1) % model.ring_width
    per_link = ctx.pipeline[:, slot].copy()
    if per_link.any():
        ctx.pipeline[:, slot] = 0.0
        ctx.arrivals = np.asarray(model.link_to_mat @ per_link).ravel()
        ctx.on_hand = ctx.on_hand + ctx.arrivals
    else:
        ctx.arrivals = np.zeros(model.n_mats)


def _mech_accounting(model: CompiledModel, ctx: SimContext, policies: list[PolicyPlugin]) -> None:
    t = ctx.week
    tr = ctx.trace
    u = model.unit_price
    D, F, L = ctx.demand, ctx.fulfillment, ctx.lost_units_week
    served_new = ctx.served_new_week
    dv = float((u * D).sum())
    tr.demand_value[t] = dv
    tr.fulfilled_value[t] = float((u * served_new).sum())
    tr.revenue_value[t] = float((u * F).sum())
    lost_v = float((u * L).sum())
    tr.lost_value[t] = lost_v
    tr.lost_units[t] = float(L.sum())
    tr.backlog_units[t] = float(ctx.backlog.sum())
    tr.fill_rate[t] = tr.fulfilled_value[t] / dv if dv > 0 else 1.0
    tr.inbound_rejected[t] = ctx.lost_inbound_this_week
    tr.on_hand_value[t] = float((ctx.on_hand * model.mat_cost).sum())
    tr.fg_value[t] = float((ctx.fg_on_hand * model.fg_unit_cogs).sum())
    # The same two stocks in units. Plain scalars, so — unlike the per-item
    # matrices below — they cost nothing, need no `keep_matrices`, and exist on
    # every replication of every run rather than on inspection runs only.
    tr.on_hand_units[t] = float(ctx.on_hand.sum())
    tr.fg_units[t] = float(ctx.fg_on_hand.sum())
    if lost_v > 0:
        ctx.cost.add("lost_sales", lost_v)
    for pol in policies:
        cb = pol.cost_contribution(ctx)
        for component, amount in cb.components.items():
            if amount:
                ctx.cost.add(component, amount)
    if tr.keep_matrices:
        tr.D[:, t] = D
        tr.PD[:, t] = ctx.plan_projected_demand[:, 0]
        tr.REQ[:, t] = ctx.plan_requirement[:, 0]
        tr.PLAN[:, t] = ctx.planned_production[:, 0]
        # Built = STARTED (what the plan asked the line for). Identical to the
        # completions whenever no product has a production lead time (P-P.13).
        tr.Q[:, t] = ctx.production_started
        tr.F[:, t] = F
        tr.B[:, t] = ctx.backlog
        tr.L[:, t] = L
        tr.I_mat[:, t] = ctx.on_hand
        # Inspection-mode per-material flows: pipeline content (in transit,
        # all future arrival slots) and this week's purchase orders, both
        # aggregated over supplier links onto materials.
        tr.I_transit[:, t] = np.asarray(
            model.link_to_mat @ ctx.pipeline.sum(axis=1)
        ).ravel()
        tr.O_mat[:, t] = np.asarray(model.link_to_mat @ ctx.purchase_orders).ravel()
        # Per-product FG stock at the same point as `tr.fg_units` (end of week,
        # after PH-50's completions), and the target PH-70 set this week for
        # next week's PH-40. Σ over products of FG is `fg_units`.
        tr.FG[:, t] = ctx.fg_on_hand
        tr.FG_TARGET[:, t] = ctx.fg_target


_MECHANIC_HOOKS: list[tuple[str, Hook, Callable]] = [
    ("mech.week_start", Hook(phase=PhaseId.PH00, priority=50, writes={DISRUPTION_STATE}),
     _mech_week_start),
    ("mech.demand_realization", Hook(phase=PhaseId.PH10, priority=50,
                                     writes={DEMAND, FORECAST, DEMAND_ROWS}),
     _mech_demand),
    ("mech.detection", Hook(phase=PhaseId.PH20, priority=50,
                            reads={DISRUPTION_STATE}, writes={FIRM_KNOWLEDGE}),
     _mech_detection),
    ("mech.fulfill_from_stock", Hook(phase=PhaseId.PH30, priority=50,
                                     reads={DEMAND, ST_BACKLOG, ST_FG_TARGET},
                                     writes={FG_FULFILLMENT, ST_FG_ON_HAND}),
     _mech_fulfill_from_stock),
    ("mech.default_plan", Hook(phase=PhaseId.PH40, priority=50,
                               reads={DEMAND, DEMAND_ROWS, FG_FULFILLMENT, OVERTIME_CAPACITY,
                                      ST_BACKLOG, ST_FG_TARGET},
                               writes={PRODUCTION_PLAN, PLANNED_PRODUCTION}),
     _mech_default_plan),
    ("mech.production_execute", Hook(phase=PhaseId.PH50, priority=50,
                                     reads={PRODUCTION_PLAN, OVERTIME_CAPACITY},
                                     writes={PRODUCTION_OUTPUT, ST_ON_HAND, ST_FG_ON_HAND}),
     _mech_production_execute),
    ("mech.gross_requirements", Hook(phase=PhaseId.PH70, priority=30,
                                     reads={PLANNED_PRODUCTION}, writes={GROSS_REQUIREMENTS}),
     _mech_gross_requirements),
    ("mech.material_demand", Hook(phase=PhaseId.PH70, priority=40,
                                  reads={FORECAST}, writes={MATERIAL_DEMAND}),
     _mech_material_demand),
    ("mech.fg_target_base", Hook(phase=PhaseId.PH70, priority=45,
                                 reads={FORECAST}, writes={ST_FG_TARGET}),
     _mech_fg_target_base),
    ("mech.orders_to_queue", Hook(phase=PhaseId.PH80, priority=90,
                                  reads={PURCHASE_ORDERS}, writes={ST_QUEUE}),
     _mech_orders_to_queue),
    ("mech.defer_arrivals", Hook(phase=PhaseId.PH90, priority=10,
                                 reads={DISRUPTION_STATE}, writes={ST_PIPELINE}),
     _mech_defer_arrivals),
    ("mech.ship_queue", Hook(phase=PhaseId.PH90, priority=20,
                             reads={DISRUPTION_STATE, PURCHASE_ORDERS},
                             writes={ST_PIPELINE, ST_QUEUE}),
     _mech_ship_queue),
    ("mech.land_arrivals", Hook(phase=PhaseId.PH90, priority=90,
                                writes={ARRIVALS, ST_ON_HAND, ST_PIPELINE}),
     _mech_land_arrivals),
]


# ---------------------------------------------------------------------------
# Compilation
# ---------------------------------------------------------------------------

@dataclass
class CompiledScenario:
    scenario: Scenario
    model: CompiledModel
    policies: list[PolicyPlugin]
    params_by_id: dict[str, Any]
    dispatch: dict[PhaseId, list[tuple[int, BoundHook, Callable]]]
    feasibility_warnings: list[FeasibilityIssue]
    warmup: Optional[WarmupReport] = None


def compile_scenario(scenario: Scenario, debug: bool = True) -> CompiledScenario:
    for p in scenario.network.products:
        if p.fulfillment_mode == FulfillmentMode.ATO:
            raise CompileError(
                f"product {p.id!r}: fulfillment_mode=ato is a reserved enum value "
                f"(not scheduled); use mto or mts"
            )

    model = CompiledModel(scenario)
    validate_events(model)
    for links in model.links_of_sup:
        for link in links:
            if model.link_lt_dist[link] == LeadTimeDist.EMPIRICAL:
                raise CompileError("lead_time_dist=empirical lands with the data-import path (M7)")

    # Policies: portfolio + always-on built-ins (manuscript baseline defaults).
    policy_specs = dict(scenario.policies)
    for builtin in BUILT_IN_POLICY_IDS:
        policy_specs.setdefault(builtin, {})
    issues = check_portfolio(scenario)
    errors = [i for i in issues if i.severity == "error"]
    if errors:
        msgs = "; ".join(f"[{e.code}] {e.message}" for e in errors)
        raise CompileError(f"portfolio infeasible: {msgs}")

    policies = [instantiate(pid, raw) for pid, raw in sorted(policy_specs.items())]
    params_by_id = {pol.id: pol.params for pol in policies}
    # A policy may shape the compiled model before any context is built (WP
    # 14.5: P-P.1 marks its MRP materials and sets the planning horizon H).
    for pol in policies:
        configure = getattr(pol, "configure_model", None)
        if configure is not None:
            configure(model)

    bound: list[BoundHook] = [
        BoundHook(owner=name, hook=hook, is_mechanic=True) for name, hook, _ in _MECHANIC_HOOKS
    ]
    for pol in policies:
        for hook in pol.hooks:
            bound.append(BoundHook(owner=pol.id, hook=hook))
    # PH-99 accounting reads freely (read-only by contract) — registered last.
    accounting_hook = Hook(phase=PhaseId.PH99, priority=50,
                           writes={KPI_ROWS, ST_COST_LEDGER})
    bound.append(BoundHook(owner="mech.accounting", hook=accounting_hook, is_mechanic=True))
    validate_hooks(bound)

    dispatch: dict[PhaseId, list[tuple[int, BoundHook, Callable]]] = {ph: [] for ph in PhaseId}
    for (name, hook, fn) in _MECHANIC_HOOKS:
        bh = BoundHook(owner=name, hook=hook, is_mechanic=True)
        dispatch[hook.phase].append((hook.priority, bh, _bind_mechanic(fn, model)))
    acc_bh = BoundHook(owner="mech.accounting", hook=accounting_hook, is_mechanic=True)
    dispatch[PhaseId.PH99].append(
        (50, acc_bh, lambda ctx, _m=model, _p=policies: _mech_accounting(_m, ctx, _p))
    )
    for pol in policies:
        for hook in pol.hooks:
            bh = BoundHook(owner=pol.id, hook=hook)
            dispatch[hook.phase].append((hook.priority, bh, _bind_policy(pol, hook.phase)))
    for ph in PhaseId:
        dispatch[ph].sort(key=lambda item: item[0])

    return CompiledScenario(
        scenario=scenario,
        model=model,
        policies=policies,
        params_by_id=params_by_id,
        dispatch=dispatch,
        feasibility_warnings=[i for i in issues if i.severity == "warning"],
    )


def _bind_mechanic(fn: Callable, model: CompiledModel) -> Callable:
    return lambda ctx: fn(model, ctx)


def _bind_policy(pol: PolicyPlugin, phase: PhaseId) -> Callable:
    return lambda ctx: pol.on_phase(phase, ctx)


# ---------------------------------------------------------------------------
# Replication loop
# ---------------------------------------------------------------------------

def run_replication(
    compiled: CompiledScenario,
    model_rep: int,
    event_rep: int,
    events: list[ResolvedEvent],
    debug: bool = False,
    snapshot_store=None,
    snapshot_digest: Optional[str] = None,
    warmup_week: Optional[int] = None,
) -> SimContext:
    model = compiled.model
    settings = model.settings
    keep_matrices = settings.trace_verbosity == TraceVerbosity.FULL_DEBUG
    streams = world_streams(settings.project_seed, model_rep, event_rep)
    ctx = SimContext(model, streams, events, keep_matrices=keep_matrices, debug=debug)
    ctx._params = compiled.params_by_id

    for pol in compiled.policies:
        pol.setup(ctx)
    _initialize_state(compiled, ctx)

    # Warm-state snapshots (§10.2.4): resume at t_w when the family is cached.
    start_week = 0
    capture_at: Optional[int] = None
    use_snapshots = (
        snapshot_store is not None
        and snapshot_digest is not None
        and warmup_week is not None
        and all(e.start >= warmup_week for e in events)
    )
    if use_snapshots:
        resumed = snapshot_store.restore(snapshot_digest, model_rep, ctx)
        if resumed is not None:
            start_week = resumed
        else:
            capture_at = warmup_week

    dispatch = compiled.dispatch
    phases = list(PhaseId)
    for t in range(start_week, settings.horizon):
        if capture_at is not None and t == capture_at:
            from scsim.io.snapshots import SnapshotInvalid
            try:
                snapshot_store.capture(snapshot_digest, model_rep, ctx, t)
            except SnapshotInvalid:
                pass
            capture_at = None
        ctx.week = t
        for ph in phases:
            for _prio, bh, fn in dispatch[ph]:
                if debug and not bh.is_mechanic:
                    ctx._active_hook = bh
                    try:
                        fn(ctx)
                    finally:
                        ctx._active_hook = None
                else:
                    fn(ctx)
    return ctx


def _initialize_state(compiled: CompiledScenario, ctx: SimContext) -> None:
    """Warm start: run the PH-70 chain once to get levels and FG targets, set
    I_m(0), prime the in-transit pipeline with one expected week per slot."""
    model = compiled.model
    ctx.week = 0
    for _prio, bh, fn in compiled.dispatch[PhaseId.PH70]:
        fn(ctx)
    init = np.where(model.mat_initial >= 0, model.mat_initial,
                    np.maximum(ctx.level_S - model.exp_demand_m * model.link_lt[model.primary_link], 0.0))

    # Initial-inventory diagnostics (9bf05df). DEBUG-level, not print(): this runs
    # once per replication in the worker AND in the browser engine, and stdout
    # there is a user's console. `scsim/debug_init.py` turns it on.
    if _log.isEnabledFor(logging.DEBUG):
        _log.debug("mat_ids: %s", model.mat_ids)
        _log.debug("material_demand: %s", ctx.material_demand)
        _log.debug("level_S: %s", ctx.level_S)
        _log.debug("exp_demand_m: %s", model.exp_demand_m)
        _log.debug("link_lt[primary]: %s", model.link_lt[model.primary_link])
        _log.debug("mat_initial: %s", model.mat_initial)
        _log.debug("computed init: %s", init)
    ctx.on_hand = init.astype(float)
    if model.mts_mask.any():
        # MTS starts at its FG opening stock (engine RFC 4, WP 14.4), else at its
        # stock target — today's behaviour.
        ctx.fg_on_hand = np.where(model.mts_mask & (model.fg_initial >= 0),
                                  model.fg_initial, ctx.fg_target)
    W = model.ring_width
    for m in range(model.n_mats):
        link = model.primary_link[m]
        exp_d = model.exp_demand_m[m]
        if exp_d <= 0:
            continue
        for w in range(1, int(model.link_lt[link]) + 1):
            ctx.pipeline[link, w % W] += exp_d


# ---------------------------------------------------------------------------
# Warm-up resolution (Part VIII §1)
# ---------------------------------------------------------------------------

def resolve_warmup(compiled: CompiledScenario, detection_reps: int = 10) -> WarmupReport:
    settings = compiled.model.settings
    if settings.warmup_method == WarmupMethod.MANUAL:
        report = WarmupReport(
            conway_week=-1, mser5_week=-1,
            adopted_week=int(settings.warmup_end), method=WarmupMethod.MANUAL,
        )
        compiled.warmup = report
        return report

    n = min(detection_reps, settings.model_seeds)
    series = np.zeros((n, settings.horizon))
    for i in range(n):
        ctx = run_replication(compiled, model_rep=i, event_rep=0, events=[])
        series[i] = ctx.trace.fill_rate
    mean_series = series.mean(axis=0)
    report = detect_warmup(mean_series, settings.warmup_method, settings.warmup_end)
    adopted = min(report.adopted_week, settings.horizon // 2)
    report = WarmupReport(
        conway_week=report.conway_week, mser5_week=report.mser5_week,
        mser5_legacy_week=report.mser5_legacy_week,
        adopted_week=adopted, method=report.method, series_used="fill_rate",
    )
    compiled.warmup = report
    return report


# ---------------------------------------------------------------------------
# Scenario run + aggregation
# ---------------------------------------------------------------------------

@dataclass
class ScenarioResult:
    name: str
    kpis: list[dict[str, float]]                  # one row per replication
    fr_series: np.ndarray                          # [n_reps, horizon]
    aggregates: dict[str, dict[str, float]]
    stats: StatisticsReport
    feasibility_warnings: list[FeasibilityIssue] = field(default_factory=list)
    rep_cells: list[tuple[int, int]] = field(default_factory=list)
    warmup: Optional[WarmupReport] = None
    lp_fallbacks: int = 0
    # Additional weekly per-replication series lifted from the trace (same
    # shape as fr_series): every `PUBLISHED_SERIES_KEYS` entry except
    # `fill_rate`, which is `fr_series` above. Keyed by the declared name, so
    # the set follows `WEEKLY_SERIES` rather than a list kept here by hand.
    extra_series: dict[str, np.ndarray] = field(default_factory=dict)
    # Single-run inspection surface (blueprint G17/§9.5.1): per-item weekly
    # matrices lifted from the full-debug trace — populated ONLY when
    # trace_verbosity=full_debug and the run has exactly one replication
    # (per-item evidence at multi-rep scale is deliberately not exposed).
    # Keys: "material.on_hand" / "material.in_transit" / "material.orders"
    # (+ "material.mrp_need" / "mrp_on_hand" / "mrp_on_the_way" / "mrp_net"
    # when the run has MRP materials) ([n_mats, horizon]) and
    # "product.demand" / "product.projected_demand" / "product.requirement" /
    # "product.planned" / "product.production" / "product.fulfillment" /
    # "product.backlog" / "product.lost_units" / "product.fg_on_hand" /
    # "product.fg_target" / "product.make_to_stock" (1 = MTS, 0 = MTO, the
    # same every week) (+ "product.wip" with a production lead time)
    # ([n_prods, horizon]).
    item_series: Optional[dict[str, np.ndarray]] = None
    # Row labels for item_series: {"material": [...ids], "product": [...ids]}.
    item_ids: Optional[dict[str, list[str]]] = None
    # Facet 11 decision-trace records (scsim/core/decisions.py), on the SAME
    # rule as `item_series`: a single-replication full-debug inspection run,
    # else None. Shape: {"records": [{week, policy, catalog_ref, node_kind,
    # node, rationale, inputs, decision}], "dropped": int, "max_records": int}.
    # Behaviour-neutral: no KPI, series or golden digest depends on it.
    decision_trace: Optional[dict] = None
    # WHICH products and suppliers the capacity held back, over the analysis
    # window, averaged across replications (WP 9.3 / §4 D167). Present on EVERY
    # run — unlike `item_series`, which needs a single-replication full-debug
    # inspection run, and which is why "for which products did capacity bind"
    # had no answer a user could reach. Shape:
    #   {"window_weeks": int, "replications": int,
    #    "products":  [{"id", "bound_weeks", "capacity", "produced", "utilization"}],
    #    "suppliers": [{"id", "bound_weeks", "capacity", "shipped", "utilization"}],
    #    "unlimited_suppliers": int}
    # Only entities the capacity bound for at least one week are listed: a list
    # of every product on every run is a table nobody reads, and the absence of
    # a row is the same statement as a zero.
    capacity_binding: Optional[dict] = None
    # Stochastic lead-time draws bounded to the in-transit ring (audit F-36):
    # [{"supplier_id", "material_id", "draws", "replications", "bounded_to_weeks"}].
    # Empty when no draw was bounded — the common case.
    lead_time_truncations: list = field(default_factory=list)
    # Normal (or zero-floored bounded) lead-time draws below one week, raised to
    # one (PLAN.md §26 WP 16.1): [{"supplier_id", "material_id", "draws",
    # "replications"}]. Empty when nothing was raised — always, for a project
    # with no shaped lead time.
    lead_time_floor_raises: list = field(default_factory=list)
    # P-P.13 production lead time (PLAN.md §26 WP 16.4). `work_in_progress`:
    # None when no product has one; else {"mean_units", "mean_value",
    # "by_product": [{"product_id", "mean_units"}], "replications"} over the
    # analysis window — units started and not yet completed, at material value,
    # carrying NO holding cost. `production_lead_time_clips`: drawn production
    # lead times bounded to [0, ring] — [{"product_id", "draws", "replications"}].
    work_in_progress: Optional[dict] = None
    production_lead_time_clips: list = field(default_factory=list)
    # Fixed-start events moved from inside warm-up to t_w (audit F-03):
    # [{"event_index", "target_id", "authored_week", "used_week", "replications"}].
    event_shifts: list = field(default_factory=list)
    # Demand per customer × product row (WP 14.1). `demand_clips`: normal draws
    # set to 0 (decision 8) — [{"row"|"product", "clipped_draws", "draws",
    # "mean_shift", "replications"}], empty when nothing was clipped.
    # `demand_warnings`: the run's demand notes in the mapping-warning shape
    # ({level, entity, field, reason}) — clips and forecasts shorter than the
    # horizon — so the bridge can put them where the run panel reads.
    demand_clips: list = field(default_factory=list)
    demand_warnings: list = field(default_factory=list)

    def kpi_array(self, key: str) -> np.ndarray:
        return np.array([row.get(key, np.nan) for row in self.kpis])


# Per-replication progress observer: called as (done, total, kpi_row,
# weekly_series) after each replication completes; ``weekly_series`` carries
# exactly the published traces ScenarioResult exposes — `PUBLISHED_SERIES_KEYS`
# — for that single replication. ``total`` is the planned grid size and may
# grow under sequential-CI stopping.
ProgressFn = Callable[[int, int, dict[str, float], dict[str, np.ndarray]], None]


class RunCancelled(Exception):
    """Raised by a progress observer to STOP the run (audit F-06).

    The one exception `_notify_progress` does not swallow. Every other observer
    error is still ignored — a broken observer must never kill a run — which is
    exactly why a cancel could not be expressed before this: the only hook the
    engine calls between replications had no way to say "stop".
    """


def _notify_progress(
    progress: Optional[ProgressFn], done: int, total: int,
    row: dict[str, float], ctx: SimContext,
) -> None:
    """Observer errors must never kill a run — swallow and continue; a
    deliberate `RunCancelled` is the exception."""
    if progress is None:
        return
    try:
        progress(done, total, row, {
            k: getattr(ctx.trace, k) for k in PUBLISHED_SERIES_KEYS
        })
    except RunCancelled:
        raise
    except Exception:  # noqa: BLE001 — observer only, run integrity first
        pass



class _CapacityBindingAccumulator:
    """Per-entity capacity evidence, summed across replications as they run.

    Kept OUTSIDE the trace because a trace belongs to one replication and this
    question is asked of the run: "which products did capacity hold back", not
    "which products did capacity hold back in replication 7". Accumulating here
    also means the matrices are never retained — each replication's context is
    discarded as before, and what survives is two float vectors per entity kind.
    """

    def __init__(self, model) -> None:
        self.prod_ids = list(model.prod_ids)
        self.sup_ids = list(model.sup_ids)
        self.prod_bound = np.zeros(model.n_prods)
        self.sup_bound = np.zeros(model.n_sups)
        self.reps = 0
        # `np.inf` is the declared meaning of an empty `capacity_per_week`, so
        # this counts the suppliers that opted OUT of being a constraint.
        self.unlimited_suppliers = int(np.isinf(model.sup_capacity).sum())
        self.finite_capacity = float(
            model.sup_capacity[np.isfinite(model.sup_capacity)].sum()
        )
        self.plant_capacity = float(model.capacity.sum())
        # Not capacity evidence, but the same shape of question — a run-level
        # count summed over replications — so it rides the same observer rather
        # than a second parameter through `_extend_until_ci` (audit F-36).
        self.lt_truncated = np.zeros(model.n_links, dtype=int)
        self.lt_floor_raised = np.zeros(model.n_links, dtype=int)
        self.has_prod_lt = bool(getattr(model, "has_prod_lt", False))
        self.prod_ids = list(model.prod_ids)
        self.wip_units_sum = 0.0
        self.wip_value_sum = 0.0
        self.wip_by_prod = np.zeros(model.n_prods)
        self.wip_weeks = 0
        self.prod_lt_clipped = np.zeros(model.n_prods, dtype=int)
        self.ring_width = int(model.ring_width)
        self.link_ids = [(model.sup_ids[model.link_sup[k]], model.mat_ids[model.link_mat[k]])
                         for k in range(model.n_links)]
        # Normal-demand clips (WP 14.1, decision 8): per row when demand is drawn
        # per row, else per product — summed over replications like the above.
        self.clip_labels = (list(model.row_ids) if model.has_row_demand
                            else list(model.prod_ids))
        self.clip_kind = "row" if model.has_row_demand else "product"
        self.demand_clips = np.zeros(len(self.clip_labels))
        self.demand_clip_add = np.zeros(len(self.clip_labels))
        self.horizon = int(model.settings.horizon)

    def demand_clip_report(self) -> list[dict]:
        """Rows (or products) whose normal draws were clipped at 0, with the
        mean count per replication and how far clipping raised the realized
        weekly mean (Σ clipped-away negatives / draws)."""
        if self.reps == 0:
            return []
        n = float(self.reps)
        return [
            {self.clip_kind: label,
             "clipped_draws": round(float(self.demand_clips[i]) / n, 3),
             "draws": self.horizon,
             "mean_shift": round(float(self.demand_clip_add[i]) / (n * self.horizon), 6),
             "replications": self.reps}
            for i, label in enumerate(self.clip_labels) if self.demand_clips[i] > 0
        ]

    def lead_time_truncations(self) -> list[dict]:
        return [
            {"supplier_id": sid, "material_id": mid, "draws": int(self.lt_truncated[k]),
             "replications": self.reps, "bounded_to_weeks": self.ring_width - 2}
            for k, (sid, mid) in enumerate(self.link_ids) if self.lt_truncated[k] > 0
        ]

    def lead_time_floor_raises(self) -> list[dict]:
        return [
            {"supplier_id": sid, "material_id": mid, "draws": int(self.lt_floor_raised[k]),
             "replications": self.reps}
            for k, (sid, mid) in enumerate(self.link_ids) if self.lt_floor_raised[k] > 0
        ]

    def work_in_progress(self) -> Optional[dict]:
        if not self.has_prod_lt or self.wip_weeks == 0:
            return None
        n = float(self.wip_weeks)
        return {
            "mean_units": round(self.wip_units_sum / n, 6),
            "mean_value": round(self.wip_value_sum / n, 6),
            "by_product": [{"product_id": pid, "mean_units": round(float(self.wip_by_prod[j]) / n, 6)}
                           for j, pid in enumerate(self.prod_ids) if self.wip_by_prod[j] > 0],
            "replications": self.reps,
        }

    def production_lead_time_clips(self) -> list[dict]:
        return [
            {"product_id": pid, "draws": int(self.prod_lt_clipped[j]), "replications": self.reps}
            for j, pid in enumerate(self.prod_ids) if self.prod_lt_clipped[j] > 0
        ]

    def observe(self, ctx: SimContext, t_w: int, window_end: int) -> None:
        w = slice(t_w, window_end)
        self.lt_truncated += ctx.lt_truncated
        self.lt_floor_raised += ctx.lt_floor_raised
        if self.has_prod_lt:
            self.prod_lt_clipped += ctx.prod_lt_clipped
            self.wip_units_sum += float(ctx.trace.wip_units[w].sum())
            self.wip_value_sum += float(ctx.trace.wip_value[w].sum())
            if ctx.trace.WIP is not None:
                self.wip_by_prod += ctx.trace.WIP[:, w].sum(axis=1)
            self.wip_weeks += max(window_end - t_w, 0)
        self.demand_clips += ctx.demand_clips
        self.demand_clip_add += ctx.demand_clip_add
        self.prod_bound += ctx.trace.prod_cap_bound[:, w].sum(axis=1)
        self.sup_bound += ctx.trace.sup_cap_bound[:, w].sum(axis=1)
        self.reps += 1

    def summary(self, model, t_w: int, window_end: int) -> dict:
        if self.reps == 0:
            return {}
        n = float(self.reps)
        products = [
            {
                "id": self.prod_ids[i],
                "bound_weeks": round(float(self.prod_bound[i]) / n, 3),
                "capacity": round(float(model.capacity[i]), 4),
            }
            for i in range(len(self.prod_ids))
            if self.prod_bound[i] > 0
        ]
        suppliers = [
            {
                "id": self.sup_ids[i],
                "bound_weeks": round(float(self.sup_bound[i]) / n, 3),
                "capacity": (
                    None if np.isinf(model.sup_capacity[i])
                    else round(float(model.sup_capacity[i]), 4)
                ),
            }
            for i in range(len(self.sup_ids))
            if self.sup_bound[i] > 0
        ]
        products.sort(key=lambda r: (-r["bound_weeks"], r["id"]))
        suppliers.sort(key=lambda r: (-r["bound_weeks"], r["id"]))
        return {
            "window_weeks": int(window_end - t_w),
            "replications": self.reps,
            "products": products,
            "suppliers": suppliers,
            "unlimited_suppliers": self.unlimited_suppliers,
            "finite_supplier_capacity": self.finite_capacity,
            "plant_capacity": self.plant_capacity,
        }


def run_scenario(
    scenario: Scenario,
    debug: bool = False,
    compiled: Optional[CompiledScenario] = None,
    snapshot_store=None,
    progress: Optional[ProgressFn] = None,
) -> ScenarioResult:
    compiled = compiled or compile_scenario(scenario)
    settings = compiled.model.settings
    warmup = compiled.warmup or resolve_warmup(compiled)
    t_w = warmup.adopted_week
    window_end = min(t_w + settings.analysis_window, settings.horizon)

    snapshot_digest = None
    if snapshot_store is not None:
        from scsim.io.snapshots import family_digest
        snapshot_digest = family_digest(scenario)

    grid = replication_grid(
        settings.model_seeds,
        settings.disruption_event_seeds,
        any_stochastic(scenario.events),
    )
    kpis: list[dict[str, float]] = []
    # One [n_reps, horizon] block per PUBLISHED series, keyed by its declared
    # name. This was four separate locals threaded through `_extend_until_ci`'s
    # signature, which is why adding a fifth series meant touching five call
    # sites and is a large part of why `fg_value` never became one (§4 D163).
    rows: dict[str, np.ndarray] = {
        k: np.zeros((len(grid), settings.horizon)) for k in PUBLISHED_SERIES_KEYS
    }
    lp_fallbacks = 0
    cap_acc = _CapacityBindingAccumulator(compiled.model)
    # event index → (authored week, week used). Deterministic per event, so one
    # entry per event whatever the replication count (audit F-03).
    shifts: dict[int, tuple[int, int]] = {}
    for n, (i, j) in enumerate(grid):
        events = resolve_events(compiled.model, t_w, j, shifts) if scenario.events else []
        ctx = run_replication(
            compiled, i, j, events, debug=debug,
            snapshot_store=snapshot_store, snapshot_digest=snapshot_digest, warmup_week=t_w,
        )
        row = compute_replication_kpis(ctx, t_w, window_end, events)
        for pol in compiled.policies:
            row.update(pol.kpi_contribution(ctx, t_w, window_end))
        row["model_rep"], row["event_rep"] = float(i), float(j)
        kpis.append(row)
        for k in PUBLISHED_SERIES_KEYS:
            rows[k][n] = getattr(ctx.trace, k)
        cap_acc.observe(ctx, t_w, window_end)
        lp_fallbacks += int(ctx.policy_state.get("material_allocation", {}).get("lp_fallbacks", 0))
        _notify_progress(progress, n + 1, len(grid), row, ctx)

    # Sequential stopping (optional) extends model seeds until ε is met.
    from scsim.entities.enums import ReplicationStopping
    sequential = settings.replication_stopping == ReplicationStopping.SEQUENTIAL_CI and bool(scenario.events)
    if sequential:
        kpis, rows, grid = _extend_until_ci(
            compiled, scenario, kpis, rows, grid, t_w, window_end, debug, progress,
            cap_acc, shifts=shifts,
        )

    # Single-run inspection surface (G17/§9.5.1): expose the full-debug
    # per-item matrices when — and only when — the run is exactly one
    # replication. `ctx` is the sole replication's context here.
    item_series: Optional[dict[str, np.ndarray]] = None
    item_ids: Optional[dict[str, list[str]]] = None
    decision_trace: Optional[dict] = None
    if (
        settings.trace_verbosity == TraceVerbosity.FULL_DEBUG
        and len(grid) == 1
        and ctx.trace.keep_matrices
    ):
        tr = ctx.trace
        item_series = {
            "material.on_hand": tr.I_mat,
            "material.in_transit": tr.I_transit,
            "material.orders": tr.O_mat,
            "product.demand": tr.D,
            # WP 14.4 — the plan's record: what it projected, required and planned
            # (built is `product.production`).
            "product.projected_demand": tr.PD,
            "product.requirement": tr.REQ,
            "product.planned": tr.PLAN,
            "product.production": tr.Q,
            "product.fulfillment": tr.F,
            "product.backlog": tr.B,
            "product.lost_units": tr.L,
            # Finished-goods stock per product and its target S^FG — the
            # per-item halves of `fg_units`; both 0 for a make-to-order product.
            "product.fg_on_hand": tr.FG,
            "product.fg_target": tr.FG_TARGET,
            # The fulfillment mode the engine RESOLVED (row → master → project
            # → MTO), so no reader has to re-derive it: 1 = make-to-stock.
            "product.make_to_stock": np.repeat(
                compiled.model.mts_mask.astype(float)[:, None], tr.horizon, axis=1),
        }
        if tr.WIP is not None:
            # P-P.13 — units started and not yet completed, per product.
            item_series["product.wip"] = tr.WIP
        if tr.MRP_NEED is not None:
            # WP 14.5 — the MRP record, week by week, for a run that has MRP
            # materials (orders placed are `material.orders`).
            item_series.update({
                "material.mrp_need": tr.MRP_NEED,
                "material.mrp_on_hand": tr.MRP_ON_HAND,
                "material.mrp_on_the_way": tr.MRP_ON_WAY,
                "material.mrp_net": tr.MRP_NET,
            })
        item_ids = {
            "material": list(compiled.model.mat_ids),
            "product": list(compiled.model.prod_ids),
        }
        decision_trace = ctx.decisions.export()

    keys = sorted({k for row in kpis for k in row} - {"model_rep", "event_rep"})
    aggregates = {
        k: aggregate_mean_ci(np.array([r[k] for r in kpis if k in r]), settings.ci_level)
        for k in keys
    }
    stats = StatisticsReport(
        engine_version=ENGINE_VERSION,
        project_seed=settings.project_seed,
        model_seeds=settings.model_seeds,
        disruption_event_seeds=settings.disruption_event_seeds,
        n_replications=len(grid),
        crn_enabled=settings.crn_enabled,
        run_mode=settings.run_mode,
        warmup=warmup,
        below_replication_floor=settings.below_replication_floor,
        wide_ci_badge=settings.run_mode == RunMode.FAST_SCAN,
        stopping_rule="sequential_ci" if sequential else "fixed",
    )
    return ScenarioResult(
        name=scenario.name,
        kpis=kpis,
        fr_series=rows["fill_rate"],
        aggregates=aggregates,
        stats=stats,
        feasibility_warnings=compiled.feasibility_warnings,
        rep_cells=grid,
        warmup=warmup,
        lp_fallbacks=lp_fallbacks,
        # Every published series except `fill_rate`, which keeps its own
        # `fr_series` field for the callers that have always read it there.
        extra_series={k: v for k, v in rows.items() if k != "fill_rate"},
        item_series=item_series,
        item_ids=item_ids,
        decision_trace=decision_trace,
        capacity_binding=cap_acc.summary(compiled.model, t_w, window_end) or None,
        lead_time_truncations=cap_acc.lead_time_truncations(),
        lead_time_floor_raises=cap_acc.lead_time_floor_raises(),
        work_in_progress=cap_acc.work_in_progress(),
        production_lead_time_clips=cap_acc.production_lead_time_clips(),
        event_shifts=[
            {"event_index": i, "target_id": scenario.events[i].target_id,
             "authored_week": a, "used_week": u, "replications": len(grid)}
            for i, (a, u) in sorted(shifts.items())
        ],
        demand_clips=(clips := cap_acc.demand_clip_report()),
        demand_warnings=_demand_warnings(compiled.model, clips),
    )


def _demand_warnings(model: CompiledModel, clips: list[dict]) -> list[dict]:
    """The demand notes a user must see at the point of display (T2)."""
    out: list[dict] = []
    for f in model.row_forecast_short:
        out.append({
            "level": "warn", "entity": f"customer_row:{f['row']}", "field": "forecast",
            "reason": (f"the forecast covers {f['weeks']} of the run's {f['horizon']} weeks; "
                       f"later weeks use the row's {f['tail_source']} ({f['tail']:g}/wk)"),
        })
    for c in clips:
        kind = "row" if "row" in c else "product"
        label = c.get("row", c.get("product"))
        out.append({
            "level": "warn", "entity": f"{'customer_row' if kind == 'row' else 'product'}:{label}",
            "field": "demand_distribution",
            "reason": (f"normal demand: {c['clipped_draws']:g} of {c['draws']} weekly draws per "
                       f"replication were negative and set to 0, raising the realized mean by "
                       f"{c['mean_shift']:g}/wk"),
        })
    return out


def _extend_until_ci(compiled, scenario, kpis, rows, grid, t_w, window_end, debug,
                     progress: Optional[ProgressFn] = None,
                     cap_acc: Optional["_CapacityBindingAccumulator"] = None,
                     shifts: Optional[dict] = None):
    settings = compiled.model.settings
    e_axis = max({j for _, j in grid}) + 1
    next_i = max({i for i, _ in grid}) + 1
    while next_i < 200:
        fr = np.array([r["fill_rate"] for r in kpis])
        fr = fr[np.isfinite(fr)]
        # No measured fill rate (no demand in the window) → nothing to converge
        # on; extending to 200 replications would change nothing (audit F-08).
        if fr.size == 0 or t_halfwidth(fr, settings.ci_level) <= settings.ci_halfwidth_target:
            break
        batch = []
        for i in range(next_i, min(next_i + 10, 200)):
            for j in range(e_axis):
                batch.append((i, j))
        for (i, j) in batch:
            events = resolve_events(compiled.model, t_w, j, shifts) if scenario.events else []
            ctx = run_replication(compiled, i, j, events, debug=debug)
            row = compute_replication_kpis(ctx, t_w, window_end, events)
            for pol in compiled.policies:
                row.update(pol.kpi_contribution(ctx, t_w, window_end))
            row["model_rep"], row["event_rep"] = float(i), float(j)
            kpis.append(row)
            for k in PUBLISHED_SERIES_KEYS:
                rows[k] = np.vstack([rows[k], getattr(ctx.trace, k)[None, :]])
            # The extension replications are replications: leaving them out
            # would make `bound_weeks` a mean over a denominator that no longer
            # matches the run (`replications` below would disagree with
            # `stats.n_replications`, which is exactly the kind of silent
            # divergence §2.1 `single-source` is about).
            if cap_acc is not None:
                cap_acc.observe(ctx, t_w, window_end)
            # The final total is unknown while extending — report the current
            # count as both done and total so observers see monotone progress.
            _notify_progress(progress, len(kpis), len(kpis), row, ctx)
        grid = grid + batch
        next_i += 10
    return kpis, rows, grid


# ---------------------------------------------------------------------------
# Portfolio study under CRN (deltas vs S0; synergy-ready)
# ---------------------------------------------------------------------------

@dataclass
class PortfolioStudy:
    base_name: str
    s0: ScenarioResult
    portfolios: dict[str, ScenarioResult]
    clean: dict[str, ScenarioResult]               # per-portfolio no-event reference
    deltas: dict[str, dict[str, np.ndarray]]       # name → per-rep ΔR / ΔC / SLA arrays
    portfolio_policies: dict[str, list[str]]       # name → strategy policy ids
    settings_seed: int
    bootstrap_resamples: int
    ci_level: float


def run_portfolio_study(
    scenario: Scenario,
    portfolios: dict[str, dict[str, dict]],
    include_clean_reference: bool = True,
    debug: bool = False,
) -> PortfolioStudy:
    """Run S0 (built-ins only) + each portfolio under CRN; produce per-rep
    paired ΔR (Eq. 25-style) and ΔC^res (Eq. 24-style) plus SLA when the
    clean reference is enabled."""
    if not scenario.events:
        raise ValueError("portfolio study needs at least one disruption event")
    builtins = {
        pid: params for pid, params in scenario.policies.items() if pid in BUILT_IN_POLICY_IDS
    }
    s0_scenario = scenario.with_policies(dict(builtins), name=f"{scenario.name}__S0")

    # Shared warm-up: detect once on S0 (same network/built-ins ⇒ same steady state).
    s0_compiled = compile_scenario(s0_scenario)
    warmup = resolve_warmup(s0_compiled)
    s0 = run_scenario(s0_scenario, debug=debug, compiled=s0_compiled)

    results: dict[str, ScenarioResult] = {}
    clean: dict[str, ScenarioResult] = {}
    deltas: dict[str, dict[str, np.ndarray]] = {}
    settings = scenario.settings

    d_total = s0.kpi_array("demand_value")
    q_s0 = s0.kpi_array("produced_value")
    c_s0 = s0.kpi_array("cost_of_resilience")
    portfolio_policies: dict[str, list[str]] = {}

    for name, policy_set in portfolios.items():
        merged = {**builtins, **policy_set}
        sc = scenario.with_policies(merged, name=f"{scenario.name}__{name}")
        sc_compiled = compile_scenario(sc)
        sc_compiled.warmup = warmup
        res = run_scenario(sc, debug=debug, compiled=sc_compiled)
        results[name] = res
        portfolio_policies[name] = [p for p in policy_set if p not in BUILT_IN_POLICY_IDS]

        q_i = res.kpi_array("produced_value")
        c_i = res.kpi_array("cost_of_resilience")
        if len(q_i) != len(q_s0):
            raise ValueError(
                "replication grids differ between S0 and portfolio runs — keep "
                "replication_stopping='fixed' for portfolio studies (CRN pairing)"
            )
        denom = d_total - q_s0
        delta_r = np.where(np.abs(denom) > 1e-9, (q_i - q_s0) / np.where(denom == 0, 1, denom), 0.0)
        delta_c = np.where(np.abs(c_s0) > 1e-9, 1.0 - c_i / np.where(c_s0 == 0, 1, c_s0), 0.0)
        entry = {"delta_revenue": delta_r, "delta_cost": delta_c}

        if include_clean_reference:
            sc_clean = sc.without_events(name=f"{scenario.name}__{name}__clean")
            cl_compiled = compile_scenario(sc_clean)
            cl_compiled.warmup = warmup
            cl = run_scenario(sc_clean, debug=debug, compiled=cl_compiled)
            clean[name] = cl
            t_w = warmup.adopted_week
            w_end = min(t_w + settings.analysis_window, settings.horizon)
            # CRN pairing: disrupted rep (i, j) shares world streams with the
            # clean rep at the same model seed i (clean grid has event axis 1).
            clean_row_of_model_rep = {cell[0]: r for r, cell in enumerate(cl.rep_cells)}
            sla = np.zeros(len(res.rep_cells))
            for r, (i, _j) in enumerate(res.rep_cells):
                ref = cl.fr_series[clean_row_of_model_rep[i], t_w:w_end]
                gap = ref - res.fr_series[r, t_w:w_end]
                sla[r] = float(np.maximum(gap, 0.0).sum())
            entry["service_loss_area"] = sla
        deltas[name] = entry

    return PortfolioStudy(
        base_name=scenario.name,
        s0=s0,
        portfolios=results,
        clean=clean,
        deltas=deltas,
        portfolio_policies=portfolio_policies,
        settings_seed=settings.project_seed,
        bootstrap_resamples=settings.bootstrap_resamples,
        ci_level=float(settings.ci_level),
    )

# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""Canonical project → Scenario mapper: reducers, units, defaults, modes."""
from __future__ import annotations

import pytest

from scsim.entities.enums import DemandModel, EffectType, FulfillmentMode
from scsim.io.project_map import (
    BomArc,
    MaterialRow,
    OutboundArc,
    ProductRow,
    ProjectData,
    ScenarioSettings,
    SupplierRow,
    SupplyArc,
    from_project_data,
)


def _base(**scenario_kw) -> ProjectData:
    """One supplier → one material → one product → one customer."""
    return ProjectData(
        suppliers=[SupplierRow(id="s1")],
        materials=[MaterialRow(id="m1", cost=2.0)],
        products=[ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=200.0)],
        supply_arcs=[SupplyArc(supplier_id="s1", material_id="m1", unit_price=2.0,
                               lead_time=2, lead_time_unit="week")],
        bom=[BomArc(product_id="p1", material_id="m1", consumption_rate=1.0)],
        outbound=[OutboundArc(product_id="p1", customer_id="c1", unit_price=20.0,
                              volume=100.0, time_unit="week")],
        scenario=ScenarioSettings(**scenario_kw),
    )


def test_master_prices_win():
    res = from_project_data(_base())
    net = res.scenario.network
    assert net.materials[0].cost == 2.0
    assert net.products[0].unit_price == 20.0
    assert net.supplier_links[0].cost == 2.0


def test_product_price_is_demand_weighted_average_when_no_master():
    d = _base()
    d.products[0].sell_price = None  # force fallback
    d.outbound = [
        OutboundArc("p1", "big", unit_price=10.0, volume=300.0, time_unit="week"),
        OutboundArc("p1", "small", unit_price=20.0, volume=100.0, time_unit="week"),
    ]
    res = from_project_data(d)
    # weighted: (10*300 + 20*100) / 400 = 12.5  (NOT last-writer 20 or max 20)
    assert res.scenario.network.products[0].unit_price == pytest.approx(12.5)
    assert any(w.field == "unit_price" for w in res.warnings)


def test_material_cost_is_volume_weighted_across_lanes_when_no_master():
    """The analogue of the demand-weighted sell price above: a multi-sourced
    material is valued at what it costs, not at its cheapest quote."""
    d = _base()
    d.materials[0].cost = None
    d.supply_arcs = [
        SupplyArc("s1", "m1", unit_price=5.0, lead_time=2, lead_time_unit="week",
                  volume=300.0, time_unit="week"),
        SupplyArc("s2", "m1", unit_price=3.0, lead_time=3, lead_time_unit="week",
                  volume=100.0, time_unit="week"),
    ]
    res = from_project_data(d)
    # (5*300 + 3*100) / 400 = 4.5  — NOT the cheapest quote (3.0)
    assert res.scenario.network.materials[0].cost == pytest.approx(4.5)
    note = next(w for w in res.warnings
                if w.entity == "material:m1" and w.field == "cost")
    assert note.level == "info"
    assert "volume-weighted" in note.reason


def test_material_cost_weight_is_normalized_to_a_weekly_rate():
    """`time_unit` describes the VOLUME period, so lanes quoted in different
    periods must be weighted by the same weekly basis before averaging."""
    d = _base()
    d.materials[0].cost = None
    d.supply_arcs = [
        # 13 per month ≈ 3 per week vs. 1 per week → the monthly lane dominates
        SupplyArc("s1", "m1", unit_price=10.0, lead_time=2, lead_time_unit="week",
                  volume=13.035, time_unit="month"),
        SupplyArc("s2", "m1", unit_price=2.0, lead_time=2, lead_time_unit="week",
                  volume=1.0, time_unit="week"),
    ]
    res = from_project_data(d)
    # (10*3 + 2*1) / 4 = 8.0 on a weekly basis; taking the volumes raw would
    # give (10*13.035 + 2)/14.035 = 9.43.
    assert res.scenario.network.materials[0].cost == pytest.approx(8.0, rel=1e-3)


def test_material_cost_ignores_lanes_with_no_volume():
    """A lane nothing is bought through carries no weight at all — it neither
    moves the mean nor (by being present) hides the cheapest-quote step."""
    d = _base()
    d.materials[0].cost = None
    d.supply_arcs = [
        SupplyArc("s1", "m1", unit_price=5.0, lead_time=2, lead_time_unit="week",
                  volume=100.0, time_unit="week"),
        SupplyArc("s2", "m1", unit_price=3.0, lead_time=3, lead_time_unit="week"),
    ]
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == pytest.approx(5.0)


def test_material_cost_falls_back_to_cheapest_link_with_warning():
    """No lane carries a volume → nothing to weight by, so the chain's second
    step resolves it: the cheapest quote, which is what every project got
    before volumes were weighted."""
    d = _base()
    d.materials[0].cost = None
    d.supply_arcs = [
        SupplyArc("s1", "m1", unit_price=5.0, lead_time=2, lead_time_unit="week"),
        SupplyArc("s2", "m1", unit_price=3.0, lead_time=3, lead_time_unit="week"),
    ]
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == 3.0  # cheapest
    note = next(w for w in res.warnings
                if w.entity == "material:m1" and w.field == "cost")
    assert note.level == "info"
    assert "cheapest" in note.reason


def test_bom_material_with_no_master_row_is_simulated_and_named():
    """§4 D166: a master row is not what makes a material real — the BOM is.

    Before D166 the arc filter dropped this material's lanes, so the `unsourced`
    check raised and the branch meant to handle it could never run.
    """
    d = _base()
    d.bom.append(BomArc(product_id="p1", material_id="m2", consumption_rate=1.0))
    d.supply_arcs = d.supply_arcs + [
        SupplyArc("s1", "m2", unit_price=8.0, lead_time=2, lead_time_unit="week",
                  volume=300.0, time_unit="week"),
        SupplyArc("s2", "m2", unit_price=4.0, lead_time=2, lead_time_unit="week",
                  volume=100.0, time_unit="week"),
    ]
    res = from_project_data(d)          # no longer raises
    m2 = next(m for m in res.scenario.network.materials if m.id == "m2")
    assert m2.cost == pytest.approx(7.0)   # (8*300 + 4*100) / 400 — the same chain
    # T1: it is NAMED, not quietly materialized.
    note = next(w for w in res.warnings
                if w.entity == "material:m2" and w.field == "master_row")
    assert note.level == "info"
    assert "no row in `materials`" in note.reason
    # …and its lanes are real links, not dropped.
    assert any(l.material_id == "m2" for l in res.scenario.network.supplier_links)


def test_bom_material_with_no_arc_at_all_still_raises():
    """The error message always claimed this; since D166 it is what it means."""
    d = _base()
    d.bom.append(BomArc(product_id="p1", material_id="m_ghost", consumption_rate=1.0))
    with pytest.raises(ValueError, match="m_ghost"):
        from_project_data(d)


def test_an_arc_for_a_material_nothing_consumes_is_still_dropped():
    """D166 widened the filter to the BOM, not to everything: a lane for a
    material no product consumes and no master row names is still noise."""
    d = _base()
    d.supply_arcs = d.supply_arcs + [
        SupplyArc("s9", "m_unused", unit_price=5.0, lead_time=2, lead_time_unit="week",
                  volume=100.0, time_unit="week"),
    ]
    res = from_project_data(d)
    ids = {m.id for m in res.scenario.network.materials}
    assert "m_unused" not in ids
    assert not any(l.material_id == "m_unused"
                   for l in res.scenario.network.supplier_links)


def test_duplicate_supplier_material_arcs_deduped_to_cheapest():
    d = _base()
    d.supply_arcs = [
        SupplyArc("s1", "m1", unit_price=5.0, lead_time=2, lead_time_unit="week"),
        SupplyArc("s1", "m1", unit_price=3.0, lead_time=4, lead_time_unit="week"),
        SupplyArc("s1", "m1", unit_price=3.0, lead_time=1, lead_time_unit="week"),
    ]
    res = from_project_data(d)
    links = res.scenario.network.supplier_links
    assert len(links) == 1
    assert links[0].cost == 3.0
    assert links[0].lead_time_weeks == 1  # tie broken by shortest lead time
    assert any(w.field == "duplicate_arc" for w in res.warnings)


def test_missing_price_defaults_to_one_and_warns():
    d = _base()
    d.products[0].sell_price = None
    d.outbound = [OutboundArc("p1", "c1", unit_price=None, volume=100.0, time_unit="week")]
    res = from_project_data(d)
    assert res.scenario.network.products[0].unit_price == 1.0
    assert any(w.level == "warn" and w.field == "unit_price" for w in res.warnings)


@pytest.mark.parametrize("unit,vol,expected", [
    ("week", 100.0, 100.0),
    ("day", 10.0, 70.0),       # per-day → ×7
    ("month", 434.8, pytest.approx(100.0, rel=1e-3)),  # ÷4.348
    # Rate-word synonyms the upload templates actually use.
    ("yearly", 5218.0, pytest.approx(100.0, rel=1e-3)),   # ÷52.18
    ("annually", 5218.0, pytest.approx(100.0, rel=1e-3)),
    ("daily", 10.0, 70.0),
    ("weekly", 100.0, 100.0),
    ("monthly", 434.8, pytest.approx(100.0, rel=1e-3)),
])
def test_demand_unit_normalization(unit, vol, expected):
    d = _base()
    d.products[0].demand_mean = None  # force outbound-derived demand
    d.outbound = [OutboundArc("p1", "c1", unit_price=20.0, volume=vol, time_unit=unit)]
    res = from_project_data(d)
    assert res.scenario.network.products[0].demand_mode == expected


def test_lead_time_days_normalized_to_weeks():
    d = _base()
    d.supply_arcs = [SupplyArc("s1", "m1", unit_price=2.0, lead_time=14, lead_time_unit="day")]
    res = from_project_data(d)
    assert res.scenario.network.supplier_links[0].lead_time_weeks == 2


def test_lead_time_is_weeks_and_ignores_rate_time_unit():
    """§3 contract: time_unit describes the volume period only; lead_time is
    weeks unless lead_time_unit explicitly overrides. A template row with
    time_unit="yearly" and lead_time=4 must map to 4 weeks, not 4 years."""
    d = _base()
    d.supply_arcs = [SupplyArc("s1", "m1", unit_price=2.0, lead_time=4,
                               time_unit="yearly")]
    res = from_project_data(d)
    assert res.scenario.network.supplier_links[0].lead_time_weeks == 4


def test_fulfillment_mode_from_project_model():
    d = _base()
    d.products[0].fulfillment_mode = None
    d.project_model = "Make-To-Stock"
    res = from_project_data(d)
    assert res.scenario.network.products[0].fulfillment_mode == FulfillmentMode.MTS


def test_scenario_demand_model_poisson_applied():
    d = _base(demand_model={"kind": "poisson"})
    res = from_project_data(d)
    assert res.scenario.network.products[0].demand_model == DemandModel.POISSON


def test_triangular_av_from_mean_and_cv():
    d = _base(demand_model={"kind": "triangular", "cv": 0.30})
    d.products[0].demand_mean = 100.0
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert p.demand_model == DemandModel.TRIANGULAR
    assert (p.demand_min, p.demand_mode, p.demand_max) == (70.0, 100.0, 130.0)


def test_explicit_demand_bounds_override_triangular_av():
    """Master demand_min/demand_max carry an asymmetric empirical triangular
    (b = historical median, c = historical max) — the WSC/TRON form."""
    d = _base()
    d.products[0].demand_mean = 100.0
    d.products[0].demand_cv = 0.30
    d.products[0].demand_min = 70.0
    d.products[0].demand_max = 400.0  # right tail far beyond mean·1.3
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert (p.demand_min, p.demand_mode, p.demand_max) == (70.0, 100.0, 400.0)
    assert not [w for w in res.warnings if w.field in ("demand_min", "demand_max")]


def test_partial_explicit_bound_keeps_av_for_the_other():
    d = _base()
    d.products[0].demand_mean = 100.0
    d.products[0].demand_cv = 0.30
    d.products[0].demand_max = 250.0
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert (p.demand_min, p.demand_mode, p.demand_max) == (70.0, 100.0, 250.0)


def test_inconsistent_demand_bounds_clamped_with_warning():
    d = _base()
    d.products[0].demand_mean = 100.0
    d.products[0].demand_min = 120.0  # > mode
    d.products[0].demand_max = 80.0   # < mode
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert (p.demand_min, p.demand_mode, p.demand_max) == (100.0, 100.0, 100.0)
    fields = {w.field for w in res.warnings if w.level == "warn"}
    assert {"demand_min", "demand_max"} <= fields


def test_partial_cut_becomes_capacity_reduction_when_capacity_finite():
    d = _base()
    d.suppliers = [SupplierRow(id="s1", capacity_per_week=500.0)]
    d.scenario.disruption_schedule = [
        {"target": "supplier:s1", "magnitude_pct": 60, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    ev = res.scenario.events[0]
    assert ev.effect_type == EffectType.CAPACITY_REDUCTION
    assert ev.capacity_factor == pytest.approx(0.40)  # 60% cut → 40% remains


def test_partial_cut_without_capacity_warns_and_uses_extension():
    d = _base()  # supplier capacity None (∞)
    d.scenario.disruption_schedule = [
        {"target": "s1", "magnitude_pct": 60, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    assert res.scenario.events[0].effect_type == EffectType.LEAD_TIME_EXTENSION
    assert any("finite supplier capacity" in w.reason for w in res.warnings)


def test_plant_target_maps_to_node_plant_halt():
    from scsim.entities.enums import TargetType
    d = _base()
    d.scenario.disruption_schedule = [
        {"target": "plant:main", "magnitude_pct": 100, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    ev = res.scenario.events[0]
    assert ev.target_type == TargetType.NODE_PLANT
    assert ev.effect_type == EffectType.LEAD_TIME_EXTENSION  # full cut = halt
    assert not any(w.field == "target" for w in res.warnings)


def test_plant_partial_cut_throttles_without_capacity_precondition():
    """Unlike suppliers, the plant needs no capacity_per_week: production_capacity
    is always finite, so a partial cut always becomes capacity_reduction."""
    from scsim.entities.enums import TargetType
    d = _base()
    d.scenario.disruption_schedule = [
        {"target": "node:plant", "magnitude_pct": 75, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    ev = res.scenario.events[0]
    assert ev.target_type == TargetType.NODE_PLANT
    assert ev.effect_type == EffectType.CAPACITY_REDUCTION
    assert ev.capacity_factor == pytest.approx(0.25)  # 75% cut → 25% remains
    assert not any("finite supplier capacity" in w.reason for w in res.warnings)


def test_plant_event_runs_end_to_end():
    from scsim.core.engine import run_scenario
    d = _base(replications=2, horizon_days=560, warmup_mode="manual", warmup_days=70)
    d.scenario.disruption_schedule = [
        {"target": "plant:main", "magnitude_pct": 100, "start_week": 12, "duration_weeks": 8},
    ]
    out = run_scenario(from_project_data(d).scenario)
    assert out.aggregates["lost_sales_value"]["mean"] > 0.0


def test_material_target_maps_to_a_material_outage():
    """Engine 0.9.0 (PLAN.md §29 WP 19.1): a supplied material is a target. Before
    0.9.0 this schedule was skipped with a warning; it now stops m1's supply, and a
    partial cut says it runs as the full outage."""
    from scsim.entities.enums import EffectType, TargetType
    d = _base()
    d.scenario.disruption_schedule = [
        {"target": "material:m1", "magnitude_pct": 50, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    (ev,) = res.scenario.events
    assert (ev.target_type, ev.target_id, ev.start, ev.duration) == (TargetType.NODE_MATERIAL, "m1", 90, 6)
    assert ev.effect_type == EffectType.LEAD_TIME_EXTENSION
    assert any(w.field == "magnitude" and "full outage of its supply" in w.reason for w in res.warnings)
    assert not any(w.field == "target" and "skipped" in w.reason for w in res.warnings)


def test_a_material_with_no_supply_link_is_still_skipped():
    d = _base()
    d.scenario.disruption_schedule = [
        {"target": "material:not-supplied", "magnitude_pct": 100, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    assert res.scenario.events == []
    assert any(w.field == "target" and "no supplied material" in w.reason for w in res.warnings)


def test_supplier_literally_named_plant_stays_a_supplier():
    from scsim.entities.enums import TargetType
    d = _base()
    d.suppliers = [SupplierRow(id="plant")]
    d.supply_arcs = [SupplyArc(supplier_id="plant", material_id="m1", unit_price=2.0,
                               lead_time=2, lead_time_unit="week")]
    d.scenario.disruption_schedule = [
        {"target": "plant", "magnitude_pct": 100, "start_week": 90, "duration_weeks": 6},
    ]
    res = from_project_data(d)
    assert res.scenario.events[0].target_type == TargetType.NODE_SUPPLIER


def test_fulfillment_allocation_enables_customer_allocation():
    d = _base()
    d.outbound = [
        OutboundArc(product_id="p1", customer_id="c1", unit_price=20.0,
                    volume=60.0, time_unit="week"),
        OutboundArc(product_id="p1", customer_id="c2", unit_price=20.0,
                    volume=40.0, time_unit="week"),
    ]
    d.policies = {"default": {"fulfillment": {"allocation": "fair_share"}}}
    res = from_project_data(d)
    assert res.scenario.policies["customer_allocation"] == {"rule": "fair_share"}
    links = res.scenario.network.customer_links
    assert {(l.product_id, l.customer_id) for l in links} == {("p1", "c1"), ("p1", "c2")}
    shares = {l.customer_id: l.share for l in links}
    assert shares["c1"] == pytest.approx(60.0)


def test_single_customer_does_not_enable_customer_allocation():
    d = _base()  # one customer c1
    d.policies = {"default": {"fulfillment": {"allocation": "priority"}}}
    res = from_project_data(d)
    assert "customer_allocation" not in res.scenario.policies


def test_unsourced_material_raises():
    d = _base()
    d.supply_arcs = []  # m1 now has no supplier
    with pytest.raises(ValueError, match="no supplier link"):
        from_project_data(d)


def test_extended_fulfillment_mode_collapses_to_mto_with_warning():
    """CTO/ETO are valid UI strategies the engine doesn't model — they must
    collapse to MTO loudly, not silently (audit finding G)."""
    d = _base()
    d.products[0].fulfillment_mode = "configure_to_order"
    res = from_project_data(d)
    assert res.scenario.network.products[0].fulfillment_mode == FulfillmentMode.MTO
    assert any(w.level == "warn" and w.field == "fulfillment_mode" for w in res.warnings)


def test_fg_safety_stock_gated_on_actual_product_mode():
    """FG safety stock is gated on the products' real engine mode, not the
    separate `fulfillment_strategy` string: an MTS product enables it even when
    fulfillment_strategy is unset."""
    d = _base()
    d.project_model = "make_to_stock"  # products resolve to MTS
    d.products[0].fulfillment_mode = None
    d.policies = {"default": {"inventory": {
        "fg_safety_stock": "service_level", "fg_service_level_target": 0.95}}}
    res = from_project_data(d)
    assert "fg_safety_stock" in res.scenario.policies


def test_fg_safety_stock_skipped_when_no_mts_product_despite_strategy():
    """The two fulfillment-mode fields disagree: fulfillment_strategy claims MTS
    but no product is actually MTS → FG stock skipped, disagreement warned."""
    d = _base()  # products default to MTO
    d.policies = {"default": {
        "fulfillment_strategy": "make_to_stock",
        "inventory": {"fg_safety_stock": "fixed_days"},
    }}
    res = from_project_data(d)
    assert "fg_safety_stock" not in res.scenario.policies
    assert any(w.level == "warn" and w.field == "fulfillment_strategy" for w in res.warnings)


def _fulfillment_warned(res) -> bool:
    return any(w.level == "warn" and w.entity == "policy:unmet_demand_handling"
               and w.field == "fulfillment" for w in res.warnings)


def test_a_customer_row_backorder_override_is_applied_not_warned():
    """PLAN.md §24 WP 14.3 (D284 c): backorder, its window and cost are per
    customer × product row. Until then this override was dropped with a
    warning — the test that pinned the warning now pins its absence and the
    row's resolved settings (the project's window and the row's cost × 7)."""
    d = _base()
    d.policies = {
        "default": {"fulfillment": {"backorder_allowed": True}},
        "node:c1::p1": {"fulfillment": {"backorder_cost_per_day": 5.0}},
    }
    res = from_project_data(d)
    assert not _fulfillment_warned(res)
    assert res.scenario.policies["unmet_demand_handling"]["row_overrides"] == {
        "c1::p1": {"backorder_allowed": True, "backorder_horizon": 2, "backorder_penalty": 35.0}}


def test_a_row_may_backorder_in_a_lost_sales_project_and_vice_versa():
    d = _base()
    d.policies = {"node:c1::p1": {"fulfillment": {"backorder_allowed": True,
                                                  "max_backorder_days": 10}}}
    pol = from_project_data(d).scenario.policies["unmet_demand_handling"]
    assert pol["rule"] == "lost_sales"
    assert pol["row_overrides"]["c1::p1"] == {"backorder_allowed": True, "backorder_horizon": 1,
                                              "backorder_penalty": 0.0}
    d.policies = {"default": {"fulfillment": {"backorder_allowed": True}},
                  "node:c1::p1": {"fulfillment": {"backorder_allowed": False}}}
    pol = from_project_data(d).scenario.policies["unmet_demand_handling"]
    assert pol["rule"] == "backorder"
    assert pol["row_overrides"]["c1::p1"] == {"backorder_allowed": False}


def test_per_node_fulfillment_override_is_warned_not_dropped_silently():
    """What stays project-wide still warns on a node: the allocation RULE (one
    per project, decision 4), and any fulfillment field on a node that is not
    an existing Customer row (doc §4/§6)."""
    d = _base()
    d.policies = {"node:c1::p1": {"fulfillment": {"allocation": "priority"}}}
    assert _fulfillment_warned(from_project_data(d))
    d.policies = {"node:Plant::p1": {"fulfillment": {"backorder_allowed": True}}}
    res = from_project_data(d)
    assert _fulfillment_warned(res)
    assert "row_overrides" not in res.scenario.policies["unmet_demand_handling"]


@pytest.mark.parametrize("days,weeks", [(3, 0), (4, 1), (10, 1), (11, 2), (14, 2), (3.5, 1)])
def test_max_backorder_days_round_half_up_to_weeks(days, weeks):
    d = _base()
    d.policies = {"default": {"fulfillment": {"backorder_allowed": True,
                                              "max_backorder_days": days}},
                  "node:c1::p1": {"fulfillment": {"max_backorder_days": days}}}
    pol = from_project_data(d).scenario.policies["unmet_demand_handling"]
    assert pol["backorder_horizon"] == weeks
    assert pol["row_overrides"]["c1::p1"]["backorder_horizon"] == weeks


def test_per_node_routing_hint_does_not_trigger_fulfillment_warning():
    """primary_source / sourcing_firm are firm-routing hints, not fulfillment
    params — a node patch carrying only those must NOT warn."""
    d = _base()
    d.policies = {"node:c1::p1": {"fulfillment": {
        "sourcing_firm": "PlantA", "primary_source": True}}}
    res = from_project_data(d)
    assert not any(
        w.entity == "policy:unmet_demand_handling" and w.field == "fulfillment"
        for w in res.warnings
    )


def test_e1_fully_specified_project_has_no_silent_fallbacks():
    """Engine-retirement gate E1 (blueprint §3): a fully-specified project
    maps with ZERO warn-level MappingWarnings — every warn is a silent
    fallback the user did not ask for. The one info-level residue is the
    known Phase B leftover (absolute order_up_to → coverage-κ, G1)."""
    d = ProjectData(
        suppliers=[SupplierRow(id="s1", capacity_per_week=500.0)],
        materials=[MaterialRow(id="m1", cost=2.0)],
        products=[ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=200.0)],
        supply_arcs=[SupplyArc(supplier_id="s1", material_id="m1", unit_price=2.0,
                               lead_time=2, lead_time_unit="week")],
        bom=[BomArc(product_id="p1", material_id="m1", consumption_rate=1.0)],
        outbound=[OutboundArc(product_id="p1", customer_id="c1", unit_price=20.0,
                              volume=100.0, time_unit="week")],
        scenario=ScenarioSettings(horizon_days=364),
    )
    res = from_project_data(d)
    warns = [w for w in res.warnings if w.level == "warn"]
    assert warns == [], [w.as_dict() for w in warns]
    # `source` lines are the run log naming where each value came from (§23 WP
    # 13.1) — a report of the order override → master → lanes → default, never a
    # substitution, so they are not residue.
    info_residue = {(w.entity, w.field) for w in res.warnings
                    if w.level == "info" and w.entity != "source"}
    # The second residue is not new behaviour — it is a substitution that was
    # SILENT until audit WP 2 (F-21): at a 52-week horizon the analysis window is
    # bounded to horizon − 13 = 39 weeks, not the nominal 52, and this gate could
    # not see it because `_clamp` said nothing. It is `info` because the user's
    # horizon forced it, not a value they typed into the window.
    assert info_residue <= {("policy:inventory_control", "order_up_to"),
                            ("scenario", "analysis_window")}, info_residue


def test_scenario_runs_end_to_end():
    from scsim.core.engine import run_scenario
    res = from_project_data(_base(replications=2, horizon_days=560, warmup_mode="manual", warmup_days=70))
    out = run_scenario(res.scenario)
    assert "fill_rate" in out.aggregates


# ── Plant-stage production overrides (§4 D75) ────────────────────────────────
# The /policies plant grid keys every row "<focal plant>::<product>", so a
# lookup keyed by the product alone never reached it: line capacity was stored
# and never read. These pin both spellings and the master's precedence.

def _plant_capacity_case(policies: dict, master: float | None) -> tuple:
    d = _base()
    d.products = [ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=master)]
    d.policies = policies
    res = from_project_data(d)
    return res.scenario.network.products[0], res.warnings


def test_composite_plant_key_line_capacity_reaches_the_engine():
    """node:<plant>::<product> — the spelling the grid actually writes."""
    prod, warns = _plant_capacity_case(
        {"node:Focal plant::p1": {"production": {
            "capacity_units_per_day": 50.0, "utilization_cap_pct": 80.0}}},
        master=None,
    )
    assert prod.production_capacity == pytest.approx(50.0 * 7.0 * 0.80)  # 280/wk
    assert any(w.field == "production_capacity" and w.level == "info"
               and "derived from production policy" in w.reason for w in warns)
    assert not any("no capacity source" in w.reason for w in warns)


def test_bare_product_key_line_capacity_still_works():
    """node:<product> — no regression for any writer using the bare form."""
    prod, _ = _plant_capacity_case(
        {"node:p1": {"production": {
            "capacity_units_per_day": 50.0, "utilization_cap_pct": 80.0}}},
        master=None,
    )
    assert prod.production_capacity == pytest.approx(280.0)


def test_composite_key_beats_bare_key_and_project_default():
    """Most specific wins: default < node:<product> < node:<plant>::<product>."""
    prod, _ = _plant_capacity_case(
        {
            "default": {"production": {"capacity_units_per_day": 10.0,
                                       "utilization_cap_pct": 100.0}},
            "node:p1": {"production": {"capacity_units_per_day": 20.0}},
            "node:Focal plant::p1": {"production": {"capacity_units_per_day": 50.0}},
        },
        master=None,
    )
    assert prod.production_capacity == pytest.approx(50.0 * 7.0 * 1.0)  # 350/wk


def test_master_capacity_shadows_line_capacity_and_says_so():
    """products.production_capacity (units/wk) wins — but never silently."""
    prod, warns = _plant_capacity_case(
        {"node:Focal plant::p1": {"production": {"capacity_units_per_day": 50.0}}},
        master=200.0,
    )
    assert prod.production_capacity == pytest.approx(200.0)
    assert any(w.level == "info" and w.field == "production_capacity"
               and "shadows" in w.reason for w in warns)


def test_missing_utilization_cap_is_declared_not_silent():
    prod, warns = _plant_capacity_case(
        {"node:Focal plant::p1": {"production": {"capacity_units_per_day": 50.0}}},
        master=None,
    )
    assert prod.production_capacity == pytest.approx(50.0 * 7.0 * 0.85)  # 297.5/wk
    assert any(w.field == "utilization_cap_pct" and w.level == "info" for w in warns)


def test_override_naming_nothing_in_the_project_warns():
    """A key whose components name no entity joins nothing, in any family."""
    _, warns = _plant_capacity_case(
        {"node:Other plant::p_typo": {"production": {"capacity_units_per_day": 50.0}}},
        master=200.0,
    )
    assert any(w.level == "warn" and w.field == "target_key"
               and "p_typo" in w.reason for w in warns)


def test_known_target_keys_do_not_warn_as_orphans():
    """The four real spellings must not trip the orphan guard."""
    _, warns = _plant_capacity_case(
        {
            "node:Focal plant::p1": {"production": {"capacity_units_per_day": 50.0}},
            "node:s1::m1": {"sourcing": {"supply_share": 1.0}},
            "node:c1::p1": {"fulfillment": {"backorder_cost_per_day": 5.0}},
            "node:m1": {"inventory": {"holding_cost_pct": 0.25}},
        },
        master=200.0,
    )
    assert not any(w.field == "target_key" for w in warns)


def test_two_owners_on_one_product_warn_instead_of_silently_picking():
    """Two plants patching the same product (nganho124, PR #220).

    The merge is deterministic — sorted key order, last wins on a shared
    field — and it is ANNOUNCED. A silent choice between two values a user
    typed is the same defect D75 was.
    """
    prod, warns = _plant_capacity_case(
        {
            "node:Plant A::p1": {"production": {
                "capacity_units_per_day": 20.0, "utilization_cap_pct": 80.0}},
            "node:Plant B::p1": {"production": {"capacity_units_per_day": 30.0}},
        },
        master=None,
    )
    # B wins the field both set; A's utilization survives — B never sets it.
    assert prod.production_capacity == pytest.approx(30.0 * 7.0 * 0.80)
    amb = [w for w in warns if w.field == "target_key" and w.level == "warn"]
    assert len(amb) == 1, "exactly one ambiguity warning"
    assert "Plant A::p1" in amb[0].reason and "Plant B::p1" in amb[0].reason


def test_one_owner_per_product_does_not_warn():
    _, warns = _plant_capacity_case(
        {"node:Plant A::p1": {"production": {"capacity_units_per_day": 20.0}}},
        master=None,
    )
    assert not any(w.field == "target_key" and w.level == "warn" for w in warns)


def test_owner_name_containing_the_separator_still_resolves():
    """A plant literally named "A::B" — the second split candidate."""
    prod, _ = _plant_capacity_case(
        {"node:Plant A::B::p1": {"production": {
            "capacity_units_per_day": 20.0, "utilization_cap_pct": 80.0}}},
        master=None,
    )
    assert prod.production_capacity == pytest.approx(20.0 * 7.0 * 0.80)


def test_sequential_ci_without_disruptions_says_it_runs_a_fixed_count():
    """Audit F-32: the engine extends replications for a sequential-CI rule only
    when the scenario has events (`engine.py` gates on `scenario.events`), so a
    baseline scenario with that rule ran a fixed count and said nothing."""
    res = from_project_data(_base(stopping_rule={"kind": "sequential_ci", "epsilon": 0.02}))
    [w] = [w for w in res.warnings if w.field == "stopping_rule"]
    assert w.level == "warn" and "fixed" in w.reason
    res2 = from_project_data(_base(
        stopping_rule={"kind": "sequential_ci"},
        disruption_schedule=[{"target": "supplier:s1", "start_day": 140, "duration_days": 14}]))
    assert not [w for w in res2.warnings if w.field == "stopping_rule"]


# ------------------------- supplier-grid replenishment overrides (P-P.1)

def test_supplier_row_inventory_override_reaches_engine():
    """A node:<supplier>::<material> inventory patch becomes a per-material
    engine override — the class of edit that was silently dropped before."""
    d = _base()
    d.policies = {"node:s1::m1": {"inventory": {
        "type": "min_max", "reorder_point": 300, "coverage_weeks": 4,
    }}}
    res = from_project_data(d)
    inv = res.scenario.policies["inventory_control"]
    assert inv["material_overrides"]["m1"] == {
        "policy_type": "min_max", "reorder_point": 300.0, "coverage_weeks": 4.0}
    assert any(w.level == "info" and w.field == "material_overrides"
               for w in res.warnings)
    assert not any(w.field == "inventory" and w.level == "warn"
                   for w in res.warnings)


def test_supplier_row_zero_q_is_unset_not_a_zero_lot():
    """The frontend schema defaults rop_q_quantity to 0; a stored 0 means
    'unset', never a zero lot (and never a gt=0 validation crash)."""
    d = _base()
    d.policies = {"node:s1::m1": {"inventory": {"rop_q_quantity": 0}}}
    res = from_project_data(d)
    assert "material_overrides" not in res.scenario.policies["inventory_control"]


def test_default_scope_rop_without_q_declares_the_fallback():
    """(R,Q) at project scope with no positive Q: the substitution (order up
    to S) is DECLARED as a warning, and no zero/absent Q reaches pydantic."""
    d = _base()
    d.policies = {"default": {"inventory": {"type": "rop", "rop_q_quantity": 0}}}
    res = from_project_data(d)
    inv = res.scenario.policies["inventory_control"]
    assert inv["policy_type"] == "rop_q"
    assert "rop_q_quantity" not in inv
    assert any(w.level == "warn" and w.field == "rop_q_quantity" for w in res.warnings)


def test_default_scope_coverage_weeks_maps_to_a_fixed_strip():
    d = _base()
    d.policies = {"default": {"inventory": {"coverage_weeks": 4}}}
    res = from_project_data(d)
    assert res.scenario.policies["inventory_control"]["coverage_weeks"] == {
        "nominal": 4.0, "alert": 4.0, "crisis": 4.0}


def test_conflicting_supplier_rows_warn_and_keep_first():
    """Two suppliers of one material stating different κ: deterministic keep
    (sorted key order, first wins) and an ANNOUNCED conflict, not a silent pick."""
    d = _base()
    d.suppliers.append(SupplierRow(id="s2"))
    d.supply_arcs.append(SupplyArc(supplier_id="s2", material_id="m1",
                                   unit_price=2.5, lead_time=3, lead_time_unit="week"))
    d.policies = {
        "node:s1::m1": {"inventory": {"coverage_weeks": 4}},
        "node:s2::m1": {"inventory": {"coverage_weeks": 9}},
    }
    res = from_project_data(d)
    inv = res.scenario.policies["inventory_control"]
    assert inv["material_overrides"]["m1"]["coverage_weeks"] == 4.0
    assert any(w.level == "warn" and w.entity == "material:m1"
               and w.field == "coverage_weeks" for w in res.warnings)


def test_inverted_absolute_band_drops_S_with_warning():
    d = _base()
    d.policies = {"node:s1::m1": {"inventory": {
        "reorder_point": 500, "order_up_to": 400}}}
    res = from_project_data(d)
    ov = res.scenario.policies["inventory_control"]["material_overrides"]["m1"]
    assert ov == {"reorder_point": 500.0}
    assert any(w.level == "warn" and w.entity == "material:m1"
               and w.field == "order_up_to" for w in res.warnings)


def test_plant_row_inventory_stays_default_scope_and_warns():
    """A plant-stage node key (second token is a product, not a material) is
    still dropped for inventory — and still counted, not silent."""
    d = _base()
    d.policies = {"node:Focal plant::p1": {"inventory": {"type": "rop"}}}
    res = from_project_data(d)
    assert "material_overrides" not in res.scenario.policies["inventory_control"]
    assert any(w.level == "warn" and w.field == "inventory"
               and "not applied" in w.reason for w in res.warnings)


# ------------- /policies values override the item masters (§4 D188, D204)

def _two_suppliers() -> ProjectData:
    """m1 bought from s1 at 2.0 and s2 at 5.0 — the engine's own rule picks s1."""
    d = _base()
    d.suppliers.append(SupplierRow(id="s2"))
    d.supply_arcs.append(SupplyArc(supplier_id="s2", material_id="m1",
                                   unit_price=5.0, lead_time=3, lead_time_unit="week"))
    return d


def _primary(res) -> str:
    from scsim.core.context import CompiledModel
    m = CompiledModel(res.scenario)
    return m.sup_ids[m.link_sup[m.primary_link[m.mat_index["m1"]]]]


def test_unsaved_primary_keeps_the_cheapest_supplier():
    res = from_project_data(_two_suppliers())
    assert _primary(res) == "s1"
    assert res.scenario.network.primary_link("m1").supplier_id == "s1"


def test_saved_primary_on_policies_beats_the_cheapest_supplier():
    """The run buys where the /policies Supplier stage says, not where the
    engine's cost rule would — D188's 'the grid says X, the run buys from Y'."""
    d = _two_suppliers()
    d.policies = {"node:s2::m1": {"sourcing": {"primary_source": True}}}
    res = from_project_data(d)
    assert _primary(res) == "s2"
    assert res.scenario.network.primary_link("m1").supplier_id == "s2"
    note = next(w for w in res.warnings if w.field == "primary_source")
    assert note.level == "info"
    assert "for 1 of them that is not the cheapest" in note.reason


def test_two_saved_primaries_apply_neither_and_warn():
    d = _two_suppliers()
    d.policies = {
        "node:s1::m1": {"sourcing": {"primary_source": True}},
        "node:s2::m1": {"sourcing": {"primary_source": True}},
    }
    res = from_project_data(d)
    assert _primary(res) == "s1"
    assert any(w.level == "warn" and w.entity == "material:m1"
               and w.field == "primary_source" for w in res.warnings)


def test_saved_primary_with_no_lane_is_named_not_forgotten():
    d = _base()
    d.policies = {"node:gone::m1": {"sourcing": {"primary_source": True}}}
    res = from_project_data(d)
    assert any(w.field == "primary_source" and "no inbound lane" in w.reason
               for w in res.warnings)


def test_policies_holding_pct_beats_the_master():
    d = _base()
    d.materials[0].holding_cost_pct = 0.10
    d.policies = {"node:s1::m1": {"inventory": {"holding_cost_pct": 0.30}}}
    res = from_project_data(d)
    assert res.scenario.network.materials[0].holding_cost_rate == pytest.approx(30.0)
    # Applied, so not counted among the dropped per-node overrides.
    assert not any(w.field == "inventory" and "not applied" in w.reason for w in res.warnings)


def test_policies_holding_pct_applies_to_a_material_with_no_master_row():
    d = _base()
    d.materials = []  # m1 exists only through the BOM and its lane
    d.policies = {"node:s1::m1": {"inventory": {"holding_cost_pct": 0.35}}}
    res = from_project_data(d)
    assert res.scenario.network.materials[0].holding_cost_rate == pytest.approx(35.0)


def test_master_holding_pct_applies_when_policies_says_nothing():
    d = _base()
    d.materials[0].holding_cost_pct = 0.10
    res = from_project_data(d)
    assert res.scenario.network.materials[0].holding_cost_rate == pytest.approx(10.0)


def test_policies_safety_days_reach_the_engine_per_material():
    d = _base()
    d.policies = {
        "default": {"inventory": {"safety_stock_method": "service_level"}},
        "node:s1::m1": {"inventory": {"safety_stock_days": 21}},
    }
    res = from_project_data(d)
    ss = res.scenario.policies["safety_stock_materials"]
    assert ss["classification"] == "uniform"
    assert ss["fixed_days_by_material"] == {"m1": 21.0}
    assert not any(w.field == "inventory" and "not applied" in w.reason for w in res.warnings)


def test_per_material_safety_days_size_the_buffer():
    """E[D]·days/7 for the listed material, whatever the classification."""
    from scsim.core.engine import compile_scenario, run_replication
    from scsim.policies.strategic.p_p3_safety_stock import SafetyStockParams

    with pytest.raises(ValueError):
        SafetyStockParams(fixed_days_by_material={"m1": 90.0})
    d = _base(horizon_days=90)
    d.policies = {
        "default": {"inventory": {"safety_stock_method": "service_level"}},
        "node:s1::m1": {"inventory": {"safety_stock_days": 14}},
    }
    compiled = compile_scenario(from_project_data(d).scenario)
    ctx = run_replication(compiled, 0, 0, [], debug=True)
    i = compiled.model.mat_index["m1"]
    exp_d = compiled.model.exp_demand_m[i]
    ss = ctx.policy_state["safety_stock_materials"]
    assert ss["ss_s"][i] == pytest.approx(exp_d * 14 / 7)
    assert ss["ss_S"][i] == pytest.approx(exp_d * 14 / 7)


# ── §23 WP 13.1 — /policies writes OVERRIDES, never the item masters ──────────
#
# Every master-backed /policies cell is a per-row policy override, read
# override → item master → derived from lanes → default. The master rows in
# these fixtures carry a value on purpose: the override must beat it, and the
# master must still decide when no override exists.

def _sources(res, field):
    return next(w.reason for w in res.warnings if w.entity == "source" and w.field == field)


def test_supplier_row_overrides_beat_every_material_and_supplier_master():
    d = _base()
    d.suppliers = [SupplierRow(id="s1", capacity_per_week=500.0, reliability_score=0.9)]
    d.materials = [MaterialRow(id="m1", cost=2.0, moq=10.0, initial_on_hand=5.0)]
    d.policies = {"node:s1::m1": {
        "sourcing": {"material_cost": 3.5, "material_moq": 40, "capacity_per_week": 250,
                     "reliability_score": 0.75},
        "inventory": {"initial_on_hand": 80},
    }}
    res = from_project_data(d)
    net = res.scenario.network
    assert net.materials[0].cost == pytest.approx(3.5)
    assert net.materials[0].initial_on_hand == pytest.approx(80.0)
    assert net.supplier_links[0].moq == pytest.approx(40.0)
    assert net.suppliers[0].capacity_per_week == pytest.approx(250.0)
    assert net.suppliers[0].reliability_score == pytest.approx(0.75)
    # The master rows are inputs and are not touched by the mapper.
    assert d.materials[0].cost == 2.0 and d.suppliers[0].capacity_per_week == 500.0
    assert _sources(res, "materials.cost") .endswith("override 1")
    # An applied supplier-row inventory override is not counted as dropped.
    assert not any(w.field == "inventory" and "not applied" in w.reason for w in res.warnings)


def test_plant_row_overrides_beat_every_product_master():
    # Demand is not among them since §4 D286: it is authored on Customer rows.
    d = _base()
    d.products[0].demand_cv = 0.2
    d.policies = {"node:Plant A::p1": {"production": {
        "sell_price": 31.0, "production_capacity": 333.0}}}
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert p.unit_price == pytest.approx(31.0)
    assert p.production_capacity == pytest.approx(333.0)
    assert "override 1" in _sources(res, "products.sell_price")


def test_the_master_decides_when_no_override_exists():
    d = _base()
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == 2.0
    assert _sources(res, "materials.cost").endswith("master 1")
    assert _sources(res, "products.sell_price").endswith("master 1")


def test_override_beats_the_lanes_when_there_is_no_master():
    d = _base()
    d.materials = [MaterialRow(id="m1")]          # no master cost: lanes would say 2.0
    d.products[0].sell_price = None                # lanes would say 20.0
    d.policies = {"node:s1::m1": {"sourcing": {"material_cost": 4.0}},
                  "node:Plant A::p1": {"production": {"sell_price": 25.0}}}
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == pytest.approx(4.0)
    assert res.scenario.network.products[0].unit_price == pytest.approx(25.0)
    d.policies = {}
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == pytest.approx(2.0)
    assert _sources(res, "materials.cost").endswith("lanes 1")


def test_an_unusable_override_is_ignored_and_said_and_the_master_decides():
    d = _base()
    d.policies = {"node:s1::m1": {"sourcing": {"material_cost": 0, "reliability_score": 1.7}}}
    res = from_project_data(d)
    assert res.scenario.network.materials[0].cost == 2.0
    assert res.scenario.network.suppliers[0].reliability_score == 1.0
    bad = [w for w in res.warnings if w.level == "warn" and "not a usable value" in w.reason]
    assert {w.field for w in bad} == {"material_cost", "reliability_score"}


def test_an_override_reaches_a_bom_material_with_no_master_row():
    d = _base()
    d.materials = []
    d.policies = {"node:s1::m1": {"sourcing": {"material_cost": 6.0, "material_moq": 12},
                                  "inventory": {"initial_on_hand": 9}}}
    res = from_project_data(d)
    m = res.scenario.network.materials[0]
    assert (m.cost, m.initial_on_hand) == (pytest.approx(6.0), pytest.approx(9.0))
    assert res.scenario.network.supplier_links[0].moq == pytest.approx(12.0)


def test_a_supplier_override_on_two_rows_that_disagree_keeps_the_first_and_says_so():
    d = _base()
    d.materials.append(MaterialRow(id="m2", cost=1.0))
    d.supply_arcs.append(SupplyArc(supplier_id="s1", material_id="m2", unit_price=1.0,
                                   lead_time=1, lead_time_unit="week"))
    d.bom.append(BomArc(product_id="p1", material_id="m2", consumption_rate=1.0))
    d.policies = {"node:s1::m1": {"sourcing": {"capacity_per_week": 100}},
                  "node:s1::m2": {"sourcing": {"capacity_per_week": 300}}}
    res = from_project_data(d)
    assert res.scenario.network.suppliers[0].capacity_per_week == pytest.approx(100.0)
    assert any(w.entity == "supplier:s1" and w.field == "capacity_per_week"
               and "conflicting" in w.reason for w in res.warnings)


# ── The Supplier row's lead time — an override of a LANE column ────────────────
#
# `lead_time_weeks` on `node:<supplier>::<material>` beats the uploaded
# `inbound_logistics.lead_time` for that one link: the upload is the suggestion,
# the /policies row is what runs.

def _two_lanes() -> ProjectData:
    d = _base()
    d.suppliers.append(SupplierRow(id="s2"))
    d.supply_arcs.append(SupplyArc(supplier_id="s2", material_id="m1", unit_price=3.0,
                                   lead_time=4, lead_time_unit="week"))
    return d


def _lead(res, sup, mat="m1"):
    return next(l.lead_time_weeks for l in res.scenario.network.supplier_links
                if l.supplier_id == sup and l.material_id == mat)


def test_a_supplier_row_lead_time_beats_the_uploaded_lane_and_only_that_lane():
    d = _two_lanes()
    d.policies = {"node:s2::m1": {"sourcing": {"lead_time_weeks": 7}}}
    res = from_project_data(d)
    assert (_lead(res, "s1"), _lead(res, "s2")) == (2, 7)
    lt = res.resolved["inbound_logistics.lead_time"]
    assert lt["s1::m1"] == {"source": "master", "value": 2}
    assert lt["s2::m1"] == {"source": "override", "value": 7}
    assert _sources(res, "inbound_logistics.lead_time").endswith("override 1 · master 1")
    # The upload is an input and is not touched.
    assert d.supply_arcs[1].lead_time == 4


def test_without_a_lead_time_override_the_run_log_is_unchanged():
    res = from_project_data(_two_lanes())
    assert not any(w.entity == "source" and w.field == "inbound_logistics.lead_time"
                   for w in res.warnings)
    assert res.resolved["inbound_logistics.lead_time"]["s2::m1"] == {"source": "master", "value": 4}


def test_a_lead_time_override_fills_a_blank_lane_instead_of_the_two_week_default():
    d = _base()
    d.supply_arcs[0].lead_time = None
    res = from_project_data(d)
    assert _lead(res, "s1") == 2
    assert res.resolved["inbound_logistics.lead_time"]["s1::m1"] == {"source": "default", "value": 2}
    d.policies = {"node:s1::m1": {"sourcing": {"lead_time_weeks": 5}}}
    res = from_project_data(d)
    assert _lead(res, "s1") == 5
    assert not any(w.field == "lead_time" and "defaulted to 2 weeks" in w.reason for w in res.warnings)


def test_a_lead_time_override_is_rounded_and_clamped_like_the_upload():
    d = _base()
    d.policies = {"node:s1::m1": {"sourcing": {"lead_time_weeks": 2.5}}}
    assert _lead(from_project_data(d), "s1") == 2           # half to even, as round() does
    d.policies = {"node:s1::m1": {"sourcing": {"lead_time_weeks": 80}}}
    res = from_project_data(d)
    assert _lead(res, "s1") == 51
    assert res.resolved["inbound_logistics.lead_time"]["s1::m1"] == {"source": "override", "value": 51}


def test_an_unusable_lead_time_override_is_ignored_and_said_and_the_upload_decides():
    d = _base()
    d.policies = {"node:s1::m1": {"sourcing": {"lead_time_weeks": 0}}}
    res = from_project_data(d)
    assert _lead(res, "s1") == 2
    assert any(w.field == "lead_time_weeks" and "not a usable value" in w.reason for w in res.warnings)
    assert res.resolved["inbound_logistics.lead_time"]["s1::m1"]["source"] == "master"


def test_a_lead_time_override_moves_the_engines_primary_tie_break():
    # Equal cost: the engine's own rule then picks the SHORTER lead time.
    from scsim.entities.network import primary_rank

    def primary(res):
        return min(res.scenario.network.supplier_links, key=primary_rank).supplier_id

    d = _two_lanes()
    d.supply_arcs[1].unit_price = 2.0
    assert primary(from_project_data(d)) == "s1"
    d.policies = {"node:s2::m1": {"sourcing": {"lead_time_weeks": 1}}}
    assert primary(from_project_data(d)) == "s2"


def test_a_production_capacity_override_shadows_the_line_capacity_and_says_which():
    d = _base()
    d.products[0].production_capacity = None
    d.policies = {"node:Plant A::p1": {"production": {
        "production_capacity": 150.0, "capacity_units_per_day": 1000}}}
    res = from_project_data(d)
    assert res.scenario.network.products[0].production_capacity == pytest.approx(150.0)
    assert any(w.field == "production_capacity" and "the /policies override" in w.reason
               for w in res.warnings)


# ── FG policy per product (PLAN.md §24 WP 14.4, D284 d) ─────────────────────

def _mts_base(**fg) -> ProjectData:
    d = _base()
    d.products = [ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=200.0, fulfillment_mode="mts", **fg)]
    return d


def test_the_fg_policy_and_levels_reach_an_mts_product_from_the_master():
    res = from_project_data(_mts_base(fg_policy="min_max", fg_base_stock=400.0,
                                      fg_reorder_point=100.0, fg_initial_on_hand=250.0))
    p = res.scenario.network.products[0]
    assert (p.fg_policy.value, p.fg_base_stock, p.fg_reorder_point, p.fg_initial_on_hand) == (
        "min_max", 400.0, 100.0, 250.0)
    assert res.resolved["products.fg_policy"]["p1"] == {"source": "master", "value": "min_max"}


def test_a_plant_row_override_beats_the_master():
    d = _mts_base(fg_policy="base_stock", fg_base_stock=300.0)
    d.policies = {"node:Plant::p1": {"production": {"fg_policy": "days_of_cover",
                                                    "fg_cover_days": 14}}}
    p = from_project_data(d).scenario.network.products[0]
    assert (p.fg_policy.value, p.fg_cover_days, p.fg_base_stock) == ("days_of_cover", 14.0, 300.0)


def test_an_incomplete_policy_runs_as_base_stock_and_says_so():
    res = from_project_data(_mts_base(fg_policy="min_max", fg_base_stock=400.0))
    assert res.scenario.network.products[0].fg_policy.value == "base_stock"
    assert any(w.field == "fg_policy" and "min_max needs" in w.reason for w in res.warnings)


def test_an_mto_product_reads_no_fg_policy_and_the_run_says_so():
    d = _base()
    d.products = [ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=200.0, fg_base_stock=300.0)]
    res = from_project_data(d)
    assert res.scenario.network.products[0].fg_base_stock is None
    assert any(w.field == "fg_policy" and "MTO" in w.reason for w in res.warnings)


def test_a_plant_row_demand_override_is_no_longer_read_and_says_so():
    """Demand is authored on the Customer rows (WP 14.2); the product's mean is
    only what a row without its own inherits. A Plant-row demand override was a
    second author of it (§4 D286) — ignored, and named in the run log."""
    base = from_project_data(_mts_base())
    d = _mts_base()
    d.policies = {"node:Plant::p1": {"production": {"demand_mean": 999.0, "demand_cv": 0.9}}}
    res = from_project_data(d)
    a, b = base.scenario.network.products[0], res.scenario.network.products[0]
    assert a.model_dump() == b.model_dump()
    assert {w.field for w in res.warnings if "no longer read" in w.reason} == {"demand_mean", "demand_cv"}
    assert res.resolved["products.demand_mean"]["p1"]["source"] == "master"


def test_a_plant_row_makes_an_mto_product_hold_fg_stock():
    """The Plant row's MTS / MTO beats the master, and its FG levels then reach."""
    d = _base()
    d.products = [ProductRow(id="p1", sell_price=20.0, demand_mean=100.0,
                             production_capacity=200.0, fulfillment_mode="mto",
                             fg_base_stock=300.0)]
    d.policies = {"node:Plant::p1": {"production": {"fulfillment_mode": "mts"}}}
    res = from_project_data(d)
    p = res.scenario.network.products[0]
    assert (p.fulfillment_mode.value, p.fg_base_stock) == ("mts", 300.0)
    assert res.resolved["products.fulfillment_mode"]["p1"] == {"source": "override", "value": "mts"}


def test_a_plant_row_makes_an_mts_product_build_to_order():
    res = from_project_data(_with_policies(_mts_base(fg_base_stock=300.0),
                                           {"node:Plant::p1": {"production": {"fulfillment_mode": "mto"}}}))
    p = res.scenario.network.products[0]
    assert (p.fulfillment_mode.value, p.fg_base_stock) == ("mto", None)


def test_an_unset_row_keeps_the_master_then_the_project_model():
    res = from_project_data(_mts_base())
    assert res.resolved["products.fulfillment_mode"]["p1"] == {"source": "master", "value": "mts"}
    d = _base()
    d.project_model = "Make-To-Stock"
    d.products[0].fulfillment_mode = None
    res = from_project_data(d)
    assert res.resolved["products.fulfillment_mode"]["p1"] == {"source": "default", "value": "mts"}
    # An unset row adds no run-log line (the log is unchanged for every project
    # that never touched the cell).
    assert not any(w.field == "products.fulfillment_mode" for w in res.warnings)


def test_an_unknown_mode_override_is_ignored_and_says_so():
    res = from_project_data(_with_policies(_mts_base(),
                                           {"node:Plant::p1": {"production": {"fulfillment_mode": "eto"}}}))
    assert res.scenario.network.products[0].fulfillment_mode.value == "mts"
    assert any(w.field == "fulfillment_mode" and "not mts or mto" in w.reason for w in res.warnings)


def _with_policies(d: ProjectData, policies: dict) -> ProjectData:
    d.policies = policies
    return d


def test_a_customer_row_no_longer_reaches_the_product():
    """WP 14.2 found `_composite_patches` sent any `node:<x>::<product>` key to the
    product; WP 14.4 closed it — a Customer row's patch is the row's own."""
    d = _base()
    d.policies = {"node:c1::p1": {"production": {"sell_price": 999.0}}}
    assert from_project_data(d).scenario.network.products[0].unit_price == 20.0


# ── MRP (PLAN.md §24 WP 14.5, D284 a) ───────────────────────────────────────

def test_mrp_reaches_the_engine_as_the_project_type_and_per_material():
    d = _base()
    d.policies = {"default": {"inventory": {"type": "mrp"}}}
    assert from_project_data(d).scenario.policies["inventory_control"]["policy_type"] == "mrp"
    d.policies = {"node:s1::m1": {"inventory": {"type": "mrp"}}}
    pol = from_project_data(d).scenario.policies["inventory_control"]
    assert pol["policy_type"] == "min_max"
    assert pol["material_overrides"]["m1"]["policy_type"] == "mrp"


# ── A lane's lead-time SPREAD — PLAN.md §26 WP 16.2, §4 D299 / D302 ────────────
#
# Order, per part: the Supplier row → the lane's upload → (shape and CV only)
# the material → deterministic. A bounded shape's planning lead time is its
# bounds' mean (§26.2 rule 3).

def _link(res, sup, mat="m1"):
    return next(l for l in res.scenario.network.supplier_links
                if l.supplier_id == sup and l.material_id == mat)


def test_the_lane_upload_beats_the_material_and_only_for_that_lane():
    d = _two_lanes()
    d.materials[0].lead_time_dist, d.materials[0].lead_time_cv = "lognormal", 0.3
    d.supply_arcs[1].lead_time_dist, d.supply_arcs[1].lead_time_cv = "normal", 0.2
    res = from_project_data(d)
    a, b = _link(res, "s1"), _link(res, "s2")
    assert (a.lead_time_dist.value, a.lead_time_cv) == ("lognormal", 0.3)
    assert (b.lead_time_dist.value, b.lead_time_cv) == ("normal", 0.2)
    dist = res.resolved["inbound_logistics.lead_time_dist"]
    assert dist["s1::m1"] == {"source": "derived", "value": "lognormal"}
    assert dist["s2::m1"] == {"source": "master", "value": "normal"}


def test_the_supplier_row_beats_the_lane_upload():
    d = _two_lanes()
    d.supply_arcs[1].lead_time_dist, d.supply_arcs[1].lead_time_cv = "normal", 0.2
    d.policies = {"node:s2::m1": {"sourcing": {"lane_lead_time_dist": "gamma",
                                               "lane_lead_time_cv": 0.4}}}
    res = from_project_data(d)
    b = _link(res, "s2")
    assert (b.lead_time_dist.value, b.lead_time_cv) == ("gamma", 0.4)
    assert res.resolved["inbound_logistics.lead_time_cv"]["s2::m1"] == {"source": "override", "value": 0.4}
    assert _sources(res, "inbound_logistics.lead_time_dist")  # counted: a lane states one


def test_a_triangular_lane_plans_on_its_bounds_mean_and_converts_days():
    d = _two_lanes()
    arc = d.supply_arcs[1]
    arc.lead_time, arc.lead_time_unit = 28, "day"
    arc.lead_time_dist, arc.lead_time_min, arc.lead_time_mode, arc.lead_time_max = "triangular", 14, 21, 49
    res = from_project_data(d)
    b = _link(res, "s2")
    assert (b.lead_time_min_weeks, b.lead_time_mode_weeks, b.lead_time_max_weeks) == (2, 3, 7)
    assert b.lead_time_weeks == 4                       # (2 + 3 + 7) / 3
    assert res.resolved["inbound_logistics.lead_time"]["s2::m1"] == {"source": "derived", "value": 4}


def test_a_row_lead_time_is_not_read_on_a_bounded_lane_and_says_so():
    d = _two_lanes()
    d.policies = {"node:s2::m1": {"sourcing": {"lead_time_weeks": 9,
                                               "lane_lead_time_dist": "uniform",
                                               "lane_lead_time_min_weeks": 2, "lane_lead_time_max_weeks": 6}}}
    res = from_project_data(d)
    assert _link(res, "s2").lead_time_weeks == 4
    assert any(w.field == "lead_time_weeks" and "bounds' mean" in w.reason for w in res.warnings)


@pytest.mark.parametrize("patch, why", [
    ({"lane_lead_time_dist": "triangular", "lane_lead_time_min_weeks": 2, "lane_lead_time_max_weeks": 6},
     "needs min, mode and max"),
    ({"lane_lead_time_dist": "normal"}, "needs a CV"),
    ({"lane_lead_time_dist": "uniform", "lane_lead_time_min_weeks": 7, "lane_lead_time_max_weeks": 6},
     "needs min ≤ max"),
])
def test_a_shape_missing_a_parameter_runs_deterministic_with_a_warning(patch, why):
    d = _two_lanes()
    d.policies = {"node:s2::m1": {"sourcing": patch}}
    res = from_project_data(d)
    b = _link(res, "s2")
    assert b.lead_time_dist.value == "deterministic" and b.lead_time_weeks == 4
    assert any(w.field == "lead_time_dist" and why in w.reason for w in res.warnings)


def test_an_unknown_shape_on_the_row_is_ignored_with_a_warning():
    d = _two_lanes()
    d.policies = {"node:s2::m1": {"sourcing": {"lane_lead_time_dist": "weibull"}}}
    res = from_project_data(d)
    assert _link(res, "s2").lead_time_dist.value == "deterministic"
    assert any(w.field == "lane_lead_time_dist" and "weibull" in w.reason for w in res.warnings)


def test_a_material_cv_above_one_is_clamped_not_a_failed_run():
    # §4 D302: before Phase 16 this raised a ValidationError while the network was built.
    d = _base()
    d.materials[0].lead_time_dist, d.materials[0].lead_time_cv = "lognormal", 1.5
    res = from_project_data(d)
    assert _link(res, "s1").lead_time_cv == 1.0
    assert any(w.field == "lead_time_cv" and "D302" in w.reason for w in res.warnings)


def test_without_any_spread_the_run_log_is_unchanged():
    res = from_project_data(_two_lanes())
    assert not any(w.entity == "source" and w.field.startswith("inbound_logistics.lead_time_")
                   for w in res.warnings)
    assert all(l.lead_time_dist.value == "deterministic" for l in res.scenario.network.supplier_links)


# ── A product's production lead time — PLAN.md §26 WP 16.5, §4 D300 ───────────

def _prod(res):
    return res.scenario.network.products[0]


def test_a_product_that_states_no_production_lead_time_maps_as_before():
    res = from_project_data(_base())
    p = _prod(res)
    assert (p.production_lead_time_weeks, p.production_lead_time_dist.value) == (0, "deterministic")
    assert res.resolved["products.production_lead_time"]["p1"] == {"source": "default", "value": 0}
    assert not any(w.entity == "source" and w.field.startswith("products.production_lead_time")
                   for w in res.warnings)
    # …and the Product carries no new key, so it serializes exactly as before.
    assert "production_lead_time_weeks" not in _prod(res).model_dump(exclude_defaults=True)


def test_the_master_in_days_is_converted_and_the_plant_row_beats_it():
    d = _base()
    d.products[0].production_lead_time, d.products[0].production_lead_time_unit = 14, "day"
    res = from_project_data(d)
    assert _prod(res).production_lead_time_weeks == 2
    assert res.resolved["products.production_lead_time"]["p1"] == {"source": "master", "value": 2}
    d.policies = {"node:plant::p1": {"production": {"prod_lead_time_weeks": 3}}}
    res = from_project_data(d)
    assert _prod(res).production_lead_time_weeks == 3
    assert res.resolved["products.production_lead_time"]["p1"] == {"source": "override", "value": 3}


def test_a_bounded_production_lead_time_plans_on_its_mean():
    d = _base()
    d.policies = {"node:plant::p1": {"production": {
        "prod_lead_time_weeks": 9, "prod_lead_time_dist": "triangular",
        "prod_lead_time_min_weeks": 1, "prod_lead_time_mode_weeks": 2, "prod_lead_time_max_weeks": 6}}}
    res = from_project_data(d)
    p = _prod(res)
    assert p.production_lead_time_weeks == 3 and p.production_lead_time_dist.value == "triangular"
    assert res.resolved["products.production_lead_time"]["p1"] == {"source": "derived", "value": 3}
    assert any(w.field == "prod_lead_time_weeks" and "bounds' mean" in w.reason for w in res.warnings)


def test_a_production_shape_missing_its_cv_runs_deterministic_with_a_warning():
    d = _base()
    d.products[0].production_lead_time, d.products[0].production_lead_time_dist = 2, "gamma"
    res = from_project_data(d)
    p = _prod(res)
    assert p.production_lead_time_dist.value == "deterministic" and p.production_lead_time_weeks == 2
    assert any(w.field == "production_lead_time_dist" and "needs a CV" in w.reason for w in res.warnings)

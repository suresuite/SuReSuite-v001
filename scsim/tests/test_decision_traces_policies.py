"""Facet 11 decision traces, slice 2 — every implemented policy records
(scsim/core/decisions.py; ai-agents.md §9.6; blueprint §6.1).

For each implemented policy, one inspection run of a scenario built so the
policy actually decides, and three assertions:
  1. it records, and every record carries a code from ITS declared vocabulary
     (the closed-vocabulary rule — the registry publishes exactly that);
  2. the codes the scenario must exercise are present (the branch is driven);
  3. recording is BEHAVIOUR-NEUTRAL for that policy: log on vs log off gives
     byte-identical KPIs and series.
"""
from __future__ import annotations

import numpy as np
import pytest

from scsim import (
    BomLine,
    Customer,
    CustomerLink,
    DisruptionEvent,
    Material,
    Network,
    Product,
    Scenario,
    Supplier,
    SupplierLink,
)
from scsim.core.decisions import DecisionLog
from scsim.core.engine import run_scenario
from scsim.entities.enums import (
    DemandModel,
    EffectType,
    FulfillmentMode,
    TargetType,
    TraceVerbosity,
)
from scsim.io.registry_export import build_registry
from scsim.policies.registry import get_entry

from .conftest import (
    dual_source_network,
    make_settings,
    shared_material_network,
    single_chain_network,
)

OUTAGE = [DisruptionEvent(target_id="s1", start=20, duration=14)]
THROTTLE = [DisruptionEvent(
    target_type=TargetType.NODE_PLANT, target_id="plant",
    effect_type=EffectType.CAPACITY_REDUCTION, capacity_factor=0.4,
    start=20, duration=14,
)]
THIN_BUFFER = {"coverage_weeks": {"nominal": 2, "alert": 2, "crisis": 2}}


def _capacity_bound() -> Network:
    return Network(
        suppliers=[Supplier(id="s1")],
        materials=[Material(id="m1", cost=1.0)],
        products=[Product(id="p1", unit_price=10.0, demand_mode=100.0,
                          demand_model=DemandModel.DETERMINISTIC, production_capacity=80.0)],
        bom=[BomLine(product_id="p1", material_id="m1", rate=1.0)],
        supplier_links=[SupplierLink(supplier_id="s1", material_id="m1", cost=1.0,
                                     lead_time_weeks=1)],
    )


def _two_customers() -> Network:
    base = single_chain_network()
    return Network(
        suppliers=base.suppliers, materials=base.materials, products=base.products,
        bom=base.bom, supplier_links=base.supplier_links,
        customers=[Customer(id="key_account", segment="strategic", priority_weight=10.0),
                   Customer(id="spot_buyer", segment="spot", priority_weight=1.0)],
        customer_links=[CustomerLink(product_id="p1", customer_id="key_account", share=60.0),
                        CustomerLink(product_id="p1", customer_id="spot_buyer", share=40.0)],
    )


def _mts_stochastic() -> Network:
    return Network(
        suppliers=[Supplier(id="s1")],
        materials=[Material(id="m1", cost=2.0)],
        products=[Product(id="p1", unit_price=10.0, demand_mode=100.0,
                          demand_model=DemandModel.TRIANGULAR, production_capacity=200.0,
                          fulfillment_mode=FulfillmentMode.MTS)],
        bom=[BomLine(product_id="p1", material_id="m1", rate=1.0)],
        supplier_links=[SupplierLink(supplier_id="s1", material_id="m1", cost=2.0,
                                     lead_time_weeks=2)],
    )


# (policy under test, network, events, policies, extra settings, codes that must appear)
CASES = {
    "forward_visibility": (
        single_chain_network, [],
        {"forward_visibility": {}, "inventory_control": {"basis": "forward_visible"}}, {},
        {"horizon_from_settings"}),
    "early_warning_failover": (
        dual_source_network, OUTAGE,
        {"early_warning_failover": {"detection_lag_weeks": 0}, "backup_supplier": {}},
        {"detection_lag_weeks": 2}, {"lag_compressed"}),
    "short_term_capacity": (
        _capacity_bound, [], {"short_term_capacity": {"max_overtime_factor": 1.5}}, {},
        {"granted_revenue_positive"}),
    "expedited_shipments": (
        single_chain_network, OUTAGE, {"expedited_shipments": {}}, {},
        {"expedited_shortfall"}),
    "proactive_multi_sourcing": (
        dual_source_network, OUTAGE, {"proactive_multi_sourcing": {"rebalance_trigger": "disruption"}}, {},
        {"split_planned_shares", "split_rebalanced_around_disruption"}),
    "fg_safety_stock": (
        _mts_stochastic, [], {"fg_safety_stock": {}}, {}, {"buffer_service_level"}),
    "safety_stock_materials": (
        lambda: single_chain_network(deterministic=False), [],
        {"safety_stock_materials": {}}, {}, {"buffer_abc_xyz"}),
    "material_allocation": (
        shared_material_network, [DisruptionEvent(target_id="s1", start=30, duration=8)],
        {"material_allocation": {}}, dict(horizon=90, warmup_end=15, analysis_window=60),
        {"rationed_lp", "held_no_binding_material"}),
    "customer_allocation": (
        _two_customers, THROTTLE,
        {"customer_allocation": {"rule": "priority"}, "inventory_control": THIN_BUFFER}, {},
        {"short_priority"}),
    "unmet_demand_handling": (
        single_chain_network, OUTAGE, {"unmet_demand_handling": {"rule": "lost_sales"}}, {},
        {"unmet_lost_sales"}),
    "inventory_control": (
        single_chain_network, OUTAGE, {"inventory_control": {"policy_type": "min_max"}}, {},
        {"ordered_min_max"}),
}


def _scenario(name: str) -> Scenario:
    net, events, policies, kw, _ = CASES[name]
    return Scenario(name=name, network=net(), events=list(events), policies=policies,
                    settings=make_settings(model_seeds=1, trace_verbosity=TraceVerbosity.FULL_DEBUG,
                                           **kw))


def _implemented() -> list[str]:
    return sorted(p["id"] for p in build_registry()["policies"] if p["status"] == "implemented")


def test_every_implemented_policy_is_covered_here():
    """A new implemented policy must declare a vocabulary AND get a case."""
    assert set(_implemented()) == set(CASES) | {"backup_supplier"}
    for pid in _implemented():
        assert get_entry(pid).plugin_cls.rationale_codes, f"{pid} declares no rationale_codes"


@pytest.mark.parametrize("name", sorted(CASES))
def test_policy_records_its_declared_codes(name):
    recs = run_scenario(_scenario(name)).decision_trace["records"]
    vocab = get_entry(name).plugin_cls.rationale_codes
    mine = [r for r in recs if r["policy"] == name]
    assert mine, f"{name} recorded nothing in a scenario built for it to decide"
    for r in mine:
        assert r["rationale"] in vocab
        assert r["catalog_ref"] == get_entry(name).catalog_ref
        assert isinstance(r["node"], str) and r["node"]
        for v in list(r["inputs"].values()) + list(r["decision"].values()):
            assert v is None or isinstance(v, (bool, int, float, str)), (name, r)
    seen = {r["rationale"] for r in mine}
    missing = CASES[name][4] - seen
    assert not missing, f"{name}: expected codes not exercised: {sorted(missing)} (saw {sorted(seen)})"


@pytest.mark.parametrize("name", sorted(CASES))
def test_recording_is_behaviour_neutral_per_policy(name, monkeypatch):
    on = run_scenario(_scenario(name))
    monkeypatch.setattr(DecisionLog, "record", lambda self, **kw: None)
    off = run_scenario(_scenario(name))
    assert off.decision_trace["records"] == []
    for k in on.aggregates:
        assert np.array_equal(on.aggregates[k]["mean"], off.aggregates[k]["mean"], equal_nan=True), k
    assert on.fr_series.tobytes() == off.fr_series.tobytes()
    for k, v in on.extra_series.items():
        assert np.asarray(v).tobytes() == np.asarray(off.extra_series[k]).tobytes(), (name, k)


def test_a_no_lot_rop_q_names_the_declared_fallback():
    sc = _scenario("inventory_control")
    sc = sc.model_copy(update={"policies": {"inventory_control": {"policy_type": "rop_q"}}})
    recs = run_scenario(sc).decision_trace["records"]
    codes = {r["rationale"] for r in recs if r["policy"] == "inventory_control"}
    assert "ordered_rop_q_no_lot" in codes and "ordered_rop_q" not in codes


def test_backorder_rule_records_waiting_not_lost():
    sc = _scenario("unmet_demand_handling")
    sc = sc.model_copy(update={"policies": {"unmet_demand_handling": {"rule": "backorder"}}})
    recs = [r for r in run_scenario(sc).decision_trace["records"]
            if r["policy"] == "unmet_demand_handling"]
    assert recs and {r["rationale"] for r in recs} == {"unmet_backordered"}


def test_setup_decisions_record_once_at_week_zero():
    for name in ("forward_visibility", "early_warning_failover"):
        recs = [r for r in run_scenario(_scenario(name)).decision_trace["records"]
                if r["policy"] == name]
        assert len(recs) == 1 and recs[0]["week"] == 0 and recs[0]["node_kind"] == "network"


# ---------------------------------------------------------------- every branch
#
# One scenario per declared code the cases above do not already exercise, so
# every rationale code in every vocabulary is driven by some test
# (test_every_declared_code_is_driven checks the union).

def _sc(net, events=(), policies=None, **kw) -> Scenario:
    return Scenario(name="v", network=net, events=list(events), policies=policies or {},
                    settings=make_settings(model_seeds=1, trace_verbosity=TraceVerbosity.FULL_DEBUG,
                                           **kw))


def _priced(price: float) -> Network:
    base = single_chain_network()
    prod = base.products[0].model_copy(update={"unit_price": price})
    return base.model_copy(update={"products": [prod]})


def _typed_fg() -> Network:
    base = _mts_stochastic()
    prod = base.products[0].model_copy(update={"fg_base_stock": 150.0})
    return base.model_copy(update={"products": [prod]})


_CUT = [DisruptionEvent(target_id="s1", effect_type=EffectType.CAPACITY_REDUCTION,
                        capacity_factor=0.0, start=20, duration=10)]
_TWO_C = {"inventory_control": THIN_BUFFER}

VARIANTS = [
    ("forward_visibility", "horizon_from_params", lambda: _sc(
        single_chain_network(), policies={"forward_visibility": {"visibility_horizon": 20},
                                          "inventory_control": {"basis": "forward_visible"}})),
    ("early_warning_failover", "lag_not_compressed", lambda: _sc(
        dual_source_network(), OUTAGE, {"early_warning_failover": {"detection_lag_weeks": 2}},
        detection_lag_weeks=1)),
    ("short_term_capacity", "granted_during_disruption", lambda: _sc(
        _capacity_bound(), [DisruptionEvent(target_id="s1", start=20, duration=4)],
        {"short_term_capacity": {"activation": "always_during_disruption"}})),
    ("short_term_capacity", "held_premium_exceeds_gain", lambda: _sc(
        _capacity_bound().model_copy(update={"products": [
            _capacity_bound().products[0].model_copy(update={"unit_price": 0.0})]}),
        policies={"short_term_capacity": {}})),
    ("expedited_shipments", "held_value_below_premium", lambda: _sc(
        _priced(0.5), OUTAGE, {"expedited_shipments": {"premium_pct_of_cost": 50.0}})),
    ("expedited_shipments", "held_nothing_in_transit", lambda: _sc(
        single_chain_network(supplier_capacity=120.0), _CUT,
        {"expedited_shipments": {"decision": "always_during_disruption", "scope": "all"}})),
    ("fg_safety_stock", "buffer_fixed_days", lambda: _sc(
        _mts_stochastic(), policies={"fg_safety_stock": {"sizing": "fixed_days"}})),
    ("fg_safety_stock", "buffer_fixed_units", lambda: _sc(
        _mts_stochastic(), policies={"fg_safety_stock": {"sizing": "fixed_units", "fixed_units": 40}})),
    ("fg_safety_stock", "buffer_zero_typed_level", lambda: _sc(
        _typed_fg(), policies={"fg_safety_stock": {}})),
    ("safety_stock_materials", "buffer_king", lambda: _sc(
        single_chain_network(deterministic=False),
        policies={"safety_stock_materials": {"classification": "king"}})),
    ("safety_stock_materials", "buffer_uniform", lambda: _sc(
        single_chain_network(deterministic=False),
        policies={"safety_stock_materials": {"classification": "uniform"}})),
    ("safety_stock_materials", "buffer_fixed_days", lambda: _sc(
        single_chain_network(), policies={"safety_stock_materials": {"classification": "fixed_days"}})),
    ("safety_stock_materials", "buffer_material_days", lambda: _sc(
        single_chain_network(), policies={"safety_stock_materials": {
            "fixed_days_by_material": {"m1": 14.0}}})),
    ("safety_stock_materials", "buffer_window_raised", lambda: _sc(
        single_chain_network(), policies={"safety_stock_materials": {"windows": [
            {"material_id": "m1", "days": 14.0, "start_week": 15, "end_week": 25}]}})),
    ("safety_stock_materials", "buffer_zero_stated_level", lambda: _sc(
        single_chain_network(deterministic=False), policies={
            "safety_stock_materials": {},
            "inventory_control": {"material_overrides": {"m1": {"reorder_point": 300.0}}}})),
    ("material_allocation", "rationed_greedy", lambda: _sc(
        shared_material_network(), [DisruptionEvent(target_id="s1", start=30, duration=8)],
        {"material_allocation": {"solver": "greedy"}}, horizon=90, warmup_end=15,
        analysis_window=60)),
    ("customer_allocation", "short_fair_share", lambda: _sc(
        _two_customers(), THROTTLE, {"customer_allocation": {"rule": "proportional"}, **_TWO_C})),
    ("customer_allocation", "short_sla_tier", lambda: _sc(
        _two_customers(), THROTTLE, {"customer_allocation": {
            "rule": "sla_tier", "sla_tiers": {"strategic": 90.0}}, **_TWO_C})),
    ("customer_allocation", "short_revenue_max", lambda: _sc(
        _two_customers(), THROTTLE, {"customer_allocation": {
            "rule": "revenue_max", "row_price": {"key_account::p1": 12.0}}, **_TWO_C})),
    ("unmet_demand_handling", "unmet_partially_backordered", lambda: _sc(
        single_chain_network(), OUTAGE, {"unmet_demand_handling": {"rule": "partial_backorder"}})),
    ("inventory_control", "ordered_base_stock", lambda: _sc(
        single_chain_network(), OUTAGE, {"inventory_control": {"policy_type": "base_stock"}})),
    ("inventory_control", "ordered_rop_q", lambda: _sc(
        single_chain_network(), OUTAGE, {"inventory_control": {
            "policy_type": "rop_q", "rop_q_quantity": 400.0}})),
    ("inventory_control", "ordered_periodic", lambda: _sc(
        single_chain_network(), OUTAGE, {"inventory_control": {
            "policy_type": "periodic", "periodic_review_weeks": 2}})),
    ("inventory_control", "ordered_mrp", lambda: _sc(
        single_chain_network(), OUTAGE, {"inventory_control": {"policy_type": "mrp"}})),
    ("inventory_control", "held_not_review_week", lambda: _sc(
        single_chain_network(), OUTAGE, {"inventory_control": {
            "policy_type": "min_max", "review_cadence_weeks": 4}})),
]


def _codes(sc: Scenario, policy: str) -> set[str]:
    return {r["rationale"] for r in run_scenario(sc).decision_trace["records"]
            if r["policy"] == policy}


@pytest.mark.parametrize("policy,code,build", VARIANTS, ids=[f"{p}:{c}" for p, c, _ in VARIANTS])
def test_variant_drives_its_code(policy, code, build):
    seen = _codes(build(), policy)
    assert code in seen, f"{policy}: expected {code}, saw {sorted(seen)}"


def test_lp_failure_records_the_greedy_fallback(monkeypatch):
    import scsim.policies.improvisation.p_p9_material_allocation as p9

    class _Failed:
        success = False
    monkeypatch.setattr(p9, "linprog", lambda *a, **k: _Failed())
    seen = _codes(_scenario("material_allocation"), "material_allocation")
    assert "rationed_greedy_lp_failed" in seen and "rationed_lp" not in seen


def test_every_declared_code_is_driven():
    """The union of codes the cases, variants and the named tests above
    require equals every declared vocabulary — a new code needs a test."""
    driven = {(n, c) for n, case in CASES.items() for c in case[4]}
    driven |= {(p, c) for p, c, _ in VARIANTS}
    driven |= {("inventory_control", "ordered_rop_q_no_lot"),
               ("unmet_demand_handling", "unmet_backordered"),
               ("material_allocation", "rationed_greedy_lp_failed")}
    declared = {(n, c) for n in CASES for c in get_entry(n).plugin_cls.rationale_codes}
    assert declared == driven, sorted(declared ^ driven)

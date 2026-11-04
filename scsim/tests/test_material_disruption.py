# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""node:material disruption targets (PLAN.md §27 WP 17.1, §4 D311).

A material event is a full outage of every supply link of ONE material and of
nothing else: the material's suppliers keep shipping their other materials. A
supplier event stops everything the supplier ships. Where the two coincide (a
supplier that ships one material, sole-sourced) they are the same event, and
the traces say so byte for byte.
"""
from __future__ import annotations

import numpy as np
import pytest

from scsim import BomLine, DisruptionEvent, Material, Network, Product, Scenario, Supplier, SupplierLink
from scsim.core.engine import compile_scenario, run_replication, run_scenario
from scsim.disruption.injector import DisruptionCompileError, resolve_events
from scsim.entities.enums import DemandModel, EffectType, TargetType
from scsim.io.traces import trace_frame

from .conftest import dual_source_network, make_settings, single_chain_network


def scenario(net: Network, events=None, policies=None, **kw) -> Scenario:
    return Scenario(name="t", network=net, settings=make_settings(**kw),
                    events=events or [], policies=policies or {})


def mat_event(mid: str, *, start=20, duration=8) -> DisruptionEvent:
    return DisruptionEvent(target_type=TargetType.NODE_MATERIAL, target_id=mid,
                           start=start, duration=duration)


def two_chain_network() -> Network:
    """One supplier, two sole-sourced materials, each feeding its own product.
    The products' prices differ, so the two materials' losses can be told apart."""
    return Network(
        suppliers=[Supplier(id="s1")],
        materials=[Material(id="m1", cost=2.0), Material(id="m2", cost=2.0)],
        products=[
            Product(id="p1", unit_price=10.0, demand_mode=100.0,
                    demand_model=DemandModel.DETERMINISTIC, production_capacity=200.0),
            Product(id="p2", unit_price=50.0, demand_mode=100.0,
                    demand_model=DemandModel.DETERMINISTIC, production_capacity=200.0),
        ],
        bom=[BomLine(product_id="p1", material_id="m1", rate=1.0),
             BomLine(product_id="p2", material_id="m2", rate=1.0)],
        supplier_links=[
            SupplierLink(supplier_id="s1", material_id="m1", cost=2.0, lead_time_weeks=2),
            SupplierLink(supplier_id="s1", material_id="m2", cost=2.0, lead_time_weeks=2),
        ],
    )


def lost(res) -> float:
    return float(res.aggregates["lost_sales_value"]["mean"])


def test_material_outage_equals_the_supplier_outage_it_coincides_with():
    """single_chain: s1 ships only m1, and m1 has only s1 — the two events are
    one event, so every trace column is byte-identical."""
    sup = scenario(single_chain_network(), [DisruptionEvent(target_id="s1", start=20, duration=8)])
    mat = scenario(single_chain_network(), [mat_event("m1")])
    cs, cm = compile_scenario(sup), compile_scenario(mat)
    ts = trace_frame(run_replication(cs, 0, 0, resolve_events(cs.model, 10, 0)))
    tm = trace_frame(run_replication(cm, 0, 0, resolve_events(cm.model, 10, 0)))
    for key in ts:
        assert ts[key].tobytes() == tm[key].tobytes(), f"column {key} differs"


def test_material_outage_stops_that_material_only():
    """Two independent chains behind one supplier: the supplier outage loses both
    products; each material outage loses only its own, and the two add up."""
    base = run_scenario(scenario(two_chain_network()))
    # 14 weeks: long enough to outlast the default material cover.
    sup = run_scenario(scenario(two_chain_network(),
                                [DisruptionEvent(target_id="s1", start=20, duration=14)]))
    m1 = run_scenario(scenario(two_chain_network(), [mat_event("m1", duration=14)]))
    m2 = run_scenario(scenario(two_chain_network(), [mat_event("m2", duration=14)]))
    assert lost(base) == 0.0
    assert 0.0 < lost(m1) < lost(m2) < lost(sup)
    # p2 is five times p1's price on the same volume, and nothing is shared.
    assert lost(m2) == pytest.approx(5.0 * lost(m1))
    assert lost(sup) == pytest.approx(lost(m1) + lost(m2))


def test_material_outage_blocks_every_supplier_of_it():
    """dual_source: a material outage stops BOTH links of m1 — there is no healthy
    source to fail over to, so it loses more than an outage of the primary alone
    with a backup-supplier policy on."""
    pol = {"backup_supplier": {}}
    sup = run_scenario(scenario(dual_source_network(),
                                [DisruptionEvent(target_id="s1", start=20, duration=14)], pol))
    mat = run_scenario(scenario(dual_source_network(), [mat_event("m1", duration=14)], pol))
    assert lost(mat) > lost(sup)


def test_backup_policy_does_not_reroute_a_healthy_material():
    """A material event on m2 leaves s1's m1 link healthy, so P-S.1 must not
    reroute m1 to its backup — no backup premium is paid."""
    net = Network(
        suppliers=[Supplier(id="s1"), Supplier(id="s2")],
        materials=[Material(id="m1", cost=2.0), Material(id="m2", cost=2.0)],
        products=[Product(id="p1", unit_price=10.0, demand_mode=100.0,
                          demand_model=DemandModel.DETERMINISTIC, production_capacity=200.0)],
        bom=[BomLine(product_id="p1", material_id="m1", rate=1.0),
             BomLine(product_id="p1", material_id="m2", rate=1.0)],
        supplier_links=[
            SupplierLink(supplier_id="s1", material_id="m1", cost=2.0, lead_time_weeks=2),
            SupplierLink(supplier_id="s2", material_id="m1", cost=2.6, lead_time_weeks=2),
            SupplierLink(supplier_id="s1", material_id="m2", cost=2.0, lead_time_weeks=2),
        ],
    )
    pol = {"backup_supplier": {"cooldown_weeks": 0}}
    mat = run_scenario(scenario(net, [mat_event("m2")], pol))
    sup = run_scenario(scenario(net, [DisruptionEvent(target_id="s1", start=20, duration=8)], pol))
    assert mat.aggregates["cost_backup_premium"]["mean"] == 0.0
    assert sup.aggregates["cost_backup_premium"]["mean"] > 0.0


def test_overlapping_supplier_and_material_events_compose_to_the_later_end():
    """Same link blocked twice: the later window end wins (max severity)."""
    short_sup = DisruptionEvent(target_id="s1", start=20, duration=4)
    long_mat = mat_event("m1", start=20, duration=8)
    both = run_scenario(scenario(single_chain_network(), [short_sup, long_mat]))
    long_alone = run_scenario(scenario(single_chain_network(), [long_mat]))
    assert lost(both) == pytest.approx(lost(long_alone))


def test_no_material_event_leaves_the_link_state_inert():
    ctx = run_replication(compile_scenario(scenario(two_chain_network())), 0, 0, [])
    assert not ctx.link_lt_block_end.any()


def test_material_target_validation():
    with pytest.raises(DisruptionCompileError, match="unknown material"):
        compile_scenario(scenario(single_chain_network(), [mat_event("nope")]))
    # A sub-assembly is a PRODUCT in the engine, so naming one as a material is an
    # unknown material — the only targets are suppliers and the materials they supply.
    with pytest.raises(DisruptionCompileError, match="unknown material"):
        compile_scenario(scenario(single_chain_network(), [mat_event("p1")]))
    # A capacity cut is per supplier; a material event is a full outage only.
    with pytest.raises(ValueError, match="lead_time_extension only"):
        DisruptionEvent(target_type=TargetType.NODE_MATERIAL, target_id="m1",
                        effect_type=EffectType.CAPACITY_REDUCTION, capacity_factor=0.5,
                        start=20, duration=4)


def test_material_events_do_not_mark_a_supplier_disrupted():
    sc = scenario(two_chain_network(), [mat_event("m1", start=20, duration=8)])
    cm = compile_scenario(sc)
    ctx = run_replication(cm, 0, 0, resolve_events(cm.model, 10, 0))
    # The run is over; step the clock back inside the window to read the views.
    ctx.week = 22
    assert not ctx.visible_disrupted_suppliers().any()
    links = ctx.visible_disrupted_links()
    assert links.tolist() == [bool(cm.model.link_mat[k] == cm.model.mat_index["m1"])
                              for k in range(cm.model.n_links)]
    assert np.count_nonzero(links) == 1


# ── PLAN.md §29 WP 19.1 — the platform's schedule reaches a material ─────────────
# `project_map._map_events` turns a scenario's `material:<id>` into the event above.

from scsim.io.project_map import _map_events  # noqa: E402


def _entry(target, *, start_day=140, duration_days=28, magnitude_pct=100):
    return {"target": target, "target_type": "node", "start_day": start_day,
            "duration_days": duration_days, "magnitude_pct": magnitude_pct}


def test_the_mapper_turns_a_material_target_into_a_material_event():
    w: list = []
    ev = _map_events([_entry("material:M1")], {"S1"}, {"S1": None}, w, mat_ids={"M1", "M2"})
    assert len(ev) == 1 and not w
    assert ev[0].target_type == TargetType.NODE_MATERIAL and ev[0].target_id == "M1"
    assert (ev[0].start, ev[0].duration) == (20, 4)
    assert ev[0].effect_type == EffectType.LEAD_TIME_EXTENSION


def test_a_partial_cut_on_a_material_runs_as_an_outage_and_says_so():
    w: list = []
    ev = _map_events([_entry("material:M1", magnitude_pct=50)], {"S1"}, {"S1": 100.0}, w, mat_ids={"M1"})
    assert len(ev) == 1 and ev[0].effect_type == EffectType.LEAD_TIME_EXTENSION
    assert any("full outage of its supply" in x.reason for x in w)


def test_an_unknown_or_unsupplied_material_is_skipped_with_its_reason():
    w: list = []
    assert _map_events([_entry("material:NOPE")], {"S1"}, {}, w, mat_ids={"M1"}) == []
    assert any("no supplied material named 'NOPE'" in x.reason for x in w)


def test_the_material_kind_is_no_longer_named_unsupported():
    from scsim.io import project_map as pm
    from scsim.io.registry_export import disruption_rule
    assert "material" not in pm.UNSUPPORTED_EVENT_KINDS
    rule = disruption_rule()
    assert "material" in rule["supported_target_kinds"] and rule["material_cut_runs_as_outage"] is True


def test_a_mapped_material_outage_stops_that_material_only_end_to_end():
    """Through the mapper's event: M1 stops for its weeks, M2 (same supplier) keeps arriving."""
    net = two_chain_network()
    m1, m2 = net.materials[0].id, net.materials[1].id
    w: list = []
    events = _map_events([_entry(f"material:{m1}", start_day=140, duration_days=98)],
                         {s.id for s in net.suppliers}, {}, w,
                         mat_ids={l.material_id for l in net.supplier_links})
    assert not w
    assert lost(run_scenario(scenario(net, events=events))) > lost(run_scenario(scenario(net)))

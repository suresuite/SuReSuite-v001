"""Facet 11 decision traces (scsim/core/decisions.py; blueprint §6.1, ai-agents.md §5.5).

Four properties, each the reason the feature can exist at all:
  1. present on a single-replication inspection run, absent on any other run;
  2. BEHAVIOUR-NEUTRAL — recording on/off gives byte-identical KPIs and series;
  3. a closed vocabulary — a record carries only a code its policy declared,
     and the registry publishes exactly that vocabulary;
  4. the records say what happened — P-S.1's reroutes during an outage, with
     the backup it chose, and nothing for a week it did not decide.
"""
from __future__ import annotations

import numpy as np
import pytest

from scsim import DisruptionEvent, Scenario
from scsim.core import decisions as decisions_mod
from scsim.core.decisions import DecisionLog
from scsim.core.engine import run_scenario
from scsim.entities.enums import TraceVerbosity
from scsim.io.registry_export import build_registry
from scsim.policies.strategic.p_s1_backup_supplier import BackupSupplier

from .conftest import dual_source_network, make_settings

OUTAGE = DisruptionEvent(target_id="s1", start=20, duration=14)


def _scenario(*, inspection: bool, policies=None) -> Scenario:
    kw = dict(model_seeds=1, trace_verbosity=TraceVerbosity.FULL_DEBUG) if inspection else {}
    return Scenario(name="dt", network=dual_source_network(), settings=make_settings(**kw),
                    events=[OUTAGE], policies=policies if policies is not None else {"backup_supplier": {}})


def test_trace_present_on_inspection_run_only():
    assert run_scenario(_scenario(inspection=False)).decision_trace is None
    tr = run_scenario(_scenario(inspection=True)).decision_trace
    assert tr is not None and tr["dropped"] == 0 and tr["records"]


def test_recording_is_behaviour_neutral(monkeypatch):
    on = run_scenario(_scenario(inspection=True))
    monkeypatch.setattr(DecisionLog, "record", lambda self, **kw: None)
    off = run_scenario(_scenario(inspection=True))
    assert off.decision_trace == {"records": [], "dropped": 0,
                                  "max_records": decisions_mod.MAX_RECORDS}
    for k in on.aggregates:
        assert np.array_equal(on.aggregates[k]["mean"], off.aggregates[k]["mean"], equal_nan=True), k
    assert on.fr_series.tobytes() == off.fr_series.tobytes()
    for k, v in on.extra_series.items():
        assert np.asarray(v).tobytes() == np.asarray(off.extra_series[k]).tobytes(), k


def test_backup_supplier_records_the_outage_reroutes():
    recs = run_scenario(_scenario(inspection=True)).decision_trace["records"]
    assert {r["policy"] for r in recs} == {"backup_supplier"}
    for r in recs:
        assert r["catalog_ref"] == "P-S.1" and r["node_kind"] == "material" and r["node"] == "m1"
        assert r["rationale"] in BackupSupplier.rationale_codes
        assert set(r) == {"week", "policy", "catalog_ref", "node_kind", "node",
                          "rationale", "inputs", "decision"}
    rerouted = [r for r in recs if r["decision"]["rerouted"]]
    assert rerouted, "an outage of the primary must reroute at least one order"
    for r in rerouted:
        assert r["decision"]["backup_supplier"] == "s2"
        assert r["inputs"]["primary_supplier"] == "s1"
        assert r["decision"]["qty"] > 0
    # The policy only decides while the firm sees the outage (or in cooldown,
    # default 0): every record falls inside the outage weeks or after detection.
    assert min(r["week"] for r in recs) >= OUTAGE.start
    assert max(r["week"] for r in recs) < OUTAGE.start + OUTAGE.duration + 8


def test_no_policy_means_no_records():
    tr = run_scenario(_scenario(inspection=True, policies={})).decision_trace
    assert tr["records"] == []


def test_an_undeclared_rationale_is_refused():
    log = DecisionLog(enabled=True)
    with pytest.raises(ValueError, match="closed vocabulary"):
        log.record(week=1, policy_id="x", catalog_ref="P-X.0", declared={"a": "A"},
                   rationale="b", node_kind="material", node="m1")
    DecisionLog(enabled=False).record(week=1, policy_id="x", catalog_ref="P-X.0", declared={},
                                      rationale="anything", node_kind="m", node="n")  # off ⇒ no check


def test_the_log_caps_and_counts_what_it_drops(monkeypatch):
    monkeypatch.setattr(decisions_mod, "MAX_RECORDS", 2)
    log = DecisionLog(enabled=True)
    for w in range(5):
        log.record(week=w, policy_id="x", catalog_ref="P-X.0", declared={"a": "A"},
                   rationale="a", node_kind="m", node="n")
    out = log.export()
    assert len(out["records"]) == 2 and out["dropped"] == 3


def test_registry_publishes_each_policys_rationale_vocabulary():
    reg = {p["id"]: p for p in build_registry()["policies"]}
    assert reg["backup_supplier"]["rationale_codes"] == BackupSupplier.rationale_codes
    assert all("rationale_codes" in p for p in reg.values())

# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""The ``/scsim/registry`` payload — Part IX §9.6.

Pydantic is canonical: this module renders the policy catalog (all 21,
implemented + planned), each Params JSON Schema with units/ranges/defaults,
the pipeline schema, the KPI dictionary, and the entity variable dictionary
into one JSON document. The frontend renders forms from this ONLY (no
hard-coded policies); Zod/Supabase validators are code-generated from the
same schemas; the MkDocs catalog pages are generated from it too
(scripts/gen_docs.py) — so docs cannot drift from code (Docs CI gate).
"""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

from scsim.io import project_map as pm

from scsim import ENGINE_VERSION
from scsim.core.phases import pipeline_schema
from scsim.entities.config import SimulationSettings
from scsim.entities.disruption import DisruptionEvent
from scsim.entities.network import (
    BomLine,
    Customer,
    Lane,
    Material,
    Product,
    Supplier,
    SupplierLink,
)
from scsim.io.project_map import POLICY_BUNDLE_KEYS, base_data_requirements
from scsim.kpi.definitions import KPI_DICTIONARY
from scsim.policies.registry import catalog
from scsim.stress import battery as stress_battery
from scsim.stress.nexus import NEXUS_SCENARIO, nexus_scenario_hash

# The engine author's implemented/planned shorthand in ST_DEFINITIONS, with the
# whitespace in front of it so a strip cannot leave "(manuscript )" behind.
_GLYPH = re.compile("\\s*[\u2705\u274c\ufe0f]+")

ENTITY_MODELS: dict[str, type[BaseModel]] = {
    "simulation_settings": SimulationSettings,
    "supplier": Supplier,
    "supplier_link": SupplierLink,
    "material": Material,
    "bom_line": BomLine,
    "product": Product,
    "customer": Customer,
    "lane": Lane,
    "disruption_event": DisruptionEvent,
}


def stress_tests() -> list[dict[str, Any]]:
    """The stress battery as a DECLARATION — §4 D106.

    ``ST_DEFINITIONS`` in ``scsim/stress/battery.py`` is the engine's own
    catalog of ST-1…ST-7 and it was reachable only by a text scan over the
    Python literal: §4 D90's weakest door, and the archived manual had already
    drifted from it (it carried a ``status`` column for all seven that the engine
    does not). §3 and blueprint §6.2 make this module the single source of truth
    for what the engine declares, so the battery belongs here.

    ``entrypoint`` is resolved by ``getattr`` at import time rather than parsed
    out of a call site: the fact a consumer needs is "is there a callable that
    runs this cell", and Python answering that is stronger evidence than any
    scan of ``_run_battery(…, "ST-n", …)``. It is the module's PUBLIC name, so a
    consumer can also say WHERE the battery lives — it is a ``scsim`` library
    API and not a product surface (§4 D111), and a declaration that hands over
    the import path lets the page state that from data instead of asserting it.
    """
    out: list[dict[str, Any]] = []
    for test_id, description in stress_battery.ST_DEFINITIONS.items():
        fn = f"run_st{test_id.removeprefix('ST-')}"
        callable_ = getattr(stress_battery, fn, None)
        out.append({
            "id": test_id,
            # The author's implemented/planned glyph is stripped: `entrypoint`
            # carries that fact from a callable rather than from a glyph, and this
            # string is product copy the moment a page renders it (§3.5 forbids
            # emoji there). The mathematical marks (×, Δ, φ, ∩) stay — they are
            # notation, not decoration.
            "description": _GLYPH.sub("", description).strip(),
            "entrypoint": f"scsim.stress.{fn}" if callable(callable_) else None,
        })
    return out


def _run_window_examples() -> list[dict[str, Any]]:
    """Cases computed BY THE MAPPER, so the UI's arithmetic is pinned to it.

    ``runWindow.test.ts`` asserts the browser reproduces every row; a TS rule
    that drifted from ``_build_settings`` / ``_map_events`` fails there.
    ``measured_weeks`` is ``min(t_w + window, horizon) − t_w`` — the engine's
    ``window_end`` — and is known before the run only for a MANUAL warm-up.
    """
    rows: list[dict[str, Any]] = []
    for horizon_days, mode, warmup_days in (
        (1092, "manual", 105), (1092, "auto", 105), (364, "manual", 70),
        (200, "manual", 0), (455, "manual", 210), (4000, "manual", 105),
        (3000, "auto", 0), (500, "manual", 400),
    ):
        st = pm._build_settings(pm.ScenarioSettings(
            horizon_days=horizon_days, warmup_mode=mode, warmup_days=warmup_days), [])
        t_w = int(st.warmup_end) if mode == "manual" else None
        rows.append({
            "horizon_days": horizon_days, "warmup_mode": mode, "warmup_days": warmup_days,
            "horizon_weeks": st.horizon, "analysis_window_weeks": st.analysis_window,
            "warmup_weeks": t_w,
            "measured_weeks": (min(t_w + st.analysis_window, st.horizon) - t_w)
            if t_w is not None else None,
        })
    return rows


def _disruption_examples() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for start_day, duration_days in ((10, 5), (0, 3), (3, 10), (17, 11), (140, 400), (700, 30)):
        [ev] = pm._map_events([{"target": "supplier:s", "start_day": start_day,
                                "duration_days": duration_days}], {"s"}, {"s": None}, [])
        rows.append({"start_day": start_day, "duration_days": duration_days,
                     "start_week": ev.start, "duration_weeks": ev.duration})
    return rows


def run_window_rule() -> dict[str, Any]:
    """The constants ``project_map.analysis_window_weeks`` applies, verbatim."""
    return {
        "examples": _run_window_examples(),
        "disruption_examples": _disruption_examples(),
        "days_per_tick": 7,
        "horizon_weeks_floor": pm.HORIZON_WEEKS_FLOOR,
        "horizon_weeks_ceiling": pm.HORIZON_WEEKS_CEILING,
        "analysis_window_weeks": pm.ANALYSIS_WINDOW_WEEKS,
        "analysis_window_min_weeks": pm.ANALYSIS_WINDOW_MIN_WEEKS,
        "analysis_window_max_weeks": pm.ANALYSIS_WINDOW_MAX_WEEKS,
        "analysis_window_tail_weeks": pm.ANALYSIS_WINDOW_TAIL_WEEKS,
    }


def backorder_rule() -> dict[str, Any]:
    """``project_map._backorder_weeks`` — max backorder days → whole weeks,
    rounded half up and clamped (PLAN.md §24 WP 14.3). The Customer table shows
    each row's window in the weeks the engine will use; ``backorderWeeks.test.ts``
    holds the browser's copy to the examples below, computed BY the mapper."""
    return {
        "days_per_week": 7,
        "rounding": "half_up",
        "min_weeks": 0,
        "max_weeks": 26,
        "examples": [
            {"days": d, "weeks": pm._backorder_weeks(d, w=[], entity="example")}
            for d in (0, 3, 3.5, 4, 10, 10.5, 11, 14, 200)
        ],
    }


def disruption_rule() -> dict[str, Any]:
    """What ``project_map._map_events`` keeps, verbatim (WP 9.4, PLAN.md §4 D226).

    The Lab's event editor, the network pages' disruption dialog and the pre-run
    gate read this instead of restating the cap, the week bounds or the target
    kinds; ``disruptionEvents.test.ts`` checks the browser's reading of it.
    """
    return {
        "event_cap": pm.EVENT_CAP,
        "start_week_min": pm.EVENT_START_WEEK_MIN,
        "duration_weeks_min": pm.EVENT_DURATION_WEEKS_MIN,
        "duration_weeks_max": pm.EVENT_DURATION_WEEKS_MAX,
        # A supplier id of the project, the plant (`plant`, `plant:<x>`, `node:plant`),
        # or a supplied material (`material:<id>`, since 0.9.0).
        "supported_target_kinds": ["supplier", "plant", pm.MATERIAL_EVENT_KIND],
        "unsupported_target_kinds": list(pm.UNSUPPORTED_EVENT_KINDS),
        # magnitude_pct < 100 is a capacity cut BY that share; 100 is a full outage.
        # A partial cut on a supplier with no finite capacity becomes a full outage.
        "full_outage_pct": 100,
        "partial_cut_needs_finite_supplier_capacity": True,
        # A material event stops every supply link of that material; a magnitude
        # below 100 on it runs as that full outage (the cut is per supplier).
        "material_cut_runs_as_outage": True,
    }


def build_registry() -> dict[str, Any]:
    policies = []
    for entry in catalog():
        plugin_hooks = []
        if entry.plugin_cls is not None:
            proto = entry.plugin_cls(entry.params_model())
            plugin_hooks = [
                {
                    "phase": h.phase.value,
                    "priority": h.priority,
                    "reads": sorted(h.reads),
                    "writes": sorted(h.writes),
                    "resolution": h.resolution,
                }
                for h in proto.hooks
            ]
        policies.append({
            "id": entry.id,
            "catalog_ref": entry.catalog_ref,
            "stage": entry.stage.value,
            "strategy_class": entry.strategy_class.value,
            "constraint_targeted":
                entry.constraint_targeted.value if entry.constraint_targeted else None,
            "requires_predeployment": entry.requires_predeployment,
            "status": entry.status.value,
            "milestone": entry.milestone or None,
            "summary": entry.summary,
            "hooks": plugin_hooks,
            "params_schema": entry.params_model.model_json_schema(),
            "data_requirements": [r.as_dict() for r in entry.data_requirements],
        })
    return {
        "engine_version": ENGINE_VERSION,
        "policies": policies,
        # §8.1 — entity fields the always-on engine mechanics read (world model,
        # economics), with project_map.py's fallback chains. The per-policy
        # counterpart is each policy's "data_requirements".
        "base_data_requirements": [r.as_dict() for r in base_data_requirements()],
        # Part VI — the stress battery, declared rather than scanned (§4 D106).
        "stress_tests": stress_tests(),
        # §4 D90 — the POLICY-BUNDLE keys the mapper reads, and what each one
        # feeds. The third of WP 6.1's three doors to the engine, and the only one
        # that was a text scan over a Python file rather than a declaration.
        # Authored in `project_map.py` beside the code that performs the mapping,
        # for the same reason `base_data_requirements` is: the declaration and the
        # reader drift the moment they live apart.
        "policy_bundle_keys": [dict(k) for k in POLICY_BUNDLE_KEYS],
        # Audit 2026-09-22, F-02 — the weeks the engine MEASURES after warm-up.
        # The Run-window card printed `horizon − warm-up` as measured while the
        # engine measured a fixed window; the card now reads this, so the rule
        # has one author (`project_map.analysis_window_weeks`).
        "run_window": run_window_rule(),
        "backorder": backorder_rule(),
        "disruption": disruption_rule(),
        # PLAN.md §27 WP 17.2 — the nexus battery's ONE shared scenario (§27.2
        # rule 1): the card, the store's key and the manual read it from here.
        "nexus_scenario": {**NEXUS_SCENARIO, "hash": nexus_scenario_hash()},
        "pipeline": pipeline_schema(),
        "kpis": [
            {"name": k.name, "symbol": k.symbol, "definition": k.definition, "unit": k.unit}
            for k in KPI_DICTIONARY
        ],
        "entities": {
            name: model.model_json_schema() for name, model in ENTITY_MODELS.items()
        },
    }


def registry_json(indent: int = 2) -> str:
    return json.dumps(build_registry(), indent=indent, sort_keys=True)


if __name__ == "__main__":
    # `python -m scsim.io.registry_export > registry.json` — the /scsim/registry
    # payload for the frontend forms and the Zod/Supabase validator codegen.
    print(registry_json())

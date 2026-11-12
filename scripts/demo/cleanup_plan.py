#!/usr/bin/env python3
"""Resolve the demo clean-up to full ids, verifying every name first. Writes plan.json.

NOTHING IS GUESSED: each entry names an id PREFIX and the exact name or label it must
carry; a mismatch, or a prefix matching 0 or 2 rows, stops the run before anything is
touched. Read-only (SELECT through the Management API).

The clean-up (2026-11-12, owner's instruction: keep only the latest Validated Model and
remove the prior scenario data):
  small demo   revoke the older Validated Model (2026Q4), delete the three earlier
               52-week scenarios (their runs go with them) and the policy version that
               only they used.
  large demo   delete the three earlier 52-week scenarios.
KEPT: every "…2026" scenario and its runs, the validation scenario and both validation
runs, both policy versions the 2026 runs use, policy v1 (the revoked model's card
still names it — delete_policy_version refuses a referenced version), every data version.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nexus"))
from nexus_job import lit, sql  # noqa: E402

SMALL = "Demo — Control Unit Supply Network"
LARGE = "Demo — Large Network (100 products, 500 suppliers)"
SPEC = {
    SMALL: {
        "revoke_models": [("a8b723e3", "Baseline policies")],
        "delete_scenarios": [("6782fc27", "Normal year"),
                             ("98abf6bc", "Microcontroller supplier outage (6 weeks)"),
                             ("f101358b", "Plant shutdown (3 weeks)")],
        "delete_policy_versions": [("634cc56f", "Safety stock 28 days")],
    },
    LARGE: {
        "revoke_models": [],
        "delete_scenarios": [("0ae56b96", "Normal year"),
                             ("dd25150d", "Sensor supplier outage (10 weeks)"),
                             ("f69fd4fc", "Plant shutdown (3 weeks)")],
        "delete_policy_versions": [],
    },
}
TABLE = {"revoke_models": ("model_validations", "name"),
         "delete_scenarios": ("scenarios", "name"),
         "delete_policy_versions": ("policy_versions", "label")}


def one(table: str, col: str, pid: str, prefix: str, expect: str) -> str:
    rows = sql(f"SELECT id::text AS id, {col} AS v FROM public.{table} "
               f"WHERE project_id = '{pid}' AND id::text LIKE {lit(prefix + '%')}")
    if len(rows) != 1:
        raise SystemExit(f"{table} {prefix}: {len(rows)} rows match, expected exactly 1")
    if rows[0]["v"] != expect:
        raise SystemExit(f"{table} {prefix} is named {rows[0]['v']!r}, expected {expect!r} — refusing")
    return rows[0]["id"]


plan = []
for pname, spec in SPEC.items():
    own = sql(f"""SELECT p.id::text AS pid, u.id::text AS uid, u.email FROM public.projects p
                    JOIN public.approved_users u ON u.id = p.modeler_id WHERE p.name = {lit(pname)}""")
    if len(own) != 1:
        raise SystemExit(f"{pname!r}: {len(own)} projects")
    pid = own[0]["pid"]
    entry = {"project": pname, "project_id": pid, "user_id": own[0]["uid"], "user_email": own[0]["email"]}
    for key, (table, col) in TABLE.items():
        entry[key] = [{"id": one(table, col, pid, pre, name), "name": name} for pre, name in spec[key]]
    # Safety: nothing deleted may be evidence for a Validated Model, or be the validation scenario.
    for s in entry["delete_scenarios"]:
        bad = sql(f"""SELECT 1 FROM public.scenarios s WHERE s.id = '{s['id']}' AND s.role <> 'experiment'
                      UNION ALL SELECT 1 FROM public.model_validations m
                       WHERE m.evidence_run_id IN (SELECT id FROM public.simulation_runs WHERE scenario_id = '{s['id']}')""")
        if bad:
            raise SystemExit(f"scenario {s['name']!r} is the validation scenario or holds a model's evidence run — refusing")
    plan.append(entry)
Path("plan.json").write_text(json.dumps(plan, indent=1))
for e in plan:
    print(f"{e['project']} (owner {e['user_email']})")
    for k in TABLE:
        for x in e[k]:
            print(f"   {k}: {x['name']}  {x['id']}")

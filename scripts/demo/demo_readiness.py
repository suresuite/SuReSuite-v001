#!/usr/bin/env python3
"""Demo readiness — what does each demo project hold, and what is missing?

READ-ONLY. Every statement is a SELECT (checked before it is sent). It reads,
for every project whose name starts with "Demo", the inputs /policies and the
Simulation Lab need: the masters and lanes, the derived lane table, policy
defaults/overrides/versions, data versions, scenarios, runs (by status, with
their last error), the Validated Model, and the network analyses. It then
names each gap in plain words.

Run by `.github/workflows/demo-readiness.yml` (push `.github/demo-readiness-request`),
which publishes the report to the `demo-readiness-results` branch. A session
cannot reach the database itself; CI can, with SUPABASE_ACCESS_TOKEN.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "nexus"))
from nexus_job import lit, sql as _sql  # noqa: E402  (the Management API route)

NAME_PREFIX = sys.argv[1] if len(sys.argv) > 1 else "Demo"
OUT: list[str] = []


def out(s: str = "") -> None:
    OUT.append(s)
    print(s)


def sql(q: str) -> list[dict]:
    if not re.match(r"^\s*(select|with)\b", q, re.I) or re.search(
            r"\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call)\b", q, re.I):
        raise SystemExit(f"refusing a non-SELECT statement: {q[:120]}")
    return _sql(q)


def safe(q: str):
    try:
        return sql(q), None
    except SystemExit as e:
        return None, str(e)[:400]


COUNT_TABLES = [
    "suppliers", "materials", "products", "customers", "demand_forecasts",
    "bom_multi_level", "bom_single_level", "inbound_logistics", "outbound_logistics",
    "supply_chain_data", "supply_chain_data_multi_tier", "node_list",
    "network_nodes", "network_edges", "policy_overrides", "policy_versions",
    "dataset_versions", "scenarios", "simulation_runs", "model_validations", "analysis_runs",
]

# Master columns /policies and the engine read; a NULL here is an empty cell.
NULL_CHECKS = {
    "materials": ["cost", "holding_cost_pct", "moq", "initial_on_hand", "lead_time_dist", "lead_time_cv"],
    "suppliers": ["capacity_per_week", "reliability_score"],
    "products": ["sell_price", "production_capacity", "demand_mean", "demand_cv",
                 "demand_distribution", "fulfillment_mode", "production_lead_time", "fg_policy"],
    "inbound_logistics": ["volume", "lead_time", "unit_price"],
    "outbound_logistics": ["volume", "expected_lead_time", "unit_price"],
}


def project_report(p: dict) -> list[str]:
    pid = p["id"]
    gaps: list[str] = []
    out(f"\n## {p['name']}\n")
    out(f"- id `{pid}` · model `{p.get('supply_chain_model')}` · bom_level `{p.get('bom_level')}` · "
        f"plant `{p.get('plant_name')}` · modeler `{p.get('modeler_email')}`")
    out(f"- simulation window: {p.get('simulation_start')} → {p.get('simulation_end')}")

    union = " UNION ALL ".join(
        f"SELECT '{t}' AS t, count(*)::int AS n FROM public.{t} WHERE project_id = '{pid}'"
        for t in COUNT_TABLES)
    rows, err = safe(union)
    counts = {}
    if err:  # one missing table/column must not hide the rest
        for t in COUNT_TABLES:
            r, e = safe(f"SELECT count(*)::int AS n FROM public.{t} WHERE project_id = '{pid}'")
            counts[t] = r[0]["n"] if r else f"error: {e[:120]}"
    else:
        counts = {r["t"]: r["n"] for r in rows}
    out("\n| table | rows |\n|---|---:|")
    for t in COUNT_TABLES:
        out(f"| {t} | {counts.get(t)} |")
    pd, _ = safe(f"SELECT count(*)::int AS n FROM public.policy_defaults WHERE project_id = '{pid}'")
    out(f"| policy_defaults | {pd[0]['n'] if pd else '?'} |")
    r, e = safe(f"SELECT fulfillment::text AS f, demand::text AS d FROM public.policy_defaults WHERE project_id = '{pid}'")
    out(f"\n**Fulfillment defaults (live):** `{r[0]['f'] if r else e}`")
    r, e = safe(f"SELECT version_no, label, left((snapshot->'defaults'->'fulfillment')::text, 600) AS f, "
                f"left((SELECT string_agg(k, ',') FROM jsonb_object_keys(snapshot) k), 300) AS keys "
                f"FROM public.policy_versions WHERE project_id = '{pid}' ORDER BY version_no")
    for x in r or []:
        out(f"- policy v{x['version_no']} {x['label']}: fulfillment `{x['f']}` · snapshot keys `{x['keys']}`")

    out("\n**Empty master cells (NULL count / rows)**\n")
    for t, cols in NULL_CHECKS.items():
        expr = ", ".join(f"count(*) FILTER (WHERE {c} IS NULL)::int AS {c}" for c in cols)
        r, e = safe(f"SELECT count(*)::int AS total, {expr} FROM public.{t} WHERE project_id = '{pid}'")
        if e:
            out(f"- {t}: could not read ({e[:160]})")
            continue
        r = r[0]
        nulls = {c: r[c] for c in cols if r[c]}
        out(f"- {t} ({r['total']} rows): " + (", ".join(f"`{c}` {n}" for c, n in nulls.items()) or "no empty cells"))
        if nulls and r["total"]:
            gaps.append(f"{t} has empty {', '.join(nulls)}")

    r, _ = safe(f"SELECT status, count(*)::int AS n, max(created_at)::text AS last FROM public.simulation_runs "
                f"WHERE project_id = '{pid}' GROUP BY status ORDER BY 2 DESC")
    out("\n**Runs by status:** " + (", ".join(f"{x['status']} {x['n']} (last {x['last'][:19]})" for x in r) if r else "none"))
    r, _ = safe(f"SELECT status, left(coalesce(error_message,''), 300) AS err, created_at::text AS at "
                f"FROM public.simulation_runs WHERE project_id = '{pid}' AND error_message IS NOT NULL "
                f"ORDER BY created_at DESC LIMIT 3")
    for x in r or []:
        out(f"  - {x['at'][:19]} {x['status']}: {x['err']}")
    # What the finished runs actually hold — an empty KPI block is "no value" on the page.
    r, e = safe(f"""SELECT r.created_at::text AS at, s.name AS scenario, pv.label AS policy,
                           r.rep_count_done, r.rep_count_target, r.code_version,
                           left(coalesce((r.aggregate_kpis - '_meta' - '_range')::text, 'NULL'), 1500) AS kpis,
                           r.series_object IS NOT NULL AS has_series, r.series_expired_at::text AS series_expired, r.retention,
                           left(coalesce(r.mapping_warnings::text, 'NULL'), 2500) AS warnings
                      FROM public.simulation_runs r
                      LEFT JOIN public.scenarios s ON s.id = r.scenario_id
                      LEFT JOIN public.policy_versions pv ON pv.id = r.policy_version_id
                     WHERE r.project_id = '{pid}' ORDER BY r.created_at DESC LIMIT 8""")
    if e:
        out(f"  (run detail unreadable: {e[:200]})")
    for x in r or []:
        out(f"\n- run {x['at'][:19]} · {x['scenario']} · {x['policy']} · reps {x['rep_count_done']}/{x['rep_count_target']} · {x['code_version']} · series {'stored' if x['has_series'] else 'NONE'}{' (expired ' + x['series_expired'][:10] + ')' if x['series_expired'] else ''} · {x['retention']}")
        out(f"  - kpis: `{x['kpis']}`")
        out(f"  - mapping warnings: `{x['warnings']}`")
    r, e = safe(f"""SELECT count(*)::int AS n FROM public.run_replications rr
                      JOIN public.simulation_runs r ON r.id = rr.run_id WHERE r.project_id = '{pid}'""")
    out(f"\n**Replication rows:** {r[0]['n'] if r else e}")
    r, e = safe(f"""SELECT count(*)::int AS n FROM public.run_item_series ri
                      JOIN public.simulation_runs r ON r.id = ri.run_id WHERE r.project_id = '{pid}'""")
    out(f"**Item series rows:** {r[0]['n'] if r else e}")
    r, _ = safe(f"SELECT name, role, horizon_days, replications, jsonb_array_length(coalesce(disruption_schedule,'[]'::jsonb)) AS events "
                f"FROM public.scenarios WHERE project_id = '{pid}' ORDER BY created_at")
    out("\n**Scenarios:** " + ("; ".join(f"{x['name']} ({x['role']}, {x['horizon_days']} d, {x['replications']} reps, {x['events']} events)" for x in r) if r else "none"))
    r, _ = safe(f"SELECT version_no, label, created_at::text AS at FROM public.policy_versions WHERE project_id = '{pid}' ORDER BY version_no")
    out("**Policy versions:** " + ("; ".join(f"v{x['version_no']} {x['label'] or ''}" for x in r) if r else "none"))
    r, _ = safe(f"SELECT version_no, label FROM public.dataset_versions WHERE project_id = '{pid}' ORDER BY version_no")
    out("**Data versions:** " + ("; ".join(f"v{x['version_no']} {x['label'] or ''}" for x in r) if r else "none"))
    r, _ = safe(f"SELECT model_code, name, status, revoked_at::text AS revoked FROM public.model_validations "
                f"WHERE project_id = '{pid}' ORDER BY created_at")
    out("**Validated Models:** " + ("; ".join(f"{x['model_code']} {x['name'] or ''} [{x['status']}{' revoked' if x['revoked'] else ''}]" for x in r) if r else "none"))
    r, _ = safe(f"SELECT analysis_kind, status, count(*)::int AS n FROM public.analysis_runs WHERE project_id = '{pid}' "
                f"GROUP BY 1, 2 ORDER BY 1")
    out("**Network analyses:** " + (", ".join(f"{x['analysis_kind']} {x['status']} ×{x['n']}" for x in r) if r else "none"))

    def n(t):
        v = counts.get(t)
        return v if isinstance(v, int) else 0
    if n("inbound_logistics") and not n("supply_chain_data"):
        gaps.append("lanes are loaded but supply_chain_data is empty — the combine step never ran, so /policies has no rows")
    if not n("policy_versions"):
        gaps.append("no saved policy version — a run binds one")
    if not n("dataset_versions"):
        gaps.append("no data version (snapshot) — a run binds one")
    if not n("scenarios"):
        gaps.append("no scenario — the Lab has nothing to run")
    if not n("simulation_runs"):
        gaps.append("no simulation run — the Lab and /policies results are empty")
    if not n("model_validations"):
        gaps.append("no Validated Model — Run & Validate baseline never ran; the Nexus battery needs one")
    if not n("analysis_runs"):
        gaps.append("no network analysis run — centrality/criticality figures are empty")
    out("\n**Gaps:** " + ("\n" + "\n".join(f"- {g}" for g in gaps) if gaps else "none found"))
    return gaps


def export_snapshots(p: dict) -> None:
    """The project's frozen inputs, so a run can be replayed locally with
    `sim_worker.local.run_from_snapshots` (latest data version, every policy
    version, every scenario row). Skipped above 8 MB so the report stays small."""
    pid = p["id"]
    slug = re.sub(r"[^a-z0-9]+", "-", p["name"].lower()).strip("-")[:40]
    d = Path("snapshots") / slug
    size, _ = safe(f"SELECT pg_column_size(snapshot)::int AS b, version_no FROM public.dataset_versions "
                   f"WHERE project_id = '{pid}' ORDER BY version_no DESC LIMIT 1")
    if not size or size[0]["b"] > 8_000_000:
        out(f"\n_snapshots of {p['name']} not exported ({size[0]['b'] if size else 'none'} bytes)_")
        return
    d.mkdir(parents=True, exist_ok=True)
    ds, _ = safe(f"SELECT id::text, version_no, snapshot FROM public.dataset_versions WHERE project_id = '{pid}' "
                 f"ORDER BY version_no DESC LIMIT 1")
    (d / "dataset.json").write_text(json.dumps(ds[0], indent=1))
    pv, _ = safe(f"SELECT id::text, version_no, label, snapshot FROM public.policy_versions "
                 f"WHERE project_id = '{pid}' ORDER BY version_no")
    (d / "policy_versions.json").write_text(json.dumps(pv or [], indent=1))
    sc, _ = safe(f"SELECT to_jsonb(s) AS s FROM public.scenarios s WHERE project_id = '{pid}' ORDER BY created_at")
    (d / "scenarios.json").write_text(json.dumps([x["s"] for x in sc or []], indent=1))
    pd, _ = safe(f"SELECT to_jsonb(x) AS x FROM public.policy_defaults x WHERE project_id = '{pid}'")
    po, _ = safe(f"SELECT to_jsonb(x) AS x FROM public.policy_overrides x WHERE project_id = '{pid}'")
    (d / "live_policies.json").write_text(json.dumps({"defaults": [x["x"] for x in pd or []],
                                                      "overrides": [x["x"] for x in po or []]}, indent=1))
    out(f"\n_snapshots of {p['name']} exported to `{d}`_")


def inventory(p: dict) -> None:
    """Everything a clean-up would touch, with who references it — read-only."""
    pid = p["id"]
    out(f"\n### Inventory — {p['name']}\n")
    r, e = safe(f"""SELECT id::text, model_code, name, status, revoked_at::text AS revoked, superseded_by::text AS superseded_by,
                           policy_version_id::text AS pv, dataset_version_id::text AS dv, evidence_run_id::text AS ev,
                           (protocol->>'horizon_days') AS horizon, adopted_warmup_days, validated_at::text AS at
                      FROM public.model_validations WHERE project_id = '{pid}' ORDER BY created_at""")
    out("**Validated Models**")
    for x in r or []:
        out(f"- `{x['id'][:8]}` {x['model_code']} \"{x['name']}\" [{x['status']}{' revoked' if x['revoked'] else ''}] policy `{(x['pv'] or '')[:8]}` data `{(x['dv'] or '')[:8]}` evidence-run `{(x['ev'] or '')[:8]}` warm-up {x['adopted_warmup_days']} d horizon {x['horizon']} · {x['at']}")
    if e: out(f"  ({e[:200]})")
    r, e = safe(f"""SELECT s.id::text, s.name, s.role, s.horizon_days, s.created_at::text AS at,
                           (SELECT count(*)::int FROM public.simulation_runs r WHERE r.scenario_id = s.id) AS runs,
                           (SELECT count(*)::int FROM public.model_validations m WHERE m.evidence_run_id IN
                              (SELECT id FROM public.simulation_runs r WHERE r.scenario_id = s.id)) AS evidence_for_models
                      FROM public.scenarios s WHERE s.project_id = '{pid}' ORDER BY s.created_at""")
    out("\n**Scenarios** (runs cascade with their scenario)")
    for x in r or []:
        out(f"- `{x['id'][:8]}` {x['name']} · {x['role']} · {x['horizon_days']} d · {x['runs']} runs · evidence for {x['evidence_for_models']} model(s) · {x['at'][:16]}")
    r, e = safe(f"""SELECT v.id::text, v.version_no, v.label, v.created_at::text AS at,
                           (SELECT count(*)::int FROM public.simulation_runs r WHERE r.policy_version_id = v.id) AS runs,
                           (SELECT count(*)::int FROM public.model_validations m WHERE m.policy_version_id = v.id) AS models
                      FROM public.policy_versions v WHERE v.project_id = '{pid}' ORDER BY v.version_no""")
    out("\n**Policy versions**")
    for x in r or []:
        out(f"- `{x['id'][:8]}` v{x['version_no']} {x['label']} · {x['runs']} runs · {x['models']} model(s) · {x['at'][:16]}")
    r, e = safe(f"""SELECT v.id::text, v.version_no, v.label, v.created_at::text AS at,
                           (SELECT count(*)::int FROM public.simulation_runs r WHERE r.dataset_version_id = v.id) AS runs,
                           (SELECT count(*)::int FROM public.model_validations m WHERE m.dataset_version_id = v.id) AS models
                      FROM public.dataset_versions v WHERE v.project_id = '{pid}' ORDER BY v.version_no""")
    out("\n**Data versions**")
    for x in r or []:
        out(f"- `{x['id'][:8]}` v{x['version_no']} {x['label']} · {x['runs']} runs · {x['models']} model(s) · {x['at'][:16]}")
    r, e = safe(f"""SELECT r.id::text, s.name AS scenario, pv.label AS policy, r.status, r.created_at::text AS at,
                           r.model_validation_id::text AS model, r.exploratory
                      FROM public.simulation_runs r LEFT JOIN public.scenarios s ON s.id = r.scenario_id
                      LEFT JOIN public.policy_versions pv ON pv.id = r.policy_version_id
                     WHERE r.project_id = '{pid}' ORDER BY r.created_at""")
    out("\n**Runs**")
    for x in r or []:
        out(f"- `{x['id'][:8]}` {x['scenario']} · {x['policy']} · {x['status']} · model `{(x['model'] or '-')[:8]}` · {x['at'][:16]}")
    r, e = safe(f"SELECT count(*)::int AS n FROM public.analysis_runs WHERE project_id = '{pid}' AND status = 'running'")
    out(f"\n**Analyses still `running`:** {r[0]['n'] if r else e}")

def main() -> None:
    out(f"# Demo readiness — projects named `{NAME_PREFIX}*`\n")
    projects = sql(f"""SELECT p.id::text, p.name, p.supply_chain_model, p.bom_level, p.plant_name,
                              p.simulation_start::text, p.simulation_end::text, u.email AS modeler_email
                         FROM public.projects p LEFT JOIN public.approved_users u ON u.id = p.modeler_id
                        WHERE p.name LIKE {lit(NAME_PREFIX + '%')} ORDER BY p.created_at""")
    out(f"{len(projects)} project(s).")
    w, e = safe("SELECT to_jsonb(b) AS b FROM public.sim_engine_builds b "
                "LIMIT 1")
    out(f"Latest engine build recorded: {w[0] if w else e}")
    r, e = safe("SELECT status, count(*)::int AS n, max(created_at)::text AS last FROM public.simulation_runs "
                "WHERE created_at > now() - interval '14 days' GROUP BY status")
    out(f"Runs on the whole platform, last 14 days: {r if r is not None else e}")
    summary = {p["name"]: project_report(p) for p in projects}
    for p in projects:
        inventory(p)
        export_snapshots(p)
    Path("demo-readiness.md").write_text("\n".join(OUT) + "\n")
    Path("demo-readiness.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()

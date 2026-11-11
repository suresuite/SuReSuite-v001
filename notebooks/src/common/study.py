# ── SuReSuite study helpers ─────────────────────────────────────────────────
# Shared by notebooks 04 and 05, so both read your project the same way: the data a
# run reads (frozen, or the newest frozen copy and its age), the policies as they are
# on /policies now (saved, or rebuilt here for a read-only key), your saved baseline
# scenario's frame, the platform's engine, and one replication's per-item weeks.
# Run this cell; you do not need to read it.
import json
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore", category=FutureWarning)

INPUT_TABLES = ("suppliers", "materials", "products", "customers", "inbound", "outbound",
                "bom", "bom_multi_level", "demand_forecasts")


def key_scopes(api):
    """The scopes this key may use now (GET /key), so each step knows its fallback."""
    return set((api.key() or {}).get("scopes") or ["read:data", "read:policies"])


def key_table(scopes, verify_use="VERIFY_ON_PLATFORM"):
    return pd.DataFrame([
        {"needs": s, "this key": "yes" if s in scopes else "no", "used for": use, "without it": alt}
        for s, use, alt in [
            ("read:data", "your data and the engine", "—"),
            ("read:policies", "your policies", "—"),
            ("read:runs", "your saved baseline and stress-test scenarios", "the Simulation Lab's defaults"),
            ("write:data", "freezing the data as it is now", "the newest frozen copy (its age is shown)"),
            ("write:policies", "saving /policies as a version", "/policies read live and rebuilt here"),
            ("write:runs", verify_use, "skipped"),
        ]]).set_index("needs")


def styled(df, fmt=None, shade=(), cmap="Reds", caption=None):
    """A formatted table with value shading, or the plain table where the notebook cannot style."""
    try:
        s = df.style.format(fmt or {}, na_rep="—")
        for c in shade:
            if c in df and pd.api.types.is_numeric_dtype(df[c]) and df[c].notna().any():
                s = s.background_gradient(cmap=cmap, subset=[c])
        return s.set_caption(caption) if caption else s
    except (ImportError, AttributeError):  # pandas styling needs jinja2; without it `.style` raises AttributeError
        if caption:
            print(caption)
        return df


def capped(df, what="rows", limit=None):
    limit = limit or globals().get("MAX_ROWS", 40)
    if len(df) > limit:
        print(f"showing {limit} of {len(df)} {what} — the export has all of them")
        return df.head(limit)
    return df


def col(df, name, default=None):
    return df[name] if name in df else pd.Series(default, index=df.index)


def load_dataset(api, project_id, source, scopes, live, label):
    """The frozen dataset version a run reads. "current" freezes the data now when the key may
    (an unchanged project returns the version it has); without write:data it is the newest
    version, and its age is said. Versions are immutable, so they are cached on disk by id."""
    versions = sorted(api.dataset_versions(project_id), key=lambda v: v.get("created_at") or "", reverse=True)
    if source == "current" and "write:data" in scopes:
        version_id = api.freeze_dataset(project_id, label)["id"]
        print("froze the data as it is now:", "no change since the last freeze, so that version is used"
              if version_id in {v["id"] for v in versions} else "a new version")
    elif source in ("current", "latest"):
        if not versions:
            raise Stop("this project has no frozen data yet — run anything in the Simulation Lab (every run "
                       "freezes the data it reads) or use a key with write:data, then run again")
        version_id = versions[0]["id"]
        if source == "current":
            age = (pd.Timestamp.now(tz="UTC") - pd.Timestamp(versions[0]["created_at"])).days
            print(f"note: this key cannot freeze data (no write:data), so the newest frozen version is used — "
                  f"it is {age} day(s) old. Anything uploaded since is NOT in it. Every platform run freezes "
                  f"the data it reads: run anything in the Simulation Lab to refresh it.")
    else:
        version_id = source
    path = Path("suresuite_cache") / project_id / f"{version_id}.json"
    started = time.time()
    if path.exists():
        dv = json.loads(path.read_text())
        print(f"dataset version {version_id}: from the local cache")
    else:
        dv = api.dataset_version(project_id, version_id)
        if live:  # a version never changes, so a copy on disk is always current
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(dv))
        print(f"dataset version {version_id}: downloaded {len(json.dumps(dv)) / 1e6:.1f} MB "
              f"in {time.time() - started:.1f}s")
    return Dataset(id=dv["id"], graph_hash=dv.get("graph_hash"), snapshot=dv["snapshot"], label=dv.get("label"),
                   version_no=dv.get("version_no"), meta={k: v for k, v in dv.items() if k != "snapshot"})


def input_tables(data):
    return {name: data.tables.get(name, pd.DataFrame()) for name in INPUT_TABLES}


def flat_bom(T):
    """(product, material, rate): units of each purchased material per unit of each product,
    through any sub-assemblies. The multi-level BOM wins when it has rows, as in the engine."""
    ml = T["bom_multi_level"]
    if len(ml):
        children = {}
        for parent, child, rate in zip(col(ml, "higher_level_component_id"), ml["material_id"],
                                       col(ml, "consumption_rate", 1)):
            if parent:
                children.setdefault(str(parent), []).append((str(child), float(rate or 0)))
        out = {}

        def walk(product, node, mult, depth=0):
            for child, rate in children.get(node, []):
                if child in children and depth < 25:
                    walk(product, child, mult * rate, depth + 1)
                else:
                    out[(product, child)] = out.get((product, child), 0.0) + mult * rate
        for p in col(T["products"], "product_id").astype(str):
            walk(p, p, 1.0)
        return pd.DataFrame([{"product_id": p, "material_id": m, "rate": r} for (p, m), r in out.items()],
                            columns=["product_id", "material_id", "rate"])
    b = T["bom"]
    return pd.DataFrame({"product_id": col(b, "product_id").astype(str), "material_id": col(b, "material_id").astype(str),
                         "rate": col(b, "consumption_rate", 1).astype(float)})


PER_WEEK = {"day": 7, "week": 1, "month": 12 / 52, "quarter": 4 / 52, "year": 1 / 52}


def supply_lanes(T):
    """Inbound lanes with their weekly volume and weekly spend (for ranking only; the engine
    normalizes the data itself)."""
    return T["inbound"].assign(
        supplier_id=lambda d: col(d, "supplier_id").astype(str), material_id=lambda d: col(d, "material_id").astype(str),
        per_week=lambda d: col(d, "volume", 0).astype(float).fillna(0)
                           * col(d, "time_unit", "week").fillna("week").str.lower().map(PER_WEEK).fillna(1),
        spend=lambda d: d["per_week"] * col(d, "unit_price", 0).astype(float).fillna(0))


def data_check(T, bom, lanes):
    mats = set(col(T["materials"], "material_id").astype(str))
    prods = set(col(T["products"], "product_id").astype(str))
    n_sources = lanes.groupby("material_id")["supplier_id"].nunique()
    return pd.DataFrame([
        ("materials in the BOM with no item master", sorted(set(bom.material_id) - mats)),
        ("materials with no supplier lane", sorted(set(bom.material_id) - set(lanes.material_id))),
        ("products with no BOM", sorted(prods - set(bom.product_id))),
        ("materials with a single supplier", sorted(n_sources[n_sources == 1].index)),
    ], columns=["check", "items"]).assign(
        count=lambda d: d["items"].map(len),
        items=lambda d: d["items"].map(lambda xs: ", ".join(xs[:12]) + (" …" if len(xs) > 12 else "")))


def load_policies(api, project_id, source, pinned_id, scopes, label):
    """The policy version a run reads, and what differs between the saved version and /policies now.
    Returns (policy, drift rows, the families as stored on /policies now)."""
    saved = sorted(api.policy_versions(project_id), key=lambda v: v.get("created_at") or "", reverse=True)
    pinned_id = pinned_id or (saved[0]["id"] if saved else None)
    pinned = policy(api, project_id, pinned_id) if pinned_id else None

    live = api.policies(project_id)
    live_def = live.get("defaults") or {}
    now_fam = {f: dict(live_def.get(f) or {}) for f in FAMILIES}
    now_strategy = live_def.get("fulfillment_strategy")
    canon = lambda o: (o["scope"], o["target_key"], o["family"])
    now_over = {canon(o): o.get("patch") or {} for o in live.get("overrides") or []}

    drift = []
    if pinned:
        saved_def = pinned.snapshot.get("defaults") or {}
        for f in FAMILIES:
            for k, v in now_fam[f].items():
                if (saved_def.get(f) or {}).get(k) != v:
                    drift.append({"setting": f"{f}.{k}", "saved version": (saved_def.get(f) or {}).get(k), "/policies now": v})
        if now_strategy and now_strategy != pinned.snapshot.get("fulfillment_strategy"):
            drift.append({"setting": "fulfillment_strategy", "saved version": pinned.snapshot.get("fulfillment_strategy"),
                          "/policies now": now_strategy})
        saved_over = {canon(o): o.get("patch") or {} for o in pinned.snapshot.get("overrides") or []}
        for key in sorted(set(saved_over) | set(now_over)):
            if saved_over.get(key) != now_over.get(key):
                drift.append({"setting": "override " + " · ".join(key), "saved version": saved_over.get(key),
                              "/policies now": now_over.get(key)})
        print(f"saved version: {pinned.label or 'unlabelled'} ({pinned.id})")

    if source == "pinned" or (pinned and not drift):
        if not pinned:
            raise Stop("this project has no saved policy version to pin — use \"current\", or save one on /policies")
        pol = pinned
        print("using the saved version" + ("" if not drift else f" — {len(drift)} setting(s) differ from /policies now (below)"))
    elif "write:policies" in scopes:
        pol = policy(api, project_id, api.snapshot_policies(project_id, f"{label} · /policies as it is now")["id"])
        print(f"saved /policies as it is now: {pol.label} ({pol.id})")
    else:
        # The platform builds a version as the page's defaults with the stored values over them, family
        # by family. The saved version already holds the page's defaults, so the stored values go over it.
        snap = copy.deepcopy(pinned.snapshot) if pinned else {"schema_version": 2, "defaults": {}}
        for f in FAMILIES:
            snap.setdefault("defaults", {})[f] = {**(snap["defaults"].get(f) or {}), **now_fam[f]}
        snap["fulfillment_strategy"] = now_strategy or snap.get("fulfillment_strategy") or "make_to_stock"
        snap["overrides"] = [{"scope": s, "target_key": t, "family": f, "patch": p} for (s, t, f), p in sorted(now_over.items())]
        pol = Policy(id="rebuilt from /policies (not a saved version)", policy_hash=None, snapshot=snap,
                     label="/policies as it is now")
        print("note: this key cannot save a policy version (no write:policies), so the current policies are rebuilt "
              "here from /policies" + (" over the saved version." if pinned else
              " alone — there is no saved version, so settings never touched on /policies take the ENGINE's defaults, "
              "which can differ from the page's. Save a version on /policies for an exact run."))
    if not drift and pinned:
        print("the saved version matches /policies on every stored setting")
    return pol, pd.DataFrame(drift, columns=["setting", "saved version", "/policies now"]).set_index("setting"), now_fam


def policy_tables(pol, now_fam):
    """(project-wide settings with where each comes from, per-item overrides counted by family)."""
    snap = pol.snapshot or {}
    rows = [{"family": f, "setting": k, "value": v if not isinstance(v, (dict, list)) else json.dumps(v)[:80],
             "where": "set on /policies" if k in now_fam.get(f, {}) else "page default"}
            for f in FAMILIES for k, v in (snap.get("defaults", {}).get(f) or {}).items()]
    settings = pd.DataFrame(rows, columns=["family", "setting", "value", "where"]).sort_values(
        ["where", "family"], ascending=[False, True])
    over = pd.DataFrame(snap.get("overrides") or [], columns=["scope", "target_key", "family", "patch"])
    return settings, over.groupby(["family", "scope"]).size().rename("per-item overrides").to_frame()


def study_scenario(api, project_id, scenario_id, scopes, replications=None):
    """Your saved baseline scenario (or the Simulation Lab's defaults), its frame, and your saved
    stress tests. A pre-filled SCENARIO_ID with disruptions is used as a frame and its events
    join the stress tests."""
    scenarios = api.scenarios(project_id) if "read:runs" in scopes else []
    stress = [s for s in scenarios if s.get("disruption_schedule")]
    sc = next((s for s in scenarios if s["id"] == scenario_id), None) if scenario_id else \
        next((s for s in scenarios if not s.get("disruption_schedule")), None)
    if sc is None:
        sc = {"id": None, "name": "Simulation Lab defaults", **DEFAULT_FRAME}
        print("no saved baseline scenario" + ("" if "read:runs" in scopes else " (the key has no read:runs)")
              + " — using the Simulation Lab's defaults")
    elif sc.get("disruption_schedule"):
        print(f"note: {sc['name']} has disruptions — its frame is the baseline here, its events are a stress test")
        stress = [sc] + [s for s in stress if s["id"] != sc["id"]]
        sc = {**sc, "disruption_schedule": []}
    frame = {k: sc[k] for k in ("horizon_days", "warmup_days", "replications", "seed", "crn", "recovery_overrides")
             if sc.get(k) is not None}
    if replications:
        frame["replications"] = replications
    print(f"scenario: {sc['name']} — {frame.get('horizon_days')} days, {frame.get('replications')} replications, "
          f"seed {frame.get('seed')}")
    return sc, frame, stress


def ensure_engine(api, live, version=None):
    """The engine on this machine: the platform's current one, or `version` ("0.8.3", or the exact
    build a run recorded as its code_version) to repeat an older study. Installed, or reinstalled
    when the version here is another one. Demo mode hands out no engine."""
    try:
        wanted = api.engine(version=version)
    except SuReSuiteError:
        wanted = None
    if wanted and live:
        import importlib.metadata as md
        have = md.version("scsim") if engine_available() else None
        if have != wanted["engine_version"]:
            install_engine(api, version=version)
            if "scsim" in sys.modules:
                print("an engine was already loaded in this session — restart the runtime and run all cells again")
    if not engine_available():
        print("the engine is not installed — demo mode cannot hand it out. Add SURESUITE_API_KEY (see the Setup "
              "notes) and run all cells again; the simulation steps need it.")
        return False
    return True


def engine_view(data, pol, scenario, project_model):
    """What the engine RECEIVES for these inputs — lead times in weeks, capacities, opening stock,
    the allocation rule — read from the engine's own mapping rather than re-derived here."""
    from sim_worker.local import engine_input_from_snapshots
    return engine_input_from_snapshots(data.snapshot, pol.snapshot, scenario, project_model=project_model)["scenario"]


def inspect_run(data, pol, scenario, project_model, seed, disruptions=None):
    """One replication with every item's weekly record — {(kind, measure): weeks × items}. A one-replication
    run with seed s is replication 0 of any run with root seed s, so it is one of that run's own worlds."""
    from sim_worker.local import run_from_snapshots
    out = run_from_snapshots(data.snapshot, pol.snapshot,
                             {**scenario, "replications": 1, "seed": seed, "inspection": True,
                              "disruption_schedule": list(disruptions or [])},
                             project_model=project_model)
    frames = {}
    for r in out["item_series"]:
        for measure, values in r["series"].items():
            frames.setdefault((r["kind"], measure), {})[str(r["item_id"])] = values
    if not frames:
        raise Stop("the engine returned no per-item weeks — this engine build predates them; install the platform's")
    return out["run_update"], {k: pd.DataFrame(v) for k, v in frames.items()}


def use_of(frames, bom):
    """Each material used per week: each product's production times its BOM."""
    prod = frames.get(("product", "production"), pd.DataFrame())
    oh = frames[("material", "on_hand")]
    use = pd.DataFrame(0.0, index=oh.index, columns=oh.columns)
    for p, m, rate in bom.itertuples(index=False):
        if p in prod and m in use:
            use[m] += prod[p] * rate
    return use

# %% [markdown]
# # SuReSuite 04 · Component inventory: trace materials week by week
#
# Runs your project on **this machine** with the platform's engine and follows the materials you
# choose, week by week, with and without a disruption. Four steps:
#
# 1. **Versions** — the engine, data and policies the runs read (the latest, or pinned).
# 2. **Baseline** — run it here, or pull a finished run from the platform.
# 3. **Experiment** — the suppliers to knock out, compared with the baseline on the KPIs you pick.
# 4. **Trace** — the materials to follow: stock, in transit, ordered and used, in both worlds.
#
# Nothing here changes your project or uses quota. Demo mode needs no key; with one, `read:data` and
# `read:policies` are enough (`read:runs` to pull a run). The KPIs average every replication; a trace
# is **one seed**, because the engine keeps per-item weeks for a single replication only.

# %% include: config

# %% include: bundle setup library local study trace demo_data baseline

# %% [markdown]
# ## Settings
# Everything you choose is in this one cell. Ids are the ones in your own data.

# %%
# 1 · Versions — "latest"/"current" follow the platform; pin a value to repeat a study exactly
ENGINE = "latest"      # or "0.8.3", or a run's code_version ("scsim-0.8.3+…")
DATA = "current"       # "current" = your data now | "latest" = the newest frozen version | a dataset version id
POLICY = "current"     # "current" = /policies now | "latest" = the newest saved version | a policy version id

# 2 · Baseline — the frame (horizon, warm-up) is your scenario's (SCENARIO_ID above)
BASELINE = "run"       # "run" = run it on this machine | a run id from the Simulation Lab = pull that run
REPLICATIONS = None    # None = the scenario's
SEED = None            # None = the scenario's; the trace follows this seed
KPIS = ["fill_rate", "lost_units", "lost_sales_value", "max_backlog", "avg_on_hand_value"]   # [] = every KPI

# 3 · Experiment — [] = baseline only
SUPPLIERS_OUT = []     # supplier ids and/or "plant" to knock out together, e.g. ["S2"]
START_DAY, OUTAGE_DAYS, MAGNITUDE_PCT = 140, 42, 100   # when, how long, how hard (100 = ships nothing)

# 4 · Trace
MATERIALS = []         # material ids to follow, e.g. ["M1", "M2"]; [] = the TOP_N riskiest
TOP_N = 4

EXPORT = "material_trace.xlsx"   # "" = no export

# %% [markdown]
# ## 1 · Versions
# **Expect:** your project, then one table: the engine, data, policies and scenario the runs read, and
# whether each is the newest the platform has.

# %%
api = connect(BASE_URL, API_KEY, DEMO_DATA, needs=["read:data", "read:policies"], mode=MODE)
project = pick_project(api, PROJECT_ID)
PID, MODEL, SCOPES = project["id"], project.get("supply_chain_model"), key_scopes(api)

if not ensure_engine(api, api.live, None if ENGINE == "latest" else ENGINE):
    raise Stop("this notebook runs the engine — add SURESUITE_API_KEY and run all cells again")
data = load_dataset(api, PID, DATA, SCOPES, api.live, "notebook 04")
pol, drift, _ = load_policies(api, PID, "current" if POLICY == "current" else "pinned",
                              POLICY_VERSION_ID if POLICY == "current" else "" if POLICY == "latest" else POLICY,
                              SCOPES, "notebook 04")
scenario, FRAME, _ = study_scenario(api, PID, SCENARIO_ID, SCOPES, REPLICATIONS)
if SEED is not None:
    FRAME["seed"] = SEED
RUN = {**scenario, **FRAME}
display(styled(versions_table(api, PID, data, pol, scenario, FRAME)))

# %% [markdown]
# ## 2 · Baseline
# **Expect:** the baseline's KPIs: mean and 95 % interval over the replications.

# %%
base = baseline(api, BASELINE, data, pol, RUN, MODEL)
display(kpi_table(base["run"], KPIS or None)[["measure", "mean", "± 95% CI"]])

# %% [markdown]
# ## 3 · Experiment
# The same replications again with `SUPPLIERS_OUT` shipping nothing for the window, paired with the
# baseline draw by draw.
# **Expect:** each KPI in both worlds, the difference, and whether it is clear of noise.

# %%
EVENTS = [outage(t, START_DAY, OUTAGE_DAYS, MAGNITUDE_PCT) for t in SUPPLIERS_OUT or ([SUPPLIER_ID] if SUPPLIER_ID else [])]
shock = simulate(data, pol, scenario=RUN, disruptions=EVENTS, project_model=MODEL) if EVENTS else None
WINDOW = effective_window(EVENTS[0], base["run"]) if EVENTS else None

if shock:
    assert_disruption_applied(shock["replications"])
    display(paired_compare(base["replications"], shock["replications"], KPIS or None, labels=("baseline", "disrupted"))
            .drop(columns=["delta", "half_width"]))
else:
    print("no disruption set — the trace below is the baseline alone")

# %% [markdown]
# ## 4 · Trace
# One replication on the seed, with every material's weeks kept, without and with the disruption:
# the two worlds share every random draw and differ only by the outage.
# **Expect:** the materials followed, side by side in both worlds, then their dynamics: a column per
# material; on hand, in transit, ordered and used from top to bottom.

# %%
T = input_tables(data)
BOM, LANES = flat_bom(T), supply_lanes(T)
WORLDS = {"baseline": trace(data, pol, RUN, MODEL, FRAME["seed"], BOM)}
if EVENTS:
    WORLDS["disrupted"] = trace(data, pol, RUN, MODEL, FRAME["seed"], BOM, EVENTS)

summary = material_summary(list(WORLDS.values())[-1], LANES, base=WORLDS["baseline"] if EVENTS else None)
TRACED = select_materials(summary, MATERIALS, TOP_N)
print(f"{len(summary)} materials in the run · following {len(TRACED)}: {', '.join(TRACED)}")
display(styled(compare_table(WORLDS, LANES, TRACED), fmt="{:,.0f}", caption=f"Materials followed — seed {FRAME['seed']}"))

# %%
plot_dynamics(WORLDS, TRACED, WINDOW)

# %% [markdown]
# **Reading it.** Stock falling while orders stay flat: the policy is not reacting. Orders rising
# while nothing arrives: the supply is not answering. A material used less although its own supplier
# is fine: production stopped for want of another one. To tell the chain from the seed, change `SEED`
# and run again: a stockout that stays in the same week is structural.

# %% [markdown]
# ## Export
# **Expect:** one workbook: the versions, the KPIs, every material, and the traced ones week by week.

# %%
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        versions_table(api, PID, data, pol, scenario, FRAME).to_excel(xw, sheet_name="versions")
        kpi_table(base["run"]).to_excel(xw, sheet_name="baseline KPIs")
        if shock:
            kpi_table(shock["run"]).to_excel(xw, sheet_name="disrupted KPIs")
        summary.to_excel(xw, sheet_name="materials")
        weekly(WORLDS, TRACED).to_excel(xw, sheet_name="weekly", index=False)
    print("written:", EXPORT)
    try:
        from google.colab import files
        files.download(EXPORT)
    except ImportError:
        pass

# %% [markdown]
# ## Next
# - **02** — disruptions as platform runs, saved where the Simulation Lab shows them.
# - **03** — fix what you found on a local copy first: a second supplier lane, more safety stock.
# - **05** — can a request be met, and when.

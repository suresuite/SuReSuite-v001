# %% [markdown]
# # SuReSuite 04 · Component inventory: trace materials week by week
#
# Runs your project on **this machine** with the platform's engine and follows the materials and
# products you choose, week by week — as they are, or under a disruption. Three steps:
#
# 1. **Versions** — the engine, data and policies the runs read (the latest, or pinned).
# 2. **Experiment** — replications, seed, and an optional disruption.
# 3. **Trace** — the materials and products to follow.
#
# Nothing here changes your project or uses quota. Demo mode needs no key; with one, `read:data` and
# `read:policies` are enough (create it on /developer). The KPIs average every replication; a trace
# is **one seed**, because the engine keeps per-item weeks for a single replication only.

# %% include: config

# %% include: setup

# %% include: library

# %% include: local

# %% include: study

# %% include: trace

# %% include: demo_data baseline

# %% [markdown]
# ## Settings
# Everything you choose is in this one cell. Ids are the ones in your own data.

# %%
# 1 · Versions — "latest"/"current" follow the platform; pin a value to repeat a study exactly
ENGINE = "latest"      # or "0.8.3", or a run's code_version ("scsim-0.8.3+…")
DATA = "current"       # "current" = your data now | "latest" = the newest frozen version | a dataset version id
POLICY = "current"     # "current" = /policies now | "latest" = the newest saved version | a policy version id

# 2 · Experiment — the rest of the frame (horizon, warm-up) is your scenario's (SCENARIO_ID above)
REPLICATIONS = None    # None = the scenario's
SEED = None            # None = the scenario's; the trace follows this seed
DISRUPTIONS = [outage(SUPPLIER_ID, start_day=140, duration_days=42)] if SUPPLIER_ID else []
#   any list of outage(target, start_day, duration_days, magnitude_pct); a target is a supplier id or "plant"

# 3 · Trace
PRODUCTS = []          # product ids: follow them and the riskiest materials in their BOM
MATERIALS = []         # material ids to follow, e.g. ["M1", "M2"]
TOP_N = 6              # riskiest materials added automatically (all of them when nothing is named)

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
scenario, FRAME, saved_stress = study_scenario(api, PID, SCENARIO_ID, SCOPES, REPLICATIONS)
if SEED is not None:
    FRAME["seed"] = SEED
RUN = {**scenario, **FRAME}
display(styled(versions_table(api, PID, data, pol, scenario, FRAME)))

# %% [markdown]
# ## 2 · Experiment
# The baseline, and the same replications again under `DISRUPTIONS`, paired draw by draw.
# **Expect:** the KPIs — with a disruption, the difference and whether it is clear of noise.

# %%
EVENTS = DISRUPTIONS or next((s["disruption_schedule"] for s in saved_stress if s["id"] == SCENARIO_ID), [])
base = simulate(data, pol, scenario=RUN, disruptions=[], project_model=MODEL)
shock = simulate(data, pol, scenario=RUN, disruptions=EVENTS, project_model=MODEL) if EVENTS else None
WINDOW = effective_window(EVENTS[0], base["run"]) if EVENTS else None

if shock:
    assert_disruption_applied(shock["replications"])
    display(paired_compare(base["replications"], shock["replications"], labels=("baseline", "disrupted"))
            .drop(columns=["delta", "half_width"]))
else:
    display(kpi_table(base["run"])[["measure", "mean", "± 95% CI"]])

# %% [markdown]
# ## 3 · Trace
# One replication on the seed, with every item's weeks kept — the same world as one line of step 2.
# **Expect:** the materials ranked by risk, then the ones followed: a table, a chart each, and all of
# them on one map.

# %%
T = input_tables(data)
BOM, LANES = flat_bom(T), supply_lanes(T)
B = trace(data, pol, RUN, MODEL, FRAME["seed"], BOM)
S = trace(data, pol, RUN, MODEL, FRAME["seed"], BOM, EVENTS) if EVENTS else None
WORLDS = {"baseline": B, "disrupted": S} if S else {"baseline": B}

summary = material_summary(S or B, LANES, base=B if S else None)
TRACED, TRACED_PRODUCTS = select_items(summary, BOM, PRODUCTS, MATERIALS, TOP_N)
print(f"{len(summary)} materials in the run · following {len(TRACED)}: {', '.join(TRACED)}")
display(styled(summary.loc[TRACED], shade=["weeks at zero"],
               fmt={c: "{:,.1f}" for c in summary.select_dtypes("number")} | {"weeks at zero": "{:,.0f}",
                                                                              "first stockout": "{:,.0f}"},
               caption=f"Materials followed — seed {FRAME['seed']}, {'disrupted' if S else 'baseline'}"))

# %% [markdown]
# **Stock.** A panel per material: on hand and in transit — under a disruption, on hand in both worlds.

# %%
plot_items(WORLDS, "material", TRACED, ["on_hand"] if S else ["on_hand", "in_transit"], WINDOW, title="Stock — units")

# %% [markdown]
# **Flow.** What was ordered and what production used.

# %%
plot_items(WORLDS, "material", TRACED, ["orders", "use"], WINDOW, title="Ordered and used — units per week")

# %% [markdown]
# **All of them at once.** A row per material.

# %%
stock_map(S or B, TRACED, base=B if S else None, window=WINDOW)

# %% [markdown]
# **The products they go into.**

# %%
display(styled(product_summary(S or B).loc[TRACED_PRODUCTS], fmt="{:,.1f}",
               caption=f"Products — seed {FRAME['seed']}, {'disrupted' if S else 'baseline'}"))
plot_items(WORLDS, "product", TRACED_PRODUCTS, ["fulfillment", "backlog"] if S else ["demand", "fulfillment", "fg_on_hand"],
           WINDOW, title="Products — units per week")

# %% [markdown]
# **Reading it.** Stock falling while orders stay flat: the policy is not reacting. Orders rising
# while nothing arrives: the supply is not answering. A material used less although its own supplier
# is fine: production stopped for want of another one. To tell the chain from the seed, change `SEED`
# and run again: a stockout that stays in the same week is structural.
#
# One material's full weekly record, MRP columns included where it has them:
# `pd.DataFrame({k: v[TRACED[0]] for k, v in B["material"].items()})`.

# %% [markdown]
# ## Export
# **Expect:** one workbook: the versions, the KPIs, every material, and the traced items week by week.

# %%
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        versions_table(api, PID, data, pol, scenario, FRAME).to_excel(xw, sheet_name="versions")
        kpi_table(base["run"]).to_excel(xw, sheet_name="baseline KPIs")
        if shock:
            kpi_table(shock["run"]).to_excel(xw, sheet_name="disrupted KPIs")
        summary.to_excel(xw, sheet_name="materials")
        product_summary(S or B).to_excel(xw, sheet_name="products")
        weekly(WORLDS, TRACED, TRACED_PRODUCTS).to_excel(xw, sheet_name="weekly", index=False)
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

# %% [markdown]
# # SuReSuite 05 · Available to promise
#
# Answers, for the materials you choose: *can Q units leave stock in this week, and if not, how much
# and when?* It runs your chain on **this machine** as it is, in several possible futures, and reads
# the answer from each material's stock. Four steps:
#
# 1. **Versions** — the engine, data and policies the runs read (the latest, or pinned).
# 2. **Futures** — the chain as it is, one run per future. Kept on disk: a new question runs nothing.
# 3. **Materials** — the ones to check, and how much of each, by when.
# 4. **Answer** — yes, partial, or the nearest week that works.
#
# **Available to promise** in a week is what can leave stock then without running short before a
# reorder can arrive: the lowest stock from that week to one lead time later, in at least
# `CONFIDENCE` of the futures. Nothing here changes your project or uses quota. Demo mode needs no
# key; with one, `read:data` and `read:policies` are enough.

# %% include: config

# %% include: bundle setup library local study atp demo_data baseline

# %% [markdown]
# ## Settings
# Everything you choose is in this one cell. Only sections 1 and 2 cost a run; change 3 and 4 freely.

# %%
# 1 · Versions — "latest"/"current" follow the platform; pin a value to repeat a study exactly
ENGINE = "latest"      # or "0.8.3", or a run's code_version ("scsim-0.8.3+…")
DATA = "current"       # "current" = your data now | "latest" = the newest frozen version | a dataset version id
POLICY = "current"     # "current" = /policies now | "latest" = the newest saved version | a policy version id

# 2 · Futures — the horizon and warm-up are your scenario's (SCENARIO_ID above)
N_WORLDS = 10          # futures (one seed each); more = a steadier answer, and only the new ones are run

# 3 · Materials
MATERIALS = []         # material ids to check, e.g. ["M1", "M2"]; [] = the TOP_N with the least cover
TOP_N = 4
QUANTITY = 150         # units of each — or one per material: {"M1": 300, "M2": 150}
NEEDED_BY = ""         # "YYYY-MM-DD"; "" = NEEDED_WEEK
NEEDED_WEEK = 20       # weeks from week 0
START_DATE = ""        # the date of week 0; "" = your earliest forecast period, else today

# 4 · Answer
CONFIDENCE = 0.9       # promise only what holds in at least this share of futures

EXPORT = "available_to_promise.xlsx"   # "" = no export

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
data = load_dataset(api, PID, DATA, SCOPES, api.live, "notebook 05")
pol, drift, _ = load_policies(api, PID, "current" if POLICY == "current" else "pinned",
                              POLICY_VERSION_ID if POLICY == "current" else "" if POLICY == "latest" else POLICY,
                              SCOPES, "notebook 05")
scenario, FRAME, _ = study_scenario(api, PID, SCENARIO_ID, SCOPES, N_WORLDS)
RUN = {**scenario, **FRAME}
display(styled(versions_table(api, PID, data, pol, scenario, FRAME)))

# %% [markdown]
# ## 2 · Futures
# One replication per seed, every material's weeks kept. This is the only step that runs the engine.
# **Expect:** how many futures were run and how many came from the cache.

# %%
T = input_tables(data)
BOM, LANES = flat_bom(T), supply_lanes(T)
EV = engine_view(data, pol, RUN, MODEL)   # what the engine receives: lead times, capacities, opening stock
SEEDS = [int(RUN.get("seed", 42)) + i for i in range(N_WORLDS)]
WORLDS = futures(data, pol, RUN, MODEL, SEEDS, BOM)

# %% [markdown]
# ## 3 · Materials
# Week 0 is the start of the simulation: your opening stock as it is in the data. The data holds no
# open purchase orders, so the first lead-time weeks can understate supply you have already ordered.
# **Expect:** the week asked for, then the stock position of the materials checked.

# %%
START = week_zero(T, START_DATE)
WEEK = int((pd.Timestamp(NEEDED_BY) - START).days // 7) if NEEDED_BY else int(NEEDED_WEEK)
if not 0 <= WEEK < len(WORLDS[SEEDS[0]]["on_hand"]):
    raise Stop(f"week {WEEK} is outside the simulated weeks 0–{len(WORLDS[SEEDS[0]]['on_hand']) - 1}")
POSITION = atp_position(WORLDS, EV, WEEK, CONFIDENCE)
REQUESTS = pick_requests(POSITION, MATERIALS, QUANTITY, TOP_N)
print(f"week {WEEK} = {(START + pd.Timedelta(weeks=WEEK)).date()} · {len(POSITION)} materials · checking {', '.join(REQUESTS)}")
display(styled(POSITION.loc[list(REQUESTS)], fmt="{:,.0f}", shade=["ATP"], cmap="Greens",
               caption=f"Stock position in week {WEEK} — ATP at {CONFIDENCE:.0%} confidence"))

# %% [markdown]
# ## 4 · Answer
# **Expect:** one row per material — yes, or how much then and when the rest, the nearest week that
# takes all of it, and what an order placed now would add — then each material's stock, its ATP and
# the request on one panel.

# %%
ANSWER = promise(WORLDS, EV, LANES, REQUESTS, WEEK, CONFIDENCE, START)
display(styled(ANSWER, fmt="{:,.0f}", shade=["on time (% of futures)"], cmap="Greens",
               caption=f"Can it leave stock in week {WEEK}? — {N_WORLDS} futures, {CONFIDENCE:.0%} confidence"))
plot_atp(WORLDS, EV, REQUESTS, WEEK, CONFIDENCE)

# %% [markdown]
# **Reading it.** The green line is what you can promise in each week; the request is the dot. A dot
# under the line is a yes. A dot above it waits for the next delivery: the week the line climbs back
# over it is "all of it by". Raise `N_WORLDS` before you quote a date that sits just above the bar.

# %% [markdown]
# ## Export
# **Expect:** one workbook: the versions, the answer, and every material's stock position.

# %%
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        versions_table(api, PID, data, pol, scenario, FRAME).to_excel(xw, sheet_name="versions")
        ANSWER.assign(week=WEEK, date=str((START + pd.Timedelta(weeks=WEEK)).date()), confidence=CONFIDENCE,
                      futures=N_WORLDS).to_excel(xw, sheet_name="answer")
        POSITION.to_excel(xw, sheet_name="stock position")
    print("written:", EXPORT)
    try:
        from google.colab import files
        files.download(EXPORT)
    except ImportError:
        pass

# %% [markdown]
# ## Next
# - **04** — follow the same materials week by week, with and without a supplier outage.
# - **03** — try the fix on a local copy first: a second supplier lane, more safety stock.

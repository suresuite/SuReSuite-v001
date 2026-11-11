# %% [markdown]
# # SuReSuite 05 · Available to promise
#
# For a list of requests — *can Q units of this material leave stock in this week?* — it runs your
# chain on **this machine** in several possible scenarios and gives one decision per request. The
# materials, quantities and weeks can all differ, and a material can be asked for more than once.
#
# 1. **Versions** — the engine, data and policies the runs read (the latest, or pinned).
# 2. **Scenarios** — the chain as it is, one run per scenario. Kept on disk: a new question runs nothing.
# 3. **Requests** — one line each: the material, how much, and when.
# 4. **Which case?** — **case 1**, the request is within what is available to promise (ATP): all of it
#    in the week. **Case 2**, above ATP: the part ATP covers in the week, the rest later.
# 5. **Decision** — that plan, simulated. **This is the answer**; ATP is the quick screen before it.
#
# **How ATP is worked out.** What can leave stock in a week without production running short before
# a reorder can arrive:
#
# > ATP = stock at the start of the week + what arrives − what production uses − what earlier requests were promised
#
# counted up to the **tightest week** between the request's week and one lead time later (a reorder
# placed in that week lands then). Stock that planned production will use before then is not free,
# so a material can hold a lot and still have little to promise. It is read in the scenario that
# makes the promise hold in at least `CONFIDENCE` of them (0.9 = 9 of 10). Step 4 shows this sum
# for every request. Two things to know: the
# requests are accepted **together**, and an accepted order is known from week 0, so your
# replenishment may react before the week. Nothing here changes your project or uses quota.

# %% include: config

# %% include: bundle setup library local study atp demo_data baseline

# %% [markdown]
# ## Settings
# Everything you choose is in this one cell. Sections 1 and 2 cost a run per scenario; a new list of
# requests in section 3 costs one more per scenario, for the decision.

# %%
# 1 · Versions — "latest"/"current" follow the platform; pin a value to repeat a study exactly
ENGINE = "latest"      # or "0.8.3", or a run's code_version ("scsim-0.8.3+…")
DATA = "current"       # "current" = your data now | "latest" = the newest frozen version | a dataset version id
POLICY = "current"     # "current" = /policies now | "latest" = the newest saved version | a policy version id

# 2 · Scenarios — the horizon and warm-up are your scenario's (SCENARIO_ID above)
N_SCENARIOS = 10       # possible courses of the year (one seed each); more = a steadier answer
CONFIDENCE = 0.9       # promise only what holds in at least this share of them (0.9 = 9 of 10)

# 3 · Requests — one line each: (material, quantity, when). `when` is a week number or a "YYYY-MM-DD" date.
#     A material may appear several times, at different weeks and quantities.
REQUESTS = [
    # ("M1", 400, 20),
    # ("M2", 300, "2027-03-31"),
    # ("M1", 250, 34),
]
START_DATE = ""        # the date of week 0; "" = your earliest forecast period, else today
TRY = dict(top_n=4, quantity=150, week=20)   # used only while REQUESTS is empty: the materials with the least cover

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
scenario, FRAME, _ = study_scenario(api, PID, SCENARIO_ID, SCOPES, N_SCENARIOS)
RUN = {**scenario, **FRAME}
display(styled(versions_table(api, PID, data, pol, scenario, FRAME)))

# %% [markdown]
# ## 2 · Scenarios
# **Expect:** how many scenarios were run and how many came from the cache.

# %%
T = input_tables(data)
EV = engine_view(data, pol, RUN, MODEL)   # what the engine receives: lead times, capacities, opening stock
SEEDS = [int(RUN.get("seed", 42)) + i for i in range(N_SCENARIOS)]
AS_IS = futures(data, pol, RUN, MODEL, SEEDS, flat_bom(T))

# %% [markdown]
# ## 3 · Requests
# Week 0 is the start of the simulation: your opening stock as it is in the data. The data holds no
# open purchase orders, so the first lead-time weeks can understate supply you have already ordered.
# **Expect:** the requests as read, each with its week and date.

# %%
START = week_zero(T, START_DATE)
POSITION = atp_position(AS_IS, EV, TRY["week"], CONFIDENCE)
ASKED = read_requests(REQUESTS, POSITION, START, len(AS_IS[SEEDS[0]]["on_hand"]), **TRY)
display(styled(ASKED, fmt="{:,.0f}", caption=f"{len(ASKED)} requests for {ASKED['material'].nunique()} materials"))

# %% [markdown]
# ## 4 · Which case?
# Requests for the same material are taken in order of their week, and each sees what is left after
# the ones before it.
# **Expect:** each request against its ATP, its case and the plan that follows; then how each ATP is
# worked out, line by line.

# %%
SCREEN, HOW, PLANS = plan_requests(AS_IS, EV, ASKED, CONFIDENCE)
display(styled(SCREEN, fmt="{:,.0f}", caption="Each request against what is available to promise in its week"))
display(styled(HOW, fmt="{:,.0f}", caption="How each ATP is worked out"))

# %% [markdown]
# ## 5 · Decision
# The plans above are taken out of stock, all together, in the same scenarios as step 2, so the only
# difference is the decision. One more run per scenario, kept on disk like the others.
# **Expect:** one row per request: the decision, in how many scenarios it is delivered as planned, and
# `ok` or what goes wrong. Then what existing customers lose, and a chart per material.

# %%
BEFORE, AFTER = decide(AS_IS, data, pol, RUN, MODEL, SEEDS, SCREEN, PLANS)
DECISION, CUSTOMERS, DETAIL = decision(BEFORE, AFTER, SCREEN, PLANS, CONFIDENCE)
display(styled(DECISION, fmt="{:,.0f}", caption=f"The decision — {N_SCENARIOS} scenarios, promised when it holds in {CONFIDENCE:.0%} of them"))
if CUSTOMERS:
    print(CUSTOMERS)
plot_decision(BEFORE, AFTER, EV, SCREEN, PLANS, CONFIDENCE)

# %% [markdown]
# **Reading it.** `Decline`: nothing is free in that week or later; see step 4 for the sum behind it.
# `ok`: promise it as written. `late`: the material is not there in the planned week
# in enough scenarios; "complete by" is the week to quote instead. `stock runs out`: accepting empties
# the stock for longer than today, and production waits for it. On the chart, the green line is
# what can be promised each week, a ring is a request and a dot is what the plan accepts: a dot under
# the line is safe by the screen. The dashed line is the stock once the plan is in the books.

# %% [markdown]
# ## Export
# **Expect:** one workbook: the versions, the decision for each request, and the detail behind it by material.

# %%
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        versions_table(api, PID, data, pol, scenario, FRAME).to_excel(xw, sheet_name="versions")
        ASKED.join(DECISION.drop(columns="material")).assign(
            confidence=CONFIDENCE, scenarios=N_SCENARIOS, customers=CUSTOMERS).to_excel(xw, sheet_name="decision")
        HOW.to_excel(xw, sheet_name="how ATP is worked out")
        DETAIL.to_excel(xw, sheet_name="detail by material")
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

# %% [markdown]
# # SuReSuite 05 · Available to promise
#
# *We need more of a material than planned. Can its suppliers deliver it by this week?*
#
# > **ATP** in a week = what each supplier of the material has spare in that week (its weekly
# > capacity − what our planned orders take), added over the suppliers.
#
# ATP is a weekly amount: capacity a supplier does not use in a week is gone, it does not add up.
#
# - **Case 1 · the request is within the week's ATP:** accept all of it in the week.
# - **Case 2 · above it:** accept the week's ATP in the week, and the rest from each following
#   week's ATP until it is complete.
#
# Run all cells once, then edit **Requests** and run again. Nothing here changes your project.

# %% include: config

# %% include: bundle setup library local study atp demo_data baseline

# %% [markdown]
# ## 1 · Requests
# The only cell you need to edit.

# %%
# One line each: (material, quantity, when). `when` is a week number or a "YYYY-MM-DD" date.
# A material may appear several times, at different weeks and quantities.
REQUESTS = [
    # ("M1", 400, 20),
    # ("M2", 300, "2027-03-31"),
    # ("M1", 250, 34),
]

# ── advanced: the defaults work ─────────────────────────────────────────────
START_DATE = ""        # the date of week 0 (today's orders are placed in week 0); "" = your earliest forecast period, else today
TRY = dict(top_n=2, quantity=150, week=8)   # used only while REQUESTS is empty
ASSUME_SPARE = (0.05, 0.20)   # a supplier with no capacity in your data: capacity is ASSUMED = what it already delivers
#                               plus a buffer drawn in this range (whole units); None = do not ask such a supplier
ASSUME_SEED = 0               # the draw's seed: the same seed gives the same assumed capacities every run
SIMULATE = False       # True = also run the plan through the engine (step 5); adds a minute or two
N_SCENARIOS = 10       # step 5 only: possible courses of the year
CONFIDENCE = 0.9       # step 5 only: "delivered as planned" must hold in this share of them
ENGINE, DATA, POLICY = "latest", "current", "current"   # pin a version to repeat a study exactly
EXPORT = "available_to_promise.xlsx"   # "" = no export

# %%
api = connect(BASE_URL, API_KEY, DEMO_DATA, needs=["read:data", "read:policies"], mode=MODE)
project = pick_project(api, PROJECT_ID)
PID, MODEL, SCOPES = project["id"], project.get("supply_chain_model"), key_scopes(api)

if not ensure_engine(api, api.live, None if ENGINE == "latest" else ENGINE):
    raise Stop("this notebook reads your data the way the engine does — add your API key and run all cells again")
data = load_dataset(api, PID, DATA, SCOPES, api.live, "notebook 05")
pol, drift, _ = load_policies(api, PID, "current" if POLICY == "current" else "pinned",
                              POLICY_VERSION_ID if POLICY == "current" else "" if POLICY == "latest" else POLICY,
                              SCOPES, "notebook 05")
scenario, FRAME, _ = study_scenario(api, PID, SCENARIO_ID, SCOPES, N_SCENARIOS)
RUN = {**scenario, **FRAME}
HORIZON = int(round(float(RUN.get("horizon_days") or 364) / 7))

T = input_tables(data)
EV = engine_view(data, pol, RUN, MODEL)   # what the engine receives: capacities and lead times
SUPPLIERS = supplier_table(EV, supply_lanes(T), ASSUME_SPARE, ASSUME_SEED)
ASKED = read_requests(REQUESTS, SUPPLIERS, week_zero(T, START_DATE), HORIZON, **TRY)
display(styled(ASKED, fmt="{:,.0f}", caption=f"{len(ASKED)} requests for {ASKED['material'].nunique()} materials"))

# %% [markdown]
# ## 2 · Answer
# **Expect:** one row per request: its case, the decision, the week it is complete, and how much each
# supplier delivers.

# %%
ANSWER, WHY, PLANS = plan_requests(SUPPLIERS, ASKED, HORIZON)
display(styled(ANSWER, fmt="{:,.0f}", caption="The answer"))

# %% [markdown]
# ## 3 · Why
# The sum behind each ATP, supplier by supplier: capacity − committed = spare, per week. An order
# placed now (week 0) arrives one lead time later, so a supplier delivers nothing before then.
# Requests are taken in order of their week; what one takes in a week the next no longer has in
# that week. The "capacity" column says where each capacity comes from: your data, or **assumed**
# (`ASSUME_SPARE`, `ASSUME_SEED`) where your data has none — an answer resting on an assumed
# capacity is only as good as the assumption.
# **Expect:** one row per request and supplier.

# %%
display(styled(WHY, fmt="{:,.0f}", caption="capacity − committed = spare, per week"))

# %% [markdown]
# ## 4 · Chart
# The green line is ATP: what the suppliers have spare in each week. A ring is a request; the bars
# are what the plan takes, week by week. A ring under the line is case 1.

# %%
plot_supply(SUPPLIERS, ANSWER, PLANS, HORIZON)

# %% [markdown]
# ## 5 · Check by simulation (optional)
# With `SIMULATE = True` the accepted plan is run through the engine as an extra need for the
# material in the planned weeks, in `N_SCENARIOS` scenarios with and without it. **It is an
# estimate:** the engine cannot place an extra order with a supplier directly, so the need is added
# and your own replenishment policy does the ordering, within the suppliers' capacity.
# **Expect:** per request, in how many scenarios the material was there as planned, the week it is
# complete by, and `ok` or what goes wrong; then what existing customers lose.

# %%
if SIMULATE and PLANS:
    SEEDS = [int(RUN.get("seed", 42)) + i for i in range(N_SCENARIOS)]
    AS_IS = futures(data, pol, RUN, MODEL, SEEDS, flat_bom(T))
    BEFORE, AFTER = decide(AS_IS, data, pol, RUN, MODEL, SEEDS, ANSWER, PLANS)
    CHECK, CUSTOMERS, DETAIL = decision(BEFORE, AFTER, ANSWER, PLANS, CONFIDENCE)
    display(styled(CHECK, fmt="{:,.0f}", caption=f"The plan in {N_SCENARIOS} scenarios"))
    print(CUSTOMERS)

# %% [markdown]
# ## Export
# **Expect:** one workbook: the answer, the why, the suppliers, and the versions that produced them.

# %%
VERSIONS = versions_table(api, PID, data, pol, scenario, FRAME)
display(styled(VERSIONS, caption="What produced this"))
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        ASKED[["date"]].join(ANSWER).to_excel(xw, sheet_name="answer")
        WHY.to_excel(xw, sheet_name="why")
        SUPPLIERS.to_excel(xw, sheet_name="suppliers", index=False)
        if SIMULATE and PLANS:
            CHECK.assign(customers=CUSTOMERS).to_excel(xw, sheet_name="simulation")
        VERSIONS.to_excel(xw, sheet_name="versions")
    print("written:", EXPORT)
    try:
        from google.colab import files
        files.download(EXPORT)
    except ImportError:
        pass

# %% [markdown]
# ## Next
# - **04** — follow the same materials in our own stock, week by week, with and without a supplier outage.
# - **03** — try a fix on a local copy first: a second supplier lane, more capacity.

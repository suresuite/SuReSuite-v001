# %% [markdown]
# # SuReSuite 05 · Available to promise
#
# Answers a request the way a planner does: *can we give this customer Q units of a product, or Q units
# of a material from stock, by this date?* It runs your chain on **this machine** in several possible
# futures, with and without the request, and answers yes, or how much by then and when the rest, or a
# nearby date that works. Four steps:
#
# 1. **Versions** — the engine, data and policies the runs read (the latest, or pinned).
# 2. **Request** — what, how many, by when, in the engine's weeks.
# 3. **Stock position** — what you hold, what is coming, what is free to promise.
# 4. **Answer** — promise, partial, pull in or push back, and what stands in the way.
#
# Nothing here changes your project or uses quota: the request is added to a **copy** of your data.
# Demo mode needs no key; with one, `read:data` and `read:policies` are enough.

# %% include: config

# %% include: bundle setup library local study atp demo_data baseline

# %% [markdown]
# ## Settings
# Everything you choose is in this one cell. Ids are the ones in your own data.

# %%
# 1 · Versions — "latest"/"current" follow the platform; pin a value to repeat a study exactly
ENGINE = "latest"      # or "0.8.3", or a run's code_version ("scsim-0.8.3+…")
DATA = "current"       # "current" = your data now | "latest" = the newest frozen version | a dataset version id
POLICY = "current"     # "current" = /policies now | "latest" = the newest saved version | a policy version id

# 2 · Request
KIND = "product"       # "product" = a customer's make-to-order request | "material" = material taken from stock
ITEM = ""              # a product or material id; "" = the first one in your data
QUANTITY = 150
NEEDED_BY = ""         # "YYYY-MM-DD"; "" = NEEDED_WEEK
NEEDED_WEEK = 20       # weeks from week 0
START_DATE = ""        # the date of week 0; "" = your earliest forecast period, else today
DELIVERY_WEEKS = None  # product only: weeks in transit to the customer; None = the product's customer lanes

# 3 · Promise rule
CONFIDENCE = 0.9       # promise only what holds in at least this share of futures
N_WORLDS = 10          # futures tried (one seed each); raise it before quoting a date that sits just above the bar
SEARCH_WEEKS = 3       # how far each way to look for a pull-in or a push-back
SERVE_LAST = True      # product only: True = after every existing customer row | False = your allocation rule
PLAN_MATERIALS = "both"   # product only: "as is" | "order book" (the request's materials planned by MRP) | "both"

EXPORT = "available_to_promise.xlsx"   # "" = no export

# %% [markdown]
# ## 1 · Versions
# **Expect:** your project, then one table: the engine, data, policies and scenario the runs read, and
# whether each is the newest the platform has.

# %%
from IPython.display import Markdown

api = connect(BASE_URL, API_KEY, DEMO_DATA, needs=["read:data", "read:policies"], mode=MODE)
project = pick_project(api, PROJECT_ID)
PID, MODEL, SCOPES = project["id"], project.get("supply_chain_model"), key_scopes(api)

if not ensure_engine(api, api.live, None if ENGINE == "latest" else ENGINE):
    raise Stop("this notebook plays the request through the engine — add SURESUITE_API_KEY and run all cells again")
data = load_dataset(api, PID, DATA, SCOPES, api.live, "notebook 05")
pol, drift, _ = load_policies(api, PID, "current" if POLICY == "current" else "pinned",
                              POLICY_VERSION_ID if POLICY == "current" else "" if POLICY == "latest" else POLICY,
                              SCOPES, "notebook 05")
scenario, FRAME, _ = study_scenario(api, PID, SCENARIO_ID, SCOPES, N_WORLDS)
RUN = {**scenario, **FRAME}
SEEDS = [int(RUN.get("seed", 42)) + i for i in range(N_WORLDS)]
display(styled(versions_table(api, PID, data, pol, scenario, FRAME)))

# %% [markdown]
# ## 2 · Request
# Week 0 is the start of the simulation: your opening stock as it is in the data. Lead times and
# capacities are what the engine received, not a second reading of your tables.
# **Expect:** the request and the week it ships, then what it needs from each material.

# %%
T = input_tables(data)
BOM, LANES = flat_bom(T), supply_lanes(T)
EV = engine_view(data, pol, RUN, MODEL)
req = read_request(EV, T, BOM, int(round(float(RUN.get("horizon_days") or 364) / 7)),
                   KIND, ITEM, QUANTITY, NEEDED_BY, NEEDED_WEEK, START_DATE, DELIVERY_WEEKS, CONFIDENCE)
facts, needs = request_tables(req)
display(facts)
if needs is not None:
    display(styled(needs, fmt={"rate": "{:g}", "needed": "{:,.0f}", "opening stock": "{:,.0f}"},
                   caption="What the request needs from each material"))

# %% [markdown]
# ## 3 · Stock position
# The project as it is, in `N_WORLDS` futures. **Available to promise** in a week is what can leave then
# without running short before a reorder can arrive: the lowest stock from that week to one lead time
# later, at the `CONFIDENCE` level. The data holds no open purchase orders, so the first lead-time weeks
# can understate supply you have already ordered.
# **Expect:** each material at the ship week, then its stock, its ATP and the request on one panel.

# %%
WORLDS = futures(data, pol, RUN, MODEL, SEEDS)
POSITION = stock_position(req, WORLDS, BOM)
display(styled(POSITION, fmt={c: "{:,.0f}" for c in POSITION.columns if c != "lead time (wk)"},
               shade=[f"ATP wk {req.ship_week}"], cmap="Greens",
               caption=f"Stock position at week {req.ship_week} ({req.to_date(req.ship_week)}) — ATP at {CONFIDENCE:.0%} confidence"))
plot_position(req, WORLDS)

# %% [markdown]
# ## 4 · Answer
# **A product** becomes a firm order from a customer row added to a copy of your data, tried in every
# week from `SEARCH_WEEKS` before to `SEARCH_WEEKS` after, in the same futures with and without it. It
# is answered twice: your materials replenished **as is**, and the request's materials planned from the
# **order book** (ordered one lead time ahead of the need). **A material** is read from step 3's stock.
# **Expect:** one row per candidate week, then the answer in words and as a chart.

# %%
played = play_request(req, data, pol, RUN, MODEL, SEEDS, WORLDS, T, SEARCH_WEEKS, SERVE_LAST, PLAN_MATERIALS)
for table in candidate_tables(req, played).values():
    display(table)

# %%
display(Markdown(answer_text(req, played, LANES)))
plot_answer(req, played)

# %% [markdown]
# **What stands in the way.** For a product: how many units of it each constraint covers in the wanted
# week — the plant's capacity left by existing customers, and each material's stock divided by what one
# unit uses. The smallest one limits the on-time quantity. A material request is limited by its own
# stock and lead time (step 3).

# %%
for table in limits(req, played).values() if KIND == "product" else []:
    display(table)

# %% [markdown]
# **Reading it.** A request that fails only on plant capacity can often ship partly now and the rest a
# week later; one that fails on a material waits for that material's lead time. "Others lose" above
# zero means the request, even served last, used capacity or material an existing customer needed
# later: promising it is a choice. When "order book" beats "as is", the gap is purchasing not seeing
# the order: telling them now is what closes it.

# %% [markdown]
# ## Export
# **Expect:** one workbook: the versions, the request, the stock position and every candidate week.

# %%
if EXPORT:
    with pd.ExcelWriter(EXPORT) as xw:
        versions_table(api, PID, data, pol, scenario, FRAME).to_excel(xw, sheet_name="versions")
        facts.assign(**{"": facts[""].astype(str)}).to_excel(xw, sheet_name="request")
        pd.Series({"week 0": str(req.start.date()), "futures": f"{N_WORLDS} (seeds {SEEDS[0]}–{SEEDS[-1]})",
                   "confidence": f"{CONFIDENCE:.0%}", "served": "after every existing row" if SERVE_LAST else "by the project's rule",
                   "materials": ", ".join(played.cands)}, name="value").to_frame().to_excel(xw, sheet_name="promise rule")
        POSITION.to_excel(xw, sheet_name="stock position")
        for mode, cand in played.cands.items():
            cand.to_excel(xw, sheet_name=f"weeks · materials {mode}"[:31])
    print("written:", EXPORT)
    try:
        from google.colab import files
        files.download(EXPORT)
    except ImportError:
        pass

# %% [markdown]
# ## Next
# - **04** — follow the request's materials week by week, with and without a supplier outage.
# - **03** — try the fix on a local copy first: a second supplier lane, more safety stock, more capacity.

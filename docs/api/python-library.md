# SuReSuite as a Python library — user guide

> **Status:** AUTHORED. Audience: analysts and engineers who want to work with
> their SuReSuite project in Python (Google Colab, Jupyter, scripts).

The app is built for people who do not write code. Some users want more: more runs
than the Simulation Lab is meant for, their own analysis in pandas, or a what-if on
data they are not ready to upload. For them SuReSuite is also a **Python library**:

- **Read** the data your API key may see — frozen dataset versions and policy versions.
- **Run** the platform's own simulation engine **on your machine** (laptop or Colab),
  not on the platform's compute. Same inputs give the platform's numbers.
- **Analyse** results with the helpers the app uses: KPI tables with 95 % intervals,
  paired A/B comparison, weekly series, charts.
- **Never write by accident.** Nothing in the library writes to the platform. Local
  runs and local edits stay on your machine.

## How it works

```
your project in the app ──freeze──▶ dataset version (rows + graph_hash)
                                    policy version  (snapshot + policy_hash)
                                          │  GET with your API key
                                          ▼
              your machine:  ss.dataset · ss.policy · ss.install_engine
                                          │
                                          ▼
                             ss.simulate(data, policy, scenario)  ──▶ results (API shapes)
```

- A **dataset version** is the input data exactly as a run reads it, frozen and
  identified by its `graph_hash`. A **policy version** is the configuration, frozen
  and identified by its `policy_hash`. Together with a scenario they fully
  determine a run.
- The **engine** is downloaded through the API (`GET /v1/engine`). Each file is
  checked against the sha256 the platform publishes before it is installed.
- `ss.simulate` calls the same function the platform's worker runs, so a local run
  of the same versions and scenario gives the same numbers.

## What you need

| | |
|---|---|
| Python | 3.10 or later (Colab works as is) |
| API key | A **personal** key from the app's **/developer** page. Scopes: `read:data` and `read:policies` to pull data and the engine; `read:runs` + `write:runs` to also run on the platform. Every user may create a read-only personal key; the write scopes need a key manager (admin or modeler) |
| Without a key | The notebooks run in **demo mode** on a small example project. Demo mode does not hand out the engine, so local simulation needs a key |

Keep the key out of your code: in Colab, add it in the **Secrets** panel as
`SURESUITE_API_KEY`; locally, `export SURESUITE_API_KEY="sk_test_…"`. A personal key
acts as you, stops working if you leave the organization, and every request is
logged under your name.

## Install

```bash
pip install "suresuite[plots,excel] @ https://<your-app>/python/suresuite-0.1.0-py3-none-any.whl"
```

(or download the wheel from `/python/` in the app and `pip install` the file).

## Quick start

```python
import suresuite as ss

api = ss.connect()                         # reads SURESUITE_API_KEY
ss.install_engine(api)                     # once per environment

project = ss.pick_project(api)            # or pick_project(api, "<project id>")
pid  = project["id"]
model = project["supply_chain_model"]      # the platform reads it; pass it to every local run
data = ss.dataset(api, pid)                # newest dataset version, with its rows
pol  = ss.policy(api, pid)                 # newest policy version
print(data)                                # table sizes and graph_hash

base  = ss.simulate(data, pol, replications=30, project_model=model)
shock = ss.simulate(data, pol, replications=30, project_model=model,
                    disruptions=[ss.outage("S2", start_day=140, duration_days=42)])

ss.kpi_table(base["run"])
ss.paired_compare(base["replications"], shock["replications"], ["fill_rate", "lost_sales_value"])
```

A what-if on your own copy of the data:

```python
sup = data.tables["suppliers"].copy()
sup.loc[sup.supplier_id == "S2", "capacity_per_week"] *= 2
ss.simulate(ss.with_tables(data, suppliers=sup), pol, project_model=model)
```

## Function reference

**Connect and pull**

| Function | What it does |
|---|---|
| `ss.connect(api_key=None, base_url=None, demo_data=None)` | A client. Uses `SURESUITE_API_KEY` if no key is passed |
| `ss.pick_project(api, project_id="")` | The given project, or the first one your key sees |
| `ss.dataset(api, pid, version="latest")` | A dataset version with its rows; `.tables` gives pandas DataFrames |
| `ss.policy(api, pid, version="latest")` | A policy version; `.snapshot` is the configuration |
| `ss.install_engine(api, version=None)` / `ss.engine_available()` | Install the engine — the current one, or an earlier version or exact build (sha256-checked) / check it is installed |

**Simulate locally**

| Function | What it does |
|---|---|
| `ss.simulate(data, policy, scenario=None, disruptions=None, project_model=None, **frame)` | Runs the engine here. `frame` overrides the scenario: `replications`, `horizon_days`, `seed`, … Pass `project_model=project["supply_chain_model"]`: the platform uses it for every product whose master sets no fulfillment mode, so without it a make-to-stock project runs make-to-order here. Returns `{"run", "replications", "series", "inputs"}` |
| `ss.with_tables(data, **tables)` | A local copy of `data` with some tables replaced |
| `ss.outage(target, start_day=140, duration_days=42, magnitude_pct=100)` | A disruption event. `target` is a **supplier id** of your project or `"plant"`; below 100 % it is a capacity cut |

**Read results** (work on platform runs and local runs alike)

| Function | What it does |
|---|---|
| `ss.kpi_table(run)` | Each KPI's mean and 95 % interval, labelled |
| `ss.replications_frame(replications)` | One row per replication |
| `ss.paired_compare(reps_a, reps_b, kpis, labels=("A", "B"))` | A vs B replication by replication (same random draws); says "better"/"worse" only when the 95 % interval excludes zero |
| `ss.plot_kpis(runs, kpis)` · `ss.plot_series(series_by_label, column, window=None)` | Bar chart with intervals · weekly lines with a shaded disruption window |
| `ss.export_run_workbook(api, run, scenario, path)` | The app's run-results Excel workbook, with its reproducibility sheet |

**Use the platform from Python** (consumes your organization's compute quota)

| Method | What it does |
|---|---|
| `api.key()` | Your key as the platform sees it now: the `scopes` it may use, `env`, `principal`, `project_ids` |
| `api.projects()`, `api.scenarios(pid)`, `api.policy_versions(pid)` | List what you can see |
| `api.freeze_dataset(pid, label)` · `api.snapshot_policies(pid, label)` | Freeze the current data / policies into a version (`write:data` / `write:policies`) |
| `api.run_and_wait(pid, scenario_id, policy_version_id)` | Run on the platform and wait; repeating it returns the same run |
| `api.run(id)`, `api.replications(id)`, `api.series(id)`, `api.validation(id)` | Read a platform run |
| `ss.editing_policies(api, pid)` | A `with` block: policy edits inside it are always put back afterwards |

## Reproducibility

Every local result records what it was computed from:

```python
shock["run"]["computed_by"]          # "client"
shock["run"]["dataset_version_id"], shock["run"]["graph_hash"]
shock["run"]["policy_version_id"], shock["run"]["policy_hash"]
shock["run"]["engine_version"]
```

When you report a number, keep these with it. Anyone with access to the project can
pull the same versions and get the same result. Data edited with `with_tables` has no
`graph_hash` — say so if you report from it.

If a local run does not match the platform, compare the build your run recorded
(`run["run"]["code_version"]`, `scsim-<version>+<digest>`) with the platform run's
`code_version`; after a platform upgrade, run `ss.install_engine(api)` again.

To re-run a stored result on the engine that produced it, install that build:
`ss.install_engine(api, version=platform_run["code_version"])`, or a version such as
`version="0.4.0"` for the newest build of it. Every build the platform has published
stays installable; the list, and what each version changed, is on the
"Engine versions & changes" page of the manual.

## Rules and limits

- **Read-only.** You cannot push data or results back yet. When that arrives, a result
  computed on your machine will be badged "client-computed" until the platform re-runs
  it and gets the same numbers.
- **Disruption targets** must be a supplier id of your project or `"plant"`. Material,
  customer and lane targets are skipped by the engine.
- **Quota.** Local runs use no compute quota. Platform runs (`run_and_wait`) do. API
  requests are rate-limited and logged against your key.
- **Your machine sets the speed.** The example project runs in a fraction of a second;
  a large project takes longer. Colab gives you a free machine.

## The notebooks

Six notebooks show the library in use. Download them from **/developer → Notebook**
with your project's ids filled in, or run them with no key in demo mode.

| Notebook | You will | Key needed |
|---|---|---|
| **00 · Quickstart** | Freeze data and policies, run a baseline, read KPIs, replications and the weekly chart | No (demo) |
| **01 · Policy experiment** | Change safety stock, compare A and B in a normal and an outage year, sweep four levels | No (demo) |
| **02 · Disruption and resilience** | Plant shutdown, supplier outages and a capacity cut; damage, recovery and the weekly dip | No (demo) |
| **03 · Simulate on your own machine** | Reproduce a platform run locally, a 20-run sweep, a second-supplier what-if | Yes |
| **04 · Component inventory: trace materials week by week** | Pick the versions, run or pull the baseline, knock out suppliers, and follow several materials week by week with and without the disruption | No (demo, with the engine installed); a read-only personal key for your project |
| **05 · Available to promise** | Can we give this customer Q units by this date? Stock position, available to promise, partial delivery, pull in, push back or split — with replenishment as it is and with the request's materials planned from the order book | No (demo, with the engine installed); a read-only personal key for your project |

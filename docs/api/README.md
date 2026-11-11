# SuReSuite Public API (v1) — Reference & Quickstart

The public API lets external systems — scripts, notebooks, CI jobs, partner
services — drive SuReSuite programmatically: manage input data, configure
policies, dispatch simulation runs, and retrieve results.

- **Design doc:** `docs/design/public-api-and-access-control.md` (G15)
- **Gateway:** `supabase/functions/api` (single entry point; every request is
  authenticated, scope- and tenancy-checked, rate-limited, validated, audited)
- **Key management UI:** the **Developer API** page (`/developer`) in the app

## Base URL

```
https://<project-ref>.supabase.co/functions/v1/api/v1
```

## Authentication

Every request carries an API key created on the Developer API page:

```
Authorization: Bearer sk_live_<keyid8>_<secret>
```

- Keys are org-scoped, carry explicit **scopes**, and can be restricted to
  specific projects. The secret is shown **once** at creation and stored only
  as a SHA-256 hash — rotate the key if you lose it.
- `sk_test_` keys are for integration work: much stricter rate limits and a
  single concurrent run.
- Rotation (`72 h` overlap) and revocation are instant, one click in the UI,
  and fully audited.

Identity comes only from the key. Nothing in the request body influences who
you are or what you may touch.

## Scopes

| Scope | Grants |
|---|---|
| `read:data` / `write:data` | read projects & dataset versions / freeze dataset versions |
| `read:policies` / `write:policies` | read catalog & configs / edit policies, snapshot versions |
| `read:runs` / `write:runs` | read runs & results / dispatch, cancel, extend runs |
| `admin:keys` | list/revoke keys over the API (usually humans use the UI instead) |

Missing scope ⇒ `403 missing_scope`. A key can never reach a project outside
its organization (or outside its project restriction) — those ids read as
`404`, deliberately indistinguishable from nonexistent ones.

## Rate limits & compute quotas

- Per-key request limits (defaults: live `120/min`, `5000/day`; test `30/min`,
  `300/day`). State is returned in `X-RateLimit-Limit / -Remaining / -Reset`;
  over-limit responses are `429` with `Retry-After`.
- Compute quotas on `POST …/runs`: max concurrent queued/running runs per org
  (default 5 live / 1 test) and an optional per-org replication ceiling under
  the global 200 clamp. A super admin can tier any org/key via the
  `api_rate_limits` table.
- Auth, authorization, and quota checks **fail closed**: if a backend needed
  for a security decision is unavailable, the request is denied (`503`).

## Idempotency

`POST …/runs` accepts an `Idempotency-Key` header. Retrying the same key within
24 h returns the **same** `run_id` (marked `Idempotency-Replayed: true`) instead
of dispatching a duplicate — safe retries, no double compute.

## Errors

All errors use one envelope; `X-Request-Id` is echoed on every response for
support/audit correlation:

```json
{ "error": { "code": "missing_scope", "message": "this key does not have the write:runs scope" } }
```

Notable codes: `invalid_key`, `expired_key`, `revoked_key` (401) ·
`quota_exceeded` (402 — the organization's monthly compute or its series storage,
or the member's share of either) · `missing_scope`, `replications_exceeded` (403) ·
`project_not_found`, `run_not_found`, `route_not_found` (404) · `validation_failed`
(422, includes the data-gate findings) · `rate_limited`, `daily_quota_exceeded`,
`concurrent_runs_exceeded` (429) · `payload_too_large` (413).

`POST …/runs` is admitted against the organization's plan in the database, the same
check the app's own runs go through: the key's `max_concurrent_runs` and
`max_replications` fold into the plan's (the stricter wins), a refusal's `message`
carries the numbers, and a reuse (`409 reuse_available`) or an identical run already
in flight consumes nothing.

## Endpoints

| Method & path | Scope | Returns |
|---|---|---|
| `GET /projects` | read:data | org's projects (cursor-paginated: `?limit=&cursor=`) |
| `GET /projects/{id}` | read:data | one project |
| `POST /projects/{id}/datasets:freeze` | write:data | `201` dataset version + `graph_hash` (deduped server-side) |
| `GET /projects/{id}/dataset-versions` | read:data | provenance history |
| `GET /projects/{id}/dataset-versions/{version}` | read:data | one frozen dataset version **with its rows** (`snapshot`: v2 `inputs` = what a simulation reads, `network` = what the analyses read); `{version}` is an id or `latest`; `?tables=suppliers,inbound` narrows it; gzip when the client accepts it |
| `GET /projects/{id}/policy-catalog` | read:policies | engine policy catalog (registry export — the same contract the UI forms use) |
| `GET /projects/{id}/policies` | read:policies | policy defaults + per-node overrides |
| `PUT /projects/{id}/policies` | write:policies | update defaults (`{"defaults":{"inventory":{…}},"overrides":[…]}`) via the same RPCs the UI uses |
| `POST /projects/{id}/policy-versions` | write:policies | `201` immutable snapshot + `policy_hash` |
| `GET /projects/{id}/policy-versions` | read:policies | snapshot history |
| `GET /projects/{id}/policy-versions/{version}` | read:policies | one frozen policy version with its `snapshot` and `policy_hash`; `{version}` is an id or `latest` |
| `GET /projects/{id}/scenarios` | read:runs | scenarios (paginated) |
| `POST /projects/{id}/scenarios` | write:runs | `201` new scenario (horizon, replications, seed, disruptions…) |
| `POST /projects/{id}/runs` | write:runs | `202 {run_id, status, policy_hash, graph_hash, gate_skipped}`; body `{"scenario_id","policy_version_id","acknowledge_warnings"?,"force_rerun"?}` |
| `GET /runs/{id}` | read:runs | status, aggregate KPIs, CI half-widths, provenance hashes, `gate_skipped` |
| `GET /runs/{id}/replications` | read:runs | per-replication KPI rows (cursor = rep index). `?include=time_series` adds a top-level `series` object: a short-lived signed URL to ONE Parquet file of every weekly series in long form (`rep_index, model_rep, event_rep, week`, one column per series), or `expired` with the RunKey that reproduces it — the rows' own `time_series` is `{}` for runs since WP 10.6 |
| `POST /runs/{id}:cancel` | write:runs | `202` cancel |
| `POST /runs/{id}:add-reps` | write:runs | `202` — **accepted but has no effect today**: the worker has no handler for the command it queues. Dispatch a scenario with more replications instead |
| `GET /runs/{id}/validation` | read:runs | credibility badge: `validated` / `stale` / `unvalidated` + the model-validation card |
| `GET /engine` | read:data | the simulation engine for your own machine: per wheel, its sha256, size and a 10-minute signed URL (`suresuite.install_engine()` uses it). Every fetch is logged |
| `GET /key` | any key | the calling key: `key_prefix`, `env`, `principal` (`personal`/`org`), `scopes` it may use NOW (a personal key whose owner does not manage keys is cut to the read scopes) and `project_ids`. The notebooks check it before they start |
| `GET /keys` | admin:keys | org's keys (never the secret) |
| `POST /keys/{id}:revoke` | admin:keys | kill switch over the API |

Runs are **asynchronous**: dispatch returns `202` immediately; poll
`GET /runs/{id}` with backoff until `status ∈ {done, failed, cancelled}`. The
lifecycle is `queued → running → done | failed | cancelled` — a finished run is
`done` (an earlier version of this page said `succeeded`, the vocabulary of the
analysis store, and a client written to it polled a finished run forever).
`:cancel` answers `cancelled` even for a run that had already finished; read the
run back to see its real status.
(Webhooks and scoped realtime tokens are the planned push options — design doc §9.)

## Quickstart

```bash
export SURESUITE_API_KEY="sk_test_…"   # from the /developer page
BASE="https://<project-ref>.supabase.co/functions/v1/api/v1"

# list projects
curl -s "$BASE/projects" -H "Authorization: Bearer $SURESUITE_API_KEY"

# snapshot the current policy configuration
curl -s -X POST "$BASE/projects/$PROJECT/policy-versions" \
  -H "Authorization: Bearer $SURESUITE_API_KEY" \
  -H "Content-Type: application/json" -d '{"label":"api quickstart"}'

# dispatch a run (idempotent)
curl -s -X POST "$BASE/projects/$PROJECT/runs" \
  -H "Authorization: Bearer $SURESUITE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: quickstart-1" \
  -d "{\"scenario_id\":\"$SCENARIO\",\"policy_version_id\":\"$VERSION\"}"

# poll until "status" is done, failed or cancelled
curl -s "$BASE/runs/$RUN_ID" -H "Authorization: Bearer $SURESUITE_API_KEY"
```

A Python end-to-end example (snapshot → dispatch → poll → replications) is on
the Developer API page's Quickstart tab.

### Python notebooks (Google Colab or local Jupyter)

Six notebooks, each the Python version of one workflow in the app. Get them from
the `/developer` page's **Notebook** tab, which lists your projects and, per
project, every id the notebooks need, and downloads any of them with the CONFIG
cell pre-filled. **Open in Colab** downloads the same pre-filled copy and opens
Colab for *File → Upload notebook* — it never links Colab to the source
repository, which is private.

| Notebook | Mirrors in the app |
|---|---|
| `suresuite_00_quickstart.ipynb` | Simulation Lab: freeze data, snapshot policies, run a baseline, read KPIs ± CI, replications, weekly series, credibility |
| `suresuite_01_policy_experiment.ipynb` | /policies edit → Save version → Lab Compare: A vs B on common random numbers, paired by replication, plus a safety-stock sweep |
| `suresuite_02_disruption_resilience.ipynb` | Lab stress tests: plant shutdown, sole- and dual-source supplier outages, a partial capacity cut; time to survive / recover |
| `suresuite_03_local_simulation.ipynb` | Simulate on your own machine: pull a dataset and policy version, reproduce a platform run exactly, sweep 20 scenarios locally, a what-if on your copy of the data |
| `suresuite_04_component_inventory.ipynb` | /policies → Run & validate → Single (Inspection mode), for the materials and products you choose, in three steps: the versions (the engine, data and policies the runs read — the latest, or pinned), the experiment (replications, seed, an optional disruption, run on your own machine and paired with the baseline), and the trace (several materials and their products week by week, a panel each and all of them on one map) |
| `suresuite_05_available_to_promise.ipynb` | Answer a request the way a planner does: a make-to-order request for a product (or material taken from stock) by a date — the stock position and available to promise of each material it needs, then the request played through the chain as a firm order served after every existing customer, in N futures: yes, or how much on time and when the rest, a pull-in, a push-back or a split delivery, what it costs existing customers, and the same answer with the request's materials planned from the order book (MRP) |

**Two modes.** With no key the notebooks run in **demo mode**: they replay engine
output recorded for the Example project (`scripts/example_project/dataset.json`,
recorded by `notebooks/tools/record_demo.py` through the worker's own path), and
refuse — never invent — anything they have no recording for. With a key from
Colab's Secrets panel or the `SURESUITE_API_KEY` environment variable, the same
cells run on your project. Locally:

```bash
python -m venv .venv && source .venv/bin/activate
pip install jupyterlab requests pandas matplotlib pyarrow openpyxl
export SURESUITE_API_KEY="sk_test_…"
jupyter lab
```

**Live smoke test** (CI runs every notebook in demo mode, but cannot hold a key):
upload `suresuite_00_quickstart.ipynb` to Colab with a `sk_test_` key on the
Example project, *Run all*, and check the run reaches `done` and the weekly series
load. Run `01` and confirm the project's policies read the same afterwards.

### The `suresuite` Python package — simulate on your own machine

For scripts and your own notebooks: `pip install` the wheel the app serves at
`/python/suresuite-0.1.0-py3-none-any.whl` (built from `python/` and kept in step by
`scripts/build_python_package.sh --check`). With a key it pulls a dataset version's
rows (`ss.dataset`) and a policy version (`ss.policy`), installs the engine through
`GET /engine` with each wheel's sha256 checked (`ss.install_engine`), and runs it on
YOUR machine (`ss.simulate`) — the same function the platform's browser engine runs,
so the same inputs give the platform's numbers. `ss.with_tables` makes a what-if on
your local copy. Nothing in the package writes to the platform. The user guide is
[`python-library.md`](python-library.md); the package's own notes are `python/README.md`.

**Authoring.** The notebooks are generated: edit `notebooks/src/*.py` (percent
format) and `notebooks/src/common/*.py`, then `npm run notebooks:build`.
`npm run notebooks:check` (part of `npm run lint`) fails on a stale build, on a
CONFIG cell that differs from the one `/developer` writes, and on content a
customer must not receive. See `notebooks/README.md`.

## Security model (summary)

See the design doc §10 for the full STRIDE analysis. In brief: hashed
show-once keys; identity never taken from the request body; tenancy checked at
the edge **and** re-verified in the database (`api_can_access_project`);
service role held only by the gateway; per-key rate limits + per-org compute
quotas; append-only `api_request_logs` for every request and
`admin_audit_logs` for every key lifecycle event; auth/authz/quota failures
fail closed; 401 storms are throttled by IP.

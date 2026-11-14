# SuReSuite — session guidance

## Governing document — read before platform work

Any work touching the simulation platform — policies UI, data model, engine, worker,
experimentation, AI/surrogates — must first consult the design blueprint:

**`docs/design/next-gen-platform-design.md`**

Where to look inside it:

- **§2.3 Gap catalog (G1–G12)** — the numbered problems the plan closes; check which gap your task serves.
- **§13 Roadmap (Phases A–E)** — where the task sits in the sequence and its exit criteria.
- **§5 + Appendix A — policy catalog** — before adding or changing any policy, find its row (or add one).
- **§2.2 Preserved assets (A1–A15)** — design decisions that must not be broken.

## The plan — the authority for the data layer

`docs/design/next-gen-platform-design.md` says what the platform becomes.
**`docs/PLAN.md` is the single plan for getting the data layer there** — architecture,
confirmed defects, the transparency standard, the documentation manual, the work
packages, the verification SQL and the drift log. There is no second plan; the two
documents it replaced (`TRANSPARENCY.md`, `USER-DOCS-PLAN.md`) were folded in because
duplicating facts is the defect the plan exists to end.

- **§4 is the only authority for data-layer `file:line` evidence.** Anything about the
  CSV parse, ingestion, the ETL, the policy grid, the engine mapping or the migrations
  cites §4 by D-number or §4.1 row — it does not restate the line numbers. A citation
  that lives only in another document is a fact with no owner, and it goes stale within
  a quarter (D21 and D22 are what that looks like).
- **`npm run check:docs` enforces it** (`scripts/check-docs-single-source.mjs`): a
  markdown file outside the allow-list may not carry data-layer evidence at all, and an
  allow-listed *derived* file (today only `docs/PLAN-PROMPTS.md`) may not hold a fact
  the plan lacks. It runs as part of `npm run lint`.
- **Every work package ends with a gap check and a §16 drift-log entry** — what the
  previous package promised versus what this one found. If a finding changes a later
  package, edit the plan in the SAME commit.
- Commit convention: `Phase N / WP N.M / <blueprint ref>: <title>`.

## The invariants (PLAN.md §2.1) — by gate name

**Every invariant has a NAME, and you cite the name.** The plan's `§2.1` table
numbers four of them `G1`–`G4`, and the blueprint numbers eighteen *gaps* `G1`–`G18`;
on one page "G4" means both "every tier transition writes an audit row" and "no
data-entry surface for the economics". Names do not collide. `PLAN.md §2.1` remains
the authority for the statements; this table adds what the plan cannot — **where
each one is enforced today, and where it is still only a promise.**

Each is meant to be a CI gate, not an aspiration — anything unenforced drifts within
two months, which is the lesson of the two orphan tables (D3, D4, both closed in
WP 1.4). Gates land with their work packages; the rule holds from now.

| Gate name | §2.1 | Invariant | Enforced today by |
|---|---|---|---|
| `single-source` | I1 | Every data fact is authored exactly once; docs/validators/RLS generate from it | `check:docs` · `contract:check` R3 (page drift) · **and the enforcement stops at markdown, which Phase 5 found three times.** D101: "which columns an analysis writes" was authored twice — prose in four sidecars and a literal Set in `graphHashCoverage.test.ts` — closed by declaring `computed_by` in the contract, which that suite now derives from (18 of 18, byte-identical). D103: the Data Trust Report published two "known limits" that WP 5.3 and WP 6.2 had closed, to users, on every project — CLOSED, and gated: `trustReportLimits.test.ts` checks every `§4 D<n>` a limit cites against §4's "Closed by" column. D105: `dataset_versions.hash_network`'s own description was two tables behind the migration that changed it — closed. **The class is a prose fact about the data layer authored outside §4, in TypeScript rather than markdown, with nothing comparing the two.** `check:docs` cannot see any of it. **D127 is the largest instance yet and it is not prose — it is a node's TYPE, authored EIGHT times**: `classify_node_type` in SQL, four page-level classifiers, `MapView`'s binary test and the engine's master-table read, none of which reads a type because **no type column exists on either edge table**. Eight answers for one node, disagreeing by construction, with nothing comparing them — **AUTHORED ONCE SINCE WP 8.1** — `node_list.echelon`, CHECK-constrained, derived by `classify_node_echelon` reading BOTH edge tables, with `subassembly` as a value no page could express; the legacy `classify_node_type` is now a MAPPING from that rule rather than a second priority order beside it, so the two cannot drift. **AND NO PAGE READS THE COLUMN YET**: the pages read its declared mirror, `typedNodesFromLanes`, because the column deploys on merge. The render-time classifiers are down to ONE — `oneClassifier.test.ts` is the ratchet, 6 → 4 → 2 in WP 8.3/8.4 and 2 → 1 in audit WP 7 (F-09, where `/interactive-network-space`'s ladder called every product a material). Both lane pages now place nodes through one call, `placeLaneNodes`. What remains is `FirmLevelNetwork`'s `getTierFromDepth`, and the gate refuses a ninth, and D140 was what that looks like one layer down — TWO live ETLs writing `supply_chain_data_multi_tier.level` by different rules, so no reader could be correct. **CLOSED by WP 8.2**: one writer, and `bom_depth` read from `bom_multi_level`, the table that owns the measurement; `level` carries the same value as a deprecated alias for one release. The same package found the general form of it twice more — **D150**, D2 fixed in ONE of the two writers so the DEPLOYED one read every lane `volume` raw for another year, and a third instance of D145 where one read path had two live definitions, so D134's fix would have landed in one and been false of the other under one name. **A fix applied to one of two writers of one table is not a fix** **WP 11.2 closed D264 the same way, for the engine's read set**: the tables `datamap.py` reads and the tables the snapshot's `inputs` domain hashes (the `simulation` scope every Validated Model and RunKey binds) are two authors of one list, and `simulationScopeParity.test.ts` parses both and fails when either gains a table the other lacks. |
| `no-tier-skip` | I2 | No tier skipping — external data never lands below T1; pages never write T3 | **MET for every CSV dataset the contract describes, since WP 3.3.** All TEN land in tier 0 (`ingest_files`) and tier 1 (`ingest_staged_rows`) and reach tier 2 only through `ingest_apply_run` — the item masters joined in `20260916000020` once the promotion became an upsert (D55), and `customers` in `20260919000001` because WP 6.1's G4 gate fired on the two `Customer` fields WP 6.2 declared and the only honest way to satisfy it was to give the table a surface (D94, D108). `rehearsal/070`, `090` and `230` prove it against a real database, and `ingestSpecParity.test.ts` fails if a `.split(',')` or a `bulk_upsert_*` call returns to the client. **One group still skips and it is named**: the node list and the two deep-tier network tables (D56, WP 4.2), which have no sidecar because WP 4.2 owns the decision about what tier they are. **WP 4.3 DESCRIBED THEM**: all four now carry sidecars at tier 3 — what `graphHashCoverage.test.ts` has treated them as since WP 4.1 — so they are inside the contract, inside the audit rule, and no longer a group nothing can see. They still reach their tables through the four bulk RPCs rather than through `ingest_land_file`, so the SKIP itself is unchanged; what changed is that it is a described skip on a described table. Calling the uploaded half tier 2 is WP 5.3's, after the computed columns go — sooner would fold an analysis's output into the identity of its own inputs (D56, D75). **WP 4.1 turned three more paths from a property of code into a property of the schema**: the three legacy `ingest-*` functions write through `ingest_legacy_upsert_lane`, whose target list is a whitelist in a migration — while they held a PostgREST client they were one `.upsert()` away from any tier-2 table. **That is true of the REPOSITORY and not of production (§4 D168)**: all three functions' live builds were last deployed 2026-03-17, six months before WP 4.1, so the code a user reaches predates the change. It also closed a path nobody had named: `erp-sync-orbit-mrp` promoted `ingest_staged_products` → `products` WITHOUT `ingest_apply_run`, per row, with no actor and no role. Still no gate saying a NEW dataset must land — enforced for the ten by the absence of any other write path, not by a check. **And the promotion's one-column-list-per-run design has a cost that was live for three packages (D120)**: a column ONE row supplies is written for EVERY row, so a blank optional cell in a NOT NULL DEFAULT column aborted the whole upload. `ingest_promotion_plan` wraps such a column in `COALESCE` against the default it reads from `pg_attrdef`; `rehearsal/230` §9 proves it on `suppliers`, where it had been live since WP 3.3 and no template ever exercised it |
| `normalize-at-promotion` | I3 | Units normalize at promotion into T2; nothing downstream converts | `contract:units -- --check` (one `UNIT_DAYS`) · **the promotion converts since WP 3.3**: `ingest_apply_run` calls `rate_to_weekly`/`duration_to_weeks` INSIDE the promoting statement and writes the canonical token into the unit column, so a tier-2 row states what it is in. Authored in the sidecars (`unit_column` + `normalize_at_promotion`), restated in `ingest_normalize_at_promotion()` because SQL cannot import the generated module, and pinned by `ingestSpecParity.test.ts`; asserted in `rehearsal/090` (30.4375/month → 7/week, 14 days → 2 weeks, idempotent on re-promotion). **The second clause is NOT met**: THREE readers still convert — `rebuild_supply_chain_lanes`, `sc_nodes`, and the one the engine reads, `project_map.py`'s `_duration_to_weeks`/`_rate_to_weekly` on every lane's lead time and volume (named by audit 2026-09-22 D-2; this row listed two). Each is exactly identity for promoted rows (×7/7) and still load-bearing for rows predating this path. Removing them is a reader change across the ETL and `project_map.py`, owned by no package yet. **And WP 8.2 measured why the conversion had to STAY in the deployed writer rather than being dropped with the edge function's**: the SQL RPC never had one. D2 was closed in `combine-project` by WP 0.2 and the RPC read all eight `volume` sites raw until WP 8.2 (D150), so "downstream still converts" described the half that was not running |
| `natural-key` | I4 | Every canonical table has a natural-key unique constraint; ingestion upserts | **MET since WP 3.3.** `contract:check` R5 is a **`fail`**, flipped in the same commit that created the seven unique indexes (`20260916000018`) so neither half can outlive the other. R5 has two halves: a tier-2 table whose only uniqueness is the surrogate `id` fails, AND a table whose landed key differs from its sidecar's `natural_key_intended` fails. Every index is `NULLS NOT DISTINCT` — three of the seven keys contain a nullable column, and a plain index would constrain every row EXCEPT those while `ON CONFLICT` inserted duplicates rather than updating (§4 D5). The ingestion upserts: `ingest_apply_run` reads the arbiter from `pg_index` and raises rather than guessing. `rehearsal/080` + `090`, mutation-tested. **WP 3.4 made the key load-bearing in a second place and did not restate it**: `ingest_promotion_plan()` was lifted OUT of the promotion so the diff compares the columns the upsert would write, with the same normalized values, joining on `IS NOT DISTINCT FROM` because three of the seven keys are `NULLS NOT DISTINCT` — `rehearsal/100` §6 fails if it regresses to `=` |
| `diff-before-decision` | — | A review screen's diff is computed against tier 2 BEFORE the promotion, and re-computed inside it | `ingest_diff_run`, called at landing, on demand, and by `ingest_apply_run` in its own transaction · `ingestDiffReview.test.ts` (the DEFAULT and NOT NULL are gone; the promotion no longer overwrites the split) · `supabase/rehearsal/100`, eight mutations. **The two answers are cross-checked**: `xmax = 0`'s count of rows that already existed must equal the diff's `changed + unchanged`, and a disagreement raises rather than reporting a promotion that did something else (WP 3.4, D62–D64) |
| `input-hash` | I5 | Every derived row carries the input hash it came from | **not yet — and the OWNER in this row was wrong, which `20260917000002` found by finishing.** `20260917000002` completed the HASH: `graph_hash` covers every tier-2 value column, splits into `hash_inputs` / `hash_network`, and `graphHashCoverage.test.ts` fails when a column goes missing (D11, D67, D68 closed). But I5 is about the DERIVED ROW carrying it, and no tier-3 table has a `computed_from_hash` column. **`20260917000006` built the STORE that will**: `analysis_runs.input_hash` is written on every run from `current_graph_hash`, and `supabase/rehearsal/120` §2 fails if a run records a hash the project does not have — so the anchor now lands IN A ROW for the first time, and a run is reproducible. The invariant still is **NOT met**, because a run row is not a derived row: the four analyzers still write centralities onto `network_nodes` with nothing saying which inputs produced them (D19, measured at 1 385 such rows). **`20260917000007` LANDED THAT HALF**: `computed_from_hash` + `computed_at` on `network_nodes`, `node_list`, `network_summary` and `supply_chain_data` (not `network_edges` — every column of it is uploaded, and provenance no writer could fill is a promise, not a fact), written by `analysis_apply_node_metrics` and `analysis_mark_critical_nodes` FROM THE RUN rather than from a parameter, so a row cannot name a world its run never saw. `supabase/rehearsal/130` §2 compares the entity columns against `analysis_results` field by field and §3 fails if a row carries the wrong hash or an unwritten row carries any. **AND I5 IS STILL NOT MET, for a reason `20260917000007` found rather than inherited — D75.** `input_hash` is `current_graph_hash`, which hashes eleven tier-2 tables, and the two centrality analyzers read `network_nodes`/`network_edges`, neither of them: a re-uploaded network moves no hash, so the anchor a derived row now carries is blind to that row's own inputs. Mitigated by a DECLARED `topology_digest` in `analysis_runs.params`, which makes the cache key sound without moving a stored hash; **THE ANCHOR IS FIXED — D75 CLOSED BY `20260917000009`.** The deep-tier topology is in `hash_network`: exactly the six columns the two prominence RPCs return, `schema_version` 2 → 3, taken against §15's measured blast radius of zero. It folded BY COLUMN rather than by the tier change, because that route is blocked — **D88**: 8 577 of 8 577 derived rows carry no input hash and the store holds 0 runs and 0 results, so the computed columns cannot be dropped without destroying 8 577 values. **I5 IS STILL NOT MET AND D88 IS NOW THE WHOLE OF WHY**: every derived row that exists predates provenance. The dual-write is correct and shipped; what is missing is that nobody has RUN an analysis since. The precondition is adoption, not code, and the unblocking condition is a number in §15 — `analysis_results` non-zero and `computed_from_hash IS NULL` falling. Owned by **WP 6.5, deliverable (b)** with the drop — moved there by WP 6.3 because the precondition is ADOPTION IN PRODUCTION: a §15 read, a deploy, analyses actually run, and a second §15 read, which no package that ends at a merge can contain. **WP 6.3 shipped the half that makes the wait honest**: `get_network_metrics_for_materials` prefers the store, falls back to the column and SAYS WHICH at the point of display (`rehearsal/250`, five node states, mutation-tested). `geocode-locations` remains the other gap: it writes `node_list` coordinates with no run at all (D36's class). **`20261001000007` (Phase 10's level package) made the anchor a run carries the hash of the LEVEL it read** — `analysis_kinds` states each kind's scope once (product · process · firm · all), `analysis_runs` records `input_scope` and `dataset_version_id`, and the project's current hashes are STORED (`project_graph_state`), so a price edit no longer invalidates a centrality and a reload no longer rebuilds a snapshot (`rehearsal/570`, D233–D239). That sharpens I5; it does not meet it — D88's 8 577 rows still predate provenance |
| `declared-fallback` | I6 | A fallback absent from the contract may not exist in code | `contract:validate` (`engine.missing_default`) · `contract:generate` fails when the engine registry names a required field the contract has no column for |
| `ingestion-contract` | I7 | A new source implements the ingestion contract; it never touches T2 schemas | **PARTIAL since WP 3.1.** The tables are source-agnostic (`ingest_runs`, `ingest_staged_*`, `ingest_files`, `ingest_staged_rows`, with `source_kind` and `fact_class` CHECK-constrained and no DEFAULT) and `supabase/rehearsal/050`+`060` prove against a real database that a link-less run is governed and that staging reaches T2 only through a promotion. **The second source exists in the REPOSITORY since WP 3.2** — `ingest-file` implements the contract and touches no T2 schema: `rehearsal/070` asserts the whole path and `ingestSpecParity.test.ts` fails if the function names a tier-2 table or a CSV header of its own. **AND IT WAS NOT PUBLISHED, WHICH THIS ROW ASSERTED FOR FOUR PACKAGES — D123.** The deploy workflow named six of eighteen functions and `ingest-file` was not among them, so "a live second source" was true of `main` and false of production, and every CSV upload WP 6.2 routed through it was unreachable. `rehearsal/070` could not notice: it proves the DATABASE path and says nothing about whether the function reaching it is published. WP 6.3 wrote **R17**, which fails a function that is neither deployed nor deferred to a named package — and fails separately one with a deploy step and no push path. **WP 6.5 (a) MADE THE SWITCH.** WP 6.3 had added the deploy step and reverted it, because publishing it moves every upload in production onto the landing path Phase 3 built, all at once, and a §15 reading was owed either side — which no branch can take, since the workflow is `branches: [main]`. WP 6.5 (a) took the BEFORE read over all eleven projects (§15 run `35781287043`: D156's keys to `approved_users`, bucket `ingest` present and private, `ingest_runs`/`ingest_files`/`ingest_staged_rows` all 0, fence unmoved), then added the deploy step and push path and removed the register entry in ONE commit, because R17 refuses the state in between. **AND THE AFTER READ SAYS IT IS NOW A PRODUCT** (§15 run `35787833840`, pushed after the merge per D153): 10 files and 290 staged rows landed, 3 runs promoted, and tier-2 rows in `bom_single_level`, `inbound_logistics` and `outbound_logistics` resolve through `ingest_value_chain` to their file and line, with no table below the baseline. The first upload also found **D169**: the review screen read its run as `anon` through a `TO authenticated` policy, got zero rows and rendered nothing, so no upload could be promoted until `ingest_run_review` (`20260922000001`) gave it a read that names its reader. Its accepted side effect was D161: the first person who uploaded a CSV could not be deleted from `approved_users` — **CLOSED by `20260930000007`**, WP 7.2 option (a): the upload is kept and its uploader anonymised. **Still a reading, not a check, for the NEXT source**: nothing forces a third one through `ingest_land_file` |
| `result-binding` | I8 | Every result binds dataset + policy + scenario + engine version | **MET FOR EVERY RUN DISPATCHED SINCE WP 10.4 (`20261001000009`); NOT MET FOR D88'S HISTORY.** A new run row carries its registered engine (`engine_id`), the whole identity as data (`run_spec`: engine build, `policy_hash`, `graph_hash`, the scenario's run spec, deviations), its `run_key` (sha256 of that spec), the Validated Model it follows (`model_validation_id`), `protocol_overrides` and `exploratory` — written by ONE insert path, `create_simulation_run`, and `rehearsal/590` §5 edits the live scenario after dispatch and proves the run's record does not move. The A5 record reads all of it from the row. What stays unmet is the rows that predate it: 8 577 derived rows and every earlier run, which bind through the three hashes, seed and schedule and SAY what they lack (the new bindings are `recommended`, so history is not made unreproducible by a column it could not have had). The drop that would close D88 is still **WP 6.5's, deliverable (b)**. **Before WP 10.4 it read: STILL NOT MET, and WP 6.3 shipped the ARTIFACT that states it.** `reproducibilityRecord.ts` (A5) binds nine parts — dataset version + `graph_hash` + hash schema version, policy version + hash, the scenario with its disruption schedule and root seed — **both read from the RUN since audit WP 8** (`simulation_runs.seed` / `disruption_schedule`, stamped at dispatch; an older run binds the live scenario row only when it is provably unchanged since dispatch, and otherwise binds nothing with the reason — before WP 8 the seed came from the live row and the schedule was not bound at all), the worker's `code_version`, the browser build, and the analysis runs behind any network figure — each as a `Binding` that is either a value with its source or `null` WITH a stated reason, so `reproducible` is COMPUTED from the required bindings rather than asserted. It reaches a user as a `reproducibility` sheet in the run-results workbook, and `reproducibilityRecord.test.ts` holds 23 assertions over it. **What is not met is the INVARIANT**: a result ROW still carries no binding — the record is assembled at export time from rows that could each have been written by a different world, and `analysis_results` is the only store that binds anything to a hash. The remaining gap is D88's: 8 577 derived rows predate provenance, and the drop that would make a result row carry its binding is **WP 6.5's, deliverable (b)**. **This row had a wrong owner once before and the way it got one is worth keeping**: `20260917000008` re-homed it to a package §11 scopes to staleness and the Trust Report — an owner nothing behind it had agreed to, which is exactly what `contract:check` R8 exists to catch, and the ten table deferrals that pointed at the same package are the other half of that story **Since WP 11.2 (`20261001000020`) the RunKey's graph term is the SIMULATION scope** (`hash_inputs`, RunKey v2) and the run row binds `hash_simulation` and its version beside the composite, so a deep-tier upload no run reads no longer makes an identical simulation a new key; v1 specs are never rewritten. |
| `page-equals-run` | — | For a given dataset version and policy version, the value /policies shows in a cell is the value the engine receives, or the cell says at the point of display that the engine does not read it — and /policies writes no item master (PLAN.md §23) | **MET SINCE PHASE 13 (§23, §4 D280 closed).** `pageEqualsRun.test.ts` resolves every master-backed cell of `scripts/example_project/page_equals_run.json` through the page's own resolver and compares value AND source with what scsim's mapper gave the engine (`MappingResult.resolved`, held current by `sim-worker/tests/test_page_equals_run.py`): zero differences, mutation-tested. Every other cell reaches the engine on its stage or is badged "not simulated" — generated from `POLICY_BUNDLE_KEYS[].scopes`, which `test_declared_scopes_are_the_scopes_the_mapper_reads` proves by perturbing every key at every scope. `policiesNeverWriteMasters.test.ts` + `rehearsal/760`: no master write from /policies (a cost, MOQ, capacity, price or demand is a row OVERRIDE read override → master → lanes → default). `test_frozen_inputs.py`: the worker computes from the run's frozen dataset and policy versions only (worker = package = browser); `rehearsal/770`: a run of a Validated Model reads the model's own two versions; `rehearsal/780` + `policyBundleDefaultsSql.test.ts`: a policy version stores the defaults the page shows. All of it runs as the `page equals run` job in `data-contract.yml`. **Not covered**: the browser Back button drops drafts unasked; values earlier /policies saves wrote INTO masters stay there (indistinguishable from uploads); D283 (no project-default controls) is open |
| `plan-from-demand` | — | Planned production and every MRP order derive from projected finished-good demand (the customer table's forecast or mean, per customer × product row) and the FG policy; **the plan never reads the realized future demand draws** (PLAN.md §24.2) | **MET SINCE PHASE 14 (WP 14.6).** Four honesty tests perturb the drawn schedule beyond the current week and require every plan value to stay put: `test_projected_demand_never_reads_the_drawn_future` (WP 14.1, the projection), `test_the_plan_does_not_read_future_draws` (WP 14.4, planned production and the FG requirement), `test_gross_requirements_and_orders_do_not_read_future_draws` (WP 14.5, gross requirements and MRP orders). `test_golden_7_the_worked_example_week_by_week` reproduces the design's worked MRP example exactly (orders 250/250/250 in weeks 1–3, arriving 3–5). Byte-identity for projects that set no new field is the frozen digests (`scsim/tests/data/golden_digests.json`, `sim-worker/tests/data/golden_runs.json`, WP 14.0), and the published comparison `docs/research/mrp-vs-reorder-point.md` is regenerated and byte-compared by `study_demand_driven_planning.py --check` in `scsim-tests.yml`. All of it runs in that workflow. **Not covered**: multi-stage (WP 14.7, owner decision); a step only the realized demand knows is not anticipated BY DESIGN — that is the study's forecast-bias case, not a breach; D285 (products cannot be uploaded with `normal`) is open |
| `engine-ledger` | — | Every engine build that produces a result is recorded once and immutably, archived so it can be installed again by version, and described by a change record a user can read on /docs; a behaviour change without an `ENGINE_VERSION` bump and a change record fails CI (PLAN.md §25) | **MET IN THE REPOSITORY SINCE WP 15.6 (§25); production is read by WP 15.7 after the merge.** The change record (WP 15.4), the build identity (WP 15.1), the build ledger (WP 15.2), the archive (WP 15.3), the release report (WP 15.5), and the /docs page "Engine versions & changes" with every engine-naming surface linked to it (WP 15.6, D297 closed). **Rule 8 since WP 15.5**: `release_report.py --check` (`sim-worker` job) regenerates `scsim/docs/releases/<version>.{md,json}` — this build against the previous version's archived build on the reference set, same seeds — and the change record may not understate it. **Any change under `scsim/scsim/` or the worker's compute path means: bump or amend `CHANGELOG.yaml`, rebuild the wheels, re-record the demo, regenerate the release report.** Every published build is in the bucket's append-only `versions.json` and installable by version or exact build (`GET /v1/engine?version=`, `suresuite.install_engine(version=…)`); `scripts/verify_engine_archive.sh <ref>` reproduces a build's own frozen results from its wheels alone (D295 closed). `sim_engine_builds` records every build a boot report, a run row or history names, append-only (`rehearsal/820`); a build is withdrawn with a reason, never deleted, and dispatch refuses a withdrawn current build (D292 closed). A run's `code_version` is `scsim-<ENGINE_VERSION>+<12 hex>`, a digest of scsim's source and the worker's compute path (`sim_worker/build.py` `COMPUTE_MODULES`, which `test_engine_build.py` holds equal to what a run loads); the browser manifest names the same build, and `build_engine_wheels.sh --check` fails when they differ (D293, D294 closed). `scsim/CHANGELOG.yaml` is the one source for what a version changed (D296 closed). `scsim/scripts/engine_changelog.py check --base auto` runs in `scsim-tests.yml`: (1) `ENGINE_VERSION` has its entry; (2) a moved frozen digest is a bump whose entry lists exactly the moved runs; (3) a pipeline contract change is Tier 3 with an ADR; (4) `identical` only when nothing moved; (6) engine source changed with no bump ⇒ an appended amendment; (7) nothing published is rewritten. `test_changelog.py` mutation-tests every rule. **Bump the version or append an amendment in the same commit as any change under `scsim/scsim/`.** |
| `uuid-identity` | G1 | Orgs/projects/users referenced by uuid; a displayable name is never a join key | `orgIdentity.test.ts` (no live policy, function or edge function compares an org string outside the one predicate) · the predicate itself is **uuid-only since WP 3.0** (D29) · `supabase/rehearsal/040` proves against a real database that a rename still matches and a shared display name does not. **The last exception is CLOSED (§4 D47, WP 6.2)**: `20260918000001` made the `organizations` row read uuid-only too, and `rehearsal/160` proves it four ways (own row still readable, namesake not, rename still matches, the slug branch gone). What that migration could not make structural is the uuid itself: `approved_users.organization_id` is stamped by a trigger that REFUSES TO GUESS between two same-named organizations, and `NOT NULL` on it is unsafe until the `default_org` question is answered — §4 D96, owned by WP 7.1 |
| `declared-capability` | G2 | Every table declares read/write capability and minimum project role | `contract:validate` (`governance` is a required sidecar block) |
| `subtractive-delegation` | G3 | Delegation is subtractive and expiring | `projectMembership.test.ts` — subtraction in the RPC, `expires_at NOT NULL`, expiry applied in `effective_project_role`, and NO write policy on either table. **BEHAVIOURAL SINCE WP 3.4, in the one place a live path reads it**: `ingest_apply_run` refuses a promotion below editor and `supabase/rehearsal/100` §3 proves it against a real database with an analyst who is a genuine member. That first live reader also exposed D61 — `project_members` had one writer in its life and it ran once, so every project created after WP 2.2 had no members and its own creator no role. Closed by a trigger; until WP 3.4 nothing had ever called the resolver, so nothing could notice. The rest of the delegation surface is still source-level |
| `audit-actor` | G4 | Every tier transition writes an audit row naming the actor | `dataPlaneAudit.test.ts` (every tier 2/3/4 table **in the contract** has all three triggers, read from every migration) · `contract:check` R9 (`governance.audited` matches them — D40) · **the ROW half is now PROVEN**: `supabase/rehearsal/010` writes one tier-2 statement and asserts exactly one `plane='data'` row at statement grain naming the actor, mutation-tested (D45). **The ingestion landing joined it in WP 3.2**, by the RPC route rather than a trigger: `ingest_land_file` and `ingest_apply_run` take the actor as a PARAMETER and set `app.current_user_id` LOCAL to their own transaction, so the tier-2 trigger names the promoter and the tier-0/1 landing writes its own row naming the uploader — `rehearsal/070`, mutation-tested, including the mutation that removes the GUC. **The SQL writers joined in WP 3.3**: `assign_material_supplier` writes three tier-2/3 tables from the /policies grid and had taken the actor as a parameter all along without telling the trigger — `20260916000021` adds the one line and `rehearsal/090` reads the row back. **The promotion also names the ROLE it acted under since WP 3.4**: `ingest_apply_run` takes the actor, resolves `effective_project_role` and refuses below editor, so the audit row's actor is one the database agreed could write (`rehearsal/100`, mutation-tested). **The six PostgREST writers are CLOSED since WP 4.1** *(in the repository — the three legacy `ingest-*` functions among them run a pre-WP-4.1 build in production, §4 D168)* — four RPCs (`ingest_legacy_upsert_lane`, `mrp_apply_staged_products`, `etl_replace_supply_chain`, `analysis_mark_critical_nodes`), each taking the actor through one shared preamble that refuses a NULL actor and sets the GUC LOCAL — and does NOT authorize: a role gate was written, found to refuse an organization admin on `combine-project`'s live path, and removed in `20260917000005`, because `min_project_role` is D66's to make live and not four RPCs' to answer ad hoc — and WP 6.2 measured why that removal was right rather than expedient: the two predicates disagree in BOTH directions, so an org admin passes RLS with no project role at all while a genuine editor holds a role and fails RLS (D66); `supabase/rehearsal/110` §7 performs each write and READS THE ROW BACK, with the GUC deliberately poisoned first because the first draft passed for the wrong reason (§16 · WP 4.1 · E). **AND THE INVARIANT IS STILL NOT MET, which is the point of D71**: WP 4.1's gap check measured the class D36 was one slice of — **26 `SECURITY DEFINER` functions write a tier-2/3/4 table and TWO set `app.current_user_id`**; 16 of the rest already take an actor parameter and 17 have live callers. **THOSE FIGURES WERE A TEXT SCAN'S READING AND WP 4.3 CORRECTED THEM — D78**: ten of the 26 attribute through `set_current_user_context`, whose body is one `set_config('app.current_user_id', …, true)` and has been since 2025-08-20; the scan could not follow the call, the same limitation `VIA_SHARED_PREAMBLE` was written for one package earlier. Honest figures now that four more tables are described: **31 writers, 15 attributing, 16 not, six of them live.** The invariant does not move — 16 is still 16 — but WP 6.2 budgets for six live functions rather than seventeen, and `supabase/rehearsal/130` §10 proves the widening with the GUC POISONED first rather than leaving it a reading. WP 4.3 also brought the four deep-tier tables inside the rule for the first time (D54's largest group: 22 tables audited by trigger, was 18; 38 deferrals, was 42). Each is the one line D36 says is not one for PostgREST but IS one here. **AND WP 6.2 SLICES 11 + 12 CLOSED IT — THE LIST IS NOW A GATE RATHER THAN A RATCHET.** `20260918000002` gave the one line to the three that already took `p_user_id` and never passed it on; `20260918000003` appended `_actor_user_id uuid DEFAULT NULL` to the nine that took no actor at all, in ONE migration, plus the eleven client call sites. The parameter defaults to NULL so every existing caller kept working unchanged, and a guard stops a NULL blanking an actor the caller's transaction had already set. `CREATE OR REPLACE` cannot change a parameter count, so each is a DROP and CREATE — which takes the function's grants with it, and `supabase/rehearsal/210` §2 checks every role back as an EXPLICIT grantee in `proacl` rather than asking `has_function_privilege`, which cannot fail while PUBLIC keeps EXECUTE. FOUR names remain on the list and NONE is debt: three attribute through `assert_writer_may_act`, and `create_default_policy_defaults` `RETURNS trigger` — PostgreSQL refuses a trigger function with declared arguments, and a trigger fires inside someone else's statement, so the actor is that statement's to set. `dataPlaneAudit.test.ts` now fails if a name sits on the list without one of those two justifications. **What is still NOT met is adoption at the edge**: `supabase/functions/api/index.ts` passes no actor on three calls, because its principal is an API KEY and carries no user uuid — naming a fabricated one would make `actor_known` true about somebody who did not act. That is D28's question and WP 7.1's to answer. And note what attribution means here: this application authenticates against `approved_users`, not Supabase Auth, so the uploader's id is CLIENT-ASSERTED — the database refuses a landing into a project that user cannot reach, which is a real constraint, but it is not proof of identity (D28) **WP 8.1 added one writer to the list and the ratchet caught it the same day**: `node_list_discover` wrote a tier-3 table with no GUC, `dataPlaneAudit.test.ts` failed with the new name in it, and the fix is the fifth function attributing through `assert_writer_may_act`. The same package found the OTHER half of that preamble's history the hard way — making D143's dead trigger fire turned two rehearsals red with `forbidden`, because `rebuild_node_list` AUTHORIZES and a derivation running inside somebody else's INSERT can only refuse a writer the database already allowed. **A derivation names WHO and decides nothing** (D66, and `20260917000005` is the precedent). **WP 8.2 added the sixth such writer and took the same shape deliberately rather than by trial**: `rebuild_supply_chain_lanes` runs from a statement trigger on the four lane SOURCES (D142), so it attributes through `assert_writer_may_act` and authorizes nothing — `combine_project_into_supply_chain` keeps the authorization as the wrapper. `rehearsal/310` §10 blanks the session actor FIRST and then reads the audit row back, because a check that passes on a session already holding the right value proves nothing about the writer |
| `table-covered` | — | Every table is described by a sidecar or deferred to a named work package | `contract:check` R1 (WP 1.4). **It is load-bearing for more than documentation**: `dataPlaneAudit.test.ts` scopes the audit rule to tables IN THE CONTRACT, so a deferred tier-2 table's writes are unaudited with nothing to notice (D54). **WP 4.3 is what that costs, measured**: describing the four deep-tier tables added three audit triggers each AND surfaced five writers the scan had never seen, which then corrected D71's headline number by ten (D78). A deferral does not only hide a table from the documentation — it hides its writers from every rule scoped to the contract |
| `no-orphan-table` | — | No relation in production is created by no migration | `contract:check` R4 · `contract:verify` (WP 1.4) — those see only tables the CODE READS · **`npm run verify:sql`'s schema probe is the rule for the class** (WP 3.0, D43): it keys on "production has it", prints the columns of anything untracked and EXITS NON-ZERO. It needs CI to reach the database, so it gates on demand rather than on every pull request |

## The transparency commitments (PLAN.md §5.3)

Also named, for the same reason. These are what the invariants are *for*.

| Commitment | Rule |
|---|---|
| **T1 · No number without a source** | Every displayed value resolves to data, a named substitution rule, or an explicit default. There is no fourth option. |
| **T2 · Substitution is always visible** | At the point of display, not in a log. A fallback absent from the contract may not exist in code (`declared-fallback`). |
| **T3 · We publish our own blind spots** | Every report and export states the known limits of its own computation. |
| **T4 · Reproducible or not published** | Any figure leaving the system carries the dataset, policy, scenario and engine versions that produced it. |
| **T5 · Transparency survives handover** | Generated and CI-gated, so it stays true when the people who built it have moved on. |

## The data-contract commands

One command reproduces everything CI asserts about the data layer:

```
npm run contract:check
```

**AND `npm run lint` IS MORE THAN THE TWO COMMANDS BELOW.** It runs `typecheck`,
`check:docs`, **`audit:ui`** and **eslint** as well, and the last two have their own
CI workflows (`ui-audit.yml`, and eslint inside `lint-all.mjs`). Five packages of
§16 entries report `audit:ui` and eslint counts while this section named neither, so
the practice existed and the instruction did not — and WP 6.3 shipped a red
`ui-audit` because of it: two `✅` literals in a test's regex, which §3.5 of
`docs/mobile-ui-spec.md` forbids in source. Match a glyph as `\u2705`; a rule that
made an exception for tests would stop being a rule.

**AFTER A BASE MERGE, RUN `contract:check` AND `npm test` BEFORE ANYTHING ELSE.**
A merge is a change nobody wrote, and §4 D39 is what it costs: WP 6.3 merged `main`
and broke three gates at once, none of which either branch was red about alone — a
generated module that had to carry both sides, a count one side pinned and the other
moved, and **§4's own table merging line by line into nine duplicated rows**
(D122, now gated by `contract:check` R16).

**And `npm run typecheck`, which did not exist until Phase 5 closed D57.** Nothing
in this repository typechecked: Vite does not, `contract:generate -- --check`
compares text, and a bare `tsc --noEmit` at the root passes VACUOUSLY because
`tsconfig.json` is `"files": []` plus two project references. The script pins
`tsconfig.app.json`, refuses to believe a clean result from a program that does
not contain `src/main.tsx`, and ratchets against `scripts/typecheck-baseline.json`
— 15 pre-existing errors in eight files as of WP 9.4 (the audit read 21 in nine; audit WP 8 paid four, WP 9.4 two), each with a named owner; the list may
shrink and may not grow, and one FEWER than the baseline also fails. It runs in
`npm run lint` and in `data-contract.yml`. **It cannot see an `@ts-nocheck` file,
and seventeen files in `src/` carry one** (§16 · WP 5.2e; WP 9.4 deleted the eighteenth), so "15 of 15 held"
describes the files it can see (it prints that count on every run), not all of `src/`.

And one more EXECUTES the migrations a branch adds, which no static gate can (D31):

```
npm run contract:rehearse                 # the migrations this branch adds, fresh
npm run contract:rehearse -- --fixtures   # …and over production's untracked shape
npm run contract:rehearse -- --since HEAD # …and against the artifact YOU wrote
```

It needs a PostgreSQL 16 (`PGHOST`/`PGPORT`/`PGUSER`, or `--database-url`); CI uses
a `postgres:16` service container in `data-contract.yml`'s `migrations run` job and
runs it BOTH ways. It builds the base from the BASE branch's
`build/schema.introspected.json` — not a replay of history, which cannot work: 92
of 296 migrations fail on an empty database and always will. After the migrations
it runs `supabase/rehearsal/*.sql` (23 files as of WP 6.2), which are BEHAVIOURAL
assertions against that database — the half a structural test cannot reach, and the reason `audit-actor`
went from claimed to proved (D45). **Write one whenever a change's correctness
depends on what the database DOES rather than on what a migration SAYS.**

**The third way is the shape `main` meets after your merge.** The first two build
the base from the BASE branch's artifact and then run your migrations, so the tables
come from the migration. Nothing there executes the artifact your branch WRITES —
and an artifact can be wrong about what the migration did. WP 3.1's rename is what
that costs: the introspector did not follow it into the foreign keys, the artifact
recorded a dangling reference, `rehearsal-schema.mjs` skipped the key silently, and
`main` went red on the merge commit with no cascade on three tables (D52). CI runs
all three now; run the third one locally before you push.

**A fixture must no-op once its migration is in the base** (`supabase/rehearsal/fixtures/README.md`).
Guard every statement on the shape it reproduces — `IF to_regclass('public.old_name')
IS NOT NULL` — so the day the migration merges, the fixture stops doing anything. A
fixture that plants ROWS a migration then removes has no shape to key on: it passes
once, on its own branch, and fails on every branch after it. That is D50, and it kept
`main` red from the WP 3.0 merge until WP 3.1.

It runs `contract:introspect -- --check`, `contract:validate`, `contract:units -- --check`,
`contract:verify` and `contract:generate -- --check`, then its own rules (R1 coverage,
R4 orphans, R5 natural keys, R6 §4 citation resolution, R7 §16 append-only **and**
every done package has a §16 entry, R8 nothing open is owned by a finished package,
R9 `governance.audited` matches the audit triggers, R10 §17's sequencing table agrees
with §7–§13's ✅ markers, R11 every deferred table says whether it is audited and is
right, R12 every §5.1 lineage row resolves to a real page and a real read, R13 an
implemented policy's declared requirement is described AND reaches a surface, R14 no
dynamic RLS statement resolves to zero tables, R15 a sidecar's prose may not deny a
reader its own `surfaces` block confirms, R16 every §4 D-number is unique, R17 every
edge function is deployed or deferred to a named package — **and R17 is the one to read
before claiming any edge-function work done**: twelve of eighteen functions shipped to
`main` and never reached production, including `ingest-file`, which is WP 3.2's entire
deliverable and which the I7 row above called live for four packages (D123)).
`.github/workflows/data-contract.yml`
runs the same set, plus `check:docs` and `npm test`, on every pull request.

**R7's append-only half needs history.** It SKIPS on a shallow clone and says so;
CI checks out with `fetch-depth: 0`. A local run that prints "SKIPPED" is expected.

One further command reaches the LIVE database:

```
npm run verify:sql          # PLAN.md §15, read-only (SELECT only)
```

No work-package session can run it — the egress proxy denies CONNECT. Touch
`.github/verify-request` and push; `.github/workflows/verification-sql.yml` runs it
with CI's `SUPABASE_ACCESS_TOKEN` and publishes the report to the
`verification-results` branch.

**THE RACE IS GONE AND THE TRIGGER STILL HAS THREE DOORS — AND A MIGRATION NO LONGER
DEPLOYS FROM A BRANCH AT ALL.** `supabase-migrations.yml` was scoped to
`branches: [main]` on 2026-09-18 (§4 D31's first half), so on a feature branch only one
of the two workflows can fire and the old rule — *push the migration, wait for* `Deploy
Supabase Migrations`*, then request §15* — describes a wait that will never end. **What
replaces it is more important than the race it removed: your branch's migrations are NOT
in the database a §15 run reads.** They deploy on MERGE. So a §15 report taken from a
branch measures production WITHOUT that branch's migrations, and a probe that queries a
column the branch adds comes back empty or errors — which is a fact about the sequence,
not a finding. Say which shape you measured.
`verification-sql.yml` still fires on three doors — `.github/verify-request`, the workflow
file, AND `scripts/data-contract/verification-sql.mjs` — and a probe you add travels in its
own push, which is why WP 3.4 lost a run: it shipped four new probes beside a migration.
A §15 run that races a deploy still reports a database that changed underneath it, and on
`main` that race is live: WP 3.3's first after-run read 1 787 rows in its lane sweep and a
total of 1 691 in a later query of the same report. Four runs across three packages have
been lost to this rule's older form. **AND THE RULE CANNOT BE OBEYED AT THE MERGE, WHICH
IS WHERE IT MATTERS — §4 D153.** `verification-sql.yml` has no branch filter, so the merge
commit fires it AND the migration deploy at the same second: WP 6.4 put its migrations and
its probe in two separate pushes, as the rule says, and the merge carried both doors
anyway — the report is stamped 20:03:28Z and the seven migrations applied 20:04:11–13Z,
with 74 statements spanning the boundary. So an after-reading taken on a merge is not a
reading. **Take it in the push AFTER the merge**, and read the report's last section:
`verification-sql.mjs` now reads the migration ledger before its first probe and after its
last, FAILS the run if it moved, and timestamps every `### ` heading, so a raced report
says so itself instead of being quoted as a measurement. **And a migration cannot report
its own numbers to you**: `supabase db push` forwards no notices and a `DELETE`'s row count
is a command tag, so the published deploy log is `Applying …` lines and nothing else (D152).
A migration that wants a number read back must write it into a table. **Measure every project, never just one** — the
largest project in this database is the one `seed-project.yml` seeds, and reading it
alone reports a clean data layer that is not clean (PLAN.md §4 D42).

- **Added a table?** Author `supabase/contract/<table>.contract.yaml`, or defer it in
  `scripts/data-contract/coverage.yaml` under the work package that will. A table in
  neither fails `table-covered`.
- **Changed a migration or a sidecar?** Run `npm run contract:generate` and commit
  `build/data-contract.generated.json` and `docs/data/tables/*.md` with it. They are
  committed on purpose: a gate that compares against an uncommitted artifact can never
  fail.
- **Never edit `docs/data/tables/*.md`.** They are generated. Edit the sidecar.

## Traceability convention

- Commits and PRs that advance the plan reference the blueprint section, gap, and phase they
  serve — e.g. `Phase A / G4 / §8.3: item-master editing forms`.
- If implementation must deviate from the blueprint, **update the blueprint in the same PR**.
  The document and the code move together; the blueprint is never allowed to go stale.

## Standing architectural laws (from the blueprint)

- **scsim is the strategic engine.** The legacy engine `sim-worker/sim_worker/engine.py` is
  frozen — never add capability to it (§3).
- **The registry export is the single source of truth for policy schemas**
  (`scsim/scsim/io/registry_export.py`). Never hand-write parallel policy schemas; generate
  from the registry (§6.2).
- **Extend existing artifacts, don't replace them** — proposals build on the phase pipeline,
  plugin registry, and version/hash patterns that already exist (§0).
- **Policy catalog IDs**: `P-S.x` supplier, `P-P.x` plant, `P-T.x` transport, `P-C.x` customer,
  `P-F.x` forecasting, `P-X.x` cross-cutting; `P-W.x` reserved for the warehouse echelon (§4.2).

## Non-platform work — euroFMX (HWR Berlin)

Grant administration, person-month planning and the research positioning for euroFMX
(GA 101299128) are recorded in `docs/projects/eurofmx-hwr.md`. **Read it before any
euroFMX task**: it carries HWR's PM per work package, the contract bands, the
allocation model behind `docs/projects/eurofmx/euroFMX_HWR_PM_v9.xlsx`, the cost check
against the faculty budget plan, and the standing conventions — including that the
WSC'26 paper belongs to ACCURATE and not to euroFMX, and that network mapping is
validated against reference databases and never against simulation. It is not platform
work, it does not advance `docs/PLAN.md`, and it carries no data-layer evidence.

## Repo orientation

| Tier | Path | Entry points |
|---|---|---|
| Frontend (React/Vite) | `src/` | `src/pages/ProjectPolicies.tsx` (/policies), `src/pages/DataManager.tsx` (/project-manager), `src/pages/SimulationLab.tsx` (/simulation-lab) |
| Data & control plane (Supabase) | `supabase/` | `supabase/functions/sim-command/index.ts`, `supabase/migrations/` |
| Execution (Fly.io worker) | `sim-worker/` | `sim_worker/worker.py`, `sim_worker/datamap.py`, `sim_worker/scsim_bridge.py` |
| Engine (Python) | `scsim/` | `scsim/scsim/core/phases.py`, `scsim/scsim/policies/registry.py`, `scsim/scsim/io/project_map.py` |

Companion docs, all under `docs/data/` and each opening with a status banner
(GENERATED / AUTHORED / DEPRECATED) so you know whether to edit it or its generator:
`docs/data/field-mapping.md` (AUTHORED — the field-mapping contract),
`docs/data/lifecycle.md` (AUTHORED — state tiers), `docs/data/tables/*.md`
(GENERATED by the data contract, lands in WP 1.4). The old top-level paths
`docs/data-simulation-mapping.md` and `docs/simulation-data-lifecycle.md` are
tombstones — many code comments still cite them; follow the stub, and do not add
content there.

`scsim/docs/` is the engine reference — generated, edit via
`scsim/scripts/gen_docs.py`, not by hand.

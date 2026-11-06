# Manual implementation review

Draft review batch, not a declaration that the entire manual is finished.

Initial source: `7698ac2d541242de35383d488cfa3cc1ab5a31c2`. Refreshed through `21cc4a4aed1ac11b9de4b60fa464f0596b0bd21a`, then `32aa35b8f4f525ce9c75c49685d0866803840af3` as main advanced. Both upstream updates (150 and 103 changed blobs) matched their Git blob hashes locally before integration. The final refresh adds Supplier-stage per-lane lead-time overrides, whole-week rounding and the lane/default fallback. The final comparison, replenishment and export guidance incorporates that newer behavior. No production writes, permissions, deployment, migrations or engine behavior were changed.

## Refresh 2026-10-18

Seven evidence hashes had gone stale as main advanced past the reviewed commit (Phase 14–16 work, the notebook key check and two policy-grid fixes). Each file's change since the version its hash was recorded against was read against the manual page it backs. Four manual claims were corrected: who can create an API key and the button's name (`getting-an-api-key`), the engine-difference rule of the comparison screen (`experiments-and-comparison`), the bounded lead-time exception to "an override wins" (`how-policies-work`), and the optional lane-shape and production lead-time columns (`uploading-data`). `engineInputExport.ts` changed only in how the Export reads the project's MTS/MTO default; no claim depended on it. Not refreshed: the other twelve hashes, which still match. Not reviewed here: `plant-stage` and `customer-stage` against the production lead-time and requested-delivery-schedule fields, which are outside this evidence map.

## Refresh 2026-10-31 (PLAN.md §4 D318)

Two evidence hashes moved: `comparability.ts` (`runVersions` gains the run's recorded calendar; `canonicalSchedule` ignores `start_anchor`) and `CompareScenariosPanel.tsx` (a Calendar column in "What each run used"). Both were read against `experiments-and-comparison`, whose description of that table was corrected to name the calendar and to say that neither the calendar nor how a start was entered makes a column not like-for-like. `disruptions` gained the three ways to enter a start and how runs are dated. Not refreshed: every other hash, which still matches.

## Refresh 2026-11-05

One evidence hash moved: `UploadWizard.tsx`. The change is that a failed `ingest-file` call now shows the server's own reason and HTTP status instead of the fixed sentence "Edge Function returned a non-2xx status code" (`src/lib/ingest/edgeError.ts`, also used by `useIngestRun`). It was read against `uploading-data`, which already tells readers that an upload error, a validation failure and a permission denial need different fixes and to capture the exact message; the page needed no change, and the new behaviour is what makes that advice workable. Not refreshed: every other hash, which still matches.

## What changed

- **Starting:** four reader paths now lead to an outcome. The analyst tutorial supplies seven synthetic CSVs, a precise experiment protocol, expected checkpoints, failure recovery and locally executed results.
- **Data:** upload guidance distinguishes staged landing, review, promotion, natural-key upserts, optional blanks, held rows and derived data. It no longer claims every upload appends rows or every input path uses the same lifecycle.
- **Networks:** product, process and firm guides explain the question each view answers, how to inspect it and what the graph cannot establish about simulation or reality.
- **Policies:** field-specific source resolution replaces a universal ladder. Examples distinguish drafts, saved overrides, masters, missing values and zero. The 0.6.1 guidance covers typed replenishment levels, review periods, required Q, legacy FG buffers and the new engine-input export.
- **Simulation and trust:** readers get a three-run comparison design, measurement-window and denominator explanations, uncertainty limits, current baseline-versus-many controls and explicit Resilience Index availability.
- **Access and API:** shared account-role text is preserved; project rights and actual server enforcement are distinguished. API guidance provides a source-checked first request, scopes, submission shape and recovery steps without claiming a live request was executed.
- **Presentation:** the principal pages have meaningful diagrams. Missing-figure authoring briefs no longer render to readers. Tests check required assets, rendered internal destinations and sample validity instead of imposing a word-count floor.

Existing slugs, registry/search organization and documentation access filtering remain intact. Generated references are not hand-edited. `docs/PLAN.md` retains the engineering history and gains a §16 entry. [Evidence map](evidence.json) records reviewed source paths, symbols and hashes; hash changes require a related manual review, not a blind hash refresh.

## Verification

| Check | Result |
| --- | --- |
| Full Vitest suite after upstream refresh | PASS: 158 files, 1,661 tests |
| Final documentation suite after tutorial refinements | PASS: 10 files, 296 tests |
| Production Vite build | PASS; existing large-chunk/Tailwind warnings |
| Typecheck ratchet | PASS: no new errors; 15 baseline errors in 8 files |
| Adaptive UI source audit | PASS: no new violations; 7 baseline violations |
| Single-source documentation check | PASS |
| Notebook generation check | PASS: 4 notebooks current |
| Data-contract check | PASS; existing Phase 5 status and customers.segment binding warnings |
| Engine generated documentation check | PASS |
| ESLint on changed docs and preview/render scripts | PASS |
| Repository-wide ESLint | FAIL: 294 errors and 111 warnings; no findings in this batch's changed files |
| Real CSV parser and ingest contract validators | PASS: all seven files, plus identifier relationships |
| Local frozen-input engine execution | PASS: three experiments × three completed replications, engine 0.6.1 |
| Python test suite | NOT RUN: pytest unavailable in this runtime; standalone verification script did execute |
| React static rendering and internal links/fragments | PASS; these checks do not establish pixel layout |
| Browser light/dark/mobile inspection and screenshots | BLOCKED; zero pages pixel-verified |
| Hosted upload/promotion, validation, dispatch, API calls | NOT RUN; needs an authorized isolated deployment |

The local browser binary was absent and its official download returned an empty/invalid archive. The Cloud Browser could not open the loopback preview (`net::ERR_BLOCKED_BY_CLIENT`). No screenshots are supplied or represented as verified. [Render status](render-checks.json) records the gap.

Reviewer reproduction:

```sh
npm ci
npm test
npm run typecheck
npm run audit:ui
npm run check:docs
npm run notebooks:check
npm run contract:check
PYTHONPATH=scsim python scsim/scripts/gen_docs.py --check
python scripts/verify-manual-example.py
npm run build
node scripts/preview-manual.mjs
```

Python dependencies are those declared by `scsim` and `sim-worker`. The preview mounts the real manual bodies and CSS without app credentials or backend requests, in a temporary entry separate from production. Open `http://127.0.0.1:4173/manual-preview.html?page=your-first-project&theme=dark`. With Playwright/Chromium installed, run `node scripts/verify-manual-render.mjs` from another terminal; it checks 17 pages at 1440/375 px in both themes and captures four representative full-page screenshots. It blocks remote requests. Inspect the screenshots and every changed page visually, then replace the blocked status with actual results. The isolated preview does not prove full-shell navigation or authorization behavior; test those separately in the isolated application.

## Sample and numeric interpretation

[CSV files, exact protocol and recorded output](../../public/examples/control-unit/) describe a synthetic MTO control-unit assembly: 100 units/week, one board and two housings per unit, 150/week board capacity, 300/week housing capacity, 150/week assembly capacity. The event reduces S-BOARD capacity 80% for four weeks, beginning at day 112. The response changes material safety stock from 0 to 28 days. Horizon 455 days, manual warm-up 56 days, 52 measured weeks, seed 42, CRN on, three deterministic replications.

| Experiment | Fill rate | Lost-sales value | Cost of resilience |
| --- | ---: | ---: | ---: |
| Baseline | 100% | 0 | 0 |
| Board disruption | 95.9615% | 12,600 | 12,600 |
| Same disruption, buffer | 100% | 0 | 2,400 |

Measured demand value is 100 × 52 × 60 = 312,000; 1 − 12,600 / 312,000 explains the disruption fill rate. Cost of resilience includes lost sales and holding-cost effects: it is not solely expenditure on stock. Identical replications and zero-width intervals are expected for these deterministic inputs; they do not validate a real supply chain. `verification.json` retains conversion notes and replication KPIs, not fabricated screenshots of a hosted run. UI adoption/defaults must be checked against `protocol.json` before expecting the same outcome.

## Unresolved product and documentation issues

1. **Browser simulation authorization:** `supabase/functions/sim-command/index.ts` checks for an Authorization header, permits a null result from `getUser`, and checks project existence using the service client. `_shared/dispatch.ts` assumes caller authorization. This reviewed dispatch path does not establish the caller's project role. No production exploit, permission change or security fix was attempted. Engineering follow-up should authenticate the caller, enforce per-command project rights and test denials before release; deployment parity is unknown.
2. **Conversion note resolved upstream:** the initial 0.6.0 run included a misleading generic coverage note. The refreshed 0.6.1 output replaces it with the s/S formulas and explicit-level rule. The shipped output contains the corrected note; this is no longer reported as an open defect.
3. **Engineer onboarding:** the main README/package `api` command refers to `services.api`, while current architecture uses Supabase and the worker. The frontend Supabase client has source configuration; an arbitrary `.env` does not prove isolation. The new architecture guide flags this, but a complete local-backend setup remains work.
4. **Source is not deployment:** current migrations, scopes, model/library availability and frozen-input behavior were traced in source. Hosted authorization, ingestion and first API request are not verified by this batch.
5. **Scope:** 17 of 83 registered page bodies were implemented/refined. Other bodies received shared rendering/link coverage only; that is not a factual audit. Upstream Customer/Plant changes were preserved. Browser acceptance remains incomplete even for the changed pages.

## Page-level continuation checklist

“Implemented” below means content and source checks, not final visual acceptance. The whole-manual work continues after browser QA of this batch. Prioritize exports/reproducibility, stage references, validation and access before the remaining features.

| Page slug | Completion | Next concrete check |
| --- | --- | --- |
| `what-suresuite-is` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `how-suresuite-is-designed` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `data-model` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `how-your-data-flows` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `what-happens-to-your-data` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `system-boundary` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `known-limits` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `your-first-project` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `projects` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `uploading-data` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `inbound-logistics` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `outbound-logistics` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `demand-forecasts` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `bom-single-level` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `bom-multi-level` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `materials` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `products` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `suppliers` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `node-list` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `deep-tier-nodes` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `deep-tier-edges` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `multi-tier-suppliers` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `units-and-time-periods` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `supply-chain-data` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `multi-tier-data` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `network-summary` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `dataset-versions` | Preserved; link/registry checks only | Trace freeze, legacy fallback and version selection in worker/browser/export. |
| `how-policies-work` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `how-planning-works` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `supplier-stage` | Preserved; link/registry checks only | Check 0.6.1 typed s/S, T, Q and κ semantics against the current grid. |
| `plant-stage` | Preserved; link/registry checks only | Preserve upstream removal of demand edits and legacy-only FG buffer. |
| `customer-stage` | Preserved; link/registry checks only | Preserve upstream distribution gates and forecast availability; add a worked task. |
| `policy-types` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `policy-catalog` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `where-a-number-came-from` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `when-a-value-is-missing` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `policy-versions-and-presets` | Preserved; link/registry checks only | Reconcile the new engine-input Export and its provenance fallback. |
| `verify-your-inputs` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `data-trust-report` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `model-validation` | Preserved; link/registry checks only | Complete a hosted isolated walkthrough of findings, adoption and staleness. |
| `simulation-lab` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `scenarios` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `disruptions` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `recovery-playbooks` | Preserved; link/registry checks only | Verify reachable event editor controls and distinguish unsupported engine-library features. |
| `experiments-and-comparison` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `seeds-replications-confidence` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `stress-tests` | Preserved; link/registry checks only | Verify every application/library availability claim. |
| `product-level-network` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `process-level-network` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `firm-level-network` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `interactive-network-space` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `network-science-metrics` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `ai-assistant` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `plans-and-proposals` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `project-memory` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `models-budgets-limits` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `connecting-erp` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `reviewing-a-sync` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `csv-vs-connector` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `reading-your-results` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `kpis-and-resilience-index` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `per-item-time-series` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `performance-and-caching` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `reports-and-files` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `verifiable-exports` | Preserved; link/registry checks only | Inspect the new engine-input workbook, hash checks and latest-run/current-data fallback. |
| `reproducibility-record` | Preserved; link/registry checks only | Distinguish frozen inputs from scenario settings read at export time. |
| `exporting-and-deleting` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `organizations-and-members` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `roles-and-capabilities` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `project-access` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `who-can-see-your-data` | Preserved; link/registry checks only | Trace each caller/server authorization boundary; reconcile the simulation gap. |
| `audit-log` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `admin-screens` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `account-and-password` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `getting-an-api-key` | Implemented; source/SSR checked; browser QA pending | Inspect light/dark at 1440/375 px; exercise the relevant isolated workflow. |
| `endpoints-and-schemas` | Preserved; link/registry checks only | Exercise a scoped request and run lifecycle in an isolated deployment. |
| `rate-limits-and-idempotency` | Preserved; link/registry checks only | Trace key owner eligibility, quota buckets and retry behavior. |
| `request-log` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `all-tables` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `units-and-conventions` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `glossary` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `field-index` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |
| `questions` | Preserved; link/registry checks only | Review current implementation, task checkpoints and visual usefulness; inspect rendered page. |

## Changed files

See the following exact paths (relative to the repository root).

- `docs/PLAN.md`
- `docs/manual-review/README.md`
- `docs/manual-review/evidence.json`
- `docs/manual-review/render-checks.json`
- `public/examples/control-unit/bom_single_level.csv`
- `public/examples/control-unit/customers.csv`
- `public/examples/control-unit/inbound_logistics.csv`
- `public/examples/control-unit/materials.csv`
- `public/examples/control-unit/outbound_logistics.csv`
- `public/examples/control-unit/products.csv`
- `public/examples/control-unit/protocol.json`
- `public/examples/control-unit/suppliers.csv`
- `public/examples/control-unit/verification.json`
- `scripts/preview-manual.mjs`
- `scripts/verify-manual-example.py`
- `scripts/verify-manual-render.mjs`
- `src/assets/manual/api-request.svg`
- `src/assets/manual/capability-layers.svg`
- `src/assets/manual/controlled-comparison.svg`
- `src/assets/manual/firm-network.svg`
- `src/assets/manual/first-comparison.svg`
- `src/assets/manual/flow.svg`
- `src/assets/manual/interactive-space.svg`
- `src/assets/manual/kpi-vocabulary-gap.svg`
- `src/assets/manual/process-network.svg`
- `src/assets/manual/product-network.svg`
- `src/assets/manual/project-access-review.svg`
- `src/assets/manual/resolution-order.svg`
- `src/assets/manual/system-components.svg`
- `src/assets/manual/tiers.svg`
- `src/assets/manual/trust-boundaries.svg`
- `src/assets/manual/upload-review.svg`
- `src/components/docs/DocFigure.tsx`
- `src/components/docs/DocPage.tsx`
- `src/components/docs/DocsHome.tsx`
- `src/components/docs/ExampleDownloads.tsx`
- `src/components/docs/__tests__/figures.test.ts`
- `src/components/docs/__tests__/manualExample.test.ts`
- `src/components/docs/__tests__/pageDepth.test.tsx`
- `src/components/docs/bodies/ExperimentsAndComparison.tsx`
- `src/components/docs/bodies/FirmLevelNetwork.tsx`
- `src/components/docs/bodies/GettingAnApiKey.tsx`
- `src/components/docs/bodies/HowItIsDesigned.tsx`
- `src/components/docs/bodies/HowPoliciesWork.tsx`
- `src/components/docs/bodies/HowYourDataFlows.tsx`
- `src/components/docs/bodies/KnownLimits.tsx`
- `src/components/docs/bodies/KpisAndResilienceIndex.tsx`
- `src/components/docs/bodies/ProcessLevelNetwork.tsx`
- `src/components/docs/bodies/ProductLevelNetwork.tsx`
- `src/components/docs/bodies/ProjectAccess.tsx`
- `src/components/docs/bodies/ReadingYourResults.tsx`
- `src/components/docs/bodies/RolesAndCapabilities.tsx`
- `src/components/docs/bodies/SeedsReplicationsConfidence.tsx`
- `src/components/docs/bodies/SimulationLab.tsx`
- `src/components/docs/bodies/UploadingData.tsx`
- `src/components/docs/bodies/YourFirstProject.tsx`
- `src/components/docs/figureManifest.ts`
- `src/components/docs/prose.tsx`

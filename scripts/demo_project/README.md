# Demo dataset — product, process and firm level

A small, **entirely fictional** supply network for the demo (`/demo`): the three network
pages, and Policies, the Simulation Lab and the Developer API page, all read-only. It grows
the manual's control-unit assembly (`public/examples/control-unit`) until each page has
something to show; that example itself is untouched.

| Page | What it reads | What this dataset gives it |
|---|---|---|
| Product level | the lanes, the node list, `risk_data` | 1 finished product, 10 purchased materials, 11 suppliers, 2 customers, a second source for the microcontroller, locations for the map |
| Process level | the multi-level BOM and the lanes | a three-deep bill of materials with 3 sub-assemblies |
| Firm level | the deep-tier firm graph, `risk_data` | 41 firms (the plant, 11 tier-1, 17 tier-2, 12 tier-3) in 16 countries; a wafer foundry, a resin maker and a copper-cathode miner each feed several firms, so a few firms are visibly more critical than the rest |

The tier-1 firms of the firm graph *are* the chain's suppliers (same names, same
cities). The deep-tier graph feeds the network analyses and the firm-level map, not the
simulation, and its firm ids are separate from the chain's supplier ids.

## Files

| File | What it is |
|---|---|
| `build_dataset.py` | the dataset, authored once; checks it and writes the files below |
| `dataset.json` | what `scripts/seed_demo_project.mjs` loads |
| `csv/*.csv` | the same rows in the upload wizard's formats, for loading by hand in `/project-manager` |

Both outputs are generated. Change the dataset in `build_dataset.py`, then run:

```sh
python3 scripts/demo_project/build_dataset.py          # rewrite the files
python3 scripts/demo_project/build_dataset.py --check  # fail if they are out of date
```

`src/lib/__tests__/demoDataset.test.ts` runs the CSVs through the real upload validators
and checks the firm graph's structure, so a file the wizard would refuse fails in CI.

## Loading it

**By script (repeatable).** The script drives the same RPCs the app does and runs the
analyses each page would otherwise start on first open, once, so no visitor's session has
to write anything.

```sh
node scripts/seed_demo_project.mjs --dry-run        # validate, print counts, write nothing
USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs
```

`USER_ID` and `USER_EMAIL` are the approved-user id and email of the **modeler who will
own the project**. The project's organization is stamped from that identity, and
`list_projects` shows it only to that organization, so there is no default. Re-running
reuses the project by name, clears its arcs and the deep-tier graph, and loads them again.
It ends by reading every page's data back as that modeler and exits non-zero if a page
would be empty.

**Scenarios, policy versions and results.** `/policies` and `/simulation-lab` need something to
show, and the first seed creates none of it. `scripts/seed_demo_runs.mjs` creates two saved
policy versions (baseline, and safety stock 28 days), three scenarios (a normal year, a
six-week outage of the microcontroller's main supplier, a three-week plant shutdown) and runs
each under both versions, one at a time, on the platform. It uses the public API, so it needs
an **API key of the project's owner** with all six read/write scopes on data, policies and runs
(sign in as the owner, `/developer`), and the simulation worker has to be online.

```sh
node scripts/seed_demo_runs.mjs --dry-run
SURESUITE_API_KEY=sk_live_… node scripts/seed_demo_runs.mjs
```

One step stays manual: the Policies page's Run & Validate queue belongs to the project's
validation baseline, which only the app creates. As the owner, open `/policies` → Run &
Validate and run one baseline.

**By hand.** In `/project-manager`, create a project (Make-To-Order, BOM level *multi*,
deep-tier enabled, plant `Stuttgart Plant`) and upload, in this order: suppliers,
materials, products, `bom_multi_level`, `inbound_logistics`, `outbound_logistics`, then
`network_nodes` and `network_edges` on the Deep Tier Network tab (nodes first). The node
list's locations (`node_list.csv`) go in after the lanes exist. The analyses then start
the first time someone opens each page.

## Before you rely on it

- **Country risk.** The firm level and the map colour firms by `risk_data`, a shared
  reference table this dataset does not write. A country with no row there shows as
  "Unknown" with a notice. The dataset uses: Germany, Taiwan, Japan, China, Malaysia,
  Mexico, Vietnam, South Korea, Poland, Czech Republic, Austria, United States,
  Thailand, Saudi Arabia, Chile and Finland. Check that your `risk_data` has them.
- **The plant's pin** comes from geocoding the plant name, which needs the geocoding
  function's map token. The seed calls it; if it reports a failure, the pin is the only
  thing missing.
- **Nothing here is real.** Firm names, revenues, headcounts and relationships are
  invented. Only the cities are real, to place the dots. Websites use the reserved
  `.example` domain.

## How visitors get in (no login)

`/demo` opens the three network pages without an account. It starts a **demo session**,
in which the app's user is a dedicated, read-only demo account in the demo organization.
The code is in `src/lib/demo`, `src/pages/DemoEntry.tsx` and `src/components/demo`.

The demo is **off unless configured**: it needs `VITE_DEMO_GUEST_ID` and
`VITE_DEMO_GUEST_EMAIL` (the demo account's id and email) at build time. They are set in
`.env.production`, which is the hosting configuration for production builds; remove either
line and `/demo` says the demo is not available.

What a demo session does and does not do:

- The visitor sees six pages — Product, Process and Firm level, Policies, the Simulation Lab
  and the Developer API — a banner saying it is a read-only demo, and an "Exit demo" /
  "Sign in" way out. Every other route sends them back to the first page. On the Developer
  API page only Quickstart and Notebook are shown, and no API key can be created.
  The AI chat bubble is not drawn, and the recalculation buttons are off: the demo shows
  what the seed stored and computes nothing.
- The session lives in the tab (`sessionStorage`), and its project selection has its own
  key, so it never touches what a signed-in person last had open in the same browser. A
  real sign-in ends it.
- **The route allow-list is not a security boundary.** The demo account's id is in the
  bundle, so anyone can call the database as that account. What makes that harmless is the
  account itself, so check it once, whenever the demo is set up:
  - it is a plain `user` and is **not** the project's owner, so every write call refuses it;
  - it is a **Viewer** on the demo project (`/admin/projects` → Members & access), because
    with no project role the account role decides and a plain `user` may run simulations;
  - for it (`/admin/users/<id>`), the page capabilities are on for the six demo pages and off
    for the rest, and every **feature** capability is denied — Run Simulations, editing
    policies and inputs, export, and AI chat above all — with an AI budget of 0;
  - the demo organization holds nothing but the demo project and the two demo accounts.

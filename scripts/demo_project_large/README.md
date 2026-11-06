# Large demo dataset — 100 products, 1 000 suppliers

The same story as `scripts/demo_project`, at the size where the three network lenses stop
being readable as one graph: a multi-level bill of materials four levels deep, thousands of
nodes and edges, and a deep-tier firm graph of about three thousand firms. Entirely
fictional. It exists to try the lenses' large-network views (`src/lib/network/scale.ts`) and
to see how the rest of the app behaves on a project this size.

| | Count |
|---|---|
| Finished products (10 families) | 100 |
| Purchased materials (shared across products) | 1 800 |
| Suppliers (16 specialities, 22 countries) | 1 000 |
| BOM rows (levels 1–4) | ~4 900 |
| Inbound lanes | ~3 050 |
| Customers / outbound lanes | 25 / ~190 |
| Firm graph: nodes / edges | ~3 100 / ~5 200 |

The BOM is kept under 10 000 rows on purpose: production returns at most that many rows
from one unpaged read, and a project past it would be simulated on a slice.

## Build it

The files are generated, not committed (`out/` is ignored), and are fully determined by the
flags and the seed.

```sh
python3 scripts/demo_project_large/build_dataset.py                # → out/dataset.json + out/csv/
python3 scripts/demo_project_large/build_dataset.py --check        # build and self-check only
python3 scripts/demo_project_large/build_dataset.py --products 12 --suppliers 80 --materials 150 \
  --customers 6 --out /tmp/small                                   # a small instance, same shape
```

Add `--split 700` to also write `out/csv_split/`: every CSV longer than that, cut into files of
about that many rows, for uploading one at a time through `/project-manager`. A big upload is
staged, reviewed and promoted as one unit, and each of those steps has a per-request time limit;
smaller files keep each unit inside it. The BOM is cut only between products.

`src/lib/__tests__/demoDatasetLarge.test.ts` builds it at full size and runs the real upload
validators and the platform's pre-run data check over it.

## Load it

```sh
DATASET_DIR=scripts/demo_project_large/out node scripts/seed_demo_project.mjs --dry-run
DATASET_DIR=scripts/demo_project_large/out BATCH_ROWS=1000 SKIP_ANALYSES=1 \
  USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs
```

* **Load it with `LANES_VIA=sql`, in two steps.** Every promotion through the upload path
  (`LANES_VIA=ingest`, or the wizard) rebuilds the project's lanes, and on a project this size
  one rebuild takes about 8 s on a small hosted database — the per-statement limit — so even a
  20-row file can fail. The `sql` mode loads the BOM, inbound and outbound rows with the rebuild
  triggers off and rebuilds once:

  ```sh
  # 1. creates the project and the item masters, writes out/load_lanes.sql, stops
  DATASET_DIR=scripts/demo_project_large/out LANES_VIA=sql SKIP_ANALYSES=1 \
    USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs

  # 2. run out/load_lanes.sql as ONE transaction: Supabase dashboard → SQL Editor → New query →
  #    paste the file (about 0.8 MB) → Run. Or: psql "<connection string>" -1 -f out/load_lanes.sql
  #    Its last query prints the row counts and triggers_left_off (must be 0).

  # 3. finishes: the node list's locations, the firm graph, the read-back
  DATASET_DIR=scripts/demo_project_large/out LANES_VIA=loaded BATCH_ROWS=300 SKIP_ANALYSES=1 \
    USER_ID=<uuid> USER_EMAIL=<email> node scripts/seed_demo_project.mjs
  ```

  The file is one transaction, so a failure rolls everything back, including the trigger
  switches. Its rows skip the ingest tiers and their audit rows, as the bulk RPCs did. It needs
  migration `20261105000001` (the rebuild) applied first. `LANES_VIA=ingest` is still there for
  a database with room to spare; it sends each file through `ingest-file` and splits one that
  times out.
* `BATCH_ROWS` sends each bulk call in slices, so one statement stays under the database's
  per-statement time limit. Each slice on a lane table rebuilds the project's lanes, so a
  load this size is slow — and the single `combine_project_into_supply_chain` call at the
  end is the step most likely to hit the time limit. If it does, run it again from the SQL
  editor, where the limit can be raised.
* `SKIP_ANALYSES=1` is recommended. The network-science analyses are not built for graphs
  this size (they run in an edge function with a CPU cap), so a pass here is not expected.
  The lenses' overview does not depend on them.
* By hand, the CSVs in `out/csv/` are in the upload wizard's formats.

Opening `/network/product-level`, `/network/process-level` or `/network/firm-level` on this
project draws the whole network on a canvas, in a layout made for thousands of nodes (classes
ordered so related nodes sit together; rings for the firm graph). Scroll to zoom, drag to pan,
click a node to select it, double-click to focus its supply path (a button returns to the full
network); labels appear when you zoom in. The **Summary** tab shows the same network as counts
and a ranking.

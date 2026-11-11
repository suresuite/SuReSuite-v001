# SuReSuite notebooks — authoring guide

The six notebooks a customer downloads from `/developer` →
`public/notebooks/suresuite_0N_*.ipynb` — are **generated**. Do not edit an
`.ipynb`; edit its source here and rebuild.

```
notebooks/
  src/
    00_quickstart.py … 05_available_to_promise.py   one source per notebook (percent format)
    common/config.py      the CONFIG cell — /developer patches it; its variables must match nbConfigCell
    common/setup.py       packages + API key (Colab Secrets → SURESUITE_API_KEY → prompt in "live")
    common/study.py       how 04 and 05 read a project: data, policies, scenario, engine, per-item weeks
    common/trace.py       04's tables and charts for following several items through one replication
  demo/example_project.json   recorded engine output the demo mode replays
  tools/record_demo.py        re-records it through the worker's own path
  tools/run_notebooks.py      executes every built notebook in demo mode
  tests/                      pytest for the client and the demo
```

## Cell markers in a source

```python
# %% [markdown]
# # A heading — every markdown line starts with "# "

# %% include: config        # the shared CONFIG cell
# %% include: setup         # packages + key (collapsed in Colab)
# %% include: library       # client.py + kpi_display.py (collapsed in Colab)
# %% include: study         # common/study.py (collapsed in Colab)
# %% include: trace         # common/trace.py (collapsed in Colab)
# %% include: demo_data baseline s2_outage   # only the recordings this notebook replays
# %% include: bundle setup library local study trace demo_data baseline   # all of them as ONE cell (04)

# %%
api = connect(BASE_URL, API_KEY, DEMO_DATA)
```

## Commands

```bash
npm run notebooks:build          # regenerate kpi_display.py and every .ipynb
npm run notebooks:check          # part of `npm run lint`; fails on drift and on the content rules

pip install requests pandas matplotlib pyarrow openpyxl nbclient nbformat ipykernel pytest
(cd notebooks && python -m pytest tests -q)
python notebooks/tools/run_notebooks.py           # every notebook, demo mode, no key

# re-record the demo (needs the engine and the worker; run from anywhere)
pip install ./scsim ./sim-worker -r sim-worker/requirements.txt
python notebooks/tools/record_demo.py [--check]
```

## Rules `--check` enforces

- The built notebooks are exactly what the sources produce, and `/developer`'s
  `NOTEBOOKS` list names exactly the built files.
- `common/config.py`'s variables equal the ones `nbConfigCell` in
  `src/pages/DeveloperApi.tsx` writes into a download.
- No emoji (the product copy rule), no `file:line` citations (PLAN.md §4 owns
  that evidence, and a customer cannot open a private repository), no run status
  `succeeded` (a finished run is `done`), no material / edge / customer / lane
  disruption target (the engine skips them — PLAN.md §4 D112).

## Adding an experiment to the demo

Demo mode answers a dispatch only when the (policy families, disruption
schedule, scenario frame) combination was recorded. To add one, append it to
`RECORDINGS` in `tools/record_demo.py`, re-record, list its label in the
notebook's `demo_data` include, and rebuild. A combination with no recording is
refused with `demo_no_recording` — never answered with an invented number.

`src/lib/sim/__tests__/notebookParity.test.ts` keeps the demo honest against the
gateway (run row columns, scenario and run body fields) and keeps
`paired_compare` equal to the Simulation Lab's `pairedDifference`.

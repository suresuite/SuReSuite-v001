#!/usr/bin/env python3
"""Run one generated SQL file as ONE transaction through the Supabase Management API.

Used by `.github/workflows/demo-seed.yml` for the file `scripts/seed_demo_project.mjs`
writes with LANES_VIA=sql (load_lanes.sql): the large demo's BOM and lanes, loaded with
the lane triggers off and rebuilt once. The file says it must run as one transaction, so
it is wrapped in BEGIN … COMMIT here; any error rolls the whole file back.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nexus"))
from nexus_job import sql  # noqa: E402

path = Path(sys.argv[1])
body = path.read_text()
print(f"running {path} ({len(body):,} bytes) as one transaction")
rows = sql("BEGIN;\n" + body + "\nCOMMIT;")
print(json.dumps(rows, indent=1)[:2000])
if rows and isinstance(rows, list) and rows[-1].get("triggers_left_off") not in (0, None):
    raise SystemExit("a lane trigger was left off")

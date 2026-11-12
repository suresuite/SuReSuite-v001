#!/usr/bin/env python3
"""Print `USER_ID=<id>` and `USER_EMAIL=<email>` for the owner (modeler) of a project.

    python scripts/demo/owner.py "<project name>" ["<fallback project name>"]

The first name that exists wins: a demo project that is about to be created takes its
owner from the project it replaces. Read-only (SELECT through the Management API).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "nexus"))
from nexus_job import lit, sql  # noqa: E402

for name in sys.argv[1:]:
    rows = sql(f"""SELECT u.id::text AS id, u.email FROM public.projects p
                     JOIN public.approved_users u ON u.id = p.modeler_id
                    WHERE p.name = {lit(name)} ORDER BY p.created_at LIMIT 1""")
    if rows:
        print(f"USER_ID={rows[0]['id']}")
        print(f"USER_EMAIL={rows[0]['email']}")
        print(f"owner of {name!r}", file=sys.stderr)
        break
else:
    raise SystemExit(f"none of these projects exists: {sys.argv[1:]}")

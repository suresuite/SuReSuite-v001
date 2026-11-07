"""Novo Nordisk and Zentiva reference datasets from EMA public records
(docs/PLAN.md §29, WP 19.4b / 19.4c).

Sources, both published by the European Medicines Agency:
  - the "Medicines output" table (every EU-authorised medicine and its
    marketing-authorisation holder), to list each company's products;
  - each product's EPAR product information, Annex II.A: the manufacturer(s)
    of the biological active substance (biologics) and the manufacturer(s)
    responsible for batch release, with their site addresses.

What Annex II.A does NOT say, and this dataset therefore never claims: who
makes a small-molecule active ingredient (that sits in confidential dossiers),
volumes, or any commercial term. No personal data: Annex II.A names
companies and sites only.

  python scripts/kg_reference/build_ema.py          # fetch (cached) + write both
  python scripts/kg_reference/build_ema.py --check  # rebuild, compare
"""
from __future__ import annotations

import re
import subprocess
import sys

import openpyxl

from common import clean, fetch, fragment, write_dataset

TABLE_ID = "ema-medicines-output"
TABLE_URL = "https://www.ema.europa.eu/en/documents/report/medicines-output-medicines-report_en.xlsx"
EMA_NOTE = ("European Medicines Agency public document; EMA permits reuse with acknowledgement of the "
            "source. Facts and short fragments only.")
COMPANIES = {
    "novo_nordisk": {"match": "novo nordisk", "focal": "Novo Nordisk A/S", "country": "Denmark"},
    "zentiva": {"match": "zentiva", "focal": "Zentiva, k.s.", "country": "Czechia"},
}
LABEL = ("Mapped from public European Medicines Agency records (EPAR product information, Annex II.A). "
         "Not endorsed by or affiliated with {focal}. Names manufacturing and batch-release sites only; "
         "says nothing about who makes a small-molecule active ingredient, volumes or availability.")

ROLE_HEADERS = (
    (re.compile(r"name and address of the manufacturers?\(?s?\)? of the biological active substance", re.I),
     "active_substance_manufacturer"),
    (re.compile(r"name and address of the manufacturers?\(?s?\)? responsible for batch release", re.I),
     "batch_release"),
)
STOP = re.compile(r"(the printed package leaflet|^\s*B\.\s+CONDITIONS OR RESTRICTIONS)", re.I)


def products(path) -> list[dict]:
    ws = openpyxl.load_workbook(path, read_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[1] == "Name of medicine")
    h = [str(c) for c in rows[hi]]
    col = {k: h.index(k) for k in (
        "Name of medicine", "Marketing authorisation developer / applicant / holder", "Medicine status",
        "Category", "Medicine URL", "Active substance", "Generic", "Biosimilar", "EMA product number")}
    out = []
    for r in rows[hi + 1:]:
        if r[col["Category"]] != "Human" or str(r[col["Medicine status"]]).lower() != "authorised":
            continue
        out.append({k: (clean(r[i]) if r[i] is not None else None) for k, i in col.items()})
    return out


def annex_iia(text: str) -> list[dict]:
    """Every (role, strengths, block) in Annex II.A, in document order."""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if ROLE_HEADERS[0][0].search(l) or ROLE_HEADERS[1][0].search(l)),
                 None)
    if start is None:
        return []
    out, role, strengths, block = [], None, None, []

    def columns(raw: list[str]) -> list[list[str]]:
        """Split a block printed as two side-by-side sites (a wide gap on every
        line) into two blocks, left then right; otherwise the block itself."""
        split = [re.split(r"\s{3,}", r.strip(), maxsplit=1) for r in raw]
        if len(raw) > 1 and all(len(p) == 2 for p in split):
            return [[p[0] for p in split], [p[1] for p in split]]
        return [raw]

    def flush():
        nonlocal block, strengths
        raw = [x for x in block if clean(x)]
        block = []
        if not role or not raw:
            return
        if len(raw) == 1:
            # A one-line block is a presentation heading ("Tablets", "Actrapid
            # InnoLet:", "Tresiba Penfill 100 units/mL"), never a site: a site
            # always has a name and at least one address line.
            strengths = clean(raw[0]).rstrip(":").strip()
            return
        for col in columns(raw):
            out.append({"role": role, "strengths": strengths, "lines": [clean(x) for x in col]})

    for l in lines[start:]:
        if STOP.search(l):
            break
        hit = next((r for rx, r in ROLE_HEADERS if rx.search(l)), None)
        if hit:
            flush(); role, strengths = hit, None
            continue
        s = clean(l)
        if s.startswith("-") and len(s) > 2 and s[1] in " \t":
            flush(); strengths = s.lstrip("- ").strip()
            continue
        if not s:
            flush()
            continue
        block.append(l)
    flush()
    return out


def _country(last_line: str) -> str:
    return clean(last_line.split(",")[-1]) if last_line else ""


def build(check: bool) -> bool:
    table = fetch(TABLE_ID, TABLE_URL, "ema-medicines-output.xlsx", "European Medicines Agency", EMA_NOTE)
    meds = products(table)
    ok = True
    for name, cfg in COMPANIES.items():
        mine = [m for m in meds if cfg["match"] in (m["Marketing authorisation developer / applicant / holder"] or "").lower()]
        focal = {"ref": "focal", "type": "Company", "name": cfg["focal"], "country": cfg["country"], "identifiers": {}}
        entities, assertions, sources, empty = [focal], [], [TABLE_ID], []
        holders = {}
        sites: dict[tuple, str] = {}
        for m in sorted(mine, key=lambda x: x["Name of medicine"]):
            slug = m["Medicine URL"].rstrip("/").split("/")[-1]
            pid = f"product:{slug}"
            sid = f"ema-epar-pi-{slug}"
            pi_url = f"https://www.ema.europa.eu/en/documents/product-information/{slug}-epar-product-information_en.pdf"
            pdf = fetch(sid, pi_url, f"ema-{slug}.pdf", "European Medicines Agency", EMA_NOTE)
            sources.append(sid)
            text = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True,
                                  check=True).stdout
            holder = m["Marketing authorisation developer / applicant / holder"]
            if holder not in holders:
                holders[holder] = f"holder:{len(holders) + 1}"
                entities.append({"ref": holders[holder], "type": "Company", "name": holder, "country": None,
                                 "identifiers": {}})
            entities.append({"ref": pid, "type": "Product", "name": m["Name of medicine"], "country": None,
                             "identifiers": {"ema_product_number": m["EMA product number"],
                                             "active_substance": m["Active substance"],
                                             "generic": m["Generic"], "biosimilar": m["Biosimilar"]}})
            assertions.append({"subject": holders[holder], "relation": "Produces", "object": pid,
                               "qualifier": {"role": "marketing_authorisation_holder"},
                               "evidence": [{"source": TABLE_ID, "page": None,
                                             "fragment": fragment(f"{m['Name of medicine']} {holder}")}]})
            blocks = annex_iia(text)
            if not blocks:
                empty.append(slug)
            for b in blocks:
                company, country = b["lines"][0], _country(b["lines"][-1])
                key = (company, tuple(b["lines"][1:]))
                if key not in sites:
                    sites[key] = f"site:{len(sites) + 1:03d}"
                    entities.append({"ref": sites[key], "type": "Facility", "name": company, "country": country or None,
                                     "identifiers": {}, "address": ", ".join(b["lines"][1:])})
                    assertions.append({"subject": sites[key], "relation": "LocatedIn", "object": f"country:{country}",
                                       "qualifier": {"address": ", ".join(b["lines"][1:])},
                                       "evidence": [{"source": sid, "page": None,
                                                     "fragment": fragment(" ".join(b["lines"]))}]})
                assertions.append({"subject": sites[key], "relation": "SuppliesTo", "object": pid,
                                   "qualifier": {"role": b["role"], "strengths": b["strengths"]},
                                   "evidence": [{"source": sid, "page": None,
                                                 "fragment": fragment(" ".join(b["lines"]))}]})
        for c in sorted({e["country"] for e in entities if e.get("country")}):
            entities.append({"ref": f"country:{c}", "type": "Location", "name": c, "country": c, "identifiers": {}})
        payload = {"dataset": name, "label": LABEL.format(focal=cfg["focal"]), "focal": "focal",
                   "sources": sources,
                   "counts": {"products": len(mine), "sites": len(sites),
                              "site_assertions": sum(1 for a in assertions if a["relation"] == "SuppliesTo"),
                              "products_without_annex_iia": len(empty)},
                   "skipped": [{"product": s, "reason": "no Annex II.A block found"} for s in empty],
                   "entities": entities, "assertions": assertions}
        ok = write_dataset(name, payload, check=check) and ok
    return ok


if __name__ == "__main__":
    sys.exit(0 if build("--check" in sys.argv) else 1)

"""Fairphone reference dataset (docs/PLAN.md §29, WP 19.4a).

Source: Fairphone's own Supply Chain Engagement report 2024 —
  Annex 1, "List of assembly suppliers and sub-suppliers" (pages 38–42)
  Annex 2, "List of smelters and refiners" (pages 44–53)
Fairphone publishes these on purpose; this dataset records the FACTS they
state (who, tier, country, component category, product), each with the page
and a short verbatim fragment, and is labelled as not endorsed by Fairphone.

Shape (what the WP 19.1/19.2 loader reads):
  entities   — {ref, type, name, country, identifiers}; `ref` is local to this
               file; identity across files is the resolver's job, never ours
  assertions — {subject, relation, object, qualifier, evidence[]}

Faithful to the document's own words: a row says a supplier "provide[s]
components for" a Fairphone product at a tier counted from final assembly, so
every row is `SuppliesTo` the PRODUCT with its tier — not to a named buyer the
document does not name. Smelters are in the products' supply chain at an
unstated path, which the qualifier says.

  python scripts/kg_reference/build_fairphone.py          # fetch (cached) + write
  python scripts/kg_reference/build_fairphone.py --check  # rebuild, compare
"""
from __future__ import annotations

import sys

import pdfplumber

from common import clean, fetch, fragment, write_dataset

SOURCE_ID = "fairphone-sce-2024"
URL = "https://www.fairphone.com/wp-content/uploads/2024/05/SCE-2024.pdf"
ANNEX1_PAGES = range(38, 43)   # 1-based, inclusive of 42
ANNEX2_PAGES = range(44, 54)
LABEL = ("Mapped from Fairphone's own public disclosures (Supply Chain Engagement report 2024). "
         "Not endorsed by or affiliated with Fairphone B.V. Inclusion on Fairphone's list does not "
         "imply a direct relationship with Fairphone (the report's own caveat).")

FOCAL = {"ref": "focal", "type": "Company", "name": "Fairphone B.V.", "country": "Netherlands",
         "identifiers": {}}
PRODUCTS = ("Fairphone 4", "Fairphone 5", "Fairbuds", "Fairbuds XL")


def _products(cell: str) -> list[str]:
    parts = [clean(p) for p in clean(cell).split(",")]
    return [p for p in parts if p]


def _site(address: str) -> tuple[str, str]:
    a = clean(address)
    for kind in ("Manufacturer", "Manufacture", "Headquarters"):
        if a.lower().startswith(kind.lower() + ":"):
            return ("headquarters" if kind == "Headquarters" else "manufacturing"), a[len(kind) + 1:].strip()
    return "unstated", a


def build() -> dict:
    path = fetch(SOURCE_ID, URL, "fairphone-SCE-2024.pdf", "Fairphone B.V.",
                 "Published by Fairphone for transparency; robots.txt permits the path. Facts and short "
                 "fragments only; the document is not redistributed.")
    entities = [FOCAL] + [{"ref": f"product:{p}", "type": "Product", "name": p, "country": None,
                           "identifiers": {}} for p in PRODUCTS]
    assertions = [{"subject": "focal", "relation": "Produces", "object": f"product:{p}",
                   "qualifier": {}, "evidence": [{"source": SOURCE_ID, "page": 3,
                                                  "fragment": "chains of Fairphone 4, Fairphone 5, Fairbuds and Fairbuds XL."}]}
                  for p in PRODUCTS]
    skipped = []
    n = 0
    with pdfplumber.open(path) as pdf:
        for page in ANNEX1_PAGES:
            for table in pdf.pages[page - 1].extract_tables():
                for row in table:
                    cells = [clean(c) for c in row]
                    tier = cells[1] if len(cells) > 1 else ""
                    if not tier.startswith("Tier ") or not tier[5:].isdigit():
                        if tier not in ("Tier", ""):
                            skipped.append((page, cells[:3]))
                        continue
                    _, _, name, sites, address, country, website, products, category = cells[:9]
                    n += 1
                    ref = f"fp-a1-{n:03d}"
                    site_kind, addr = _site(address)
                    entities.append({"ref": ref, "type": "Company", "name": name, "country": country or None,
                                     "identifiers": {"website": website} if website and
                                     website.lower() != "no official website" else {}})
                    ev = [{"source": SOURCE_ID, "page": page,
                           "fragment": fragment(f"{tier} {name} {country} {products} {category}")}]
                    for p in _products(products):
                        assertions.append({"subject": ref, "relation": "SuppliesTo", "object": f"product:{p}"
                                           if p in PRODUCTS else p,
                                           "qualifier": {"tier": int(tier[5:]), "category": category,
                                                         "sites": int(sites) if sites.isdigit() else None},
                                           "evidence": ev})
                    if country:
                        assertions.append({"subject": ref, "relation": "LocatedIn", "object": f"country:{country}",
                                           "qualifier": {"site_kind": site_kind, "address": addr},
                                           "evidence": [{"source": SOURCE_ID, "page": page, "fragment": fragment(address)}]})
        metal = None
        m = 0
        for page in ANNEX2_PAGES:
            for table in pdf.pages[page - 1].extract_tables():
                for row in table:
                    cells = [clean(c) for c in row]
                    if cells and cells[0] and len(cells) > 1 and not any(cells[1:]):
                        metal = cells[0].title()          # a section header row: GOLD, TIN, …
                        continue
                    if not cells or not cells[0].startswith("CID"):
                        continue
                    cid, name, country, status = (cells + [""] * 4)[:4]
                    m += 1
                    ref = f"fp-a2-{cid}"
                    entities.append({"ref": ref, "type": "Company", "name": name, "country": country.title() or None,
                                     "identifiers": {"rmi_cid": cid}})
                    ev = [{"source": SOURCE_ID, "page": page, "fragment": fragment(f"{cid} {name} {country} {status}")}]
                    assertions.append({"subject": ref, "relation": "Produces", "object": f"material:{metal}",
                                       "qualifier": {"role": "smelter_or_refiner", "audit_status": status},
                                       "evidence": ev})
                    assertions.append({"subject": ref, "relation": "SuppliesTo", "object": "focal",
                                       "qualifier": {"tier": None, "path": "not stated — in the supply chain of "
                                                     "Fairphone 4, Fairphone 5, Fairbuds and Fairbuds XL",
                                                     "material": metal}, "evidence": ev})
    countries = sorted({e["country"] for e in entities if e.get("country")})
    entities += [{"ref": f"country:{c}", "type": "Location", "name": c, "country": c, "identifiers": {}}
                 for c in countries]
    mats = sorted({a["object"][9:] for a in assertions if a["object"].startswith("material:")})
    entities += [{"ref": f"material:{x}", "type": "Material", "name": x, "country": None, "identifiers": {}}
                 for x in mats]
    return {"dataset": "fairphone", "label": LABEL, "focal": "focal", "sources": [SOURCE_ID],
            "counts": {"annex1_rows": n, "annex2_smelters": m, "skipped_rows": len(skipped)},
            "skipped": [{"page": p, "cells": c} for p, c in skipped],
            "entities": entities, "assertions": assertions}


if __name__ == "__main__":
    ok = write_dataset("fairphone", build(), check="--check" in sys.argv)
    sys.exit(0 if ok else 1)

#!/usr/bin/env python3
"""Build the demo dataset for the three network pages (product, process, firm level).

    python3 scripts/demo_project/build_dataset.py            # write dataset.json + csv/
    python3 scripts/demo_project/build_dataset.py --check    # fail if the committed files differ

THE DATASET IS AUTHORED HERE, ONCE. `dataset.json` is what `seed_demo_project.mjs`
loads; `csv/*.csv` are the same rows in the upload wizard's formats, for loading by
hand through /project-manager. Both are generated, so they cannot disagree.

THE STORY. The manual's synthetic control-unit assembly (`public/examples/control-unit`),
grown so every one of the three pages has something to show:

  * Product level  — 1 finished product, 10 purchased materials, 11 suppliers,
                     2 customers, a second source for the microcontroller.
  * Process level  — a three-deep bill of materials: 3 sub-assemblies, so the page's
                     depth lens has levels to separate.
  * Firm level     — a 41-firm deep-tier graph (the plant, 11 tier-1, 17 tier-2,
                     12 tier-3 firms) in 16 countries, with shared upstream firms
                     (a wafer foundry, a resin maker, a copper-cathode miner) so a
                     few of them are visibly more critical than the rest.

EVERYTHING IS FICTIONAL. Firm names, revenues, headcounts and relationships are
invented; only the cities are real (they place the dots on the map). Websites use
the reserved `.example` TLD so no name here points at a real site.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NS = uuid.uuid5(uuid.NAMESPACE_DNS, "demo.suresuite.example")

PROJECT = {
    "name": "Demo — Control Unit Supply Network",
    "plant": "Stuttgart Plant",
    "model": "Make-To-Order",
    "bom_level": "multi",
}

# ── Chain: tier-1 suppliers (also the depth-1 firms of the deep-tier graph) ──────
# id, name, country, city, lat, long, capacity/wk, reliability, industry, employees, revenue USD
SUPPLIERS = [
    ("S-PCB",      "Lumora Circuit Works",       "Taiwan",         "Taoyuan",      24.9936,  121.3010,  900, 0.97, "Printed Circuit Boards",        1800,   410_000_000),
    ("S-MCU",      "Kestrel Microsystems",       "Japan",          "Kyoto",        35.0116,  135.7681,  500, 0.98, "Semiconductors",                2600,  1_250_000_000),
    ("S-MCU2",     "Orrin Semiconductor",        "Malaysia",       "Penang",        5.4164,  100.3327,  300, 0.94, "Semiconductors",                1500,   640_000_000),
    ("S-PASSIVE",  "Vantor Passive Components",  "China",          "Suzhou",       31.2990,  120.5853, 1200, 0.93, "Electronic Components",         3400,   520_000_000),
    ("S-CONN",     "Tessaro Connectors",         "Mexico",         "Guadalajara",  20.6597, -103.3496,  800, 0.95, "Connectors",                    1250,   230_000_000),
    ("S-HARNESS",  "Halong Cable Systems",       "Vietnam",        "Hanoi",        21.0278,  105.8342,  600, 0.92, "Wiring Harnesses",              2900,   190_000_000),
    ("S-SENS",     "Dorado Sensor Tech",         "South Korea",    "Busan",        35.1796,  129.0756,  400, 0.96, "Sensors",                        900,   310_000_000),
    ("S-PLASTIC",  "Brannock Polymers",          "Poland",         "Katowice",     50.2649,   19.0238,  500, 0.97, "Plastic Moulding",              1100,   170_000_000),
    ("S-SEAL",     "Moravia Rubber Seals",       "Czech Republic", "Brno",         49.1951,   16.6068,  400, 0.98, "Rubber Products",                640,    85_000_000),
    ("S-FAST",     "Eisenau Fasteners",          "Austria",        "Linz",         48.3069,   14.2858, 4000, 0.99, "Fasteners",                      520,    98_000_000),
    ("S-PRINT",    "Neckar Label Print",         "Germany",        "Ulm",          48.3984,    9.9916,  500, 0.99, "Printing",                       210,    24_000_000),
]

# Customers (chain nodes the map draws): id, name, city, lat, long, volume/wk, price EUR, lead wk
CUSTOMERS = [
    ("C-ASSEMBLY", "Rheinwerk Assembly",     "Munich",  48.1351, 11.5820, 100, 60, 1),
    ("C-SERVICE",  "Nordlicht Service Parts", "Hamburg", 53.5511,  9.9937,  30, 72, 2),
]

# Purchased materials: id, name, unit cost, lead time weeks, per-finished-unit use
MATERIALS = [
    ("M-PCB",       "Printed circuit board",     6.50, 5, 1),
    ("M-MCU",       "Microcontroller",           4.20, 8, 1),
    ("M-CAP",       "Capacitor kit",             0.80, 4, 1),
    ("M-CONNECTOR", "Board connector",           0.55, 3, 2),
    ("M-SENSOR",    "Temperature sensor",        2.40, 4, 1),
    ("M-HARNESS",   "Wiring harness",            3.10, 4, 1),
    ("M-SHELL",     "Plastic shell",             1.90, 2, 1),
    ("M-SEAL",      "Gasket",                    0.35, 2, 1),
    ("M-SCREW",     "Fastener (each)",           0.04, 1, 6),
    ("M-LABEL",     "Product label",             0.05, 1, 1),
]

# Which supplier delivers which material, and the split when there are two.
# supplier, material, share of that material, unit price, lead time weeks
SOURCING = [
    ("S-PCB",     "M-PCB",       1.00, 6.50, 5),
    ("S-MCU",     "M-MCU",       0.70, 4.20, 8),
    ("S-MCU2",    "M-MCU",       0.30, 4.50, 6),
    ("S-PASSIVE", "M-CAP",       1.00, 0.80, 4),
    ("S-CONN",    "M-CONNECTOR", 1.00, 0.55, 3),
    ("S-SENS",    "M-SENSOR",    1.00, 2.40, 4),
    ("S-HARNESS", "M-HARNESS",   1.00, 3.10, 4),
    ("S-PLASTIC", "M-SHELL",     1.00, 1.90, 2),
    ("S-SEAL",    "M-SEAL",      1.00, 0.35, 2),
    ("S-FAST",    "M-SCREW",     1.00, 0.04, 1),
    ("S-PRINT",   "M-LABEL",     1.00, 0.05, 1),
]

# Bill of materials, per ONE unit of the parent on the row. Level 1 NAMES THE FINISHED
# PRODUCT as its parent. The table also allows an empty parent there ("the finished
# product itself"), and the network pages read it that way — but the platform's pre-run
# data check and the worker's BOM flattening take the roots of the tree as the products,
# so an empty parent leaves the product with no BOM and every run is refused ("products
# with empty BoM"). Naming the product satisfies all three readers.
# material, level, parent, rate
_P = "P-CONTROL"
BOM = [
    ("A-ELEC",      1, _P,          1),
    ("A-HOUSING",   1, _P,          1),
    ("M-HARNESS",   1, _P,          1),
    ("M-LABEL",     1, _P,          1),
    ("A-BOARD",     2, "A-ELEC",    1),
    ("M-CONNECTOR", 2, "A-ELEC",    2),
    ("M-SENSOR",    2, "A-ELEC",    1),
    ("M-SHELL",     2, "A-HOUSING", 1),
    ("M-SEAL",      2, "A-HOUSING", 1),
    ("M-SCREW",     2, "A-HOUSING", 6),
    ("M-PCB",       3, "A-BOARD",   1),
    ("M-MCU",       3, "A-BOARD",   1),
    ("M-CAP",       3, "A-BOARD",   1),
]
SUBASSEMBLIES = {"A-ELEC": "Electronics module", "A-HOUSING": "Housing assembly", "A-BOARD": "Populated control board"}

PRODUCT = ("P-CONTROL", "Control unit", 60, 150, "mto", "triangular", 130, 0.2)

# ── Deep-tier firm graph ────────────────────────────────────────────────────────
# key, name, country, city, lat, long, industry, employees, revenue USD
PLANT_FIRM = ("PLANT", "Stuttgart Control Systems GmbH", "Germany", "Stuttgart", 48.7758, 9.1829,
              "Industrial Controls", 4200, 1_650_000_000)

TIER2 = [
    ("LAM",      "Corvane Laminates",        "Taiwan",        "Hsinchu",      24.8138, 120.9675, "Laminates",              780,  140_000_000),
    ("SUNDRA",   "Sundra Chemicals",         "Japan",         "Osaka",        34.6937, 135.5023, "Specialty Chemicals",   5200, 2_100_000_000),
    ("FAB",      "Aurelia Wafer Foundry",    "Taiwan",        "Hsinchu",      24.7736, 121.0100, "Semiconductor Foundry", 9800, 7_400_000_000),
    ("PKG",      "Pinewood Chip Packaging",  "Malaysia",      "Penang",        5.3117, 100.4592, "Semiconductor Packaging",1900,  380_000_000),
    ("LEAD",     "Selangor Lead Frames",     "Malaysia",      "Kuala Lumpur",  3.1390, 101.6869, "Metal Stamping",         1100,  120_000_000),
    ("CERAM",    "Ganzhou Ceramic Powders",  "China",         "Ganzhou",      25.8310, 114.9335, "Advanced Ceramics",     1400,  210_000_000),
    ("METAL",    "Zhuzhou Metal Foils",      "China",         "Zhuzhou",      27.8274, 113.1340, "Metal Foils",            950,  160_000_000),
    ("COPPER",   "Sonora Copper Strip",      "Mexico",        "Hermosillo",   29.0729,-110.9559, "Copper Products",       1600,  340_000_000),
    ("RESIN",    "Gulfline Resins",          "United States", "Houston",      29.7604, -95.3698, "Plastic Resins",        6100, 3_900_000_000),
    ("WIRE",     "Dong Nai Copper Wire",     "Vietnam",       "Bien Hoa",     10.9574, 106.8426, "Wire and Cable",         870,  145_000_000),
    ("GLASS",    "Ulsan Glass Substrates",   "South Korea",   "Ulsan",        35.5384, 129.3114, "Glass Products",        2100,  480_000_000),
    ("PIGMENT",  "Lodz Pigments",            "Poland",        "Lodz",         51.7592,  19.4560, "Pigments",               310,   46_000_000),
    ("RUBBER",   "Songkhla Natural Rubber",  "Thailand",      "Songkhla",      7.1756, 100.6144, "Natural Rubber",         740,  120_000_000),
    ("ELASTO",   "Ostrava Elastomers",       "Czech Republic","Ostrava",      49.8209,  18.2625, "Synthetic Rubber",       520,   98_000_000),
    ("STEEL",    "Donawitz Steel Wire",      "Austria",       "Leoben",       47.3807,  15.0940, "Steel Wire",            1250,  410_000_000),
    ("PAPER",    "Schwarzwald Paper Mill",   "Germany",       "Freiburg",     47.9990,   7.8421, "Paper Products",         430,   72_000_000),
    ("INK",      "Rhein Ink Works",          "Germany",       "Cologne",      50.9375,   6.9603, "Printing Inks",          190,   31_000_000),
]

TIER3 = [
    ("SILICON",  "Nagano Silicon Boules",    "Japan",         "Nagano",       36.6513, 138.1810, "Silicon Wafers",        2300,  950_000_000),
    ("RESIST",   "Kanto Photoresist",        "Japan",         "Tokyo",        35.6762, 139.6503, "Photochemicals",         410,  210_000_000),
    ("GAS",      "Bayou Specialty Gases",    "United States", "Baytown",      29.7355, -94.9774, "Industrial Gases",      1700,  880_000_000),
    ("GLASSFIB", "Changzhou Glass Fibre",    "China",         "Changzhou",    31.8112, 119.9740, "Glass Fibre",           2600,  540_000_000),
    ("FOIL",     "Taoyuan Copper Foil",      "Taiwan",        "Taoyuan",      24.9937, 121.3169, "Copper Foil",            680,  260_000_000),
    ("NAPHTHA",  "Baytown Olefins",          "United States", "Baytown",      29.7355, -94.9774, "Petrochemicals",        3800, 5_200_000_000),
    ("BENZENE",  "Jubail Aromatics",         "Saudi Arabia",  "Jubail",       27.0046,  49.6225, "Petrochemicals",        2900, 3_100_000_000),
    ("CATHODE",  "Calama Copper Cathode",    "Chile",         "Calama",      -22.4667, -68.9333, "Copper Mining",        7400, 4_800_000_000),
    ("OXIDE",    "Baotou Rare Earth Oxides", "China",         "Baotou",       40.6574, 109.8404, "Rare Earth Mining",     3100,  690_000_000),
    ("PELLET",   "Erzberg Iron Pellets",     "Austria",       "Eisenerz",     47.5290,  14.8830, "Iron Ore",               560,  130_000_000),
    ("LATEX",    "Southern Plantation Coop", "Thailand",      "Hat Yai",       7.0086, 100.4747, "Rubber Plantations",    4100,  150_000_000),
    ("PULP",     "Kymi Pulp",                "Finland",       "Kotka",        60.4664,  26.9458, "Pulp",                  1200,  520_000_000),
]

# Edges, buyer -> supplier, with the supplier's share of revenue sold to the buyer (%).
# The plant buys from every tier-1 firm; its share is of the TIER-1 FIRM's revenue.
TIER1_SHARE = {"S-PCB": 38, "S-MCU": 9, "S-MCU2": 21, "S-PASSIVE": 6, "S-CONN": 18, "S-HARNESS": 24,
               "S-SENS": 12, "S-PLASTIC": 22, "S-SEAL": 35, "S-FAST": 14, "S-PRINT": 60}
# tier-1 supplier id -> [(tier-2 key, share %)]
T1_T2 = {
    "S-PCB":     [("LAM", 30), ("SUNDRA", 4)],
    "S-MCU":     [("FAB", 18), ("PKG", 12)],
    "S-MCU2":    [("FAB", 26), ("LEAD", 14)],
    "S-PASSIVE": [("CERAM", 22), ("METAL", 19)],
    "S-CONN":    [("COPPER", 16), ("RESIN", 2)],
    "S-HARNESS": [("WIRE", 41), ("RESIN", 2)],
    "S-SENS":    [("FAB", 8), ("GLASS", 11)],
    "S-PLASTIC": [("RESIN", 3), ("PIGMENT", 25)],
    "S-SEAL":    [("RUBBER", 33), ("ELASTO", 28)],
    "S-FAST":    [("STEEL", 9)],
    "S-PRINT":   [("PAPER", 44), ("INK", 52)],
}
# tier-2 key -> [(tier-3 key, share %)]
T2_T3 = {
    "FAB":     [("SILICON", 14), ("RESIST", 31), ("GAS", 7)],
    "LAM":     [("GLASSFIB", 12), ("FOIL", 36)],
    "RESIN":   [("NAPHTHA", 8), ("BENZENE", 6)],
    "COPPER":  [("CATHODE", 3)],
    "WIRE":    [("CATHODE", 2)],
    "CERAM":   [("OXIDE", 27)],
    "STEEL":   [("PELLET", 45)],
    "RUBBER":  [("LATEX", 58)],
    "PAPER":   [("PULP", 39)],
}


def fuid(key: str) -> str:
    """A stable firm id: the same key always yields the same uuid."""
    return str(uuid.uuid5(NS, key))


def site(name: str) -> str:
    slug = "".join(c for c in name.lower() if c.isalnum() or c == " ").replace(" ", "")
    return f"www.{slug}.example"


def build() -> dict:
    d: dict = {
        "_about": (
            "Demo dataset for the product-, process- and firm-level network pages. Authored in "
            "build_dataset.py and generated; do not edit by hand. Every firm is fictional. "
            "Inbound lead_time and outbound expected_lead_time are in WEEKS."
        ),
        "project": PROJECT,
    }

    d["suppliers"] = [
        {"supplier_id": s[0], "name": s[1], "capacity_per_week": s[6], "reliability_score": s[7]}
        for s in SUPPLIERS
    ]
    # About two weeks of cover on hand at the start.
    weekly_demand = sum(c[5] for c in CUSTOMERS)
    d["materials"] = [
        {"material_id": m[0], "name": m[1], "cost": m[2], "holding_cost_pct": 0.2, "moq": 1,
         "initial_on_hand": int(round(m[4] * weekly_demand * 2)),
         "lead_time_dist": "deterministic", "lead_time_cv": 0}
        for m in MATERIALS
    ]
    p = PRODUCT
    d["products"] = [{
        "product_id": p[0], "name": p[1], "sell_price": p[2], "production_capacity": p[3],
        "fulfillment_mode": p[4], "demand_distribution": p[5], "demand_mean": p[6], "demand_cv": p[7],
    }]
    d["bom_multi_level"] = [
        {"material_id": m, "level": lv, "higher_level_component_id": par, "consumption_rate": r}
        for (m, lv, par, r) in BOM
    ]

    use = {m[0]: m[4] for m in MATERIALS}
    d["inbound"] = [
        {"supplier_id": s, "material_id": m, "volume": int(round(use[m] * weekly_demand * share)),
         "time_unit": "week", "lead_time": lt, "lead_time_unit": "week", "unit_price": price}
        for (s, m, share, price, lt) in SOURCING
    ]
    d["outbound"] = [
        {"customer_id": c[0], "product_id": p[0], "volume": c[5], "time_unit": "week",
         "expected_lead_time": c[7], "unit_price": c[6]}
        for c in CUSTOMERS
    ]

    # Locations for the map (the page draws suppliers and customers).
    d["node_list"] = (
        [{"node_id": s[0], "description_text": s[8], "location_text": f"{s[3]}, {s[2]}",
          "latitude": s[4], "longitude": s[5]} for s in SUPPLIERS]
        + [{"node_id": c[0], "description_text": "Customer", "location_text": f"{c[2]}, Germany",
            "latitude": c[3], "longitude": c[4]} for c in CUSTOMERS]
    )

    # Deep-tier firms.
    def node(key, name, country, city, lat, lon, industry, emp, rev, depth, seed=False):
        return {"uid": fuid(key), "depth": depth, "name": name, "country": country, "industry": industry,
                "website": site(name), "traded_as": "", "number_of_employees": emp, "revenue": rev,
                "lat": lat, "long": lon, "is_seed": seed}

    pf = PLANT_FIRM
    nodes = [node("PLANT", pf[1], pf[2], pf[3], pf[4], pf[5], pf[6], pf[7], pf[8], 0, True)]
    for s in SUPPLIERS:
        nodes.append(node(s[0], s[1], s[2], s[3], s[4], s[5], s[8], s[9], s[10], 1))
    for t in TIER2:
        nodes.append(node("T2-" + t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], 2))
    for t in TIER3:
        nodes.append(node("T3-" + t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], 3))
    d["network_nodes"] = nodes
    rev = {n["uid"]: n["revenue"] for n in nodes}

    def edge(src_key, dst_key, pct, depth):
        dst = fuid(dst_key)
        return {"src_uid": fuid(src_key), "dst_uid": dst, "relation_type": "Supplier",
                "relative_revenue": round(rev[dst] * pct / 100 / 1_000_000, 1),
                "relative_revenue_percentage": pct, "depth": depth, "direction": "suppliers"}

    edges = [edge("PLANT", s[0], TIER1_SHARE[s[0]], 1) for s in SUPPLIERS]
    for t1, kids in T1_T2.items():
        edges += [edge(t1, "T2-" + k, pct, 2) for k, pct in kids]
    for t2, kids in T2_T3.items():
        edges += [edge("T2-" + t2, "T3-" + k, pct, 3) for k, pct in kids]
    d["network_edges"] = edges
    return d


# ── Self-checks: a dataset that fails these never reaches a file ────────────────
def check(d: dict) -> list[str]:
    errs: list[str] = []
    sup = {s["supplier_id"] for s in d["suppliers"]}
    mat = {m["material_id"] for m in d["materials"]}
    prod = {p["product_id"] for p in d["products"]}
    parents = {b["higher_level_component_id"] for b in d["bom_multi_level"] if b["higher_level_component_id"]} - prod
    items = {b["material_id"] for b in d["bom_multi_level"]}
    leaves = items - parents
    # every leaf is a purchased material, and every purchased material is sourced
    if leaves != mat:
        errs.append(f"BOM leaves {sorted(leaves)} differ from the material master {sorted(mat)}")
    sourced = {i["material_id"] for i in d["inbound"]}
    if sourced != mat:
        errs.append(f"materials without an inbound lane: {sorted(mat - sourced)}")
    for i in d["inbound"]:
        if i["supplier_id"] not in sup:
            errs.append(f"inbound names unknown supplier {i['supplier_id']}")
    for o in d["outbound"]:
        if o["product_id"] not in prod:
            errs.append(f"outbound names unknown product {o['product_id']}")
    # level = depth of the parent chain + 1; level 1 hangs under a finished product
    level_of = {b["material_id"]: b["level"] for b in d["bom_multi_level"]}
    for b in d["bom_multi_level"]:
        par = b["higher_level_component_id"]
        want = level_of.get(par, 0) + 1
        if b["level"] != want:
            errs.append(f"BOM {b['material_id']} under {par or 'nothing'}: level {b['level']}, expected {want}")
        if b["level"] == 1 and par not in prod:
            errs.append(f"BOM {b['material_id']} is level 1 but its parent {par!r} is not a finished product")
    # shares of one material sum to 1
    for m in mat:
        total = sum(sh for (_s, mm, sh, _p, _l) in SOURCING if mm == m)
        if abs(total - 1) > 1e-9:
            errs.append(f"sourcing shares of {m} sum to {total}")
    # deep-tier graph: unique uids, edges join existing firms, one step down each time
    uids = {n["uid"]: n for n in d["network_nodes"]}
    if len(uids) != len(d["network_nodes"]):
        errs.append("duplicate firm uid")
    if sum(1 for n in d["network_nodes"] if n["is_seed"]) != 1:
        errs.append("need exactly one seed firm")
    seen = set()
    for e in d["network_edges"]:
        a, b = uids.get(e["src_uid"]), uids.get(e["dst_uid"])
        if not a or not b:
            errs.append("edge names a firm with no node")
            continue
        if b["depth"] != a["depth"] + 1 or e["depth"] != b["depth"]:
            errs.append(f"edge {a['name']} -> {b['name']} is not one tier down")
        if (e["src_uid"], e["dst_uid"]) in seen:
            errs.append(f"duplicate edge {a['name']} -> {b['name']}")
        seen.add((e["src_uid"], e["dst_uid"]))
    reached = {e["dst_uid"] for e in d["network_edges"]}
    for n in d["network_nodes"]:
        if not n["is_seed"] and n["uid"] not in reached:
            errs.append(f"firm {n['name']} is not reachable from the plant")
    # the tier-1 firms of the graph ARE the chain's suppliers (same names, countries)
    names = {n["name"] for n in d["network_nodes"] if n["depth"] == 1}
    if names != {s[1] for s in SUPPLIERS}:
        errs.append("depth-1 firms differ from the chain suppliers")
    return errs


def to_csv(rows: list[dict], cols: list[str]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for r in rows:
        w.writerow(["" if r.get(c) is None else r[c] for c in cols])
    return buf.getvalue()


CSV_SPECS = {
    "suppliers.csv": ("suppliers", ["supplier_id", "name", "capacity_per_week", "reliability_score"]),
    "materials.csv": ("materials", ["material_id", "name", "cost", "holding_cost_pct", "moq", "initial_on_hand",
                                    "lead_time_dist", "lead_time_cv"]),
    "products.csv": ("products", ["product_id", "name", "sell_price", "production_capacity", "fulfillment_mode",
                                  "demand_distribution", "demand_mean", "demand_cv"]),
    "bom_multi_level.csv": ("bom_multi_level", ["material_id", "level", "higher_level_component_id", "consumption_rate"]),
    "inbound_logistics.csv": ("inbound", ["supplier_id", "material_id", "volume", "time_unit", "lead_time",
                                          "lead_time_unit", "unit_price"]),
    "outbound_logistics.csv": ("outbound", ["customer_id", "product_id", "volume", "time_unit",
                                            "expected_lead_time", "unit_price"]),
    "node_list.csv": ("node_list", ["node_id", "description_text", "location_text", "latitude", "longitude"]),
    "network_nodes.csv": ("network_nodes", ["uid", "depth", "name", "country", "industry", "website", "traded_as",
                                            "number_of_employees", "revenue", "lat", "long", "is_seed"]),
    "network_edges.csv": ("network_edges", ["src_uid", "dst_uid", "relation_type", "relative_revenue",
                                            "relative_revenue_percentage", "depth", "direction"]),
}


def outputs(d: dict) -> dict[Path, str]:
    out = {HERE / "dataset.json": json.dumps(d, indent=2, ensure_ascii=False) + "\n"}
    for fname, (key, cols) in CSV_SPECS.items():
        rows = d[key]
        if key == "network_nodes":  # the upload parser reads the literal words
            rows = [{**r, "is_seed": "True" if r["is_seed"] else "False"} for r in rows]
        out[HERE / "csv" / fname] = to_csv(rows, cols)
    return out


def main() -> int:
    d = build()
    errs = check(d)
    if errs:
        print("dataset is inconsistent:", *errs, sep="\n  - ")
        return 1
    files = outputs(d)
    if "--check" in sys.argv:
        stale = [str(p.relative_to(HERE.parent.parent)) for p, text in files.items()
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            print("out of date — run `python3 scripts/demo_project/build_dataset.py`:", *stale, sep="\n  ")
            return 1
        print(f"demo dataset current ({len(files)} files)")
        return 0
    (HERE / "csv").mkdir(exist_ok=True)
    for p, text in files.items():
        p.write_text(text, encoding="utf-8")
    n = {k: len(d[k]) for k in ("suppliers", "materials", "bom_multi_level", "inbound", "outbound", "network_nodes", "network_edges")}
    print("wrote", len(files), "files:", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())

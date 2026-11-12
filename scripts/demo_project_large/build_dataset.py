#!/usr/bin/env python3
"""Build the LARGE demo dataset: 100 products, 1 000 suppliers, a multi-level bill of materials.

    python3 scripts/demo_project_large/build_dataset.py                 # write out/dataset.json + out/csv/
    python3 scripts/demo_project_large/build_dataset.py --check        # build and self-check only
    python3 scripts/demo_project_large/build_dataset.py --products 12 --suppliers 80 --materials 150 \
        --out /tmp/small-large                                         # a small instance, same shape

WHY IT EXISTS. `scripts/demo_project` is a one-product, 11-supplier network: right for showing
what each page DOES, far too small to show what each page does when a project is BIG. This is the
same story at the scale where the three network lenses stop being readable as a single graph
(see `src/lib/network/scale.ts`): thousands of nodes and edges, a BOM four levels deep, a
deep-tier firm graph of about three thousand firms.

THE OUTPUT IS NOT COMMITTED. It is a few megabytes and fully determined by the flags and the
seed, so `out/` is ignored by git and rebuilt on demand. `seed_demo_project.mjs` loads it with
`DATASET_DIR=scripts/demo_project_large/out`.

SHAPE (defaults)
  * 100 finished products in 10 families, each with a four-level BOM: 3 sub-assemblies under the
    product, 1-2 under each of those, some a level further down. Sub-assemblies have ONE parent
    each; purchased materials are SHARED across products (a family's materials, plus a pool of
    commodities every family uses), which is what makes a material "important".
  * 1 800 purchased materials, every one used by at least one product and sourced by 1-3
    suppliers (shares sum to 1). About 5 000 BOM rows in all — kept well under 10 000, the
    most any unpaged read returns from production.
  * 1 000 suppliers in 16 specialities, each supplying at least one material; a few supply many
    (supplier choice is skewed, so concentration shows up). Capacity is set from what each
    supplier is asked to ship, so the baseline is feasible rather than starved.
  * 25 customers; each product is sold to 1-3 of them.
  * A deep-tier firm graph: the plant, the 1 000 suppliers as tier 1, then ~1 400 tier-2 and
    ~700 tier-3 firms, with shared upstream hubs (a few firms feed many). Every firm is
    reachable from the plant, every edge goes exactly one tier down.

EVERYTHING IS FICTIONAL. Firm names are generated from syllables; revenues, headcounts and
relationships are invented. Only the cities are real (they place the dots on the map), nudged by
a few tenths of a degree so a thousand suppliers do not stack on a handful of pixels. Websites
use the reserved `.example` TLD.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import random
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
NS = uuid.uuid5(uuid.NAMESPACE_DNS, "demo-large.suresuite.example")

PROJECT = {
    "name": "Demo — Large Network (100 products, 1 000 suppliers)",
    "plant": "Stuttgart Plant",
    "model": "Make-To-Order",
    "bom_level": "multi",
}

# country -> [(city, lat, long)]. Real cities; the dataset nudges each pin.
GEO: dict[str, list[tuple[str, float, float]]] = {
    "China": [("Suzhou", 31.30, 120.59), ("Shenzhen", 22.54, 114.06), ("Dongguan", 23.02, 113.75), ("Ningbo", 29.87, 121.54), ("Chengdu", 30.57, 104.07), ("Wuhan", 30.59, 114.31)],
    "Taiwan": [("Taoyuan", 24.99, 121.30), ("Hsinchu", 24.81, 120.97), ("Taichung", 24.15, 120.67)],
    "Japan": [("Kyoto", 35.01, 135.77), ("Nagoya", 35.18, 136.91), ("Osaka", 34.69, 135.50)],
    "South Korea": [("Busan", 35.18, 129.08), ("Incheon", 37.46, 126.71), ("Ulsan", 35.54, 129.31)],
    "Germany": [("Stuttgart", 48.78, 9.18), ("Ulm", 48.40, 9.99), ("Dresden", 51.05, 13.74), ("Nuremberg", 49.45, 11.08)],
    "Poland": [("Katowice", 50.26, 19.02), ("Wroclaw", 51.11, 17.04), ("Poznan", 52.41, 16.93)],
    "Czech Republic": [("Brno", 49.20, 16.61), ("Ostrava", 49.82, 18.26)],
    "Austria": [("Linz", 48.31, 14.29), ("Graz", 47.07, 15.44)],
    "Italy": [("Turin", 45.07, 7.69), ("Bologna", 44.49, 11.34), ("Brescia", 45.54, 10.22)],
    "Spain": [("Barcelona", 41.39, 2.17), ("Valencia", 39.47, -0.38)],
    "Turkey": [("Bursa", 40.18, 29.07), ("Izmir", 38.42, 27.14)],
    "United States": [("Houston", 29.76, -95.37), ("Detroit", 42.33, -83.05), ("Greenville", 34.85, -82.40), ("Phoenix", 33.45, -112.07)],
    "Mexico": [("Guadalajara", 20.66, -103.35), ("Monterrey", 25.69, -100.32), ("Queretaro", 20.59, -100.39)],
    "Brazil": [("Campinas", -22.91, -47.06), ("Curitiba", -25.43, -49.27)],
    "India": [("Pune", 18.52, 73.86), ("Chennai", 13.08, 80.27), ("Bengaluru", 12.97, 77.59)],
    "Vietnam": [("Hanoi", 21.03, 105.83), ("Ho Chi Minh City", 10.82, 106.63)],
    "Thailand": [("Rayong", 12.68, 101.28), ("Bangkok", 13.76, 100.50)],
    "Malaysia": [("Penang", 5.42, 100.33), ("Johor Bahru", 1.49, 103.74)],
    "Indonesia": [("Bekasi", -6.24, 106.99), ("Surabaya", -7.25, 112.75)],
    "United Kingdom": [("Birmingham", 52.49, -1.89), ("Sheffield", 53.38, -1.47)],
    "Netherlands": [("Eindhoven", 51.44, 5.48), ("Rotterdam", 51.92, 4.48)],
    "Canada": [("Windsor", 42.32, -83.04), ("Kitchener", 43.45, -80.49)],
}
# How likely each country is to host a supplier (rough share of global manufacturing).
COUNTRY_WEIGHT = {
    "China": 22, "Taiwan": 7, "Japan": 6, "South Korea": 5, "Germany": 8, "Poland": 3, "Czech Republic": 3,
    "Austria": 1, "Italy": 4, "Spain": 2, "Turkey": 3, "United States": 8, "Mexico": 4, "Brazil": 2,
    "India": 6, "Vietnam": 4, "Thailand": 3, "Malaysia": 3, "Indonesia": 2, "United Kingdom": 2,
    "Netherlands": 1, "Canada": 1,
}

# (speciality, firm noun). A material belongs to one speciality and is sourced from its suppliers.
CATEGORIES = [
    ("Semiconductors", "Microsystems"), ("Printed Circuit Boards", "Circuit Works"),
    ("Electronic Components", "Components"), ("Connectors", "Connectors"),
    ("Wiring Harnesses", "Cable Systems"), ("Sensors", "Sensor Tech"),
    ("Plastic Moulding", "Polymers"), ("Rubber Products", "Elastomers"),
    ("Fasteners", "Fasteners"), ("Metal Stamping", "Stamping"),
    ("Castings and Forgings", "Foundry"), ("Packaging", "Packaging"),
    ("Motors and Actuators", "Drives"), ("Batteries", "Energy Cells"),
    ("Optics", "Optics"), ("Coatings and Chemicals", "Coatings"),
]
TIER2_KINDS = [("Laminates", "Laminates"), ("Specialty Chemicals", "Chemicals"), ("Semiconductor Foundry", "Foundry"),
               ("Advanced Ceramics", "Ceramics"), ("Metal Foils", "Foils"), ("Plastic Resins", "Resins"),
               ("Wire and Cable", "Wire"), ("Glass Products", "Glass"), ("Steel Wire", "Steelworks"),
               ("Synthetic Rubber", "Rubber Compounds"), ("Paper Products", "Paper"), ("Copper Products", "Copper")]
TIER3_KINDS = [("Silicon Wafers", "Silicon"), ("Photochemicals", "Photochemicals"), ("Industrial Gases", "Gases"),
               ("Petrochemicals", "Petrochemicals"), ("Copper Mining", "Mining"), ("Rare Earth Mining", "Rare Earths"),
               ("Iron Ore", "Iron Ore"), ("Rubber Plantations", "Plantations"), ("Pulp", "Pulp")]

CUSTOMER_CITIES = [("Munich", "Germany", 48.14, 11.58), ("Hamburg", "Germany", 53.55, 9.99), ("Lyon", "France", 45.76, 4.84),
                   ("Milan", "Italy", 45.46, 9.19), ("Gothenburg", "Sweden", 57.71, 11.97), ("Rotterdam", "Netherlands", 51.92, 4.48),
                   ("Chicago", "United States", 41.88, -87.63), ("Atlanta", "United States", 33.75, -84.39),
                   ("Toronto", "Canada", 43.65, -79.38), ("Monterrey", "Mexico", 25.69, -100.32),
                   ("Osaka", "Japan", 34.69, 135.50), ("Seoul", "South Korea", 37.57, 126.98)]

ONSET = ["b", "br", "c", "d", "dr", "f", "g", "gr", "h", "k", "kr", "l", "m", "n", "p", "pr", "r", "s", "st", "t", "tr", "v", "z"]
VOWEL = ["a", "e", "i", "o", "u", "ae", "ia", "ou"]
CODA = ["", "", "n", "r", "l", "s", "x", "th"]
TIERS_OF_PLANT = "Stuttgart Control Systems GmbH"


def fuid(key: str) -> str:
    return str(uuid.uuid5(NS, key))


def site(name: str) -> str:
    slug = "".join(c for c in name.lower() if c.isalnum())
    return f"www.{slug}.example"


class Namer:
    """Unique, pronounceable, invented firm names."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.used: set[str] = set()

    def word(self) -> str:
        r = self.rng
        syl = r.choice([2, 2, 3])
        w = "".join(r.choice(ONSET) + r.choice(VOWEL) + (r.choice(CODA) if i == syl - 1 else "") for i in range(syl))
        return w.capitalize()

    def name(self, noun: str) -> str:
        while True:
            n = f"{self.word()} {noun}"
            if n not in self.used:
                self.used.add(n)
                return n


def weighted_country(rng: random.Random) -> str:
    return rng.choices(list(COUNTRY_WEIGHT), weights=list(COUNTRY_WEIGHT.values()))[0]


def place(rng: random.Random, country: str) -> tuple[str, float, float]:
    city, lat, lon = rng.choice(GEO[country])
    return city, round(lat + rng.uniform(-0.3, 0.3), 4), round(lon + rng.uniform(-0.3, 0.3), 4)


def zipf_pick(rng: random.Random, n: int, s: float) -> int:
    """An index in [0, n) with weight 1/(i+1)^s — a few indices are chosen far more often."""
    weights = [1.0 / (i + 1) ** s for i in range(n)]
    return rng.choices(range(n), weights=weights)[0]


def build(n_products: int, n_suppliers: int, n_materials: int, n_customers: int, seed: int) -> dict:
    rng = random.Random(seed)
    namer = Namer(rng)
    ncat = len(CATEGORIES)

    # ── Suppliers ────────────────────────────────────────────────────────────────
    suppliers = []
    sup_by_cat: dict[int, list[int]] = {c: [] for c in range(ncat)}
    for i in range(n_suppliers):
        cat = i % ncat
        country = weighted_country(rng)
        city, lat, lon = place(rng, country)
        emp = int(min(30000, max(60, rng.lognormvariate(6.4, 1.1))))
        suppliers.append({
            "id": f"S-{i + 1:04d}", "name": namer.name(CATEGORIES[cat][1]), "cat": cat,
            "country": country, "city": city, "lat": lat, "lon": lon, "emp": emp,
            "rev": int(emp * rng.uniform(120_000, 420_000)), "reliability": round(rng.uniform(0.88, 0.995), 3),
        })
        sup_by_cat[cat].append(i)

    # ── The bill of materials, product by product ───────────────────────────────
    # Materials are created lazily, in the order the tree asks for them, so each is first used
    # by a product and every one of the `n_materials` ends up in the BOM.
    mat_cat = [m % ncat for m in range(n_materials)]
    fresh = list(range(n_materials))
    rng.shuffle(fresh)
    commodity = set(range(max(1, n_materials // 6)))  # shared by every family
    n_families = max(1, n_products // 10)
    family_used: dict[int, list[int]] = {f: [] for f in range(n_families)}

    # First pass: the shape, so the number of material slots is known before any is filled.
    shapes = []
    for p in range(n_products):
        l1_subs = 3
        l1_mats = 2
        subs = []
        for _ in range(l1_subs):
            l2_subs = rng.choice([1, 2])
            l2_mats = rng.randint(3, 5)
            sub2 = []
            for _ in range(l2_subs):
                l3_mats = rng.randint(3, 6)
                deeper = rng.random() < 0.3
                sub2.append((l3_mats, rng.randint(3, 4) if deeper else 0))
            subs.append((l2_mats, sub2))
        shapes.append((l1_mats, subs))

    def slots(shape) -> int:
        l1m, subs = shape
        return l1m + sum(m2 + sum(m3 + m4 for (m3, m4) in sub2) for (m2, sub2) in subs)

    remaining_slots = sum(slots(s) for s in shapes)
    if remaining_slots < n_materials:
        raise SystemExit(f"the BOM has {remaining_slots} material slots for {n_materials} materials; raise --products")

    bom: list[dict] = []
    products = []
    mat_rate: dict[str, dict[str, float]] = {}  # product -> material -> units per product (flattened)

    unused = set(range(n_materials))

    def next_fresh() -> int:
        while fresh:
            m = fresh.pop()
            if m in unused:  # a commodity may have been drawn as a "reuse" already
                return m
        raise RuntimeError("no unused material left")

    def pick_material(family: int, taken: set[int]) -> int:
        """Take a not-yet-used material, or reuse one the family (or the commodity pool) already has.

        The odds of a fresh one rise as the slots run out, and it is certain when as many are
        left as there are slots, so every material is used at least once."""
        nonlocal remaining_slots
        nf = len(unused)
        take_fresh = nf > 0 and (nf >= remaining_slots or rng.random() < nf / remaining_slots)
        remaining_slots -= 1
        if take_fresh:
            m = next_fresh()
        else:
            pool = [x for x in family_used[family] if x not in taken]
            pool += [x for x in commodity if x not in taken and rng.random() < 0.15]
            if pool:
                m = rng.choice(pool)
            elif unused:
                m = next_fresh()
            else:
                m = rng.choice([x for x in range(n_materials) if x not in taken])
        unused.discard(m)
        if m not in family_used[family]:
            family_used[family].append(m)
        return m

    def mid(m: int) -> str:
        return f"M-{m + 1:05d}"

    for p, (l1m, subs) in enumerate(shapes):
        pid = f"P-{p + 1:03d}"
        family = p % n_families
        flat: dict[str, float] = {}

        def add_leaf(parent: str, level: int, mult: float, taken: set[int]) -> None:
            m = pick_material(family, taken)
            taken.add(m)
            rate = rng.choice([1, 1, 1, 2, 2, 4, 6])
            bom.append({"material_id": mid(m), "level": level, "higher_level_component_id": parent, "consumption_rate": rate})
            flat[mid(m)] = flat.get(mid(m), 0.0) + mult * rate

        def add_sub(parent: str, level: int, mult: float, k: int) -> tuple[str, float]:
            sid = f"A-{pid[2:]}-{k}"
            rate = rng.choice([1, 1, 2])
            bom.append({"material_id": sid, "level": level, "higher_level_component_id": parent, "consumption_rate": rate})
            return sid, mult * rate

        counter = 0
        taken1: set[int] = set()
        for _ in range(l1m):
            add_leaf(pid, 1, 1.0, taken1)
        for (l2m, sub2) in subs:
            counter += 1
            s1, mult1 = add_sub(pid, 1, 1.0, counter)
            taken2: set[int] = set()
            for _ in range(l2m):
                add_leaf(s1, 2, mult1, taken2)
            for (l3m, l4m) in sub2:
                counter += 1
                s2, mult2 = add_sub(s1, 2, mult1, counter)
                taken3: set[int] = set()
                for _ in range(l3m):
                    add_leaf(s2, 3, mult2, taken3)
                if l4m:
                    counter += 1
                    s3, mult3 = add_sub(s2, 3, mult2, counter)
                    taken4: set[int] = set()
                    for _ in range(l4m):
                        add_leaf(s3, 4, mult3, taken4)
        mat_rate[pid] = flat
        demand = rng.choice([20, 30, 40, 60, 80, 100, 120, 160])
        products.append({"id": pid, "family": family, "demand": demand, "flat": flat})

    # Anything still unused (rounding in the draw above) is hung under the product's first
    # sub-assembly at level 2, so the invariant "every material is in the BOM" holds exactly.
    used = {b["material_id"] for b in bom}
    for m in range(n_materials):
        if mid(m) not in used:
            p = rng.randrange(n_products)
            pid = f"P-{p + 1:03d}"
            parent = f"A-{pid[2:]}-1"
            bom.append({"material_id": mid(m), "level": 2, "higher_level_component_id": parent, "consumption_rate": 1})
            products[p]["flat"][mid(m)] = products[p]["flat"].get(mid(m), 0.0) + 1

    # ── Materials ───────────────────────────────────────────────────────────────
    use_per_week = {mid(m): 0.0 for m in range(n_materials)}
    for pr in products:
        for m, q in pr["flat"].items():
            use_per_week[m] += pr["demand"] * q
    materials = []
    for m in range(n_materials):
        cost = round(min(250.0, max(0.02, rng.lognormvariate(0.9, 1.0))), 2)
        lt = rng.randint(1, 12)
        materials.append({
            "material_id": mid(m), "name": f"{CATEGORIES[mat_cat[m]][0]} item {m + 1:05d}", "cost": cost,
            "holding_cost_pct": 0.2, "moq": 1, "initial_on_hand": int(round(use_per_week[mid(m)] * 2)),
            "lead_time_dist": "deterministic", "lead_time_cv": 0, "_lt": lt, "_cat": mat_cat[m],
        })

    # ── Inbound lanes: who supplies what ───────────────────────────────────────
    # Each supplier gets at least one material of its speciality (round-robin), and further
    # sources are drawn skewed, so some suppliers carry many materials.
    inbound = []
    rr = {c: 0 for c in range(ncat)}
    for mt in materials:
        cat = mt["_cat"]
        pool = sup_by_cat[cat]
        n_src = rng.choices([1, 2, 3], weights=[45, 40, 15])[0]
        chosen: list[int] = [pool[rr[cat] % len(pool)]]
        rr[cat] += 1
        guard = 0
        while len(chosen) < n_src and guard < 20:
            guard += 1
            s = pool[zipf_pick(rng, len(pool), 0.8)]
            if s not in chosen:
                chosen.append(s)
        shares = {1: [1.0], 2: [0.65, 0.35], 3: [0.5, 0.3, 0.2]}[len(chosen)]
        for s, share in zip(chosen, shares):
            vol = max(1, int(round(use_per_week[mt["material_id"]] * share)))
            inbound.append({
                "supplier_id": suppliers[s]["id"], "material_id": mt["material_id"], "volume": vol,
                "time_unit": "week", "lead_time": max(1, mt["_lt"] + rng.choice([-1, 0, 0, 1])), "lead_time_unit": "week",
                "unit_price": round(mt["cost"] * rng.uniform(0.92, 1.12), 2), "_share": share,
            })
    shipped: dict[str, int] = {}
    for lane in inbound:
        shipped[lane["supplier_id"]] = shipped.get(lane["supplier_id"], 0) + lane["volume"]

    d: dict = {
        "_about": (
            "LARGE demo dataset for the three network pages. Authored in "
            "scripts/demo_project_large/build_dataset.py and generated; do not edit by hand. Every "
            "firm is fictional. Inbound lead_time and outbound expected_lead_time are in WEEKS."
        ),
        "project": PROJECT,
    }
    d["suppliers"] = [
        {"supplier_id": s["id"], "name": s["name"],
         "capacity_per_week": max(10, int(math.ceil(1.6 * shipped.get(s["id"], 0)))), "reliability_score": s["reliability"]}
        for s in suppliers
    ]
    d["materials"] = [{k: v for k, v in m.items() if not k.startswith("_")} for m in materials]

    # ── Products, customers, outbound lanes ─────────────────────────────────────
    cost_of = {m["material_id"]: m["cost"] for m in materials}
    d["products"] = []
    for pr in products:
        unit_cost = sum(q * cost_of[m] for m, q in pr["flat"].items())
        d["products"].append({
            "product_id": pr["id"], "name": f"Product {pr['id'][2:]} (family {pr['family'] + 1})",
            "sell_price": round(max(5.0, unit_cost * 1.6), 2), "production_capacity": int(math.ceil(pr["demand"] * 1.6)),
            "fulfillment_mode": "mto", "demand_distribution": "triangular", "demand_mean": pr["demand"], "demand_cv": 0.2,
        })
    customers = []
    for c in range(n_customers):
        city, country, lat, lon = CUSTOMER_CITIES[c % len(CUSTOMER_CITIES)]
        customers.append({"id": f"C-{c + 1:02d}", "name": namer.name("Distribution"), "city": city, "country": country,
                          "lat": round(lat + rng.uniform(-0.2, 0.2), 4), "lon": round(lon + rng.uniform(-0.2, 0.2), 4)})
    price_of = {p["product_id"]: p["sell_price"] for p in d["products"]}
    outbound = []
    for pr in products:
        n_c = rng.choices([1, 2, 3], weights=[40, 40, 20])[0]
        chosen = rng.sample(range(n_customers), min(n_c, n_customers))
        cuts = [rng.random() + 0.3 for _ in chosen]
        for c, w in zip(chosen, cuts):
            outbound.append({
                "customer_id": customers[c]["id"], "product_id": pr["id"],
                "volume": max(1, int(round(pr["demand"] * w / sum(cuts)))), "time_unit": "week",
                "expected_lead_time": rng.randint(1, 3), "unit_price": round(price_of[pr["id"]] * rng.uniform(0.97, 1.05), 2),
            })
    d["bom_multi_level"] = bom
    d["inbound"] = [{k: v for k, v in i.items() if not k.startswith("_")} for i in inbound]
    d["outbound"] = outbound

    d["node_list"] = (
        [{"node_id": s["id"], "description_text": CATEGORIES[s["cat"]][0], "location_text": f"{s['city']}, {s['country']}",
          "latitude": s["lat"], "longitude": s["lon"]} for s in suppliers]
        + [{"node_id": c["id"], "description_text": "Customer", "location_text": f"{c['city']}, {c['country']}",
            "latitude": c["lat"], "longitude": c["lon"]} for c in customers]
    )

    # ── Deep-tier firm graph ───────────────────────────────────────────────────
    def node(key, name, country, lat, lon, industry, emp, rev, depth, seed_firm=False):
        return {"uid": fuid(key), "depth": depth, "name": name, "country": country, "industry": industry,
                "website": site(name), "traded_as": "", "number_of_employees": emp, "revenue": rev,
                "lat": lat, "long": lon, "is_seed": seed_firm}

    nodes = [node("PLANT", TIERS_OF_PLANT, "Germany", 48.7758, 9.1829, "Industrial Controls", 4200, 1_650_000_000, 0, True)]
    for s in suppliers:
        nodes.append(node(s["id"], s["name"], s["country"], s["lat"], s["lon"], CATEGORIES[s["cat"]][0], s["emp"], s["rev"], 1))
    n_t2 = max(1, int(round(n_suppliers * 1.4)))
    n_t3 = max(1, int(round(n_suppliers * 0.7)))
    t2_keys, t3_keys = [], []
    for i in range(n_t2):
        ind, noun = TIER2_KINDS[i % len(TIER2_KINDS)]
        country = weighted_country(rng)
        _, lat, lon = place(rng, country)
        emp = int(min(40000, max(80, rng.lognormvariate(6.8, 1.1))))
        key = f"T2-{i + 1:04d}"
        t2_keys.append(key)
        nodes.append(node(key, namer.name(noun), country, lat, lon, ind, emp, int(emp * rng.uniform(150_000, 500_000)), 2))
    for i in range(n_t3):
        ind, noun = TIER3_KINDS[i % len(TIER3_KINDS)]
        country = weighted_country(rng)
        _, lat, lon = place(rng, country)
        emp = int(min(60000, max(120, rng.lognormvariate(7.2, 1.2))))
        key = f"T3-{i + 1:04d}"
        t3_keys.append(key)
        nodes.append(node(key, namer.name(noun), country, lat, lon, ind, emp, int(emp * rng.uniform(200_000, 900_000)), 3))
    d["network_nodes"] = nodes
    rev = {n["uid"]: n["revenue"] for n in nodes}

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def edge(src_key: str, dst_key: str, pct: int, depth: int) -> None:
        pair = (fuid(src_key), fuid(dst_key))
        if pair in seen:
            return
        seen.add(pair)
        edges.append({"src_uid": pair[0], "dst_uid": pair[1], "relation_type": "Supplier",
                      "relative_revenue": round(rev[pair[1]] * pct / 100 / 1_000_000, 1),
                      "relative_revenue_percentage": pct, "depth": depth, "direction": "suppliers"})

    for s in suppliers:
        edge("PLANT", s["id"], rng.randint(3, 60), 1)
    # tier 1 -> tier 2: round-robin first (every tier-2 firm has a buyer), then skewed extras
    for i, t2 in enumerate(t2_keys):
        edge(suppliers[i % n_suppliers]["id"], t2, rng.randint(2, 45), 2)
    for s in suppliers:
        for _ in range(rng.choice([0, 1, 1, 2])):
            edge(s["id"], t2_keys[zipf_pick(rng, n_t2, 0.9)], rng.randint(2, 45), 2)
    # tier 2 -> tier 3: round-robin first, then a strongly skewed few hubs
    for i, t3 in enumerate(t3_keys):
        edge(t2_keys[i % n_t2], t3, rng.randint(2, 50), 3)
    for t2 in t2_keys:
        for _ in range(rng.choice([0, 0, 1, 1, 2])):
            edge(t2, t3_keys[zipf_pick(rng, n_t3, 1.1)], rng.randint(2, 50), 3)
    d["network_edges"] = edges
    return d


# ── Self-checks: a dataset that fails these never reaches a file ───────────────────
def check(d: dict) -> list[str]:
    errs: list[str] = []
    sup = {s["supplier_id"] for s in d["suppliers"]}
    mat = {m["material_id"] for m in d["materials"]}
    prod = {p["product_id"] for p in d["products"]}
    if len(sup) != len(d["suppliers"]) or len(mat) != len(d["materials"]) or len(prod) != len(d["products"]):
        errs.append("duplicate master id")
    bom = d["bom_multi_level"]
    parents = {b["higher_level_component_id"] for b in bom if b["higher_level_component_id"]} - prod
    items = {b["material_id"] for b in bom}
    if items - parents != mat:
        errs.append(f"BOM leaves differ from the material master: {len((items - parents) ^ mat)} ids")
    if len(bom) >= 10_000:
        errs.append(f"{len(bom)} BOM rows; production returns at most 10 000 per unpaged read")
    pairs = [(b["material_id"], b["higher_level_component_id"]) for b in bom]
    if len(set(pairs)) != len(pairs):
        errs.append("a material appears twice under the same parent")
    level_of = {b["material_id"]: b["level"] for b in bom if b["material_id"] in parents}
    parent_count: dict[str, int] = {}
    for b in bom:
        if b["material_id"] in parents:
            parent_count[b["material_id"]] = parent_count.get(b["material_id"], 0) + 1
        par = b["higher_level_component_id"]
        want = level_of.get(par, 0) + 1
        if b["level"] != want:
            errs.append(f"BOM {b['material_id']} under {par}: level {b['level']}, expected {want}")
        if b["level"] == 1 and par not in prod:
            errs.append(f"BOM {b['material_id']} is level 1 but its parent {par!r} is not a finished product")
    if any(n != 1 for n in parent_count.values()):
        errs.append("a sub-assembly has more than one parent")
    sourced = {i["material_id"] for i in d["inbound"]}
    if sourced != mat:
        errs.append(f"{len(mat - sourced)} materials without an inbound lane")
    if {i["supplier_id"] for i in d["inbound"]} != sup:
        errs.append("some supplier supplies nothing, or a lane names an unknown supplier")
    shares: dict[str, float] = {}
    lane_pairs = set()
    for i in d["inbound"]:
        key = (i["supplier_id"], i["material_id"])
        if key in lane_pairs:
            errs.append(f"duplicate lane {key}")
        lane_pairs.add(key)
    for o in d["outbound"]:
        if o["product_id"] not in prod:
            errs.append(f"outbound names unknown product {o['product_id']}")
    if {o["product_id"] for o in d["outbound"]} != prod:
        errs.append("a product has no customer")
    # the deep-tier graph
    uids = {n["uid"]: n for n in d["network_nodes"]}
    if len(uids) != len(d["network_nodes"]):
        errs.append("duplicate firm uid")
    if sum(1 for n in d["network_nodes"] if n["is_seed"]) != 1:
        errs.append("need exactly one seed firm")
    if len({n["name"] for n in d["network_nodes"]}) != len(d["network_nodes"]):
        errs.append("duplicate firm name")
    seen = set()
    for e in d["network_edges"]:
        a, b = uids.get(e["src_uid"]), uids.get(e["dst_uid"])
        if not a or not b:
            errs.append("edge names a firm with no node")
            continue
        if b["depth"] != a["depth"] + 1 or e["depth"] != b["depth"]:
            errs.append(f"edge {a['name']} -> {b['name']} is not one tier down")
        if (e["src_uid"], e["dst_uid"]) in seen:
            errs.append("duplicate edge")
        seen.add((e["src_uid"], e["dst_uid"]))
    reached = {e["dst_uid"] for e in d["network_edges"]}
    for n in d["network_nodes"]:
        if not n["is_seed"] and n["uid"] not in reached:
            errs.append(f"firm {n['name']} is not reachable from the plant")
    if {n["name"] for n in d["network_nodes"] if n["depth"] == 1} != {s["name"] for s in d["suppliers"]}:
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


def outputs(d: dict, out: Path) -> dict[Path, str]:
    files = {out / "dataset.json": json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n"}
    for fname, (key, cols) in CSV_SPECS.items():
        rows = d[key]
        if key == "network_nodes":  # the upload parser reads the literal words
            rows = [{**r, "is_seed": "True" if r["is_seed"] else "False"} for r in rows]
        files[out / "csv" / fname] = to_csv(rows, cols)
    return files


def product_of(row: dict) -> str:
    """The finished product a BOM row belongs to: its parent is the product, or a sub-assembly
    whose id carries the product's number (A-007-3 -> P-007)."""
    par = row["higher_level_component_id"]
    return par if par.startswith("P-") else "P-" + par.split("-")[1]


def split_files(d: dict, out: Path, size: int) -> dict[Path, str]:
    """The same CSVs cut into files of at most ~`size` rows, for uploading one at a time.

    A big upload is staged, reviewed and promoted as ONE unit, and the review read and the
    promotion are each bound by the database's per-request time limit. Smaller files keep each
    unit inside it. The BOM is cut only between products, so a sub-assembly never ends up in a
    different file from its parent; every other dataset is independent rows."""
    files: dict[Path, str] = {}
    for fname, (key, cols) in CSV_SPECS.items():
        rows = d[key]
        if key == "network_nodes":
            rows = [{**r, "is_seed": "True" if r["is_seed"] else "False"} for r in rows]
        if len(rows) <= size:
            continue
        chunks: list[list[dict]] = [[]]
        last = None
        for r in rows:
            owner = product_of(r) if key == "bom_multi_level" else None
            if len(chunks[-1]) >= size and (key != "bom_multi_level" or owner != last):
                chunks.append([])
            chunks[-1].append(r)
            last = owner
        stem = fname[:-4]
        for i, chunk in enumerate(chunks, 1):
            files[out / "csv_split" / f"{stem}_part{i:02d}.csv"] = to_csv(chunk, cols)
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--products", type=int, default=100)
    ap.add_argument("--suppliers", type=int, default=1000)
    ap.add_argument("--materials", type=int, default=1800)
    ap.add_argument("--customers", type=int, default=25)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=HERE / "out")
    ap.add_argument("--check", action="store_true", help="build and self-check, write nothing")
    ap.add_argument("--split", type=int, default=0, metavar="ROWS",
                    help="also write out/csv_split/: every CSV longer than ROWS rows, cut into files of about that size")
    a = ap.parse_args()

    d = build(a.products, a.suppliers, a.materials, a.customers, a.seed)
    errs = check(d)
    if errs:
        print("dataset is inconsistent:", *errs[:20], sep="\n  - ")
        return 1
    n = {k: len(d[k]) for k in ("suppliers", "materials", "products", "bom_multi_level", "inbound", "outbound",
                                "node_list", "network_nodes", "network_edges")}
    if a.check:
        print("dataset OK:", n)
        return 0
    written = outputs(d, a.out)
    if a.split > 0:
        written.update(split_files(d, a.out, a.split))
    for p, text in written.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    print(f"wrote {a.out}:", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())

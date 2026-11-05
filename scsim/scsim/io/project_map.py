# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""Canonical SuReSuite-project → scsim Scenario mapper (single source of truth).

This module is the ONE place that turns a project's stored data (item masters +
logistics + merged policies + scenario settings) into an scsim ``Scenario``. It
is pure and Supabase-agnostic: callers (the Fly worker) fetch rows and populate
the typed :class:`ProjectData`; this module applies the documented reducers,
unit normalization, defaults, and emits a structured :class:`MappingWarning`
list so nothing is ever silently wrong.

The human-readable contract lives in ``docs/data-simulation-mapping.md`` — keep
the two in sync. Economics (material cost, product price, capacity, MOQ, …) come
from the item-master rows first; logistics/policy values are only fallbacks, and
every fallback is recorded as a warning.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Optional

from scsim.entities.config import SimulationSettings
from scsim.entities.disruption import DisruptionEvent
from scsim.entities.enums import (
    DemandModel,
    EffectType,
    FulfillmentMode,
    LeadTimeDist,
    ReplicationStopping,
    TargetType,
    TraceVerbosity,
    WarmupMethod,
)
from scsim.entities.network import (
    BomLine,
    Customer,
    CustomerLink,
    Material,
    Network,
    Product,
    Supplier,
    SupplierLink,
    lead_time_bounds_mean,
    primary_rank,
    triangular_av,
)
from scsim.entities.scenario import Scenario

# ── Time-unit normalization ───────────────────────────────────────────────────
# Everything in scsim is weekly. A duration of N units → weeks; a quantity per
# unit-period → quantity per week (the inverse).
_UNIT_DAYS = {
    "day": 1.0, "days": 1.0, "d": 1.0, "daily": 1.0,
    "week": 7.0, "weeks": 7.0, "wk": 7.0, "w": 7.0, "weekly": 7.0,
    "month": 30.4375, "months": 30.4375, "mo": 30.4375, "m": 30.4375, "monthly": 30.4375,
    "quarter": 91.3125, "quarters": 91.3125, "quarterly": 91.3125,
    "year": 365.25, "years": 365.25, "yr": 365.25, "y": 365.25,
    "yearly": 365.25, "annual": 365.25, "annually": 365.25,
}
_DEFAULT_CV = 0.30  # triangularAV variability when none supplied


def _unit_days(unit: Optional[str]) -> Optional[float]:
    if not unit:
        return None
    return _UNIT_DAYS.get(str(unit).strip().lower())


def _duration_to_weeks(value: float, unit: Optional[str], default_days: float = 7.0) -> float:
    days = _unit_days(unit) or default_days
    return float(value) * days / 7.0


def _rate_to_weekly(value: float, unit: Optional[str], default_days: float = 7.0) -> float:
    days = _unit_days(unit) or default_days
    return float(value) * 7.0 / days


def _fmt(x: float) -> str:
    return f"{x:g}"


def _clamp(
    v: float, lo: float, hi: float, *,
    w: list["MappingWarning"], entity: str, field: str,
    unit: str = "", scale: float = 1.0, level: str = "warn",
) -> float:
    """Bound ``v`` to the engine's range — and SAY so when that changed it.

    The only two-sided clamp in this module (audit 2026-09-22, F-21). It used to
    return silently, and a dozen values the user typed were bounded with the
    substitution recorded in a comment or in ``docs/data/field-mapping.md``,
    which is T2's exact prohibition. ``w``, ``entity`` and ``field`` are
    keyword-only with no default, so a call cannot omit the sink, and
    ``tests/test_mapping_clamps.py`` fails on any clamp idiom outside this one.

    ``scale`` converts the engine value back to the unit the user typed for the
    message only (e.g. a holding rate in %/yr against a stored fraction).
    """
    used = max(lo, min(hi, v))
    if used != v:
        w.append(MappingWarning(
            level, entity, field,
            f"{_fmt(v / scale)}{unit} is outside the engine range "
            f"[{_fmt(lo / scale)}, {_fmt(hi / scale)}]{unit} → {_fmt(used / scale)}{unit} used"))
    return used


def _review_weeks(days: float, *, w: list["MappingWarning"], entity: str) -> int:
    """A periodic review period T typed in DAYS → the engine's whole weeks.

    The engine steps a week at a time, so T rounds to the nearest week and never
    below one; a T that is not a whole number of weeks says what it became."""
    weeks = max(1, math.floor(days / 7.0 + 0.5))
    weeks = int(_clamp(float(weeks), 1.0, 13.0, w=w, entity=entity,
                       field="review_period_days", unit=" wk"))
    if weeks * 7 != days:
        w.append(MappingWarning(
            "info", entity, "review_period_days",
            f"review period {_fmt(days)} d → reviewed every {weeks} wk "
            "(the engine steps in whole weeks)"))
    return weeks


# ── Typed, Supabase-agnostic input ────────────────────────────────────────────

@dataclass
class SupplierRow:
    id: str
    name: Optional[str] = None
    capacity_per_week: Optional[float] = None  # None = ∞
    reliability_score: Optional[float] = None  # None = no master value → the engine's 1.0


@dataclass
class MaterialRow:
    id: str
    name: Optional[str] = None
    cost: Optional[float] = None               # c_m (master); else primary supplier link
    holding_cost_pct: Optional[float] = None   # fraction, e.g. 0.20
    moq: Optional[float] = None
    initial_on_hand: Optional[float] = None
    lead_time_dist: Optional[str] = None
    lead_time_cv: Optional[float] = None


@dataclass
class ProductRow:
    id: str
    name: Optional[str] = None
    sell_price: Optional[float] = None         # u_p (master); else demand-weighted outbound price
    production_capacity: Optional[float] = None  # units/week (master); else policy
    fulfillment_mode: Optional[str] = None     # else project supply_chain_model
    demand_distribution: Optional[str] = None  # else scenario demand_model
    demand_mean: Optional[float] = None        # b_p (master); else Σ outbound volume
    demand_cv: Optional[float] = None
    # Explicit triangular bounds (a_p, c_p). When set they override the
    # symmetric triangularAV form — this is how an asymmetric empirical
    # distribution (b = historical median, c = historical max ≫ b·(1+cv))
    # reaches the engine. Ignored for non-triangular demand kinds.
    demand_min: Optional[float] = None         # a_p (master); else b·(1−cv)
    demand_max: Optional[float] = None         # c_p (master); else b·(1+cv)
    # FG inventory policy, MTS only (PLAN.md §24 WP 14.4, design doc §3.2).
    fg_policy: Optional[str] = None            # base_stock | min_max | days_of_cover
    fg_base_stock: Optional[float] = None      # S (units)
    fg_reorder_point: Optional[float] = None   # s (units), min_max
    fg_cover_days: Optional[float] = None      # D (days), days_of_cover
    fg_initial_on_hand: Optional[float] = None  # FG opening stock (units), RFC 4
    # P-P.13 production lead time (PLAN.md §26 WP 16.5): the lead time and its
    # bounds in `production_lead_time_unit` (weeks after promotion).
    production_lead_time: Optional[float] = None
    production_lead_time_unit: Optional[str] = None
    production_lead_time_dist: Optional[str] = None
    production_lead_time_cv: Optional[float] = None
    production_lead_time_min: Optional[float] = None
    production_lead_time_mode: Optional[float] = None
    production_lead_time_max: Optional[float] = None


@dataclass
class SupplyArc:
    """inbound_logistics row: supplier → material.

    Unit contract (docs/data-simulation-mapping.md §3): ``time_unit`` describes
    the VOLUME period only (e.g. "yearly"). ``lead_time`` is in WEEKS unless
    ``lead_time_unit`` explicitly overrides it — it never inherits ``time_unit``.
    """
    supplier_id: str
    material_id: str
    unit_price: Optional[float] = None  # c_{m,s}
    lead_time: Optional[float] = None   # weeks (see unit contract above)
    lead_time_unit: Optional[str] = None  # explicit override only
    time_unit: Optional[str] = None       # volume period
    volume: Optional[float] = None
    # PLAN.md §26 WP 16.2 — the lane's own lead-time spread. The bounds are in
    # `lead_time_unit` like `lead_time` (weeks after promotion).
    lead_time_dist: Optional[str] = None
    lead_time_cv: Optional[float] = None
    lead_time_min: Optional[float] = None
    lead_time_mode: Optional[float] = None
    lead_time_max: Optional[float] = None


@dataclass
class BomArc:
    product_id: str
    material_id: str
    consumption_rate: float = 1.0


@dataclass
class OutboundArc:
    """outbound_logistics row: product → customer (demand + price fallback).

    The ``demand_*`` fields and ``forecast`` are the row's own demand spec
    (WP 14.1, ADR 0002 decision 2). All optional: a row that sets none keeps
    today's behaviour — its product's distribution, scaled by its volume share.
    ``demand_mean`` / ``demand_min`` / ``demand_max`` are rates in the row's
    ``time_unit`` (like ``volume``); ``forecast`` is already weekly, one value
    per simulated week from week 0. ``demand_variation`` is read by the
    distribution: a CV for ``normal``, the ± fraction for ``triangular_av``.
    """
    product_id: str
    customer_id: str
    unit_price: Optional[float] = None
    volume: Optional[float] = None
    time_unit: Optional[str] = None
    demand_distribution: Optional[str] = None
    demand_mean: Optional[float] = None
    demand_variation: Optional[float] = None
    demand_min: Optional[float] = None
    demand_max: Optional[float] = None
    forecast: Optional[list[float]] = None


@dataclass
class CustomerRow:
    """``customers`` row — the table the mapper never read (§4 D69).

    ``ProjectData.customers`` is a list of IDS and stays that way. This carries
    the ATTRIBUTES for those ids and NOTHING ELSE — in particular it does not
    decide WHICH customers exist.

    That separation was not the first draft's, and CI is what settled it. The
    draft also unioned these rows into the id set, so a row naming a customer the
    graph does not trade with became a `Customer` entity with no demand — and, as
    a side effect, `unmatched` below compared against a set that already
    contained every row, so it could never fire and
    `test_a_row_naming_an_id_with_no_demand_is_reported_not_silent` failed. Which
    customers exist is decided by the outbound arcs exactly as it was before D69;
    widening it is a behaviour change beyond the defect, and one that would have
    put demand-less customers into `len(net.customers)`, which P-C.2's own
    feasibility check reads.

    ``sla_fill_floor_pct`` is read since WP 14.3 (PLAN.md §24): the floor is
    per CUSTOMER × PRODUCT ROW now, not per segment, so a customer's contracted
    floor is the default service target of each of its rows under ``sla_tier``
    (``Customer.sla_fill_floor_pct``), and the segment's ``sla_tiers`` floor
    applies only where it is empty. The question that kept it out — two
    customers of one segment disagreeing — has no answer to invent when the
    floor belongs to the row.
    """
    id: str
    name: Optional[str] = None
    segment: Optional[str] = None
    priority_weight: Optional[float] = None
    sla_fill_floor_pct: Optional[float] = None


@dataclass
class ScenarioSettings:
    horizon_days: int = 1092          # ~156 weeks
    warmup_mode: str = "auto"         # auto | manual
    warmup_days: int = 105            # ~15 weeks
    replications: int = 30
    seed: int = 42
    crn: bool = True
    ci_level: int = 95
    demand_model: Optional[dict] = None      # {"kind": "...", "lambda"/"cv": ...}
    disruption_schedule: list[dict] = field(default_factory=list)
    stopping_rule: Optional[dict] = None     # {"kind": "fixed_horizon"|"sequential_ci", "epsilon": ...}
    name: str = "scenario"
    # Single-run inspection mode (G17/§9.5.1): raises trace_verbosity to
    # full_debug so per-item weekly matrices are exposed on the result.
    # Honored only when replications == 1 — ignored (with a warning) otherwise.
    inspection: bool = False


@dataclass
class ProjectData:
    suppliers: list[SupplierRow] = field(default_factory=list)
    materials: list[MaterialRow] = field(default_factory=list)
    products: list[ProductRow] = field(default_factory=list)
    supply_arcs: list[SupplyArc] = field(default_factory=list)
    bom: list[BomArc] = field(default_factory=list)
    outbound: list[OutboundArc] = field(default_factory=list)
    customers: list[str] = field(default_factory=list)
    # The ATTRIBUTES of the customers the `customers` table describes. Additive
    # to `customers` above, which remains the id list — see `CustomerRow` (D69).
    customer_rows: list[CustomerRow] = field(default_factory=list)
    # §4 D174 — master products CONSUMED by another product (sub-assemblies).
    # Stamped by the caller from the RAW BOM shape, because the flattened
    # `bom` arcs no longer show which nodes were intermediate. The mapper
    # excludes these from the engine's product list WITH a warning; a
    # ProductRow for one would otherwise reach `Network` with an empty BoM
    # and the engine would refuse the whole project.
    subassemblies: list[str] = field(default_factory=list)
    policies: dict[str, Any] = field(default_factory=dict)   # {"default": {...}, "node:<id>": {...}}
    scenario: ScenarioSettings = field(default_factory=ScenarioSettings)
    project_model: Optional[str] = None  # projects.supply_chain_model


# ── Structured warnings ───────────────────────────────────────────────────────

@dataclass
class MappingWarning:
    level: Literal["info", "warn", "error"]
    entity: str
    field: str
    reason: str

    def as_dict(self) -> dict:
        return {"level": self.level, "entity": self.entity, "field": self.field, "reason": self.reason}


@dataclass
class MappingResult:
    scenario: Scenario
    warnings: list[MappingWarning] = field(default_factory=list)
    # §23 WP 13.4 — `{"materials.cost": {"M1": {"source": "override", "value": 3.5}}}`:
    # what the engine was given for every master-backed field, and from where.
    resolved: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)

    @property
    def warning_dicts(self) -> list[dict]:
        return [w.as_dict() for w in self.warnings]


# ── Base data requirements (§8.1) ─────────────────────────────────────────────
# The entity fields the always-on engine mechanics read, with the exact
# fallback chains this module applies. Policy-specific requirements live on
# each plugin (PolicyPlugin.data_requirements); these are the world-model
# inputs every run consumes regardless of the policy set. When §4.4 promotes
# the mechanics into named default policies (P-C.4, P-P.0, …), these entries
# migrate onto those plugins. Exported to the frontend/edge validators via
# registry_export.build_registry()["base_data_requirements"].

# ── §4 D90 · THE POLICY-BUNDLE KEYS, DECLARED ───────────────────────────────
#
# WP 6.1 traced every /policies grid field to the engine and found THREE doors:
# the registry's `data_requirements` (`table.column` the engine needs from the
# dataset), a policy's `params_schema` (80 declared parameters), and — for
# everything else — A QUOTED STRING IN THIS FILE.
#
# Door 3 is not a contract. It is a text scan over Python, it was the only proof
# those fields reach the engine at all, and `single-source` (I1) says a data fact
# is authored once somewhere a generator can read. §3's standing law — "the
# registry export is the single source of truth for policy schemas" — was true of
# the schemas that exist and silent about these.
#
# §4 D90 said the fix belongs here and deferred it on "it needs a session that can
# run Python", the same premise D94 and D106 were deferred on and which WP 6.2
# found false.
#
# WHAT THIS IS AND IS NOT. It is not a second copy of the mapping: the mapper
# below is still the only code that performs it, and this table makes no runtime
# decision. It declares WHICH POLICY PARAMETER OR ENTITY FIELD each bundle key
# feeds, so a reader outside Python can answer "does this grid cell reach the
# engine, and as what" without scanning for a dict read. `registry_export`
# publishes it and `resolutionChains` reads it as door 3 proper.
#
# `parity` is what keeps it from drifting into fiction: every key here must be
# READ by this module, and every bundle key this module reads must be here —
# `scsim/tests/test_registry_io.py` asserts both directions against the source.
#
# SIXTEEN KEYS: `type` and `safety_stock_days` are rendered by both
# the supplier and the plant stage, so the grid has more cells than keys; the
# four replenishment cells (Q, κ, s, S) joined when supplier-row overrides
# started reaching the engine as `inventory_control.material_overrides`.
# (`utilization_cap_pct` joined in WP 9.3 — it was on the test's `not_rendered`
# list, which is the list of keys that are NOT grid cells, while the arithmetic
# it performs is half of what the plant stage exists to show.)
#
# `shadowed_by` is OPTIONAL and names the entity field that, when present,
# makes this key's value unreachable. Two keys carry it and both name
# `products.production_capacity` (§4 D167) — which since WP 13.1 is present when
# the master OR the Plant-stage override of it carries a value.
#
# `customer` (PLAN.md §24 WP 14.2) is a Customer-stage row, `node:<customer>::<product>`.
# From WP 14.2 to WP 14.4 the seven production-family keys declared it too, because
# `_composite_patches` resolved ANY `node:<x>::<product>` key to the product, so a
# production patch on a Customer row reached the product. WP 14.4 closed that reach
# (`exclude=` the existing Customer rows) when its five FG keys would have had to
# declare the same false scope; the probe that found it is
# `test_declared_scopes_are_the_scopes_the_mapper_reads` (§16 · WP 14.2, WP 14.4).
#
# `scopes` is REQUIRED (§23 WP 13.4, §4 D204 b): WHERE the mapper reads the key —
# `default` (the project-wide policy), `supplier` (a Supplier-stage row,
# `node:<supplier>::<material>`), `plant` (a Plant-stage row,
# `node:<plant>::<product>`). A /policies cell whose stage is not in its key's
# scopes is stored and versioned and changes no result, and the grid badges it
# "not simulated" — the badge list is generated from this field, and
# `test_declared_scopes_are_the_scopes_the_mapper_reads` perturbs every key at
# every scope to prove each declaration true.
#
# `master`, `rows` and `domain` are OPTIONAL and travel together (§23 WP
# 13.1): `master` names the item-master column this key OVERRIDES, `rows` the
# /policies stage whose row keys the mapper reads it from, and `domain` the
# values it accepts (positive · nonnegative · fraction) — an override outside it
# is ignored with a warning and the master decides. `empty_default` (and, when it
# is not a number, `empty_note`) is what the engine uses when the override, the
# master and every derivation are empty — the grid shows exactly that rather than
# an invented 0 (§23 WP 13.4). Nine keys carry them, and
# the grid reads all three from the registry rather than restating them.
POLICY_BUNDLE_KEYS: tuple[dict[str, Any], ...] = (
    {
        "key": "supply_share",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "proactive_multi_sourcing.weights",
        "catalog_ref": "P-S.2",
        "transform": "fraction x 100 into the material's weight map, keyed by supplier; "
                     "only for a supplier the material actually has a link to",
    },
    {
        "key": "type",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        "target": "inventory_control.policy_type",
        "catalog_ref": "P-X.1",
        "transform": "enum map — min_max/s_S/continuous_review -> min_max, base_stock -> "
                     "base_stock, rop -> rop_q, periodic_review -> periodic, mrp -> mrp (WP "
                     "14.5: ordered from the plan); anything unrecognised falls back to min_max",
    },
    {
        "key": "safety_stock_days",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        "target": "safety_stock_materials.fixed_days_cover",
        "catalog_ref": "P-X.2",
        "transform": "days, clamped 0-84. At default scope only when `safety_stock_method` "
                     "is neither service_level/demand_variability nor king_method. On a "
                     "Supplier-stage row (`node:<supplier>::<material>`) it is that "
                     "material's cover in `fixed_days_by_material`, whatever the method — "
                     "the /policies value beats the project default (§4 D204)",
    },
    {
        "key": "holding_cost_pct",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        # An ENTITY field, like capacity_units_per_day: the master column and
        # this key feed the same number, and the /policies row wins.
        "target": "Material.holding_cost_rate",
        "catalog_ref": None,
        "transform": "fraction x 100 -> %/yr, clamped 5-50. Order: the Supplier-stage row "
                     "(`node:<supplier>::<material>`) -> materials.holding_cost_pct (master) "
                     "-> the project-default policy -> 20. The /policies value beats the "
                     "item master (§4 D204)",
    },
    {
        "key": "primary_source",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.primary",
        "catalog_ref": None,
        "transform": "true on a Supplier-stage row makes that supplier the material's "
                     "primary link (where P-P.1 orders go). Nothing saved -> the engine's "
                     "rule: cheapest, then shortest lead time, then id. Two saved for one "
                     "material -> neither applied, warned (§4 D188)",
    },
    # ── /policies overrides of the item masters (PLAN.md §23 WP 13.1, §4 D280) ──
    # /policies never writes the masters: each of these is a per-row override the
    # mapper reads BEFORE the master column it names (`master`), on the stage rows
    # it names (`rows`). The grid's resolver derives the same rule from these
    # declarations (`src/lib/policies/masterOverrides.ts`), so a cell shows the
    # value read here.
    {
        "key": "material_cost",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "Material.cost",
        "catalog_ref": None,
        "master": "materials.cost",
        "rows": "supplier",
        "domain": "positive",
        "empty_default": 1.0,
        "transform": "currency per unit, must be > 0. Order: the Supplier-stage row "
                     "(`node:<supplier>::<material>`) -> materials.cost (master) -> the "
                     "volume-weighted, then cheapest, inbound price -> 1.0",
    },
    {
        "key": "material_moq",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.moq",
        "catalog_ref": None,
        "master": "materials.moq",
        "rows": "supplier",
        "domain": "nonnegative",
        "empty_default": 0.0,
        "transform": "units, >= 0, applied to every supplier link of the material. Order: "
                     "the Supplier-stage row -> materials.moq (master) -> 0",
    },
    {
        "key": "capacity_per_week",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "Supplier.capacity_per_week",
        "catalog_ref": None,
        "master": "suppliers.capacity_per_week",
        "rows": "supplier",
        "domain": "positive",
        "empty_default": None,
        "empty_note": "unlimited — no capacity limit",
        "transform": "units per week, must be > 0; one value per SUPPLIER, read from any "
                     "of its Supplier-stage rows. Order: the row -> "
                     "suppliers.capacity_per_week (master; empty means unlimited)",
    },
    {
        "key": "reliability_score",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "Supplier.reliability_score",
        "catalog_ref": None,
        "master": "suppliers.reliability_score",
        "rows": "supplier",
        "domain": "fraction",
        "empty_default": 1.0,
        "transform": "fraction 0-1; one value per SUPPLIER, read from any of its "
                     "Supplier-stage rows. Order: the row -> suppliers.reliability_score "
                     "(master) -> 1.0",
    },
    {
        # The lane's own lead time (the T_s of P-P.1's levels), per
        # supplier × material — the first override of a LANE column rather than
        # an item master, on the pattern the Customer row's `price` set over
        # `outbound_logistics.unit_price`. The upload is the suggestion; the
        # /policies row is what runs.
        "key": "lead_time_weeks",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_weeks",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time",
        "rows": "supplier",
        "domain": "positive",
        "empty_default": 2.0,
        "transform": "weeks, > 0, on THIS supplier x material link only; rounded half to "
                     "even and clamped 1-51 like the uploaded value. Order: the Supplier-stage "
                     "row (`node:<supplier>::<material>`) -> inbound_logistics.lead_time x "
                     "lead_time_unit -> 2 weeks",
    },
    # ── A lane's lead-time SPREAD (PLAN.md §26 WP 16.2, D299, blueprint P-S.6) ──
    # Chosen like demand: a shape and only the parameters it reads, per Supplier
    # row, over the lane's own upload (`inbound_logistics`), else the material's
    # shape (`materials.lead_time_dist` / `lead_time_cv`), else deterministic.
    # Read per LANE exactly like `lead_time_weeks`. A bounded shape (triangular,
    # uniform) IS its bounds and its planning lead time is their mean, so on such
    # a lane the row's `lead_time_weeks` is not read (§26.2 rule 3).
    {
        "key": "lane_lead_time_dist",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_dist",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time_dist",
        "rows": "supplier",
        "domain": "lead_time_distribution",
        "empty_default": None,
        "empty_note": "the material's lead-time shape, else deterministic",
        "transform": "enum deterministic | normal | lognormal | gamma | triangular | uniform. "
                     "Order: the Supplier-stage row -> inbound_logistics.lead_time_dist -> "
                     "materials.lead_time_dist -> deterministic. A shape missing a parameter "
                     "it reads runs deterministic, warned",
    },
    {
        "key": "lane_lead_time_cv",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_cv",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time_cv",
        "rows": "supplier",
        "domain": "fraction",
        "empty_default": None,
        "empty_note": "the material's CV, else none — normal, lognormal and gamma need one",
        "transform": "fraction 0-1, read by normal, lognormal and gamma. Order: the "
                     "Supplier-stage row -> inbound_logistics.lead_time_cv -> "
                     "materials.lead_time_cv",
    },
    {
        "key": "lane_lead_time_min_weeks",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_min_weeks",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time_min",
        "rows": "supplier",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular and uniform need it",
        "transform": "weeks, >= 0; triangular and uniform. Order: the Supplier-stage row -> "
                     "inbound_logistics.lead_time_min x lead_time_unit",
    },
    {
        "key": "lane_lead_time_mode_weeks",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_mode_weeks",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time_mode",
        "rows": "supplier",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular needs it",
        "transform": "weeks, >= 0; triangular. Order: the Supplier-stage row -> "
                     "inbound_logistics.lead_time_mode x lead_time_unit",
    },
    {
        "key": "lane_lead_time_max_weeks",
        "scopes": ("supplier",),
        "family": "sourcing",
        "target": "SupplierLink.lead_time_max_weeks",
        "catalog_ref": None,
        "master": "inbound_logistics.lead_time_max",
        "rows": "supplier",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular and uniform need it",
        "transform": "weeks, >= 0, at most 51; triangular and uniform. Order: the "
                     "Supplier-stage row -> inbound_logistics.lead_time_max x lead_time_unit",
    },
    {
        "key": "initial_on_hand",
        "scopes": ("supplier",),
        "family": "inventory",
        "target": "Material.initial_on_hand",
        "catalog_ref": None,
        "master": "materials.initial_on_hand",
        "rows": "supplier",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "the engine's own opening stock (its starting cover)",
        "transform": "units, >= 0. Order: the Supplier-stage row -> "
                     "materials.initial_on_hand (master) -> the engine's own opening "
                     "stock. A PLANT-stage initial_on_hand is not read (§4 D89)",
    },
    {
        "key": "sell_price",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.unit_price",
        "catalog_ref": None,
        "master": "products.sell_price",
        "rows": "plant",
        "domain": "positive",
        "empty_default": 1.0,
        "transform": "currency per unit, must be > 0. Order: the Plant-stage row "
                     "(`node:<plant>::<product>`) -> products.sell_price (master) -> the "
                     "demand-weighted outbound price -> 1.0",
    },
    {
        "key": "production_capacity",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_capacity",
        "catalog_ref": None,
        "master": "products.production_capacity",
        "rows": "plant",
        "domain": "positive",
        "empty_default": None,
        "empty_note": "max(2 × demand, 1000) — chosen so capacity never binds",
        "transform": "units per week, must be > 0. Order: the Plant-stage row -> "
                     "products.production_capacity (master) -> the line capacity "
                     "(capacity_units_per_day x 7 x utilization) -> max(2 x demand, 1000)",
    },
    {
        "key": "service_level_target",
        "scopes": ("default",),
        "family": "inventory",
        "target": "safety_stock_materials.uniform_service_level",
        "catalog_ref": "P-X.2",
        "transform": "fraction x 100, clamped 80.0-99.9. Read only when "
                     "`safety_stock_method` is service_level or demand_variability",
    },
    {
        "key": "capacity_units_per_day",
        "scopes": ("default", "plant"),
        "family": "production",
        # NOT a policy parameter. This one lands on an ENTITY field, which is why
        # door 2 could never have declared it and why the row needed this table
        # rather than a Params addition.
        "target": "Product.production_capacity",
        "catalog_ref": None,
        "transform": "units/day x 7 x utilization_cap_pct (default 0.85) -> units/week. "
                     "The MASTER `products.production_capacity` shadows it entirely when "
                     "present, and the mapper warns that the grid entry is not applied",
        # THE SHADOW, MACHINE-READABLE (§4 D167). The sentence above has been in
        # this table since D90 and no surface could act on it: the plant grid
        # rendered an editable `capacity_units_per_day` cell with nothing saying
        # the engine would ignore it whenever the product carried a master
        # capacity. A surface cannot read prose. It can read this.
        "shadowed_by": "products.production_capacity",
    },
    {
        # The OTHER half of the same arithmetic, and it had no declaration and no
        # column — so a planner saw 1 000 units/day become 5 950 units/week with
        # nothing on screen holding the 0.85. It is read by `_map_policies`'s
        # capacity branch exactly as `capacity_units_per_day` is.
        "key": "utilization_cap_pct",
        "scopes": ("default", "plant"),
        "family": "production",
        "target": "Product.production_capacity",
        "catalog_ref": None,
        "transform": "percent / 100, multiplied into the weekly capacity above; the "
                     "mapper substitutes 85 when the production policy sets none and "
                     "says so. Read ONLY on the branch that derives capacity from the "
                     "grid — a master production_capacity shadows this too",
        "shadowed_by": "products.production_capacity",
    },
    {
        "key": "fg_safety_stock",
        "scopes": ("default",),
        "family": "inventory",
        "target": "fg_safety_stock.sizing",
        "catalog_ref": "P-P.4",
        "transform": "enum — 'none' skips the policy; 'service_level' selects "
                     "service-level sizing; anything else selects fixed_days. Gated on the "
                     "engine's own `has_mts`, not on the policy's fulfillment_strategy string",
    },
    {
        "key": "fg_service_level_target",
        "scopes": ("default",),
        "family": "inventory",
        "target": "fg_safety_stock.service_level_pct",
        "catalog_ref": "P-P.4",
        "transform": "fraction x 100, clamped 80.0-99.9. Read only when `fg_safety_stock` "
                     "is service_level",
    },
    {
        "key": "fg_safety_stock_days",
        "scopes": ("default",),
        "family": "inventory",
        "target": "fg_safety_stock.fixed_days_cover",
        "catalog_ref": "P-P.4",
        "transform": "days, clamped 0-12. Read only when `fg_safety_stock` selects "
                     "fixed_days sizing",
    },
    {
        "key": "allocation_priority_weight",
        "scopes": ("plant",),
        "family": "production",
        "target": "material_allocation.priority_weights",
        "catalog_ref": "P-X.3",
        "transform": "per-product weight, collected from composite `node:<node>::<product>` "
                     "override keys. Read only when the scenario asks for "
                     "`allocate_materials`, and its presence switches the objective to "
                     "priority_weighted",
    },
    # The four supplier-grid replenishment cells. At the project default scope
    # only `rop_q_quantity` and `coverage_weeks` are read; all four are read
    # from `node:<supplier>::<material>` override keys into
    # `inventory_control.material_overrides[<material>]`, which is how a
    # row-level adjustment reaches the engine (before this, node-scoped
    # inventory was dropped with a warning — the D-class the (R,Q)
    # inventory-flatline defect exposed). A row's stored value that its policy
    # type does not show (an s on a base-stock row, an S on an (R,Q) row, …) is
    # NOT applied: the run uses exactly the cells the page shows.
    {
        "key": "rop_q_quantity",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        "target": "inventory_control.rop_q_quantity",
        "catalog_ref": "P-P.1",
        "transform": "units; 0 means UNSET (the frontend schema's default), never a "
                     "zero lot — an (R,Q) scope with no positive Q orders up to S "
                     "instead, and the substitution is warned at dispatch. The "
                     "project's Q is read whatever the project's own type: it is the "
                     "lot of every (R,Q) row that states none",
    },
    {
        "key": "coverage_weeks",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        "target": "inventory_control.coverage_weeks",
        "catalog_ref": "P-P.1",
        "transform": "weeks, clamped 0-26. At default scope the one number becomes a "
                     "fixed strip (nominal=alert=crisis); per material it fixes that "
                     "material's κ in every mode",
    },
    {
        "key": "reorder_point",
        "scopes": ("supplier",),
        "family": "inventory",
        "target": "inventory_control.material_overrides[*].reorder_point",
        "catalog_ref": "P-P.1",
        "transform": "absolute units replacing s = E[D]·T_s for that material only; "
                     "read from supplier-row overrides, not at default scope (the "
                     "default s stays the formula)",
    },
    {
        "key": "order_up_to",
        "scopes": ("supplier",),
        "family": "inventory",
        "target": "inventory_control.material_overrides[*].order_up_to",
        "catalog_ref": "P-P.1",
        "transform": "absolute units replacing S = E[D]·(T_s+κ) for that material "
                     "only; dropped with a warning when it does not exceed the row's "
                     "reorder point. Not read at default scope",
    },
    {
        # The T of the periodic (T, S) type. Until this row it was read nowhere:
        # the grid showed T and every periodic material was reviewed every 4
        # weeks whatever it said.
        "key": "review_period_days",
        "scopes": ("default", "supplier"),
        "family": "inventory",
        "target": "inventory_control.periodic_review_weeks",
        "catalog_ref": "P-P.1",
        "transform": "days → whole weeks (nearest, at least 1, at most 13; a T that is "
                     "not a whole number of weeks is stated). At default scope the "
                     "project's T; on a Supplier-stage row that material's T. Read only "
                     "for a periodic material",
    },
    # ── Demand per customer × product row (PLAN.md §24 WP 14.2, D284 b) ─────
    # The Customer stage's demand cells. Each is an OVERRIDE of the row's
    # uploaded spec on `outbound_logistics` (`master`), read from the Customer
    # row's key `node:<customer>::<product>` (`rows: customer`) — the same
    # override → data → default order as every master-backed cell. Rates are
    # weekly (the grid shows units/wk); the data's rates are weekly after
    # promotion. A project that sets none of them maps exactly as before.
    {
        # NOT a master override: the mode is DERIVED from the data (a row with an
        # uploaded series plans on it), so there is no column to override.
        "key": "row_demand_mode",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.forecast",
        "catalog_ref": "P-C.4",
        "transform": "empty = the engine's rule (the row's requested delivery schedule "
                     "when one is entered, else its forecast when it has an uploaded "
                     "series, else model). Enum — 'model' plans and draws on the row's mean even when a forecast "
                     "series is uploaded (the series is set aside); 'forecast' uses the "
                     "series and is warned and ignored when the row has none; 'schedule' "
                     "runs the row's requested delivery schedule (row_demand_schedule) "
                     "exactly, and is warned and ignored when none is entered",
    },
    {
        # The customer's REQUESTED DELIVERY SCHEDULE: quantities the customer has
        # asked for, week by week, typed on /policies. Not a master override —
        # nothing is uploaded for it — and not a forecast: it is firm, so the row
        # draws nothing around it (deterministic) and is zero past its end.
        "key": "row_demand_schedule",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.forecast",
        "catalog_ref": "P-C.4",
        "transform": "array of units per week, one per simulated week from week 1, each "
                     ">= 0. Runs when row_demand_mode is 'schedule' or empty: the row's "
                     "demand becomes exactly the schedule (deterministic, forecast = the "
                     "schedule, mean 0 so a week past its end has no demand); the row's "
                     "distribution, variation, bounds and any uploaded forecast are set "
                     "aside. A non-array or a negative / non-numeric week is warned and "
                     "the row keeps its forecast or model",
    },
    {
        "key": "row_demand_distribution",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.demand_model",
        "catalog_ref": None,
        "master": "outbound_logistics.demand_distribution",
        "rows": "customer",
        "domain": "distribution",
        "empty_default": None,
        "empty_note": "the product's distribution, scaled by the row's volume share",
        "transform": "enum deterministic | normal | triangular | triangular_av | poisson. "
                     "Order: the Customer-stage row -> outbound_logistics.demand_distribution "
                     "-> the product's distribution × share",
    },
    {
        "key": "row_demand_mean",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.demand_mean",
        "catalog_ref": None,
        "master": "outbound_logistics.demand_mean",
        "rows": "customer",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "the product's mean × the row's volume share",
        "transform": "units per week, >= 0 (the mode for triangular). Order: the "
                     "Customer-stage row -> outbound_logistics.demand_mean (weekly after "
                     "promotion)",
    },
    {
        "key": "row_demand_variation",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.demand_variation",
        "catalog_ref": None,
        "master": "outbound_logistics.demand_variation",
        "rows": "customer",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — the distribution needs no variation, or the row is not specified",
        "transform": "read by the distribution: CV for normal, ± fraction for "
                     "triangular_av. Order: the Customer-stage row -> "
                     "outbound_logistics.demand_variation",
    },
    {
        "key": "row_demand_min",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.demand_min",
        "catalog_ref": None,
        "master": "outbound_logistics.demand_min",
        "rows": "customer",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular rows need it",
        "transform": "units per week, triangular only. Order: the Customer-stage row -> "
                     "outbound_logistics.demand_min",
    },
    {
        "key": "row_demand_max",
        "scopes": ("customer",),
        "family": "demand",
        "target": "CustomerLink.demand_max",
        "catalog_ref": None,
        "master": "outbound_logistics.demand_max",
        "rows": "customer",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular rows need it",
        "transform": "units per week, triangular only. Order: the Customer-stage row -> "
                     "outbound_logistics.demand_max",
    },
    # ── FG inventory policy per product, MTS (PLAN.md §24 WP 14.4, D284 d) ──
    # Plant-stage rows (`node:<plant>::<product>`, family `production`) over the
    # `products` master. ONE SOURCE PER NUMBER: a typed level IS the target and
    # P-P.4 adds nothing on top. Read for an MTS product only.
    {
        "key": "fg_policy",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fg_policy",
        "catalog_ref": None,
        "master": "products.fg_policy",
        "rows": "plant",
        "domain": "fg_policy",
        "empty_default": None,
        "empty_note": "base_stock",
        "transform": "enum — base_stock (S) · min_max (s, S) · days_of_cover (D). Order: the "
                     "Plant-stage row -> products.fg_policy -> base_stock. An incomplete min_max "
                     "or days_of_cover runs as base_stock, warned. MTS only",
    },
    {
        "key": "fg_base_stock",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fg_base_stock",
        "catalog_ref": None,
        "master": "products.fg_base_stock",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "derived: one week of forecast, plus P-P.4's buffer when it is on",
        "transform": "units, >= 0: S, the end-of-week FG target (base_stock, min_max). Order: "
                     "the Plant-stage row -> products.fg_base_stock -> derived. MTS only",
    },
    {
        "key": "fg_reorder_point",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fg_reorder_point",
        "catalog_ref": None,
        "master": "products.fg_reorder_point",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — read by min_max only",
        "transform": "units, >= 0: s — min_max builds up to S only when the stock left after "
                     "the week's demand is below s. MTS only",
    },
    {
        "key": "fg_cover_days",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fg_cover_days",
        "catalog_ref": None,
        "master": "products.fg_cover_days",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — read by days_of_cover only",
        "transform": "days, >= 0: D — the target is D/7 x the projected weekly demand, so it "
                     "moves with the forecast. MTS only",
    },
    {
        "key": "fg_initial_on_hand",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fg_initial_on_hand",
        "catalog_ref": None,
        "master": "products.fg_initial_on_hand",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "the policy target — the run starts at it",
        "transform": "units, >= 0: FG opening stock (engine RFC 4). Order: the Plant-stage row "
                     "-> products.fg_initial_on_hand -> the target. MTS only",
    },
    # Whether the product holds finished-goods stock at all — the switch every
    # FG key above depends on, so /policies can show the FG policy only where it
    # is read. Same chain as the master's: the Plant-stage row -> the product ->
    # the project's supply_chain_model -> MTO (`_fulfillment_mode`).
    {
        "key": "fulfillment_mode",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.fulfillment_mode",
        "catalog_ref": None,
        "master": "products.fulfillment_mode",
        "rows": "plant",
        "domain": "fulfillment_mode",
        "empty_default": None,
        "empty_note": "the project's supply chain model, else make-to-order",
        "transform": "enum — mts (holds FG stock, the FG policy applies) · mto (built to order, "
                     "no FG stock). Order: the Plant-stage row -> products.fulfillment_mode -> "
                     "projects.supply_chain_model -> mto",
    },
    # ── P-P.13 production lead time (PLAN.md §26 WP 16.5, D300) ─────────────
    # The Plant row's Production group, over the `products` master, chosen like a
    # lane's lead time (one grid helper, `leadTimeParamFor`). Named `prod_…`: the
    # legacy `production` family already carries an unread
    # `production_lead_time_min/max` in days with Zod defaults. A bounded shape's
    # planning lead time is its bounds' mean, so the row's lead time is then not
    # read (§26.2 rule 3). A product that sets none completes in the week it starts.
    {
        "key": "prod_lead_time_weeks",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_weeks",
        "catalog_ref": None,
        "master": "products.production_lead_time",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": 0.0,
        "transform": "weeks, >= 0: output started in a week completes this many weeks later; "
                     "rounded half to even, clamped 0-26. Order: the Plant-stage row -> "
                     "products.production_lead_time x production_lead_time_unit -> 0",
    },
    {
        "key": "prod_lead_time_dist",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_dist",
        "catalog_ref": None,
        "master": "products.production_lead_time_dist",
        "rows": "plant",
        "domain": "lead_time_distribution",
        "empty_default": None,
        "empty_note": "deterministic",
        "transform": "enum deterministic | normal | lognormal | gamma | triangular | uniform. "
                     "Order: the Plant-stage row -> products.production_lead_time_dist -> "
                     "deterministic. A shape missing a parameter runs deterministic, warned",
    },
    {
        "key": "prod_lead_time_cv",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_cv",
        "catalog_ref": None,
        "master": "products.production_lead_time_cv",
        "rows": "plant",
        "domain": "fraction",
        "empty_default": None,
        "empty_note": "none — normal, lognormal and gamma need one",
        "transform": "fraction 0-1, read by normal, lognormal and gamma. Order: the Plant-stage row -> products.production_lead_time_cv",
    },
    {
        "key": "prod_lead_time_min_weeks",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_min_weeks",
        "catalog_ref": None,
        "master": "products.production_lead_time_min",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular and uniform need it",
        "transform": "weeks, >= 0; triangular and uniform. Order: the Plant-stage row -> products.production_lead_time_min x production_lead_time_unit",
    },
    {
        "key": "prod_lead_time_mode_weeks",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_mode_weeks",
        "catalog_ref": None,
        "master": "products.production_lead_time_mode",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular needs it",
        "transform": "weeks, >= 0; triangular. Order: the Plant-stage row -> products.production_lead_time_mode x production_lead_time_unit",
    },
    {
        "key": "prod_lead_time_max_weeks",
        "scopes": ("plant",),
        "family": "production",
        "target": "Product.production_lead_time_max_weeks",
        "catalog_ref": None,
        "master": "products.production_lead_time_max",
        "rows": "plant",
        "domain": "nonnegative",
        "empty_default": None,
        "empty_note": "none — triangular and uniform need it",
        "transform": "weeks, >= 0, at most 26; triangular and uniform. Order: the Plant-stage row -> products.production_lead_time_max x production_lead_time_unit",
    },
    # ── Per-row fulfillment (PLAN.md §24 WP 14.3, D284 c) ───────────────────
    # Backorder, its window and cost are read at the project default AND on a
    # Customer row (`node:<customer>::<product>`, an existing row only); a row
    # that names any of them gets all three resolved row → project → default,
    # so the engine never falls to a parameter default the page does not show.
    # The allocation RULE stays one per project (decision 4); the row's
    # priority, price and service target are what that rule reads per row.
    {
        "key": "backorder_allowed",
        "scopes": ("default", "customer"),
        "family": "fulfillment",
        "target": "unmet_demand_handling.rule / row_overrides[row].backorder_allowed",
        "catalog_ref": "P-C.1",
        "transform": "boolean. Project: backorder (else lost_sales). Row: whether this "
                     "customer × product row waits; empty = the project's setting",
    },
    {
        "key": "max_backorder_days",
        "scopes": ("default", "customer"),
        "family": "fulfillment",
        "target": "unmet_demand_handling.backorder_horizon / row_overrides[row].backorder_horizon",
        "catalog_ref": "P-C.1",
        "transform": "days -> whole weeks rounded HALF UP (3 -> 0, 4 -> 1, 10 -> 1, 11 -> 2), "
                     "clamped 0-26; empty = the project's, else 14 days. Read only for a "
                     "project or row that backorders",
    },
    {
        "key": "backorder_cost_per_day",
        "scopes": ("default", "customer"),
        "family": "fulfillment",
        "target": "unmet_demand_handling.backorder_penalty / row_overrides[row].backorder_penalty",
        "catalog_ref": "P-C.1",
        "transform": "per unit per day x 7 -> per unit per week; empty = the project's, else 0. "
                     "Read only for a project or row that backorders",
    },
    {
        "key": "row_priority",
        "scopes": ("customer",),
        "family": "fulfillment",
        "target": "customer_allocation.row_priority",
        "catalog_ref": None,
        "master": "customers.priority_weight",
        "rows": "customer",
        "domain": "nonnegative",
        "empty_default": 1.0,
        "transform": "weight, >= 0; higher serves first. Order: the Customer-stage row -> "
                     "customers.priority_weight of the row's customer -> 1.0. Read under the "
                     "priority and sla_tier rules",
    },
    {
        "key": "price",
        "scopes": ("customer",),
        "family": "fulfillment",
        "target": "CustomerLink.unit_price",
        "catalog_ref": None,
        "master": "outbound_logistics.unit_price",
        "rows": "customer",
        "domain": "positive",
        "empty_default": None,
        "empty_note": "the product's sell price",
        "transform": "per unit, > 0. Order: the Customer-stage row -> outbound_logistics."
                     "unit_price -> the product's sell price. What revenue_max orders rows by "
                     "and what values a row's fill rate",
    },
    {
        "key": "sla_fill_floor_pct",
        "scopes": ("customer",),
        "family": "fulfillment",
        "target": "customer_allocation.row_floor_pct",
        "catalog_ref": None,
        "master": "customers.sla_fill_floor_pct",
        "rows": "customer",
        "domain": "percent",
        "empty_default": None,
        "empty_note": "no contracted floor — the segment's tier floor applies, else none",
        "transform": "% of the row's demand guaranteed first, 0-100. Order: the Customer-stage "
                     "row -> customers.sla_fill_floor_pct of the row's customer -> the "
                     "segment's tier floor. Read under the sla_tier rule",
    },
)


def base_data_requirements() -> tuple:
    # Imported lazily: scsim.policies pulls in scsim.core, which imports this
    # module's package — a top-level import here would be circular.
    #
    # fallback_spec mirrors THIS module's reducers step for step (§8.2): the
    # named reducers are the shared vocabulary the TS grading module
    # (supabase/functions/_shared/grading.ts) dispatches on, and each step's
    # grade matches the MappingWarning level the mapper emits when that step
    # is what resolves the field — the validation-parity tests pin this.
    from scsim.policies.base import DataRequirement, EmptyMeaning, FallbackStep

    return (
        DataRequirement(
            field="materials.cost", level="required",
            reason="Inventory valuation and holding cost — the terminal default of "
                   "1.0 makes every cost KPI meaningless.",
            fallback="volume-weighted average inbound unit_price across the "
                     "material's supply lanes; the cheapest quoted price when no "
                     "lane carries a volume",
            fallback_spec=(
                FallbackStep(grade="info", reducer="volume_weighted_inbound_price"),
                FallbackStep(grade="info", reducer="cheapest_inbound_price"),
                FallbackStep(grade="warn", constant=1.0),
            ),
        ),
        DataRequirement(
            field="products.sell_price", level="required",
            reason="Revenue and lost-sales valuation — the terminal default of 1.0 "
                   "makes revenue KPIs meaningless.",
            fallback="demand-weighted average outbound unit_price",
            fallback_spec=(
                FallbackStep(grade="info", reducer="demand_weighted_outbound_price"),
                FallbackStep(grade="warn", constant=1.0),
            ),
        ),
        DataRequirement(
            field="products.demand_mean", level="required",
            reason="Demand generation — with neither source the product is never "
                   "ordered (zero demand).",
            fallback="Σ weekly outbound volume",
            fallback_spec=(
                FallbackStep(grade="info", reducer="weekly_outbound_volume"),
                FallbackStep(grade="warn", constant=0.0),
            ),
        ),
        DataRequirement(
            field="products.production_capacity", level="recommended",
            reason="With no capacity source the engine defaults to max(2·demand, "
                   "1000), so plant capacity never binds.",
            fallback="production policy capacity_units_per_day × 7 × utilization",
            fallback_spec=(
                FallbackStep(grade="info", reducer="production_policy_capacity"),
                FallbackStep(grade="warn", reducer="twice_demand_floor_1000"),
            ),
        ),
        DataRequirement(
            field="inbound_logistics.unit_price", level="recommended",
            reason="Purchase cost per sourcing arc — a missing price defaults to "
                   "1.0 and distorts procurement spend.",
            fallback=None,
            fallback_spec=(FallbackStep(grade="warn", constant=1.0),),
        ),
        DataRequirement(
            field="inbound_logistics.lead_time", level="recommended",
            reason="Supplier lead time per sourcing arc — missing values default "
                   "to 2 weeks.",
            fallback=None,
            fallback_spec=(FallbackStep(grade="warn", constant=2.0),),
        ),
        DataRequirement(
            field="suppliers.capacity_per_week", level="defaulted",
            reason="Empty means unlimited (a valid modeling choice) — but partial-"
                   "magnitude supplier disruptions need a finite capacity to "
                   "throttle, else they degrade to full outages.",
            fallback="unlimited",
            # NOT a fallback: `context.py` builds `np.inf` from the NULL, so the
            # engine honours the blank instead of substituting for it. Declared
            # here because the sentence had TWO authors — this table said
            # "unlimited" in prose and `columnSpecs.ts::master.nullMeans` carried
            # the token and the tooltip the grid actually rendered (§4 D167).
            empty_means=EmptyMeaning(
                token="∞",
                meaning="No capacity limit. An empty supplier capacity means "
                        "unlimited, so this supplier never throttles shipments — "
                        "and a partial-magnitude disruption on it degrades to a "
                        "full outage. Enter a number to model a finite capacity.",
            ),
        ),
    )


# ── Policy & demand helpers ───────────────────────────────────────────────────

def _merged_policy(policies: dict, node_id: str, family: str) -> dict:
    default = (policies.get("default") or {}).get(family) or {}
    override = (policies.get(f"node:{node_id}") or {}).get(family) or {}
    return {**default, **override}


def _supplier_row_values(
    policies: dict, family: str, field: str, mat_ids: set[str], w: list[MappingWarning],
) -> dict[str, Any]:
    """Per-material values of one field, read from /policies Supplier-stage rows.

    Those rows key overrides ``node:<supplier>::<material>``. A material-level
    attribute set on two rows of one material with DIFFERENT values is resolved
    the way `_map_policies` resolves κ and Q: sorted key order, first wins, and
    the conflict is announced rather than picked silently.
    """
    out: dict[str, Any] = {}
    for k in sorted(k for k in policies if isinstance(k, str) and k.startswith("node:")):
        sup, sep, mat = k[len("node:"):].partition("::")
        if not sep or mat not in mat_ids:
            continue
        v = ((policies[k] or {}).get(family) or {}).get(field)
        if v is None:
            continue
        if mat in out and out[mat] != v:
            w.append(MappingWarning(
                "warn", f"material:{mat}", field,
                f"conflicting per-supplier values for one material — "
                f"kept {out[mat]}, ignored {v} (from {sup})"))
            continue
        out[mat] = v
    return out


def _supplier_values(
    policies: dict, family: str, field: str, sup_ids: set[str], w: list[MappingWarning],
) -> dict[str, Any]:
    """Per-SUPPLIER values of one field, read from /policies Supplier-stage rows.

    The supplier-level twin of :func:`_supplier_row_values`: the row key is
    ``node:<supplier>::<material>`` and a supplier attribute (capacity,
    reliability) is the same on every row of that supplier. Sorted key order,
    first wins, and two rows of one supplier disagreeing is announced.
    """
    out: dict[str, Any] = {}
    for k in sorted(k for k in policies if isinstance(k, str) and k.startswith("node:")):
        sup, sep, mat = k[len("node:"):].partition("::")
        if not sep or sup not in sup_ids:
            continue
        v = ((policies[k] or {}).get(family) or {}).get(field)
        if v is None:
            continue
        if sup in out and out[sup] != v:
            w.append(MappingWarning(
                "warn", f"supplier:{sup}", field,
                f"conflicting per-material values for one supplier — "
                f"kept {out[sup]}, ignored {v} (from {mat})"))
            continue
        out[sup] = v
    return out


# ── /policies overrides of item-master values (PLAN.md §23 WP 13.1, §4 D280) ──
#
# /policies NEVER writes the item masters. A cost, MOQ, capacity, price or
# demand changed there is a POLICY OVERRIDE on the grid row, saved in the policy
# version, and the mapper reads every such field in one order:
#
#     override → item master → derived from lanes → default
#
# — the order `holding_cost_pct` already followed (§4 D204). The row keys are the
# grid's own: the Supplier stage's ``node:<supplier>::<material>`` and the Plant
# stage's ``node:<plant>::<product>`` (`columnSpecs.ts` targetKey). The grid
# resolves the same rule (`src/lib/policies/masterOverrides.ts`) so the value a
# cell shows is the value read here.
#
# The sources of every value are COUNTED and the counts go to the run log, one
# line per field, so a run states how many entities took the /policies value,
# how many the uploaded master, how many a lane-derived value, how many another
# derivation (a product's capacity from the plant grid's line rate) and how many
# the terminal default.
_SOURCE_ORDER = ("override", "master", "lanes", "derived", "default")


class _SourceTally:
    """Where every master-backed value came from — counted for the run log and
    recorded per entity for `MappingResult.resolved` (§23 WP 13.4: the value the
    engine receives for each /policies cell, which `pageEqualsRun` compares)."""

    def __init__(self) -> None:
        self.counts: dict[str, dict[str, int]] = {}
        self.by_entity: dict[str, dict[str, dict[str, Any]]] = {}

    def add(self, field: str, source: str, entity: Optional[str] = None,
            count: bool = True) -> None:
        """``count=False`` records the entity's answer (page-equals-run) without
        a run-log line — for a value the run does not use, so a project that
        sets none of a feature logs exactly as before it existed."""
        if count:
            row = self.counts.setdefault(field, {})
            row[source] = row.get(source, 0) + 1
        if entity is not None:
            self.by_entity.setdefault(field, {})[entity] = {"source": source}

    def value(self, field: str, entity: str, v: Any) -> None:
        self.by_entity.setdefault(field, {}).setdefault(entity, {})["value"] = v

    def emit(self, w: list[MappingWarning]) -> None:
        for field in sorted(self.counts):
            row = self.counts[field]
            parts = " · ".join(f"{s} {row[s]}" for s in _SOURCE_ORDER if row.get(s))
            w.append(MappingWarning(
                "info", "source", field,
                f"value sources (override → item master → lanes → default): {parts}"))


def _override_num(
    v: Any, *, entity: str, field: str, domain: str, w: list[MappingWarning],
) -> Optional[float]:
    """A /policies override as a number, or None when it cannot be used.

    `domain` is the key's declared one (`POLICY_BUNDLE_KEYS`). A non-numeric or
    out-of-domain value is IGNORED WITH A WARNING rather than applied or
    silently dropped: the master underneath then decides, and the run log says
    the override did not."""
    try:
        n = float(v)
    except (TypeError, ValueError):
        n = float("nan")
    ok = n == n and n not in (float("inf"), float("-inf")) and n >= 0
    if domain == "positive":
        ok = ok and n > 0
    elif domain == "fraction":
        ok = ok and n <= 1.0
    elif domain == "percent":
        ok = ok and n <= 100.0
    if not ok:
        w.append(MappingWarning(
            "warn", entity, field,
            f"/policies override {v!r} is not a usable value — ignored, the item master decides"))
        return None
    return n


# ── A lane's lead-time spread (PLAN.md §26 WP 16.2, D299, blueprint P-S.6) ──
_LANE_LT_DISTS = ("deterministic", "normal", "lognormal", "gamma", "triangular", "uniform")
_LT_SPREAD_KEYS = ("lane_lead_time_dist", "lane_lead_time_cv", "lane_lead_time_min_weeks",
                   "lane_lead_time_mode_weeks", "lane_lead_time_max_weeks")


def _lane_lead_time_spread(
    arc: "SupplyArc", mrow: Optional["MaterialRow"], row: dict, w: list[MappingWarning],
) -> tuple[dict[str, Any], Optional[float], dict[str, tuple[str, Any]]]:
    """The lane's lead-time SHAPE as the engine receives it, its planning lead
    time when the shape fixes one, and where every part came from.

    Order (§26.2 rule 5), per part: the Supplier row (``row``, the lane's
    ``sourcing`` patch) → the lane's upload → (shape and CV only) the material's
    master → deterministic. A shape the row or the lane chose that lacks a
    parameter it reads is WARNED and the lane runs deterministic — never a
    guessed parameter. A material's shape keeps its pre-Phase-15 meaning exactly
    (a missing CV is "no spread", silently), so a project that states no lane or
    row spread maps byte-identically — except that a material CV above the
    engine's bound of 1 is now clamped to 1 and warned instead of failing the
    run (§4 D302).

    Returns ``(link_fields, planning_weeks, resolved)``: ``planning_weeks`` is the
    bounded shape's mean (§26.2 rule 3), else None (the lane's lead time stands);
    ``resolved`` maps each lane column to ``(source, value)`` — the value each
    /policies cell must show (page-equals-run), whether or not the chosen shape
    reads it.
    """
    ent = f"supply:{arc.supplier_id}->{arc.material_id}"
    src: dict[str, str] = {}

    # The shape.
    dist, dist_src = None, "default"
    rv = row.get("lane_lead_time_dist")
    if rv not in (None, ""):
        t = str(rv).strip().lower()
        if t in _LANE_LT_DISTS:
            dist, dist_src = t, "override"
        else:
            w.append(MappingWarning("warn", ent, "lane_lead_time_dist",
                                    f"/policies override {rv!r} is not one of {', '.join(_LANE_LT_DISTS)} "
                                    f"— ignored, the lane's upload decides"))
    if dist is None and arc.lead_time_dist not in (None, ""):
        t = str(arc.lead_time_dist).strip().lower()
        if t in _LANE_LT_DISTS:
            dist, dist_src = t, "master"
        else:
            w.append(MappingWarning("warn", ent, "lead_time_dist",
                                    f"lane lead-time distribution {arc.lead_time_dist!r} is not one of "
                                    f"{', '.join(_LANE_LT_DISTS)} — ignored"))
    if dist is None and mrow is not None and mrow.lead_time_dist:
        dist, dist_src = str(mrow.lead_time_dist), "derived"
    if dist is None:
        dist = "deterministic"
    src["lead_time_dist"] = dist_src

    # The CV: row → lane → material.
    cv, cv_src = None, "default"
    rv = row.get("lane_lead_time_cv")
    if rv not in (None, ""):
        n = _override_num(rv, entity=ent, field="lane_lead_time_cv", domain="fraction", w=w)
        if n is not None:
            cv, cv_src = n, "override"
    if cv is None and arc.lead_time_cv is not None:
        cv, cv_src = float(arc.lead_time_cv), "master"
    if cv is None and mrow is not None and mrow.lead_time_cv:
        cv, cv_src = float(mrow.lead_time_cv), "derived"
        if cv > 1.0:
            w.append(MappingWarning(
                "warn", ent, "lead_time_cv",
                f"material lead-time CV {cv:g} is above the engine's bound of 1 → used as 1 "
                f"(§4 D302)"))
            cv = 1.0
    src["lead_time_cv"] = cv_src

    # The bounds: row → lane (in the lane's lead_time_unit).
    bounds: dict[str, Optional[float]] = {}
    for part, rkey, col in (("lead_time_min", "lane_lead_time_min_weeks", arc.lead_time_min),
                            ("lead_time_mode", "lane_lead_time_mode_weeks", arc.lead_time_mode),
                            ("lead_time_max", "lane_lead_time_max_weeks", arc.lead_time_max)):
        v, vs = None, "default"
        rv = row.get(rkey)
        if rv not in (None, ""):
            n = _override_num(rv, entity=ent, field=rkey, domain="nonnegative", w=w)
            if n is not None:
                v, vs = n, "override"
        if v is None and col is not None:
            v, vs = _duration_to_weeks(float(col), arc.lead_time_unit), "master"
        bounds[part], src[part] = v, vs
    vals: dict[str, Any] = {"lead_time_dist": dist, "lead_time_cv": cv, **bounds}

    def _resolved() -> dict[str, tuple[str, Any]]:
        return {k: (src[k], vals[k]) for k in src}

    out: dict[str, Any] = {"lead_time_dist": LeadTimeDist(dist), "lead_time_cv": cv or 0.0}
    chosen_here = dist_src in ("override", "master")

    def _fallback(why: str) -> tuple[dict[str, Any], Optional[float], dict[str, tuple[str, Any]]]:
        w.append(MappingWarning("warn", ent, "lead_time_dist",
                                f"{dist} lead time {why} → the lane runs deterministic"))
        src["lead_time_dist"], vals["lead_time_dist"] = "default", "deterministic"
        return {"lead_time_dist": LeadTimeDist.DETERMINISTIC, "lead_time_cv": 0.0}, None, _resolved()

    if dist in ("normal", "lognormal", "gamma"):
        if cv is None and chosen_here:
            return _fallback("needs a CV and none is stated (row, lane or material)")
        return out, None, _resolved()
    if dist in ("triangular", "uniform"):
        lo, mo, hi = bounds["lead_time_min"], bounds["lead_time_mode"], bounds["lead_time_max"]
        if lo is None or hi is None or (dist == "triangular" and mo is None):
            need = "min, mode and max" if dist == "triangular" else "min and max"
            return _fallback(f"needs {need}")
        if dist == "uniform":
            mo = None
        if hi > 51:
            return _fallback(f"max {hi:g} wk is above the engine's 51 weeks")
        if not (lo <= (mo if mo is not None else lo) <= hi and lo <= hi):
            return _fallback(f"needs min ≤ {'mode ≤ ' if mo is not None else ''}max, got "
                             f"{lo:g} / {'' if mo is None else f'{mo:g} / '}{hi:g}")
        out.update(lead_time_min_weeks=lo, lead_time_mode_weeks=mo, lead_time_max_weeks=hi,
                   lead_time_cv=0.0)
        mean = lead_time_bounds_mean(LeadTimeDist(dist), lo, mo, hi)
        return out, mean, _resolved()
    # deterministic (or the material's reserved `empirical`, which compile
    # refuses). A row or lane that SAYS deterministic means no spread at all, so
    # P-P.3's King formula reads no CV for it; a deterministic material keeps
    # the CV it always carried (inert for draws), byte-identically.
    if dist == "deterministic" and chosen_here:
        out["lead_time_cv"] = 0.0
    return out, None, _resolved()


# ── P-P.13 production lead time (PLAN.md §26 WP 16.5, D300) ───────────────────

def _product_lead_time(
    p: "ProductRow", row: dict, tally: "_SourceTally", w: list[MappingWarning],
) -> dict[str, Any]:
    """The product's production lead time and shape as the engine receives them,
    and every part's source for page-equals-run.

    Order, per part: the Plant row → the product master (in
    `production_lead_time_unit`) → the default (0 weeks, deterministic). A shape
    lacking a parameter it reads runs deterministic, warned; a bounded shape plans
    on its bounds' mean (§26.2 rule 3) and the row's lead time is then not read.
    Returns only the fields that differ from the entity defaults, so a product
    that states nothing maps — and serializes — exactly as before Phase 16. The
    sources are counted in the run log only when the product states something.
    """
    ent = f"product:{p.id}"
    src: dict[str, tuple[str, Any]] = {}

    def num(key: str, col: Optional[float], domain: str, convert: bool) -> tuple[Optional[float], str]:
        rv = row.get(key)
        if rv not in (None, ""):
            n = _override_num(rv, entity=ent, field=key, domain=domain, w=w)
            if n is not None:
                return n, "override"
        if col is not None:
            v = float(col)
            return (_duration_to_weeks(v, p.production_lead_time_unit) if convert else v), "master"
        return None, "default"

    lt, lt_src = num("prod_lead_time_weeks", p.production_lead_time, "nonnegative", True)
    cv, cv_src = num("prod_lead_time_cv", p.production_lead_time_cv, "fraction", False)
    lo, lo_src = num("prod_lead_time_min_weeks", p.production_lead_time_min, "nonnegative", True)
    mo, mo_src = num("prod_lead_time_mode_weeks", p.production_lead_time_mode, "nonnegative", True)
    hi, hi_src = num("prod_lead_time_max_weeks", p.production_lead_time_max, "nonnegative", True)
    dist, dist_src = "deterministic", "default"
    rv = row.get("prod_lead_time_dist")
    if rv not in (None, ""):
        t = str(rv).strip().lower()
        if t in _LANE_LT_DISTS:
            dist, dist_src = t, "override"
        else:
            w.append(MappingWarning("warn", ent, "prod_lead_time_dist",
                                    f"/policies override {rv!r} is not one of {', '.join(_LANE_LT_DISTS)} "
                                    f"— ignored, the item master decides"))
    if dist_src == "default" and p.production_lead_time_dist not in (None, ""):
        t = str(p.production_lead_time_dist).strip().lower()
        if t in _LANE_LT_DISTS:
            dist, dist_src = t, "master"
        else:
            w.append(MappingWarning("warn", ent, "production_lead_time_dist",
                                    f"products.production_lead_time_dist {t!r} is not a lead-time "
                                    f"shape — ignored"))

    def _fallback(why: str) -> None:
        nonlocal dist, dist_src
        w.append(MappingWarning("warn", ent, "production_lead_time_dist",
                                f"{dist} production lead time {why} → runs deterministic"))
        dist, dist_src = "deterministic", "default"

    planning = lt if lt is not None else 0.0
    planning_src = lt_src
    out: dict[str, Any] = {}
    if dist in ("normal", "lognormal", "gamma"):
        if cv is None:
            _fallback("needs a CV and none is stated")
    elif dist in ("triangular", "uniform"):
        mode_ok = dist == "uniform" or mo is not None
        if lo is None or hi is None or not mode_ok:
            _fallback("needs " + ("min, mode and max" if dist == "triangular" else "min and max"))
        elif hi > 26:
            _fallback(f"max {hi:g} wk is above the engine's 26 weeks")
        elif not (lo <= (mo if dist == "triangular" else lo) <= hi and lo <= hi):
            _fallback("needs its bounds in order (min ≤ mode ≤ max)")
        else:
            mean = lead_time_bounds_mean(LeadTimeDist(dist), lo, mo if dist == "triangular" else None, hi)
            if lt_src == "override":
                w.append(MappingWarning(
                    "info", ent, "prod_lead_time_weeks",
                    f"the row's production lead time is not read on a {dist} product — it plans "
                    f"on the bounds' mean, {mean:g} wk"))
            planning, planning_src = mean, "derived"
            out.update(production_lead_time_min_weeks=lo, production_lead_time_max_weeks=hi)
            if dist == "triangular":
                out["production_lead_time_mode_weeks"] = mo
    weeks = int(_clamp(round(planning), 0, 26, w=w, field="production_lead_time", unit=" wk",
                       entity=ent))
    if weeks:
        out["production_lead_time_weeks"] = weeks
    if dist != "deterministic":
        out["production_lead_time_dist"] = LeadTimeDist(dist)
        if dist in ("normal", "lognormal", "gamma"):
            out["production_lead_time_cv"] = cv
    stated = any(s_ in ("override", "master")
                 for s_ in (lt_src, cv_src, lo_src, mo_src, hi_src, dist_src))
    for field, source, val in (
            ("production_lead_time", planning_src, weeks),
            ("production_lead_time_dist", dist_src, dist),
            ("production_lead_time_cv", cv_src, cv),
            ("production_lead_time_min", lo_src, lo),
            ("production_lead_time_mode", mo_src, mo),
            ("production_lead_time_max", hi_src, hi)):
        tally.add(f"products.{field}", source, p.id, count=stated)
        tally.value(f"products.{field}", p.id, val)
    return out


def _apply_primary_choice(
    links: list[SupplierLink], policies: dict, w: list[MappingWarning],
) -> None:
    """Mark the primary supplier the /policies Supplier stage SAVED (§4 D188).

    A saved ``node:<supplier>::<material>`` → ``sourcing.primary_source: true``
    is the user's choice of where that material is bought, and it beats the
    engine's own rule (cheapest link — `primary_rank`). Nothing saved leaves the
    engine rule in charge, which is also what the grid suggests, so an unsaved
    row and the run agree.

    A material with TWO saved primaries is ambiguous: neither is applied, the
    engine rule picks, and the warning says so — the pre-run check blocks that
    state, so reaching here means the gate was bypassed. A saved primary whose
    lane no longer exists is named rather than silently forgotten.
    """
    by_key = {(l.supplier_id, l.material_id): l for l in links}
    chosen: dict[str, list[str]] = {}
    stale: list[str] = []
    for k in sorted(k for k in policies if isinstance(k, str) and k.startswith("node:")):
        if ((policies[k] or {}).get("sourcing") or {}).get("primary_source") is not True:
            continue
        body = k[len("node:"):]
        # Both halves are free text; try the first and the last `::`, keep the
        # one that names a real link (the `_composite_target` convention).
        cands = [body.partition("::"), body.rpartition("::")]
        hit = next(((sup, mat) for sup, sep, mat in cands if sep and (sup, mat) in by_key), None)
        if hit is None:
            sup, sep, mat = cands[0]
            if sep and not sup.startswith("("):  # "(made in-house)" etc. are grid-only rows
                stale.append(body)
            continue
        chosen.setdefault(hit[1], []).append(hit[0])
    if stale:
        w.append(MappingWarning(
            "info", "policy:sourcing", "primary_source",
            f"{len(stale)} saved primary supplier choice(s) name a supplier × material "
            f"with no inbound lane, so they choose nothing: {stale[:5]}"))
    applied = changed = 0
    for mat, sups in sorted(chosen.items()):
        if len(sups) > 1:
            w.append(MappingWarning(
                "warn", f"material:{mat}", "primary_source",
                f"{len(sups)} suppliers saved as primary ({sorted(sups)[:5]}) — none applied, "
                "the engine's cheapest-supplier rule picks"))
            continue
        options = [l for l in links if l.material_id == mat]
        before = min(options, key=primary_rank).supplier_id
        by_key[(sups[0], mat)].primary = True
        applied += 1
        changed += before != sups[0]
    if applied:
        w.append(MappingWarning(
            "info", "policy:sourcing", "primary_source",
            f"{applied} material(s) are bought from the primary supplier saved on /policies; "
            f"for {changed} of them that is not the cheapest supplier the engine would "
            "otherwise pick"))


def recovery_responses(recovery: dict) -> set[str]:
    """The recovery responses a run applies: none while recovery is switched off.

    `enabled: false` on the scenario's playbook ("Recovery enabled" on the card)
    means disruptions hit raw. Before engine 0.8.2 the mapper never read it, so a
    ticked strategy ran with the switch off.
    """
    if recovery.get("enabled", True) is False:
        return set()
    return {str(r) for r in (recovery.get("response") or [])}


def _scenario_backup_links(
    recovery: dict, links: list[SupplierLink], w: list[MappingWarning],
) -> tuple[list[SupplierLink], dict[str, dict]]:
    """Backup sources a scenario's playbook ENTERS for P-S.1 (engine 0.8.2).

    ``recovery.backup_lanes`` is a list of ``{material_id, supplier_id, lead_time_weeks,
    unit_price, capacity_per_week?, supplier_name?}`` — a source the planner states for
    this scenario because no uploaded lane offers one. Each becomes a ``backup_only``
    link: never the material's primary, no planned share, used only while P-S.1
    reroutes. Read only when the Backup supplier response is on, so a scenario that
    does not use it compiles exactly as before. Returns the links and, for a supplier
    no uploaded lane names, the entity fields it needs.
    """
    entries = recovery.get("backup_lanes") or []
    if not entries or "dual_source_activate" not in recovery_responses(recovery):
        return [], {}
    existing = {(l.supplier_id, l.material_id) for l in links}
    sourced = {l.material_id for l in links}
    known_sup = {l.supplier_id for l in links}
    out: list[SupplierLink] = []
    new_sups: dict[str, dict] = {}
    for i, e in enumerate(entries):
        ent = f"scenario:backup_lanes[{i}]"
        if not isinstance(e, dict):
            w.append(MappingWarning("warn", ent, "backup_lanes", "not an object — skipped"))
            continue
        mat = str(e.get("material_id") or "").strip()
        sup = str(e.get("supplier_id") or "").strip()
        try:
            lt = float(e.get("lead_time_weeks"))
            price = float(e.get("unit_price"))
        except (TypeError, ValueError):
            lt = price = float("nan")
        if not mat or not sup or not (lt == lt) or not (price == price):
            w.append(MappingWarning(
                "warn", ent, "backup_lanes",
                "a backup source needs a material, a supplier, a lead time and a unit price — skipped"))
            continue
        if mat not in sourced:
            w.append(MappingWarning(
                "warn", ent, "material_id",
                f"{mat!r} has no uploaded supplier, so there is no primary to back up — skipped"))
            continue
        if (sup, mat) in existing:
            w.append(MappingWarning(
                "info", ent, "supplier_id",
                f"{sup!r} already supplies {mat!r} through an uploaded lane — the uploaded lane "
                "is the backup; the entered one is not added"))
            continue
        if price <= 0:
            w.append(MappingWarning("warn", ent, "unit_price",
                                    f"unit price {price:g} must be above 0 — skipped"))
            continue
        out.append(SupplierLink(
            supplier_id=sup, material_id=mat, cost=price, backup_only=True,
            lead_time_weeks=int(_clamp(round(lt), 1, 51, w=w, entity=ent,
                                       field="lead_time_weeks", unit=" wk")),
        ))
        existing.add((sup, mat))
        if sup not in known_sup and sup not in new_sups:
            cap = e.get("capacity_per_week")
            new_sups[sup] = {
                "name": str(e.get("supplier_name") or sup),
                "capacity_per_week": float(cap) if cap not in (None, "") and float(cap) > 0 else None,
            }
    if out:
        w.append(MappingWarning(
            "info", "scenario", "backup_lanes",
            f"{len(out)} backup source(s) entered on this scenario, not uploaded — used only "
            f"while backup_supplier reroutes: {[f'{l.supplier_id}->{l.material_id}' for l in out][:5]}"))
    return out, new_sups


def _safety_stock_windows(raw: Any, w: list[MappingWarning]) -> list[dict]:
    """The recovery card's safety-stock windows → P-P.3 `windows` (engine 0.8.3).

    Each entry is ``{material_id, days, start_week, end_week}``: extra cover for one
    material, held for ``start_week ≤ week < end_week`` (the disruption schedule's
    weeks). An entry the plugin would refuse is skipped here, with the reason.
    """
    out: list[dict] = []
    for i, e in enumerate(raw or []):
        ent = f"scenario:safety_stock_windows[{i}]"
        try:
            mat = str(e.get("material_id") or "").strip()
            days = float(e.get("days"))
            start, end = int(e.get("start_week")), int(e.get("end_week"))
        except (AttributeError, TypeError, ValueError):
            mat, days, start, end = "", 0.0, 0, 0
        if not mat or not days > 0 or start < 0 or end <= start:
            w.append(MappingWarning(
                "warn", ent, "safety_stock_windows",
                "a buffer window needs a material, days above 0 and a start week before its "
                "end week — skipped"))
            continue
        out.append({"material_id": mat,
                    "days": _clamp(days, 0.0, 84.0, w=w, entity=ent, field="days", unit=" d"),
                    "start_week": start, "end_week": end})
    return out


def _composite_target(key_body: str, targets: set[str]) -> Optional[str]:
    """The target id inside a composite ``<owner>::<target>`` key, or None.

    Splitting at the FIRST ``::`` is this file's convention — the same parse
    :func:`_multi_sourcing_weights` and the P-P.9 priority fold use, and the
    one the TS grader mirrors. Both halves of a key are free-text user data
    though, so a plant named ``A::B`` would defeat it; the LAST ``::`` is
    tried as a second candidate for exactly that case. Each candidate is
    validated against the known ids, so an extra one cannot mis-resolve —
    it can only rescue a key the first split got wrong.
    """
    first = key_body.partition("::")[2]
    if first and first in targets:
        return first
    last = key_body.rpartition("::")[2]
    if last and last in targets:
        return last
    return None


def _composite_patches(
    policies: dict, family: str, targets: set[str], w: list[MappingWarning],
    exclude: frozenset[str] = frozenset(),
) -> dict[str, dict]:
    """Index ``node:<owner>::<target>`` patches of ``family`` by their target.

    The policy grid's two-key stages write one override row per pair — the
    plant stage as ``<plant>::<product>``, the supplier stage as
    ``<supplier>::<material>`` (``src/lib/policies/columnSpecs.ts``). The
    engine only ever holds the target id, so a lookup keyed by the target
    alone has to reach those rows or they are stored and never read (§4 D75).

    Keys are visited in sorted order, so when two owners patch the same
    target the winner is stable — and it is ANNOUNCED rather than picked in
    silence, because a silent choice between two user-entered values is the
    same defect this function exists to close.
    """
    seen: dict[str, list[str]] = {}
    out: dict[str, dict] = {}
    for key in sorted(k for k in policies if isinstance(k, str)):
        if not key.startswith("node:") or "::" not in key:
            continue
        # A Customer row `<customer>::<product>` is not the product's row (WP
        # 14.4 closed the reach WP 14.2 found): its patches are the row's own.
        if key[len("node:"):] in exclude:
            continue
        target = _composite_target(key[len("node:"):], targets)
        if target is None:
            continue
        patch = (policies.get(key) or {}).get(family) or {}
        if not patch:
            continue
        seen.setdefault(target, []).append(key)
        out.setdefault(target, {}).update(patch)
    for target, keys in seen.items():
        if len(keys) > 1:
            w.append(MappingWarning(
                "warn", f"{family}:{target}", "target_key",
                f"{len(keys)} {family!r} overrides name {target!r} under different "
                f"owners ({', '.join(repr(k) for k in keys)}) — merged in key order, "
                f"{keys[-1]!r} wins on any field they share"))
    return out


# Extended fulfillment strategies the UI offers (FulfillmentStrategy) that the
# engine does not model — they collapse to MTO. Warned so the collapse is never silent.
_MODE_COLLAPSED_TO_MTO = {"cto", "configure_to_order", "eto", "engineer_to_order"}


def _fulfillment_mode(
    raw: Optional[str],
    project_model: Optional[str],
    w: Optional[list["MappingWarning"]] = None,
    product_id: Optional[str] = None,
) -> FulfillmentMode:
    token = (raw or project_model or "").strip().lower().replace("-", "_").replace(" ", "_")
    if token in ("mts", "make_to_stock"):
        return FulfillmentMode.MTS
    if token in ("ato", "assemble_to_order"):
        return FulfillmentMode.ATO
    if token in _MODE_COLLAPSED_TO_MTO and w is not None:
        w.append(MappingWarning(
            "warn", f"product:{product_id or '?'}", "fulfillment_mode",
            f"fulfillment mode {token!r} is not modeled by the engine — treated as make_to_order (MTO)"))
    return FulfillmentMode.MTO


# The two values a Plant row may set — mirrored by `entityOverrides.ts`'s
# `fulfillment_mode` domain, so the page and the run accept the same tokens.
_MODE_OVERRIDE_TOKENS = ("mts", "mto")


def _resolve_mode(
    master: ProductRow, prod_row: dict, project_model: Optional[str],
    tally: "_SourceTally", w: list[MappingWarning],
) -> FulfillmentMode:
    """Whether the product holds FG stock: the Plant-stage row's override → the
    products master → the project's model → MTO. Only an override is counted in
    the run log, so a project that sets none logs exactly as before."""
    pid = master.id
    raw = prod_row.get("fulfillment_mode")
    token = None
    if raw not in (None, ""):
        token = str(raw).strip().lower()
        if token not in _MODE_OVERRIDE_TOKENS:
            token = None
            w.append(MappingWarning("warn", f"product:{pid}", "fulfillment_mode",
                                    f"/policies override {raw!r} is not mts or mto — ignored, "
                                    f"the item master decides"))
    if token is not None:
        mode, src = FulfillmentMode(token), "override"
    else:
        mode = _fulfillment_mode(master.fulfillment_mode, project_model, w, pid)
        src = "master" if master.fulfillment_mode not in (None, "") else "default"
    tally.add("products.fulfillment_mode", src, pid, count=src == "override")
    tally.value("products.fulfillment_mode", pid, mode.value)
    return mode


def _resolve_demand_kind(product_dist: Optional[str], scenario_model: Optional[dict]) -> str:
    if product_dist:
        return str(product_dist).strip().lower()
    if scenario_model and scenario_model.get("kind"):
        return str(scenario_model["kind"]).strip().lower()
    return "triangular"


def _negbin_k(mean: float, cv: float) -> float:
    if mean <= 0 or cv <= 0:
        return 1.0
    var = (cv * mean) ** 2
    if var <= mean:           # under-dispersed → push toward Poisson
        return 1e6
    return max(1e-3, mean * mean / (var - mean))


_FG_POLICIES = ("base_stock", "min_max", "days_of_cover")


def _resolve_fg(
    pid: str, master: ProductRow, prod_row: dict, overrides: dict[str, Optional[float]],
    tally: "_SourceTally", w: list[MappingWarning],
) -> dict[str, Any]:
    """The product's FG policy and levels (WP 14.4): the Plant-stage row's
    override → the products master → the engine default (base-stock, derived S,
    start at the target). Recorded for page-equals-run for every product; the
    engine receives them for an MTS product only.

    An incomplete policy (min-max without s or S, s ≥ S; days of cover without
    D) is NOT a crash: the product runs base-stock with whatever S it has, and
    the run says so — the pre-run check is where such a row should be caught.
    """
    ent = f"product:{pid}"
    out: dict[str, Any] = {}
    for field in ("fg_base_stock", "fg_reorder_point", "fg_cover_days", "fg_initial_on_hand"):
        ov = overrides.get(field)
        mv = getattr(master, field)
        if ov is not None:
            out[field] = ov
            tally.add(f"products.{field}", "override", pid, count=True)
        elif mv is not None:
            out[field] = float(mv)
            tally.add(f"products.{field}", "master", pid, count=True)
        else:
            out[field] = None
            tally.add(f"products.{field}", "default", pid, count=False)
        tally.value(f"products.{field}", pid, out[field])
    raw = prod_row.get("fg_policy")
    token = str(raw).strip().lower() if raw not in (None, "") else None
    if token is not None and token not in _FG_POLICIES:
        w.append(MappingWarning("warn", ent, "fg_policy",
                                f"/policies override {raw!r} is not an FG policy — ignored, "
                                f"the item master decides"))
        token = None
    if token is not None:
        policy, src = token, "override"
    elif master.fg_policy:
        policy, src = str(master.fg_policy).strip().lower(), "master"
        if policy not in _FG_POLICIES:
            w.append(MappingWarning("warn", ent, "fg_policy",
                                    f"products.fg_policy {master.fg_policy!r} is not an FG policy "
                                    f"→ base_stock"))
            policy = "base_stock"
    else:
        policy, src = "base_stock", "default"
    tally.add("products.fg_policy", src, pid, count=src != "default")
    if policy == "min_max" and not (
            out["fg_base_stock"] is not None and out["fg_reorder_point"] is not None
            and out["fg_reorder_point"] < out["fg_base_stock"]):
        w.append(MappingWarning("warn", ent, "fg_policy",
                                "min_max needs s (fg_reorder_point) below S (fg_base_stock) — "
                                "run as base_stock"))
        policy = "base_stock"
    if policy == "days_of_cover" and out["fg_cover_days"] is None:
        w.append(MappingWarning("warn", ent, "fg_policy",
                                "days_of_cover needs D (fg_cover_days) — run as base_stock"))
        policy = "base_stock"
    tally.value("products.fg_policy", pid, policy)
    out["fg_policy"] = policy
    return out


def _build_product(
    row: ProductRow, *, price: float, capacity: float, mode: FulfillmentMode,
    mean: float, cv: float, kind: str, warnings: list[MappingWarning],
    fg: Optional[dict[str, Any]] = None,
    production_lead_time: Optional[dict[str, Any]] = None,
) -> Product:
    common = dict(
        id=row.id, name=str(row.name or row.id),
        unit_price=max(price, 1e-9), production_capacity=max(capacity, 1e-6),
        fulfillment_mode=mode,
    )
    # P-P.13 — only what a product states; one that states none keeps the entity
    # defaults (0, deterministic), so it serializes exactly as before.
    if production_lead_time:
        common.update(production_lead_time)
    # FG policy and levels reach an MTS product only (WP 14.4); an MTO product
    # holds no FG stock. A product that sets none keeps the entity defaults.
    if fg and mode == FulfillmentMode.MTS:
        common.update({k: v for k, v in fg.items() if v is not None and k != "fg_policy"})
        if fg.get("fg_policy") and fg["fg_policy"] != "base_stock":
            common["fg_policy"] = fg["fg_policy"]
    if kind in ("triangular", "triangular_av", "triangularav", ""):
        a, b, c = triangular_av(max(mean, 0.0), max(cv, 0.0))
        # Master-supplied explicit bounds win over the symmetric AV form
        # (docs/data-simulation-mapping.md §5). Inconsistent bounds are
        # clamped to the mode and reported instead of failing the run.
        if row.demand_min is not None:
            a = float(row.demand_min)
            if a > b:
                warnings.append(MappingWarning(
                    "warn", f"product:{row.id}", "demand_min",
                    f"demand_min {a:g} > demand mode {b:g} — clamped to the mode"))
                a = b
        if row.demand_max is not None:
            c = float(row.demand_max)
            if c < b:
                warnings.append(MappingWarning(
                    "warn", f"product:{row.id}", "demand_max",
                    f"demand_max {c:g} < demand mode {b:g} — clamped to the mode"))
                c = b
        return Product(demand_model=DemandModel.TRIANGULAR,
                       demand_mode=b, demand_min=max(a, 0.0), demand_max=c, **common)
    if kind == "deterministic":
        return Product(demand_model=DemandModel.DETERMINISTIC, demand_mode=mean, **common)
    if kind == "poisson":
        return Product(demand_model=DemandModel.POISSON, demand_mode=mean, **common)
    if kind == "negbin":
        return Product(demand_model=DemandModel.NEGBIN, demand_mode=mean,
                       negbin_dispersion=_negbin_k(mean, cv), **common)
    if kind == "normal":
        # A REAL normal since WP 14.1 (ADR 0002 decision 8; §4 D284 (b)). Before
        # it, `normal` ran as triangularAV with demand_cv as its ± fraction.
        warnings.append(MappingWarning(
            "info", f"product:{row.id}", "demand_distribution",
            f"normal demand: demand_cv {cv:g} is the coefficient of variation "
            f"(σ = {cv:g} × {mean:g} = {cv * mean:g}/wk); negative draws are set to 0 and the "
            f"run reports how many (for triangular, demand_cv is the ± fraction instead)"))
        return Product(demand_model=DemandModel.NORMAL, demand_mode=max(mean, 0.0),
                       demand_cv=max(cv, 0.0), **common)
    # bootstrap (needs history we don't have) / unknown → triangularAV fallback
    warnings.append(MappingWarning("warn", f"product:{row.id}", "demand_distribution",
                                   f"demand kind {kind!r} unsupported here — using triangularAV "
                                   f"with demand_cv {cv:g} as its ± fraction"))
    a, b, c = triangular_av(max(mean, 0.0), max(cv, 0.0))
    return Product(demand_model=DemandModel.TRIANGULAR,
                   demand_mode=b, demand_min=a, demand_max=c, **common)


# ── Demand per customer × product row (WP 14.1) ──────────────────────────────

_ROW_KIND = {
    "deterministic": "deterministic", "normal": "normal", "poisson": "poisson",
    "triangular": "triangular",
    "triangular_av": "triangular_av", "triangularav": "triangular_av",
}


def _row_demand_spec(o: OutboundArc, w: list[MappingWarning]) -> Optional[dict[str, Any]]:
    """The CustomerLink demand fields an outbound row carries, normalized to
    weeks — or None when it carries none (today's behaviour for the row)."""
    ent = f"customer_row:{o.customer_id}::{o.product_id}"
    raw_kind = (o.demand_distribution or "").strip().lower().replace("-", "_").replace(" ", "_")
    has_any = raw_kind or o.forecast or any(
        v is not None for v in (o.demand_mean, o.demand_variation, o.demand_min, o.demand_max))
    if not has_any:
        return None
    spec: dict[str, Any] = {}
    if raw_kind:
        kind = _ROW_KIND.get(raw_kind)
        if kind is None:
            w.append(MappingWarning(
                "warn", ent, "demand_distribution",
                f"row demand distribution {o.demand_distribution!r} is not one of "
                f"{sorted(set(_ROW_KIND.values()))} — the row keeps its product's distribution"))
            return None
        spec["demand_model"] = kind
    elif o.forecast:
        spec["demand_model"] = "deterministic"
    for f in ("demand_mean", "demand_min", "demand_max"):
        v = getattr(o, f)
        if v is not None:
            spec[f] = _rate_to_weekly(float(v), o.time_unit)
    if o.demand_variation is not None:
        spec["demand_variation"] = float(o.demand_variation)
    if o.forecast:
        spec["forecast"] = [float(x) for x in o.forecast]
    return spec


def _customer_links(cust_share: dict[tuple[str, str], float],
                    row_spec: dict[tuple[str, str], dict[str, Any]],
                    prod_ids: set[str], w: list[MappingWarning]) -> list[CustomerLink]:
    """One CustomerLink per (product, customer) with volume or a demand spec.

    A spec the engine rejects (a distribution missing a parameter it needs)
    is dropped WITH a warning and the row keeps its product's distribution —
    the pre-run gate blocks such a row before a run is dispatched (WP 14.2).
    """
    out: list[CustomerLink] = []
    for key in sorted(set(cust_share) | set(row_spec)):
        pid, cid = key
        if pid not in prod_ids:
            continue
        spec = row_spec.get(key)
        share = cust_share.get(key, 0.0)
        if share <= 0 and spec is not None:
            fc = spec.get("forecast") or []
            share = spec.get("demand_mean") or (sum(fc) / len(fc) if fc else 0.0) or 1.0
        if share <= 0:
            continue
        if spec is not None:
            try:
                out.append(CustomerLink(product_id=pid, customer_id=cid, share=share, **spec))
                continue
            except ValueError as exc:
                errs = getattr(exc, "errors", None)
                msg = (errs()[0]["msg"] if callable(errs) else str(exc)).removeprefix("Value error, ")
                w.append(MappingWarning(
                    "warn", f"customer_row:{cid}::{pid}", "demand_distribution",
                    f"row demand spec not applied ({msg.strip()}) — the row keeps its "
                    f"product's distribution"))
        out.append(CustomerLink(product_id=pid, customer_id=cid, share=share))
    return out


# The Customer-row override keys (POLICY_BUNDLE_KEYS, `rows: customer`) and the
# CustomerLink field each one sets.
_ROW_OVERRIDE_FIELD = {
    "row_demand_distribution": "demand_model",
    "row_demand_mean": "demand_mean",
    "row_demand_variation": "demand_variation",
    "row_demand_min": "demand_min",
    "row_demand_max": "demand_max",
}
# `MappingResult.resolved` field name → the spec field it reports.
_ROW_RESOLVED = {
    "outbound_logistics.demand_distribution": "demand_model",
    "outbound_logistics.demand_mean": "demand_mean",
    "outbound_logistics.demand_variation": "demand_variation",
    "outbound_logistics.demand_min": "demand_min",
    "outbound_logistics.demand_max": "demand_max",
}


def _tally_row_allocation(
    tally: "_SourceTally", row_keys: frozenset[str], row_priority: dict[str, float],
    row_floor: dict[str, float], masters: dict[str, dict[str, Any]],
    rule: Optional[str] = None,
) -> None:
    """The Customer row's priority and service target as the engine resolves
    them (page-equals-run, WP 14.3): the row's override → its customer's master
    value → the engine default (priority 1.0; no floor, so the segment's tier
    floor applies). Recorded per ROW, whatever the rule — the grid shows the
    column only under a rule that reads it, and the cell must still be honest.
    Counted in the run log only under the rule that reads the value."""
    cp = rule in ("priority", "sla_tier")
    cf = rule == "sla_tier"
    for rid in sorted(row_keys):
        cid = rid.partition("::")[0]
        m = masters.get(cid, {})
        if rid in row_priority:
            tally.add("customers.priority_weight", "override", rid, count=cp)
            tally.value("customers.priority_weight", rid, row_priority[rid])
        elif m.get("priority_weight") is not None:
            tally.add("customers.priority_weight", "master", rid, count=cp)
            tally.value("customers.priority_weight", rid, float(m["priority_weight"]))
        else:
            tally.add("customers.priority_weight", "default", rid, count=cp)
            tally.value("customers.priority_weight", rid, 1.0)
        if rid in row_floor:
            tally.add("customers.sla_fill_floor_pct", "override", rid, count=cf)
            tally.value("customers.sla_fill_floor_pct", rid, row_floor[rid])
        elif m.get("sla_fill_floor_pct") is not None:
            tally.add("customers.sla_fill_floor_pct", "master", rid, count=cf)
            tally.value("customers.sla_fill_floor_pct", rid, float(m["sla_fill_floor_pct"]))
        else:
            tally.add("customers.sla_fill_floor_pct", "default", rid, count=cf)
            tally.value("customers.sla_fill_floor_pct", rid, None)


def _row_schedule(raw: Any, ent: str, w: list[MappingWarning]) -> Optional[list[float]]:
    """A Customer row's requested delivery schedule (`row_demand_schedule`):
    units per week from week 1 — or None when there is none, or it is not one."""
    if raw is None or raw == "" or raw == []:
        return None
    if not isinstance(raw, (list, tuple)):
        w.append(MappingWarning("warn", ent, "row_demand_schedule",
                                f"/policies delivery schedule {raw!r} is not a list of weekly "
                                f"quantities — ignored"))
        return None
    out: list[float] = []
    for i, v in enumerate(raw):
        try:
            n = 0.0 if v is None or v == "" else float(v)
        except (TypeError, ValueError):
            n = float("nan")
        if not math.isfinite(n) or n < 0:
            w.append(MappingWarning("warn", ent, "row_demand_schedule",
                                    f"/policies delivery schedule week {i + 1} is {v!r}, not a "
                                    f"quantity >= 0 — the schedule is ignored"))
            return None
        out.append(n)
    return out


def _apply_row_demand_overrides(
    row_spec: dict[tuple[str, str], dict[str, Any]], policies: dict,
    tally: "_SourceTally", w: list[MappingWarning],
    all_rows: set[tuple[str, str]] = frozenset(),
) -> dict[tuple[str, str], dict[str, Any]]:
    """The Customer stage's demand cells (PLAN.md §24 WP 14.2): an override on
    `node:<customer>::<product>` (family `demand`) beats the row's uploaded spec,
    field by field — override → data → the product's distribution × share.

    Records each row's resolved value and source on `tally` (page-equals-run)
    ONLY when the project specifies demand on some row, by data or override: a
    project that sets none maps, and logs, exactly as before Phase 14.
    """
    overrides: dict[tuple[str, str], dict[str, Any]] = {}
    for key in sorted(k for k in policies if isinstance(k, str) and k.startswith("node:")):
        patch = (policies.get(key) or {}).get("demand") or {}
        if not isinstance(patch, dict) or not any(
                f in patch for f in (*_ROW_OVERRIDE_FIELD, "row_demand_mode", "row_demand_schedule")):
            continue
        cid, sep, pid = key[len("node:"):].partition("::")
        if not sep or not cid or not pid:
            continue
        overrides[(pid, cid)] = patch
    if not overrides and not row_spec:
        return row_spec

    out = {k: dict(v) for k, v in row_spec.items()}
    # Only rows that EXIST: a `node:<a>::<b>` key from another stage (a Plant row
    # `<plant>::<product>`) must not invent a customer called `<plant>`.
    keys = set(out) | set(all_rows)
    for pid, cid in sorted(keys):
        ent = f"customer_row:{cid}::{pid}"
        spec = out.get((pid, cid), {})
        data_spec = dict(spec)
        patch = overrides.get((pid, cid), {})
        src: dict[str, str] = {}
        # Each key read as a literal, so the D90 gate sees the reader.
        reads = {
            "row_demand_distribution": patch.get("row_demand_distribution"),
            "row_demand_mean": patch.get("row_demand_mean"),
            "row_demand_variation": patch.get("row_demand_variation"),
            "row_demand_min": patch.get("row_demand_min"),
            "row_demand_max": patch.get("row_demand_max"),
        }
        for bkey, v in reads.items():
            field = _ROW_OVERRIDE_FIELD[bkey]
            if v in (None, ""):
                continue
            if bkey == "row_demand_distribution":
                kind = _ROW_KIND.get(str(v).strip().lower().replace("-", "_").replace(" ", "_"))
                if kind is None:
                    w.append(MappingWarning("warn", ent, bkey,
                                            f"/policies override {v!r} is not a distribution — "
                                            f"ignored, the row's data decides"))
                    continue
                spec[field] = kind
            else:
                n = _override_num(v, entity=ent, field=bkey, domain="nonnegative", w=w)
                if n is None:
                    continue
                spec[field] = n
            src[field] = "override"
        mode = patch.get("row_demand_mode")
        schedule = _row_schedule(patch.get("row_demand_schedule"), ent, w)
        if mode == "schedule" and schedule is None:
            w.append(MappingWarning("warn", ent, "row_demand_mode",
                                    "/policies sets this row to a requested delivery schedule, "
                                    "and none is entered — the row keeps its forecast or model"))
        if schedule is not None and mode in (None, "", "schedule"):
            # The requested delivery schedule IS the row's demand: firm, so no
            # spread around it, and nothing past its end.
            for f in ("demand_variation", "demand_min", "demand_max"):
                spec.pop(f, None)
            spec.update(demand_model="deterministic", forecast=schedule, demand_mean=0.0)
            for f in _ROW_OVERRIDE_FIELD.values():
                src[f] = "override"
        elif mode == "model" and spec.get("forecast") is not None:
            spec.pop("forecast")
            if spec.get("demand_model") is None:
                spec["demand_model"] = "deterministic"
        elif mode == "forecast" and spec.get("forecast") is None:
            w.append(MappingWarning("warn", ent, "row_demand_mode",
                                    "/policies sets this row to its forecast, and it has none "
                                    "uploaded — the row plans on its mean"))
        if spec:
            out[(pid, cid)] = spec
        rid = f"{cid}::{pid}"
        for rfield, field in _ROW_RESOLVED.items():
            source = src.get(field) or ("master" if data_spec.get(field) is not None else "default")
            tally.add(rfield, source, rid)
            tally.value(rfield, rid, spec.get(field))
    return out


# ── Main entry point ──────────────────────────────────────────────────────────

def from_project_data(data: ProjectData) -> MappingResult:
    """Map a project's stored data into an scsim Scenario + mapping warnings.

    Implements the canonical reducers/units/defaults of
    ``docs/data-simulation-mapping.md``. Pure and deterministic.
    """
    w: list[MappingWarning] = []
    sc = data.scenario

    mat_ids = {m.id for m in data.materials}

    # §4 D174 — a master product consumed by another product is a SUB-ASSEMBLY,
    # not a finished product. The BOM flatten models it through its components
    # (root→leaf arcs), so a ProductRow for it would reach `Network` with an
    # empty BoM and the engine would refuse the whole project — which is what
    # the 2026-09-23 acceptance audit hit with the canonical sub-assembly
    # dataset. Excluded here, and SAID: info when the exclusion is pure
    # modeling, warn when the sub-assembly also ships (its own outbound demand
    # is then not simulated, and silence about that would be a T2 breach).
    if data.subassemblies:
        sub = set(data.subassemblies)
        shipping = {o.product_id for o in data.outbound}
        for pid in sorted(sub):
            if pid in shipping:
                w.append(MappingWarning(
                    "warn", f"product:{pid}", "subassembly",
                    "consumed by another product — modeled through the BOM as a component; "
                    "its OWN outbound demand is not simulated (spare-parts demand on a "
                    "sub-assembly is not supported yet)"))
            else:
                w.append(MappingWarning(
                    "info", f"product:{pid}", "subassembly",
                    "consumed by another product — modeled through the BOM as a component, "
                    "not as a finished product"))
        if any(p.id in sub for p in data.products):
            data = replace(data, products=[p for p in data.products if p.id not in sub])

    prod_ids = {p.id for p in data.products}
    # Computed HERE rather than beside its `unsourced` check below, because the
    # arc loop needs it: a material the BOM consumes is part of this project
    # whether or not anyone gave it a master row (§4 D166).
    bom_mat_ids = {b.material_id for b in data.bom if b.product_id in prod_ids}
    sup_ids = {s.id for s in data.suppliers}

    # /policies overrides of item-master values (§23 WP 13.1): read once, here,
    # because the arc loop below already needs the MOQ.
    tally = _SourceTally()
    all_mat_ids = mat_ids | bom_mat_ids
    arc_sup_ids = sup_ids | {a.supplier_id for a in data.supply_arcs}
    row_cost = _supplier_row_values(data.policies, "sourcing", "material_cost", all_mat_ids, w)
    row_moq = _supplier_row_values(data.policies, "sourcing", "material_moq", all_mat_ids, w)
    row_on_hand = _supplier_row_values(data.policies, "inventory", "initial_on_hand", all_mat_ids, w)
    row_sup_cap = _supplier_values(data.policies, "sourcing", "capacity_per_week", arc_sup_ids, w)
    row_sup_rel = _supplier_values(data.policies, "sourcing", "reliability_score", arc_sup_ids, w)

    domains = {k["key"]: str(k["domain"]) for k in POLICY_BUNDLE_KEYS if k.get("master")}

    def _ovr(table: dict[str, Any], key: str, entity: str, bundle_key: str) -> Optional[float]:
        """The override of `bundle_key` for `key`, validated against its
        declared domain; None when there is none or it is unusable."""
        if key not in table:
            return None
        return _override_num(table[key], entity=entity, field=bundle_key,
                             domain=domains[bundle_key], w=w)

    moq_by_mat: dict[str, float] = {}
    for mid in sorted(all_mat_ids):
        mrow0 = next((m for m in data.materials if m.id == mid), None)
        ov = _ovr(row_moq, mid, f"material:{mid}", "material_moq")
        if ov is not None:
            moq_by_mat[mid] = ov
            tally.add("materials.moq", "override", mid)
        elif mrow0 is not None and mrow0.moq:
            moq_by_mat[mid] = float(mrow0.moq)
            tally.add("materials.moq", "master", mid)
        else:
            moq_by_mat[mid] = 0.0
            tally.add("materials.moq", "default", mid)

    # ── Supplier links (per supplier×material) + the materials.cost fallback ──
    # Duplicate (supplier, material) inbound rows are reduced to one link:
    # cheapest unit_price wins, ties broken by shortest lead time.
    #
    # Two per-material price reductions are accumulated here, and they are the
    # two data-derived steps of the `materials.cost` chain (the registry's
    # fallback_spec below declares them in this order):
    #
    #   volume_weighted_inbound_price — Σ(price × weekly volume) / Σ(weekly
    #     volume) over the material's arcs. The exact analogue of the
    #     demand-weighted outbound price that backs `products.sell_price`: a
    #     lane contributes at the rate the project actually buys through it,
    #     so a material quoted by three suppliers is valued at what it costs
    #     rather than at its cheapest quote.
    #   cheapest_inbound_price — min over the arcs. Reached only when NO arc
    #     of the material carries a positive volume, i.e. when there is no
    #     weight to average by.
    #
    # Both reduce over the RAW arcs rather than over `links_by_key`: the
    # platform graders (supabase/functions/_shared/grading.ts) see raw rows
    # and cannot dedupe, so reducing over the deduped links would make the
    # engine and every surface that predicts it disagree by construction. A
    # duplicate (supplier, material) row is extra volume quoted at its own
    # price, which is what the weighted mean should say.
    links_by_key: dict[tuple[str, str], SupplierLink] = {}
    cheapest_cost: dict[str, float] = {}
    vol_price_num: dict[str, float] = {}
    vol_price_den: dict[str, float] = {}
    mat_lt_dist = {m.id: m for m in data.materials}
    # The Supplier row's own lead time (`lead_time_weeks`), read per LANE: the
    # row key IS the arc, `node:<supplier>::<material>`, so it is looked up
    # exactly rather than split to an entity — an override on one supplier's
    # lane never moves another's. Validated once per lane, not once per
    # duplicate upload row.
    row_lead: dict[tuple[str, str], float] = {}
    for sup_id, mat_id in sorted({(a.supplier_id, a.material_id) for a in data.supply_arcs}):
        v = ((data.policies.get(f"node:{sup_id}::{mat_id}") or {}).get("sourcing") or {}).get("lead_time_weeks")
        if v in (None, ""):
            continue
        n = _override_num(v, entity=f"supply:{sup_id}->{mat_id}", field="lead_time_weeks",
                          domain=domains["lead_time_weeks"], w=w)
        if n is not None:
            row_lead[(sup_id, mat_id)] = n
    lt_source: dict[tuple[str, str], str] = {}
    # The Supplier row's lead-time SPREAD cells (§26 WP 16.2), per lane, read
    # exactly like `lead_time_weeks` above — each by its literal key so the D90
    # gate sees the reads.
    row_sourcing: dict[tuple[str, str], dict[str, Any]] = {}
    for sup_id, mat_id in sorted({(a.supplier_id, a.material_id) for a in data.supply_arcs}):
        patch = (data.policies.get(f"node:{sup_id}::{mat_id}") or {}).get("sourcing") or {}
        picked = {
            "lane_lead_time_dist": patch.get("lane_lead_time_dist"),
            "lane_lead_time_cv": patch.get("lane_lead_time_cv"),
            "lane_lead_time_min_weeks": patch.get("lane_lead_time_min_weeks"),
            "lane_lead_time_mode_weeks": patch.get("lane_lead_time_mode_weeks"),
            "lane_lead_time_max_weeks": patch.get("lane_lead_time_max_weeks"),
        }
        picked = {k: v for k, v in picked.items() if v not in (None, "")}
        if picked:
            row_sourcing[(sup_id, mat_id)] = picked
    spread_source: dict[tuple[str, str], dict[str, tuple[str, Any]]] = {}
    for arc in data.supply_arcs:
        # A master row is not what makes a material real — the BOM is. An arc
        # whose material the BOM consumes counts even with no row in
        # `materials`, which is what makes the BOM-only branch below reachable
        # (§4 D166). An arc for a material NOTHING consumes is still noise and
        # is still dropped.
        if arc.material_id not in mat_ids and arc.material_id not in bom_mat_ids:
            continue
        sup_ids.add(arc.supplier_id)
        cost = float(arc.unit_price or 0.0)
        if cost <= 0:
            cost = 1.0
            w.append(MappingWarning("warn", f"supply:{arc.supplier_id}->{arc.material_id}",
                                    "cost", "missing inbound unit_price → defaulted to 1.0"))
        # Lead times are weeks; time_unit describes the volume period only
        # (§3). With lead_time_unit unset, _duration_to_weeks defaults to a
        # 7-day basis → the value is taken as weeks verbatim.
        # Order: the /policies row → the uploaded lane → 2 weeks.
        key = (arc.supplier_id, arc.material_id)
        lt_unit = arc.lead_time_unit
        if key in row_lead:
            lt_weeks, lt_src = row_lead[key], "override"
        elif arc.lead_time:
            lt_weeks, lt_src = _duration_to_weeks(arc.lead_time, lt_unit), "master"
        else:
            lt_weeks, lt_src = 2.0, "default"
            w.append(MappingWarning("warn", f"supply:{arc.supplier_id}->{arc.material_id}",
                                    "lead_time", "missing lead_time → defaulted to 2 weeks"))
        mrow = mat_lt_dist.get(arc.material_id)
        # The lane's SHAPE (PLAN.md §26 WP 16.2): the row → the lane's upload →
        # the material → deterministic. A bounded shape fixes the planning lead
        # time at its bounds' mean, which then wins over the row's lead time.
        spread, planning_lt, spread_src = _lane_lead_time_spread(
            arc, mrow, row_sourcing.get(key, {}), w)
        if planning_lt is not None:
            if lt_src == "override":
                w.append(MappingWarning(
                    "info", f"supply:{arc.supplier_id}->{arc.material_id}", "lead_time_weeks",
                    f"the row's lead time is not read on a {spread['lead_time_dist'].value} lane — "
                    f"its planning lead time is the bounds' mean, {planning_lt:g} wk"))
            lt_weeks, lt_src = planning_lt, "derived"
        link = SupplierLink(
            supplier_id=arc.supplier_id, material_id=arc.material_id,
            cost=cost, lead_time_weeks=int(_clamp(
                round(lt_weeks), 1, 51, w=w, field="lead_time", unit=" wk",
                entity=f"supply:{arc.supplier_id}->{arc.material_id}")),
            moq=moq_by_mat.get(arc.material_id, 0.0),
            **spread,
        )
        prev = links_by_key.get(key)
        if prev is None:
            links_by_key[key] = link
            lt_source[key] = lt_src
            spread_source[key] = spread_src
        else:
            w.append(MappingWarning("warn", f"supply:{arc.supplier_id}->{arc.material_id}",
                                    "duplicate_arc",
                                    "duplicate (supplier, material) inbound rows → kept "
                                    "cheapest unit_price (tie: shortest lead time)"))
            if (link.cost, link.lead_time_weeks) < (prev.cost, prev.lead_time_weeks):
                links_by_key[key] = link
                lt_source[key] = lt_src
                spread_source[key] = spread_src
        cheapest_cost[arc.material_id] = min(cheapest_cost.get(arc.material_id, cost), cost)
        # `time_unit` describes the VOLUME period (§3), so the weight is a
        # weekly rate. A zero/absent/negative volume is no weight at all
        # rather than an epsilon one: the lane is excluded from the mean, and
        # a material with no weighted lane at all falls through to cheapest.
        weekly_vol = _rate_to_weekly(float(arc.volume or 0.0), arc.time_unit)
        if weekly_vol > 0:
            vol_price_num[arc.material_id] = vol_price_num.get(arc.material_id, 0.0) + cost * weekly_vol
            vol_price_den[arc.material_id] = vol_price_den.get(arc.material_id, 0.0) + weekly_vol

    def _inbound_cost(material_id: str) -> Optional[tuple[float, str]]:
        """The material's inbound-derived cost and the reducer that derived it.

        `None` when the material has no inbound arc at all — the caller then
        applies the terminal 1.0 and warns. Mirrored by
        `volume_weighted_inbound_price` / `cheapest_inbound_price` in
        supabase/functions/_shared/grading.ts.
        """
        den = vol_price_den.get(material_id, 0.0)
        if den > 0:
            return vol_price_num[material_id] / den, "volume_weighted_inbound_price"
        if material_id in cheapest_cost:
            return cheapest_cost[material_id], "cheapest_inbound_price"
        return None

    links = list(links_by_key.values())
    # Each lane's lead time as the link carries it, with its source — what the
    # Supplier grid's lead-time cell must show (page-equals-run). Counted in the
    # run log only when some lane takes the /policies value, so a project that
    # overrides none logs exactly as before the key existed.
    any_lead_override = "override" in lt_source.values()
    # The spread is counted only when some lane states one of its own (row or
    # upload), so a project that sets none logs exactly as before Phase 16.
    any_spread = any(sv[0] in ("override", "master")
                     for srcs in spread_source.values() for sv in srcs.values())
    for (sup_id, mat_id), link in sorted(links_by_key.items()):
        lane = f"{sup_id}::{mat_id}"
        tally.add("inbound_logistics.lead_time", lt_source[(sup_id, mat_id)], lane,
                  count=any_lead_override)
        tally.value("inbound_logistics.lead_time", lane, link.lead_time_weeks)
        srcs = spread_source.get((sup_id, mat_id), {})
        for field in ("lead_time_dist", "lead_time_cv", "lead_time_min", "lead_time_mode",
                      "lead_time_max"):
            source, val = srcs.get(field, ("default", None))
            tally.add(f"inbound_logistics.{field}", source, lane, count=any_spread)
            tally.value(f"inbound_logistics.{field}", lane, val)
    _apply_primary_choice(links, data.policies, w)
    backup_links, backup_sups = _scenario_backup_links(
        (data.policies.get("default") or {}).get("recovery") or {}, links, w)
    links.extend(backup_links)
    sup_ids.update(backup_sups)

    # BOM materials with no source link cannot be simulated. Since D166 this
    # says what it always claimed: a material here has NO inbound arc at all,
    # rather than merely no master row.
    unsourced = bom_mat_ids - cheapest_cost.keys()
    if unsourced:
        raise ValueError(f"materials with no supplier link: {sorted(unsourced)}")

    # ── Demand-weighted product price + weekly demand from outbound ──
    out_price_num: dict[str, float] = {}
    out_price_den: dict[str, float] = {}
    out_demand: dict[str, float] = {}
    customers: set[str] = set(data.customers)
    cust_share: dict[tuple[str, str], float] = {}  # (product, customer) → weekly volume
    row_spec: dict[tuple[str, str], dict[str, Any]] = {}  # WP 14.1: the row's demand spec
    row_price: dict[tuple[str, str], float] = {}  # WP 14.3: the row's own unit price
    for o in data.outbound:
        customers.add(o.customer_id)
        if o.unit_price is not None and float(o.unit_price) > 0:
            row_price[(o.product_id, o.customer_id)] = float(o.unit_price)
        weekly = _rate_to_weekly(float(o.volume or 0.0), o.time_unit)
        out_demand[o.product_id] = out_demand.get(o.product_id, 0.0) + weekly
        key = (o.product_id, o.customer_id)
        spec = _row_demand_spec(o, w)
        if spec is not None:
            if key in row_spec:
                w.append(MappingWarning(
                    "warn", f"customer_row:{o.customer_id}::{o.product_id}", "demand_distribution",
                    "two outbound rows for this customer × product both carry a demand spec — "
                    "the first is used"))
            else:
                row_spec[key] = spec
        if weekly > 0:
            cust_share[key] = cust_share.get(key, 0.0) + weekly
        if o.unit_price:
            wgt = max(weekly, 1e-9)
            out_price_num[o.product_id] = out_price_num.get(o.product_id, 0.0) + float(o.unit_price) * wgt
            out_price_den[o.product_id] = out_price_den.get(o.product_id, 0.0) + wgt

    # WP 14.2 — /policies Customer-row overrides of the row's demand spec.
    row_spec = _apply_row_demand_overrides(row_spec, data.policies, tally, w,
                                           all_rows=set(cust_share) | set(row_spec))

    # ── Suppliers ──
    sup_master = {s.id: s for s in data.suppliers}

    def _sup_capacity(sid: str) -> Optional[float]:
        ov = _ovr(row_sup_cap, sid, f"supplier:{sid}", "capacity_per_week")
        if ov is not None:
            tally.add("suppliers.capacity_per_week", "override", sid)
            return ov
        cap = sup_master[sid].capacity_per_week if sid in sup_master else None
        # An empty master capacity MEANS unlimited (the registry's `empty_means`),
        # so it is the master answering, not a default standing in.
        tally.add("suppliers.capacity_per_week", "master" if sid in sup_master else "default", sid)
        return cap

    def _sup_reliability(sid: str) -> float:
        ov = _ovr(row_sup_rel, sid, f"supplier:{sid}", "reliability_score")
        if ov is not None:
            tally.add("suppliers.reliability_score", "override", sid)
            return ov
        # An EMPTY master value is the declared default (1.0), and a stated 0 is
        # the master's 0 — before §23 WP 13.4 both read as "master 1.0", which is
        # what the grid's empty cell did not show (page-equals-run).
        rel = sup_master[sid].reliability_score if sid in sup_master else None
        if rel is None:
            tally.add("suppliers.reliability_score", "default", sid)
            return 1.0
        tally.add("suppliers.reliability_score", "master", sid)
        return float(rel)

    suppliers = [
        Supplier(
            id=sid,
            name=str((sup_master.get(sid) or SupplierRow(sid)).name or sid),
            capacity_per_week=_sup_capacity(sid),
            reliability_score=_sup_reliability(sid),
        )
        if sid not in backup_sups else
        # A supplier only a scenario's entered backup names: its capacity is the
        # one entered beside it (blank = unlimited), its reliability the default.
        Supplier(id=sid, name=backup_sups[sid]["name"],
                 capacity_per_week=backup_sups[sid]["capacity_per_week"])
        for sid in sorted(sup_ids)
    ]
    cap_by_sup = {s.id: s.capacity_per_week for s in suppliers}

    # ── Materials ──
    # Holding % set on a /policies Supplier-stage row is the user's value for
    # that material and beats the master (§4 D204): the item masters are the
    # base layer, /policies overrides them.
    row_holding = _supplier_row_values(
        data.policies, "inventory", "holding_cost_pct",
        {m.id for m in data.materials} | bom_mat_ids, w)
    materials: list[Material] = []
    def _on_hand(mid: str, master: Optional[float]) -> Optional[float]:
        ov = _ovr(row_on_hand, mid, f"material:{mid}", "initial_on_hand")
        if ov is not None:
            tally.add("materials.initial_on_hand", "override", mid)
            return ov
        tally.add("materials.initial_on_hand", "master" if master is not None else "default", mid)
        return float(master) if master is not None else None

    for m in data.materials:
        inv = _merged_policy(data.policies, m.id, "inventory")
        cost_ov = _ovr(row_cost, m.id, f"material:{m.id}", "material_cost")
        if cost_ov is not None:
            cost = cost_ov
            tally.add("materials.cost", "override", m.id)
        elif m.cost and m.cost > 0:
            cost = float(m.cost)
            tally.add("materials.cost", "master", m.id)
        elif (derived := _inbound_cost(m.id)) is not None:
            cost, via = derived
            tally.add("materials.cost", "lanes", m.id)
            w.append(MappingWarning(
                "info", f"material:{m.id}", "cost",
                "no master cost → using volume-weighted inbound price"
                if via == "volume_weighted_inbound_price"
                else "no master cost and no inbound volumes → using cheapest supplier price"))
        else:
            cost = 1.0
            tally.add("materials.cost", "default", m.id)
            w.append(MappingWarning("warn", f"material:{m.id}", "cost",
                                    "no master cost and no supplier price → defaulted to 1.0"))
        hold_pct = (row_holding[m.id] if m.id in row_holding
                    else m.holding_cost_pct if m.holding_cost_pct is not None
                    else inv.get("holding_cost_pct"))
        holding = _clamp(float(hold_pct) * 100.0, 5.0, 50.0, w=w, entity=f"material:{m.id}",
                         field="holding_cost_pct", unit=" %/yr") \
            if hold_pct is not None else 20.0
        materials.append(Material(
            id=m.id, name=str(m.name or m.id), cost=cost, holding_cost_rate=holding,
            initial_on_hand=_on_hand(m.id, m.initial_on_hand),
        ))
    # Materials the BOM consumes that have no master row. REACHABLE since §4
    # D166 — before it, the arc filter above dropped their arcs, so the
    # `unsourced` check raised first and this loop could only ever see an empty
    # set. Same chain as above: a row with no master cannot have a master cost,
    # so the fallback is all it has, and every such material is NAMED rather
    # than quietly materialized (T1 — no number without a source).
    for mid in sorted(bom_mat_ids - {m.id for m in materials}):
        cost_ov = _ovr(row_cost, mid, f"material:{mid}", "material_cost")
        derived = None if cost_ov is not None else _inbound_cost(mid)
        cost = cost_ov if cost_ov is not None else derived[0] if derived else 1.0
        tally.add("materials.cost",
                  "override" if cost_ov is not None else "lanes" if derived else "default", mid)
        w.append(MappingWarning(
            "info", f"material:{mid}", "master_row",
            "no row in `materials` — simulated from its BOM and inbound lanes, cost "
            + ("the /policies override" if cost_ov is not None
               else "derived from those lanes" if derived else "defaulted to 1.0")
            + "; MOQ, initial stock and holding cost take the Supplier-stage value when "
            "one is set, else the engine default; the lead-time distribution takes the "
            "engine default"))
        kw: dict[str, Any] = {}
        if mid in row_holding:  # the /policies value needs no master row (§4 D204)
            kw["holding_cost_rate"] = _clamp(
                float(row_holding[mid]) * 100.0, 5.0, 50.0, w=w,
                entity=f"material:{mid}", field="holding_cost_pct", unit=" %/yr")
        on_hand = _on_hand(mid, None)
        if on_hand is not None:
            kw["initial_on_hand"] = on_hand
        materials.append(Material(id=mid, name=mid, cost=cost, **kw))

    # ── Products ──
    # The plant grid keys its production overrides "<focal plant>::<product>",
    # so the composite index is what makes a per-row line-capacity edit reach
    # the engine at all; the bare "node:<product>" form still wins nothing and
    # loses nothing (§4 D75).
    prod_composite = _composite_patches(
        data.policies, "production", prod_ids, w,
        exclude=frozenset(f"{cid}::{pid}" for pid, cid in set(cust_share) | set(row_spec)))
    products: list[Product] = []
    product_modes: set[FulfillmentMode] = set()
    for p in data.products:
        prod_pol = {**_merged_policy(data.policies, p.id, "production"),
                    **prod_composite.get(p.id, {})}
        # The Plant-stage row's overrides of the product master (§23 WP 13.1) —
        # NODE scope only, the bare and the composite key, composite last: a
        # project-default `production` family is not a value for one product.
        prod_row = {**(((data.policies.get(f"node:{p.id}") or {}).get("production")) or {}),
                    **prod_composite.get(p.id, {})}
        ent = f"product:{p.id}"
        # price
        price_ov = _ovr(prod_row, "sell_price", ent, "sell_price")
        if price_ov is not None:
            price = price_ov
            tally.add("products.sell_price", "override", p.id)
        elif p.sell_price and p.sell_price > 0:
            price = float(p.sell_price)
            tally.add("products.sell_price", "master", p.id)
        elif out_price_den.get(p.id):
            price = out_price_num[p.id] / out_price_den[p.id]
            tally.add("products.sell_price", "lanes", p.id)
            w.append(MappingWarning("info", f"product:{p.id}", "unit_price",
                                    "no master sell_price → demand-weighted outbound price"))
        else:
            price = 1.0
            tally.add("products.sell_price", "default", p.id)
            w.append(MappingWarning("warn", f"product:{p.id}", "unit_price",
                                    "no sell_price and no outbound price → defaulted to 1.0"))
        # demand mean — the item master, then the lanes. DEMAND IS AUTHORED ON
        # THE CUSTOMER ROWS (WP 14.2): this product-level value is only what a
        # row with no demand of its own inherits (× its volume share). A
        # Plant-row demand override was a second author of the same fact and is
        # no longer read (§24 WP 14.8, §4 D286); one saved earlier is named.
        for stale in ("demand_mean", "demand_cv"):
            if prod_row.get(stale) not in (None, ""):
                w.append(MappingWarning(
                    "warn", ent, stale,
                    f"a /policies Plant-row {stale} override ({prod_row.get(stale)!r}) is no "
                    f"longer read — demand is set per Customer row; the item master, then "
                    f"the outbound volume, decides the product's fallback"))
        if p.demand_mean and p.demand_mean > 0:
            mean = float(p.demand_mean)
            tally.add("products.demand_mean", "master", p.id)
        else:
            mean = out_demand.get(p.id, 0.0)
            tally.add("products.demand_mean", "lanes" if mean > 0 else "default", p.id)
            if mean <= 0:
                w.append(MappingWarning("warn", f"product:{p.id}", "demand_mean",
                                        "no master demand_mean and no outbound volume → 0"))
        # capacity — the /policies override, then the master (units/week), then
        # the plant grid's line capacity (units/day); say so rather than
        # dropping a line-capacity edit silently.
        line_cap = prod_pol.get("capacity_units_per_day")
        cap_ov = _ovr(prod_row, "production_capacity", ent, "production_capacity")
        if cap_ov is not None or (p.production_capacity and p.production_capacity > 0):
            cap = cap_ov if cap_ov is not None else float(p.production_capacity)
            tally.add("products.production_capacity",
                      "override" if cap_ov is not None else "master", p.id)
            if line_cap:
                w.append(MappingWarning("info", f"product:{p.id}", "production_capacity",
                                        "production_capacity (units/week, "
                                        + ("the /policies override" if cap_ov is not None
                                           else "the item master")
                                        + ") shadows the plant grid's line capacity "
                                        "(units/day) — the line capacity entry is not applied"))
        elif line_cap:
            util_raw = prod_pol.get("utilization_cap_pct")
            if util_raw is None:
                w.append(MappingWarning("info", f"product:{p.id}", "utilization_cap_pct",
                                        "production policy sets no utilization cap → 85%"))
            util = float(85.0 if util_raw is None else util_raw) / 100.0
            cap = float(line_cap) * 7.0 * util
            tally.add("products.production_capacity", "derived", p.id)
            w.append(MappingWarning("info", f"product:{p.id}", "production_capacity",
                                    "no master capacity → derived from production policy"))
        else:
            cap = max(mean * 2.0, 1000.0)
            tally.add("products.production_capacity", "default", p.id)
            w.append(MappingWarning("warn", f"product:{p.id}", "production_capacity",
                                    "no capacity source → defaulted (capacity will not bind)"))
        mode = _resolve_mode(p, prod_row, data.project_model, tally, w)
        product_modes.add(mode)
        if p.demand_cv is not None:
            cv = float(p.demand_cv)
            tally.add("products.demand_cv", "master", p.id)
        else:
            cv = (float((sc.demand_model or {}).get("cv"))
                  if (sc.demand_model or {}).get("cv") is not None else _DEFAULT_CV)
            tally.add("products.demand_cv", "default", p.id)
        tally.value("products.demand_mean", p.id, mean)
        tally.value("products.demand_cv", p.id, cv)
        kind = _resolve_demand_kind(p.demand_distribution, sc.demand_model)
        # Each FG override read as a literal, so the D90 gate sees the reader.
        fg = _resolve_fg(p.id, p, prod_row, {
            "fg_base_stock": _ovr(prod_row, "fg_base_stock", ent, "fg_base_stock"),
            "fg_reorder_point": _ovr(prod_row, "fg_reorder_point", ent, "fg_reorder_point"),
            "fg_cover_days": _ovr(prod_row, "fg_cover_days", ent, "fg_cover_days"),
            "fg_initial_on_hand": _ovr(prod_row, "fg_initial_on_hand", ent, "fg_initial_on_hand"),
        }, tally, w)
        if mode != FulfillmentMode.MTS and any(fg[k] is not None for k in fg if k != "fg_policy"):
            w.append(MappingWarning("info", f"product:{p.id}", "fg_policy",
                                    "FG policy / levels are set but the product is MTO — an MTO "
                                    "product holds no finished-goods stock, so they are not read"))
        # P-P.13 (§26 WP 16.5) — each override read as a literal (the D90 gate).
        plt = _product_lead_time(p, {
            "prod_lead_time_weeks": prod_row.get("prod_lead_time_weeks"),
            "prod_lead_time_dist": prod_row.get("prod_lead_time_dist"),
            "prod_lead_time_cv": prod_row.get("prod_lead_time_cv"),
            "prod_lead_time_min_weeks": prod_row.get("prod_lead_time_min_weeks"),
            "prod_lead_time_mode_weeks": prod_row.get("prod_lead_time_mode_weeks"),
            "prod_lead_time_max_weeks": prod_row.get("prod_lead_time_max_weeks"),
        }, tally, w)
        products.append(_build_product(p, price=price, capacity=cap, mode=mode,
                                       mean=mean, cv=cv, kind=kind, warnings=w, fg=fg,
                                       production_lead_time=plt))
    if not products:
        raise ValueError("project has no products to simulate")

    bom = [BomLine(product_id=b.product_id, material_id=b.material_id,
                   rate=float(b.consumption_rate or 1.0))
           for b in data.bom if b.product_id in {p.id for p in products}]
    if not bom:
        # Fail with a diagnosis instead of pydantic's opaque "bom too_short":
        # either the project has no BOM rows at all, or none of its BOM
        # product ids match a product master (for multi-level BOMs the
        # flattened roots must be the outbound/finished products).
        raise ValueError(
            "no usable BOM arcs: the project's BOM is empty or its product ids "
            f"match none of the {len(products)} product(s) — upload a BOM whose "
            "top level is the finished product"
        )

    prod_ids = {p.id for p in products}
    # WP 14.3 — the row's price: the Customer row's `price` override → the
    # outbound row's unit price → its product's (engine default). Read by
    # `revenue_max` and by the per-row, per-customer fill rates.
    clinks = _customer_links(cust_share, row_spec, prod_ids, w)
    row_keys = frozenset(f"{cl.customer_id}::{cl.product_id}" for cl in clinks)
    count_price = str(((data.policies.get("default") or {}).get("fulfillment") or {})
                      .get("allocation") or "") == "revenue_max"
    price_by_prod = {p.id: p.unit_price for p in products}
    for i, cl in enumerate(clinks):
        rid = f"{cl.customer_id}::{cl.product_id}"
        patch = (data.policies.get(f"node:{rid}") or {}).get("fulfillment") or {}
        v = patch.get("price")
        n = (_override_num(v, entity=f"customer_row:{rid}", field="price", domain="positive", w=w)
             if v not in (None, "") else None)
        if n is not None:
            price, src = n, "override"
        elif (cl.product_id, cl.customer_id) in row_price:
            price, src = row_price[(cl.product_id, cl.customer_id)], "master"
        else:
            price, src = None, "default"
        if price is not None:
            clinks[i] = cl.model_copy(update={"unit_price": price})
        tally.add("outbound_logistics.unit_price", src, rid,
                  count=count_price or src == "override")
        tally.value("outbound_logistics.unit_price", rid,
                    price if price is not None else price_by_prod.get(cl.product_id))
    network = Network(
        suppliers=suppliers, materials=materials, products=products,
        bom=bom, supplier_links=links,
        customers=_build_customers(customers, data.customer_rows, w),
        customer_links=clinks,
    )

    settings = _build_settings(sc, w)
    events = _map_events(sc.disruption_schedule, sup_ids, cap_by_sup, w,
                         mat_ids={l.material_id for l in links})
    # The engine extends replications under a sequential-CI rule only when the
    # scenario HAS events (`run_scenario` gates on `scenario.events`). A baseline
    # scenario with that rule ran its fixed count and said nothing (audit F-32).
    if (settings.replication_stopping == ReplicationStopping.SEQUENTIAL_CI
            and not events):
        w.append(MappingWarning(
            "warn", "scenario", "stopping_rule",
            f"sequential-CI stopping applies to disrupted scenarios only — this one has "
            f"no disruptions, so it ran a fixed {settings.model_seeds} replications"))
    sups_by_mat: dict[str, set[str]] = {}
    for link in links:
        sups_by_mat.setdefault(link.material_id, set()).add(link.supplier_id)
    policies = _map_policies(data.policies, w, n_customers=len(customers),
                             sups_by_mat=sups_by_mat,
                             has_mts=(FulfillmentMode.MTS in product_modes),
                             prod_ids=prod_ids, row_keys=row_keys, tally=tally,
                             row_masters={c.id: {"priority_weight": c.priority_weight,
                                                 "sla_fill_floor_pct": c.sla_fill_floor_pct}
                                          for c in data.customer_rows if c.id})
    # A buffer window for a material this project does not simulate holds nothing.
    sim_mats = {m.id for m in network.materials}
    ss_windows = (policies.get("safety_stock_materials") or {}).get("windows") or []
    unknown_win = sorted({wd["material_id"] for wd in ss_windows} - sim_mats)
    if unknown_win:
        w.append(MappingWarning(
            "warn", "policy:safety_stock_materials", "windows",
            f"{len(unknown_win)} buffer window(s) name a material this project does not "
            f"simulate, so they hold nothing: {unknown_win[:5]}"))

    # Every override the user typed should reach SOME entity. A key whose
    # components name no supplier, material, product or customer joins
    # nothing in any family — the shape of §4 D75, caught here generically
    # so the next stage to invent a target-key spelling is not silent.
    known = prod_ids | mat_ids | sup_ids | customers
    orphan_keys = sorted(
        k for k in data.policies
        if isinstance(k, str) and k.startswith("node:")
        and not (set(k[len("node:"):].split("::")) & known)
    )
    if orphan_keys:
        shown = ", ".join(orphan_keys[:5]) + ("…" if len(orphan_keys) > 5 else "")
        w.append(MappingWarning(
            "warn", "policy:overrides", "target_key",
            f"{len(orphan_keys)} policy override(s) name no supplier, material, "
            f"product or customer in this project and were not applied: {shown}"))

    tally.emit(w)
    # The value each master-backed entity field was given, beside its source.
    for mat in materials:
        tally.value("materials.cost", mat.id, mat.cost)
        tally.value("materials.initial_on_hand", mat.id, mat.initial_on_hand)
    for mid, moq in moq_by_mat.items():
        tally.value("materials.moq", mid, moq)
    for sup in suppliers:
        tally.value("suppliers.capacity_per_week", sup.id, sup.capacity_per_week)
        tally.value("suppliers.reliability_score", sup.id, sup.reliability_score)
    for prod in products:
        tally.value("products.sell_price", prod.id, prod.unit_price)
        tally.value("products.production_capacity", prod.id, prod.production_capacity)
    scenario = Scenario(name=sc.name or "scenario", network=network,
                        settings=settings, events=events, policies=policies)
    return MappingResult(scenario=scenario, warnings=w, resolved=tally.by_entity)


# ── The run window — ONE author, exported (audit 2026-09-22, F-02) ─────────────
#
# The Run-window card printed `horizon − warm-up` days as "measured" while the
# engine measured a fixed 52-week window after warm-up: 987 days claimed, 364
# measured, at the shipped defaults. The decision (§16 · audit WP 2) is to keep
# the engine's window and make the card print IT — so the rule lives here once,
# and `registry_export.run_window_rule()` hands it to the UI through
# `registry.generated.json`. Nothing in `src/` may restate 52.
HORIZON_WEEKS_FLOOR = 52
HORIZON_WEEKS_CEILING = 520
ANALYSIS_WINDOW_WEEKS = 52
ANALYSIS_WINDOW_MIN_WEEKS = 13
ANALYSIS_WINDOW_MAX_WEEKS = 156
ANALYSIS_WINDOW_TAIL_WEEKS = 13  # the horizon keeps this many weeks after the window


def analysis_window_weeks(horizon: int, w: list[MappingWarning]) -> int:
    """Weeks measured after warm-up. The engine then takes
    ``window_end = min(t_w + window, horizon)``, so a late warm-up can shorten it
    further at run time; that half is reported on the run, not here."""
    # The upper bound is a derived quantity, not a typed one; the clamp below is
    # what can change the window, and it says so.
    room = max(ANALYSIS_WINDOW_MIN_WEEKS, horizon - ANALYSIS_WINDOW_TAIL_WEEKS)
    hi = min(ANALYSIS_WINDOW_MAX_WEEKS, room)
    return int(_clamp(ANALYSIS_WINDOW_WEEKS, ANALYSIS_WINDOW_MIN_WEEKS, hi, w=w,
                      entity="scenario", field="analysis_window", unit=" wk", level="info"))


def _build_settings(sc: ScenarioSettings, w: list[MappingWarning]) -> SimulationSettings:
    # The horizon FLOOR stays `info`: raising a short horizon to one engine year
    # was always said. The ceiling was not, and is now `warn` like every other.
    horizon_weeks = round(sc.horizon_days / 7.0)
    horizon = int(_clamp(horizon_weeks, HORIZON_WEEKS_FLOOR, HORIZON_WEEKS_CEILING, w=w,
                         entity="scenario", field="horizon", unit=" wk",
                         level="info" if horizon_weeks < HORIZON_WEEKS_FLOOR else "warn"))
    ci_level = int(sc.ci_level) if sc.ci_level in (90, 95, 99) else 95
    if ci_level != sc.ci_level:
        w.append(MappingWarning("warn", "scenario", "ci_level",
                                f"{sc.ci_level}% is not a supported confidence level "
                                f"(90, 95, 99) → {ci_level}% used"))
    kwargs: dict[str, Any] = dict(
        project_seed=int(sc.seed), horizon=horizon,
        model_seeds=int(_clamp(sc.replications, 1, 200, w=w, entity="scenario",
                               field="replications")),
        crn_enabled=bool(sc.crn), ci_level=ci_level,
        analysis_window=analysis_window_weeks(horizon, w),
    )
    if str(sc.warmup_mode).lower() == "manual":
        kwargs["warmup_method"] = WarmupMethod.MANUAL
        kwargs["warmup_end"] = int(_clamp(round(sc.warmup_days / 7.0), 0, horizon // 2, w=w,
                                          entity="scenario", field="warmup", unit=" wk"))
    else:
        kwargs["warmup_method"] = WarmupMethod.MOST_CONSERVATIVE
    rule = (sc.stopping_rule or {}).get("kind", "")
    if str(rule) in ("sequential_ci", "sequential"):
        kwargs["replication_stopping"] = ReplicationStopping.SEQUENTIAL_CI
        eps = (sc.stopping_rule or {}).get("epsilon") or (sc.stopping_rule or {}).get("ci_halfwidth_target")
        if eps is not None:
            kwargs["ci_halfwidth_target"] = float(_clamp(
                float(eps), 0.01, 0.10, w=w, entity="scenario", field="stopping_rule.epsilon"))
    # Single-run inspection mode (G17): full-debug trace so the engine exposes
    # per-item weekly matrices. Strictly single-replication — per-item series
    # at multi-rep scale are deliberately never produced.
    if sc.inspection:
        if kwargs["model_seeds"] == 1:
            kwargs["trace_verbosity"] = TraceVerbosity.FULL_DEBUG
        else:
            w.append(MappingWarning(
                "warn", "scenario", "inspection",
                f"inspection mode requires exactly 1 replication "
                f"(got {kwargs['model_seeds']}) → ignored",
            ))
    return SimulationSettings(**kwargs)


# ── The disruption-event rule — ONE author, exported (WP 9.4, PLAN.md §4 D226) ──
#
# `_map_events` below is the only place a schedule becomes engine events. The Lab's
# event editor, the network pages' disruption dialog and the pre-run gate all need
# to say, BEFORE a run, which events the mapper will keep; they read these through
# `registry_export.disruption_rule()` rather than restating them, the way the run
# window is exported above. Nothing in `src/` may restate 5 or 52.
EVENT_CAP = 5                    # events beyond this many are dropped, with a warning
EVENT_START_WEEK_MIN = 1         # an event starts no earlier than the first week
EVENT_DURATION_WEEKS_MIN = 1
EVENT_DURATION_WEEKS_MAX = 52
# Target kinds the mapper names as "cannot be disrupted yet"; anything that is not
# a supplier id of the project, a supplied material (`material:<id>`, since 0.9.0 —
# PLAN.md §29 WP 19.1, §4 D311's platform half) or the plant is skipped too, with
# its own warning.
UNSUPPORTED_EVENT_KINDS = ("edge", "customer", "lane")
MATERIAL_EVENT_KIND = "material"


def _is_plant_target(raw: str, stripped: str) -> bool:
    """`plant:X`, `node:plant`, or bare `plant` address the (single) focal plant."""
    return raw.lower().startswith("plant:") or stripped.lower() == "plant"


def _map_events(
    schedule: list[dict], sup_ids: set[str], cap_by_sup: dict[str, Optional[float]],
    w: list[MappingWarning], mat_ids: Optional[set[str]] = None,
) -> list[DisruptionEvent]:
    """`mat_ids` are the materials with at least one supply link — the ones a
    `node:material` event can stop (the injector refuses any other)."""
    events: list[DisruptionEvent] = []
    mat_ids = mat_ids or set()
    for entry in schedule[:EVENT_CAP]:
        raw = str(entry.get("target", entry.get("target_id", "")))
        target = raw.rsplit(":", 1)[1] if ":" in raw else raw
        kind = raw.split(":", 1)[0].lower() if ":" in raw else ""
        if kind == MATERIAL_EVENT_KIND:
            # A full outage of every supply link of ONE material (WP 17.1): the
            # engine models lead-time extension only for a material, so a partial
            # cut runs as an outage and says so.
            if target not in mat_ids:
                w.append(MappingWarning("warn", f"event:{raw}", "target",
                                        f"no supplied material named {target!r} in this project's data — event skipped"))
                continue
            start_days = float(entry.get("start_day", entry.get("start_week", 0)) or 0)
            start_week = round(start_days) if "start_week" in entry else round(start_days / 7.0)
            dur_days = float(entry.get("duration_days", entry.get("duration_weeks", 6)) or 6)
            dur_weeks = round(dur_days) if "duration_weeks" in entry else round(dur_days / 7.0)
            magnitude = float(entry.get("magnitude_pct", entry.get("magnitude", 100.0)) or 100.0)
            if magnitude < 100.0:
                w.append(MappingWarning("warn", f"event:{raw}", "magnitude",
                                        f"{magnitude:.0f}% cut on a material runs as a full outage of its "
                                        f"supply — the engine cuts capacity per supplier, not per material"))
            events.append(DisruptionEvent(
                target_type=TargetType.NODE_MATERIAL, target_id=target,
                start=int(_clamp(int(start_week), EVENT_START_WEEK_MIN, float("inf"), w=w,
                                 entity=f"event:{raw}", field="start", unit=" wk")),
                duration=int(_clamp(dur_weeks, EVENT_DURATION_WEEKS_MIN, EVENT_DURATION_WEEKS_MAX,
                                    w=w, entity=f"event:{raw}", field="duration", unit=" wk")),
            ))
            continue
        is_plant = target not in sup_ids and _is_plant_target(raw, target)
        if target not in sup_ids and not is_plant:
            # Two different failures, said apart (acceptance audit 2026-09-23):
            # a target KIND the mapper cannot disrupt yet, versus a supplier id
            # this project simply does not have. The old single message blamed
            # "material/edge" even when the target was `supplier:primary`.
            if kind in UNSUPPORTED_EVENT_KINDS:
                w.append(MappingWarning("warn", f"event:{raw}", "target",
                                        f"{kind} targets cannot be disrupted yet (land later in M7) — event skipped"))
            else:
                w.append(MappingWarning("warn", f"event:{raw}", "target",
                                        f"no supplier or plant named {target!r} in this project's data — event skipped"))
            continue
        start_days = float(entry.get("start_day", entry.get("start_week", 0)) or 0)
        # 'start_week' already weeks; 'start_day' days
        start_week = round(start_days) if "start_week" in entry else round(start_days / 7.0)
        dur_days = float(entry.get("duration_days", entry.get("duration_weeks", 6)) or 6)
        dur_weeks = round(dur_days) if "duration_weeks" in entry else round(dur_days / 7.0)
        magnitude = float(entry.get("magnitude_pct", entry.get("magnitude", 100.0)) or 100.0)
        kwargs: dict[str, Any] = dict(
            target_type=TargetType.NODE_PLANT if is_plant else TargetType.NODE_SUPPLIER,
            target_id=target or "plant",
            start=int(_clamp(int(start_week), EVENT_START_WEEK_MIN, float("inf"), w=w,
                             entity=f"event:{raw}", field="start", unit=" wk")),
            duration=int(_clamp(dur_weeks, EVENT_DURATION_WEEKS_MIN, EVENT_DURATION_WEEKS_MAX,
                                w=w, entity=f"event:{raw}", field="duration", unit=" wk")),
        )
        if magnitude < 100.0:
            # Plant capacity is always finite (products carry production_capacity),
            # so a partial cut always throttles; suppliers need capacity_per_week.
            if is_plant or cap_by_sup.get(target) is not None:
                kwargs["effect_type"] = EffectType.CAPACITY_REDUCTION
                kwargs["capacity_factor"] = float(_clamp(
                    (100.0 - magnitude) / 100.0, 0.0, 0.999, w=w, entity=f"event:{target}",
                    field="magnitude", unit=" (remaining capacity share)"))
            else:
                w.append(MappingWarning("warn", f"event:{target}", "magnitude",
                                        f"{magnitude:.0f}% cut needs a finite supplier capacity — "
                                        f"mapped to a full lead-time-extension outage"))
        events.append(DisruptionEvent(**kwargs))
    if len(schedule) > EVENT_CAP:
        w.append(MappingWarning("warn", "scenario", "disruption_schedule",
                                f"{len(schedule) - EVENT_CAP} events beyond the {EVENT_CAP}-event cap dropped"))
    return events


_ALLOCATION_RULE = {  # UI fulfillment.allocation → P-C.2 rule (engineBridge.json mirror)
    "priority": "priority", "fair_share": "fair_share",
    "proportional": "proportional", "sla_tier": "sla_tier",
    # WP 14.3: real, by row price (the outbound row's unit price, else the product's).
    "revenue_max": "revenue_max",
}


def _node_override(policies: dict, key: str, family: str) -> dict:
    """Family patch of a `node:<target_key>` override, {} when absent."""
    return (policies.get(f"node:{key}") or {}).get(family) or {}


def _multi_sourcing_weights(
    policies: dict, sourcing: dict, sups_by_mat: dict[str, set[str]],
    w: list[MappingWarning],
) -> dict[str, dict[str, float]]:
    """Build P-S.2 ``weights[material][supplier] = share %`` from the UI's
    sourcing ratios: arc-level overrides (target_key ``supplier::material``)
    take precedence; project-level ``sourcing.ratios`` (supplier → fraction)
    spread to every multi-sourced material that supplier serves. Shares are
    renormalized to 100 per material — the plugin hard-errors otherwise."""
    weights: dict[str, dict[str, float]] = {}
    for key, families in policies.items():
        if not isinstance(key, str) or not key.startswith("node:") or "::" not in key:
            continue
        row_sup, _, mat = key[len("node:"):].partition("::")
        src = families.get("sourcing") or {}
        # Grid-friendly scalar: the row's own share of its material.
        scalar = src.get("supply_share")
        if scalar is not None and row_sup in sups_by_mat.get(mat, set()):
            weights.setdefault(mat, {})[row_sup] = float(scalar) * 100.0
        for sup, share in (src.get("ratios") or {}).items():
            if sup in sups_by_mat.get(mat, set()):
                weights.setdefault(mat, {})[str(sup)] = float(share) * 100.0
    for sup, share in (sourcing.get("ratios") or {}).items():
        for mat, sups in sups_by_mat.items():
            if sup in sups and len(sups) > 1:
                weights.setdefault(mat, {}).setdefault(str(sup), float(share) * 100.0)
    for mat, shares in list(weights.items()):
        total = sum(shares.values())
        if total <= 0:
            weights.pop(mat)
            continue
        if abs(total - 100.0) > 1e-6:
            w.append(MappingWarning(
                "info", "policy:proactive_multi_sourcing", "weights",
                f"sourcing shares for {mat!r} sum to {total:.0f}% — renormalized to 100%"))
            weights[mat] = {s: v * 100.0 / total for s, v in shares.items()}
    return weights


# Fulfillment fields the engine does NOT consume on a node row (P-C.1
# unmet_demand_handling + P-C.2 customer_allocation). A per-node override
# carrying any of these is not applied — warned rather than dropped silently (doc §6).
# (primary_source / sourcing_firm are firm-routing hints, never engine params, so
# they are deliberately excluded here and never trigger the warning.)
#
# Since WP 14.3 (PLAN.md §24, ADR 0002 decisions 4–5) the six `_FULFILLMENT_ROW`
# fields ARE consumed on a Customer row `node:<customer>::<product>` that names
# an existing row — backorder, its window and cost, and the row's priority,
# price and service target. The allocation RULE stays one per project.
_FULFILLMENT_DEFAULT_ONLY = frozenset({
    "backorder_allowed", "max_backorder_days", "backorder_cost_per_day",
    "lost_sales_cost_per_unit", "allocation", "tier_overrides",
    "service_level_alpha", "service_level_beta", "price",
    "row_priority", "sla_fill_floor_pct",
})
_FULFILLMENT_ROW = frozenset({
    "backorder_allowed", "max_backorder_days", "backorder_cost_per_day",
    "price", "row_priority", "sla_fill_floor_pct",
})

# The replenishment parameters a Supplier-stage row can carry, and which of them
# each engine policy type uses — the same sets the grid shows per type
# (`src/components/policies/policyGridUi.tsx` POLICY_PARAMS; `reorder_point` is
# the R of (R,Q)). MRP orders from the plan and uses none of them.
_TYPE_PARAMS = frozenset({
    "rop_q_quantity", "coverage_weeks", "reorder_point", "order_up_to",
    "periodic_review_weeks",
})
_TYPE_SHOWS: dict[str, frozenset[str]] = {
    "min_max": frozenset({"reorder_point", "order_up_to", "coverage_weeks"}),
    "base_stock": frozenset({"order_up_to", "coverage_weeks"}),
    # (R,Q) orders Q below R; κ sizes no (R,Q) level, so a stored κ is not read.
    "rop_q": frozenset({"rop_q_quantity", "reorder_point"}),
    "periodic": frozenset({"periodic_review_weeks", "order_up_to", "coverage_weeks"}),
    "mrp": frozenset(),
}


def _backorder_weeks(days: float, *, w: list["MappingWarning"], entity: str) -> int:
    """Max backorder DAYS → whole WEEKS, rounded HALF UP (3 → 0, 4 → 1, 10 → 1,
    11 → 2, 14 → 2), clamped to P-C.1's 0–26. One rule for the project default
    and every row (WP 14.3) — it was Python's banker's ``round`` until then,
    which differed only at a half week (3.5 days → 0, now 1)."""
    weeks = math.floor(float(days) / 7.0 + 0.5)
    return int(_clamp(weeks, 0, 26, w=w, entity=entity, field="max_backorder_days", unit=" wk"))


def _build_customers(
    ids: set[str], rows: list[CustomerRow], w: list[MappingWarning],
) -> list[Customer]:
    """Customer entities, with the attributes the `customers` table carries.

    ── WHAT THIS USED TO BE, AND WHY IT MATTERED (§4 D69) ────────────────────

        customers=[Customer(id=c, name=c) for c in sorted(customers)]

    The mapper never read the `customers` table. Every customer therefore
    arrived with the entity DEFAULTS — `segment="default"` and
    `priority_weight=1.0` — and two P-C.2 features were inert on every project:

      · `priority_weight` — `p_c2_customer_allocation` falls back to
        `Customer.priority_weight` when its `priority_weights` param does not
        name a customer, so the fallback was always 1.0 and the `priority`
        ordering could not order anything.
      · `segment` — worse, because it is silent in a second way. Every customer
        was in the segment `"default"`, so `sla_tiers`, which is keyed BY
        SEGMENT, matched nothing and every fill floor was 0.0. The engine
        already warned about this (`unknown_sla_segment` in P-C.2's
        feasibility), and the warning named the symptom while nothing named the
        cause: the segments it compared against were a constant.

    A user filling in a customer's priority or segment changed nothing, on every
    project, with no error. That is T1 — a displayed field that resolves to
    nothing — reaching all the way into the results.

    An id can legitimately have no row: the id set is the union of this table and
    the customer ids found on outbound arcs. Those keep the entity defaults, and
    say so, rather than being dropped.
    """
    by_id = {c.id: c for c in rows if c.id}
    unmatched = sorted(set(by_id) - ids)
    if unmatched:
        w.append(MappingWarning(
            "info", "customers", "customer_id",
            f"{len(unmatched)} customer row(s) describe ids that appear on no outbound "
            f"arc, so they have no demand to allocate: {unmatched[:5]}"))
    out: list[Customer] = []
    defaulted: list[str] = []
    for cid in sorted(ids):
        row = by_id.get(cid)
        if row is None:
            defaulted.append(cid)
            out.append(Customer(id=cid, name=cid))
            continue
        kwargs: dict[str, Any] = {"id": cid, "name": row.name or cid}
        # Only override an entity default when the table actually says something.
        # A NULL column is not a value, and writing `segment=None` would fail the
        # entity's own validation rather than fall back to "default".
        if row.segment:
            kwargs["segment"] = row.segment
        if row.priority_weight is not None:
            kwargs["priority_weight"] = float(row.priority_weight)
        if row.sla_fill_floor_pct is not None:
            kwargs["sla_fill_floor_pct"] = _clamp(
                float(row.sla_fill_floor_pct), 0.0, 100.0, w=w, entity=f"customer:{cid}",
                field="sla_fill_floor_pct", unit=" %")
        out.append(Customer(**kwargs))
    # ONLY WHEN THE COVERAGE IS PARTIAL, and the E1 gate is what settled that.
    #
    # The first draft warned whenever any customer fell back, including when the
    # table supplied NO rows at all — and `test_e1_fully_specified_project_has_no
    # _silent_fallbacks` failed, correctly. E1's rule is that a fully-specified
    # project maps with no residue, and a project with no customer master data is
    # fully specified: the table is optional, and today nothing in the product
    # writes it (§4 D94), so EVERY project would have carried this note.
    #
    # What is worth saying is that the table describes SOME of these customers
    # and not the rest — that is a gap in data somebody is actively maintaining.
    # An empty table is the documented baseline, not a fallback anybody chose.
    if defaulted and by_id:
        w.append(MappingWarning(
            "info", "customers", "segment",
            f"the `customers` table describes {len(ids) - len(defaulted)} of this "
            f"project's customers but not {len(defaulted)} other(s), which keep "
            f"the engine defaults "
            f"(segment=default, priority_weight=1.0): {defaulted[:5]}"))
    return out


def _map_policies(
    policies: dict, w: list[MappingWarning], n_customers: int = 0,
    sups_by_mat: Optional[dict[str, set[str]]] = None,
    has_mts: bool = False,
    prod_ids: Optional[set[str]] = None,
    row_keys: frozenset[str] = frozenset(),
    tally: Optional["_SourceTally"] = None,
    row_masters: Optional[dict[str, dict[str, Any]]] = None,
) -> dict[str, dict]:
    out: dict[str, dict] = {}
    default = policies.get("default") or {}
    inv = default.get("inventory") or {}
    fulfil = default.get("fulfillment") or {}
    sourcing = default.get("sourcing") or {}
    recovery = default.get("recovery") or {}
    sups_by_mat = sups_by_mat or {}

    # Surface per-node fulfillment overrides the engine will not apply: any of
    # these fields on a node that is not an existing Customer row, and the
    # project-only ones (the rule, tier floors, service levels) on any node.
    def _unread(k: str, fams: dict) -> bool:
        patch = fams.get("fulfillment") or {}
        is_row = k[len("node:"):] in row_keys
        return any(f in patch and (f not in _FULFILLMENT_ROW or not is_row)
                   for f in _FULFILLMENT_DEFAULT_ONLY)
    dropped_fulfil = sum(
        1 for k, fams in policies.items()
        if isinstance(k, str) and k.startswith("node:") and isinstance(fams, dict)
        and _unread(k, fams)
    )
    if dropped_fulfil:
        w.append(MappingWarning(
            "warn", "policy:unmet_demand_handling", "fulfillment",
            f"{dropped_fulfil} per-node fulfillment override(s) not applied — the allocation "
            "rule, tier floors and service levels are project-wide, and backorder, priority, "
            "price and service target apply on a Customer row only"))

    type_map = {
        "min_max": "min_max", "s_S": "min_max", "continuous_review": "min_max",
        "base_stock": "base_stock", "rop": "rop_q", "periodic_review": "periodic",
        "mrp": "mrp",  # WP 14.5 — ordered from the plan (design doc §3.4)
    }

    # Per-material replenishment overrides from the supplier grid. Its rows key
    # overrides as node:<supplier_id>::<material_id> (columnSpecs targetKey), so
    # a key whose second token is a KNOWN material carries this material's
    # row-level inventory adjustments — policy type, (R,Q) lot, κ, absolute
    # s/S — and reaches the engine as inventory_control.material_overrides.
    # Node-scoped inventory that does not parse this way (plant FG rows, keys
    # without a material token) stays default-scope-only, and is still counted
    # and surfaced below rather than dropped silently.
    known_mats = set(sups_by_mat)
    mat_over: dict[str, dict] = {}
    consumed_keys: set[str] = set()
    for k in sorted(k for k in policies if isinstance(k, str) and k.startswith("node:")):
        sup, sep, mat = k[len("node:"):].partition("::")
        inv_o = (policies[k] or {}).get("inventory") or {}
        if not sep or mat not in known_mats or not inv_o:
            continue
        entry = mat_over.setdefault(mat, {})

        def _take(field: str, value, conflict_from: str = sup) -> None:
            if field in entry and entry[field] != value:
                w.append(MappingWarning(
                    "warn", f"material:{mat}", field,
                    f"conflicting per-supplier values for one material — "
                    f"kept {entry[field]}, ignored {value} (from {conflict_from})"))
                return
            entry[field] = value

        if inv_o.get("type") is not None:
            _take("policy_type", type_map.get(str(inv_o["type"]), "min_max"))
        # The grid's unset markers: Q and S default to 0 in the frontend
        # schema, and the engine refuses a non-positive lot or ceiling.
        for dst, v in (("rop_q_quantity", inv_o.get("rop_q_quantity")),
                       ("coverage_weeks", inv_o.get("coverage_weeks")),
                       ("reorder_point", inv_o.get("reorder_point")),
                       ("order_up_to", inv_o.get("order_up_to"))):
            if v is None:
                continue
            v = float(v)
            if v <= 0 and dst in ("rop_q_quantity", "order_up_to"):
                continue
            _take(dst, v)
        if inv_o.get("review_period_days") is not None:
            _take("periodic_review_weeks", _review_weeks(
                float(inv_o["review_period_days"]), w=w, entity=f"material:{mat}"))
        if not entry:
            mat_over.pop(mat, None)
        else:
            consumed_keys.add(k)
        # Read per material elsewhere (holding % and initial stock in the
        # material loop, safety days just below), so the row is applied, not
        # dropped.
        if (inv_o.get("holding_cost_pct") is not None or inv_o.get("safety_stock_days") is not None
                or inv_o.get("initial_on_hand") is not None):
            consumed_keys.add(k)
    # A row applies only the parameters its policy type SHOWS (policyGridUi
    # POLICY_PARAMS): a value left stored from an earlier type is invisible on
    # the page, so it must not move the run. Said, never silent.
    default_type = type_map.get(str(inv.get("type", "min_max")), "min_max")
    for mat, entry in list(mat_over.items()):
        eff_type = entry.get("policy_type", default_type)
        shown = _TYPE_SHOWS.get(eff_type, _TYPE_SHOWS["min_max"])
        hidden = sorted(f for f in _TYPE_PARAMS if f in entry and f not in shown)
        for f in hidden:
            entry.pop(f)
        if hidden:
            w.append(MappingWarning(
                "info", f"material:{mat}", "inventory",
                f"stored {', '.join(hidden)} not applied — the row's {eff_type} policy "
                "does not use it (the page does not show it)"))
        if not entry:
            mat_over.pop(mat)
    # An (R,Q) row with no lot — its own or the project's — is a row the page
    # flags as needing input. If it is run anyway the engine orders up to S
    # (the declared substitution); say so per material, not only at project
    # scope, so the run log names the row.
    project_q = inv.get("rop_q_quantity")
    has_project_q = project_q is not None and float(project_q) > 0
    for mat, entry in mat_over.items():
        if entry.get("policy_type") == "rop_q" and "rop_q_quantity" not in entry and not has_project_q:
            w.append(MappingWarning(
                "warn", f"material:{mat}", "rop_q_quantity",
                "(R,Q) row with no lot size Q — ordered up to S (min-max lot) instead; "
                "set Q on the row"))
    # An absolute band a row states inverted (s ≥ S) would be refused by the
    # engine's validator and abort the run; keep the reorder point (the half
    # that triggers) and say what was dropped.
    for mat, entry in mat_over.items():
        s_v, S_v = entry.get("reorder_point"), entry.get("order_up_to")
        if s_v is not None and S_v is not None and S_v <= s_v:
            entry.pop("order_up_to")
            w.append(MappingWarning(
                "warn", f"material:{mat}", "order_up_to",
                f"order-up-to {S_v} ≤ reorder point {s_v} — S dropped, formula S used"))

    # Safety-stock days set on a Supplier-stage row (§4 D204): that material's
    # buffer is that many days of its demand, whatever the project-wide method.
    row_ss_days = {
        mat: _clamp(float(v), 0.0, 84.0, w=w, entity=f"material:{mat}",
                    field="safety_stock_days", unit=" d")
        for mat, v in _supplier_row_values(
            policies, "inventory", "safety_stock_days", known_mats, w).items()
    }

    # Surface per-node inventory overrides the engine will not apply (plant FG
    # rows and keys without a known material token).
    dropped_inventory = sum(
        1 for k, fams in policies.items()
        if isinstance(k, str) and k.startswith("node:") and k not in consumed_keys
        and (fams.get("inventory") or {})
    )
    if dropped_inventory:
        w.append(MappingWarning(
            "warn", "policy:inventory_control", "inventory",
            f"{dropped_inventory} per-node inventory override(s) not applied — "
            "plant-row stock settings are consumed at the project default "
            "scope only; supplier-row overrides ARE applied"))

    out["inventory_control"] = {"policy_type": default_type}
    if inv.get("review_period_days") is not None:
        out["inventory_control"]["periodic_review_weeks"] = _review_weeks(
            float(inv["review_period_days"]), w=w, entity="policy:default")
    # The project's Q is the lot of EVERY (R,Q) material without its own — a row
    # switched to (R,Q) shows it, so it is read whatever the project's own type
    # (the engine applies it to (R,Q) materials only).
    q_default = inv.get("rop_q_quantity")
    if q_default is not None and float(q_default) > 0:
        out["inventory_control"]["rop_q_quantity"] = float(q_default)
    elif out["inventory_control"]["policy_type"] == "rop_q":
        # DECLARED substitution (T2): (R,Q) with no positive Q orders up to
        # S (the min_max lot) — stated here, enacted in the plugin.
        w.append(MappingWarning(
            "warn", "policy:inventory_control", "rop_q_quantity",
            "(R,Q) selected with no positive Q at project scope — such "
            "materials order up to S (min_max lot) instead"))
    if inv.get("coverage_weeks") is not None:
        k_scalar = _clamp(float(inv["coverage_weeks"]), 0.0, 26.0, w=w,
                          entity="policy:default", field="coverage_weeks", unit=" wk")
        # The UI states one κ; the engine's strip gets that value in every
        # mode — a fixed cover, not a mode-scaled one.
        out["inventory_control"]["coverage_weeks"] = {
            "nominal": k_scalar, "alert": k_scalar, "crisis": k_scalar}
    if mat_over:
        out["inventory_control"]["material_overrides"] = mat_over
        w.append(MappingWarning(
            "info", "policy:inventory_control", "material_overrides",
            f"{len(mat_over)} material(s) carry supplier-grid replenishment "
            "overrides (type/Q/κ/absolute levels) — applied per material"))
    w.append(MappingWarning("info", "policy:inventory_control", "order_up_to",
                            "project-wide s/S are the formulas s = E[D]·T_s, S = E[D]·(T_s+κ); "
                            "a supplier-grid row's absolute s/S IS that material's level, "
                            "with no safety stock added on top"))

    ss_method = str(inv.get("safety_stock_method", "fixed_days"))
    if ss_method in ("service_level", "demand_variability"):
        sl = float(inv.get("service_level_target", 0.95)) * 100.0
        out["safety_stock_materials"] = {"classification": "uniform",
                                         "uniform_service_level": _clamp(
                                             sl, 80.0, 99.9, w=w, entity="policy:default",
                                             field="service_level_target", unit=" %")}
    elif ss_method == "king_method":
        out["safety_stock_materials"] = {"classification": "king"}
    else:
        out["safety_stock_materials"] = {
            "classification": "fixed_days",
            "fixed_days_cover": _clamp(float(inv.get("safety_stock_days", 7.0)), 0.0, 84.0,
                                       w=w, entity="policy:default",
                                       field="safety_stock_days", unit=" d"),
        }
    if row_ss_days:
        out["safety_stock_materials"]["fixed_days_by_material"] = row_ss_days
        w.append(MappingWarning(
            "info", "policy:safety_stock_materials", "safety_stock_days",
            f"{len(row_ss_days)} material(s) carry a Supplier-stage safety-stock "
            "days value — applied per material, over the project-wide method"))

    project_allows = bool(fulfil.get("backorder_allowed", False))
    project_days = fulfil.get("max_backorder_days", 14)
    project_cost = fulfil.get("backorder_cost_per_day", 0.0)
    if project_allows:
        out["unmet_demand_handling"] = {
            "rule": "backorder",
            "backorder_horizon": _backorder_weeks(project_days, w=w, entity="policy:default"),
            "backorder_penalty": float(project_cost) * 7.0,
        }
    else:
        out["unmet_demand_handling"] = {"rule": "lost_sales"}

    # Per-row fulfillment (WP 14.3, ADR 0002 decisions 4–5): a Customer row's
    # backorder setting, window and cost. A row that names any of them gets ALL
    # three resolved — row → project default → the defaults above — so the
    # engine never falls to a parameter default the page does not show.
    row_bo: dict[str, dict[str, Any]] = {}
    row_patches = {k[len("node:"):]: ((policies.get(k) or {}).get("fulfillment") or {})
                   for k in policies
                   if isinstance(k, str) and k.startswith("node:") and k[len("node:"):] in row_keys}
    for rid in sorted(row_patches):
        patch = row_patches[rid]
        ent = f"customer_row:{rid}"
        allowed = patch.get("backorder_allowed")
        days = patch.get("max_backorder_days")
        cost = patch.get("backorder_cost_per_day")
        if allowed is None and days is None and cost is None:
            continue
        waits = bool(allowed) if allowed is not None else project_allows
        ov: dict[str, Any] = {"backorder_allowed": waits}
        if waits:
            ov["backorder_horizon"] = _backorder_weeks(
                days if days is not None else project_days, w=w, entity=ent)
            ov["backorder_penalty"] = float(cost if cost is not None else project_cost) * 7.0
        row_bo[rid] = ov
    if row_bo:
        out["unmet_demand_handling"]["row_overrides"] = row_bo

    # P-C.2 customer allocation — the UI's fulfillment.allocation enum finally
    # reaches the engine. Inert (skipped) below two customers.
    alloc = str(fulfil.get("allocation", "") or "")
    if alloc and n_customers >= 2:
        if alloc == "revenue_max":
            # The row price is CustomerLink.unit_price (override → the outbound
            # row's unit price), else the product's — no param needed here.
            out["customer_allocation"] = {"rule": "revenue_max"}
        elif alloc == "sla_tier":
            # G1 closure: the UI's tier fill floors (fractions) reach P-C.2.
            out["customer_allocation"] = {
                "rule": "sla_tier",
                "sla_tiers": {
                    str(k): _clamp(float(v) * 100.0, 0.0, 100.0, w=w,
                                   entity=f"policy:tier:{k}", field="tier_overrides", unit=" %")
                    for k, v in (fulfil.get("tier_overrides") or {}).items()
                },
            }
        elif alloc in _ALLOCATION_RULE:
            out["customer_allocation"] = {"rule": _ALLOCATION_RULE[alloc]}
    # The row's priority and service target (WP 14.3): an override on the
    # Customer row beats the customer's master value. Read only by the rules
    # that use them; the grid shows each column only under those rules.
    # The row's value is resolved whatever the rule (the cell shows it); the
    # engine receives it only under a rule that reads it.
    rule = (out.get("customer_allocation") or {}).get("rule")
    row_priority: dict[str, float] = {}
    row_floor: dict[str, float] = {}
    for rid in sorted(row_patches):
        patch = row_patches[rid]
        ent = f"customer_row:{rid}"
        v = patch.get("row_priority")
        if v not in (None, ""):
            n = _override_num(v, entity=ent, field="row_priority", domain="nonnegative", w=w)
            if n is not None:
                row_priority[rid] = n
        v = patch.get("sla_fill_floor_pct")
        if v not in (None, ""):
            n = _override_num(v, entity=ent, field="sla_fill_floor_pct", domain="percent", w=w)
            if n is not None:
                row_floor[rid] = n
    if row_priority and rule in ("priority", "sla_tier"):
        out["customer_allocation"]["row_priority"] = row_priority
    if row_floor and rule == "sla_tier":
        out["customer_allocation"]["row_floor_pct"] = row_floor
    if tally is not None:
        _tally_row_allocation(tally, row_keys, row_priority, row_floor, row_masters or {}, rule)

    # P-S.2 proactive multi-sourcing — sourcing.ratios finally reach the
    # engine (G1's flagship loss). Empty weights are valid: the plugin
    # derives a volume/equal split over qualified links.
    strategy = str(sourcing.get("strategy", "single"))
    weights = _multi_sourcing_weights(policies, sourcing, sups_by_mat, w)
    if strategy == "multi" or weights:
        if any(len(s) > 1 for s in sups_by_mat.values()):
            out["proactive_multi_sourcing"] = {"weights": weights}
        else:
            w.append(MappingWarning(
                "warn", "policy:proactive_multi_sourcing", "strategy",
                "multi-sourcing configured but every material is single-sourced — "
                "P-S.2 skipped (add a second qualified supplier arc)"))

    # P-P.4 finished-goods safety stock — MTS only (MTO builds no FG stock).
    # Gate on the engine's ACTUAL product mode (`has_mts`, resolved from
    # products.fulfillment_mode / supply_chain_model), not the separate policy
    # `fulfillment_strategy` string; warn when the two disagree so the split
    # between the two "fulfillment mode" fields can never silently mis-gate.
    fg = str(inv.get("fg_safety_stock", "none") or "none")
    if fg != "none":
        strat = str(default.get("fulfillment_strategy", "")).strip().lower()
        strat_is_mts = strat in ("mts", "make_to_stock")
        if has_mts:
            if fg == "service_level":
                out["fg_safety_stock"] = {
                    "sizing": "service_level",
                    "service_level_pct": _clamp(
                        float(inv.get("fg_service_level_target", 0.95)) * 100.0, 80.0, 99.9,
                        w=w, entity="policy:default", field="fg_service_level_target",
                        unit=" %"),
                    "segmentation": "uniform",
                }
            else:
                out["fg_safety_stock"] = {
                    "sizing": "fixed_days",
                    "fixed_days_cover": _clamp(
                        float(inv.get("fg_safety_stock_days", 2.0)), 0.0, 12.0, w=w,
                        entity="policy:default", field="fg_safety_stock_days", unit=" d"),
                    "segmentation": "uniform",
                }
            if strat and not strat_is_mts:
                w.append(MappingWarning(
                    "info", "policy:fg_safety_stock", "fulfillment_strategy",
                    f"fulfillment_strategy={strat!r} but MTS products exist — FG safety "
                    "stock applied per the products' actual fulfillment mode"))
        elif strat_is_mts:
            w.append(MappingWarning(
                "warn", "policy:fg_safety_stock", "fulfillment_strategy",
                "fulfillment_strategy=make_to_stock but no product is make_to_stock "
                "(products.fulfillment_mode / supply_chain_model) — FG safety stock skipped"))
        else:
            w.append(MappingWarning(
                "warn", "policy:fg_safety_stock", "fg_safety_stock",
                "finished-goods safety stock requires make_to_stock — skipped under MTO"))

    # `enabled: false` switches every recovery response off (engine 0.8.2); the
    # sourcing strategy's own backup below is strategic, not a recovery response.
    responses = recovery_responses(recovery)

    def _rec_num(key: str, lo: float, hi: float, unit: str) -> Optional[float]:
        v = recovery.get(key)
        if v in (None, ""):
            return None
        try:
            return _clamp(float(v), lo, hi, w=w, entity="policy:recovery", field=key, unit=unit)
        except (TypeError, ValueError):
            w.append(MappingWarning("warn", "policy:recovery", key, f"{v!r} is not a number — ignored"))
            return None

    if strategy in ("primary_backup", "dual_sourcing", "multi") \
            or "dual_source_activate" in responses:
        out["backup_supplier"] = {}
        # Blank = each backup lane's own lead time; a number overrides every backup's.
        blt = _rec_num("backup_lead_time_weeks", 1, 26, " wk") \
            if "dual_source_activate" in responses else None
        if blt is not None:
            out["backup_supplier"]["backup_lead_time_weeks"] = int(round(blt))
    if responses & {"mode_shift", "expedite_freight", "reroute"}:
        out["expedited_shipments"] = {}
        exp = _rec_num("expedite_cost_pct", 1, 50, " %")
        if exp is not None:
            out["expedited_shipments"]["premium_pct_of_cost"] = exp
    if "capacity_flex" in responses:
        out["short_term_capacity"] = {}
        ot = _rec_num("overtime_cost_pct", 1, 25, " %")
        if ot is not None:
            out["short_term_capacity"]["overtime_premium_pct_of_price"] = ot
    # A response with no engine model is said, not silently dropped (§4 D114).
    if "demand_shaping" in responses:
        w.append(MappingWarning(
            "warn", "policy:recovery", "response",
            "recovery response(s) ['demand_shaping'] have no engine model and change nothing in "
            "this run — material reallocation is `allocate_materials` (P-P.9)"))
    # P-P.3 disruption buffer windows (engine 0.8.3): the card's Safety stock.
    if "safety_stock_drawdown" in responses:
        wins = _safety_stock_windows(recovery.get("safety_stock_windows"), w)
        if wins:
            out.setdefault("safety_stock_materials", {})["windows"] = wins
            w.append(MappingWarning(
                "info", "policy:safety_stock_materials", "windows",
                f"{len(wins)} disruption buffer window(s): extra cover held only inside each "
                "window, its holding cost booked for those weeks"))
            if str(inv.get("type", "min_max")) == "mrp":
                w.append(MappingWarning(
                    "warn", "policy:safety_stock_materials", "windows",
                    "the inventory policy is MRP, which plans from the BOM and does not read "
                    "reorder levels — the buffer windows change nothing in this run"))
        else:
            w.append(MappingWarning(
                "warn", "policy:recovery", "safety_stock_windows",
                "Safety stock is on but no material has a buffer window — nothing changes"))

    # P-S.4 early warning — recovery.detection_lag_days finally reaches the
    # engine, compressing how fast every reactive policy engages.
    if "early_warning" in responses:
        days = float(recovery.get("detection_lag_days", 1.0) or 0.0)
        out["early_warning_failover"] = {
            "detection_lag_weeks": int(_clamp(round(days / 7.0), 0, 4, w=w,
                                              entity="policy:default",
                                              field="detection_lag_days", unit=" wk")),
        }

    # P-P.9 optimized material allocation — per-product priorities fold in
    # from plant-stage overrides (target_key "<plant>::<product>").
    if "allocate_materials" in responses:
        priority: dict[str, float] = {}
        for key, families in policies.items():
            if not isinstance(key, str) or not key.startswith("node:") or "::" not in key:
                continue
            # Nor a Customer row (WP 14.4 — the same reach `_composite_patches` had).
            if key[len("node:"):] in row_keys:
                continue
            _node, _, prod = key[len("node:"):].partition("::")
            v = (families.get("production") or {}).get("allocation_priority_weight")
            # A PRODUCT's row only (§23 WP 13.4): a Supplier-stage row keys a
            # material, and folding its production family made a material id a
            # product priority.
            if v is not None and prod and (prod_ids is None or prod in prod_ids):
                priority[prod] = float(v)
        params: dict[str, Any] = {"activation": "during_disruption"}
        win = _rec_num("allocation_horizon_weeks", 1, 13, " wk")
        if win is not None:
            params["window_weeks"] = int(round(win))
        cost = _rec_num("annual_labor_cost", 0, 1e9, " €")
        if cost is not None:
            params["annual_cost"] = cost
        if priority:
            params["objective"] = "priority_weighted"
            params["priority_weights"] = priority
        out["material_allocation"] = params

    return out

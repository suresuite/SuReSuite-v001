# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-P.3 safety_stock_materials — STRATEGIC, ABC-XYZ buffer (Part IV §4.2). ✅

Context: the classic buffer, ABC-XYZ-differentiated so euros protect where
it matters. Dominates SHORT disruptions; depletes — beyond ~7–9 weeks
expediting wins (the SS-vs-expedite crossover experiment of Part VII).

Mechanics (Eqs. 20–21), applied on top of P-P.1's levels at PH-70:
    s_m += z_m · σ_{D_m} · √T_s
    S_m += z_m · σ_{D_m} · √(T_s + κ)
The incremental holding cost of the planned reorder-point buffer
(h_m · c_m · SS_m weekly) flows into C^res as ``ss_holding``.

A level the planner STATED on a /policies row is the level the run uses, so
no buffer is added to it (P-P.1 publishes which at compile); an (R,Q)
material with a lot keeps S = R + Q, so its S moves with its s. κ in Eq. 21
is the material's own κ when its row states one.

Disruption buffer windows (engine 0.8.3, the recovery card's Safety stock): an
EXTRA buffer of `days` of expected cover for one material, held only while
``start_week ≤ week < end_week``. It raises s and S by E[D_m]·days/7 in those
weeks (never a stated level), so orders to build it are released at
``start_week`` and arrive a lead time later; its holding cost h_m · c_m · units
flows into C^res as ``ss_holding`` for those weeks only. The permanent
buffer above is unchanged.
"""
from __future__ import annotations

from typing import ClassVar, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from scipy import stats as sps

from scsim.core.context import SimContext
from scsim.core.phases import (
    INVENTORY_LEVELS,
    MATERIAL_DEMAND,
    ST_COST_LEDGER,
    Hook,
    PhaseId,
)
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.policies.base import CostBreakdown, DataRequirement, PolicyParams, PolicyPlugin
from scsim.policies.registry import register_plugin

# Plan §4.2 z-matrix defaults (service levels in %).
DEFAULT_Z_MATRIX: dict[str, float] = {
    "AX": 99.5, "AY": 99.0, "AZ": 98.0,
    "BX": 98.0, "BY": 95.0, "BZ": 90.0,
    "CX": 95.0, "CY": 90.0, "CZ": 80.0,
}


class SafetyStockWindow(BaseModel):
    """One material's extra buffer, held over a window of simulated weeks."""

    model_config = ConfigDict(extra="forbid")

    material_id: str
    days: float = Field(..., gt=0.0, le=84.0,
                        json_schema_extra={"unit": "days", "notes": "Extra cover: E[D_m]·days/7 units."})
    start_week: int = Field(..., ge=0, json_schema_extra={"unit": "week",
                            "notes": "First week the buffer is held — the disruption schedule's week."})
    end_week: int = Field(..., ge=1, json_schema_extra={"unit": "week",
                          "notes": "First week it is no longer held (exclusive)."})

    @model_validator(mode="after")
    def _order(self) -> "SafetyStockWindow":
        if self.end_week <= self.start_week:
            raise ValueError(f"safety-stock window for {self.material_id!r}: end_week "
                             f"{self.end_week} must be after start_week {self.start_week}")
        return self


class SafetyStockParams(PolicyParams):
    classification: Literal["abc_xyz", "uniform", "fixed_days", "king"] = Field(
        "abc_xyz", json_schema_extra={"unit": "enum", "scope": "G", "notes": "abc_xyz ✅."},
    )
    z_matrix: dict[str, float] = Field(
        default_factory=lambda: dict(DEFAULT_Z_MATRIX),
        json_schema_extra={"unit": "% service level", "scope": "G", "range": "[80, 99.9]",
                           "notes": "Nine ABC×XYZ cells."},
    )
    abc_breakpoints: tuple[float, float] = Field(
        (0.80, 0.95),
        json_schema_extra={"unit": "cumulative value share", "scope": "G",
                           "notes": "A up to 80%, B up to 95%, C the rest (80/15/5)."},
    )
    xyz_cv_breakpoints: tuple[float, float] = Field(
        (0.13, 0.25),
        json_schema_extra={"unit": "demand CV", "scope": "G",
                           "notes": "X ≤ 0.13, Y ≤ 0.25, Z above."},
    )
    uniform_service_level: float = Field(
        95.0, ge=80.0, le=99.9,
        json_schema_extra={"unit": "%", "scope": "G", "notes": "classification=uniform."},
    )
    fixed_days_cover: float = Field(
        14.0, ge=0.0, le=84.0,
        json_schema_extra={"unit": "days", "scope": "G", "notes": "classification=fixed_days."},
    )
    fixed_days_by_material: dict[str, float] = Field(
        default_factory=dict,
        json_schema_extra={
            "unit": "days", "scope": "M", "range": "[0, 84]",
            "notes": "Per-material fixed-days cover (the /policies Supplier stage's "
                     "safety-stock days). A listed material's buffer is E[D_m]·days/7 "
                     "whatever the classification; unlisted materials follow it.",
        },
    )
    windows: list[SafetyStockWindow] = Field(
        default_factory=list,
        json_schema_extra={
            "unit": "list", "scope": "M",
            "notes": "Disruption buffer windows (the recovery card's Safety stock): an extra "
                     "E[D_m]·days/7 held only for start_week ≤ week < end_week, its holding "
                     "cost booked for those weeks only. Empty = none.",
        },
    )

    @field_validator("z_matrix")
    @classmethod
    def _cells(cls, v: dict[str, float]) -> dict[str, float]:
        missing = set(DEFAULT_Z_MATRIX) - set(v)
        if missing:
            raise ValueError(f"z_matrix missing cells: {sorted(missing)}")
        for cell, sl in v.items():
            if cell not in DEFAULT_Z_MATRIX:
                raise ValueError(f"unknown z_matrix cell {cell!r}")
            if not (80.0 <= sl <= 99.9):
                raise ValueError(f"z_matrix[{cell}] must be in [80, 99.9] %")
        return v

    @field_validator("fixed_days_by_material")
    @classmethod
    def _days(cls, v: dict[str, float]) -> dict[str, float]:
        for mid, days in v.items():
            if not (0.0 <= days <= 84.0):
                raise ValueError(f"fixed_days_by_material[{mid}] must be in [0, 84] days")
        return v


@register_plugin
class SafetyStockMaterials(PolicyPlugin):
    id: ClassVar[str] = "safety_stock_materials"
    catalog_ref: ClassVar[str] = "P-P.3"
    stage: ClassVar[Stage] = Stage.PLANT
    strategy_class: ClassVar[StrategyClass] = StrategyClass.STRATEGIC
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.MATERIAL_AVAILABILITY
    requires_predeployment: ClassVar[bool] = True
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "ABC-XYZ-differentiated material safety stock (Eqs. 20–21). Dominates short "
        "disruptions; depletes — beyond ~7–9 weeks expediting wins (run the crossover sweep)."
    )
    Params: ClassVar[type[PolicyParams]] = SafetyStockParams
    # Facet 11: recorded for each material in the week its buffer is first set
    # and in any week it changes (a disruption window opening or closing).
    rationale_codes: ClassVar[dict[str, str]] = {
        "buffer_abc_xyz":
            "The buffer was sized from the material's ABC-XYZ class service level, demand variability and lead time (Eqs. 20-21).",
        "buffer_king":
            "The buffer was sized by King's formula: demand variability over the lead time plus lead-time variability.",
        "buffer_uniform":
            "The buffer was sized from one uniform service level, demand variability and lead time.",
        "buffer_fixed_days":
            "The buffer was set as a fixed number of days of expected demand.",
        "buffer_material_days":
            "The buffer was set from the days of cover stated for this material.",
        "buffer_zero_stated_level":
            "The material has a stated reorder level, which is never raised, so no buffer was added.",
        "buffer_window_raised":
            "A disruption buffer window for this material was open this week, so its levels were raised for the window.",
    }
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = (
        DataRequirement(
            field="products.demand_cv", level="recommended",
            reason="Safety-stock sizing scales with demand variability; the "
                   "default CV of 0.30 may badly misstate your buffers.",
            fallback="scenario demand_model.cv, then 0.30",
        ),
    )

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH70, priority=60,
                reads={MATERIAL_DEMAND, INVENTORY_LEVELS},
                writes={INVENTORY_LEVELS, ST_COST_LEDGER},
                resolution="Adds the safety-stock buffer on top of inventory_control's "
                           "levels (priority 50) — Eqs. 20–21.",
            ),
        ]

    def setup(self, ctx: SimContext) -> None:
        m = ctx.model
        p: SafetyStockParams = self.params
        sigma = np.sqrt(m.var_demand_m)
        exp_d = m.exp_demand_m
        lt = m.link_lt[m.primary_link].astype(float)
        lt_cv = m.link_lt_cv[m.primary_link]

        if p.classification == "fixed_days":
            ss_s = exp_d * p.fixed_days_cover / 7.0
            ss_S = ss_s
        else:
            z = self._z_per_material(m, p, sigma, exp_d)
            if p.classification == "king":
                # King: z·σ_D·√T + z·μ_D·σ_LT (σ_LT from the link's CV).
                ss_s = z * sigma * np.sqrt(lt) + z * exp_d * (lt_cv * lt)
                ss_S = ss_s
            else:
                ss_s = z * sigma * np.sqrt(lt)            # Eq. 20
                kappa = np.asarray(getattr(m, "kappa_override", np.full(m.n_mats, np.nan)))
                kappa = np.where(np.isnan(kappa), self._kappa_hint(ctx), kappa)
                ss_S = z * sigma * np.sqrt(lt + kappa)  # Eq. 21
        if p.fixed_days_by_material:
            ss_s = np.array(ss_s, dtype=float)
            ss_S = np.array(ss_S, dtype=float)
            for mid, days in p.fixed_days_by_material.items():
                i = m.mat_index.get(mid)
                if i is not None:
                    ss_s[i] = ss_S[i] = exp_d[i] * days / 7.0
        # What is actually ADDED to the levels: nothing on a stated level, and
        # on an (R,Q) lot the S increment equals the s one so S stays R + Q.
        stated_s = getattr(m, "stated_s_mask", None)
        stated_S = getattr(m, "stated_S_mask", None)
        lot_S = getattr(m, "lot_S_mask", None)
        add_s = np.array(ss_s, dtype=float)
        add_S = np.array(ss_S, dtype=float)
        if stated_s is not None:
            add_s = np.where(stated_s, 0.0, add_s)
            add_S = np.where(lot_S, add_s, np.where(stated_S, 0.0, add_S))
        # Disruption buffer windows: per material, the units added and when.
        win_mat, win_units, win_start, win_end = [], [], [], []
        for wdw in p.windows:
            i = m.mat_index.get(wdw.material_id)
            if i is None:
                continue
            win_mat.append(i)
            win_units.append(float(exp_d[i]) * wdw.days / 7.0)
            win_start.append(wdw.start_week)
            win_end.append(wdw.end_week)
        ctx.policy_state[self.id] = {
            "ss_s": add_s, "ss_S": add_S, "stated_S": stated_S,
            "stated_s": stated_s,
            "win_mat": np.array(win_mat, dtype=int), "win_units": np.array(win_units),
            "win_start": np.array(win_start, dtype=int), "win_end": np.array(win_end, dtype=int),
            "win_extra": np.zeros(m.n_mats),
        }
        # WP 14.5 — the same buffer as DAYS of cover per material, published at
        # setup for MRP (design doc §3.4: SS = days/7 × average weekly need over
        # the horizon). One buffer, counted once: MRP does not read the levels
        # this policy raises at PH-70.
        exp = np.asarray(exp_d, dtype=float)
        ctx.material_ss_days = np.where(exp > 0, 7.0 * np.asarray(ss_s, dtype=float)
                                        / np.where(exp > 0, exp, 1.0), 0.0)

    def _kappa_hint(self, ctx: SimContext) -> float:
        """κ for Eq. 21 — taken from inventory_control's nominal cover."""
        try:
            ic = ctx.params("inventory_control")
            return float(ic.coverage_weeks.nominal)
        except KeyError:
            return 8.0

    def _z_per_material(self, m, p: SafetyStockParams, sigma, exp_d) -> np.ndarray:
        if p.classification == "uniform":
            z_val = float(sps.norm.ppf(p.uniform_service_level / 100.0))
            return np.full(m.n_mats, z_val)
        # ABC by annual value share (descending, cumulative).
        annual_value = exp_d * 52.0 * m.mat_cost
        order = np.argsort(-annual_value)
        total = max(annual_value.sum(), 1e-12)
        cum = np.cumsum(annual_value[order]) / total
        abc = np.empty(m.n_mats, dtype="<U1")
        a_cut, b_cut = p.abc_breakpoints
        abc_sorted = np.where(cum <= a_cut, "A", np.where(cum <= b_cut, "B", "C"))
        abc[order] = abc_sorted
        # XYZ by demand CV.
        cv = np.divide(sigma, exp_d, out=np.full_like(sigma, np.inf), where=exp_d > 0)
        x_cut, y_cut = p.xyz_cv_breakpoints
        xyz = np.where(cv <= x_cut, "X", np.where(cv <= y_cut, "Y", "Z"))
        z = np.empty(m.n_mats)
        for i in range(m.n_mats):
            sl = p.z_matrix[f"{abc[i]}{xyz[i]}"]
            z[i] = sps.norm.ppf(sl / 100.0)
        return z

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        state = ctx.policy_state[self.id]
        s = ctx.level_s + state["ss_s"]
        S = ctx.level_S + state["ss_S"]
        if state["win_mat"].size:
            active = (state["win_start"] <= ctx.week) & (ctx.week < state["win_end"])
            extra = np.zeros(ctx.model.n_mats)
            np.add.at(extra, state["win_mat"][active], state["win_units"][active])
            if state["stated_s"] is not None:   # a stated level is never raised
                extra = np.where(state["stated_s"] | state["stated_S"], 0.0, extra)
            state["win_extra"] = extra
            s = s + extra
            S = S + extra
        # A stated S is never raised: a buffered formula s above it is lowered.
        if state["stated_S"] is not None and state["stated_S"].any():
            s = np.where(state["stated_S"], np.minimum(s, S), s)
        base_s, base_S = ctx.level_s, ctx.level_S
        ctx.write_levels(s, S)
        if ctx.decisions.enabled:
            self._record(ctx, base_s, base_S, ctx.level_s, ctx.level_S)

    def _record(self, ctx: SimContext, base_s, base_S, s, S) -> None:
        # Reads values on_phase already computed; changes nothing (facet 11).
        p: SafetyStockParams = self.params
        m = ctx.model
        state = ctx.policy_state[self.id]
        added = np.asarray(state["ss_s"], dtype=float) + np.asarray(state["win_extra"], dtype=float)
        prev = state.get("added_recorded")
        by_class = {"abc_xyz": "buffer_abc_xyz", "king": "buffer_king", "uniform": "buffer_uniform",
                    "fixed_days": "buffer_fixed_days"}
        stated = state["stated_s"]
        for i in range(m.n_mats):
            if prev is not None and prev[i] == added[i]:
                continue
            mid = m.mat_ids[i]
            if stated is not None and (bool(stated[i]) or bool(state["stated_S"][i])) \
                    and state["ss_s"][i] == 0.0:
                why = "buffer_zero_stated_level"
            elif state["win_extra"][i] > 0:
                why = "buffer_window_raised"
            elif mid in (p.fixed_days_by_material or {}):
                why = "buffer_material_days"
            else:
                why = by_class.get(p.classification, "buffer_abc_xyz")
            self.decide(
                ctx, rationale=why, node_kind="material", node=mid,
                inputs={"classification": p.classification, "base_reorder_point": float(base_s[i]),
                        "base_order_up_to": float(base_S[i])},
                decision={"safety_stock": float(state["ss_s"][i]),
                          "window_extra": float(state["win_extra"][i]),
                          "reorder_point": float(s[i]), "order_up_to": float(S[i])},
            )
        state["added_recorded"] = added.copy()

    def cost_contribution(self, ctx: SimContext) -> CostBreakdown:
        # Incremental holding on the planned reorder-point buffer (weekly).
        state = ctx.policy_state[self.id]
        cb = CostBreakdown()
        # A buffer window's holding is safety-stock holding too, booked only in its weeks.
        held = state["ss_s"] + state["win_extra"]
        cb.add("ss_holding", float((ctx.model.mat_holding_weekly * held).sum()))
        return cb

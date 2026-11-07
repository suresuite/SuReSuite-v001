# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""Policy plugin interface — Part IX §9.2 (binding contract).

A policy is a class with declared metadata, hooks, and a Pydantic Params
model. Policies interact with the world ONLY through the SimContext typed
accessors and draw randomness ONLY from ``ctx.rng(self.id)`` (§9.4).

Adding a Tier-1 policy = one plugin file + a registry entry + a docs row
(CI-enforced) + one validation experiment. No engine edits.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import BaseModel, ConfigDict

from scsim.core.phases import Hook, PhaseId
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass

if TYPE_CHECKING:  # pragma: no cover
    from scsim.core.context import SimContext
    from scsim.entities.scenario import Scenario


class PolicyParams(BaseModel):
    """Base for all policy parameter models. ``extra='forbid'`` so a typo in a
    param name is a validation error, not silence."""

    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class ModeStrip(BaseModel):
    """nominal/alert/crisis parameter strip (Part IV header). v1 engines use
    nominal normally and crisis while any event is firm-visible; alert engages
    once P-S.4 early warning lands (M7)."""

    model_config = ConfigDict(extra="forbid")

    nominal: float
    alert: float
    crisis: float


@dataclass(frozen=True)
class FallbackStep:
    """One step of a machine-readable fallback chain (§8.2). Exactly one of
    ``reducer`` (a named derivation over project data — the shared vocabulary
    the platform graders dispatch on) or ``constant`` (the engine's neutral
    default) is set. ``grade`` is the finding level the manifest assigns when
    THIS step is what resolves the field: data-derived → "info",
    neutral constant → "warn" (the engine emits the same levels as
    MappingWarnings, which is the parity contract)."""

    grade: str                     # "info" | "warn"
    reducer: Optional[str] = None  # e.g. "cheapest_inbound_price"
    constant: Optional[float] = None

    def as_dict(self) -> dict:
        return {"grade": self.grade, "reducer": self.reducer, "constant": self.constant}


@dataclass(frozen=True)
class EmptyMeaning:
    """What an EMPTY column MEANS, when empty means something.

    A ``fallback_spec`` says what the engine SUBSTITUTES when a column has no
    value. It cannot express the other case: a column whose emptiness is itself
    a modelling choice the engine honours. ``suppliers.capacity_per_week`` is
    the one this was written for — NULL is not "missing", it is "unlimited", and
    the engine builds ``np.inf`` from it.

    Declared here so the statement has ONE author. Until this existed the
    sentence lived in the frontend's ``columnSpecs.ts`` (``master.nullMeans``)
    while the registry said "unlimited" in prose one table over — two authors of
    one fact, which is the §2.1 `single-source` class the plan's D101/D127 are
    about. ``token`` is what a surface renders in place of a number; ``meaning``
    is the sentence it shows beside it.
    """

    token: str
    meaning: str

    def as_dict(self) -> dict:
        return {"token": self.token, "meaning": self.meaning}


@dataclass(frozen=True)
class DataRequirement:
    """Facet 5 of the policy interface — the parameter-requirement contract
    (design blueprint §8.1): an entity field this policy needs from the
    project dataset, declared machine-readably so the platform can compile
    a required-data manifest from the registry instead of hand-writing
    validation rules.

    ``field`` uses the canonical ``dataset.column`` vocabulary of
    ``docs/data-simulation-mapping.md`` §4 (mirrored by the frontend's
    ``dataMap.ts``). ``level`` drives run behavior: ``required`` blocks
    dispatch while the field is unresolvable, ``recommended`` warns and
    needs acknowledgment, ``defaulted`` is an informational note.
    ``fallback`` names the mapper's fallback chain when one exists
    (project_map.py is authoritative); ``fallback_spec`` is its
    machine-readable form — ordered steps the graders resolve without
    hand-coding per-field logic; ``condition`` scopes the
    requirement to a parameterization (e.g. ``"segmentation=abc_by_revenue"``).
    ``empty_means`` declares the OTHER case — a column whose emptiness the
    engine HONOURS rather than substitutes for (see :class:`EmptyMeaning`). A
    requirement carries a ``fallback_spec`` or an ``empty_means``, never both:
    they are opposite answers to "this column is blank", and a surface that saw
    both would have to pick one, which is a decision no surface owns.
    """

    field: str
    level: str  # "required" | "recommended" | "defaulted"
    reason: str
    fallback: Optional[str] = None
    condition: Optional[str] = None
    fallback_spec: tuple[FallbackStep, ...] = ()
    empty_means: Optional[EmptyMeaning] = None

    def __post_init__(self) -> None:
        if self.fallback_spec and self.empty_means is not None:
            raise ValueError(
                f"{self.field}: a requirement declares a fallback chain OR what an "
                "empty column means, never both — they are opposite answers to the "
                "same blank cell"
            )

    def as_dict(self) -> dict:
        return {
            "field": self.field,
            "level": self.level,
            "reason": self.reason,
            "fallback": self.fallback,
            "condition": self.condition,
            "fallback_spec": [s.as_dict() for s in self.fallback_spec],
            "empty_means": self.empty_means.as_dict() if self.empty_means else None,
        }


@dataclass(frozen=True)
class FeasibilityIssue:
    severity: str  # "error" | "warning"
    code: str
    message: str


@dataclass(frozen=True)
class FeasibilityResult:
    feasible: bool
    issues: tuple[FeasibilityIssue, ...] = ()

    @staticmethod
    def ok() -> "FeasibilityResult":
        return FeasibilityResult(True, ())


@dataclass
class CostBreakdown:
    """Per-week cost contributions, keyed by C^res component (Part V)."""

    components: dict[str, float] = field(default_factory=dict)

    def add(self, component: str, amount: float) -> None:
        self.components[component] = self.components.get(component, 0.0) + amount


class PolicyPlugin(ABC):
    """Subclass, declare ClassVar metadata, implement the lifecycle methods."""

    id: ClassVar[str]                          # registry key, snake_case
    stage: ClassVar[Stage]
    strategy_class: ClassVar[StrategyClass]
    constraint_targeted: ClassVar[Optional[ConstraintTag]]
    requires_predeployment: ClassVar[bool]
    status: ClassVar[PolicyStatus]
    catalog_ref: ClassVar[str]                 # e.g. "P-P.1"
    summary: ClassVar[str]                     # one-paragraph context (docs)
    Params: ClassVar[type[PolicyParams]]
    # Facet 5 (§8.1): entity fields the policy reads; () = params-only policy.
    data_requirements: ClassVar[tuple[DataRequirement, ...]] = ()
    # Facet 11 (§6.1, scsim/core/decisions.py): the CLOSED vocabulary of
    # rationale codes this policy's decision-trace records may carry,
    # code → plain-words meaning. Empty = the policy records no decisions yet.
    rationale_codes: ClassVar[dict[str, str]] = {}

    def __init__(self, params: PolicyParams):
        self.params = params

    def decide(
        self,
        ctx: "SimContext",
        *,
        rationale: str,
        node_kind: str,
        node: str,
        inputs: Optional[dict] = None,
        decision: Optional[dict] = None,
    ) -> None:
        """Record one decision-trace record (facet 11). A no-op unless the run
        is a single-replication inspection run; never changes the simulation."""
        ctx.decisions.record(
            week=ctx.week, policy_id=self.id, catalog_ref=self.catalog_ref,
            declared=self.rationale_codes, rationale=rationale,
            node_kind=node_kind, node=node, inputs=inputs, decision=decision,
        )

    # ------------------------------------------------------------------ hooks

    @property
    @abstractmethod
    def hooks(self) -> list[Hook]:
        """Declared phase residencies. Validated at load time (§9.2)."""

    # -------------------------------------------------------------- lifecycle

    def setup(self, ctx: "SimContext") -> None:
        """Called once per replication before week 1."""

    @abstractmethod
    def on_phase(self, phase: PhaseId, ctx: "SimContext") -> None:
        """Called for each phase the policy declared a hook on."""

    def cost_contribution(self, ctx: "SimContext") -> CostBreakdown:
        """Standing costs assessed at PH-99 (activation costs are charged
        in-phase through ``ctx.cost.add``)."""
        return CostBreakdown()

    def kpi_contribution(self, ctx: "SimContext", t_w: int, window_end: int) -> dict[str, float]:
        """Policy-owned KPI rows (facet 7 — outputs), merged into the
        replication row after the engine KPIs. Computed over the analysis
        window ``[t_w, window_end)``; keys must not collide with engine KPIs."""
        return {}

    def feasibility(self, scenario: "Scenario") -> FeasibilityResult:
        """Engine-enforced composition rules (Part IV §4.6)."""
        return FeasibilityResult.ok()

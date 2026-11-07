# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-C.6 forward_visibility — ANTICIPATION, the committed forward order book. ✅

Context: §III-D.6. A customer commits future orders over a visibility
horizon τ*, so the focal plant can plan procurement against a known forward
schedule instead of a stationary mean — the WSC-2026 MTO assumption. The
world already realizes demand from a pre-drawn schedule (PH-10 mechanic);
this policy is the *information* lever that exposes the forward window to
the plant. Realized demand is unchanged: D_p[t] = D̃_p[t] whether or not
anyone is allowed to look ahead (G-RNG invariance).

Mechanics: ``setup`` publishes τ* as ``ctx.visibility_horizon`` (the
P-S.4 ``detection_lag_override`` pattern), so the week-0 warm start
already sees it; the PH-10 residency re-asserts it. Consumers read the
book through ``ctx.forward_material_demand`` — today that is P-P.1's
``basis="forward_visible"`` (§II.4), the customer/plant two-stage
contract: the customer owns τ* and the schedule, the plant only reads it.

Feasibility (§4.6 rule 1): τ* cannot exceed ``settings.visibility_horizon``
(the schedule is only drawn that far ahead); warns when no plant policy
reads the book (visibility nobody consumes is inert).
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import Field

from scsim.core.context import SimContext
from scsim.core.phases import DEMAND, Hook, PhaseId
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.entities.scenario import Scenario
from scsim.policies.base import (
    FeasibilityIssue,
    FeasibilityResult,
    PolicyParams,
    PolicyPlugin,
)
from scsim.policies.registry import register_plugin


class ForwardVisibilityParams(PolicyParams):
    visibility_horizon: Optional[int] = Field(
        None, ge=1, le=104,
        json_schema_extra={
            "unit": "weeks", "scope": "G/C",
            "notes": "τ* — how far ahead the committed order book is visible to the "
                     "plant. None → settings.visibility_horizon (the schedule length); "
                     "must not exceed it.",
        },
    )


@register_plugin
class ForwardVisibility(PolicyPlugin):
    id: ClassVar[str] = "forward_visibility"
    catalog_ref: ClassVar[str] = "P-C.6"
    stage: ClassVar[Stage] = Stage.CUSTOMER
    strategy_class: ClassVar[StrategyClass] = StrategyClass.ANTICIPATION
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.DEMAND_SIDE
    requires_predeployment: ClassVar[bool] = True
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Customer commits future orders over a visibility horizon τ* (§III-D.6), so the "
        "plant can size coverage against the forward order book instead of a stationary "
        "mean — the customer-side half of the Forward-visible basis (§II.4). Hook: PH-10."
    )
    Params: ClassVar[type[PolicyParams]] = ForwardVisibilityParams
    # Facet 11: the policy makes ONE decision per replication — the horizon the
    # plant may see the order book over — so it records once, at setup (week 0).
    rationale_codes: ClassVar[dict[str, str]] = {
        "horizon_from_params":
            "The customer commits orders over the visibility horizon set on the policy.",
        "horizon_from_settings":
            "No horizon was set on the policy, so the scenario's drawn forward schedule length was used.",
    }

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH10, priority=60,
                reads={DEMAND},
                # Read-only resident after the demand mechanic (priority 50):
                # publishes τ* on the context; the realized demand channel and
                # the schedule itself are never modified.
            ),
        ]

    # ------------------------------------------------------------ feasibility

    def feasibility(self, scenario: Scenario) -> FeasibilityResult:
        p: ForwardVisibilityParams = self.params
        issues: list[FeasibilityIssue] = []
        schedule_len = scenario.settings.visibility_horizon
        if p.visibility_horizon is not None and p.visibility_horizon > schedule_len:
            return FeasibilityResult(False, (FeasibilityIssue(
                "error", "horizon_beyond_schedule",
                f"visibility_horizon ({p.visibility_horizon}w) exceeds the drawn forward "
                f"schedule (settings.visibility_horizon = {schedule_len}w) — the order "
                f"book cannot be seen past where it exists",
            ),))
        inv = scenario.policies.get("inventory_control")
        if inv is not None and inv.get("basis", "days_of_supply") != "forward_visible":
            issues.append(FeasibilityIssue(
                "warning", "no_forward_consumer",
                "no plant policy reads the forward order book (inventory_control basis is "
                "not 'forward_visible') — the visibility investment is inert",
            ))
        return FeasibilityResult(True, tuple(issues))

    # ---------------------------------------------------------------- runtime

    def _tau_star(self, ctx: SimContext) -> int:
        p: ForwardVisibilityParams = self.params
        if p.visibility_horizon is not None:
            return int(p.visibility_horizon)
        return int(ctx.model.settings.visibility_horizon)

    def setup(self, ctx: SimContext) -> None:
        # Published at setup so the week-0 warm start (PH-70 chain) already
        # plans against the book; re-asserted at PH-10 (declared residency).
        ctx.visibility_horizon = self._tau_star(ctx)
        p: ForwardVisibilityParams = self.params
        self.decide(
            ctx,
            rationale="horizon_from_params" if p.visibility_horizon is not None else "horizon_from_settings",
            node_kind="network", node="*",
            inputs={"policy_horizon_weeks": p.visibility_horizon,
                    "schedule_horizon_weeks": int(ctx.model.settings.visibility_horizon)},
            decision={"visibility_horizon_weeks": int(ctx.visibility_horizon)},
        )

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        ctx.visibility_horizon = self._tau_star(ctx)

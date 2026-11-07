# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""P-S.4 early_warning_failover — ANTICIPATION, detection-lag compression. ✅

Context: the scenario's ``settings.detection_lag_weeks`` is the world's
intrinsic disruption-start → firm-knows delay (PH-20). This policy models a
visibility investment (supplier monitoring, tier-1 signal sharing): while it
is enabled the firm detects events after ``detection_lag_weeks`` instead —
never later than the scenario's own lag — and pays ``monitoring_cost`` as a
standing charge whether or not anything ever fails. It makes "what is a week
of warning worth?" a first-class CRN experiment: same world, ± monitoring.

Mechanics: PH-20 serves firm knowledge on demand through
``ctx.events_visible()``; this policy sets ``ctx.detection_lag_override``,
so every reactive consumer (P-S.1 rerouting, P-T.2 expediting, P-P.5
overtime, crisis ``ModeStrip`` values) simply reacts earlier. The policy
performs no failover itself — rerouting stays P-S.1's job (the planned-era
``failover_threshold_weeks`` parameter duplicated P-S.1's
``coverage_threshold_weeks`` and was dropped at implementation).

Feasibility (§4.6 rule 1): warns when the scenario's lag is already ≤ the
monitored lag (the investment buys no earlier knowledge) and when no
knowledge consumer is enabled (earlier detection with nothing to react is
pure cost).
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import Field

from scsim.core.context import SimContext
from scsim.core.phases import DISRUPTION_STATE, FIRM_KNOWLEDGE, Hook, PhaseId
from scsim.entities.enums import ConstraintTag, PolicyStatus, Stage, StrategyClass
from scsim.entities.scenario import Scenario
from scsim.policies.base import (
    CostBreakdown,
    FeasibilityIssue,
    FeasibilityResult,
    PolicyParams,
    PolicyPlugin,
)
from scsim.policies.registry import register_plugin

# Policies whose reactions consume firm knowledge (PH-20 view).
_KNOWLEDGE_CONSUMERS = ("backup_supplier", "expedited_shipments", "short_term_capacity")


class EarlyWarningFailoverParams(PolicyParams):
    detection_lag_weeks: int = Field(
        1, ge=0, le=4,
        json_schema_extra={"unit": "weeks", "scope": "G/S",
                           "notes": "Monitored disruption-start → firm-knows delay; the "
                                    "effective lag is min(this, settings.detection_lag_weeks). "
                                    "Applies to ALL reactive strategies (PH-20)."})
    monitoring_cost: float = Field(
        0.0, ge=0,
        json_schema_extra={"unit": "€/yr", "scope": "G",
                           "notes": "Standing visibility cost, charged weekly (÷52) into "
                                    "C^res whether or not a disruption occurs."})


@register_plugin
class EarlyWarningFailover(PolicyPlugin):
    id: ClassVar[str] = "early_warning_failover"
    catalog_ref: ClassVar[str] = "P-S.4"
    stage: ClassVar[Stage] = Stage.SUPPLIER
    strategy_class: ClassVar[StrategyClass] = StrategyClass.ANTICIPATION
    constraint_targeted: ClassVar[ConstraintTag] = ConstraintTag.RESPONSE_TIME
    requires_predeployment: ClassVar[bool] = True
    status: ClassVar[PolicyStatus] = PolicyStatus.IMPLEMENTED
    summary: ClassVar[str] = (
        "Visibility investments compress disruption-start → firm-knows. Makes 'what is a "
        "week of warning worth?' a first-class experiment. Hook: PH-20."
    )
    Params: ClassVar[type[PolicyParams]] = EarlyWarningFailoverParams
    # Facet 11: the policy makes ONE decision per replication — the detection
    # lag every reactive policy then sees — so it records once, at setup (week 0).
    rationale_codes: ClassVar[dict[str, str]] = {
        "lag_compressed":
            "Monitoring shortened the disruption-start to firm-knows delay below the scenario's own lag.",
        "lag_not_compressed":
            "The scenario's own detection lag was already no longer than the monitored lag, so monitoring bought no earlier warning.",
    }

    @property
    def hooks(self) -> list[Hook]:
        return [
            Hook(
                phase=PhaseId.PH20, priority=60,
                reads={DISRUPTION_STATE}, writes={FIRM_KNOWLEDGE},
                resolution="Compresses the detection lag the mechanic (priority 50) applies "
                           "when serving firm knowledge: effective lag = min(monitored, "
                           "scenario). Later residents see the compressed view.",
            ),
        ]

    # ------------------------------------------------------------ feasibility

    def feasibility(self, scenario: Scenario) -> FeasibilityResult:
        p: EarlyWarningFailoverParams = self.params
        issues: list[FeasibilityIssue] = []
        world_lag = scenario.settings.detection_lag_weeks
        if p.detection_lag_weeks >= world_lag:
            issues.append(FeasibilityIssue(
                "warning", "no_lag_to_compress",
                f"monitored lag ({p.detection_lag_weeks}w) is not below the scenario's "
                f"detection_lag_weeks ({world_lag}w) — the investment buys no earlier "
                f"knowledge in this scenario",
            ))
        if not any(pid in scenario.policies for pid in _KNOWLEDGE_CONSUMERS):
            issues.append(FeasibilityIssue(
                "warning", "no_knowledge_consumer",
                "no reactive policy (P-S.1 / P-T.2 / P-P.5) is enabled — earlier detection "
                "has nothing to react with and contributes only monitoring cost",
            ))
        return FeasibilityResult(True, tuple(issues))

    # ---------------------------------------------------------------- runtime

    def _effective_lag(self, ctx: SimContext) -> int:
        p: EarlyWarningFailoverParams = self.params
        return min(int(p.detection_lag_weeks), int(ctx.model.settings.detection_lag_weeks))

    def setup(self, ctx: SimContext) -> None:
        # Applied at setup so week-1 consumers in earlier phases already see
        # the compressed lag; re-asserted at PH-20 (the declared residency).
        ctx.detection_lag_override = self._effective_lag(ctx)
        p: EarlyWarningFailoverParams = self.params
        world = int(ctx.model.settings.detection_lag_weeks)
        self.decide(
            ctx,
            rationale="lag_compressed" if ctx.detection_lag_override < world else "lag_not_compressed",
            node_kind="network", node="*",
            inputs={"scenario_lag_weeks": world, "monitored_lag_weeks": int(p.detection_lag_weeks)},
            decision={"effective_lag_weeks": int(ctx.detection_lag_override),
                      "monitoring_cost_per_week": float(p.monitoring_cost) / 52.0},
        )

    def on_phase(self, phase: PhaseId, ctx: SimContext) -> None:
        ctx.detection_lag_override = self._effective_lag(ctx)

    def cost_contribution(self, ctx: SimContext) -> CostBreakdown:
        p: EarlyWarningFailoverParams = self.params
        cb = CostBreakdown()
        if p.monitoring_cost > 0:
            cb.add("monitoring", p.monitoring_cost / 52.0)
        return cb

# SCSIM — supply chain simulation library and stress-test framework.
# Copyright (c) 2023-2026 Phu Nguyen. All rights reserved until the open-access
# release; see scsim/NOTICE.md for licensing, funding and citation.
# Developed in part within the ACCURATE project (Horizon Europe, GA 101138269).

"""SCSIM — resilience-grade 3-echelon supply chain simulator.

Operationalizes the methodology of "Synergistic Effects of Combining
Resilience Strategies in Supply Chains" (Nguyen & Ivanov).

Public API:
    from scsim import Scenario, Network, SimulationSettings, DisruptionEvent
    from scsim.core.engine import run_scenario, run_portfolio_study
    from scsim.stress import run_st1, run_st2
    from scsim.io.registry_export import build_registry

`ENGINE_VERSION` is embedded in every result; cross-version comparisons
must be flagged in any UI (Part IX §9.5).
"""

# Engine semantic version. Bump per change-governance tiers (Part IX §9.5):
#   Tier 2 (new variable, behavior-neutral default) -> patch
#   Tier 3 (new phase / contract change)            -> minor or major + ADR
# WHAT each version changed is authored once, in scsim/CHANGELOG.yaml (PLAN.md
# §25, gate `engine-ledger`) — not in a comment here, which the next bump would
# overwrite (§4 D296). A bump without an entry fails CI.
ENGINE_VERSION = "0.9.0"

# WP 15.1 · §4 D294 — ONE version number. The package version IS the engine
# version (pyproject reads it), so `scsim-0.6.1-py3-none-any.whl` and `pip show
# scsim` name the engine inside. It was "0.2.0" through eleven engine versions.
__version__ = ENGINE_VERSION

from scsim.entities.config import SimulationSettings, StatisticsReport  # noqa: E402,F401
from scsim.entities.network import (  # noqa: E402,F401
    BomLine,
    Customer,
    CustomerLink,
    Lane,
    Material,
    Network,
    Product,
    Supplier,
    SupplierLink,
    triangular_av,
)
from scsim.entities.disruption import DisruptionEvent  # noqa: E402,F401
from scsim.entities.scenario import Scenario  # noqa: E402,F401
from scsim.core.engine import RunCancelled  # noqa: E402,F401

/**
 * Every new scenario is seeded here (WP 9.4 slice 5, closes §4 D219).
 *
 * A model card certifies a BASELINE WORLD — the fingerprint hashes exactly
 * `horizon_days`, `time_step` and `demand_model` (`_build_scenario_fingerprint`,
 * fingerprint v1). Inheritance only fires for a scenario whose world matches a
 * card byte for byte, and before this module no scenario the Lab created could:
 * "+" and the stress presets were born at 90 days, the network dialog at 182,
 * while Run & Validate validates at 365. So a new scenario now takes its world
 * from the validated baseline, and nothing else: warm-up and replications are
 * NOT written here — `apply_validation_to_scenario` stays the one definition of
 * inheritance, and it runs after the row exists.
 *
 * Pure: no React, no client. `useScenarios.create(name, seed)` writes the row.
 */
import { SCENARIO_ENGINE_DEFAULTS, type Scenario } from "@/hooks/useScenarios";
import { protocolScenarioFields } from "../../../supabase/functions/_shared/modelRules";

/** Where a new scenario's world came from — said on screen, never assumed. */
export type WorldSource = "validation" | "baseline" | "project_window" | "defaults";

export interface SeedWorld {
  horizon_days: number;
  time_step: Scenario["time_step"];
  demand_model: Scenario["demand_model"];
  source: WorldSource;
}

type Fingerprint = Record<string, unknown> | null | undefined;

/**
 * The world a new scenario starts in: the active card's fingerprint when there
 * is one (that is what was certified), else the baseline row (the world a
 * comparison pairs with), else the engine defaults — with the horizon taken
 * from the project window when the project states one (PLAN.md §4 D318: the
 * window is the authored run length). A fingerprint missing a field falls back
 * per field to the row. A validated or baseline horizon that differs from the
 * window is never rewritten; the Lab says so (`horizonMismatch`).
 */
export function worldOf(
  baseline: Pick<Scenario, "horizon_days" | "time_step" | "demand_model"> | null | undefined,
  cardFingerprint?: Fingerprint,
  windowHorizonDays?: number | null,
): SeedWorld {
  const fp = cardFingerprint ?? null;
  const fromCard =
    !!fp && fp.horizon_days != null && fp.time_step != null && fp.demand_model != null;
  if (fromCard) {
    return {
      horizon_days: Number(fp.horizon_days),
      time_step: fp.time_step as Scenario["time_step"],
      demand_model: fp.demand_model as Scenario["demand_model"],
      source: "validation",
    };
  }
  if (baseline) {
    return {
      horizon_days: baseline.horizon_days,
      time_step: baseline.time_step,
      demand_model: baseline.demand_model,
      source: "baseline",
    };
  }
  const fromWindow = Number(windowHorizonDays) > 0;
  return {
    horizon_days: fromWindow ? Number(windowHorizonDays) : SCENARIO_ENGINE_DEFAULTS.horizon_days,
    time_step: SCENARIO_ENGINE_DEFAULTS.time_step as Scenario["time_step"],
    demand_model: SCENARIO_ENGINE_DEFAULTS.demand_model,
    source: fromWindow ? "project_window" : "defaults",
  };
}

export interface SeedOptions {
  name: string;
  world: SeedWorld;
  /** the baseline row, for the random-number stream a comparison should share */
  baseline?: Pick<Scenario, "seed" | "crn"> | null;
  description?: string;
  primary_kpi?: string;
  disruption_schedule?: Scenario["disruption_schedule"];
  /** a deliberate change of horizon; the scenario then leaves the validated world */
  horizon_days?: number;
  from_network?: boolean;
  /**
   * WP 10.5 — a scenario seeded FROM A VALIDATED MODEL takes the model's run
   * protocol (replications, steady-state week, root seed, CRN, stopping rule), so
   * a run of it is faithful by construction and records no deviation. Keys the
   * model never recorded (a backfilled model's `unknown`) fall back as above.
   */
  protocol?: {
    replications?: number | null;
    warmup_week?: number | null;
    root_seed?: number | null;
    crn?: boolean | null;
    stopping_rule?: string | null;
  } | null;
}

/**
 * The row fields for a new experiment. Same seed and CRN as the baseline, so a
 * difference between the two runs is the change and not the dice (§9.3).
 */
export function buildScenarioSeed(o: SeedOptions): Partial<Scenario> {
  return {
    name: o.name,
    description: o.description ?? "",
    horizon_days: o.horizon_days ?? o.world.horizon_days,
    time_step: o.world.time_step,
    demand_model: o.world.demand_model,
    seed: o.baseline?.seed ?? SCENARIO_ENGINE_DEFAULTS.seed,
    crn: o.baseline?.crn ?? SCENARIO_ENGINE_DEFAULTS.crn,
    primary_kpi: o.primary_kpi ?? SCENARIO_ENGINE_DEFAULTS.primary_kpi,
    disruption_schedule: o.disruption_schedule ?? [],
    recovery_overrides: {},
    role: "experiment",
    ...(o.from_network ? { from_network: true } : {}),
    ...protocolFields(o.protocol),
  };
}

/** Stated once in `_shared/modelRules.ts` (ai-agents.md §27 WP V.1): the chat
 *  seeds a scenario from a Validated Model by the same rule. */
function protocolFields(p: SeedOptions["protocol"]): Partial<Scenario> {
  return protocolScenarioFields(p) as Partial<Scenario>;
}

/** True when the seed keeps the certified world, so inheritance can match it. */
export function keepsValidatedWorld(seed: Partial<Scenario>, world: SeedWorld): boolean {
  return (
    world.source === "validation" &&
    seed.horizon_days === world.horizon_days &&
    seed.time_step === world.time_step &&
    JSON.stringify(seed.demand_model) === JSON.stringify(world.demand_model)
  );
}

/** A name not already taken in the project ("Scenario 3", "Scenario 3 (2)"). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const set = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!set.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const c = `${base} (${i})`;
    if (!set.has(c.toLowerCase())) return c;
  }
  return `${base} (${Date.now()})`;
}

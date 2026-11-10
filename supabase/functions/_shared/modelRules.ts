// The Validated Model's rules, ONE statement for the Lab and the chat
// (ai-agents.md §27 WP V.1).
//
// These were authored in `src/lib/sim/labModel.ts`, `validatedModel.ts` and
// `scenarioSeed.ts` for the Simulation Lab. The chat skills (§26) had no
// access to them and so ran experiments that ignored the model entirely. They
// live here now — dependency-free, so they run unchanged in Deno and in the
// browser — and the Lab modules RE-EXPORT them (the `disruptionRules.ts`
// pattern): one rule, two surfaces, no second author.

// ── which model ─────────────────────────────────────────────────────────────

export interface ModelLike {
  id: string;
  status: string;
  verdict?: string | null;
  validated_at?: string | number | null;
}

/** The models offered: active and validated, newest first. A superseded or
 *  revoked model is history — reachable by link, never offered. */
export function modelChoices<T extends ModelLike>(cards: T[]): T[] {
  const at = (c: T) => c.validated_at ?? "";
  return cards
    .filter((c) => c.status === "active" && c.verdict === "validated")
    .sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
}

/** The model chosen when the user has not chosen: the linked one if this
 *  project has it (any status), else the newest active model, else none. */
export function defaultModel<T extends ModelLike>(allCards: T[], linked: string | null): T | null {
  if (linked) {
    const hit = allCards.find((c) => c.id === linked);
    if (hit) return hit;
  }
  return modelChoices(allCards)[0] ?? null;
}

// ── drift, in words ─────────────────────────────────────────────────────────

export function driftReasons(drift: string[]): string[] {
  return [
    // WP 11.2 · §4 D259 — `data` is the simulation's INPUTS (the scope the engine
    // reads); a deep-tier change is a note, never this.
    drift.includes("data") ? "the simulation's inputs changed" : null,
    drift.includes("policy") ? "a newer policy exists" : null,
    drift.includes("scenario") ? "the scenario's world changed" : null,
    drift.includes("engine") ? "the engine changed" : null,
  ].filter((x): x is string => x !== null);
}

// ── what may be offered for a run of the model (PLAN.md §23 WP 13.3) ────────

export type ModelRunOffer =
  | { kind: "faithful" }
  | { kind: "moved"; replayable: boolean; note: string }
  | { kind: "blocked"; reason: string };

export function modelRunOffer(
  card: { status: string; dataset_version_id?: string | null },
  credibility: { state: string; drift?: string[] } | null,
): ModelRunOffer {
  if (card.status !== "active") {
    return { kind: "blocked", reason: "This model is no longer in force — choose the one that is." };
  }
  const drift = credibility?.state === "stale" ? credibility.drift ?? [] : [];
  if (drift.includes("scenario") || drift.includes("engine")) {
    return {
      kind: "blocked",
      reason: `${driftReasons(drift.filter((d) => d !== "data")).join(" and ")} since this model was validated — re-validate it in Policies first.`.replace(/^./, (c) => c.toUpperCase()),
    };
  }
  if (drift.includes("data")) {
    return card.dataset_version_id
      ? {
          kind: "moved",
          replayable: true,
          note: "Your project's data changed since this model was validated. A run of the model replays the data it was validated on; run current data to see today's numbers as an exploratory run.",
        }
      : {
          kind: "moved",
          replayable: false,
          note: "Your project's data changed since this model was validated, and this model does not name the data version it was validated on — it cannot be replayed. Run current data as exploratory, or re-validate.",
        };
  }
  return { kind: "faithful" };
}

// ── deviations from the protocol ────────────────────────────────────────────

export interface ProtocolLike {
  replications?: number | null;
  root_seed?: number | null;
  crn?: boolean | null;
  warmup_week?: number | null;
  horizon_weeks?: number | null;
  stopping_rule?: string | null;
}

/** The scenario fields a run actually uses for the protocol's keys. */
export interface ScenarioRunSettings {
  replications: number;
  horizon_days: number;
  seed: number;
  crn: boolean;
  warmup_mode?: string | null;
  warmup_days?: number | null;
  stopping_rule?: { kind?: string } | null;
}

export interface Deviation {
  key: "replications" | "horizon_weeks" | "warmup_week" | "root_seed" | "crn" | "stopping_rule";
  label: string;
  model: string | number | boolean | null;
  run: string | number | boolean | null;
}

/** What a run of `scenario` would deviate from `protocol`. Empty = faithful. A
 *  protocol key the model never recorded is not a deviation — there is nothing
 *  to deviate from — and is not invented here. */
export function protocolDeviations(
  protocol: ProtocolLike | null | undefined,
  scenario: ScenarioRunSettings,
): Deviation[] {
  if (!protocol) return [];
  const out: Deviation[] = [];
  const cmp = (key: Deviation["key"], label: string, model: unknown, run: unknown) => {
    if (model === null || model === undefined) return;
    if (model !== run) {
      out.push({ key, label, model: model as Deviation["model"], run: (run ?? null) as Deviation["run"] });
    }
  };
  cmp("replications", "Replications", protocol.replications, scenario.replications);
  cmp("horizon_weeks", "Horizon (weeks)", protocol.horizon_weeks, Math.ceil(scenario.horizon_days / 7));
  // An `auto` warm-up is detected per run; only a manual one states a week.
  if (scenario.warmup_mode !== "auto") {
    cmp("warmup_week", "Steady state from (week)", protocol.warmup_week,
      Math.round(Number(scenario.warmup_days ?? 0) / 7));
  } else if (protocol.warmup_week != null) {
    out.push({ key: "warmup_week", label: "Steady state from (week)", model: protocol.warmup_week, run: "detected per run" });
  }
  cmp("root_seed", "Root seed", protocol.root_seed, scenario.seed);
  cmp("crn", "Common random numbers", protocol.crn, scenario.crn);
  cmp("stopping_rule", "Stopping rule", protocol.stopping_rule, scenario.stopping_rule?.kind ?? "fixed_horizon");
  return out;
}

/** The deviations as the run row stores them (`protocol_overrides`): key → the
 *  value the run used. `{}` = faithful. */
export function overridesOf(devs: Deviation[]): Record<string, unknown> {
  return Object.fromEntries(devs.map((d) => [d.key, d.run]));
}

// ── a scenario seeded from the model ────────────────────────────────────────

/** The scenario fields a model's protocol fixes (WP 10.5): a scenario seeded
 *  from a Validated Model takes them, so its run is faithful by construction. */
export function protocolScenarioFields(p: ProtocolLike | null | undefined): Record<string, unknown> {
  if (!p) return {};
  const out: Record<string, unknown> = {};
  if (p.replications != null) out.replications = p.replications;
  if (p.warmup_week != null) {
    out.warmup_mode = "manual";
    out.warmup_days = p.warmup_week * 7;
  }
  if (p.root_seed != null) out.seed = p.root_seed;
  if (p.crn != null) out.crn = p.crn;
  if (p.stopping_rule === "fixed_horizon" || p.stopping_rule === "ci_halfwidth") {
    out.stopping_rule = { kind: p.stopping_rule };
  }
  return out;
}

/** The protocol a card states. A card older than protocols (WP 10.3) carries
 *  only its adopted warm-up and recommended replications — those two keys are
 *  then the whole protocol, and nothing else is invented. */
export function cardProtocol(card: Record<string, unknown>): ProtocolLike {
  const p = card.protocol && typeof card.protocol === "object" ? (card.protocol as Record<string, unknown>) : null;
  const unknown = new Set(Array.isArray(p?.unknown) ? (p!.unknown as string[]) : []);
  const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  if (p) {
    const key = (k: string) => (unknown.has(k) ? null : p[k]);
    return {
      replications: num(key("replications")),
      root_seed: num(key("root_seed")),
      crn: typeof key("crn") === "boolean" ? (key("crn") as boolean) : null,
      warmup_week: num(key("warmup_week")),
      horizon_weeks: num(key("horizon_weeks")),
      stopping_rule: typeof key("stopping_rule") === "string" ? (key("stopping_rule") as string) : null,
    };
  }
  const warm = num(card.adopted_warmup_days);
  return {
    replications: num(card.recommended_replications),
    warmup_week: warm === null ? null : Math.round(warm / 7),
  };
}

// ── the scenario a chat experiment creates (ai-agents.md §27 WP V.3) ────────

export interface SeedScenarioLike {
  horizon_days?: number | null;
  time_step?: string | null;
  demand_model?: unknown;
  seed?: number | null;
  crn?: boolean | null;
  warmup_mode?: string | null;
  warmup_days?: number | null;
  stopping_rule?: unknown;
}

/** The world + random-number fields a new scenario copies from the scenario
 *  it is seeded from (the model's baseline, or the project's baseline row):
 *  the same world, and the same dice, so a difference is the change (§9.3). */
export function seedWorldFields(
  seed: SeedScenarioLike | null | undefined,
  fingerprint?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fp = fingerprint ?? null;
  const pick = (k: keyof SeedScenarioLike) => {
    const v = fp && fp[k as string] != null && ["horizon_days", "time_step", "demand_model"].includes(k as string)
      ? fp[k as string]
      : seed?.[k];
    if (v !== null && v !== undefined) out[k as string] = v;
  };
  for (const k of ["time_step", "demand_model", "seed", "crn", "warmup_mode", "warmup_days", "stopping_rule"] as const) pick(k);
  return out;
}

/** The fields of a scenario that FOLLOWS a Validated Model, and what it
 *  deviates from the model's protocol. The spec's own horizon and
 *  replications win — they are what the reviewer approved — and any
 *  difference from the protocol is returned as a deviation, never hidden. */
export function scenarioFromModel(
  protocol: ProtocolLike,
  seed: SeedScenarioLike | null | undefined,
  fingerprint: Record<string, unknown> | null | undefined,
  spec: { horizon_days: number; replications: number },
): { fields: Record<string, unknown>; deviations: Deviation[] } {
  const fields: Record<string, unknown> = {
    ...seedWorldFields(seed, fingerprint),
    ...protocolScenarioFields(protocol),
    horizon_days: spec.horizon_days,
    replications: spec.replications,
  };
  const stop = fields.stopping_rule as { kind?: string } | undefined;
  const deviations = protocolDeviations(protocol, {
    replications: spec.replications,
    horizon_days: spec.horizon_days,
    seed: Number(fields.seed ?? 42),
    crn: fields.crn === undefined ? true : Boolean(fields.crn),
    warmup_mode: (fields.warmup_mode as string | undefined) ?? "auto",
    warmup_days: (fields.warmup_days as number | undefined) ?? null,
    stopping_rule: stop ?? null,
  });
  return { fields, deviations };
}

/** How a model is named to a person: its code and name, else a short id. */
export function modelDisplayName(card: Record<string, unknown>): string {
  const code = typeof card.model_code === "string" && card.model_code ? card.model_code : "";
  const name = typeof card.name === "string" && card.name ? card.name : "";
  if (code && name) return `${code} · ${name}`;
  return code || name || `validated model ${String(card.id).slice(0, 8)}`;
}

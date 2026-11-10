// Which Validated Model a chat experiment follows, and whether it may
// (ai-agents.md §27 WP V.2).
//
// The platform's storyline is data → policy version → baseline → VALIDATED
// MODEL → experiments that follow the model → comparison against the model's
// own baseline. The chat skills used to skip the model entirely. This module
// resolves it by the Lab's own rules (`_shared/modelRules.ts`) and turns the
// result into ONE decision per ask:
//
//   follow   run the model's versions and protocol (a validated result)
//   explore  an exploratory run — only when the user asked for one
//   stop     say why, and what the user can choose or do next
//
// Owner decisions 2026-11-09 (§27.3/§27.8): with no model, exploratory is
// allowed only on explicit request; when the project drifted from the model
// the chat STOPS AND ASKS every time — it never picks a mode for the user.

import type { ToolContext } from "./tools.ts";
import { currentHashes } from "./vvTools.ts";
import {
  cardProtocol,
  driftReasons,
  modelChoices,
  modelDisplayName,
  modelRunOffer,
  type ModelRunOffer,
  type ProtocolLike,
} from "../_shared/modelRules.ts";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };

export type RunMode = "model" | "exploratory";

/** What the user said about HOW to run, in their own words. */
export interface RunChoice {
  mode: RunMode | null;
  extendHorizon: boolean;
}

const EXPLORATORY_WORDS =
  /\b(explorator\w*|run\s+it\s+anyway|anyway|(?:with|on|use|using)\s+(?:the\s+)?(?:current|new|newest|latest|today'?s)\s+(?:data|polic\w+)|current\s+(?:data|polic\w+)|new\s+polic\w+)\b/i;
const MODEL_WORDS =
  /\b(as\s+validated|validated\s+(?:model|data|polic\w+|versions?)|replay(?:\s+the)?(?:\s+validated)?|follow\s+the\s+model|use\s+the\s+(?:validated\s+)?model)\b/i;
const EXTEND_WORDS = /\b(extend(?:ed|ing)?\s+(?:the\s+)?(?:horizon|run|simulation)|longer\s+(?:horizon|run|simulation))\b/i;

export function parseRunChoice(text: string): RunChoice {
  const t = String(text ?? "");
  return {
    mode: MODEL_WORDS.test(t) ? "model" : EXPLORATORY_WORDS.test(t) ? "exploratory" : null,
    extendHorizon: EXTEND_WORDS.test(t),
  };
}

export interface ScenarioWorldRow {
  id: string;
  name?: string;
  horizon_days?: number;
  time_step?: string;
  demand_model?: unknown;
  seed?: number;
  crn?: boolean;
  warmup_mode?: string;
  warmup_days?: number;
  replications?: number;
  stopping_rule?: unknown;
  disruption_schedule?: Array<Record<string, unknown>>;
  recovery_overrides?: Record<string, unknown>;
}

export interface ModelContext {
  /** The model in force, or null when the project has none. */
  card: Record<string, unknown> | null;
  /** How the model is named to the user. */
  name: string;
  protocol: ProtocolLike;
  /** What moved since validation: "policy", "data". */
  drift: string[];
  offer: ModelRunOffer | null;
  /** The scenario the model's evidence run simulated — its baseline. */
  evidenceScenario: ScenarioWorldRow | null;
  evidenceRunId: string | null;
  /** The model's horizon in days (its fingerprint, else its baseline's). */
  horizonDays: number | null;
}


/** Resolve the project's model. `utterance` may name one ("use model X"). */
export async function resolveModelContext(ctx: ToolContext, utterance = ""): Promise<ModelContext> {
  const db = ctx.supabase as unknown as Db;
  const none: ModelContext = {
    card: null, name: "", protocol: {}, drift: [], offer: null, evidenceScenario: null, evidenceRunId: null, horizonDays: null,
  };
  let cards: Array<Record<string, unknown>> = [];
  try {
    const { data } = await db.rpc("list_model_validations", { p_project_id: ctx.projectId });
    cards = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  } catch {
    return none;
  }
  const choices = modelChoices(cards as Array<{ id: string; status: string; verdict?: string; validated_at?: string | number }>) as Array<Record<string, unknown>>;
  if (choices.length === 0) return none;
  // "use model X": a model the user names by its name or code wins.
  const lower = utterance.toLowerCase();
  const named = choices.find((c) =>
    [c.name, c.model_code].some((v) => typeof v === "string" && v.length >= 3 && lower.includes(v.toLowerCase()))
  );
  const card = named ?? choices[0];

  // Drift against the live project — the rule behind the §9.5 badge
  // (vvTools.deriveValidationBadge / useModelValidation.deriveCredibility).
  const hashes = await currentHashes(db, ctx.projectId);
  const drift: string[] = [];
  if (hashes.policy !== "unknown" && String(card.policy_hash) !== hashes.policy) drift.push("policy");
  const sim = typeof card.hash_simulation === "string" && card.hash_simulation ? card.hash_simulation : null;
  if (sim !== null) {
    if (hashes.simulation !== "unknown" && sim !== hashes.simulation) drift.push("data");
  } else if (hashes.graph !== "unknown" && String(card.graph_hash) !== hashes.graph) drift.push("data");
  const offer = modelRunOffer(
    { status: String(card.status), dataset_version_id: (card.dataset_version_id as string | null) ?? null },
    { state: drift.length ? "stale" : "validated", drift },
  );

  // The model's baseline: the scenario its evidence run simulated.
  let evidenceScenario: ScenarioWorldRow | null = null;
  const evidenceRunId = typeof card.evidence_run_id === "string" ? card.evidence_run_id : null;
  if (evidenceRunId) {
    try {
      const { data: run } = await db.from("simulation_runs").select("id,scenario_id").eq("id", evidenceRunId).maybeSingle();
      const sid = (run as Record<string, unknown> | null)?.scenario_id;
      if (sid) {
        const { data: sc } = await db.from("scenarios").select("*").eq("id", sid).maybeSingle();
        evidenceScenario = (sc as ScenarioWorldRow | null) ?? null;
      }
    } catch { /* the model still stands; its baseline row is unknown */ }
  }
  const protocol = cardProtocol(card);
  const fp = (card.scenario_fingerprint ?? null) as Record<string, unknown> | null;
  const horizonDays = protocol.horizon_weeks != null
    ? protocol.horizon_weeks * 7
    : Number(fp?.horizon_days) > 0
    ? Number(fp!.horizon_days)
    : Number(evidenceScenario?.horizon_days) > 0
    ? Number(evidenceScenario!.horizon_days)
    : null;
  return { card, name: modelDisplayName(card), protocol, drift, offer, evidenceScenario, evidenceRunId, horizonDays };
}

export type RunDecision =
  | { kind: "follow"; note: string | null }
  | { kind: "explore"; why: string }
  | { kind: "stop"; code: "no_model" | "needs_choice" | "model_blocked"; message: string };

const VALIDATE_HOW =
  "Validate your baseline first: Policies → Run & Validate (or ask me \"what does it take to validate my model?\").";

/** The ONE decision per ask (see header). */
export function decideRun(model: ModelContext, choice: RunChoice): RunDecision {
  if (!model.card) {
    if (choice.mode === "exploratory") {
      return { kind: "explore", why: "this project has no Validated Model" };
    }
    return {
      kind: "stop",
      code: "no_model",
      message: "This project has no Validated Model yet, so a run now would be an unvalidated number, not a result. " +
        `${VALIDATE_HOW} If you want a rough look anyway, say "run it anyway as exploratory" — it will be labelled exploratory.`,
    };
  }
  const offer = model.offer!;
  if (offer.kind === "blocked") {
    if (choice.mode === "exploratory") return { kind: "explore", why: offer.reason.replace(/\.$/, "") };
    return {
      kind: "stop",
      code: "model_blocked",
      message: `${offer.reason} Until then I can only run this as exploratory — say "run it as exploratory" if you want that.`,
    };
  }
  if (model.drift.length === 0) {
    return choice.mode === "exploratory"
      ? { kind: "explore", why: "you asked for an exploratory run" }
      : { kind: "follow", note: null };
  }
  // Drifted: the user chooses, every time (owner decision 3).
  const what = driftReasons(model.drift).join(" and ");
  const replayable = !(offer.kind === "moved" && !offer.replayable);
  if (choice.mode === "exploratory") return { kind: "explore", why: `${what} since "${model.name}" was validated` };
  if (choice.mode === "model") {
    if (!replayable) {
      return {
        kind: "stop",
        code: "needs_choice",
        message: `"${model.name}" can't be run as validated: ${what}, and the model doesn't record the data version it was validated on. ` +
          `Say "run it as exploratory", or re-validate. ${VALIDATE_HOW}`,
      };
    }
    return {
      kind: "follow",
      note: `Run as validated: this uses the data and policies "${model.name}" was validated with, not the project's current ones (${what}).`,
    };
  }
  return {
    kind: "stop",
    code: "needs_choice",
    message: `Before I set this up: ${what} since "${model.name}" was validated. How do you want to run it?\n` +
      (replayable ? `- "run as validated" — the model's own data and policies (a validated result about the validated setup)\n` : "") +
      `- "run as exploratory" — the project's current data and policies (labelled exploratory, not a validated result)\n` +
      `- or re-validate first. ${VALIDATE_HOW}`,
  };
}

// §21.5 turn budgets (Phase H3, D4/Q35 — the normative table). Budgets ship
// UNFLAGGED: they only *bound*, and the DEFAULTs below are generous enough
// that pre-H3 single-turn behavior never hits them (the worst legal pre-H3
// request is 4 LLM calls: router + agent + persona/wrap-up + one verifier
// retry — pinned by the golden-transcript suite). Three families, three
// failure modes: MAX_HOPS bounds one LLM's tool loop (providers.ts, a
// model-quality guard); the request budgets here bound the orchestration (a
// cost/latency guard); the plan budgets (planTools.ts) bound the multi-turn
// arc (an autonomy guard).
//
// Budgets are SPEND METERS WITH HONEST EXHAUSTION, never silent truncation:
// every denial produces a reply that names the exhausted meter, and every
// chat.reply telemetry event carries the spend
// ({llm_calls, tool_calls, wall_ms, budget_hit} — §7.7-4 tests them).

/** Provider calls per request: 1 router + ≤ 2 step turns + ≤ 1 persona
 * wrap-up + ≤ 1 verifier corrective retry, plus headroom. Summary/judge calls
 * are excluded (separately capped fire-and-forget — they never receive the
 * budget).
 *
 * This was 4, which is exactly the cost of the worst legal request
 * (router + agent + wrap-up + verifier retry). At 4 the meter had zero slack:
 * any additional call — the failure-path persona turn, a second corrective
 * retry — exhausted the budget and returned the canned exhaustion line
 * instead of an answer, and the exhaustion was reached most often on exactly
 * the multi-step asks the agents exist to serve. 6 keeps the meter a real
 * cost guard while leaving the normal path two calls of headroom. */
export const MAX_LLM_CALLS_PER_REQUEST = 6;
/** Executed tool calls per request (consumed by executeTool via ToolContext). */
export const MAX_TOOL_CALLS_PER_REQUEST = 15;
/** Summed completion chars per request (checked after each LLM call). */
export const MAX_COMPLETION_CHARS_PER_REQUEST = 48_000;
/** Soft wall budget per request, checked between LLM calls and between hops
 * (headroom under the platform edge ceiling — no timeout is configured in
 * supabase/config.toml; the ceiling is a platform property). The §20.5
 * provider-retry wait counts against it (real elapsed time). */
export const WALL_BUDGET_MS = 60_000;

export type BudgetHit = null | "hops" | "llm_calls" | "tool_calls" | "output" | "wall";

export interface RequestBudget {
  maxLlmCalls: number;
  maxToolCalls: number;
  maxCompletionChars: number;
  wallBudgetMs: number;
  llmCalls: number;
  toolCalls: number;
  completionChars: number;
  startedAt: number;
  /** Injectable clock (§7.7-4: the wall tests run on a mocked clock). */
  now: () => number;
  /** First meter that ran out this request (null = none). Once set it stays
   * set — the chat.reply payload records the first exhaustion. */
  budgetHit: BudgetHit;
}

export function makeRequestBudget(overrides?: Partial<
  Pick<RequestBudget, "maxLlmCalls" | "maxToolCalls" | "maxCompletionChars" | "wallBudgetMs" | "now">
>): RequestBudget {
  const now = overrides?.now ?? (() => Date.now());
  return {
    maxLlmCalls: overrides?.maxLlmCalls ?? MAX_LLM_CALLS_PER_REQUEST,
    maxToolCalls: overrides?.maxToolCalls ?? MAX_TOOL_CALLS_PER_REQUEST,
    maxCompletionChars: overrides?.maxCompletionChars ?? MAX_COMPLETION_CHARS_PER_REQUEST,
    wallBudgetMs: overrides?.wallBudgetMs ?? WALL_BUDGET_MS,
    llmCalls: 0,
    toolCalls: 0,
    completionChars: 0,
    startedAt: now(),
    now,
    budgetHit: null,
  };
}

export function wallMs(b: RequestBudget): number {
  return Math.max(0, b.now() - b.startedAt);
}

function markHit(b: RequestBudget, hit: Exclude<BudgetHit, null>): void {
  if (b.budgetHit === null) b.budgetHit = hit;
}

/** Checked between LLM calls (§21.5): wall and output exhaustion stop the
 * request from issuing another call; the llm_calls cap denies the call
 * itself. Returns false (and records the hit) on any denial. */
export function tryConsumeLlmCall(b: RequestBudget): boolean {
  if (wallMs(b) > b.wallBudgetMs) {
    markHit(b, "wall");
    return false;
  }
  if (b.completionChars >= b.maxCompletionChars) {
    markHit(b, "output");
    return false;
  }
  if (b.llmCalls >= b.maxLlmCalls) {
    markHit(b, "llm_calls");
    return false;
  }
  b.llmCalls += 1;
  return true;
}

/** Consumed by executeTool via the per-request counter in ToolContext. On
 * exhaustion the tool returns a `too_large`-style envelope (note "budget")
 * and the model must wrap up. */
export function tryConsumeToolCall(b: RequestBudget): boolean {
  if (b.toolCalls >= b.maxToolCalls) {
    markHit(b, "tool_calls");
    return false;
  }
  b.toolCalls += 1;
  return true;
}

/** Recorded after each LLM call completes (§21.5 "index.ts after each call"). */
export function noteCompletion(b: RequestBudget, chars: number): void {
  b.completionChars += Math.max(0, chars);
  if (b.completionChars >= b.maxCompletionChars) markHit(b, "output");
}

/** The between-hops wall check (providers.ts loop): finish the current step,
 * never start another. */
export function wallExceeded(b: RequestBudget): boolean {
  if (wallMs(b) > b.wallBudgetMs) {
    markHit(b, "wall");
    return true;
  }
  return false;
}

/** §21.5 wall wrap-up reserve (v1.6, ai-agents.md §20.8). The wall was
 * checked only once it was ALREADY spent, so a turn that ran out of time
 * returned the canned line plus raw tool tables — every read it paid for,
 * unread by anyone. The loop now stops starting tool hops this long BEFORE
 * the wall and spends the reserve on one tool-free closing completion that
 * answers from the results it has (the MAX_HOPS wrap-up, applied to time). */
export const WRAP_UP_RESERVE_MS = 15_000;
/** How far past the soft wall the closing completion may still START — the
 * wall is soft headroom under the platform ceiling (§21.5), and a slow hop
 * that overshoots should still get its answer written rather than discarded. */
export const WRAP_UP_GRACE_MS = 30_000;

function reserveMs(b: RequestBudget): number {
  return Math.min(WRAP_UP_RESERVE_MS, b.wallBudgetMs / 4);
}

/** Between hops: true (and the wall hit recorded) once the remaining wall is
 * inside the wrap-up reserve — start no further tool hop. */
export function wallWrapUpDue(b: RequestBudget): boolean {
  if (wallMs(b) > b.wallBudgetMs - reserveMs(b)) {
    markHit(b, "wall");
    return true;
  }
  return false;
}

/** Whether the closing completion may still start. Past this, the honest
 * exhaustion line alone ships (nothing is guessed, nothing is hidden). */
export function wallWrapUpAffordable(b: RequestBudget): boolean {
  return wallMs(b) <= b.wallBudgetMs + Math.min(WRAP_UP_GRACE_MS, b.wallBudgetMs / 2);
}

/** Appended by the SERVER to a wall wrap-up answer, so the user is still told
 * which meter stopped the work (§21.5: never silent truncation). */
export const WALL_WRAPUP_NOTE =
  "_I stopped looking things up at this request's time budget, so this answer uses only what I had already read. " +
  "Ask a narrower follow-up if you need more._";

/** Told to the model on the closing completion after a wall stop. */
export const WALL_WRAP_UP_INSTRUCTION =
  "You are out of time for tool steps on this request. Do not call any more tools. " +
  "Answer the question now using only the tool results you already received, in 2-5 sentences. " +
  "If they are not enough for a grounded answer, say exactly what is missing — never guess.";

/** §21.5 honest exhaustion — the user is told WHICH meter ran out and that
 * work remains undone; never silent truncation. */
export const BUDGET_EXHAUSTED_LINES: Record<Exclude<BudgetHit, null>, string> = {
  hops:
    "I ran out of steps on that one. Try narrowing the question.",
  llm_calls:
    "I stopped at this request's model-call budget — the remaining work is not done. " +
    "Ask again to continue from here.",
  tool_calls:
    "I stopped at this request's tool-call budget — the remaining work is not done. " +
    "Ask again to continue from here.",
  output:
    "I stopped at this request's output budget — the remaining work is not done. " +
    "Ask again to continue from here.",
  wall:
    "I stopped at this request's time budget — the remaining work is not done. " +
    "Ask again to continue from here.",
};

export function budgetExhaustedLine(hit: BudgetHit): string {
  return hit ? BUDGET_EXHAUSTED_LINES[hit] : BUDGET_EXHAUSTED_LINES.llm_calls;
}

/** The chat.reply spend payload (§21.5: every chat.reply event carries it). */
export function budgetTelemetryPayload(b: RequestBudget): {
  llm_calls: number;
  tool_calls: number;
  wall_ms: number;
  budget_hit: BudgetHit;
} {
  return {
    llm_calls: b.llmCalls,
    tool_calls: b.toolCalls,
    wall_ms: wallMs(b),
    budget_hit: b.budgetHit,
  };
}

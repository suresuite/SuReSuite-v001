// project-ai-chat — the single conversational surface (Layer A) plus the
// Stage 0 agent plumbing (ai-agents.md §9.1): telemetry, router seam,
// server-side capability re-check. The legacy non-tools mode (anonymized
// abstract chat) is REMOVED — every request must send mode:"tools".
// With AGENT_TELEMETRY_ENABLED / AGENT_ROUTER_ENABLED / CHAT_STORE_ENABLED
// unset, behavior is byte-identical to pre-Stage-0 Layer A (pinned by
// eval/golden_transcript_test.ts).

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { runChat, resolveModel, type ChatRunResult, type ChatTurn,
  isKnownModelId,
  isHiddenModelId,
} from "./providers.ts";
import { makeToolContext, type ToolContext, type ToolDeclaration, type ToolEnvelope } from "./tools.ts";
// H2 (§6.6 rule 1): the cache reads that join the persona surface when the
// router marks an ask cache_checkable. Pure reads — no approval involved.
import { findCompletedRunDeclaration } from "./experimentTools.ts";
import { getRunResultsDeclaration, getValidationStatusDeclaration } from "./vvTools.ts";
// H1 (ai-agents.md §19.3/§22.3): the coverage-expanded persona read surface
// and the pre-send verifier. Both flags default off ⇒ byte-identical pre-H1
// behavior (personaToolDeclarations() returns the unchanged toolDeclarations;
// the verifier never runs).
import { personaToolDeclarations } from "./personaTools.ts";
import {
  verifierEnabled,
  verifyWithRetry,
  type RecordedToolCall,
  type VerifyWithRetryResult,
} from "./verifier.ts";
import { canonicalJson, makeTelemetry, sha256Hex, telemetryEnabled } from "./telemetry.ts";
import {
  decideRoute,
  deploymentEnabledAgents,
  makeClassifier,
  OFFER_CHIP_TEXT,
  AGENT_NOT_ENABLED_TEXT,
  resolveRoutedUtterance,
  routerEnabled,
} from "./router.ts";
// §20.8 (v1.6): the deterministic what-if loop — a disruption what-if is
// parsed, resolved, cache-checked BY CONTENT and proposed in code; the model
// only interprets a hit. Kill switch WHATIF_LOOP_ENABLED (default on).
import { whatIfRouteDecision } from "./whatIf.ts";
// §26 Phase M (v1.7): the modeler skills — fixed procedures in code for the
// modeler's tasks (what-if, mitigation study, sensitivity, results, readiness,
// setup, how-to, explain, capabilities). Kill switch MODELER_SKILLS.
import { matchSkill, skillById } from "./skills/index.ts";
import { closeSkillPlan, parseSkillNote, resumeInput, runSkillTurn, waitSkillPlanOn } from "./skills/runner.ts";
// Importing agentTurn.ts registers the staged draft tools (draftTools.ts,
// configuratorTools.ts, vvTools.ts, memory.ts) into the shared executeTool
// registry (ai-agents.md §9.2–§9.4, §14.7).
import { AGENT_TURNS, buildWrapupMessage, mixedHandoffNote, runAgentTurn } from "./agentTurn.ts";
import {
  applyModeToRoute,
  MODE_NOTICE_TEXT,
  modeNoticePart,
  resolveThreadMode,
} from "./modes.ts";
import { buildSuggestions, suggestionsEnabled } from "./suggestions.ts";
import {
  loadThreadSummary,
  refreshThreadSummary,
  shouldRefreshSummary,
  summariesEnabled,
} from "./summaries.ts";
import {
  detectDecisionShape,
  detectExplicitMemoryRequest,
  memoryEnabled,
  saveExplicitMemory,
} from "./memory.ts";
// H3 (ai-agents.md §21): the plan harness — the §21.4 resume pre-step (a
// client-caused turn carrying resume_plan_id; zero LLM while the run is
// queued/running), the §21.3 integrity sweep after every plan-touching turn,
// and the §21.5 request budgets (unflagged spend meters with honest
// exhaustion; DEFAULTs generous enough that pre-H3 single-turn behavior
// never hits them — golden-transcript pinned).
import {
  markPlanStepFailed,
  planPart,
  planToolEnabled,
  runResumePreStep,
  stepsByStatus,
  sweepPlanIntegrity,
} from "./planTools.ts";
import {
  budgetTelemetryPayload,
  makeRequestBudget,
  tryConsumeLlmCall,
} from "./budgets.ts";
// H4 (ai-agents.md §23.4): the capability-matrix gate at the routing
// boundary. MODEL_MATRIX_ENABLED default off ⇒ the matrix is never read and
// behavior is byte-identical H3 (golden-transcript pinned).
import { checkMatrixGate, matrixEnabled, routedCapabilityIds } from "./matrix.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Client model id → ai_models.code, mirroring src/lib/capabilities.ts
// CHAT_MODEL_CODES (the server-side re-check speaks the DB vocabulary).
const CHAT_MODEL_CODES: Record<string, string> = {
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gpt-5': 'openai/gpt-5',
  'gpt-5-mini': 'openai/gpt-5-mini',
  'deepseek-chat': 'deepseek/deepseek-chat',
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Parse the request body up-front so any parse/validation failure can return a
  // structured 200 (supabase-js `invoke` discards the body of non-2xx responses,
  // which would collapse the real reason into the generic "Edge Function returned
  // a non-2xx status code" string).
  let body: any = {};
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({ error: 'Invalid JSON body.', type: 'BAD_REQUEST' });
  }
  const { projectId, message, conversationHistory, userId, userEmail, mode, model, agentId, threadId, threadMode } = body;

  // §17.3 suggested actions: mode:"suggest" is a deterministic, capability-
  // filtered project read — no LLM. Flag off ⇒ the request falls through to
  // the standard validation below (byte-identical pre-§17.3 behavior).
  if (mode === 'suggest' && suggestionsEnabled()) {
    if (!userId || !userEmail) {
      return jsonResponse({ error: 'Missing required parameters: userId, userEmail', type: 'BAD_REQUEST' });
    }
    if (!projectId) return jsonResponse({ suggestions: [] });
    try {
      const sbClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      );
      const sbAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      );
      const { error: accessErr } = await sbClient.rpc('get_project_dataset_counts', {
        p_project_id: projectId,
        p_user_id: userId,
        p_user_email: userEmail,
      });
      if (accessErr) {
        return jsonResponse({ error: "You don't have access to this project.", type: 'FORBIDDEN' });
      }
      const { data: caps } = await sbAdmin.rpc('get_my_capabilities', { _user_id: userId });
      const c = (caps ?? {}) as Record<string, unknown>;
      const features = (c.features as Record<string, boolean>) ?? {};
      const isSuper = Boolean(c.is_super_admin);
      if (!isSuper && features.ai_chat !== true) {
        return jsonResponse({ error: "The AI assistant isn't enabled for your account.", type: 'FORBIDDEN' });
      }
      // §13.2 checkpoint-2 resolution, reused verbatim: a suggestion never
      // names an agent the caller cannot route to (§17.3 honesty rule).
      const enabledAgents = deploymentEnabledAgents().filter(
        (slug) => features['agent_' + slug.replace(/-/g, '_')] === true,
      );
      const chatMode = await resolveThreadMode(sbAdmin, typeof threadId === 'string' ? threadId : null, threadMode);
      const memoryOn = memoryEnabled() && (isSuper || features['project_memory'] === true);
      const suggestions = await buildSuggestions(sbAdmin, projectId, {
        enabledAgents,
        features,
        isSuper,
        mode: chatMode,
        memoryOn,
      });
      makeTelemetry(sbAdmin, {
        user_id: userId,
        project_id: projectId,
        thread_id: typeof threadId === 'string' ? threadId : null,
        request_id: crypto.randomUUID(),
      }).emit('suggestion.shown', {
        count: suggestions.length,
        rules: suggestions.map((s) => s.rule),
        mode: chatMode,
      });
      return jsonResponse({ suggestions, mode: chatMode });
    } catch (e) {
      console.error('suggest mode failed:', e);
      return jsonResponse({ suggestions: [] });
    }
  }

  if (!message || !userId || !userEmail) {
    return jsonResponse({
      error: 'Missing required parameters: message, userId, userEmail',
      type: 'BAD_REQUEST',
    });
  }

  // Stage 0 removes the legacy non-tools mode (ai-agents.md §2.5, §9.1): the
  // anonymized-abstract chat path is gone; tools mode is the only mode.
  if (mode !== 'tools') {
    return jsonResponse({
      error: 'This endpoint only supports mode:"tools" — the legacy chat mode has been removed.',
      type: 'BAD_REQUEST',
    });
  }

  try {
    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // Service-role client for internal tables (usage logs, telemetry, chat store).
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    // --- AI usage logging helper (fire-and-forget; never throws) ---
    async function logAiUsage(input: {
      status: 'success' | 'error' | 'blocked';
      modelCode?: string;
      providerCode?: string;
      promptChars?: number;
      completionChars?: number;
      latencyMs?: number;
      errorCode?: string;
    }) {
      try {
        // Rough token estimate: ~4 chars per token. Real usage figures come with
        // Phase 2 (provider response parsing).
        const promptTokens = Math.ceil((input.promptChars ?? 0) / 4);
        const completionTokens = Math.ceil((input.completionChars ?? 0) / 4);
        const totalTokens = promptTokens + completionTokens;

        // Look up model + cost + user org
        let modelId: string | null = null;
        let inputCost = 0;
        let outputCost = 0;
        if (input.modelCode) {
          const { data: m } = await supabaseAdmin
            .from('ai_models')
            .select('id,input_cost_per_1k,output_cost_per_1k')
            .eq('code', input.modelCode)
            .maybeSingle();
          if (m) {
            modelId = (m as any).id;
            inputCost = Number((m as any).input_cost_per_1k) || 0;
            outputCost = Number((m as any).output_cost_per_1k) || 0;
          }
        }
        const costUsd =
          (promptTokens / 1000) * inputCost + (completionTokens / 1000) * outputCost;

        let orgId: string | null = null;
        if (userId) {
          const { data: u } = await supabaseAdmin
            .from('approved_users')
            .select('organization_id')
            .eq('id', userId)
            .maybeSingle();
          orgId = (u as any)?.organization_id ?? null;
        }

        await supabaseAdmin.from('ai_usage_logs').insert({
          request_id: requestId,
          user_id: userId ?? null,
          org_id: orgId,
          project_id: projectId ?? null,
          model_id: modelId,
          model_code: input.modelCode ?? null,
          provider_code: input.providerCode ?? null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          cost_usd: costUsd,
          latency_ms: input.latencyMs ?? null,
          status: input.status,
          error_code: input.errorCode ?? null,
        });
      } catch (e) {
        console.warn('[usage-log] failed:', e);
      }
    }

    // Authorize when a project is attached; general chats skip project scoping.
    if (projectId) {
      const { error: accessErr } = await supabaseClient.rpc('get_project_dataset_counts', {
        p_project_id: projectId,
        p_user_id: userId,
        p_user_email: userEmail,
      });
      if (accessErr) {
        const m = (accessErr.message || '').toLowerCase();
        if (m.includes('forbidden') || m.includes('project_not_found')) {
          return jsonResponse({ error: "You don't have access to this project.", type: 'FORBIDDEN' });
        }
        console.error('access check error:', accessErr);
        return jsonResponse({ error: `Access check failed: ${accessErr.message}`, type: 'AI_ERROR' });
      }
    }

    // --- Server-side capability re-check (Stage 0, ai-agents.md §9.1 / §8 T5).
    // Mirrors the client gates in src/lib/capabilities.ts word for word. The
    // posture also mirrors the client fallback: a transient resolver failure
    // never wrongly blocks a legitimate call (fail open, log, proceed).
    // §23.4 no-silent-degradation: an explicitly requested model this
    // deployment cannot run is refused, not quietly swapped for the default.
    if (!isKnownModelId(typeof model === 'string' ? model : null)) {
      return jsonResponse({
        error: `The model "${String(model)}" isn't available in this deployment. Pick another from the model menu.`,
        type: 'BAD_REQUEST',
      });
    }
    // §25 Q0: a hidden model (unfunded provider account) is refused by name —
    // a stale client may still send one from before the picker dropped it.
    if (isHiddenModelId(typeof model === 'string' ? model : null)) {
      return jsonResponse({
        error: `${resolveModel(model).label} is temporarily unavailable. Pick GPT-5 or GPT-5 mini from the model menu.`,
        type: 'BAD_REQUEST',
      });
    }
    const resolvedModel = resolveModel(model);
    // ai_models.code is provider-prefixed ('google/gemini-2.5-flash'); the
    // client sends the bare id ('gemini-2.5-flash'). CHAT_MODEL_CODES already
    // bridges the two for the capability re-check below — but every
    // logAiUsage call passed the raw request-body value, so the ai_models
    // lookup never matched: cost_usd was 0 on every row and the monthly/daily
    // USD budget gates could never trip.
    const usageModelCode = CHAT_MODEL_CODES[resolvedModel.id] ?? resolvedModel.id;
    let capFeatures: Record<string, boolean> = {};
    let capIsSuper = false;
    try {
      const { data: caps, error: capsErr } = await supabaseAdmin.rpc('get_my_capabilities', {
        _user_id: userId,
      });
      if (!capsErr && caps && typeof caps === 'object') {
        const c = caps as Record<string, any>;
        capFeatures = (c.features as Record<string, boolean>) ?? {};
        const isSuper = Boolean(c.is_super_admin);
        capIsSuper = isSuper;
        if (!isSuper) {
          if (c.features && c.features.ai_chat !== true) {
            return jsonResponse({
              error: "The AI assistant isn't enabled for your account. Contact an administrator.",
              type: 'FORBIDDEN',
            });
          }
          const models = c.models ?? {};
          const allowedCodes: string[] = Array.isArray(models.allowed_codes) ? models.allowed_codes : [];
          const code = CHAT_MODEL_CODES[resolvedModel.id] ?? resolvedModel.id;
          if (!models.all_allowed && !allowedCodes.includes(code)) {
            return jsonResponse({
              error: "This model isn't enabled for your account. Ask an administrator to grant access, or pick an allowed model.",
              type: 'FORBIDDEN',
            });
          }
          const b = c.budgets ?? {};
          const num = (v: unknown): number | null => (v == null ? null : Number(v));
          const monthly = num(b.monthly_usd), daily = num(b.daily_usd), rpd = num(b.rpd);
          const mtdCost = Number(b.mtd_cost_usd ?? 0), todayCost = Number(b.today_cost_usd ?? 0);
          const todayReqs = Number(b.today_requests ?? 0);
          if (monthly != null && mtdCost >= monthly) {
            return jsonResponse({
              error: `Monthly AI budget reached ($${mtdCost.toFixed(2)} of $${monthly.toFixed(2)}). Contact an administrator to raise it.`,
              type: 'BUDGET_EXCEEDED',
            });
          }
          if (daily != null && todayCost >= daily) {
            return jsonResponse({
              error: `Daily AI budget reached ($${todayCost.toFixed(2)} of $${daily.toFixed(2)}). Try again tomorrow or ask an administrator.`,
              type: 'BUDGET_EXCEEDED',
            });
          }
          if (rpd != null && todayReqs >= rpd) {
            return jsonResponse({
              error: `Daily request limit reached (${todayReqs} of ${rpd}). Try again tomorrow or ask an administrator.`,
              type: 'BUDGET_EXCEEDED',
            });
          }
        }
      } else if (capsErr) {
        console.warn('[capability-recheck] resolver failed, proceeding:', capsErr.message);
      }
    } catch (e) {
      console.warn('[capability-recheck] failed, proceeding:', e instanceof Error ? e.message : e);
    }

    const history = Array.isArray(conversationHistory)
      ? (conversationHistory as ChatTurn[]).filter(
          (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        )
      : [];
    const ctx = projectId ? makeToolContext(projectId, userId) : null;
    const promptText = String(message).slice(0, 4000);

    // --- §21.5 request budgets (H3, unflagged): one set of spend meters per
    // request. runChat consumes an LLM call per invocation, executeTool a
    // tool call per execution (via ToolContext), the wall is checked between
    // calls and hops; every chat.reply event carries the spend.
    const budget = makeRequestBudget();
    if (ctx) ctx.budget = budget;

    // --- Telemetry (ai-agents.md §7; AGENT_TELEMETRY_ENABLED, default off) ---
    // Also stamped on every ai_usage_logs row this request writes (§8 T5:
    // "records all three (distinct request_id)"). ai_usage_logs.request_id has
    // existed since the table was created and was never populated, so an
    // agent-routed request — which legitimately writes an agent-turn row AND a
    // request row — counted twice against the per-day REQUEST limit. Declared
    // here rather than at the top of the handler because telemetry owns it;
    // every logAiUsage CALL happens below this line.
    const requestId = crypto.randomUUID();
    let orgId: string | null = null;
    if (telemetryEnabled()) {
      try {
        const { data: u } = await supabaseAdmin
          .from('approved_users').select('organization_id').eq('id', userId).maybeSingle();
        orgId = (u as any)?.organization_id ?? null;
      } catch { /* attribution only */ }
    }
    const telemetryBase = {
      user_id: userId ?? null,
      org_id: orgId,
      project_id: projectId ?? null,
      thread_id: typeof threadId === 'string' ? threadId : null,
      request_id: requestId,
      persona_id: agentId ?? null,
      model_code: resolvedModel.id,
      provider_code: resolvedModel.provider,
    };
    const telemetry = makeTelemetry(supabaseAdmin, telemetryBase);
    telemetry.emit('chat.request', {
      prompt_chars: promptText.length,
      history_len: history.length,
      has_project: Boolean(projectId),
    });

    // --- Router (ai-agents.md §6; AGENT_ROUTER_ENABLED=false ⇒ pure
    // passthrough, no LLM call). Effective agent set is computed server-side
    // (§13.2): deployment kill switch ∩ capability grants. Stage 1 wires the
    // live structured-output classifier; a bare "do it" follow-up re-routes
    // the prior utterance (§6.2 step 3).
    const enabledAgents = deploymentEnabledAgents().filter(
      (slug) => capFeatures['agent_' + slug.replace(/-/g, '_')] === true,
    );

    // --- H3 (§21.4): the resume pre-step — deterministic, before any LLM
    // call and before the router (a resume carries its own deterministic
    // instruction; it is never re-classified). The turn is CLIENT-caused
    // (approve flow / run-completion subscription, D2/Q33): the server holds
    // nothing open and schedules nothing. Checkpoint 1 (project access) ran
    // above; checkpoint 2 (capabilities) re-runs below before any agent turn
    // executes — a plan is never a pre-authorization (§13.6 rule 5).
    const resumePlanId =
      typeof body.resume_plan_id === 'string' && uuidRe.test(body.resume_plan_id)
        ? body.resume_plan_id
        : null;
    if (resumePlanId && planToolEnabled()) {
      const _t0 = Date.now();
      const planTelemetryPayload = (plan: { id: string; steps: Parameters<typeof stepsByStatus>[0]; resume_count: number }) => ({
        plan_id: plan.id,
        steps_by_status: stepsByStatus(plan.steps),
        resume_count: plan.resume_count,
      });
      const finishResume = async (result: ChatRunResult): Promise<Response> => {
        const latencyMs = Date.now() - _t0;
        for (const call of result.toolCalls ?? []) {
          sha256Hex(canonicalJson(call.args ?? {})).then((argsSha) =>
            telemetry.emit('tool.call', {
              tool: call.name,
              args_sha256: argsSha,
              ok: call.ok,
              row_count: call.row_count,
            })
          ).catch(() => { /* never blocks the reply */ });
        }
        telemetry.emit('chat.reply', {
          reply_chars: (result.reply ?? '').length,
          parts_kinds: (result.parts ?? []).map((p) => p.kind),
          blocked: Boolean(result.blocked),
          resumed_plan_id: resumePlanId,
          ...budgetTelemetryPayload(budget),
        }, { latency_ms: latencyMs });
        let persisted = false;
        const storeOn = (Deno.env.get('CHAT_STORE_ENABLED') ?? '').trim().toLowerCase() === 'true';
        if (storeOn && typeof threadId === 'string' && uuidRe.test(threadId)) {
          try {
            const { error: appendErr } = await supabaseAdmin.rpc('append_chat_message', {
              p_user_id: userId,
              p_thread_id: threadId,
              p_role: 'assistant',
              p_content: result.reply ?? '',
              p_parts: result.parts ?? [],
              p_tool_calls: result.toolCalls ?? [],
              p_proposal_id: null,
              p_model_code: resolvedModel.id,
            });
            persisted = !appendErr;
            if (appendErr) console.warn('[chat-store] resume append failed:', appendErr.message);
          } catch (e) {
            console.warn('[chat-store] resume append failed:', e instanceof Error ? e.message : e);
          }
        }
        return jsonResponse(persisted ? { ...result, persisted: true } : result as unknown as Record<string, unknown>);
      };

      try {
        const outcome = await runResumePreStep(supabaseAdmin, {
          planId: resumePlanId,
          userId,
          modelCode: resolvedModel.id,
        });

        if (outcome.kind === 'error') {
          return await finishResume({
            reply: outcome.reply,
            parts: outcome.plan ? [planPart(outcome.plan)] : [],
            toolCalls: [],
            model: resolvedModel.label,
          });
        }
        if (outcome.kind === 'progress' || outcome.kind === 'closed') {
          // Zero-LLM branches (§21.4: a poll costs nothing) — templated
          // reply + the live plan part; resume_count untouched.
          if (outcome.kind === 'closed') {
            telemetry.emit('plan.step_changed', planTelemetryPayload(outcome.plan));
            if (outcome.plan.status !== 'active') {
              telemetry.emit('plan.closed', { ...planTelemetryPayload(outcome.plan), status: outcome.plan.status });
            }
          }
          return await finishResume({
            reply: outcome.reply,
            parts: [planPart(outcome.plan)],
            toolCalls: [],
            model: resolvedModel.label,
          });
        }

        // Run done ⇒ execute the read-and-cite step (§20.4 step 5) as this
        // request's agent turn. Checkpoint 2 re-runs HERE: revoked grants ⇒
        // the typed error and the step fails (§13.6 rule 5).
        telemetry.emit('plan.step_changed', planTelemetryPayload(outcome.plan));
        const planAgentId = outcome.plan.agent_id ?? 'experiment-designer';
        if (!enabledAgents.includes(planAgentId) || !AGENT_TURNS[planAgentId] || ctx === null) {
          const reason = ctx === null
            ? 'the plan’s project is not attached to this request'
            : `the ${planAgentId} agent is no longer enabled for your account`;
          const fresh = await markPlanStepFailed(supabaseAdmin, outcome.plan, outcome.stepId, 'forbidden: capability revoked', userId);
          telemetry.emit('plan.step_changed', planTelemetryPayload(fresh));
          if (fresh.status !== 'active') {
            telemetry.emit('plan.closed', { ...planTelemetryPayload(fresh), status: fresh.status });
          }
          return await finishResume({
            reply: `forbidden: resuming this plan needs the same rights as starting it, and ${reason}. ` +
              `Plan step "${outcome.stepId}" is marked failed.`,
            parts: [planPart(fresh)],
            toolCalls: [],
            blocked: true,
            model: resolvedModel.label,
          });
        }

        // --- §26 M.3: a skill-filed plan resumes through ITS SKILL, not the
        // model-driven agent turn: the skill re-runs on the stored question
        // (now a cache hit — the run it waited on is done), answers in code,
        // and closes the plan. One model call at most (the interpretation).
        const skillStep = outcome.plan.steps.find((st) => st.id === 'answer' && parseSkillNote(st.note));
        const skillRef = skillStep ? parseSkillNote(skillStep.note) : null;
        const resumeSkill = skillRef ? skillById(skillRef.skillId) : null;
        if (resumeSkill && skillRef) {
          const skillCtx: ToolContext = {
            ...(ctx as ToolContext),
            draft: {
              userEmail: userEmail ?? null,
              threadId: outcome.plan.thread_id,
              modelCode: resolvedModel.id,
              providerCode: resolvedModel.provider,
              canProposals: capFeatures['agent_proposals'] === true,
              utterance: skillRef.utterance,
              mode: 'review',
              agentId: planAgentId,
            },
          };
          // The question AND the earlier message that named its subject: a
          // follow-up ("how do I mitigate it?") has none of its own (38(ak)).
          // A plan filed before the note carried its subject falls back to
          // the thread's own history, which the resume request sends.
          const input = skillRef.subject ? resumeInput(skillRef) : { utterance: skillRef.utterance, history };
          const match = resumeSkill.recognize(input);
          const turn = match === null || match === undefined
            ? null
            : await runSkillTurn({
              skill: resumeSkill,
              match,
              input,
              // A resume answers; it never files another card.
              opts: { canDraft: false, draftBlockedReason: 'this is the answer to the run you approved', enabledAgents },
              ctx: skillCtx,
              modelId: model,
              personaId: agentId ?? null,
              budget,
              verifierOn: verifierEnabled(),
              projectId: projectId as string,
              resuming: true,
            });
          // A study with arms still running is not a failed answer: wait on
          // one of the unfinished arms and say how far it got.
          const stillRunning = turn?.result.outcome === 'in_progress' ? (turn.result.pendingRunIds ?? []) : [];
          if (stillRunning.length > 0) {
            const planPartWait = await waitSkillPlanOn(
              skillCtx,
              outcome.plan as unknown as { id: string; steps: Array<Record<string, unknown>> },
              outcome.stepId,
              stillRunning[0],
            );
            return await finishResume({
              reply: turn!.reply,
              parts: [...turn!.parts, ...(planPartWait ? [planPartWait] : [])],
              toolCalls: turn!.result.calls.map((c) => ({
                name: c.name, args: c.args, ok: c.envelope.meta.note !== 'error', row_count: c.envelope.meta.row_count,
              })),
              model: resolvedModel.label,
            });
          }
          const answered = !!turn && ['hit', 'answered'].includes(turn.result.outcome);
          const planPartNow = await closeSkillPlan(
            skillCtx,
            outcome.plan as unknown as { id: string; steps: Array<Record<string, unknown>> },
            answered,
            outcome.stepId,
          );
          return await finishResume({
            reply: turn?.reply ?? `The run finished, but I couldn't re-read the question "${skillRef.utterance}" — ask it again and I'll answer from the run.`,
            parts: [...(turn?.parts ?? []), ...(planPartNow ? [planPartNow] : [])],
            toolCalls: (turn?.result.calls ?? []).map((c) => ({
              name: c.name, args: c.args, ok: c.envelope.meta.note !== 'error', row_count: c.envelope.meta.row_count,
            })),
            model: resolvedModel.label,
          });
        }

        const verifierOn = verifierEnabled();
        const agentCtx: ToolContext = {
          ...ctx,
          draft: {
            userEmail: userEmail ?? null,
            threadId: typeof threadId === 'string' ? threadId : null,
            modelCode: resolvedModel.id,
            providerCode: resolvedModel.provider,
            canProposals: capFeatures['agent_proposals'] === true,
            utterance: outcome.utterance,
            agentId: planAgentId,
          },
        };
        const agentT0 = Date.now();
        const agentCalls: RecordedToolCall[] = [];
        let agentContext: string | undefined;
        const agent = await runAgentTurn({
          agentId: planAgentId,
          modelId: model,
          utterance: outcome.utterance,
          ctx: agentCtx,
          ...(verifierOn
            ? {
              onToolResult: (name: string, args: Record<string, unknown>, envelope: ToolEnvelope) => {
                agentCalls.push({ name, args, envelope });
              },
              onContext: (text: string) => {
                agentContext = text;
              },
            }
            : {}),
        });
        logAiUsage({
          status: agent.ok ? 'success' : 'error',
          modelCode: usageModelCode,
          providerCode: resolvedModel.provider,
          promptChars: outcome.utterance.length,
          completionChars: agent.reply.length,
          latencyMs: Date.now() - agentT0,
          errorCode: agent.ok ? undefined : (agent.error ?? 'agent_turn_failed').slice(0, 200),
        });

        let reply = agent.ok
          ? (agent.reply || 'The run completed — but I could not produce a report. Ask again to retry the read.')
          : `The resumed step could not complete${agent.error ? ` (${agent.error})` : ''}. Ask again to retry.`;
        let evidencePart: { kind: string; data: unknown } | null = null;
        if (verifierOn && agent.ok) {
          // §22.3 on the resume path: the agent's reply IS the user-facing
          // answer — verified against its envelopes + CONTEXT, one
          // corrective retry re-invoking the same turn.
          const verdict = await verifyWithRetry<{ reply: string; calls: RecordedToolCall[] }>({
            projectId: projectId as string,
            db: ctx.supabase,
            userMessage: outcome.utterance,
            contextText: agentContext,
            attempt: { reply, calls: agentCalls },
            retry: async (addendum) => {
              const retryCalls: RecordedToolCall[] = [];
              try {
                const second = await runAgentTurn({
                  agentId: planAgentId,
                  modelId: model,
                  utterance: outcome.utterance,
                  ctx: agentCtx,
                  systemAddendum: addendum,
                  onToolResult: (name, args, envelope) => {
                    retryCalls.push({ name, args, envelope });
                  },
                });
                if (!second.ok) return null;
                return { reply: second.reply || reply, calls: retryCalls };
              } catch {
                return null;
              }
            },
            nearestAction: () => Promise.resolve(null),
          });
          reply = verdict.reply;
          if (verdict.citations.length > 0 || verdict.fallback) {
            evidencePart = {
              kind: 'evidence',
              data: { citations: verdict.citations, verified: verdict.verified, fallback: verdict.fallback },
            };
          }
          if (verdict.fallback) {
            telemetry.emit('verifier.blocked_reply', {
              violations: verdict.violationCounts,
              retried: verdict.retried,
              model_code: resolvedModel.id,
            });
          }
        }

        // §21.3: the integrity law at request end — a dangling active step
        // (budget exhaustion, provider error, a model that stopped mid-step)
        // fails with the cause in the note; the plan status is recomputed.
        const cause = budget.budgetHit
          ? `budget: ${budget.budgetHit}`
          : agent.ok
          ? undefined
          : (agent.error ?? 'agent turn failed');
        const sweep = await sweepPlanIntegrity(supabaseAdmin, {
          planId: outcome.plan.id,
          userId,
          cause,
        });
        for (const ev of agentCtx.planEvents ?? []) telemetry.emit(ev.kind, ev.payload);
        if (sweep.changed && sweep.plan) telemetry.emit('plan.step_changed', planTelemetryPayload(sweep.plan));
        if (sweep.closed && sweep.plan) {
          telemetry.emit('plan.closed', { ...planTelemetryPayload(sweep.plan), status: sweep.plan.status });
        }
        const livePlan = sweep.plan ?? outcome.plan;

        return await finishResume({
          reply,
          parts: [
            planPart(livePlan),
            ...(evidencePart ? [evidencePart] : []),
          ],
          toolCalls: agent.toolCalls,
          model: resolvedModel.label,
        });
      } catch (resumeErr) {
        // Never leave a dangling active step behind an error (§21.3).
        try {
          await sweepPlanIntegrity(supabaseAdmin, {
            planId: resumePlanId,
            userId,
            cause: resumeErr instanceof Error ? resumeErr.message : 'resume failed',
          });
        } catch { /* the sweep is best-effort here */ }
        console.error('plan resume failed:', resumeErr);
        return jsonResponse({
          error: resumeErr instanceof Error ? resumeErr.message : 'Plan resume failed.',
          type: 'AI_ERROR',
        });
      }
    }

    // §15 mode (CHAT_MODES_ENABLED default off ⇒ 'review', no read): synced
    // threads resolve from chat_threads.mode; unsynced threads carry the mode
    // in the request body and the server STILL enforces it.
    const chatMode = await resolveThreadMode(
      supabaseAdmin,
      typeof threadId === 'string' ? threadId : null,
      threadMode,
    );

    const routedUtterance = resolveRoutedUtterance(promptText, history);
    // Classification runs with the full capability-resolved set so a blocked
    // mutation ask is DETECTED and named (§15 voice: never silently drop an
    // intent); the mode then SUBTRACTS at checkpoint 2 — in Ask mode only the
    // §15 allowlist may execute. Modes never grant anything §13 doesn't.
    // §21.5: the router's classifier call counts against the LLM-call budget
    // (the "1 router" of router + ≤ 2 step turns + ≤ 1 wrap-up). A denial
    // surfaces as a classifier failure, which decideRoute already resolves
    // deterministically — never a silent drop.
    const baseClassifier = makeClassifier(resolvedModel);
    const meteredClassifier = baseClassifier
      ? (prompt: string): Promise<string> => {
        if (!tryConsumeLlmCall(budget)) {
          return Promise.reject(new Error(`llm-call budget exhausted (${budget.maxLlmCalls})`));
        }
        return baseClassifier(prompt);
      }
      : null;
    // §20.8 / §26 M.1: a message a modeler skill claims is routed by the
    // skill, not by a classifier call — the ask is already understood. A
    // drafting skill routes to the Experiment Designer when routable (so the
    // mode gate applies); a read-only skill is advisory.
    const skillHit = ctx
      ? matchSkill({ utterance: routedUtterance, history: history as Array<{ role: string; content: string }> })
      : null;
    const rawDecision = skillHit
      ? {
        ...whatIfRouteDecision(
          skillHit.skill.drafts && routerEnabled() && enabledAgents.includes('experiment-designer'),
        ),
        short_circuit: `skill:${skillHit.skill.id}`,
      }
      : await decideRoute(routedUtterance, {
        personaId: agentId ?? null,
        hasProject: Boolean(projectId),
        enabledAgents,
        modelId: resolvedModel.id,
      }, meteredClassifier);
    const { decision: routeDecision, blocked: modeBlocked } = applyModeToRoute(rawDecision, chatMode);
    telemetry.emit('router.decision', {
      route: routeDecision.route,
      agent_id: routeDecision.agent_id,
      intent: routeDecision.intent,
      confidence: routeDecision.confidence,
      short_circuit: routeDecision.short_circuit,
      // §6.6 (H2): the v2 signals ride the same event — both false with
      // ROUTER_V2_SIGNALS off (the v1 payload gains two constant fields).
      needs_run: routeDecision.needs_run,
      cache_checkable: routeDecision.cache_checkable,
    });
    if (modeBlocked) {
      telemetry.emit('mode.blocked_intent', {
        mode: chatMode,
        agent_id: modeBlocked.agent_id,
        intent: modeBlocked.intent,
      });
    }

    // --- M1 rolling summary (§14.3, CHAT_SUMMARY_ENABLED default off):
    // persona turns receive the thread summary; agent turns never do.
    let threadSummary: string | null = null;
    let summaryUptoSeq = 0;
    const summariesOn = summariesEnabled();
    if (summariesOn && typeof threadId === 'string' && uuidRe.test(threadId)) {
      const s = await loadThreadSummary(supabaseAdmin, threadId, userId);
      if (s) {
        threadSummary = s.summary;
        summaryUptoSeq = s.summaryUptoSeq;
      }
    }

    // --- M2 project memory (ai-agents.md §14.4; PROJECT_MEMORY_ENABLED
    // default off). Consent path (a): an explicit "remember …" message IS the
    // consent — saved deterministically (the model is never in this loop) with
    // a user_message citation. Consent path (b): a decision-shaped message
    // yields a {kind:"memory_offer"} part; the chip's Save button writes.
    const memoryOn = memoryEnabled() && Boolean(projectId) &&
      (capIsSuper || capFeatures['project_memory'] === true);
    let memorySaved: { id: string; content: string; kind: string } | null = null;
    let memorySaveError: string | null = null;
    let memoryOffer: { content: string; kind: string } | null = null;
    if (memoryOn) {
      const explicit = detectExplicitMemoryRequest(promptText);
      if (explicit) {
        const saved = await saveExplicitMemory(supabaseAdmin, {
          projectId,
          userId: userId ?? null,
          threadId: typeof threadId === 'string' && uuidRe.test(threadId) ? threadId : null,
          content: explicit.content,
          kind: explicit.kind,
        });
        if (saved.ok) memorySaved = { id: saved.id!, content: explicit.content, kind: explicit.kind };
        else memorySaveError = saved.error ?? 'save failed';
      } else {
        memoryOffer = detectDecisionShape(promptText);
      }
    }

    const _t0 = Date.now();
    try {
      // §3.3 orchestration: agent turn → persona wrap-up → proposal part
      // attached mechanically. Per-request turn budget (§8 T5): ≤ 1 router
      // call + ≤ 1 agent turn + ≤ 1 persona turn (+ the §22.3 verifier's
      // single corrective retry when VERIFIER_ENABLED).
      let result: ChatRunResult;
      let telemetryToolCalls: ChatRunResult['toolCalls'] = [];
      let proposalId: string | null = null;

      // --- H1 pre-send verifier (§22.3; VERIFIER_ENABLED default off). Runs
      // on every persona AND agent reply when a project is attached (without
      // one there are no tools, no grounded vocabulary and no project claims;
      // the no-project prompt already forbids numeric facts). Model prose is
      // verified BEFORE the deterministic server notes (mode notice, memory
      // line, failure note) are appended, and before the chat-store append.
      const verifierOn = verifierEnabled() && ctx !== null;
      // §19.3: the persona read surface (coverage tools + exposed Layer B
      // reads when COVERAGE_TOOLS_ENABLED; the unchanged declarations else).
      // §6.6 rule 1 (H2, deterministic — code, never model behavior):
      // cache_checkable === true on ANY route ⇒ the executing persona turn's
      // surface includes find_completed_run + get_run_results +
      // get_validation_status and its prompt carries the cache-first
      // instruction (§20.4). Only reachable with ROUTER_V2_SIGNALS on, so
      // flag-off requests keep the byte-identical v1 surface and prompt.
      const cacheCheckable = routeDecision.cache_checkable === true && ctx !== null;
      const dedupeByName = (tools: ReadonlyArray<ToolDeclaration>): ReadonlyArray<ToolDeclaration> => {
        const seen = new Set<string>();
        return tools.filter((t) => !seen.has(t.name) && (seen.add(t.name), true));
      };
      const personaTools = cacheCheckable
        ? dedupeByName([
          ...personaToolDeclarations(),
          findCompletedRunDeclaration,
          getRunResultsDeclaration,
          getValidationStatusDeclaration,
        ])
        : personaToolDeclarations();
      // Spread into every persona runChat call so the built prompt carries
      // the §20.4 cache-first instruction when rule 1 applies — and, H3, the
      // §21.5 spend meters (every persona call consumes the same budget).
      const personaCacheOpts = { budget, ...(cacheCheckable ? { cacheFirst: true } : {}) };
      const recordInto = (arr: RecordedToolCall[]) =>
        (name: string, args: Record<string, unknown>, envelope: ToolEnvelope) => {
          arr.push({ name, args, envelope });
        };
      type VerifiedTurn = { reply: string; calls: RecordedToolCall[]; result: ChatRunResult };
      let verdict: VerifyWithRetryResult<VerifiedTurn> | null = null;
      // §22.5: the fallback's nearest grounded action, from the §17.3
      // suggestion rules — computed only if the fallback fires.
      const nearestAction = async (): Promise<string | null> => {
        if (!projectId) return null;
        try {
          const suggestions = await buildSuggestions(supabaseAdmin, projectId, {
            enabledAgents,
            features: capFeatures,
            isSuper: capIsSuper,
            mode: chatMode,
            memoryOn,
          });
          return suggestions[0]?.label ?? null;
        } catch {
          return null;
        }
      };

      // Stages 1–3: any routed agent with a §5 turn runner (data-steward,
      // policy-configurator, vv-analyst — AGENT_TURNS) executes here; agents
      // without one fall through to the advisory path.
      // §6.6 rule 2 (H2): needs_run ∧ route artifact ∧ experiment-designer ⇒
      // the B4 closed-loop turn (§20.3) — which IS this path: behind
      // CLOSED_LOOP_ENABLED, buildExperimentContext swaps in the §20.4 loop
      // prompt and the §20.2 tool surface for every routed B4 turn. needs_run
      // on an *advisory* route changes nothing deterministic (the persona may
      // honestly say a run would be needed — §19.4's nearest-grounded-action).
      // §20.8: a parsed what-if never takes the model-driven agent turn (nor
      // the matrix gate that guards it — no model capability is exercised).
      const routedAgentId =
        !skillHit &&
        (routeDecision.route === 'artifact' || routeDecision.route === 'mixed') && ctx !== null &&
        routeDecision.agent_id !== null && AGENT_TURNS[routeDecision.agent_id]
          ? routeDecision.agent_id
          : null;

      // --- H4 (§23.4): the capability-matrix gate — AFTER decideRoute,
      // BEFORE any agent turn. A fresh (≤ 7 days) failing row for the routed
      // (model, capability) ⇒ the agent turn is NOT executed; the SERVER
      // instantiates the §22.5 needs-a-stronger-model template (naming the
      // best passing model, if any), attaches no card, and emits
      // model.below_target. Fail-open rules, per §23.4: no row, a stale row,
      // or an advisory route ⇒ proceed normally (the matrix subtracts
      // nothing until fresh evidence exists). NEVER auto-switch models —
      // the user chose the model; the platform's job is honesty about what
      // that choice can do.
      if (routedAgentId && matrixEnabled()) {
        const gate = await checkMatrixGate(supabaseAdmin, {
          modelCode: resolvedModel.id,
          modelLabel: resolvedModel.label,
          capabilityIds: routedCapabilityIds(routeDecision, routedAgentId),
        });
        if (gate.blocked) {
          telemetry.emit('model.below_target', {
            model_code: resolvedModel.id,
            capability_id: gate.capabilityId,
          });
          logAiUsage({
            status: 'blocked',
            modelCode: usageModelCode,
            providerCode: resolvedModel.provider,
            promptChars: promptText.length,
            latencyMs: Date.now() - _t0,
            errorCode: 'model_below_target',
          });
          const refusal: ChatRunResult = {
            reply: gate.reply,
            parts: [],
            toolCalls: [],
            blocked: true,
            model: resolvedModel.label,
          };
          telemetry.emit('chat.reply', {
            reply_chars: refusal.reply.length,
            parts_kinds: [],
            blocked: true,
            ...budgetTelemetryPayload(budget),
          }, { latency_ms: Date.now() - _t0 });
          let refusalPersisted = false;
          const matrixStoreOn = (Deno.env.get('CHAT_STORE_ENABLED') ?? '').trim().toLowerCase() === 'true';
          if (matrixStoreOn && typeof threadId === 'string' && uuidRe.test(threadId)) {
            try {
              const { error: appendErr } = await supabaseAdmin.rpc('append_chat_message', {
                p_user_id: userId,
                p_thread_id: threadId,
                p_role: 'assistant',
                p_content: refusal.reply,
                p_parts: [],
                p_tool_calls: [],
                p_proposal_id: null,
                p_model_code: resolvedModel.id,
              });
              refusalPersisted = !appendErr;
              if (appendErr) console.warn('[chat-store] append failed:', appendErr.message);
            } catch (e) {
              console.warn('[chat-store] append failed:', e instanceof Error ? e.message : e);
            }
          }
          return jsonResponse(
            refusalPersisted
              ? { ...refusal, persisted: true }
              : refusal as unknown as Record<string, unknown>,
          );
        }
      }

      if (skillHit && ctx) {
        // --- §26 the modeler skill turn (§20.8 generalized). Code decides
        // every step; the one optional model call interprets, tools
        // withdrawn, verified or dropped. A drafting skill files ONE card
        // and, with the plan harness on, a plan that brings the answer back
        // after approval and run completion (M.3).
        const canDraft = skillHit.skill.drafts && routeDecision.agent_id === 'experiment-designer';
        const draftBlockedReason = modeBlocked
          ? 'this thread is in Ask mode, which never files proposals'
          : !routerEnabled()
          ? 'agent drafting is switched off in this deployment'
          : !enabledAgents.includes('experiment-designer')
          ? "the Experiment Designer agent isn't enabled for your account"
          : undefined;
        const skillCtx: ToolContext = {
          ...ctx,
          draft: {
            userEmail: userEmail ?? null,
            threadId: typeof threadId === 'string' ? threadId : null,
            modelCode: resolvedModel.id,
            providerCode: resolvedModel.provider,
            canProposals: capFeatures['agent_proposals'] === true,
            // The skill's own input: for a follow-up choice this is the
            // earlier question joined with the choice (§27).
            utterance: skillHit.input.utterance,
            mode: chatMode,
            agentId: 'experiment-designer',
          },
        };
        const turn = await runSkillTurn({
          skill: skillHit.skill,
          match: skillHit.match,
          input: skillHit.input,
          opts: { canDraft, draftBlockedReason, enabledAgents },
          ctx: skillCtx,
          modelId: model,
          personaId: agentId ?? null,
          budget,
          verifierOn,
          projectId: projectId as string,
        });
        if (turn.planId) ctx.planTouchedId = turn.planId;
        const skillToolCalls = turn.result.calls.map((c) => ({
          name: c.name,
          args: c.args,
          ok: c.envelope.meta.note !== 'error',
          row_count: c.envelope.meta.row_count,
        }));
        telemetryToolCalls = skillToolCalls;
        if (turn.verdict) verdict = turn.verdict;
        const proposal = turn.result.proposal;
        if (proposal) {
          proposalId = proposal.proposal_id;
          if (!proposal.duplicate) {
            makeTelemetry(supabaseAdmin, { ...telemetryBase, agent_id: 'experiment-designer' })
              .emit('proposal.created', {
                artifact_type: proposal.artifact_type,
                provenance: proposal.provenance,
              }, { proposal_id: proposalId });
          }
        }
        result = {
          reply: turn.reply,
          parts: turn.parts,
          toolCalls: skillToolCalls,
          model: resolvedModel.label,
        };
      } else if (routedAgentId) {
        const agentUtterance = routeDecision.artifact_part ?? routedUtterance;
        const agentCtx: ToolContext = {
          ...(ctx as ToolContext),
          draft: {
            userEmail: userEmail ?? null,
            threadId: typeof threadId === 'string' ? threadId : null,
            modelCode: resolvedModel.id,
            providerCode: resolvedModel.provider,
            canProposals: capFeatures['agent_proposals'] === true,
            utterance: agentUtterance,
            // §15/§16.1: the one ask-mode-routable agent (report-builder)
            // phrases its evidence refusals per the thread's mode.
            mode: chatMode,
            // H3 (§21.2): recorded on any chat_plans row this turn files.
            agentId: routedAgentId,
          },
        };
        const agentT0 = Date.now();
        const agentCalls: RecordedToolCall[] = [];
        let agentContext: string | undefined;
        const agent = await runAgentTurn({
          agentId: routedAgentId,
          modelId: model,
          utterance: agentUtterance,
          ctx: agentCtx,
          ...(verifierOn
            ? {
              onToolResult: recordInto(agentCalls),
              onContext: (text: string) => {
                agentContext = text;
              },
            }
            : {}),
        });
        logAiUsage({
          status: agent.ok ? 'success' : 'error',
          modelCode: usageModelCode,
          providerCode: resolvedModel.provider,
          promptChars: agentUtterance.length,
          completionChars: agent.reply.length,
          latencyMs: Date.now() - agentT0,
          errorCode: agent.ok ? undefined : (agent.error ?? 'agent_turn_failed').slice(0, 200),
        });

        const agentTelemetry = makeTelemetry(supabaseAdmin, { ...telemetryBase, agent_id: routedAgentId });
        for (const call of agent.toolCalls) {
          sha256Hex(canonicalJson(call.args ?? {})).then((argsSha) =>
            agentTelemetry.emit('tool.call', {
              tool: call.name,
              args_sha256: argsSha,
              ok: call.ok,
              row_count: call.row_count,
            })
          ).catch(() => { /* never blocks the reply */ });
        }
        const part = agent.proposalPart;
        if (part) {
          proposalId = part.data.proposal_id;
          if (!part.data.duplicate) {
            agentTelemetry.emit('proposal.created', {
              artifact_type: part.data.artifact_type,
              provenance: part.data.provenance,
            }, { proposal_id: proposalId });
          }
        }

        if (routeDecision.route === 'mixed' && routeDecision.advisory_part) {
          // §6.2 step 5: the persona answers the advisory part in a normal
          // Layer A turn; the handoff note + card join the same reply. The
          // advisory answer survives an agent failure.
          const advisoryPart = routeDecision.advisory_part.slice(0, 4000);
          const personaCalls: RecordedToolCall[] = [];
          const persona = await runChat(
            model, advisoryPart, history, ctx, agentId,
            {
              summary: threadSummary,
              tools: personaTools,
              ...personaCacheOpts,
              ...(verifierOn ? { onToolResult: recordInto(personaCalls) } : {}),
            },
          );
          telemetryToolCalls = persona.toolCalls ?? [];
          if (verifierOn) {
            // §22.3: verify the MODEL prose — the persona answer plus, when
            // the handoff note would relay it, the agent's own report. The
            // deterministic note variants (card pointer / failure line) are
            // server text, appended after verification.
            const agentProse = !part && agent.ok ? (agent.reply || '') : '';
            const serverNote = agentProse ? '' : mixedHandoffNote(agent);
            const compose = (p: ChatRunResult, prose: string): ChatRunResult => ({
              ...p,
              reply: (serverNote ? `${prose}\n\n${serverNote}` : prose).trim(),
              parts: [...(p.parts ?? []), ...(part ? [part] : [])],
              toolCalls: [...(p.toolCalls ?? []), ...agent.toolCalls],
            });
            verdict = await verifyWithRetry<VerifiedTurn>({
              projectId: projectId as string,
              db: (ctx as ToolContext).supabase,
              userMessage: promptText,
              contextText: [agentContext, threadSummary ?? ''].filter(Boolean).join('\n\n') || undefined,
              attempt: {
                reply: agentProse ? `${persona.reply}\n\n${agentProse}` : persona.reply,
                calls: [...personaCalls, ...agentCalls],
                result: persona,
              },
              retry: async (addendum) => {
                const retryCalls: RecordedToolCall[] = [];
                try {
                  const persona2 = await runChat(model, advisoryPart, history, ctx, agentId, {
                    summary: threadSummary,
                    tools: personaTools,
                    ...personaCacheOpts,
                    systemAddendum: addendum,
                    onToolResult: recordInto(retryCalls),
                  });
                  return {
                    reply: agentProse ? `${persona2.reply}\n\n${agentProse}` : persona2.reply,
                    calls: [...retryCalls, ...agentCalls],
                    result: persona2,
                  };
                } catch {
                  return null;
                }
              },
              nearestAction,
            });
            result = compose(verdict.attempt.result, verdict.reply);
            telemetryToolCalls = verdict.attempt.result.toolCalls ?? [];
          } else {
            result = {
              ...persona,
              reply: `${persona.reply}\n\n${mixedHandoffNote(agent)}`.trim(),
              parts: [...(persona.parts ?? []), ...(part ? [part] : [])],
              toolCalls: [...(persona.toolCalls ?? []), ...agent.toolCalls],
            };
          }
        } else if (agent.ok) {
          // §6.4: persona wrap-up turn — voice only (no tools), fed the
          // agent's report; the proposal part is attached mechanically.
          const wrapMessage = buildWrapupMessage({
            utterance: agentUtterance,
            agentReply: agent.reply,
            proposal: part?.data ?? null,
            agentName: AGENT_TURNS[routedAgentId].name,
          });
          const wrapDefault =
            'I drafted a proposal for this — review the card below and approve it before it applies.';
          let wrapReply = '';
          try {
            const wrap = await runChat(
              model, wrapMessage,
              history, null, agentId, { summary: threadSummary, budget },
            );
            wrapReply = wrap.reply ?? '';
          } catch (e) {
            console.warn('persona wrap-up failed, falling back to the agent report:',
              e instanceof Error ? e.message : e);
          }
          result = {
            reply: wrapReply || agent.reply || wrapDefault,
            parts: part ? [part] : [],
            toolCalls: agent.toolCalls,
            model: resolvedModel.label,
          };
          if (verifierOn) {
            // §22.3 on the agent path: the shipped prose (wrap-up or agent
            // report) is verified against the agent turn's envelopes + its
            // CONTEXT block; the retry re-invokes the wrap-up turn.
            verdict = await verifyWithRetry<VerifiedTurn>({
              projectId: projectId as string,
              db: (ctx as ToolContext).supabase,
              userMessage: promptText,
              contextText: [agentContext, threadSummary ?? ''].filter(Boolean).join('\n\n') || undefined,
              attempt: { reply: result.reply, calls: agentCalls, result },
              retry: async (addendum) => {
                try {
                  const wrap2 = await runChat(model, wrapMessage, history, null, agentId, {
                    summary: threadSummary,
                    budget,
                    systemAddendum: addendum,
                  });
                  const reply2 = (wrap2.reply ?? '') || agent.reply || wrapDefault;
                  return { reply: reply2, calls: agentCalls, result: { ...result, reply: reply2 } };
                } catch {
                  return null;
                }
              },
              nearestAction,
            });
            result = { ...verdict.attempt.result, reply: verdict.reply };
          }
        } else {
          // Agent turn failed outright: the advisory answer still returns,
          // with one sentence noting the draft failed and why (§6.2 step 5).
          const personaCalls: RecordedToolCall[] = [];
          const persona = await runChat(model, promptText, history, ctx, agentId, {
            summary: threadSummary,
            tools: personaTools,
            ...personaCacheOpts,
            ...(verifierOn ? { onToolResult: recordInto(personaCalls) } : {}),
          });
          telemetryToolCalls = persona.toolCalls ?? [];
          const failureNote =
            `I tried to draft this for you but the drafting step failed` +
            `${agent.error ? ` (${agent.error})` : ''}. You can ask again or make the change manually.`;
          if (verifierOn) {
            // The failure note is deterministic server text (it can carry
            // provider error codes) — appended after verification.
            verdict = await verifyWithRetry<VerifiedTurn>({
              projectId: projectId as string,
              db: (ctx as ToolContext).supabase,
              userMessage: promptText,
              contextText: threadSummary ?? undefined,
              attempt: { reply: persona.reply ?? '', calls: [...personaCalls, ...agentCalls], result: persona },
              retry: async (addendum) => {
                const retryCalls: RecordedToolCall[] = [];
                try {
                  const persona2 = await runChat(model, promptText, history, ctx, agentId, {
                    summary: threadSummary,
                    tools: personaTools,
                    ...personaCacheOpts,
                    systemAddendum: addendum,
                    onToolResult: recordInto(retryCalls),
                  });
                  return {
                    reply: persona2.reply ?? '',
                    calls: [...retryCalls, ...agentCalls],
                    result: persona2,
                  };
                } catch {
                  return null;
                }
              },
              nearestAction,
            });
            result = {
              ...verdict.attempt.result,
              reply: `${verdict.reply}\n\n${failureNote}`,
            };
            telemetryToolCalls = verdict.attempt.result.toolCalls ?? [];
          } else {
            result = {
              ...persona,
              reply: `${persona.reply}\n\n${failureNote}`,
            };
          }
        }
      } else {
        const personaCalls: RecordedToolCall[] = [];
        result = await runChat(model, promptText, history, ctx, agentId, {
          summary: threadSummary,
          tools: personaTools,
          ...personaCacheOpts,
          ...(verifierOn ? { onToolResult: recordInto(personaCalls) } : {}),
        });
        telemetryToolCalls = result.toolCalls ?? [];
        if (verifierOn) {
          verdict = await verifyWithRetry<VerifiedTurn>({
            projectId: projectId as string,
            db: (ctx as ToolContext).supabase,
            userMessage: promptText,
            contextText: threadSummary ?? undefined,
            attempt: { reply: result.reply ?? '', calls: personaCalls, result },
            retry: async (addendum) => {
              const retryCalls: RecordedToolCall[] = [];
              try {
                const second = await runChat(model, promptText, history, ctx, agentId, {
                  summary: threadSummary,
                  tools: personaTools,
                  ...personaCacheOpts,
                  systemAddendum: addendum,
                  onToolResult: recordInto(retryCalls),
                });
                return { reply: second.reply ?? '', calls: retryCalls, result: second };
              } catch {
                return null;
              }
            },
            nearestAction,
          });
          result = { ...verdict.attempt.result, reply: verdict.reply };
          telemetryToolCalls = result.toolCalls ?? [];
        }
        if (routeDecision.short_circuit === 'low_confidence') {
          // §6.2 step 3: below-threshold artifact asks stay advisory with one
          // plain-text offer chip.
          result = { ...result, reply: `${result.reply}\n\n${OFFER_CHIP_TEXT}` };
        } else if (routeDecision.short_circuit === 'agent_not_enabled') {
          // The classifier positively wanted an agent this caller cannot
          // route to. That drop used to be silent — say it instead.
          result = { ...result, reply: `${result.reply}\n\n${AGENT_NOT_ENABLED_TEXT}` };
        }
      }

      // --- H1 (§22.2): the evidence part, assembled by the ORCHESTRATOR from
      // the recorded tool calls — the model never mints a citation entry. A
      // verified reply renders the "grounded — N sources" chip; a fallback
      // reply renders under the §17.2 errors-and-refusals treatment. The
      // §7.5-safe verifier.blocked_reply event records every save.
      if (verifierOn && verdict) {
        if (verdict.citations.length > 0 || verdict.fallback) {
          result = {
            ...result,
            parts: [...(result.parts ?? []), {
              kind: 'evidence',
              data: {
                citations: verdict.citations,
                verified: verdict.verified,
                fallback: verdict.fallback,
              },
            }],
          };
        }
        if (verdict.fallback) {
          telemetry.emit('verifier.blocked_reply', {
            violations: verdict.violationCounts,
            retried: verdict.retried,
            model_code: resolvedModel.id,
          });
        }
      }

      // §15: the persona names the mode and never silently drops an intent —
      // the notice + one-click "Switch to Review" chip are appended by the
      // SERVER (never the model), after the advisory answer to the same ask.
      if (modeBlocked) {
        result = {
          ...result,
          reply: `${result.reply}\n\n${MODE_NOTICE_TEXT}`,
          parts: [...(result.parts ?? []), modeNoticePart(modeBlocked)],
        };
      }

      // M2 (§14.4): the deterministic memory confirmation/offer joins the same
      // reply. The saved line is appended by the SERVER (never the model) so
      // the user always sees exactly what was stored; the offer chip is a part
      // the client renders with Save/Dismiss — no write until Save.
      if (memorySaved) {
        result = {
          ...result,
          reply: `${result.reply}\n\nSaved to project memory (${memorySaved.kind}): “${memorySaved.content}” — manage it in the Project memory panel.`,
          parts: [...(result.parts ?? []), { kind: 'memory_saved', data: memorySaved }],
        };
      } else if (memorySaveError) {
        result = {
          ...result,
          reply: `${result.reply}\n\nI couldn't save that to project memory: ${memorySaveError}`,
        };
      } else if (memoryOffer) {
        result = {
          ...result,
          parts: [...(result.parts ?? []), { kind: 'memory_offer', data: { ...memoryOffer, project_id: projectId } }],
        };
      }

      // --- H3 (§21.3): the integrity law, enforced after EVERY request that
      // touched a plan — any step still 'active' fails with the cause in its
      // note (budget exhaustion lands as "budget: <meter>"); the plan status
      // is recomputed; the reply carries the FRESH plan snapshot so the
      // rendered checklist matches the stored row.
      if (planToolEnabled() && ctx && (ctx.planTouchedId || routedAgentId)) {
        try {
          const sweep = await sweepPlanIntegrity(supabaseAdmin, {
            planId: ctx.planTouchedId ?? null,
            threadId: typeof threadId === 'string' && uuidRe.test(threadId) ? threadId : null,
            userId,
            cause: budget.budgetHit ? `budget: ${budget.budgetHit}` : undefined,
          });
          for (const ev of ctx.planEvents ?? []) telemetry.emit(ev.kind, ev.payload);
          const planPayload = (p: NonNullable<typeof sweep.plan>) => ({
            plan_id: p.id,
            steps_by_status: stepsByStatus(p.steps),
            resume_count: p.resume_count,
          });
          if (sweep.changed && sweep.plan) telemetry.emit('plan.step_changed', planPayload(sweep.plan));
          if (sweep.closed && sweep.plan) {
            telemetry.emit('plan.closed', { status: sweep.plan.status, ...planPayload(sweep.plan) });
          }
          if (ctx.planTouchedId && sweep.plan && sweep.plan.id === ctx.planTouchedId) {
            result = {
              ...result,
              parts: [...(result.parts ?? []).filter((p) => p.kind !== 'plan'), planPart(sweep.plan)],
            };
          }
        } catch (e) {
          console.warn('[plan] integrity sweep failed:', e instanceof Error ? e.message : e);
        }
      }

      const latencyMs = Date.now() - _t0;
      // A blocked reply or a budget-exhausted turn is not a success. Logging
      // it as one made the usage table read clean while the user got a refusal
      // or the canned exhaustion line.
      logAiUsage({
        status: result?.blocked ? 'blocked' : budget.budgetHit ? 'error' : 'success',
        modelCode: usageModelCode,
        providerCode: resolvedModel.provider,
        promptChars: promptText.length,
        completionChars: (result?.reply ?? '').length,
        latencyMs,
        ...(result?.blocked
          ? { errorCode: 'blocked' }
          : budget.budgetHit
          ? { errorCode: `budget:${budget.budgetHit}` }
          : {}),
      });
      for (const call of telemetryToolCalls) {
        sha256Hex(canonicalJson(call.args ?? {})).then((argsSha) =>
          telemetry.emit('tool.call', {
            tool: call.name,
            args_sha256: argsSha,
            ok: call.ok,
            row_count: call.row_count,
          })
        ).catch(() => { /* never blocks the reply */ });
      }
      // §21.5: every chat.reply event carries the spend
      // ({llm_calls, tool_calls, wall_ms, budget_hit} — §7.7-4).
      telemetry.emit('chat.reply', {
        reply_chars: (result?.reply ?? '').length,
        parts_kinds: (result.parts ?? []).map((p) => p.kind),
        blocked: Boolean(result.blocked),
        ...budgetTelemetryPayload(budget),
      }, { latency_ms: latencyMs });

      // --- Chat store (workstream M0, CHAT_STORE_ENABLED default off): the
      // server appends the assistant message so history survives client
      // crashes (§14.7). The client owns the user-message append.
      let persisted = false;
      const storeEnabled = (Deno.env.get('CHAT_STORE_ENABLED') ?? '').trim().toLowerCase() === 'true';
      if (storeEnabled && typeof threadId === 'string' && uuidRe.test(threadId)) {
        try {
          const { data: seqData, error: appendErr } = await supabaseAdmin.rpc('append_chat_message', {
            p_user_id: userId,
            p_thread_id: threadId,
            p_role: 'assistant',
            p_content: result.reply ?? '',
            p_parts: result.parts ?? [],
            p_tool_calls: result.toolCalls ?? [],
            p_proposal_id: proposalId,
            p_model_code: resolvedModel.id,
          });
          persisted = !appendErr;
          if (appendErr) console.warn('[chat-store] append failed:', appendErr.message);

          // §14.3 trigger: after an assistant reply, if 24+ messages have
          // accumulated past the summarized prefix, queue a refresh
          // (fire-and-forget, same posture as logAiUsage).
          const maxSeq = Number(seqData ?? 0) || 0;
          if (persisted && summariesOn && shouldRefreshSummary(maxSeq, summaryUptoSeq)) {
            const refresh = refreshThreadSummary(supabaseAdmin, {
              threadId,
              userId,
              model: resolvedModel,
            });
            // deno-lint-ignore no-explicit-any
            const rt = (globalThis as any).EdgeRuntime;
            if (rt?.waitUntil) rt.waitUntil(refresh);
            else refresh.catch(() => { /* logged inside */ });
          }
        } catch (e) {
          console.warn('[chat-store] append failed:', e instanceof Error ? e.message : e);
        }
      }

      return jsonResponse(persisted ? { ...result, persisted: true } : result as unknown as Record<string, unknown>);
    } catch (innerErr) {
      logAiUsage({
        status: 'error',
        modelCode: usageModelCode,
        providerCode: resolvedModel.provider,
        promptChars: promptText.length,
        latencyMs: Date.now() - _t0,
        errorCode: innerErr instanceof Error ? innerErr.message.slice(0, 200) : 'unknown',
      });
      // §21.3 (pi-01): a mid-step provider crash must never leave a dangling
      // 'active' step — the sweep fails it with note 'interrupted: <cause>'.
      if (planToolEnabled() && ctx && (ctx.planTouchedId || typeof threadId === 'string' && uuidRe.test(threadId))) {
        try {
          await sweepPlanIntegrity(supabaseAdmin, {
            planId: ctx.planTouchedId ?? null,
            threadId: typeof threadId === 'string' && uuidRe.test(threadId) ? threadId : null,
            userId,
            cause: innerErr instanceof Error ? innerErr.message : 'request failed',
          });
        } catch { /* best effort — the lazy sweep on the next read converges */ }
      }
      throw innerErr;
    }
  } catch (err) {
    console.error('project-ai-chat error:', err, 'model=', model);
    const msg = err instanceof Error ? err.message : 'AI request failed.';
    const isConfig = /not configured/i.test(msg);
    return jsonResponse({
      error: msg,
      type: isConfig ? 'SERVICE_UNAVAILABLE' : 'AI_ERROR',
    });
  }
});

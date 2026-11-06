# SuReSuite Public API & Access Control — Design Plan

| | |
|---|---|
| **Status** | v0.2 — **adopted**; the Phase 0–2 foundation is implemented: gateway `supabase/functions/api` (/v1), migration `20260711000001_api_access_control.sql` (keys/logs/quotas/RPCs), shared dispatch `supabase/functions/_shared/dispatch.ts`, key-management UI at `/developer`, reference docs `docs/api/README.md`, and the §12 Python notebook series (`public/notebooks/suresuite_0[0-5]_*.ipynb`, generated from `notebooks/src` + the `/developer` Notebook tab: per-project config panel, pre-filled download per notebook, Open in Colab by upload; an offline demo mode replays recorded engine output when no key is present). The §16 blueprint edits are applied (G15). Outstanding: webhooks/realtime tokens, OpenAPI generation + SDKs, sandbox seeding, OAuth tokens, pre-launch pen-test (Phases 3–4). |
| **Date** | 2026-07-11 (v0.1 and adoption same day) |
| **Altitude** | Platform capability design: a public, versioned HTTP API over the existing control plane, plus the authentication, authorization, quota, and audit machinery that makes it safe to expose |
| **Authority** | Governed by `docs/design/next-gen-platform-design.md`. This document proposes a **new capability and a new gap (G15)** the blueprint does not yet cover; §16 lists the exact blueprint edits to apply when this plan is adopted, per the "document and code move together" rule in `CLAUDE.md`. |
| **Non-goals** | SQL DDL, finished code, dated schedules, a public billing/pricing system, a GraphQL surface (REST first) |

---

## 0. Reading guide

This plan answers one question: **how does SuReSuite become software other systems can drive through an API — without opening a hole an attacker can walk through?**

It is written in the blueprint's own idiom: *"X already exists as Y — we complete and generalize it."* Almost every mechanism the API needs is already in the repository in embryo — tenancy (`organizations` / `organization_members`), a rate-limit shape (`ai_budgets.rpm/rpd`), an audit pattern (`admin_audit_logs` + `log_admin_action`), a validated command schema (`sim-command`'s Zod `CommandSchema`), a validation gate (§8.2 of the blueprint), and a Redis substrate for token buckets (Upstash). The work is to **assemble these behind one authenticated, authorized, rate-limited gateway** — not to invent a parallel stack.

The governing constraint comes straight from the blueprint's AI-layer guardrail (§12), promoted here to an API-layer law:

> **Every API surface is a subset of the platform's existing, already-guarded operations. The API adds identity, authorization, quotas, and audit — it never adds a privileged path the UI does not already have.**

| Reader wants… | Read |
|---|---|
| Why the current access model can't just be "turned on" as an API | §2 |
| The target shape (one gateway, key auth, scopes, quotas, audit) | §4–§7 |
| The concrete endpoints and how they map to existing operations | §8 |
| "How do I avoid being hacked" — the threat model and hardening | §10 |
| What to build, in what order | §14 |
| How this stays traceable to the blueprint | §16 |

---

## 1. Goals and non-goals

### 1.1 Goals

An external caller (a customer's script, a partner system, a CI job, a notebook) can, with credentials it holds — never a shared browser key — do the following programmatically:

1. **Manage inputs** — create/list projects, upload or edit item-master & network data, freeze a `dataset_version` (§8.4 provenance).
2. **Configure policies** — read the policy catalog, read/write `policy_defaults`/`overrides`, snapshot an immutable `policy_version`.
3. **Run simulations & experiments** — dispatch a run/experiment against a saved policy version, poll or subscribe for status, cancel, add replications.
4. **Retrieve results** — fetch aggregate KPIs, per-replication rows, mapping/validation findings, and the validated-model-card status (§9.5).
5. **Do all of the above safely** — every call authenticated to a specific principal, authorized to a specific tenant/project, rate-limited, quota-bounded, input-validated, and audited.

### 1.2 Non-goals (v1)

- Replacing the browser app's custom `approved_users` login (the API gets its **own** credential type; the two coexist).
- A public network-optimization or surrogate-training API (those land as their engine capabilities land — Phases D/E of the blueprint; the API surface is designed to extend to them).
- Billing/metering-as-a-product. Usage is **measured and quota-enforced** from day one (§7, §11); monetizing it is out of scope.
- Multi-region / sub-100ms SLAs.

---

## 2. Where we are: the current access model (and why it cannot be the API)

An honest assessment, grounded in the code, because the security plan is only as good as this diagnosis.

### 2.1 How access works today

| Fact | Evidence | Consequence for an API |
|---|---|---|
| The frontend ships a **single hardcoded anon/publishable JWT** for all Supabase traffic | `src/integrations/supabase/client.ts:6` | This key is already public (it's in the shipped bundle). It identifies *the app*, not *a caller* — useless as an API credential. |
| Auth is a **custom flow**, not Supabase Auth: `authenticate_approved_user(email,password)` → identity kept in `localStorage` | `src/hooks/useAuth.tsx:49`, `:117` | There is no per-user JWT to verify server-side. An API cannot trust anything the client asserts about who it is. |
| User context for RLS is set by `set_current_user_context({user_id,email})` — a **client-supplied `user_id`** | `useAuth.tsx:70`; GUC `app.current_user_id` set in migration `20250820165722_…` | Safe-ish in a browser right after a password check; **fatal for an API** — a caller could set any `user_id`. Identity must be derived from a server-verified credential, never from the request body. |
| The dispatch edge function authorizes by **"does the project exist"**, using the **service role** | `supabase/functions/sim-command/index.ts:653-664` (and the comment at `:649-652`: *"access control lives in that RPC layer, not here"*) | Any holder of the anon key who knows/guesses a `project_id` can dispatch compute against it. There is **no per-caller tenancy check at the dispatch boundary.** |
| CORS is wide open | `sim-command/index.ts:24` (`Access-Control-Allow-Origin: *`) | Fine for a browser GET pattern; must be tightened and paired with real auth for a credentialed API. |
| No rate limiting or quota on the compute path | `sim-command` enqueues to Upstash unconditionally | Dispatch is expensive (Monte-Carlo on a Fly worker). Unbounded ⇒ trivial cost-amplification / DoS. |
| The validation gate **fails open** on read errors | `sim-command/index.ts:414-418` (`gate_skipped`) | Correct as an *internal* resilience choice, but the API boundary must **fail closed** on auth/authorization/quota — never let a security check's failure become an allow. |

### 2.2 The one-sentence conclusion

**Exposing today's control plane as an API — anon key + client-asserted identity + "project exists" authorization + no quotas — *is* the "getting hacked" scenario.** The API therefore needs its own identity (API keys), its own authorization (tenant/project scopes enforced at the edge), and its own quotas — layered *in front of* the existing operations, which stay unchanged. The same client-asserted-identity flaw is the reason an **agent** (blueprint §12) must resolve its identity through this layer and never assert `p_user_id`/`p_user_email`: an agent stamping a project's org from asserted identity is how a project ends up in the wrong tenant, invisible to its owner (blueprint gap G16, contract in §6.4).

### 2.3 What we can reuse (the good news)

The platform already contains the load-bearing pieces:

| Need | Existing asset | Where |
|---|---|---|
| Tenancy model | `organizations`, `organization_members`, `projects.organization_id` | `20260709000002_super_admin_phase1.sql` |
| Rate-limit shape | `ai_budgets` with `rpm`, `rpd`, `budget_usd`, per `scope∈{user,org,project}` | same migration, lines 182-194 |
| Audit pattern | `admin_audit_logs` + `log_admin_action()` (actor, action, before/after, ip, ua) | same migration, lines 239-274 |
| Usage rollup pattern | `ai_usage_logs` + `v_admin_user_usage` view | same migration, lines 206-304 |
| Validated input schema | Zod `CommandSchema` (project_id, kind, payload) | `sim-command/index.ts:36-51` |
| Pre-dispatch data gate | `runValidationGate` / required-data manifest (§8.1–8.2) | `_shared/validationGate.ts`, `_shared/grading.ts` |
| Token-bucket substrate | Upstash Redis (already the worker queue) | `sim-command/index.ts:55-66` |
| Admin surface to hang key management on | `src/pages/admin/*` (AdminUsers, AdminUsage, AdminAudit) | `src/pages/admin/` |
| Schema-generation doctrine | registry export → generated forms/validators/docs (§6.2) | `scsim/scsim/io/registry_export.py` |

The API is mostly **wiring these together**, which is why it can be shipped incrementally and safely.

---

## 3. Design principles

1. **The gateway is a thin, authenticated façade.** It authenticates, authorizes, rate-limits, validates, then **delegates to the exact same RPCs and `sim-command` logic the UI uses**. No business logic forks into the API. (Guardrail of §0.)
2. **Least privilege, end to end.** A key grants the narrowest scope that works; the gateway holds the service role, the caller never does; a read key can never write; a project-scoped key can never touch another project.
3. **Defense in depth.** Auth at the edge **and** tightened authorization RPCs in the DB **and** RLS as a backstop. A single-layer bypass must not be a full compromise.
4. **Fail closed at the boundary.** Auth, authorization, and quota failures **deny**. (Contrast the internal validation gate, which may fail open — that is a data-completeness check, not a security control.)
5. **Everything is auditable and attributable.** Every API request resolves to `(api_key_id, principal, org, project, scope)` and lands in an append-only log. Provenance (the three-hash triangle, §8.4) already makes *results* reproducible; the API makes *access* reproducible.
6. **Secrets are hashed, shown once, rotatable.** No recoverable secret is ever stored. Every credential can be revoked and expired.
7. **Generated, not hand-maintained, contracts.** Request/response schemas for policy-shaped payloads are generated from the registry export (§6.2), so the API cannot drift from the engine any more than the forms can.

---

## 4. Target architecture

One new versioned edge function, `api` (routes under `/v1/**`), is the **single public entry point**. It runs the same per-request pipeline for every route:

```
Request ──▶ [1 CORS/preflight]
        ──▶ [2 Authenticate]    resolve api_key from `Authorization: Bearer sk_…`; verify hash; check active/expiry
        ──▶ [3 Resolve principal] key → org, creator, scopes, allowed project_ids
        ──▶ [4 Authorize]       route+method needs scope S and project P ∈ key's tenancy? else 403
        ──▶ [5 Rate-limit]      Upstash token bucket per (key, window); quotas (concurrent runs, reps) ; else 429
        ──▶ [6 Validate]        Zod schema per route (+ registry-generated schema for policy payloads); else 400/422
        ──▶ [7 Delegate]        call existing RPC / sim-command logic with SERVICE ROLE, scoped to resolved tenant
        ──▶ [8 Audit + respond] append api_request_logs row; return typed JSON (+ Idempotency replay if applicable)
```

```mermaid
flowchart LR
    CALLER["API caller<br/>(script / partner / CI)"]
    subgraph Edge["Supabase Edge — new `api` function (/v1)"]
        AUTH["authn: API key → hash lookup"]
        AUTHZ["authz: scope + tenancy check"]
        RL["rate limit + quota (Upstash)"]
        VAL["validate (Zod + registry schema)"]
        DELEG["delegate (service role)"]
        AUD["audit log"]
    end
    RPC["existing SECURITY DEFINER RPCs<br/>list_projects, policy_* , snapshot_dataset, …"]
    SIM["sim-command dispatch logic<br/>(validation gate → Upstash → run row)"]
    DB["Postgres: projects / policy_versions / simulation_runs / run_replications / model_validations"]
    WK["Fly worker (sole result writer)"]
    CALLER -->|Bearer sk_…| AUTH --> AUTHZ --> RL --> VAL --> DELEG
    DELEG --> RPC --> DB
    DELEG --> SIM --> DB
    SIM -->|Redis stream| WK --> DB
    DELEG --> AUD
```

**Why a dedicated `api` function rather than exposing `sim-command` directly:**
- `sim-command` is optimized for a trusted first-party browser (anon key, `*` CORS, project-exists check). Bolting API auth onto it would entangle two very different trust models.
- A separate function lets the API have its **own** CORS policy, key-based auth, versioned routes (`/v1`), and stricter fail-closed posture, while it *reuses* `sim-command`'s dispatch **logic** (extracted into `_shared/dispatch.ts`) so there is still one code path to the worker.

**Recommended stack choice (with the alternative stated):** build the gateway as a **Supabase Edge Function**, consistent with every other server component in this repo (Deno + `_shared`). The alternative — a standalone API service (e.g. on Fly, next to the worker) — buys richer middleware and connection pooling but adds a deployment target, a second secrets surface, and network hops to Postgres. **Recommendation: start on edge functions; revisit a standalone gateway only if per-request latency or middleware needs force it** (§17 open question 1).

---

## 5. Authentication: API keys

### 5.1 Credential model

API keys are the v1 credential. They are **independent of the `approved_users` login** — issued to a principal (a user and/or an org), never derived from a browser session. **A service-principal *agent* (blueprint §12 roster) is one such principal:** it holds its own org-anchored, narrowly-scoped key, so an agent's identity — and therefore the org its created projects inherit and are visible under — is resolved here, not asserted (§6.4).

Key string format (shown to the caller **once**, at creation):

```
sk_live_<keyid8>_<secret32>      # live traffic
sk_test_<keyid8>_<secret32>      # sandbox / non-billable / rate-limited harder
```

- `keyid8` — a public, indexed prefix used to **look up** the row in O(1) without scanning.
- `secret32` — ≥256 bits of CSPRNG entropy. **Only a hash is stored** (SHA-256 of the secret is acceptable given the entropy; Argon2id if we ever allow low-entropy secrets). The plaintext is never persisted or logged.
- `sk_test_` keys are routed to a sandbox tenancy and can never dispatch large sweeps — safe for docs/examples.

### 5.2 `api_keys` table (concept)

| Column | Purpose |
|---|---|
| `id`, `key_prefix` (unique, indexed) | identity + fast lookup |
| `secret_hash` | SHA-256/Argon2id of the secret; never the plaintext |
| `org_id` → organizations | tenancy anchor (required) |
| `created_by` → approved_users | who minted it |
| `scopes text[]` | e.g. `{read:runs, write:runs, read:data}` (§6.1) |
| `project_ids uuid[] NULL` | NULL = all projects in the org; non-NULL = restricted set |
| `env text` | `live` \| `test` |
| `status`, `expires_at`, `last_used_at`, `revoked_at`, `revoked_by` | lifecycle |
| `created_at`, `name`, `note` | management/UX |

RLS: only `current_is_super_admin()` or the key's `org` admins can read/manage rows for their org — **plus app-role `modeler`** *(v0.2 implementation decision: modelers are this app's developer persona, and a modeler-led org would otherwise have nobody who can mint a key; plain `user` accounts cannot)*; **`secret_hash` is never exposed to any read path** (the table has no anon/authenticated grants at all — every UI read goes through `list_api_keys`, which omits the hash). Writes go through SECURITY DEFINER RPCs (`create_api_key`, `revoke_api_key`, `rotate_api_key`) that return the plaintext exactly once, on creation, and log to `admin_audit_logs`.

> **Residual risk (documented, accepted for v1):** the key-management RPCs are called from the
> browser tier and therefore inherit its client-asserted identity (`p_user_id` +
> `set_current_user_context`, §2.1) — the same trust model as `list_projects` and every other
> write RPC in the app. This adds no *new* capability to an anon-key holder (who can already
> assert identity against all of those), and every mint/rotate/revoke is audited with the
> asserted actor — but Q2 (migrating the browser app to a server-verified identity) is what
> ultimately closes it. **The API path itself is unaffected:** `/v1` identity comes only from
> the hashed key.

### 5.3 Verification flow (gateway step 2)

1. Parse `Authorization: Bearer sk_…`; reject non-`sk_` immediately (401).
2. Split `key_prefix`; look up the row. Missing/revoked/expired ⇒ 401 (constant-time-ish: always hash before comparing to avoid a lookup-timing oracle).
3. Hash the presented secret; constant-time compare to `secret_hash`. Mismatch ⇒ 401.
4. Stamp `last_used_at` (async, best-effort — never block the request on it).

### 5.4 Lifecycle

- **Rotation:** `rotate_api_key` mints a new secret for the same scopes with an overlap window; old secret expires after N days. Clients rotate without downtime.
- **Revocation:** immediate (`revoked_at`), effective on the next request (and cache TTL ≤ 60s if the gateway caches key rows).
- **Expiry:** optional `expires_at`; expired keys 401 with a distinct `code` so clients can detect it.
- **Leak response:** revoke + rotate is a one-click admin action; `admin_audit_logs` shows every action taken with a leaked key.

### 5.5 Phase-2 option: short-lived tokens (OAuth2 client-credentials)

For partners who prefer not to send a long-lived secret on every call, add a `/v1/oauth/token` endpoint issuing short-lived (e.g. 15-min) signed JWTs from an API key. Keys stay the root credential; tokens reduce secret exposure on the wire. Deferred to Phase 4 (§14) — API keys cover v1.

---

## 6. Authorization: scopes and tenancy

Authentication says *who*; authorization says *what on whose data*. Both must pass.

### 6.1 Scopes (what)

Coarse, resource-plus-verb scopes — enough to enforce least privilege without over-engineering:

| Scope | Grants |
|---|---|
| `read:data` / `write:data` | read / edit projects, item masters, network, dataset versions |
| `read:policies` / `write:policies` | read catalog & configs / edit & snapshot policy versions |
| `read:runs` / `write:runs` | read runs & results / dispatch, cancel, add reps |
| `read:experiments` / `write:experiments` | (as the experimentation layer lands, §9 of blueprint) |
| `admin:keys` | mint/rotate/revoke keys (org-scoped; usually humans, not machines) |

A route declares the scope it requires; the gateway checks membership in the key's `scopes[]`. Missing scope ⇒ **403** (distinct from 401 missing/invalid key).

### 6.2 Tenancy (whose data) — the gap this closes

Every request that names a `project_id` (path or body) is checked:

```
project.organization_id == key.org_id
  AND (key.project_ids IS NULL OR project_id = ANY(key.project_ids))
```

This is enforced in the gateway **before** delegating, and re-checked in a new authorization RPC (`api_can_access_project(key_org, project_id)`) so the DB is not solely trusting the edge. **This is precisely the check `sim-command` does not do today** (§2.1) — the API closes it at its own boundary and hardens the shared dispatch path behind it.

Tenancy reuses `organizations` / `projects.organization_id` directly — no new tenancy concept.

### 6.3 Defense in depth

- **Edge:** scope + tenancy (above).
- **DB:** new `api_*` RPCs are SECURITY DEFINER but take the resolved `org_id` and re-verify project ownership; they never accept a caller-asserted user_id (the `set_current_user_context` anti-pattern is *not* reachable from the API path).
- **RLS backstop:** tables keep RLS on; the gateway's service-role delegation is deliberate and audited, not a blanket bypass — reads that *can* be expressed under RLS use the anon/authenticated role scoped to the resolved org where feasible.

### 6.4 Agent principals and project tenancy

*(added with the blueprint's agent run-readiness contract — `next-gen-platform-design.md` §12, gap G16.)*

The five-agent roster (blueprint §12) is not a new trust model: **an agent is just another principal driving the platform's existing operations, and it resolves to a real `(principal, org, project, scope)` through this access-control layer — never through free-form asserted identity.** This is the load-bearing link between "who the agent is" and "which project it creates," and it is what makes an agent-created project *visible to its intended owner* rather than stranded in the wrong tenant.

**Two principal shapes, one resolution path:**

- **On behalf of a user (delegated).** The agent runs inside a user's authenticated context and acts with that user's org and scopes — the same `(principal, org)` the user would act under directly. The agent's writes are the user's writes, gated identically.
- **As a service principal.** The agent is issued its own API key (§5) anchored to a specific `org_id`, with the narrowest `scopes[]` its task needs (e.g. A1 Data Steward: `write:data`; A2 Policy Configurator: `write:policies`, `write:runs` only if it also dispatches) and, where possible, a restricted `project_ids[]`. It is a first-class key holder, minted, rotatable, and revocable like any other.

Either way, **the org the agent acts in is the org its created project inherits.** Project creation flows through the same lifecycle RPC a human uses, whose `set_project_defaults` trigger stamps `organization := get_current_user_org()` from the *resolving* identity at create time; and `list_projects` returns only rows where `organization = get_current_user_org()`. So the identity the access-control layer resolves for the agent **is** the identity that governs its project's visibility. An agent that asserted `p_user_id`/`p_user_email` free-form (the §2.1 anti-pattern) could stamp — and then fail to see — a project in an unintended org; the API path forbids exactly this (§6.3), which is why agents must ride it.

**`api_can_access_project` gates every agent read and write.** Each agent operation naming a `project_id` passes the same tenancy check as any API request (§6.2): `project.organization_id == key.org_id AND (key.project_ids IS NULL OR project_id = ANY(key.project_ids))`, enforced at the edge and re-verified in the DB. An agent therefore cannot read or mutate a project outside its resolved tenancy — the same wall that stops one org's key from touching another org's data. Newly created projects fall under the key's org by construction (the stamping above), so the agent that created a project can immediately self-verify it via `list_projects` and read it back through `api_can_access_project` — the exact trail the run-readiness contract requires (§12).

**No privileged path, fully attributed.** Agents add no new write surface: they create, seed, and configure through the same RPC lifecycle, the same required-data/pre-run gates, and the same `bulk_upsert_policy_overrides` the UI uses. Every agent write is audited to its resolving principal via `api_request_logs` (§11) and, for key lifecycle, `admin_audit_logs` (§7-adjacent) — reusing the existing audit fabric, no agent-specific provenance store. This is the access-control realization of the blueprint's guardrail that "every agent tool surface is a subset of the platform's existing public interfaces."

---

## 7. Rate limiting, quotas, and abuse control

Compute is the expensive, abusable resource. Three cooperating limits, all reusing existing patterns.

### 7.1 Request-rate limits (per key)

- Token bucket in **Upstash Redis** (already present), keyed `ratelimit:{key_id}:{window}`. Sliding window: `rpm` and `rpd` per key, mirroring `ai_budgets.rpm/rpd`.
- Defaults by env: `sk_test_` far stricter than `sk_live_`.
- Over limit ⇒ **429** with `Retry-After` and `X-RateLimit-{Limit,Remaining,Reset}` headers.

### 7.2 Compute quotas (per org/key) — the real DoS guard

Rate-limiting requests is not enough: one request can queue a 200-replication sweep. So the **write:runs** path additionally enforces:

| Quota | Enforced where | Default |
|---|---|---|
| Max `replications` per run | clamp in dispatch (already `min(200,…)` at `sim-command:439`) | keep 200; make it a per-org ceiling |
| Max **concurrent** queued/running runs per org | count `simulation_runs` where status∈{queued,running} before enqueue | e.g. 5 (live), 1 (test) |
| Max runs per day / compute-seconds per month per org | `api_rate_limits` row (extends the `ai_budgets` shape) | tiered |
| Max experiment sweep size (cells) | validate before fan-out (when experiments API lands) | tiered |

Exceeding a compute quota ⇒ **429** (transient) or **402/403** (quota exhausted), with a machine-readable `code`.

### 7.3 Idempotency (correctness *and* cost control)

- `write:runs` accepts an `Idempotency-Key` header. The gateway stores `(key_id, idempotency_key) → run_id` for a TTL; a retry returns the **same** run instead of dispatching a duplicate. Safe retries, no double-charge.
- This dovetails with the blueprint's content-addressed **run cache** (§9.2): once `RunKey` caching lands, an idempotent submit of an identical `(graph,policy,scenario,seed)` can return cached results with **zero** compute — the API becomes the natural front door for "never simulate the same thing twice."

### 7.4 Input hardening

- Body size cap (e.g. 512 KB for config, larger only for bulk data upload endpoints which stream).
- Strict Zod per route; **`extra: forbid`-style rejection** of unknown fields (mirrors the engine's Pydantic `extra="forbid"`, A2).
- Policy-shaped payloads validated against the **registry-generated** schema (§6.2) — the API cannot accept a policy the engine can't run.
- The existing **required-data validation gate** (§8.2) runs on dispatch exactly as it does for the UI, but at the API boundary it **fails closed** for auth/quota while retaining the gate's own `block`/`warn` semantics for data completeness.

---

## 8. The endpoint surface (`/v1`)

REST resources that map 1:1 onto operations that already exist. Async operations (runs) return `202` + an id; results are polled or pushed (§9).

| Method & path | Scope | Delegates to (existing) | Notes |
|---|---|---|---|
| `GET /v1/projects` | read:data | `list_projects` RPC | org-scoped list |
| `GET /v1/projects/{id}` | read:data | project read RPC | tenancy-checked |
| `POST /v1/projects/{id}/datasets:freeze` | write:data | `snapshot_dataset` RPC | returns `dataset_version_id` + `graph_hash` (§8.4) |
| `GET /v1/projects/{id}/dataset-versions` | read:data | `list_dataset_versions` | provenance history |
| `GET /v1/projects/{id}/policy-catalog` | read:policies | registry export (`registry.generated.json`) | the honest catalog (A3) |
| `GET/PUT /v1/projects/{id}/policies` | read/write:policies | policy defaults/overrides RPCs (`20260609000025`) | registry-validated body |
| `POST /v1/projects/{id}/policy-versions` | write:policies | policy snapshot RPC (A5) | returns `policy_version_id` + `policy_hash` |
| `GET /v1/projects/{id}/scenarios` · `POST …/scenarios` | read/write:runs | scenarios table RPCs | horizon, disruptions, reps, seed |
| `POST /v1/projects/{id}/runs` | write:runs | shared dispatch (`sim-command` logic) | body = `{scenario_id, policy_version_id, acknowledge_warnings?}`; `Idempotency-Key`; → `202 {run_id}` |
| `GET /v1/runs/{run_id}` | read:runs | `simulation_runs` read | status, aggregates, hashes, `gate_skipped`, `model_validation_id` |
| `GET /v1/runs/{run_id}/replications` | read:runs | `run_replications` read | per-rep KPIs + weekly series |
| `POST /v1/runs/{run_id}:cancel` | write:runs | dispatch cancel path | |
| `POST /v1/runs/{run_id}:add-reps` | write:runs | dispatch add-reps path | |
| `GET /v1/runs/{run_id}/validation` | read:runs | `model_validations` / mapping report (§9.5) | credibility badge: validated/stale/unvalidated |
| `POST /v1/projects/{id}/experiments` *(Phase 4)* | write:experiments | experiment machinery (§9.1) | comparison / DOE / stress / portfolio |
| `POST /v1/webhooks` · `GET/DELETE …` | admin:keys | `api_webhooks` (§9) | signed callbacks |
| `GET /v1/key` | any valid key | the authenticated principal (§5.3) | the caller's own key: effective scopes, env, principal, project restriction — lets a client say what is missing before it starts |
| `GET /v1/keys` · `POST …` · `POST …:rotate/revoke` | admin:keys | key RPCs (§5.2) | secret shown once |

Conventions: cursor pagination (`5–10` items/page, matching the GitHub-MCP guidance the repo already follows), consistent error envelope `{error:{code,message,details}}`, ISO-8601 timestamps, and `X-Request-Id` echoed for support.

---

## 9. Async, webhooks, and realtime

Runs are asynchronous (the Fly worker is the sole result writer, A11). Three delivery options, cheapest first:

1. **Polling** — `GET /v1/runs/{id}` until `status ∈ {done, failed, cancelled}` (the worker's vocabulary: `queued → running → done | failed | cancelled`). Always available; document a backoff.
2. **Webhooks** — the caller registers an HTTPS URL; the platform POSTs `run.succeeded` / `run.failed` events, **HMAC-signed** with a per-endpoint secret (`X-SuReSuite-Signature`), with retries + a replay-protection timestamp. A tiny `api-webhook-dispatch` worker (or a DB trigger on `simulation_runs` status change → enqueue) fans these out. Signing prevents forged callbacks; the secret is per-endpoint and rotatable.
3. **Realtime (advanced)** — issue a **short-lived, channel-scoped** Realtime token so a caller can subscribe to `sim:{project_id}` (the channel `sim-command` already broadcasts on). Never hand out the anon key for this — mint a scoped token.

---

## 10. Threat model & hardening — "to avoid being hacked"

The explicit answer to the user's second ask. Framed STRIDE-style, each row names the control and the existing asset it builds on.

| Threat | Vector against a naive API | Control in this design |
|---|---|---|
| **Spoofing** (pretend to be someone) | Reuse the public anon key; forge `user_id` via `set_current_user_context` | API keys with hashed secrets (§5); identity derived **only** from the verified key, never from the body; the `set_current_user_context` path is unreachable from `/v1` (§6.3) |
| **Tampering** (alter requests/callbacks) | Modify payloads in transit; forge webhooks | TLS everywhere; strict per-route validation; **HMAC-signed webhooks** (§9) |
| **Repudiation** ("wasn't me") | No record of who did what | `api_request_logs` (append-only) + `admin_audit_logs` for key lifecycle (§11); every result already reproducible via the three-hash triangle (§8.4) |
| **Information disclosure** (see others' data) | Guess a `project_id` and dispatch/read it (today's `sim-command` gap) | Tenancy check on every `project_id` (§6.2); service role held only by the gateway; `secret_hash` never in any read path; error messages don't leak existence (404 vs 403 chosen deliberately) |
| **Denial of service / cost amplification** | Flood dispatch; queue giant sweeps | Per-key rate limits + **compute quotas** (concurrent runs, reps, sweep cells) + idempotency (§7); Upstash token buckets |
| **Elevation of privilege** | Read key that can write; test key that hits prod scale | Least-privilege scopes (§6.1); `sk_test_` sandboxed & clamped; no scope ⇒ 403; keys can never assume the service role |
| **Secret sprawl** | Long-lived shared secrets, keys in logs | Show-once + hash-at-rest + rotation/expiry (§5.4); **redact `Authorization` and `sk_` patterns from all logs**; secrets via `cleanEnv` (existing hygiene, `_shared/env.ts`); optional short-lived tokens (§5.5) |

### 10.1 Cross-cutting hardening checklist

- **Rotate the service-role key** and confirm it is *never* shipped to any client; only the gateway (server-side) holds it. Consider rotating the anon key and scoping the browser app off any endpoint the API also fronts.
- **Lock CORS for `/v1`.** Credentialed API traffic should not use `Access-Control-Allow-Origin: *`. Either require no CORS (server-to-server) or allowlist explicit dev origins; never combine `*` with credentials.
- **Fail closed** on auth/authorization/quota; **fail open only** for the *internal* data-completeness gate (and keep recording `gate_skipped`).
- **Constant-time** secret comparison; hash before compare even on prefix miss (no timing oracle).
- **Rate-limit unauthenticated 401s** by IP to blunt key-guessing / enumeration.
- **Dependency & secret hygiene:** pin edge deps; run the repo's `run_secret_scanning` before any key-handling code merges; add the `/security-review` skill to the API PR checklist.
- **PII & data governance:** decide what run outputs may cross the API boundary; redact where needed; document retention for `api_request_logs`.
- **Pre-launch:** a focused pen-test / red-team of the gateway (auth bypass, IDOR on `project_id`, quota bypass, webhook forgery) before `sk_live_` is offered externally.

---

## 11. Observability & audit

- **`api_request_logs`** (append-only, indexed on `created_at`, `api_key_id`, `org_id`) — one row per request: method, route, status, `project_id`, scope used, latency, bytes, `X-Request-Id`, truncated error code. Modeled on `ai_usage_logs` (§2.3).
- **`admin_audit_logs`** (exists) — key mint/rotate/revoke and webhook changes, via `log_admin_action()`.
- **Dashboards** — extend the admin surface (`src/pages/admin/AdminUsage.tsx`, `AdminAudit.tsx`) with per-key request/usage rollups, mirroring `v_admin_user_usage`. Owners see their keys' traffic; super-admins see all.
- **Alerting** — anomaly signals: 401 storms (key-guessing), a single key's rate spike, quota-exhaustion clusters, webhook failure rates. Wire to the existing notification path.

---

## 12. Developer experience

The API is only "software" if it's usable:

- **OpenAPI 3.1 spec**, versioned with `/v1`. Policy/scenario request bodies are **generated from the registry export** (§6.2) so the spec cannot drift from the engine — same CI-gate discipline as the docs (A13).
- **Reference docs** rendered from the spec (a new `docs/api/` tree or MkDocs page), with authenticated quickstarts.
- **Key management UI** in the admin dashboard: create (show-once), list, rotate, revoke, view usage — reusing the admin pages.
- **SDKs (Phase 3+):** thin TS and Python clients generated from the OpenAPI spec (Python especially — the analyst/notebook audience the blueprint calls out in §10.2 "For researchers/education").
- **Notebooks (delivered):** four Python notebooks, each mirroring one app workflow (quickstart, policy A/B, stress tests, simulating on your own machine; trimmed from six on 2026-10-02). Their client is authored once in `notebooks/src/common/` and inlined by `scripts/notebooks/build-notebooks.mjs` (a customer uploads one file to Colab and cannot import from a private repository); `npm run notebooks:check` gates drift, and every notebook runs in CI with no key against recorded engine output. The same client is the `suresuite` package (`python/`, Phase 12): pull frozen inputs, install the engine through `GET /v1/engine`, run it locally.
- **Sandbox:** `sk_test_` keys + a seeded reference project so integrators can build without touching production data or burning compute.

---

## 13. Data-model additions (concept-level)

All follow the platform's established immutable/audit-log patterns (A5); no DDL here.

| Store | Keyed by | Holds |
|---|---|---|
| `api_keys` | `key_prefix` | hashed secret, org, scopes, project restriction, lifecycle (§5.2) |
| `api_rate_limits` | `(scope, scope_id, period)` | rpm/rpd, concurrent-run cap, monthly compute budget (extends `ai_budgets`) |
| `api_request_logs` | `id` (+ time/key indexes) | per-request audit & usage (§11) |
| `api_webhooks` | `id` | endpoint URL, signing secret (hashed), event filter, status |
| `api_idempotency` | `(key_id, idempotency_key)` | `→ run_id`, TTL (§7.3) |

---

## 14. Rollout plan (phases with exit criteria)

Sequenced so the **security foundation ships before any write capability**, and read-only before dispatch.

**Phase 0 — Foundation & read-only spine.**
- `api` edge function skeleton with the full pipeline (§4), but only `GET /v1/projects` + `GET /v1/runs/{id}` wired.
- `api_keys` + `create/revoke/rotate` RPCs; show-once minting; `api_request_logs`; key-management UI in admin.
- Gateway holds service role; scope + tenancy checks live from day one.
- **Exit:** an external `sk_test_` key can list its org's projects and read a run, every call authenticated, tenancy-checked, and audited; another org's key gets 403; no anon key involved.

**Phase 1 — Read API GA + limits.**
- Remaining read endpoints (policies, dataset-versions, replications, validation status).
- Upstash token-bucket rate limiting; `X-RateLimit-*`/`Retry-After` headers; 401-by-IP throttle.
- OpenAPI spec + reference docs (read subset).
- **Exit:** documented, rate-limited, read-only API a partner can integrate against; dashboards show per-key usage.

**Phase 2 — Write & dispatch.**
- Extract `sim-command` dispatch into `_shared/dispatch.ts`; `POST /v1/…/runs` (+ cancel, add-reps) delegating to it.
- Compute quotas (concurrent runs, reps, daily cap) + `Idempotency-Key`; validation gate at the boundary, fail-closed auth.
- Policy/scenario write endpoints with registry-generated validation.
- **Exit:** an external caller can configure a policy version and dispatch a bounded run, with duplicate-submit protection and quota enforcement; abuse attempts are throttled/blocked and visible in logs.

**Phase 3 — Push & tooling.**
- HMAC-signed webhooks + realtime scoped tokens; TS/Python SDKs; sandbox reference project.
- Pre-launch pen-test of the gateway; secret-scanning + `/security-review` gates on the API code.
- **Exit:** `sk_live_` offered to first external integrators; end-to-end "submit → webhook → fetch results" works with signature verification.

**Phase 4 — Advanced surface.**
- OAuth2 client-credentials short-lived tokens (§5.5); experiment endpoints (§9.1) and, as they land, surrogate/criticality endpoints (§11 of blueprint); finer-grained per-endpoint quotas.
- **Exit:** the API tracks the experimentation and AI layers as they productize — same gateway, new scopes.

**Agent interoperability (G22).** `docs/design/agent-interop-plan.md` adds an MCP route to this gateway (`/v1/mcp`). It goes through the same pipeline with personal keys only, and its webhooks and OAuth packages (AG.7, AG.8) are this plan's Phase 3 push half and Phase 4 tokens, made concrete for agent hosts. It adds no endpoint that bypasses §4.

---

## 15. How this rides the existing roadmap

The API is **cross-cutting infrastructure**, not a single blueprint phase. Its natural anchor is the blueprint's **Phase C (experimentation productized)** — the API's headline value is programmatic runs/experiments and content-addressed reuse (§9.2), which Phase C delivers — but its **security foundation (Phases 0–1 above) can and should start earlier**, in parallel with Phase B, because it depends only on artifacts that already exist (tenancy, audit, dispatch, Upstash). The write/dispatch surface (Phase 2) should not GA until the validation gate and provenance triple are solid (blueprint Phases A/B0, already largely shipped), so that every API-dispatched run is as reproducible and validated as a UI-dispatched one.

---

## 16. Blueprint integration & traceability (edits to apply on adoption)

Per `CLAUDE.md` ("the document and the code move together; the blueprint is never allowed to go stale"), adopting this plan entails these edits to `docs/design/next-gen-platform-design.md`, made in the same PR as the first API code *(✅ all five applied with the Phase 0–2 implementation)*:

1. **Gap catalog (§2.3):** add **G15 — "No programmatic API or external access-control layer."** Evidence: `sim-command` authorizes by project-existence with the service role (`index.ts:653-664`); identity is client-asserted (`set_current_user_context`); a single hardcoded anon key fronts all traffic (`client.ts:6`). Consequence: the platform cannot be driven as software by external systems, and cannot be safely exposed as-is.
2. **Roadmap (§13):** add an **"API & Access Control"** workstream noting the foundation begins alongside Phase B and the dispatch surface GAs with Phase C; cross-reference this document.
3. **§12 guardrail:** extend the "every tool surface is a subset of the platform's existing public interfaces" law explicitly to the API (§0 of this doc restates it as API law).
4. **Gap index (Appendix C):** `G15 API & access control → this document, Phases 0–4`.
5. This document becomes a **companion design doc** (as `phase-b0-core-loop.md` is), referenced from §13.

Commit/PR trailer convention (per `CLAUDE.md`): e.g. `API Phase 0 / G15 / §12 guardrail: api-key gateway + tenancy check`.

---

## 17. Risks & open questions

| ID | Risk / question | Disposition |
|---|---|---|
| Q1 | **Edge function vs. standalone gateway service** | Start on edge functions (stack-consistent); revisit only if latency/middleware forces it (§4). |
| Q2 | **Adopt Supabase Auth for a real per-user JWT, or keep custom `approved_users`?** | The API sidesteps it with keys. Longer term, migrating the *browser* app to Supabase Auth would let RLS carry identity natively and shrink the service-role surface — worth a separate decision. |
| Q3 | **Key secret hashing: SHA-256 vs Argon2id** | SHA-256 is sufficient for ≥256-bit random secrets; require Argon2id only if we ever allow user-chosen secrets. |
| Q4 | **Rate-limit/quota tiers & pricing** | Enforce quotas from day one; the *values* per tier are a product decision, not a design blocker. |
| Q5 | **Result-data governance across the API boundary** | Define what run outputs may leave the tenant and the retention window for `api_request_logs` before `sk_live_` GA. |
| Q6 | **RunKey cache exposure** | Once §9.2 caching lands, decide whether cross-org cache hits are ever allowed (default: **no** — cache is org-scoped, mirroring surrogate validity scoping, §11.4). |
| R1 | **Service-role blast radius** — the gateway holds a very powerful key | Isolate it to the `api` function; never log it; rotate on schedule; the tenancy RPC re-checks so a gateway bug isn't automatically a data-crossing bug. |
| R2 | **Schema drift** between API contract and engine | Generate policy/scenario schemas from the registry export with a CI drift gate (§6.2 / A13). |

---

## Appendix A — Example: submit a run and fetch results

```http
POST /v1/projects/8f…/runs HTTP/1.1
Host: api.suresuite.app
Authorization: Bearer sk_live_1a2b3c4d_9f8e…       # the key's secret
Idempotency-Key: 3b1e-quarterly-stress-2026Q3
Content-Type: application/json

{ "scenario_id": "c2…", "policy_version_id": "a7…", "acknowledge_warnings": false }
```
```http
HTTP/1.1 202 Accepted
X-RateLimit-Remaining: 58
{ "run_id": "r_5d…", "status": "queued", "policy_hash": "…", "graph_hash": "…" }
```
Then poll `GET /v1/runs/r_5d…` (or receive a signed `run.succeeded` webhook) and read `GET /v1/runs/r_5d…/replications`. A retry of the POST with the same `Idempotency-Key` returns `r_5d…` — never a second run.

## Appendix B — Pre-launch security checklist (condensed)

- [ ] Service role held only by the `api` function; rotated; never client-shipped; redacted from logs.
- [ ] `/v1` CORS locked (no `*`-with-credentials); 401s IP-throttled.
- [ ] Every `project_id` path/body value tenancy-checked at edge **and** in the authz RPC.
- [ ] Secrets hashed at rest, shown once, rotatable, expirable; constant-time compare.
- [ ] Rate limits + compute quotas + idempotency live on `write:runs` before GA.
- [ ] Webhooks HMAC-signed with per-endpoint rotatable secrets + replay protection.
- [ ] `run_secret_scanning` + `/security-review` clean on the gateway PR; pen-test booked before `sk_live_`.
- [ ] Auth/authorization/quota fail **closed**; only the data-completeness gate fails open (records `gate_skipped`).

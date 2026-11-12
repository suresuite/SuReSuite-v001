// Stateful supabase-like stub for the Stage 1 deterministic tier
// (ai-agents.md §7.4 tier 1). Unlike stub_supabase.ts (which returns seeded
// rows verbatim for the golden-transcript replays), this stub implements
// filter fidelity for eq/in and maybeSingle plus an in-memory proposal fabric
// and item-master write RPCs, so the draft/apply machinery can be driven
// end-to-end offline: idempotency, scope gates, reducer recomputation, the
// full-row merge, and the post-apply findings delta.

export type Row = Record<string, unknown>;

interface Filter {
  kind: "eq" | "in" | "gte" | "lte";
  col: string;
  value: unknown;
}

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

class QueryBuilder implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private wantSingle = false;
  // Stage 4: write fidelity for the dispatch path — .insert({...}).select()
  // .single() and .update({...}).eq(...) as dispatch.ts drives them.
  private mode: "select" | "insert" | "update" = "select";
  private insertRows: Row[] = [];
  private updatePatch: Row | null = null;

  constructor(private rows: Row[]) {}

  select(_cols?: string) { return this; }
  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.insertRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.updatePatch = patch;
    return this;
  }
  eq(col: string, value: unknown) { this.filters.push({ kind: "eq", col, value }); return this; }
  in(col: string, value: unknown[]) { this.filters.push({ kind: "in", col, value }); return this; }
  gte(col: string, value: unknown) { this.filters.push({ kind: "gte", col, value }); return this; }
  lte(col: string, value: unknown) { this.filters.push({ kind: "lte", col, value }); return this; }
  /** PostgREST .or("a.eq.x,b.eq.y") — eq conditions only, which is all the
   * callers use (recovery_playbooks: project_id.eq.<id>,is_system.eq.true). */
  or(expr: string) {
    const conds = expr.split(",").map((c) => {
      const [col, op, ...rest] = c.split(".");
      return { col, op, value: rest.join(".") };
    });
    this.orConds.push(conds);
    return this;
  }
  private orConds: Array<Array<{ col: string; op: string; value: string }>> = [];
  private orOk(r: Row): boolean {
    return this.orConds.every((group) => group.some((c) => c.op === "eq" && String(r[c.col]) === c.value));
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  /** PostgREST .range(from, to), inclusive. */
  range(from: number, to: number) { this.rangeFrom = from; this.limitN = to - from + 1; return this; }
  private rangeFrom = 0;
  maybeSingle() { this.wantSingle = true; return this; }
  /** supabase-js .single(): here identical to maybeSingle (callers assert). */
  single() { this.wantSingle = true; return this; }

  private run(): QueryResult {
    if (this.mode === "insert") {
      const inserted: Row[] = [];
      for (const r of this.insertRows) {
        const row: Row = { id: nextUuid(), created_at: new Date().toISOString(), ...r };
        this.rows.push(row);
        inserted.push(row);
      }
      if (this.wantSingle || this.insertRows.length === 1) {
        return { data: inserted[0] ? structuredClone(inserted[0]) : null, error: null };
      }
      return { data: structuredClone(inserted), error: null };
    }
    if (this.mode === "update") {
      const touched = this.rows.filter((r) =>
        this.filters.every((f) => {
          const v = r[f.col];
          switch (f.kind) {
            case "eq": return String(v) === String(f.value);
            case "in": return (f.value as unknown[]).map(String).includes(String(v));
            case "gte": return Number(v) >= Number(f.value);
            case "lte": return Number(v) <= Number(f.value);
          }
        })
      );
      for (const r of touched) Object.assign(r, this.updatePatch ?? {});
      return { data: structuredClone(touched), error: null };
    }
    let out = this.rows.filter((r) => this.orOk(r) &&
      this.filters.every((f) => {
        const v = r[f.col];
        switch (f.kind) {
          case "eq": return String(v) === String(f.value);
          case "in": return (f.value as unknown[]).map(String).includes(String(v));
          case "gte": return Number(v) >= Number(f.value);
          case "lte": return Number(v) <= Number(f.value);
        }
      })
    );
    if (this.orderCol) {
      const col = this.orderCol;
      out = [...out].sort((a, b) => {
        const d = Number(a[col]) - Number(b[col]);
        return this.orderAsc ? d : -d;
      });
    }
    if (this.limitN != null) out = out.slice(this.rangeFrom, this.rangeFrom + this.limitN);
    // Clone like the wire would: callers must never hold references into the
    // store (the apply path's `before` snapshot depends on this).
    if (this.wantSingle) return { data: out[0] ? structuredClone(out[0]) : null, error: null };
    return { data: structuredClone(out), error: null };
  }

  then<T1 = QueryResult, T2 = never>(
    resolve?: ((r: QueryResult) => T1 | PromiseLike<T1>) | null,
    reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

export type RpcHandler = (args: Record<string, unknown>) => unknown;

export interface StubDb {
  tables: Record<string, Row[]>;
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): Promise<QueryResult>;
}

export function makeStubDb(
  tables: Record<string, Row[]>,
  rpcs: Record<string, RpcHandler> = {},
): StubDb {
  return {
    tables,
    from(table: string) {
      // Materialize missing tables so inserts land in the store, not in a
      // detached array (the Stage 4 dispatch path inserts simulation_runs).
      if (!tables[table]) tables[table] = [];
      return new QueryBuilder(tables[table]);
    },
    rpc(fn: string, args: Record<string, unknown> = {}) {
      const handler = rpcs[fn];
      // PostgREST's own answer for a function the schema does not have (PGRST202),
      // so callers that fall back for a database without a migration — WP 10.4's
      // `find_reusable_runs` / `create_simulation_run` — take that path here too.
      // This stub does not mirror those two; `rehearsal/590` holds them.
      if (!handler) {
        return Promise.resolve({
          data: null,
          error: { code: "PGRST202", message: `no stub rpc: Could not find the function public.${fn}` },
        });
      }
      try {
        return Promise.resolve({ data: handler(args), error: null });
      } catch (e) {
        return Promise.resolve({ data: null, error: { message: e instanceof Error ? e.message : String(e) } });
      }
    },
  };
}

let idCounter = 0;
const nextUuid = () => {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
};

/** djb2 over a canonical JSON — an opaque, state-derived stand-in for the SQL
 * current_policy_hash, so out-of-band mutations drift the hash (pc-08). */
function stubHash(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const s = JSON.stringify(sort(value));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `stub-${h.toString(16)}`;
}

/** In-memory mirror of the proposal fabric + item-master write RPCs + the
 * Stage 2/3 policy/validation RPCs + the M2 memory RPCs — the SQL originals
 * are pinned separately against scratch Postgres (db_rpc_test.ts /
 * db_stage23_test.ts); this mirror lets the tool/apply orchestration run
 * without a database. */
export function makeAgentRpcs(tables: Record<string, Row[]>, opts?: { graphHash?: string }): Record<string, RpcHandler> {
  if (!tables.proposals) tables.proposals = [];

  const FAMILIES = ["sourcing", "inventory", "transport", "fulfillment", "production", "recovery", "demand"];

  const policyHash = (): string => {
    const d = (tables.policy_defaults ?? [])[0] ?? {};
    const overrides = (tables.policy_overrides ?? [])
      .map(({ scope, target_key, family, patch }) => ({ scope, target_key, family, patch }))
      .sort((a, b) =>
        String(a.scope).localeCompare(String(b.scope)) ||
        String(a.target_key).localeCompare(String(b.target_key)) ||
        String(a.family).localeCompare(String(b.family)));
    const defaults: Record<string, unknown> = {};
    for (const f of FAMILIES) defaults[f] = d[f] ?? null;
    return stubHash({
      defaults,
      fulfillment_strategy: d.fulfillment_strategy ?? "make_to_stock",
      overrides,
    });
  };

  const upsert = (table: string, idCol: string, enums: Record<string, string[]>) => (args: Record<string, unknown>) => {
    const rows = (args.p_rows ?? []) as Row[];
    for (const r of rows) {
      for (const [field, allowed] of Object.entries(enums)) {
        const v = r[field];
        if (v != null && v !== "" && !allowed.includes(String(v).toLowerCase())) {
          throw new Error(`invalid ${field} "${v}" — engine accepts: ${allowed.join(", ")}`);
        }
      }
    }
    const store = tables[table] ?? (tables[table] = []);
    for (const r of rows) {
      const id = String(r[idCol] ?? "");
      if (!id) continue;
      const existing = store.find((row) => String(row[idCol] ?? "") === id);
      if (existing) Object.assign(existing, r);
      // Mirror fidelity: the SQL RPCs stamp project_id on every inserted row.
      else store.push({ project_id: args.p_project_id, ...r });
    }
    return rows.length;
  };

  return {
    current_graph_hash: () => opts?.graphHash ?? "graph-hash-1",
    get_project_dataset_counts: () => ({ total_records: 0 }),
    create_agent_proposal: (args) => {
      const live = tables.proposals.filter((p) =>
        String(p.project_id) === String(args.p_project_id) &&
        String(p.idempotency_key) === String(args.p_idempotency_key) &&
        ["draft", "proposed", "approved"].includes(String(p.status))
      );
      if (live.length > 0) return live[0].id;
      const liveByUser = tables.proposals.filter((p) =>
        String(p.project_id) === String(args.p_project_id) &&
        String(p.created_by ?? "") === String(args.p_user_id ?? "") &&
        ["draft", "proposed", "approved"].includes(String(p.status))
      );
      if (liveByUser.length >= 20) throw new Error("too_large: live-proposal cap (20) reached for this project");
      const id = nextUuid();
      tables.proposals.push({
        id,
        project_id: args.p_project_id,
        agent_id: args.p_agent_id,
        artifact_type: args.p_artifact_type,
        title: args.p_title,
        payload: args.p_payload,
        citations: args.p_citations,
        provenance: args.p_provenance,
        grounding: args.p_grounding,
        idempotency_key: args.p_idempotency_key,
        thread_id: args.p_thread_id ?? null,
        status: args.p_status ?? "proposed",
        apply_attempts: 0,
        apply_error: null,
        applied_result: null,
        created_by: args.p_user_id ?? null,
      });
      return id;
    },
    mark_agent_proposal_applied: (args) => {
      const p = tables.proposals.find((r) => String(r.id) === String(args.p_proposal_id));
      if (p && p.status === "approved") {
        p.status = "applied";
        p.applied_result = args.p_result;
        p.apply_error = null;
      }
      return null;
    },
    mark_agent_proposal_apply_failed: (args) => {
      const p = tables.proposals.find((r) => String(r.id) === String(args.p_proposal_id));
      if (p && p.status === "approved") {
        p.apply_attempts = Number(p.apply_attempts ?? 0) + 1;
        p.apply_error = String(args.p_error ?? "").slice(0, 500);
      }
      return null;
    },
    // ── Phase 4d mirror (SQL original: 20260729000001_disruption_sentinel) ──
    // The ONLY writer of a complete risk-alert impact block (§18.3 hard
    // gate 8): fills a pending impact exactly once, applied risk_alerts only.
    update_risk_alert_impact: (args) => {
      const impact = (args.p_impact ?? {}) as Row;
      if (String(impact.status ?? "") !== "complete" || !impact.run_id) {
        throw new Error("impact must be a complete impact object with a run_id");
      }
      const p = tables.proposals.find((r) =>
        String(r.id) === String(args.p_proposal_id) && String(r.artifact_type) === "risk_alert"
      );
      if (!p) throw new Error(`risk_alert proposal ${args.p_proposal_id} not found`);
      if (p.status === "applied") {
        const stored = (p.applied_result ?? {}) as Row;
        const current = (stored.impact ?? {}) as Row;
        if (String(current.status ?? "pending") === "pending") {
          p.applied_result = { ...stored, impact: structuredClone(impact) };
        }
      }
      return structuredClone(p.applied_result);
    },

    // ── Phase 4b mirrors (SQL originals: 20260727000001_network_cartographer
    //    + 20260705000002_assign_material_supplier) ─────────────────────────
    record_external_evidence: (args) => {
      const store = tables.external_evidence ?? (tables.external_evidence = []);
      const tripleJson = JSON.stringify(args.p_triple ?? {});
      const existing = store.find((r) =>
        String(r.project_id) === String(args.p_project_id) &&
        String(r.source_id) === String(args.p_source_id) &&
        String(r.content_hash) === String(args.p_content_hash) &&
        JSON.stringify(r.triple) === tripleJson
      );
      if (existing) return existing.id;
      if (store.filter((r) => String(r.project_id) === String(args.p_project_id)).length >= 5000) {
        throw new Error("too_large: external-evidence cap (5000) reached for this project");
      }
      const id = nextUuid();
      store.push({
        id,
        project_id: args.p_project_id,
        source_id: args.p_source_id,
        url_or_ref: args.p_url_or_ref ?? null,
        content_hash: args.p_content_hash,
        retrieved_at: new Date().toISOString(),
        confidence: args.p_confidence,
        triple: structuredClone(args.p_triple),
        lei: args.p_lei ?? null,
      });
      return id;
    },
    assign_material_supplier: (args) => {
      const materialId = String(args.p_material_id ?? "");
      const supplierId = String(args.p_supplier_id ?? "");
      if (!materialId || !supplierId) throw new Error("material_id and supplier_id are required");
      const project = (tables.projects ?? []).find((p) => String(p.id) === String(args.p_project_id));
      if (!project) throw new Error("project_not_found");
      const plant = String(project.plant_name ?? "");
      const lanes = tables.inbound_logistics ?? (tables.inbound_logistics = []);
      if (!lanes.some((l) =>
        String(l.project_id) === String(args.p_project_id) &&
        String(l.supplier_id) === supplierId && String(l.material_id) === materialId
      )) {
        lanes.push({ project_id: args.p_project_id, plant_name: plant, supplier_id: supplierId, material_id: materialId });
      }
      const edges = tables.supply_chain_data ?? (tables.supply_chain_data = []);
      if (!edges.some((e) =>
        String(e.project_id) === String(args.p_project_id) &&
        String(e.data_source) === "inbound" &&
        String(e.from_location) === supplierId && String(e.to_location) === materialId
      )) {
        edges.push({
          project_id: args.p_project_id, plant_name: plant, data_source: "inbound",
          from_location: supplierId, to_location: materialId,
          material_consumption_rate: 0, sourcing_ratio: 1.0, weighted: 0,
          uploaded_by: args.p_user_id ?? null, organization: project.organization ?? null,
        });
      }
      const sups = tables.suppliers ?? (tables.suppliers = []);
      if (!sups.some((s) =>
        String(s.project_id) === String(args.p_project_id) && String(s.supplier_id) === supplierId
      )) {
        sups.push({ project_id: args.p_project_id, supplier_id: supplierId });
      }
      return null;
    },
    // ── Phase 4c mirrors (SQL originals: 20260728000001_cartographer_product
    //    _level) — the BOM-line / outbound-lane assign sequence, WHERE-NOT-
    //    EXISTS idempotent like assign_material_supplier above. ────────────
    assign_bom_line: (args) => {
      const productId = String(args.p_product_id ?? "");
      const materialId = String(args.p_material_id ?? "");
      const rate = Number(args.p_rate);
      if (!productId || !materialId) throw new Error("product_id and material_id are required");
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("consumption rate must be > 0 (BomLine.rate is a hard engine constraint)");
      }
      const project = (tables.projects ?? []).find((p) => String(p.id) === String(args.p_project_id));
      if (!project) throw new Error("project_not_found");
      const plant = String(project.plant_name ?? "");
      const bom = tables.bom_single_level ?? (tables.bom_single_level = []);
      if (!bom.some((b) =>
        String(b.project_id) === String(args.p_project_id) &&
        String(b.product_id) === productId && String(b.material_id) === materialId
      )) {
        bom.push({ project_id: args.p_project_id, plant_name: plant, product_id: productId, material_id: materialId, consumption_rate: rate });
      }
      const edges = tables.supply_chain_data ?? (tables.supply_chain_data = []);
      if (!edges.some((e) =>
        String(e.project_id) === String(args.p_project_id) &&
        String(e.data_source) === "bom" &&
        String(e.from_location) === materialId && String(e.to_location) === productId
      )) {
        edges.push({
          project_id: args.p_project_id, plant_name: plant, data_source: "bom",
          from_location: materialId, to_location: productId,
          material_consumption_rate: rate, sourcing_ratio: 1.0, weighted: 0,
          uploaded_by: args.p_user_id ?? null, organization: project.organization ?? null,
        });
      }
      return null;
    },
    assign_outbound_customer: (args) => {
      const productId = String(args.p_product_id ?? "");
      const customerId = String(args.p_customer_id ?? "");
      if (!productId || !customerId) throw new Error("product_id and customer_id are required");
      const project = (tables.projects ?? []).find((p) => String(p.id) === String(args.p_project_id));
      if (!project) throw new Error("project_not_found");
      const plant = String(project.plant_name ?? "");
      const lanes = tables.outbound_logistics ?? (tables.outbound_logistics = []);
      if (!lanes.some((l) =>
        String(l.project_id) === String(args.p_project_id) &&
        String(l.product_id) === productId && String(l.customer_id) === customerId
      )) {
        lanes.push({ project_id: args.p_project_id, plant_name: plant, product_id: productId, customer_id: customerId });
      }
      const edges = tables.supply_chain_data ?? (tables.supply_chain_data = []);
      if (!edges.some((e) =>
        String(e.project_id) === String(args.p_project_id) &&
        String(e.data_source) === "outbound" &&
        String(e.from_location) === productId && String(e.to_location) === customerId
      )) {
        edges.push({
          project_id: args.p_project_id, plant_name: plant, data_source: "outbound",
          from_location: productId, to_location: customerId,
          material_consumption_rate: 0, sourcing_ratio: 1.0, weighted: 0,
          uploaded_by: args.p_user_id ?? null, organization: project.organization ?? null,
        });
      }
      return null;
    },
    // G16 self-verification read paths (blueprint §12). The SQL originals
    // filter by the caller's org via set_current_user_context; the mirror's
    // caller IS the project owner, so it returns the seeded projects.
    list_projects: () => structuredClone(tables.projects ?? []),
    get_project_dataset_status: (args) => {
      const project = (tables.projects ?? []).find((p) => String(p.id) === String(args.p_project_id));
      if (!project) throw new Error("project_not_found");
      const inProject = (t: string) =>
        (tables[t] ?? []).some((r) => String(r.project_id) === String(args.p_project_id));
      const hasBom = inProject("bom_single_level") || inProject("bom_multi_level");
      const hasInbound = inProject("inbound_logistics");
      const hasOutbound = inProject("outbound_logistics");
      return {
        bom_level: project.bom_level ?? "single",
        deep_tier_enabled: false,
        has_bom: hasBom,
        has_inbound: hasInbound,
        has_outbound: hasOutbound,
        completed: hasBom && hasInbound && hasOutbound,
      };
    },

    bulk_upsert_materials: upsert("materials", "material_id", {
      lead_time_dist: ["deterministic", "lognormal", "gamma"],
    }),
    bulk_upsert_products: upsert("products", "product_id", {
      fulfillment_mode: ["mto", "mts"],
      demand_distribution: ["triangular", "deterministic", "poisson", "negbin"],
    }),
    bulk_upsert_suppliers: upsert("suppliers", "supplier_id", {}),

    // ── Stage 2 mirrors (SQL originals: 20260609000025 / 20260612000001 /
    //    20260716000001, pinned in db_stage23_test.ts) ────────────────────────
    current_policy_hash: () => policyHash(),
    list_policy_versions: () =>
      [...(tables.policy_versions ?? [])]
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
        .map(({ id, label, parent_version_id, policy_hash, created_at }) => ({
          id, label, author_email: null, author_name: null,
          parent_version_id: parent_version_id ?? null,
          policy_hash: policy_hash ?? null, created_at,
        })),
    apply_policy_bundle: (args) => {
      if (args.p_expected_policy_hash != null && String(args.p_expected_policy_hash) !== policyHash()) {
        throw new Error(
          `stale_values: the policy configuration changed since this proposal was drafted`,
        );
      }
      const store = tables.policy_defaults ?? (tables.policy_defaults = []);
      if (store.length === 0) store.push({ project_id: args.p_project_id });
      const def = store[0];
      for (const [family, patch] of Object.entries((args.p_defaults ?? {}) as Record<string, Row>)) {
        if (!FAMILIES.includes(family)) throw new Error(`unknown policy family ${family}`);
        def[family] = { ...((def[family] ?? {}) as Row), ...patch };
      }
      const oStore = tables.policy_overrides ?? (tables.policy_overrides = []);
      for (const o of (args.p_overrides ?? []) as Row[]) {
        if (!FAMILIES.includes(String(o.family))) throw new Error(`unknown policy family ${o.family}`);
        const existing = oStore.find((row) =>
          String(row.scope) === String(o.scope) &&
          String(row.target_key) === String(o.target_key) &&
          String(row.family) === String(o.family));
        if (existing) existing.patch = { ...((existing.patch ?? {}) as Row), ...((o.patch ?? {}) as Row) };
        else oStore.push({ project_id: args.p_project_id, scope: o.scope, target_key: o.target_key, family: o.family, patch: o.patch ?? {} });
      }
      const vStore = tables.policy_versions ?? (tables.policy_versions = []);
      const hash = policyHash();
      // WP 10.2 (20261001000006): snapshot_policy returns the OLDEST version that
      // already carries this content instead of minting a second one.
      const same = vStore
        .filter((v) => String(v.project_id) === String(args.p_project_id) && v.policy_hash === hash)
        .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))[0];
      if (same) {
        return { policy_version_id: same.id, policy_hash: hash, overrides_applied: ((args.p_overrides ?? []) as Row[]).length };
      }
      const id = nextUuid();
      vStore.push({
        id,
        project_id: args.p_project_id,
        label: args.p_label ?? "agent: policy bundle",
        parent_version_id: args.p_parent_version_id ?? null,
        policy_hash: hash,
        created_at: Date.now() + vStore.length,
      });
      return { policy_version_id: id, policy_hash: hash, overrides_applied: ((args.p_overrides ?? []) as Row[]).length };
    },
    restore_policy_version: (args) => {
      const v = (tables.policy_versions ?? []).find((r) => String(r.id) === String(args.p_version_id));
      if (!v) throw new Error(`Version ${args.p_version_id} not found`);
      return null; // mirror records the call; full restore is pinned in SQL tests
    },

    // ── Stage 4 mirrors ──────────────────────────────────────────────────────
    // snapshot_dataset (20260703000001): deduped server-side — an unchanged
    // dataset reuses its latest version. The mirror returns the newest seeded
    // dataset_versions row (or none, matching a pre-migration database).
    snapshot_dataset: () => {
      const versions = [...(tables.dataset_versions ?? [])]
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
      return versions[0]?.id ?? null;
    },

    // ── Stage 3 mirrors (SQL original: 20260710000001) ───────────────────────
    scenario_fingerprint_hash: (args) => `scen-${args.p_scenario_id}`,
    list_model_validations: () =>
      [...(tables.model_validations ?? [])]
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0)),
    record_model_validation: (args) => {
      const versions = tables.policy_versions ?? [];
      if (!versions.some((v) => String(v.id) === String(args.p_policy_version_id))) {
        throw new Error(`policy version ${args.p_policy_version_id} not found`);
      }
      if (!(tables.dataset_versions ?? []).some((v) => String(v.id) === String(args.p_dataset_version_id))) {
        throw new Error(`dataset version ${args.p_dataset_version_id} not found`);
      }
      if (!(tables.scenarios ?? []).some((s) => String(s.id) === String(args.p_scenario_id))) {
        throw new Error(`scenario ${args.p_scenario_id} not found`);
      }
      const store = tables.model_validations ?? (tables.model_validations = []);
      const graphHash = opts?.graphHash ?? "graph-hash-1";
      const scenarioHash = `scen-${args.p_scenario_id}`;
      const id = nextUuid();
      const prev = store.find((c) =>
        String(c.policy_version_id) === String(args.p_policy_version_id) &&
        String(c.graph_hash) === graphHash &&
        String(c.scenario_hash) === scenarioHash &&
        c.status === "active");
      if (prev) {
        prev.status = "superseded";
        prev.superseded_by = id;
      }
      store.push({
        id,
        project_id: args.p_project_id,
        policy_version_id: args.p_policy_version_id,
        policy_hash: versions.find((v) => String(v.id) === String(args.p_policy_version_id))?.policy_hash ?? "ph",
        dataset_version_id: args.p_dataset_version_id,
        graph_hash: graphHash,
        scenario_hash: scenarioHash,
        adopted_warmup_days: args.p_adopted_warmup_days,
        warmup_method: args.p_warmup_method ?? "engine",
        recommended_replications: args.p_recommended_replications,
        replication_basis: args.p_replication_basis ?? {},
        validation_tests: args.p_validation_tests ?? [],
        findings_snapshot: args.p_findings ?? [],
        verdict: args.p_verdict ?? "validated",
        basis: args.p_basis ?? "statistical",
        evidence_run_id: args.p_evidence_run_id ?? null,
        status: "active",
        superseded_by: null,
        validated_at: Date.now(),
        created_at: Date.now() + store.length,
      });
      return id;
    },
    // WP 10.2 (SQL original: 20261001000006) — matched by CONTENT: the id is
    // resolved to its policy_hash and any card with that hash is this model's.
    active_model_validation: (args) => {
      const v = (tables.policy_versions ?? []).find((x) => String(x.id) === String(args.p_policy_version_id));
      const hash = v?.policy_hash ?? null;
      return (tables.model_validations ?? []).filter((c) =>
        (hash !== null
          ? String(c.policy_hash) === String(hash)
          : String(c.policy_version_id) === String(args.p_policy_version_id)) &&
        String(c.graph_hash) === String(args.p_graph_hash) &&
        String(c.scenario_hash) === String(args.p_scenario_hash) &&
        c.status === "active" && c.verdict === "validated");
    },
    active_model_validation_by_content: (args) =>
      (tables.model_validations ?? []).filter((c) =>
        String(c.project_id) === String(args.p_project_id) &&
        String(c.policy_hash) === String(args.p_policy_hash) &&
        String(c.graph_hash) === String(args.p_graph_hash) &&
        String(c.scenario_hash) === String(args.p_scenario_hash) &&
        c.status === "active" && c.verdict === "validated"),

    // ── M2 mirrors (SQL original: 20260717000003) ────────────────────────────
    save_project_memory: (args) => {
      const content = String(args.p_content ?? "").trim();
      if (!content) throw new Error("memory content must not be empty");
      if (content.length > 500) throw new Error("too_large: memory content exceeds 500 characters");
      if (!["fact", "preference", "decision"].includes(String(args.p_kind))) {
        throw new Error("kind must be fact, preference or decision");
      }
      const store = tables.project_memory ?? (tables.project_memory = []);
      if (store.filter((m) => String(m.project_id) === String(args.p_project_id) && m.status === "active").length >= 200) {
        throw new Error("too_large: active-memory cap (200) reached for this project — archive older entries first");
      }
      const id = nextUuid();
      store.push({
        id,
        project_id: args.p_project_id,
        kind: args.p_kind,
        content,
        citations: args.p_citations ?? [],
        grounding: args.p_grounding ?? {},
        status: "active",
        created_by: args.p_user_id ?? null,
        source_thread_id: args.p_source_thread_id ?? null,
        created_at: Date.now() + store.length,
      });
      return id;
    },
    archive_project_memory: (args) => {
      const m = (tables.project_memory ?? []).find((r) => String(r.id) === String(args.p_id));
      if (m && m.status === "active") m.status = "archived";
      return null;
    },

    // ── H3 mirrors (SQL original: 20260726000001_chat_plans.sql, pinned in
    //    db_plans_test.ts) — the §21.2 plan store the update_task_plan
    //    handler, the resume pre-step, and the client approve flow write. ───
    upsert_chat_plan: (args) => {
      const plan = (args.p_plan ?? {}) as Row;
      const userId = String(args.p_user_id ?? "");
      if (!userId) throw new Error("forbidden");
      const threadId = String(plan.thread_id ?? "");
      if (!threadId) throw new Error("upsert_chat_plan: p_plan.thread_id is required");
      const steps = Array.isArray(plan.steps) ? (plan.steps as Row[]) : [];
      if (steps.length > 12) throw new Error("invalid_params: a plan allows at most 12 steps");
      const store = tables.chat_plans ?? (tables.chat_plans = []);
      if (plan.id == null) {
        for (const p of store) {
          if (String(p.thread_id) === threadId && String(p.user_id) === userId && p.status === "active") {
            p.status = "abandoned";
          }
        }
        const id = nextUuid();
        const row: Row = {
          id,
          thread_id: threadId,
          project_id: plan.project_id ?? null,
          user_id: userId,
          agent_id: plan.agent_id ?? null,
          title: String(plan.title ?? "Task plan").slice(0, 140),
          status: plan.status ?? "active",
          steps: structuredClone(steps),
          resume_count: 0,
          model_code: plan.model_code ?? null,
          expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          created_at: Date.now() + store.length,
        };
        store.push(row);
        return structuredClone(row);
      }
      const row = store.find((p) => String(p.id) === String(plan.id));
      if (!row) throw new Error(`plan ${plan.id} not found`);
      if (String(row.user_id) !== userId) throw new Error("forbidden");
      if (String(row.thread_id) !== threadId) throw new Error(`plan ${plan.id} is not in this thread`);
      if (plan.title != null) row.title = String(plan.title).slice(0, 140);
      if (plan.status != null) row.status = plan.status;
      if (plan.steps != null) row.steps = structuredClone(steps);
      if (plan.model_code != null) row.model_code = plan.model_code;
      if (plan.increment_resume === true) row.resume_count = Number(row.resume_count ?? 0) + 1;
      return structuredClone(row);
    },
    get_chat_plan: (args) =>
      (tables.chat_plans ?? [])
        .filter((p) => String(p.id) === String(args.p_plan_id) && String(p.user_id) === String(args.p_user_id))
        .map((p) => structuredClone(p)),
    expire_chat_plans: (args) => {
      let n = 0;
      for (const p of tables.chat_plans ?? []) {
        if (String(p.thread_id) === String(args.p_thread_id) && p.status === "active" &&
          Date.parse(String(p.expires_at ?? "")) < Date.now()) {
          p.status = "expired";
          n += 1;
        }
      }
      return n;
    },
    list_chat_plans: (args) => {
      for (const p of tables.chat_plans ?? []) {
        if (String(p.thread_id) === String(args.p_thread_id) && p.status === "active" &&
          Date.parse(String(p.expires_at ?? "")) < Date.now()) {
          p.status = "expired";
        }
      }
      return (tables.chat_plans ?? [])
        .filter((p) => String(p.thread_id) === String(args.p_thread_id) && String(p.user_id) === String(args.p_user_id))
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
        .map((p) => structuredClone(p));
    },
    advance_chat_plan_step: (args) => {
      const status = String(args.p_status ?? "");
      if (!["awaiting_run", "failed"].includes(status)) {
        throw new Error("invalid_params: advance_chat_plan_step allows only awaiting_run or failed");
      }
      if (status === "awaiting_run" && args.p_run_id == null) {
        throw new Error("invalid_params: awaiting_run requires p_run_id (§21.1 rule 4)");
      }
      const row = (tables.chat_plans ?? []).find((p) => String(p.id) === String(args.p_plan_id));
      if (!row) throw new Error(`plan ${args.p_plan_id} not found`);
      if (String(row.user_id) !== String(args.p_user_id)) throw new Error("forbidden");
      if (row.status !== "active") throw new Error(`plan ${args.p_plan_id} is not active (is ${row.status})`);
      const steps = (row.steps ?? []) as Row[];
      const step = steps.find((s) => String(s.id) === String(args.p_step_id));
      if (!step) throw new Error(`step ${args.p_step_id} not found on plan ${args.p_plan_id}`);
      if (step.status !== "awaiting_approval") {
        throw new Error(`invalid_params: step ${args.p_step_id} is ${step.status} — only awaiting_approval steps advance here`);
      }
      step.status = status;
      if (args.p_note != null) step.note = String(args.p_note).slice(0, 200);
      if (args.p_run_id != null) {
        step.ref = { ...((step.ref ?? {}) as Row), run_id: args.p_run_id };
      }
      return structuredClone(row);
    },
  };
}

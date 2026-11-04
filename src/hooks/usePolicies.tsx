import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { policyRef } from "@/lib/versions/versionLabels";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useProjectRights } from "@/hooks/useProjectRights";
import { ProjectRightRefused } from "@/lib/auth/projectRights";
import {
  DEFAULT_BUNDLE,
  parseFamily,
  PolicyFamily as PolicyFamilyEnum,
  type FulfillmentStrategy,
  type PolicyBundle,
  type PolicyFamily,
} from "@/lib/policies/schemas";
import type { OverrideRow } from "@/lib/policies/resolve";
import { currentPolicyVersion } from "@/lib/policies/currentPolicyVersion";

export interface PolicyVersion {
  id: string;
  label: string | null;
  /** Free-text description of the model (6.D) — distinct from `label`. */
  notes: string | null;
  author_email: string | null;
  author_name: string | null;
  parent_version_id: string | null;
  policy_hash: string | null;
  created_at: string;
  /** "Policy v4" — one number per content per project (WP 10.2). Absent until the
   *  migration lands and on the direct-select fallback. */
  version_no?: number | null;
  /** "Policy 20261004" — the UTC day this content was first saved, `-n` for the
   *  n-th that day; stored, shared by rows of one content (WP 10.5 follow-up). */
  version_code?: string | null;
  /** How many simulation runs / model cards reference this version — a
   *  version with either is delete-guarded (6.D). Absent on the RLS fallback. */
  run_count?: number;
  card_count?: number;
}

interface UsePoliciesResult {
  defaults: PolicyBundle;
  overrides: OverrideRow[];
  loading: boolean;
  fulfillmentStrategy: FulfillmentStrategy;
  activePreset: string | null;
  presetAppliedAt: Date | null;
  versions: PolicyVersion[];
  currentHash: string | null;
  /** True when the live policies match NO saved version ("unsaved edits"). */
  isDirty: boolean;
  /** The saved version whose content IS the live policies (WP 10.2, §4 D242) —
   *  derived from `policy_hash`, never remembered per page — or null. */
  selectedVersionId: string | null;
  currentVersion: PolicyVersion | null;
  refreshVersions: () => Promise<void>;
  restoreVersion: (versionId: string) => Promise<void>;
  saveDefault: <F extends PolicyFamily>(family: F, value: PolicyBundle[F]) => Promise<void>;
  saveStrategy: (strategy: FulfillmentStrategy) => Promise<void>;
  applyResolvedPreset: (
    slug: string,
    families: PolicyFamily[],
    bundle: PolicyBundle,
  ) => Promise<void>;
  clearActivePreset: () => Promise<void>;
  upsertOverride: (row: OverrideRow) => Promise<void>;
  bulkUpsertOverrides: (rows: OverrideRow[], opts?: { seeded?: boolean }) => Promise<void>;
  deleteOverride: (scope: "node" | "edge", targetKey: string, family: PolicyFamily) => Promise<void>;
  /** Save the live policies as a version. Deduplicated server-side by content
   *  (WP 10.2): when the content is already saved, its existing id comes back and
   *  nothing new is created. `quiet` suppresses the toast for saves nobody asked
   *  for (a run binding to the version in force). */
  saveSnapshot: (label?: string, notes?: string, opts?: { quiet?: boolean }) => Promise<string | null>;
  /** 6.D — edit a version's free-text notes (distinct from its label). */
  updateVersionNotes: (versionId: string, notes: string) => Promise<void>;
  /** 6.D — delete a version; refused server-side if bound to a run/model card. */
  deleteVersion: (versionId: string) => Promise<boolean>;
  /** Delete several versions at once; returns the ids actually deleted. Each
   *  goes through the same per-version RPC, so the server still refuses any
   *  version bound to a run or model card. */
  deleteVersions: (versionIds: string[]) => Promise<string[]>;
  /** 6.D + §4 D289 — download what the engine receives for a saved version, as .xlsx. */
  exportVersion: (version: PolicyVersion) => Promise<void>;
  /** D230 — "Edit Policies" on this project, as /profile lists it. Every write above
   *  refuses without it; the page shows `policyEditRefusal` instead of letting a cell
   *  look saved. */
  canEditPolicies: boolean;
  policyEditRefusal: string | null;
}

/**
 * True when a Supabase RPC error means PostgREST could not resolve a function
 * overload matching the sent arguments — i.e. the frontend is calling a newer
 * signature than the deployed schema (a migration hasn't been applied). Lets
 * callers retry an older signature instead of hard-failing on deploy ordering.
 */
export function isMissingRpcSignature(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("no function matches") ||
    (msg.includes("function") && msg.includes("does not exist"))
  );
}

/**
 * Load + mutate policy defaults and overrides for a project.
 * After every successful mutation, dispatches a `policy.changed` command into
 * the existing sim-command pipeline so KPIs update live.
 */
export function usePolicies(projectId: string | null | undefined): UsePoliciesResult {
  const { user } = useAuth();
  const [defaults, setDefaults] = useState<PolicyBundle>(DEFAULT_BUNDLE);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fulfillmentStrategy, setFulfillmentStrategy] = useState<FulfillmentStrategy>("make_to_stock");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [presetAppliedAt, setPresetAppliedAt] = useState<Date | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  // The version the live policies were last saved as or loaded from, on THIS page —
  // used only as the lineage parent of the next save. It is NOT the version in force:
  // that is derived from content below (§4 D242).
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  // D230 — one gate for every write below: the project role decides, not the account.
  const rights = useProjectRights(projectId);
  const canEditPolicies = rights.can("data_edit_policies");
  const policyEditRefusal = rights.loading
    ? "Checking your rights on this project…"
    : rights.refusal("data_edit_policies");
  // A version records the policy set a run is bound to, so running also allows it.
  const canSnapshot = canEditPolicies || rights.can("simulation_lab");
  const canExport = rights.can("export");
  /** Toast the reason and report the refusal; `quiet` for writes nobody asked for. */
  const refused = useCallback((allowed: boolean, reason: string | null, quiet = false) => {
    if (allowed) return false;
    if (!quiet) toast.error(reason ?? "You may not change policies on this project.");
    return true;
  }, []);

  const refreshCurrentHash = useCallback(async () => {
    if (!projectId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { data, error } = await sb.rpc("current_policy_hash", { p_project_id: projectId });
    if (error) {
      console.error("current_policy_hash failed", error);
      return;
    }
    setCurrentHash((data as string | null) ?? null);
  }, [projectId]);

  const dispatchSim = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!projectId) return;
      try {
        await supabase.functions.invoke("sim-command", {
          body: {
            project_id: projectId,
            kind: "policy.changed",
            payload,
            client_ts: Date.now(),
          },
        });
      } catch (err) {
        console.error("policy sim-command failed", err);
      }
    },
    [projectId],
  );

  // initial load
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const [defRes, ovRes] = await Promise.all([
        sb.from("policy_defaults").select("*").eq("project_id", projectId).maybeSingle(),
        sb.from("policy_overrides").select("*").eq("project_id", projectId),
      ]);
      if (cancelled) return;
      if (defRes.data) {
        setDefaults({
          sourcing: parseFamily("sourcing", defRes.data.sourcing),
          inventory: parseFamily("inventory", defRes.data.inventory),
          transport: parseFamily("transport", defRes.data.transport),
          fulfillment: parseFamily("fulfillment", defRes.data.fulfillment),
          production: parseFamily("production", defRes.data.production),
          recovery: parseFamily("recovery", defRes.data.recovery),
          demand: parseFamily("demand", defRes.data.demand),
        });
        if (defRes.data.fulfillment_strategy) {
          setFulfillmentStrategy(defRes.data.fulfillment_strategy as FulfillmentStrategy);
        }
        setActivePreset((defRes.data.active_preset as string | null) ?? null);
        setPresetAppliedAt(
          defRes.data.preset_applied_at ? new Date(defRes.data.preset_applied_at) : null,
        );
      } else {
        setDefaults(DEFAULT_BUNDLE);
      }
      setOverrides((ovRes.data ?? []) as OverrideRow[]);
      setLoading(false);
      void refreshCurrentHash();
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshCurrentHash]);

  // realtime
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`policies:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "policy_defaults", filter: `project_id=eq.${projectId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          if (!row) return;
          setDefaults({
            sourcing: parseFamily("sourcing", row.sourcing),
            inventory: parseFamily("inventory", row.inventory),
            transport: parseFamily("transport", row.transport),
            fulfillment: parseFamily("fulfillment", row.fulfillment),
            production: parseFamily("production", row.production),
            recovery: parseFamily("recovery", row.recovery),
            demand: parseFamily("demand", row.demand),
          });
          void refreshCurrentHash();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "policy_overrides", filter: `project_id=eq.${projectId}` },
        (payload) => {
          setOverrides((prev) => {
            const next = [...prev];
            const row = payload.new as OverrideRow | undefined;
            const old = payload.old as { id?: string } | undefined;
            const idx = next.findIndex(
              (r) => row && r.scope === row.scope && r.target_key === row.target_key && r.family === row.family,
            );
            if (payload.eventType === "DELETE" && old) {
              return next.filter(
                (r) =>
                  !(
                    "id" in r &&
                    (r as unknown as { id: string }).id === old.id
                  ),
              );
            }
            if (!row) return next;
            if (idx >= 0) next[idx] = row;
            else next.push(row);
            return next;
          });
          void refreshCurrentHash();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, refreshCurrentHash]);

  const saveDefault = useCallback(
    async <F extends PolicyFamily>(family: F, value: PolicyBundle[F]) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) throw new ProjectRightRefused(policyEditRefusal ?? "refused");
      // optimistic
      setDefaults((prev) => ({ ...prev, [family]: value }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("save_policy_defaults", {
        p_project_id: projectId,
        p_family: family,
        p_value: value,
        // D71 · the actor, so `audit_tier_write` names a person instead of
        // recording `actor_known: false`. `_actor_user_id` is DEFAULT NULL on
        // every one of these RPCs, so omitting it is exactly the old behaviour.
        _actor_user_id: user?.id ?? null,
      });
      if (error) {
        console.error("saveDefault failed", error);
        toast.error(`Save failed: ${error.message ?? error}`);
        throw error;
      }
      await dispatchSim({ family, scope: "default", patch: value });
      void refreshCurrentHash();
    },
    [projectId, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const upsertOverride = useCallback(
    async (row: OverrideRow) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) throw new ProjectRightRefused(policyEditRefusal ?? "refused");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("bulk_upsert_policy_overrides", {
        p_project_id: projectId,
        // WP 4.4 · no `seeded` flag. This path is a person editing a cell, so
        // the override is a DECISION and carries no `seeded_from_hash` — it does
        // not go stale when the dataset moves. The seeding path sets the flag.
        p_rows: JSON.stringify([{ scope: row.scope, target_key: row.target_key, family: row.family, patch: row.patch }]),
        _actor_user_id: user?.id ?? null,   // D71
      });
      if (error) {
        console.error("upsertOverride failed", error);
        toast.error(`Save failed: ${error.message ?? error}`);
        throw error;
      }
      await dispatchSim({
        family: row.family,
        scope: row.scope,
        target_key: row.target_key,
        patch: row.patch,
      });
      void refreshCurrentHash();
    },
    [projectId, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const bulkUpsertOverrides = useCallback(
    async (rows: OverrideRow[], opts?: { seeded?: boolean }) => {
      if (!projectId || rows.length === 0) return;
      // Seeding copies project data nobody typed: refused quietly, so a Viewer opening the
      // page is not shown an error for a write it never asked for.
      if (refused(canEditPolicies, policyEditRefusal, !!opts?.seeded)) {
        if (opts?.seeded) return;
        throw new ProjectRightRefused(policyEditRefusal ?? "refused");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      // WP 4.4 · `seeded` says these values were COPIED from project data rather
      // than decided by a person. The RPC stamps `seeded_from_hash` from the
      // project's own `current_graph_hash` — the client never sends a hash,
      // because a caller that supplies provenance can supply the wrong
      // provenance. A seeded override goes stale when the dataset moves; a typed
      // one does not, and THE ENGINE READS OVERRIDES, so the difference decides
      // what a simulation computes.
      const payload = rows.map((r) => ({
        scope: r.scope,
        target_key: r.target_key,
        family: r.family,
        patch: r.patch,
        seeded: opts?.seeded === true,
      }));
      const { error } = await sb.rpc("bulk_upsert_policy_overrides", {
        p_project_id: projectId,
        p_rows: payload,
        _actor_user_id: user?.id ?? null,   // D71
      });
      if (error) {
        console.error("bulkUpsertOverrides failed", error);
        toast.error(`Save failed: ${error.message ?? error}`);
        throw error;
      }
      // one sim command per family
      const byFamily = new Map<PolicyFamily, OverrideRow[]>();
      for (const r of rows) {
        const list = byFamily.get(r.family) ?? [];
        list.push(r);
        byFamily.set(r.family, list);
      }
      await Promise.all(
        Array.from(byFamily.entries()).map(([family, list]) =>
          dispatchSim({
            family,
            scope: "bulk",
            target_keys: list.map((r) => r.target_key),
            patch: list[0]?.patch,
          }),
        ),
      );
      void refreshCurrentHash();
    },
    [projectId, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const deleteOverride = useCallback(
    async (scope: "node" | "edge", targetKey: string, family: PolicyFamily) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("delete_policy_override", {
        p_project_id: projectId,
        p_scope: scope,
        p_target_key: targetKey,
        p_family: family,
        _actor_user_id: user?.id ?? null,   // D71
      });
      if (error) {
        console.error("deleteOverride failed", error);
        return;
      }
      await dispatchSim({ family, scope, target_key: targetKey, patch: {} });
      void refreshCurrentHash();
    },
    [projectId, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const saveStrategy = useCallback(
    async (strategy: FulfillmentStrategy) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) return;
      setFulfillmentStrategy(strategy);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("save_policy_defaults", {
        p_project_id: projectId,
        p_family: "fulfillment",
        p_value: defaults.fulfillment,
        p_strategy: strategy,
        _actor_user_id: user?.id ?? null,   // D71
      });
      if (error) {
        console.error("saveStrategy failed", error);
        return;
      }
      await dispatchSim({ family: "fulfillment", scope: "strategy", patch: { strategy } });
      void refreshCurrentHash();
    },
    [projectId, defaults.fulfillment, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const applyResolvedPreset = useCallback(
    async (slug: string, families: PolicyFamily[], bundle: PolicyBundle) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) return;
      const appliedAt = new Date();
      setDefaults((prev) => {
        const next = { ...prev };
        for (const f of families) {
          (next as Record<string, unknown>)[f] = bundle[f];
        }
        return next;
      });
      setActivePreset(slug);
      setPresetAppliedAt(appliedAt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const familyResults = await Promise.all(
        families.map((f) =>
          sb.rpc("save_policy_defaults", {
            p_project_id: projectId,
            p_family: f,
            p_value: bundle[f],
            _actor_user_id: user?.id ?? null,   // D71
          }),
        ),
      );
      const familyError = familyResults.find((r: { error: unknown }) => r.error)?.error;
      if (familyError) {
        console.error("applyResolvedPreset failed", familyError);
        return;
      }
      const { error } = await sb.rpc("save_policy_defaults", {
        p_project_id: projectId,
        p_family: families[0],
        p_value: bundle[families[0]],
        p_active_preset: slug,
        p_preset_applied_at: appliedAt.toISOString(),
        _actor_user_id: user?.id ?? null,   // D71
      });
      if (error) {
        console.error("applyResolvedPreset (preset) failed", error);
        return;
      }
      await Promise.all(
        families.map((family) =>
          dispatchSim({ family, scope: "preset", preset: slug, patch: bundle[family] }),
        ),
      );
      void refreshCurrentHash();
    },
    [projectId, dispatchSim, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const clearActivePreset = useCallback(async () => {
    if (!projectId) return;
    if (refused(canEditPolicies, policyEditRefusal)) return;
    setActivePreset(null);
    setPresetAppliedAt(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    const { error } = await sb.rpc("clear_policy_preset", { p_project_id: projectId, _actor_user_id: user?.id ?? null });   // D71
    if (error) console.error("clearActivePreset failed", error);
  }, [projectId, user?.id, canEditPolicies, policyEditRefusal, refused]);

  const refreshVersions = useCallback(async () => {
    if (!projectId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    // Prefer the RPC (works around RLS quirks); fall back to a direct select.
    const { data: rpcData, error: rpcErr } = await sb.rpc("list_policy_versions", {
      p_project_id: projectId,
    });
    if (!rpcErr && rpcData) {
      setVersions(rpcData as PolicyVersion[]);
      return;
    }
    const { data, error } = await sb
      .from("policy_versions")
      .select("id,label,notes,author_email,author_name,parent_version_id,policy_hash,created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("refreshVersions failed", error);
      return;
    }
    setVersions((data ?? []) as PolicyVersion[]);
  }, [projectId]);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions]);

  const saveSnapshot = useCallback(
    async (label?: string, notes?: string, opts?: { quiet?: boolean }): Promise<string | null> => {
      if (!projectId) return null;
      if (refused(canSnapshot, policyEditRefusal)) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const baseArgs = {
        p_project_id: projectId,
        p_label: label ?? null,
        p_user_id: user?.id ?? null,
        p_user_email: user?.email ?? null,
        p_user_name: user?.display_name ?? user?.name ?? null,
        p_parent_version_id: baseVersionId,
      };
      // p_notes (6.D) ships in migration 20260711000001. If that migration is
      // not deployed yet, PostgREST can't resolve the 7-arg overload — fall back
      // to the original 6-arg call so saving a snapshot (and therefore server
      // runs / model adoption, which snapshot first) keeps working. Notes are
      // dropped until the migration lands.
      let { data, error } = await sb.rpc("snapshot_policy", { ...baseArgs, p_notes: notes ?? null });
      if (error && isMissingRpcSignature(error)) {
        ({ data, error } = await sb.rpc("snapshot_policy", baseArgs));
      }
      if (error) {
        console.error("saveSnapshot failed", error);
        toast.error(`Snapshot failed: ${error.message ?? error}`);
        return null;
      }
      const newId = data as string;
      // §4 D241: the server returns the EXISTING version when this content is already
      // saved. Saying "saved" then would report a version that was not created.
      const existing = versions.find((v) => v.id === newId) ?? null;
      if (!opts?.quiet) {
        if (existing) {
          toast.message(
            policyRef(existing)
              ? `These policies are already saved as ${policyRef(existing)} — no new version.`
              : "These policies are already saved — no new version.",
          );
        } else {
          toast.success("Simulation model version saved");
        }
      }
      setBaseVersionId(newId);
      void refreshVersions();
      void refreshCurrentHash();
      return newId;
    },
    [projectId, user, baseVersionId, versions, refreshVersions, refreshCurrentHash, canSnapshot, policyEditRefusal, refused],
  );

  const restoreVersion = useCallback(
    async (versionId: string) => {
      if (!projectId) return;
      if (refused(canEditPolicies, policyEditRefusal)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("restore_policy_version", { p_version_id: versionId, _actor_user_id: user?.id ?? null });   // D71
      if (error) {
        console.error("restoreVersion failed", error);
        toast.error(`Load failed: ${error.message ?? error}`);
        return;
      }
      setBaseVersionId(versionId);
      toast.success("Model version loaded");
      // Trigger a reload of defaults via the existing realtime channel; also refetch immediately.
      const { data } = await sb
        .from("policy_defaults")
        .select("*")
        .eq("project_id", projectId)
        .maybeSingle();
      if (data) {
        setDefaults({
          sourcing: parseFamily("sourcing", data.sourcing),
          inventory: parseFamily("inventory", data.inventory),
          transport: parseFamily("transport", data.transport),
          fulfillment: parseFamily("fulfillment", data.fulfillment),
          production: parseFamily("production", data.production),
          recovery: parseFamily("recovery", data.recovery),
          demand: parseFamily("demand", data.demand),
        });
      }
      const { data: ovData } = await sb
        .from("policy_overrides")
        .select("*")
        .eq("project_id", projectId);
      setOverrides((ovData ?? []) as OverrideRow[]);
      void refreshCurrentHash();
    },
    [projectId, refreshCurrentHash, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  // 6.D — edit a version's free-text notes (a description of the model),
  // persisted on the version record and distinct from the short label.
  const updateVersionNotes = useCallback(
    async (versionId: string, notes: string) => {
      if (refused(canEditPolicies, policyEditRefusal)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("update_policy_version_notes", {
        p_version_id: versionId,
        p_notes: notes,
        _actor_user_id: user?.id ?? null,   // WP 6.4 · §4 D71
      });
      if (error) {
        console.error("updateVersionNotes failed", error);
        toast.error(`Could not save notes: ${error.message ?? error}`);
        return;
      }
      toast.success("Notes saved");
      void refreshVersions();
    },
    // `user?.id` and not `user`: without it the callback closes over whoever was
    // signed in at first render, so a session change would attribute this write to
    // the previous person (WP 6.2 slice 12's lesson, ten arrays over).
    [refreshVersions, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  // 6.D — delete a saved version. The RPC refuses (foreign_key_violation) when
  // the version is bound to a simulation run or a validated model card, so a
  // referenced version can never be silently destroyed. Returns whether the
  // delete happened.
  const deleteVersion = useCallback(
    async (versionId: string): Promise<boolean> => {
      if (refused(canEditPolicies, policyEditRefusal)) return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { error } = await sb.rpc("delete_policy_version", {
        p_version_id: versionId,
        _actor_user_id: user?.id ?? null,   // WP 6.4 · §4 D71
      });
      if (error) {
        console.error("deleteVersion failed", error);
        toast.error(error.message ?? "Could not delete this version");
        return false;
      }
      if (baseVersionId === versionId) setBaseVersionId(null);
      toast.success("Version deleted");
      void refreshVersions();
      return true;
    },
    [baseVersionId, refreshVersions, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  const deleteVersions = useCallback(
    async (versionIds: string[]): Promise<string[]> => {
      if (refused(canEditPolicies, policyEditRefusal)) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const deleted: string[] = [];
      const failures: string[] = [];
      // Sequential, one RPC per version: each call is its own audited
      // transaction, and one refusal must not roll back the others.
      for (const versionId of versionIds) {
        const { error } = await sb.rpc("delete_policy_version", {
          p_version_id: versionId,
          _actor_user_id: user?.id ?? null,   // WP 6.4 · §4 D71
        });
        if (error) {
          console.error("deleteVersions failed", versionId, error);
          failures.push(error.message ?? versionId);
        } else {
          deleted.push(versionId);
        }
      }
      if (baseVersionId && deleted.includes(baseVersionId)) setBaseVersionId(null);
      if (deleted.length > 0) {
        toast.success(`${deleted.length} version${deleted.length === 1 ? "" : "s"} deleted`);
      }
      if (failures.length > 0) {
        toast.error(
          `${failures.length} version${failures.length === 1 ? "" : "s"} could not be deleted: ${failures[0]}`,
        );
      }
      void refreshVersions();
      return deleted;
    },
    [baseVersionId, refreshVersions, user?.id, canEditPolicies, policyEditRefusal, refused],
  );

  // 6.D + W2/G17 + §4 D289 — download WHAT THE ENGINE RECEIVES for this version:
  // the mapped scsim input, computed in the browser engine by the same mapping a
  // run performs, from this policy version and the dataset version a run of it
  // read (`engineInputExport.ts`). Before D289 this wrote the stored bundle with
  // the page's defaults filled in — neither the dataset nor the mapping, so its
  // numbers could differ from the run's, and nothing tied its content to its hash.
  const exportVersion = useCallback(async (version: PolicyVersion) => {
    if (refused(canExport, rights.refusal("export"))) return;
    if (!projectId) return;
    const name = version.label || `version-${version.id.slice(0, 8)}`;
    const toastId = toast.loading("Preparing the simulation input — reading the two frozen versions…");
    try {
      // Loaded on demand: the workbook library and the browser engine's mapping are
      // large and only an export click needs them.
      const [{ buildPolicyVersionEngineInput }, { downloadWorkbook }] = await Promise.all([
        import("@/lib/policies/engineInputExport"),
        import("@/lib/policies/excel"),
      ]);
      const wb = await buildPolicyVersionEngineInput(projectId, version, (p) => {
        toast.loading(
          p === "reading"
            ? "Preparing the simulation input — reading the two frozen versions…"
            : p === "ready"
              ? "Mapping the inputs exactly as a run does…"
              : "Loading the simulation engine in your browser (the first time takes ~20 s)…",
          { id: toastId },
        );
      }, user ? { id: user.id, email: user.email } : null);
      const safe = name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48);
      downloadWorkbook(wb, `simulation-input-${safe}.xlsx`);
      toast.success("Exported: exactly what the engine receives for this version", { id: toastId });
    } catch (err) {
      console.error("exportVersion failed", err);
      toast.error(`Could not export this version: ${(err as Error)?.message ?? String(err)}`, { id: toastId });
    }
  }, [canExport, rights, refused, projectId, user]);

  // ONE answer for every page (§4 D242): the version whose content is live.
  const currentVersion = currentPolicyVersion(versions, currentHash);
  const selectedVersionId = currentVersion?.id ?? null;
  const isDirty = currentVersion === null;

  return {
    defaults,
    overrides,
    loading,
    fulfillmentStrategy,
    activePreset,
    presetAppliedAt,
    versions,
    currentHash,
    isDirty,
    selectedVersionId,
    currentVersion,
    refreshVersions,
    restoreVersion,
    saveDefault,
    saveStrategy,
    applyResolvedPreset,
    clearActivePreset,
    upsertOverride,
    bulkUpsertOverrides,
    deleteOverride,
    saveSnapshot,
    updateVersionNotes,
    deleteVersion,
    deleteVersions,
    exportVersion,
    canEditPolicies,
    policyEditRefusal,
  };
}

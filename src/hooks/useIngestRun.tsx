/**
 * ONE STAGED RUN, LOADED FOR REVIEW (Phase 3 / WP 3.4, PLAN.md §10).
 *
 * Reads `ingest_runs`, its `ingest_files` manifest and its `ingest_staged_rows`,
 * and exposes the two actions the review screen has: re-compare, and promote.
 * Both go through the `ingest-file` edge function rather than straight to the
 * RPC, because `ingest_diff_run` and `ingest_apply_run` are granted to
 * `service_role` alone — deliberately. A promotion that the browser could call
 * directly would be a promotion whose role gate lives in the same bundle as the
 * button that hides it.
 *
 * THE READ GOES THROUGH `ingest_run_review`, NOT THROUGH THE TABLES (WP 6.5a,
 * PLAN.md §4 D169). This hook used to select the three `ingest_*` tables directly,
 * on the reasoning that they grant SELECT to `authenticated` behind an RLS policy
 * routed through the run's project. That reasoning assumed a Supabase Auth session,
 * and this application has none: the browser calls as `anon`, RLS answered zero
 * rows WITHOUT an error, and the review screen rendered nothing for every upload
 * the first day `ingest-file` was live — so nothing could be promoted. The RPC takes
 * the reader as a parameter and authorizes them with `has_project_access`, exactly
 * as `ingest_value_chain` does, and it REFUSES rather than returning an empty run,
 * so a reader without access is told so instead of shown a blank.
 *
 * NOTHING HERE BRANCHES ON `source_kind` — §10's gap check for this package.
 * A connector run and a file run are loaded by the same three queries; a
 * connector run simply has no `ingest_staged_rows` and its own staging tables
 * are WP 3.1's, not this screen's.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { edgeErrorMessage } from "@/lib/ingest/edgeError";
import type { IngestFile, IngestRun, StagedRow } from "@/lib/ingest/runReview";

export interface IngestRunState {
  run: IngestRun | null;
  file: IngestFile | null;
  rows: StagedRow[];
  /** The DATABASE's answer to "may this user promote", returned by the diff. */
  actorRole: string | null;
  canPromote: boolean;
  loading: boolean;
  busy: "diff" | "promote" | null;
  error: string | null;
  reload: () => Promise<void>;
  recompute: () => Promise<void>;
  promote: () => Promise<Record<string, unknown> | null>;
}

export function useIngestRun(runId: string | null, userId: string | null): IngestRunState {
  const [run, setRun] = useState<IngestRun | null>(null);
  const [file, setFile] = useState<IngestFile | null>(null);
  const [rows, setRows] = useState<StagedRow[]>([]);
  const [actorRole, setActorRole] = useState<string | null>(null);
  const [canPromote, setCanPromote] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"diff" | "promote" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!runId) {
      setRun(null); setFile(null); setRows([]);
      return;
    }
    setLoading(true);
    // `ingest_run_review` is not in the generated Supabase types, which are produced
    // from the live schema by hand; the same reason `ValueChainPopover` gives.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any;
    try {
      if (!userId) throw new Error("Sign in to review this upload.");
      const { data, error: err } = await sb.rpc("ingest_run_review", {
        p_user_id: userId,
        p_run_id: runId,
      });
      if (err) throw new Error(err.message);
      const review = (data ?? {}) as { run?: IngestRun | null; file?: IngestFile | null; rows?: StagedRow[] };
      setRun(review.run ?? null);
      setFile(review.file ?? null);
      setRows(review.rows ?? []);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [runId, userId]);

  useEffect(() => { void reload(); }, [reload]);

  /** One call shape for both server actions — the function takes a FormData. */
  const call = useCallback(
    async (mode: "diff" | "apply") => {
      if (!runId || !userId) return null;
      const body = new FormData();
      body.append("mode", mode);
      body.append("run_id", runId);
      body.append("user_id", userId);
      const { data, error: err } = await supabase.functions.invoke("ingest-file", { body });
      if (err) throw new Error(data?.error || (await edgeErrorMessage(err, `The ${mode} failed.`)));
      if (!data?.success) throw new Error(data?.error || `The ${mode} failed.`);
      return data as Record<string, unknown>;
    },
    [runId, userId],
  );

  const recompute = useCallback(async () => {
    setBusy("diff");
    try {
      const d = await call("diff");
      if (d) {
        setActorRole((d.actor_role as string) ?? null);
        setCanPromote(Boolean(d.actor_may_promote));
      }
      await reload();
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [call, reload]);

  // The role is the database's answer and it arrives with the counts, so the
  // screen never has a second opinion about who may promote.
  useEffect(() => { if (runId && userId) void recompute(); }, [runId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const promote = useCallback(async () => {
    setBusy("promote");
    try {
      const applied = await call("apply");
      await reload();
      setError(null);
      return applied;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return null;
    } finally {
      setBusy(null);
    }
  }, [call, reload]);

  return { run, file, rows, actorRole, canPromote, loading, busy, error, reload, recompute, promote };
}

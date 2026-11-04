// Fetch + download for the verifiable exports (G17 / §8.4 / §9.5.1 — W2):
// the dataset workbook (canonical hashed rows) and the per-run results
// workbook. The policy-snapshot export lives in usePolicies.exportVersion;
// all three are wired into the model version-history UI.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useProjectRights } from "@/hooks/useProjectRights";
import { fetchProjectLanes, laneTruncationNotice } from "@/lib/policies/projectLanes";
import { safeName } from "@/lib/policies/excelNames";
import type {
  RowProvenance,
  DatasetVersionRow,
  RunScenarioMeta,
} from "@/lib/policies/verifiableExports";

// The workbook builders (and the `xlsx` library under them) load on the first export.
const loadWorkbookTools = () =>
  Promise.all([import("@/lib/policies/verifiableExports"), import("@/lib/policies/excel")]);
import type { Replication, SimulationRun } from "@/hooks/useSimulationRun";
import { assembleRunRecord, RUN_SCENARIO_COLUMNS, type RunScenarioRow } from "@/lib/trust/assembleRunRecord";
import { seriesNotice, withRunSeries } from "@/lib/sim/runSeries";
import { INGEST_DATASETS } from "../../supabase/functions/_shared/ingestSpec.generated";

/**
 * The tables `ingest_row_provenance` can be asked about — DERIVED from the contract,
 * never listed here.
 *
 * `INGEST_DATASETS` is generated from `supabase/contract/*.contract.yaml`, and its
 * targets are exactly the tables the promotion writes, which are exactly the tables
 * that carry `ingest_run_id` + `source_row_id`. A hand-written list would be a
 * second copy that silently omits the eleventh dataset the day it lands — the shape
 * `single-source` (I1) exists to refuse, and the reason `ingest_target_is_promotable`
 * is checked against on the SQL side rather than trusted from the caller.
 */
const PROVENANCE_TABLES: readonly string[] = [
  ...new Set(Object.values(INGEST_DATASETS).map((d) => d.target)),
].sort();

export interface ExportableRun {
  id: string;
  scenario_id: string;
  scenario_name: string | null;
  ended_at: string | null;
  code_version: string | null;
  rep_count_done: number | null;
  policy_version_id: string | null;
}

interface UseVerifiableExportsResult {
  /** Completed runs of the project, newest first (for the results export picker). */
  runs: ExportableRun[];
  refreshRuns: () => Promise<void>;
  /** Snapshot-or-reuse the dataset version, then download its canonical rows. */
  exportDataset: () => Promise<void>;
  /** Download one run's metadata + per-seed KPIs + weekly series. */
  exportRunResults: (runId: string) => Promise<void>;
  busy: "dataset" | "results" | null;
  /** D230 — "Export" on this project; both exports refuse without it. */
  canExport: boolean;
  exportRefusal: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;


export function useVerifiableExports(
  projectId: string | null | undefined,
  projectName?: string | null,
): UseVerifiableExportsResult {
  const { user } = useAuth();
  // D230 — "Export" on this project, as /profile lists it.
  const rights = useProjectRights(projectId);
  const canExport = rights.can("export");
  const exportRefusal = rights.loading ? "Checking your rights on this project…" : rights.refusal("export");
  const [runs, setRuns] = useState<ExportableRun[]>([]);
  const [busy, setBusy] = useState<"dataset" | "results" | null>(null);

  const refreshRuns = useCallback(async () => {
    if (!projectId) return;
    const { data, error } = await sb
      .from("simulation_runs")
      .select("id,scenario_id,ended_at,code_version,rep_count_done,policy_version_id")
      .eq("project_id", projectId)
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) {
      console.error("export run list failed", error);
      return;
    }
    const list = (data ?? []) as ExportableRun[];
    // Attach scenario names (small list; one read).
    const scenarioIds = Array.from(new Set(list.map((r) => r.scenario_id)));
    if (scenarioIds.length > 0) {
      const { data: scens } = await sb
        .from("scenarios")
        .select("id,name")
        .in("id", scenarioIds);
      const nameOf = new Map(
        ((scens ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
      );
      for (const r of list) r.scenario_name = nameOf.get(r.scenario_id) ?? null;
    }
    setRuns(list);
  }, [projectId]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const exportDataset = useCallback(async () => {
    if (!projectId) return;
    if (!canExport) {
      toast.error(exportRefusal ?? "Export isn't enabled for you on this project.");
      return;
    }
    setBusy("dataset");
    try {
      // Snapshot-or-reuse (the RPC dedupes an unchanged dataset), then read
      // the EXACT rows the graph_hash was computed over.
      const { data: dsId, error: dsErr } = await sb.rpc("snapshot_dataset", {
        p_project_id: projectId,
      });
      if (dsErr) throw dsErr;
      const { data: version, error: verErr } = await sb
        .from("dataset_versions")
        .select("id,label,graph_hash,hash_inputs,hash_network,created_at,snapshot")
        .eq("id", dsId as string)
        .maybeSingle();
      if (verErr || !version) throw verErr ?? new Error("dataset version not readable");

      // WP 4.1 — THE LIVE READ IS ONLY FOR v1 VERSIONS NOW, and that is the
      // point of the change rather than an optimization.
      //
      // `bom_multi_level` is INSIDE the snapshot from v2 on, so the workbook
      // takes it from the frozen rows like every other sheet. Reading it live
      // would put rows in a hashed export that the hash does not describe — the
      // exact defect the v1 path had to carry a `_meta` note about, because v1
      // could not do anything else. A freshly frozen version needs no note.
      const snapshotVersion = Number(
        (version as { snapshot?: { schema_version?: number } }).snapshot?.schema_version ?? 1,
      );
      let bomMulti: Record<string, unknown>[] | undefined;
      if (snapshotVersion < 2) {
        try {
          const lanes = await fetchProjectLanes(projectId, user, { fresh: true }); // an export reads what is stored now
          if (lanes.bomLevel === "multi") bomMulti = lanes.bom;
          // D20 / §5 T3 — an export states the limits of its own computation.
          // The rows still go into the workbook (dropping them silently would be
          // worse), but the person clicking Export is told, now, that the sheet
          // is a slice. A file leaves the building; a console warning does not.
          const note = laneTruncationNotice(lanes);
          if (note) toast.warning(note);
        } catch {
          /* optional sheet only */
        }
      }
      // §5.4's ACCEPTANCE TEST — WP 6.3. One read per landable table this project
      // could hold, so the workbook can answer "which file, which line, which
      // person" for every row it lists.
      //
      // `undefined` when NOTHING could be read and `[]` when the reads returned
      // nothing: the sheet distinguishes them, because a workbook with no
      // `_provenance` sheet asserts neither, and "no row can be traced" is the true
      // and useful answer for most projects today (§4 D88).
      let provenance: RowProvenance[] | undefined;
      if (user?.id) {
        const gathered: RowProvenance[] = [];
        let anyRead = false;
        for (const table of PROVENANCE_TABLES) {
          const { data, error } = await sb.rpc("ingest_row_provenance", {
            p_project_id: projectId,
            p_user_id: user.id,
            p_target_table: table,
          });
          // A table this project has no rows in returns []; a table the RPC refuses
          // is a real failure and must not look the same. Either way one failed
          // table does not discard the others.
          if (error) continue;
          anyRead = true;
          for (const r of (data ?? []) as Array<Omit<RowProvenance, "table">>) {
            gathered.push({ ...r, table });
          }
        }
        if (anyRead) provenance = gathered;
      }

      const [{ buildDatasetWorkbook }, { downloadWorkbook }] = await loadWorkbookTools();
      const wb = buildDatasetWorkbook(
        version as DatasetVersionRow,
        projectName ?? null,
        bomMulti,
        provenance,
      );
      const hash8 = String((version as DatasetVersionRow).graph_hash).slice(0, 8);
      downloadWorkbook(wb, `dataset-${safeName(projectName ?? projectId)}-${hash8}.xlsx`);
      toast.success(`Dataset exported (graph_hash ${hash8}…)`);
    } catch (err) {
      console.error("exportDataset failed", err);
      toast.error(`Dataset export failed: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, projectName, user, canExport, exportRefusal]);

  const exportRunResults = useCallback(
    async (runId: string) => {
      if (!projectId) return;
      if (!canExport) {
        toast.error(exportRefusal ?? "Export isn't enabled for you on this project.");
        return;
      }
      setBusy("results");
      try {
        const { data: run, error: runErr } = await sb
          .from("simulation_runs")
          .select("*")
          .eq("id", runId)
          .maybeSingle();
        if (runErr || !run) throw runErr ?? new Error("run not readable");
        const { data: scenario } = await sb
          .from("scenarios")
          .select(RUN_SCENARIO_COLUMNS)
          .eq("id", (run as SimulationRun).scenario_id)
          .maybeSingle();
        const { data: reps, error: repErr } = await sb
          .from("run_replications")
          .select("*")
          .eq("run_id", runId)
          .order("rep_index", { ascending: true });
        if (repErr) throw repErr;
        let versionLabel: string | null = null;
        if ((run as SimulationRun).policy_version_id) {
          const { data: ver } = await sb
            .from("policy_versions")
            .select("label")
            .eq("id", (run as SimulationRun).policy_version_id)
            .maybeSingle();
          versionLabel = (ver?.label as string | null) ?? null;
        }
        // ── A5 · THE REPRODUCIBILITY RECORD (§5.4, I8) — one author, shared
        // with the inventory explorer's workbook (`assembleRunRecord`).
        const record = await assembleRunRecord({
          run: run as SimulationRun,
          scenario: (scenario ?? null) as RunScenarioRow | null,
          projectId,
          projectName,
          userId: user?.id ?? null,
        });

        // WP 10.6 — a worker run's series live in its Parquet object; the
        // workbook's series sheets read them through the one loader, and an
        // expired run's export says so in its limits rather than shipping
        // empty sheets as if nothing had been measured.
        const { reps: withSeries, series } = await withRunSeries(
          run as SimulationRun & { project_id: string },
          (reps ?? []) as Replication[],
        );
        const notice = seriesNotice(series);
        if (notice) record.limits = [...record.limits, { ref: "T3", limit: notice, consequence:
          "The workbook carries the run's KPIs and aggregates; its weekly series sheets are absent." }];
        const [{ buildRunResultsWorkbook }, { downloadWorkbook }] = await loadWorkbookTools();
        const wb = buildRunResultsWorkbook(
          run as SimulationRun,
          (scenario ?? null) as RunScenarioMeta | null,
          withSeries,
          versionLabel,
          record,
        );
        downloadWorkbook(wb, `run-results-${runId.slice(0, 8)}.xlsx`);
        toast.success("Run results exported");
      } catch (err) {
        console.error("exportRunResults failed", err);
        toast.error(`Results export failed: ${(err as Error).message ?? err}`);
      } finally {
        setBusy(null);
      }
    },
    [projectId, canExport, exportRefusal, user?.id],
  );

  return { runs, refreshRuns, exportDataset, exportRunResults, busy, canExport, exportRefusal };
}

// Latest COMPLETED run per scenario, for the whole project.
//
// Two surfaces need it and neither can get it from useSimulationRun (which is
// scoped to the selected scenario): the stage rail's "N scenarios with
// results" readout, and the Compare pane's A/B picker.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { SimulationRun } from "./useSimulationRun";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

export function useScenarioRuns(projectId: string | null | undefined) {
  /** scenario_id → newest run with status "done". */
  const [runsByScenario, setRunsByScenario] = useState<Record<string, SimulationRun>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    const { data } = await sb
      .from("simulation_runs")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "done")
      .order("created_at", { ascending: false });
    const newest: Record<string, SimulationRun> = {};
    for (const run of (data ?? []) as SimulationRun[]) {
      // ordered newest-first, so the first row per scenario wins
      if (!newest[run.scenario_id]) newest[run.scenario_id] = run;
    }
    setRunsByScenario(newest);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setRunsByScenario({});
      return;
    }
    void refresh();
    // A running run writes its replication counter on every replication, and each
    // write arrives here. Only a run that is (or was) "done" can change this hook's
    // answer, so queued/running/cancelled/failed updates are ignored, and the rest
    // are coalesced — the same 400 ms window useSimulationRun uses.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ch = sb
      .channel(`project_runs:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "simulation_runs",
          filter: `project_id=eq.${projectId}`,
        },
        (payload: { eventType?: string; new?: { status?: string } }) => {
          // DELETE carries no new row: refetch. INSERT/UPDATE: only when it is "done".
          if (payload.eventType !== "DELETE" && payload.new?.status !== "done") return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refresh(), 400);
        },
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      sb.removeChannel(ch);
    };
  }, [projectId, refresh]);

  return { runsByScenario, loading, refresh };
}

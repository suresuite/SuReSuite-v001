// Single fetcher for the logistics/BOM lane rows the policies UI needs.
//
// WHY RPC-FIRST: the app authenticates via a custom RPC (no supabase.auth
// session — the client runs as `anon`), and the lane tables' original RLS
// policies gate on a session GUC that does not survive PostgREST connection
// pooling, so direct `.from()` reads silently return 0 rows until the
// `20260705000001_open_logistics_reads.sql` migration is applied.
// `get_project_datasets` is SECURITY DEFINER, takes the user explicitly, and
// is the exact path ProjectDataViewer uses — it provably returns the rows.
// Direct reads remain only as a fallback.
import { supabase } from "@/integrations/supabase/client";
// The ceiling and the sentence live in their own module: they are the half of
// D20's fix that has to be TESTABLE, and importing this file pulls in the
// Supabase browser client, which needs a DOM. Re-exported so callers still have
// one import for the lane read and the limit it was read under.
import { LANE_ROW_CEILING, laneTruncationNotice } from "@/lib/policies/laneTruncation";
import { shareRead } from "@/lib/sharedRead";

export { LANE_ROW_CEILING, laneTruncationNotice };

export interface ProjectLanes {
  /** inbound_logistics rows (all columns). */
  inbound: Record<string, unknown>[];
  /** outbound_logistics rows (all columns). */
  outbound: Record<string, unknown>[];
  /** projects.bom_level — 'single' or 'multi'/'multi_level'. */
  bomLevel: string;
  /** BOM rows: single- or multi-level shape depending on bomLevel. */
  bom: Record<string, unknown>[];
  /**
   * Lane tables whose read came back AT the ceiling and was therefore probably
   * cut short (D20). Empty on every complete read, and empty on the RPC path,
   * which applies no limit at all. Callers must SHOW it: a partial project
   * rendered as a whole one is the §5 T1 failure — a number with no source —
   * and a console warning is not a display (§5 T2).
   */
  truncated: string[];
}

const EMPTY: ProjectLanes = { inbound: [], outbound: [], bomLevel: "single", bom: [], truncated: [] };

async function fetchDirect(projectId: string): Promise<ProjectLanes> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const [inQ, outQ, bomSingleQ, bomMultiQ] = await Promise.all([
    sb.from("inbound_logistics").select("*").eq("project_id", projectId).limit(LANE_ROW_CEILING),
    sb.from("outbound_logistics").select("*").eq("project_id", projectId).limit(LANE_ROW_CEILING),
    sb.from("bom_single_level").select("*").eq("project_id", projectId).limit(LANE_ROW_CEILING),
    sb.from("bom_multi_level").select("*").eq("project_id", projectId).limit(LANE_ROW_CEILING),
  ]);
  if (inQ.error) console.warn("[projectLanes] inbound_logistics read failed", inQ.error);
  if (outQ.error) console.warn("[projectLanes] outbound_logistics read failed", outQ.error);
  const multi = bomMultiQ.data ?? [];
  const single = bomSingleQ.data ?? [];
  const bomTable = multi.length > 0 ? "bom_multi_level" : "bom_single_level";
  // A table that came back at exactly the ceiling was probably cut short. Which
  // BOM table is named depends on which one was used, because naming the one
  // the caller is not reading would be a true statement about the wrong table.
  const truncated = ([
    ["inbound_logistics", inQ],
    ["outbound_logistics", outQ],
    [bomTable, multi.length > 0 ? bomMultiQ : bomSingleQ],
  ] as Array<[string, { data?: unknown[] | null }]>)
    .filter(([, q]) => (q?.data?.length ?? 0) >= LANE_ROW_CEILING)
    .map(([name]) => name);
  return {
    inbound: inQ.data ?? [],
    outbound: outQ.data ?? [],
    bomLevel: multi.length > 0 ? "multi" : "single",
    bom: multi.length > 0 ? multi : single,
    truncated,
  };
}

/**
 * The project's lanes. Callers that ask while another call for the same project and
 * user is still running share its request (`sharedRead.ts`) — /policies asks from
 * six hooks at once. Pass `fresh` right after a write so the read starts afterwards.
 * Each caller gets its own arrays; the row objects are shared and read-only.
 */
export async function fetchProjectLanes(
  projectId: string | null | undefined,
  user: { id: string; email: string } | null | undefined,
  opts: { fresh?: boolean } = {},
): Promise<ProjectLanes> {
  if (!projectId) return EMPTY;
  const lanes = await shareRead(
    `lanes|${projectId}|${user?.id ?? ""}|${(user?.email ?? "").toLowerCase()}`,
    () => readProjectLanes(projectId, user),
    opts.fresh,
  );
  return {
    ...lanes,
    inbound: [...lanes.inbound],
    outbound: [...lanes.outbound],
    bom: [...lanes.bom],
    truncated: [...lanes.truncated],
  };
}

async function readProjectLanes(
  projectId: string,
  user: { id: string; email: string } | null | undefined,
): Promise<ProjectLanes> {
  if (user?.id && user?.email) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("get_project_datasets", {
        p_project_id: projectId,
        p_user_id: user.id,
        p_user_email: user.email,
      });
      if (error) throw error;
      const ds = (data ?? {}) as Record<string, unknown>;
      return {
        inbound: (ds.inbound as Record<string, unknown>[]) ?? [],
        outbound: (ds.outbound as Record<string, unknown>[]) ?? [],
        bomLevel: String(ds.bom_level ?? "single"),
        bom: (ds.bom as Record<string, unknown>[]) ?? [],
        // The RPC aggregates each lane with no LIMIT, so this path cannot
        // truncate. Stated rather than left implied: if `get_project_datasets`
        // ever grows a bound, this is the line that has to change with it.
        truncated: [],
      };
    } catch (err) {
      console.warn("[projectLanes] get_project_datasets failed — falling back to direct reads", err);
    }
  }
  return fetchDirect(projectId);
}

/**
 * The project's demand-forecast buckets (PLAN.md §24 WP 14.2), one row per
 * uploaded week or month, each carrying its `weekly_quantity` (spread at
 * promotion) and its exclusive `period_end`. Through the SECURITY DEFINER RPC
 * that names its caller — `demand_forecasts` has no `anon` policy (§4 D28).
 * An error is RETURNED, never swallowed into an empty list: a failed read and a
 * project with no forecast must not look alike (§4 D178).
 */
export async function fetchProjectForecasts(
  projectId: string | null | undefined,
  user: { id: string; email: string } | null | undefined,
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  if (!projectId || !user?.id || !user?.email) return { rows: [], error: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("get_project_demand_forecasts", {
    p_project_id: projectId,
    p_user_id: user.id,
    p_user_email: user.email,
  });
  if (error) return { rows: [], error: String((error as { message?: string }).message ?? error) };
  return { rows: (data ?? []) as Record<string, unknown>[], error: null };
}

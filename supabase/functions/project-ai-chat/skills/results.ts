// M3 Results brief and compare (ai-agents.md §26.3). "What did the last run
// show?", "results of run 3166d661", "compare run A and B".
//
// Every number is a persisted run value (T1). A comparison is PAIRED only
// when the two runs share the seed, the replication count and the policy
// version — the CRN conditions — and otherwise says it is descriptive and
// why (§9.3's rule, the comparability.ts posture: still compared, labelled).

import { callTool, dbOf, fmt, loadRecentRuns, loadRepKpis, loadRun, orderKpis, pairedDelta, runCi, scalarKpis, signed, type RunRow, type Skill, type SkillInput, type SkillResult } from "./common.ts";

const RESULTS_WORDS =
  /\b(what\s+did\s+(?:the|my|our)\s+(?:last|latest|recent|previous)?\s*(?:run|simulation)s?\s+(?:show|say|find)|(?:results?|kpis?|outcome)\s+of\s+(?:the\s+|my\s+)?(?:last\s+|latest\s+)?(?:run|simulation)|summari[sz]e\s+(?:the\s+|my\s+)?(?:last\s+|latest\s+)?(?:run|simulation)|compare\s+(?:the\s+)?(?:last\s+two\s+)?runs?|(?:last|latest)\s+run(?:'s)?\s+results?)\b/i;
const RUN_REF = /\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;

interface ResultsMatch {
  compare: boolean;
  refs: string[];
}

async function scenarioName(db: ReturnType<typeof dbOf>, id: string | null): Promise<string> {
  if (!id) return "(no scenario)";
  try {
    const { data } = await db.from("scenarios").select("name").eq("id", id).maybeSingle();
    return String((data as Record<string, unknown> | null)?.name ?? id.slice(0, 8));
  } catch {
    return id.slice(0, 8);
  }
}

export const resultsSkill: Skill = {
  id: "results",
  drafts: false,
  describe: "briefs a finished run's KPIs with their intervals, or compares two runs (paired when they share random numbers)",
  example: "what did the last run show?  ·  compare runs 3166d661 and f09136d8",
  recognize(input: SkillInput): ResultsMatch | null {
    const refs = [...input.utterance.matchAll(RUN_REF)].map((m) => m[0].toLowerCase());
    const compare = /\bcompare\b/i.test(input.utterance) && (refs.length >= 2 || /\bruns\b/i.test(input.utterance));
    if (!RESULTS_WORDS.test(input.utterance) && !(compare && refs.length >= 2)) return null;
    return { compare, refs };
  },
  async run(ctx, match): Promise<SkillResult> {
    const m = match as ResultsMatch;
    const db = dbOf(ctx);
    const calls: SkillResult["calls"] = [];
    const recent = (await loadRecentRuns(db, ctx.projectId, 30)).filter((r) => r.status === "done");
    const byRef = async (ref: string): Promise<RunRow | null> =>
      ref.length > 8 ? await loadRun(db, ctx.projectId, ref) : recent.find((r) => r.id.startsWith(ref)) ?? null;

    const picked: RunRow[] = [];
    for (const ref of m.refs) {
      const r = await byRef(ref);
      if (r && !picked.some((p) => p.id === r.id)) picked.push(r);
    }
    const want = m.compare ? 2 : 1;
    for (const r of recent) {
      if (picked.length >= want) break;
      if (!picked.some((p) => p.id === r.id)) picked.push(r);
    }
    if (picked.length === 0) {
      return { reply: "There are no finished runs on this project yet. Run a scenario in the Simulation Lab (or ask me a what-if) first.", parts: [], calls, outcome: "no_runs" };
    }
    // Record the read (citations + telemetry) through the registered handler.
    for (const r of picked) await callTool(calls, ctx, "get_run_results", { run_id: r.id });

    if (!m.compare || picked.length < 2) {
      const r = picked[0];
      const kpis = scalarKpis(r);
      const keys = orderKpis(kpis.keys());
      const name = await scenarioName(db, r.scenario_id);
      const rows = keys.map((k) => [k, fmt(kpis.get(k)), runCi(r, k) === null ? "—" : `± ${fmt(runCi(r, k))}`]);
      const head = keys[0];
      return {
        reply: `Run ${r.id.slice(0, 8)} (scenario "${name}", ${r.rep_count_done} replications${r.code_version ? `, engine version ${r.code_version}` : ""}): ` +
          (head ? `${head} ${fmt(kpis.get(head))}${runCi(r, head) !== null ? ` ± ${fmt(runCi(r, head))}` : ""}.` : "no KPIs were recorded."),
        parts: rows.length ? [{ kind: "table", data: { columns: ["KPI", "Mean", "95% CI"], rows } }] : [],
        calls,
        outcome: "brief",
        interpretation: head
          ? `[internal handoff — this is not a user message]\nRun ${r.id} results:\n${rows.map((x) => x.join(" ")).join("\n")}\n` +
            `Write 1-2 sentences on what these results say for the user. Use ONLY these numbers; name the run id once.`
          : null,
      };
    }

    const [a, b] = picked;
    const paired = a.seed !== null && a.seed === b.seed && a.rep_count_done === b.rep_count_done &&
      a.policy_version_id === b.policy_version_id;
    const why = paired ? "" : [
      a.seed === null || b.seed === null ? "a run does not record its seed" : a.seed !== b.seed ? "different seeds" : "",
      a.rep_count_done !== b.rep_count_done ? "different replication counts" : "",
      a.policy_version_id !== b.policy_version_id ? "different policy versions" : "",
    ].filter(Boolean).join(", ");
    const ka = scalarKpis(a);
    const kb = scalarKpis(b);
    const keys = orderKpis([...ka.keys()].filter((k) => kb.has(k)));
    const ra = paired ? await loadRepKpis(db, a.id) : new Map();
    const rb = paired ? await loadRepKpis(db, b.id) : new Map();
    const rows = keys.map((k) => {
      const d = paired && ra.get(k) && rb.get(k) ? pairedDelta(rb.get(k)!, ra.get(k)!) : null;
      return [k, fmt(ka.get(k)), fmt(kb.get(k)), d ? `${signed(d.mean)} ± ${fmt(d.ci)}` : signed((kb.get(k) ?? 0) - (ka.get(k) ?? 0))];
    });
    const [na, nb] = [await scenarioName(db, a.scenario_id), await scenarioName(db, b.scenario_id)];
    return {
      reply: `Comparing run ${a.id.slice(0, 8)} ("${na}") with run ${b.id.slice(0, 8)} ("${nb}"): ` +
        (paired
          ? "they share the seed, replication count and policy version, so the differences below are paired with 95% intervals."
          : `the difference is DESCRIPTIVE, not paired — ${why}. Re-run one on the other's settings for a like-for-like comparison.`),
      parts: rows.length
        ? [{ kind: "table", data: { columns: ["KPI", `Run ${a.id.slice(0, 8)}`, `Run ${b.id.slice(0, 8)}`, paired ? "Δ (paired, 95% CI)" : "Δ (descriptive)"], rows } }]
        : [],
      calls,
      outcome: paired ? "compared_paired" : "compared_descriptive",
    };
  },
};

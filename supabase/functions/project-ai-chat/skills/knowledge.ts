// Search over the platform's own knowledge (ai-agents.md §26 WP M.4): the
// generated artifact `knowledge.generated.json` — every live /docs section,
// the engine's KPI definitions and prose reference, and the policy catalog,
// rendered from their sources by platformKnowledge.test.tsx. BM25 over title
// + text, pure and deterministic, no network: the answer a technical question
// gets is a cited passage the platform wrote, not the model's recollection.

import data from "../knowledge.generated.json" with { type: "json" };

export interface KnowledgeEntry {
  id: string;
  source: "docs" | "engine" | "policy";
  title: string;
  ref: string;
  text: string;
}

const ENTRIES: KnowledgeEntry[] = ((data as unknown as { entries?: KnowledgeEntry[] }).entries ?? []);

const STOP = new Set(
  ("a an and are as at be by can do does for from how i if in is it its me my of on or our should so " +
    "that the their them then there these this to was we what when where which who why will with you your " +
    "about into than also any each just only not no yes use used using get set").split(" "),
);

export function tokens(s: string): string[] {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9.\-_ ]+/g, " ").split(/\s+/)
    .map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

interface Doc { entry: KnowledgeEntry; tf: Map<string, number>; len: number }

let INDEX: { docs: Doc[]; df: Map<string, number>; avg: number } | null = null;

function index() {
  if (INDEX) return INDEX;
  const docs: Doc[] = ENTRIES.map((entry) => {
    // Title terms count three times: a section about "warm-up" outranks one
    // that mentions it in passing.
    const toks = [...tokens(entry.title), ...tokens(entry.title), ...tokens(entry.title), ...tokens(entry.text)];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { entry, tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  INDEX = { docs, df, avg };
  return INDEX;
}

export interface Hit { entry: KnowledgeEntry; score: number; matched: number; asked: number }

export function searchKnowledge(query: string, k = 3): Hit[] {
  const { docs, df, avg } = index();
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return [];
  const N = docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: Hit[] = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
    }
    if (score > 0) hits.push({ entry: d.entry, score, matched, asked: q.length });
  }
  return hits.sort((a, b2) => b2.score - a.score).slice(0, k);
}

export function knowledgeSize(): number {
  return ENTRIES.length;
}

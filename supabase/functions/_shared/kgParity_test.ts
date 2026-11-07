// The knowledge graph's verification threshold is authored once — networkEvidence.ts's
// VERIFY_MIN_SOURCES — and restated in SQL only because SQL cannot import it
// (kg_verify_min_sources, migration 20261107000002). This holds the two equal: the
// ingestSpecParity pattern (docs/PLAN.md §29, WP 19.2; gate `single-source`).
import { assertEquals } from "../project-ai-chat/eval/harness/asserts.ts";
import { VERIFY_MIN_SOURCES } from "./networkEvidence.ts";

Deno.test("kg_verify_min_sources() restates VERIFY_MIN_SOURCES", () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const defs = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort()
    .map((n) => Deno.readTextFileSync(new URL(n, dir)))
    .flatMap((sql) => [...sql.matchAll(/FUNCTION public\.kg_verify_min_sources\(\)[\s\S]*?SELECT\s+(\d+)\s*\$\$/g)]);
  const last = defs.at(-1);
  assertEquals(last ? Number(last[1]) : null, VERIFY_MIN_SOURCES,
    "the SQL threshold differs from networkEvidence.ts — change both in one commit");
});

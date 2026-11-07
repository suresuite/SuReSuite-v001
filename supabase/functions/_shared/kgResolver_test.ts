// kgResolver — the one place knowledge-graph identity is decided (docs/PLAN.md §29, WP 19.1).
// Pins the identity rules, and the three committed reference datasets' load plans.
import { assert, assertEquals } from "../project-ai-chat/eval/harness/asserts.ts";
import {
  facilityLocality,
  kgKeyFor,
  normalizeCountry,
  planLoad,
  type ReferenceDataset,
  resolveMention,
} from "./kgResolver.ts";

const firm = (name: string, country: string | null, identifiers: Record<string, string> = {}) =>
  ({ ref: name, type: "Company" as const, name, country, identifiers });

Deno.test("a registry identifier decides, strongest first", () => {
  assertEquals(kgKeyFor(firm("Acme", "DE", { lei: "529900abcdefghijkl12", rmi_cid: "CID000001" })),
    "lei:529900ABCDEFGHIJKL12");
  assertEquals(kgKeyFor(firm("Acme", "DE", { rmi_cid: "cid000001" })), "rmi:CID000001");
  assertEquals(kgKeyFor(firm("Acme GmbH", "Germany")), "name:acme|germany");
  // A website is evidence, not identity.
  assertEquals(kgKeyFor(firm("Acme", "Germany", { website: "acme.de" })), "name:acme|germany");
});

Deno.test("the same name in two countries is two firms", () => {
  assert(kgKeyFor(firm("Murata", "China")) !== kgKeyFor(firm("Murata", "Japan")));
});

Deno.test("country spellings the sources use map to one name", () => {
  assertEquals(normalizeCountry("Korea"), "South Korea");
  assertEquals(normalizeCountry("Korean"), "South Korea");
  assertEquals(normalizeCountry("America"), "United States");
  assertEquals(normalizeCountry("USA"), "United States");
  assertEquals(normalizeCountry("CHINA"), "China");
  assertEquals(normalizeCountry("Czech Republic"), "Czechia");
  assertEquals(normalizeCountry("The Netherlands"), "Netherlands");
  assertEquals(normalizeCountry(""), null);
});

Deno.test("a facility's locality is its postcode", () => {
  assertEquals(facilityLocality("Hallas Allé, DK-4400 Kalundborg"), "4400");
  assertEquals(facilityLocality("Novo Allé 1, DK-2880 Bagsvaerd"), "2880");
  assertEquals(facilityLocality("1, rue de la Vierge, 33 565 Carbon Blanc Cedex"), "33565");
  // A street number comes before the postcode; the last group wins.
  assertEquals(facilityLocality("4766 LaGuardia Drive, St. Louis, MO 63134"), "63134");
  // No numeric postcode: the last part, diacritics folded.
  assertEquals(facilityLocality("Bush Road, Glasgow, United Kingdom"), "united kingdom");
  const a = { type: "Facility" as const, name: "Novo Nordisk A/S", country: "Denmark", identifiers: {} };
  assert(kgKeyFor({ ...a, address: "Hallas Allé, DK-4400 Kalundborg" }) !==
    kgKeyFor({ ...a, address: "Novo Allé, DK-2880 Bagsværd" }), "two sites of one firm stayed two");
});

Deno.test("resolveMention: a known key matches; a name never overrides an identifier", () => {
  const known = [{ kg_key: "name:murata|china", name: "Wuxi Murata", country: "China", aliases: ["Murata"] }];
  assertEquals(resolveMention(firm("Murata", "China"), known), { kind: "match", kg_key: "name:murata|china" });
  assertEquals(resolveMention(firm("Murata", "Japan"), known).kind, "new");
  // An LEI nobody holds yet is a new entity, even if a known entity shares the name.
  assertEquals(resolveMention(firm("Murata", "China", { lei: "5299000000000000AA11" }), known).kind, "new");
});

Deno.test("resolveMention: two candidates go to review, never a pick", () => {
  const known = [
    { kg_key: "name:murata electronics|china", name: "Murata Electronics", country: "China", aliases: ["Murata"] },
    { kg_key: "name:wuxi murata|china", name: "Wuxi Murata", country: "China", aliases: ["Murata"] },
  ];
  const r = resolveMention(firm("Murata", "China"), known);
  assertEquals(r.kind, "review");
  assertEquals(r.kind === "review" && r.candidates.length, 2);
});

const load = (n: string): ReferenceDataset =>
  JSON.parse(Deno.readTextFileSync(new URL(`../../../scripts/kg_reference/data/${n}.json`, import.meta.url)));

Deno.test("the three reference datasets resolve with no dangling endpoint", () => {
  for (const [n, entities] of [["fairphone", 492], ["novo_nordisk", 47], ["zentiva", 37]] as const) {
    const p = planLoad(load(n));
    assertEquals(p.dangling, [], `${n}: an assertion names an entity the dataset does not define`);
    assertEquals(p.entities.length, entities, `${n}: entity count moved — a resolver rule changed`);
    assertEquals(new Set(p.entities.map((e) => e.kg_key)).size, p.entities.length);
    for (const a of p.assertions) {
      assert(a.evidence.length > 0 && a.evidence.every((e) => e.fragment.length <= 200),
        `${n}: an assertion without short verbatim evidence`);
    }
  }
});

Deno.test("Zentiva's Bucharest spellings: one site per name, the name pairs only flagged", () => {
  const p = planLoad(load("zentiva"));
  const bucharest = p.entities.filter((e) => e.kg_key.endsWith("|romania|032266"));
  // "S.C. Zentiva S.A" / "S.C. Zentiva, S.A." merged; "Zentiva S.A." is NOT merged
  // with them — nothing proves they are one legal entity — but it is flagged.
  assert(bucharest.some((e) => e.kg_key === "name:s c zentiva s a|romania|032266"));
  assert(bucharest.some((e) => e.kg_key === "name:zentiva s a|romania|032266"));
  assert(p.nearDuplicates.some(([a, b]) =>
    a === "name:s c zentiva s a|romania|032266" && b === "name:zentiva s a|romania|032266"));
});

Deno.test("the loader emits one transaction: an upsert per entity, a fact call per piece of evidence", async () => {
  const { loadSql } = await import("../../../scripts/kg_reference/load_sql.ts");
  const root = new URL("../../../scripts/kg_reference/", import.meta.url);
  const z = "00000000-0000-0000-0000-000000000000";
  for (const n of ["fairphone", "novo_nordisk", "zentiva"]) {
    const sql = loadSql(n, z, z, z, root);
    const p = planLoad(load(n));
    const evidence = p.assertions.reduce((k, a) => k + a.evidence.length, 0);
    assert(sql.includes("\nBEGIN;\n") && sql.trimEnd().endsWith("COMMIT;"), `${n}: not one transaction`);
    assertEquals((sql.match(/public\.kg_upsert_entity\(/g) ?? []).length, p.entities.length, n);
    assertEquals((sql.match(/public\.kg_record_assertion\(/g) ?? []).length, evidence, n);
    assertEquals((sql.match(/public\.record_external_evidence\(/g) ?? []).length, evidence, n);
  }
});

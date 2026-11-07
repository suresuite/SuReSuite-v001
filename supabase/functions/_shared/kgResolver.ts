// The knowledge-graph resolver — the ONE place an entity's identity is decided
// (docs/PLAN.md §29, WP 19.1; ai-agents.md §18.2 v3).
//
// Everything that writes kg_entities goes through `kgKeyFor` and
// `resolveMention`; the SQL functions store what this decided and never
// re-derive it (gate `single-source`). Name normalization is NOT re-implemented
// here: it is networkEvidence.ts's `normalizeEntityName`, the same function the
// Network Cartographer's evidence tally uses.
//
// The rules (PLAN.md §29 rule 3 — no identity by guess):
//   1. A registry identifier decides: LEI, then a Responsible Minerals
//      Initiative smelter id, then Wikidata, then Open Supply Hub, then the EMA
//      product number. Two entities share a key only if they share one of these.
//   2. Without one, the key is the normalized name plus the canonical country —
//      so "Murata" in China and "Murata" in Japan are two entities, and the same
//      firm printed twice in one document is one.
//   3. Looking up a mention against what the organization already knows: an
//      exact key wins; else one alias / name match in the same country wins;
//      more than one candidate goes to the review queue — never a pick.

import { normalizeEntityName } from "./networkEvidence.ts";

export type KgEntityType = "Company" | "Facility" | "Product" | "Material" | "Location";

export interface KgEntityInput {
  ref: string;
  type: KgEntityType;
  name: string;
  country: string | null;
  identifiers: Record<string, string | null | undefined>;
  /** A facility's street address, when the source prints one. */
  address?: string | null;
}

/** Country spellings the sources actually use, mapped to one name. Kept to
 * what the reference documents print; an unknown spelling passes through
 * title-cased rather than being guessed. */
const COUNTRY_ALIASES: Record<string, string> = {
  "korea": "South Korea",
  "korean": "South Korea",
  "republic of korea": "South Korea",
  "south korea": "South Korea",
  "america": "United States",
  "usa": "United States",
  "us": "United States",
  "united states of america": "United States",
  "united states": "United States",
  "taiwan r o c": "Taiwan",
  "taiwan roc": "Taiwan",
  "r o c": "Taiwan",
  "czech republic": "Czechia",
  "the netherlands": "Netherlands",
  "uk": "United Kingdom",
  "great britain": "United Kingdom",
};

export function normalizeCountry(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (COUNTRY_ALIASES[s]) return COUNTRY_ALIASES[s];
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

const ID_ORDER: Array<[string, string]> = [
  ["lei", "lei"],
  ["rmi_cid", "rmi"],
  ["wikidata_qid", "wd"],
  ["osh_id", "osh"],
  ["ema_product_number", "ema"],
];

/** The locality a facility sits at: its postcode — the LAST group of four or
 * more digits in the address, spaces and hyphens inside it dropped — so
 * "DK-4400 Kalundborg" and "4400, Kalundborg" are one site, and so are
 * "33565 Carbon Blanc" and "33 565 Carbon Blanc". A street number comes
 * before the postcode, which is why the last group wins. With no postcode
 * (a UK one is alphanumeric) it is the last address part, diacritics folded.
 * A different postcode is a different site, even when it is a source's typo:
 * spotting near-duplicates is the review queue's job, not this function's. */
export function facilityLocality(address: string | null | undefined): string {
  const a = String(address ?? "");
  const groups = a.match(/\d[\d\s-]{2,}\d/g) ?? [];
  const last = groups.map((g) => g.replace(/\D/g, "")).filter((g) => g.length >= 4).pop();
  if (last) return last;
  const parts = a.split(/,\s*/).filter(Boolean);
  return (parts[parts.length - 1] ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/æ/gi, "ae")
    .replace(/ø/gi, "o").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** The entity's kg_key: the strongest identifier, else name + country (and,
 * for a facility, its locality). */
export function kgKeyFor(e: Pick<KgEntityInput, "type" | "name" | "country" | "identifiers" | "address">): string {
  for (const [field, prefix] of ID_ORDER) {
    const v = e.identifiers?.[field];
    if (v && String(v).trim()) return `${prefix}:${String(v).trim().toUpperCase()}`;
  }
  const name = normalizeEntityName(e.name);
  if (e.type === "Location") return `country:${normalizeCountry(e.name) ?? name}`;
  if (e.type === "Material") return `material:${name}`;
  if (e.type === "Product") return `product:${name}`;
  const base = `name:${name}|${(normalizeCountry(e.country) ?? "").toLowerCase()}`;
  return e.type === "Facility" && e.address ? `${base}|${facilityLocality(e.address)}` : base;
}

export interface KnownEntity {
  kg_key: string;
  name: string;
  country: string | null;
  aliases: string[];
}

export type Resolution =
  | { kind: "match"; kg_key: string }
  | { kind: "review"; candidates: string[] }
  | { kind: "new"; kg_key: string };

/** Resolve one mention against an organization's known entities. */
export function resolveMention(e: KgEntityInput, known: readonly KnownEntity[]): Resolution {
  const key = kgKeyFor(e);
  if (known.some((k) => k.kg_key === key)) return { kind: "match", kg_key: key };
  if (e.type !== "Company" && e.type !== "Facility") return { kind: "new", kg_key: key };
  // A registry key that is not known yet is a new entity: a name match can
  // never override an identifier (rule 1).
  if (!key.startsWith("name:")) return { kind: "new", kg_key: key };
  const norm = normalizeEntityName(e.name);
  const country = normalizeCountry(e.country);
  const hits = known.filter((k) =>
    (normalizeCountry(k.country) === country || !country || !k.country) &&
    [k.name, ...k.aliases].some((n) => normalizeEntityName(n) === norm)
  );
  if (hits.length === 1) return { kind: "match", kg_key: hits[0].kg_key };
  if (hits.length > 1) return { kind: "review", candidates: hits.map((h) => h.kg_key).sort() };
  return { kind: "new", kg_key: key };
}

export interface DatasetAssertion {
  subject: string;
  relation: string;
  object: string;
  qualifier: Record<string, unknown>;
  evidence: Array<{ source: string; page: number | null; fragment: string }>;
}

export interface ReferenceDataset {
  dataset: string;
  focal: string;
  entities: KgEntityInput[];
  assertions: DatasetAssertion[];
}

export interface LoadPlan {
  entities: Array<{ kg_key: string; type: KgEntityType; name: string; country: string | null;
                    identifiers: Record<string, string>; aliases: string[] }>;
  /** ref → kg_key, for the assertions. */
  refs: Record<string, string>;
  assertions: Array<Omit<DatasetAssertion, "subject" | "object"> & { subject: string; object: string }>;
  /** refs that collapsed onto an entity an earlier ref already made. */
  merged: number;
  /** assertion endpoints that name no entity in the dataset. */
  dangling: string[];
  /** Pairs that MAY be one entity — same country and locality, one name's
   * words inside the other's — for the identity review queue. Never merged. */
  nearDuplicates: Array<[string, string]>;
}

function nearDuplicatePairs(entities: LoadPlan["entities"]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const firms = entities.filter((e) => e.kg_key.startsWith("name:"));
  for (let i = 0; i < firms.length; i++) {
    for (let j = i + 1; j < firms.length; j++) {
      const [, ni, ...ri] = firms[i].kg_key.split(/[:|]/);
      const [, nj, ...rj] = firms[j].kg_key.split(/[:|]/);
      if (ri.join("|") !== rj.join("|")) continue;
      const a = new Set(ni.split(" ")), b = new Set(nj.split(" "));
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      if ([...small].every((t) => big.has(t))) out.push([firms[i].kg_key, firms[j].kg_key].sort() as [string, string]);
    }
  }
  return out.sort((x, y) => x[0].localeCompare(y[0]));
}

/** Pure: a reference dataset → what the loader writes (no database). */
export function planLoad(ds: ReferenceDataset): LoadPlan {
  const byKey = new Map<string, LoadPlan["entities"][number]>();
  const refs: Record<string, string> = {};
  let merged = 0;
  for (const e of ds.entities) {
    const key = kgKeyFor(e);
    refs[e.ref] = key;
    const ids = Object.fromEntries(
      Object.entries(e.identifiers ?? {}).filter(([, v]) => v != null && String(v).trim() !== ""),
    ) as Record<string, string>;
    const prev = byKey.get(key);
    if (prev) {
      merged++;
      if (e.name !== prev.name && !prev.aliases.includes(e.name)) prev.aliases.push(e.name);
      prev.identifiers = { ...ids, ...prev.identifiers };
      continue;
    }
    byKey.set(key, { kg_key: key, type: e.type, name: e.name, country: normalizeCountry(e.country),
                     identifiers: ids, aliases: [] });
  }
  const dangling: string[] = [];
  const assertions = ds.assertions.map((a) => {
    const s = refs[a.subject], o = refs[a.object];
    if (!s) dangling.push(a.subject);
    if (!o) dangling.push(a.object);
    return { ...a, subject: s ?? a.subject, object: o ?? a.object };
  });
  const entities = [...byKey.values()];
  return { entities, refs, assertions, merged, dangling: [...new Set(dangling)].sort(),
           nearDuplicates: nearDuplicatePairs(entities) };
}

/** The qualifier fields that make two facts between one pair different facts
 * (kg_assertions.qualifier_key). Descriptive fields — an address, a site
 * count, a path note — are kept in `qualifier` but do not split a fact. */
const QUALIFIER_KEY_FIELDS = ["tier", "role", "category", "strengths", "material"] as const;

export function qualifierKey(q: Record<string, unknown> | null | undefined): string {
  return QUALIFIER_KEY_FIELDS
    .filter((k) => q?.[k] !== undefined && q?.[k] !== null && q?.[k] !== "")
    .map((k) => `${k}=${String(q![k])}`)
    .join("|");
}

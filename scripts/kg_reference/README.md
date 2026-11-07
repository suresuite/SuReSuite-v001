# Knowledge-graph reference datasets (Phase 19)

`docs/PLAN.md` §29 is the authority for this directory. These are the three reference companies the knowledge graph
is built and scored against:

| Dataset | Company | Source | What it can and cannot say |
|---|---|---|---|
| `data/fairphone.json` | Fairphone B.V. (NL, electronics) | Fairphone's Supply Chain Engagement report 2024, Annex 1 (suppliers by tier) and Annex 2 (smelters and refiners) | Tier-1 to tier-3 suppliers per product, sites, countries, component category; smelters by metal with RMI ids. Not which tier-2 supplies which tier-3. |
| `data/novo_nordisk.json` | Novo Nordisk A/S (DK, pharma) | EMA medicines table + each EPAR's product information, Annex II.A | Active-substance (biologics) and batch-release sites per medicine. Not small-molecule ingredient makers, volumes or availability. |
| `data/zentiva.json` | Zentiva, k.s. (CZ, generics) | Same as Novo Nordisk | Same as Novo Nordisk. |

Every dataset is labelled as mapped from public records and **not endorsed by or affiliated with** the company.

## Rules

- **Documents are never committed.** They are cached outside the repository (`KG_CACHE`, default `~/.cache/suresuite-kg`);
  `sources.json` records each one's URL, retrieval date and sha256.
- **Facts and short quotes only.** Each assertion carries its source, page (where the document has one) and a verbatim
  fragment of at most 200 characters.
- **No identity here.** The extractors record raw names and printed identifiers. Matching names is
  `supabase/functions/_shared/kgResolver.ts`'s job alone (gate `single-source`).
- **No personal data.** No `Person` entities.
- **Polite fetching.** A generic client name, about one request every 6 seconds, and backing off on HTTP 429.

## Rebuild

```
pip install pdfplumber openpyxl            # plus poppler's pdftotext on PATH
python scripts/kg_reference/build_fairphone.py
python scripts/kg_reference/build_ema.py
python scripts/kg_reference/build_fairphone.py --check   # rebuild and compare, exit 1 on drift
```

`supabase/functions/_shared/kgResolver_test.ts` pins how these files resolve (entity counts, no dangling endpoints, short
evidence) and runs in `scsim-tests.yml`.

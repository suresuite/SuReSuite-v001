# euroFMX — HWR Berlin contribution record

> **AUTHORED.** A self-contained brief for the next session, on the pattern of
> `docs/handoff-fable5.md`. It carries HWR Berlin's share of the euroFMX grant —
> the person-month budget, the contract and capacity model, the allocation
> workbook, the cost check, and the conventions that cost rework when forgotten.
>
> **This is not platform work.** It does not advance `docs/PLAN.md` or the
> blueprint, and it carries no data-layer `file:line` evidence (see `CLAUDE.md`,
> *single-source*). Nothing here should be restated in `docs/PLAN.md §4`.

---

## 1. The grant

| | |
|---|---|
| Project | **euroFMX** — European Factory of the Future Manufacturing eXcellence |
| Grant agreement | **101299128** |
| Call | HORIZON-CL4-2025-03-DIGITAL-EMERGING-07 (RIA) |
| Duration | **1 June 2026 – 31 May 2030** — 48 months, M1 = Jun 2026, M48 = May 2030 |
| Consortium | 67 partners |
| HWR's lead | **Phu Nguyen**, with **Prof. Dmitry Ivanov** |

HWR's technical centre of gravity is **WP4 — GenAI Models, Dynamic and Symbiotic
Agentic Systems and Autonomisation Tools** (lead UNIROMA1, M4–M36), specifically:

- **T4.2** — graph-based GenAI tools and the Manufacturing Memory Fabric. Lead
  **IDSIA-SUPSI** (contact: Marco Forgione).
- **T4.4** — active inference for agentic AI decisions. Lead **TUE**.

The research positioning that underpins both is `docs/research/ai-for-scm-positioning.md`.

## 2. HWR's person months, by work package

Read off **Part A, page 24** of Annex 1. The extraction is trustworthy because the
row sums to exactly the 30.50 PM HWR is granted.

| WP | Title (short) | HWR tasks | Task window | **PM** |
|---|---|---|---|---|
| WP1 | Project Management, Coordination and Ethics | T1.1 | M1–M48 | 1.00 |
| WP2 | Robust & Trustworthy Industrial Autonomisation Reference Framework | T2.2 | M1–M33 | 6.00 |
| WP4 | GenAI Models, Agentic Systems and Autonomisation Tools | T4.2, T4.4 | M7–M36 | 8.00 |
| WP7 | High-speed flexible autonomisation | T7.5, T7.7, T7.8 | M10–M48 | **0.00** |
| WP8 | High-accuracy, transparent autonomisation | T8.6, T8.7 | M16–M48 | 12.00 |
| WP10 | euroFMX Outreach & Ecosystem Development | T10.6 | M1–M48 | 3.50 |
| | | | **TOTAL** | **30.50** |

**WP7 is an open anomaly.** Part A names HWR in T7.5, T7.7 and T7.8 but budgets
**zero** person months for it. Flagged, never resolved — see §8.

Division of labour agreed with Prof. Ivanov: **Phu takes the technical WPs**
(WP2, WP4, WP8); **WP1 and WP10 are reserved for Prof. Ivanov**, who also absorbs
whatever WP8 Phu cannot reach.

## 3. Person-month arithmetic

Decoded from the HWR timesheet's own formulas (`B14 = 39.4/5`,
`D17 = E17/($B$14*5)`, `F17 = E17*((215/12*8)/($B$14*5))`) — not assumed:

| Quantity | Value |
|---|---|
| Day equivalents per year (Horizon Europe) | 215 |
| **1 PM** | 215/12 × 8 = **143.33 h** |
| HWR standard week | **39.4 h** |
| Day equivalent | 39.4 / 5 = **7.88 h** |
| FTE % | hours per week ÷ 39.4 |
| PM per month | ≡ the FTE fraction (0.50 FTE ⇒ 0.50 PM/month) |

## 4. The contract and capacity model

Prof. Ivanov proposed (and Phu accepted, Nov 2026) raising the contract from 50%
to **66% for 24 months**, to re-spend the 3.8 PM unused in 2026 (6 months × 50%
plus 5 months × 16%).

| Band | Months | Calendar | PM/month | h/week | Total PM |
|---|---|---|---|---|---|
| 1 | M1–M6 | Jun – Nov 2026 | 0.00 | 0.0 | 0.00 |
| 2 | M7–M11 | Dec 2026 – Apr 2027 | 0.34 | 13.40 | 1.70 |
| 3 | **M12–M35** | **May 2027 – Apr 2029** | **0.66** | 26.00 | 15.84 |
| 4 | M36–M48 | May 2029 – May 2030 | 0.50 | 19.70 | 6.50 |
| | | | | **TOTAL** | **24.04** |

24.04 PM against a **24 PM staff budget** — it fits. The decisive scheduling gain:
at 66% Phu can **start WP8 at M16**, when T8.6/T8.7 actually open, instead of M34.

## 5. The allocation model

Capacity is spent by a **strict priority cascade — WP4 → WP2 → WP8** (not
proportional to burn rate). Each WP is otherwise paced at an **even burn rate**:
remaining PM ÷ remaining months of that WP's own schedule window, recomputed every
month, so a WP always lands exactly on its budget at the end of its window.

Rows are **displayed in natural order** (WP1, WP2, WP4, WP7, WP8, WP10) while the
cascade runs in priority order. Do not reorder the display rows — the task-label
column is aligned to them, and reordering once produced a grid reading "WP4 | T1.1".

**The v8 → v9 change.** In M12–M15 the contract is already at 66% but WP4 (0.27)
and WP2 (0.26) need only 0.53, and WP8 is not open until M16 — so 0.14 PM/month,
**0.55 PM in total**, went unspent, and Year 2 read 62.6% FTE instead of 66%. v9
lets WP2 draw the full remaining capacity while WP8 is closed; its burn rate then
self-recomputes downward from M16 and the freed capacity flows to WP8.

| | v8 | **v9 (current)** |
|---|---|---|
| Allocated | 23.49 | **24.04** (= full capacity) |
| Unused capacity | 0.14 in M12–M15 | **0.00, every month** |
| WP2 / WP4 | 6.00 / 8.00 | 6.00 / 8.00 |
| WP8 — Phu | 9.49 | **10.04** |
| Prof. Ivanov | 7.01 | **6.46** = 1.00 WP1 + 1.96 WP8 + 3.50 WP10 |
| Year 2 FTE | 62.6% | **66.0%** |

Per project year (v9): Y1 2.36 · Y2 7.92 · Y3 7.76 · Y4 6.00 = **24.04**.
Year 3 reads 64.7%, not 66%, because M36 (May 2029) already drops to 50%.

## 6. The workbook

**`docs/projects/eurofmx/euroFMX_HWR_PM_v9.xlsx`** — one sheet, eight sections.
Built by `docs/projects/eurofmx/build_pm_sheet.py` (see §11 before running it).

| Rows | Section |
|---|---|
| 1–9 | 1. Identification |
| 12–17 | 2. Planned PM budget — one line per band, total capacity, Prof. Ivanov's residual (`D17 = D9 − C52`) |
| 20–26 | 3a. By availability period · 3b. By project year (K–O: WP2, WP4, WP8, total, FTE) |
| 29–35 | 4. Availability assumptions — **bands live in rows 31–34**, total capacity `C35 = AY64` |
| 38–46 | 5. Project schedule — **rows 41–46 are the six WPs**: `E` approved PM, `F` start month, `G` end month |
| 49–56 | 6. PM allocation by WP (51 approved, 52 Phu, 53 Prof. Ivanov) · **8. Cost check at K48:O56** |
| 59–81 | 7. Month-by-month projection |

Month grid, columns **C..AX = M1..M48**:

| Row | Contents |
|---|---|
| 62 | project month 1–48 |
| 63 | calendar month |
| 64 | **capacity (PM)** — `SUMIFS` over the bands in rows 31–34 |
| 65 / 66 / 67 | required even-burn rate for WP4 / WP2 / WP8 |
| 68 / 69 | capacity left after WP4 / after WP2 |
| 70–75 | allocations, natural order: WP1, WP2, WP4, WP7, WP8, WP10 |
| 76 / 77 | total allocated / **unused capacity** (must be 0 everywhere) |
| 78 / 79 / 80 | cumulative WP4 / WP2 / WP8 |
| 81 | total hours |

The cascade, for column `N`:

```
N72 (WP4)  = MIN(N65, N64)                      1st priority
N71 (WP2)  = IF(AND(N$62>=$F$42,N$62<=$G$42),   2nd priority, v9 form
               MIN(N68, IF(N$62<$F$45, MAX(0,$E$42-M79), N66)), 0)
N74 (WP8)  = MIN(N67, N69)                      3rd priority
```

Section 6 rows 52 and 53 read the grid (`=AY71`, `=AY72`, `=AY74`) and derive
Prof. Ivanov's share as `approved − Phu`, so the whole sheet follows a band change.

## 7. Cost check against Dr. Ebert's budget plan

Source: `Budgetplan_EUROFMX_Ivanov_2026-07-02_me_di.xlsx`, E13 TV-L Stufe 3.
The sheet's section 8 computes plan cost from the **capacity row**, not from the
allocations — so re-balancing work between WPs never moves the cost.

| Year | E13 full-time | Budget 50% (Ebert) | Plan (sheet) | Difference |
|---|---|---|---|---|
| 2026 | 89,891 *(2027 rate as proxy; no 2026 line exists)* | €0 | €2,547 | **+2,547** |
| 2027 | 89,891 | €44,945.50 | €49,740 | +4,794 |
| 2028 | 92,081 | €46,040.50 | €60,773 | **+14,733** |
| 2029 | 94,325 | €47,162.50 | €52,193 | +5,031 |
| 2030 | 96,626 | €48,313.00 | €20,130 | **−28,183** |
| **TOTAL** | | **€186,461.50** | **€185,383.64** | **−1,077.86** |

**It fits in total, with €1,078 to spare — but not year by year.** The plan runs
**+€27,105 across 2026–2029** and pays it back only with the **€28,183** that falls
off the end of 2030, because the project ends **31 May 2030** while the budget line
covers a full calendar year. It therefore balances only if funds can move between
calendar years, and **2026 has no budget line at all** although the contract starts
in Dec 2026.

## 8. Open items

1. **WP7 = 0.00 PM** although Part A names HWR in T7.5/T7.7/T7.8. Never resolved.
2. **The year profile above** — raise with Dr. Ebert if the annual lines are fixed.
3. Section 6 of the workbook has typed `0`s in the WP1/WP7/WP10 cells of the Phu
   row, instead of blanks, against the convention in §9.
4. WP8 still needs **1.96 PM from Prof. Ivanov**, on top of WP1 (1.00) and
   WP10 (3.50) — 6.46 PM in all.

## 9. Standing conventions

- **Prof. Ivanov reads in about two minutes.** Short, conclusion first, detail in a
  table below. Same for Dr. Ebert.
- **Show blank, never `0`.** Number format `0.00;-0.00;` throughout the grid; a grid
  full of zeros is unreadable.
- Cell background in the month grid follows the §5 schedule: dark green = scheduled
  and effort planned, pale green = scheduled but no capacity left.
- **The WSC'26 paper (Nguyen, Borodin, Dolgui & Ivanov) belongs to the ACCURATE
  project.** It must **not** be cited as the basis of the euroFMX contribution.
- **Network mapping is validated against reference databases** — FactSet, Mergent and
  the like — **never against simulation.** Simulation answers *consequence*; it cannot
  tell you whether an extracted supplier relation is real. Conflating the two is the
  single correction that most needed making during this work.

## 10. The research work, already in the repo

| Path | What it is |
|---|---|
| `docs/research/ai-for-scm-positioning.md` | "Proposer, Not Authority" — the separation-of-powers architecture, three epistemic acts, principles DP1–DP7 |
| `docs/research/measurement-protocol.md` | turning the positioning into an empirical paper: indicator set, the RQ3 cost-of-safety A/B, threats to validity |
| `scripts/research/compute_indicators.py` | the instrument — reads an `ai_chat_events` export, computes DP1–DP7, exits 2 on a DP1 invariant violation |
| `docs/research/literature-review-prompt.md` | interdisciplinary review prompt (SCM + AI/CS venues) |
| `docs/design/ai-agents.md` §18, §18.5 | agents B7 (cost estimator), B8 (network cartographer, firm- then product-level `r_{p,m}`), B9 (risk sentinel), and the data-source registry |
| `docs/design/ai-agents-implementation-prompts.md` | session-sized build prompts, phases 4a–4d |

## 11. Tooling notes

- **Use `python3.13`.** `python3` is 3.11 here and has neither openpyxl nor pdfminer.
- openpyxl writes formulas as **text** and caches no values. Read values back with a
  second `load_workbook(..., data_only=True)` pass, and only after recalculating:
  `soffice --headless --norestore --convert-to xlsx --outdir out <file>.xlsx`.
- **Never insert or delete rows** — openpyxl does not re-point formulas. Use the
  blank rows already in the layout.
- `MergedCell.value` is read-only; writing to one raises. Section bars are merged.
- Annex 1 PDFs: `pdftoppm` is missing, so pages cannot be rendered. Extract text with
  pdfminer.six and use cell coordinates to recover table structure.

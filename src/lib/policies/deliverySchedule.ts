/**
 * A Customer row's REQUESTED DELIVERY SCHEDULE — the third demand mode beside
 * forecast and model (P-C.4).
 *
 * The schedule is an array of units per week, one value per simulated week from
 * week 1, typed on /policies and saved as the override `demand.row_demand_schedule`
 * on the row. The engine runs it exactly (`project_map._apply_row_demand_overrides`:
 * deterministic, forecast = the schedule, mean 0 — a week past its end has no
 * demand). These helpers are the editor's arithmetic, kept pure so they are tested.
 */

/** The schedule's length cap — the agent surface refuses longer (`policyFields.ts`). */
import { projectWindow } from "@/lib/sim/projectWindow";
import { formatRunWeekRange, isCalendarDate } from "@/lib/sim/calendarWeeks";

export const MAX_SCHEDULE_WEEKS = 520;

/** The run's length in whole weeks from the project's simulation window, or
 *  `fallback` when the window is not set. The window is `projectWindow`'s —
 *  one rule for every surface that sizes a run (PLAN.md §4 D318). */
export function horizonWeeksOf(
  start: string | null | undefined,
  end: string | null | undefined,
  fallback = 52,
): number {
  const w = projectWindow(start, end);
  if (!w) return fallback;
  return Math.min(MAX_SCHEDULE_WEEKS, Math.max(1, w.weeks));
}

/** A stored value as a schedule: an array of finite non-negative numbers, or
 *  null when it is not one (nothing saved, or a value the engine would refuse). */
export function asSchedule(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = x === null || x === "" ? 0 : Number(x);
    if (!Number.isFinite(n) || n < 0) return null;
    out.push(n);
  }
  return out;
}

/**
 * Text pasted from a spreadsheet column or row (or typed as a list) → weekly
 * quantities. Separators: newline, tab, comma, semicolon or spaces. A decimal
 * comma is accepted only when the text has no other comma use (one number per
 * line). Returns the values, or the first token that is not a quantity ≥ 0.
 */
export function parseSchedulePaste(text: string): { values: number[] } | { error: string } {
  const lines = text.trim().split(/\r?\n/);
  // "12,5" on its own line is a decimal comma; "12, 5" or "12,5,7" across one line is a list.
  const decimalComma = lines.length > 1 && lines.every((l) => /^\s*\d+,\d+\s*$|^\s*\d*\s*$/.test(l));
  const tokens = (decimalComma ? lines.map((l) => l.replace(",", ".")) : lines)
    .join("\n")
    .split(/[\s,;]+/)
    .filter((t) => t !== "");
  const values: number[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return { error: `"${t}" is not a quantity ≥ 0` };
    values.push(n);
  }
  if (values.length === 0) return { error: "nothing to paste" };
  if (values.length > MAX_SCHEDULE_WEEKS) return { error: `${values.length} values — at most ${MAX_SCHEDULE_WEEKS} weeks` };
  return { values };
}

/** `weeks` values: the schedule padded with zeros, or cut, to that length. */
export function resizeSchedule(values: readonly number[], weeks: number): number[] {
  const n = Math.max(0, Math.min(MAX_SCHEDULE_WEEKS, Math.floor(weeks)));
  return Array.from({ length: n }, (_, i) => values[i] ?? 0);
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/** One line for the grid cell: weeks, total, and the first weekly values. */
export function scheduleSummary(values: readonly number[] | null, horizonWeeks?: number): string {
  if (!values || values.length === 0) return "not entered";
  const total = values.reduce((a, b) => a + b, 0);
  // A preview of the first weeks, each shown whole — the dialog shows them all.
  const firstWeeks = values.filter((_, i) => i < 3).map(fmt).join(", ");
  const of = horizonWeeks !== undefined && values.length !== horizonWeeks ? ` of ${horizonWeeks}` : "";
  return `${values.length}${of} wk · Σ ${fmt(total)} · ${firstWeeks}${values.length > 3 ? " …" : ""}`;
}

/**
 * A schedule cell's label (§4 D319): cell i feeds engine tick i, so it is RUN
 * WEEK i — numbered as the engine, the Lab and the results number weeks — with
 * its seven days when the project states a start.
 */
export function scheduleCellLabel(weekOneStart: string | null | undefined, i: number): {
  short: string;
  title: string;
} {
  const days = isCalendarDate(weekOneStart) ? formatRunWeekRange(weekOneStart, i) : null;
  return { short: `W${i}`, title: days ? `Run week ${i} · ${days}` : `Run week ${i}` };
}

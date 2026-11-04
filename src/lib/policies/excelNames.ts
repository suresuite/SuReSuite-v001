// File- and sheet-name rules shared by the workbook builders. Kept apart from
// `excel.ts` so that a caller who only needs a name does not pull in the `xlsx`
// library (~900 kB of source) with it.

/** Excel's sheet-name rules: ≤ 31 chars, none of []:*?/\\ . */
export function sheetName(s: string): string {
  return s.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);
}

/** A file-name-safe slug of a display name (≤ 48 chars). */
export function safeName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 48);
}

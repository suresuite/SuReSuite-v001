import { safeName } from "@/lib/policies/excelNames";

/** `inventory-<project>-run-<id8>-<YYYY-MM-DD>.xlsx`. In its own file so the explorer
 *  can name a download without loading the workbook library. */
export function inventoryFileName(projectName: string, runId: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return `inventory-${safeName(projectName)}-run-${runId.slice(0, 8)}-${day}.xlsx`;
}

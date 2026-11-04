import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DIALOG_AS_SHEET } from "@/components/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_SCHEDULE_WEEKS,
  asSchedule,
  parseSchedulePaste,
  resizeSchedule,
  scheduleCellLabel,
  scheduleSummary,
} from "@/lib/policies/deliverySchedule";

/**
 * The Customer row's REQUESTED DELIVERY SCHEDULE cell (P-C.4): a summary that
 * opens an editor with one input per week of the run. What is saved is the
 * array the engine runs exactly — units per week from run week 0 (the project
 * start). Weeks are numbered as the engine and the Lab number them (§4 D319).
 */
export function DeliveryScheduleCell({
  value,
  horizonWeeks,
  weekOneStart,
  rowLabel,
  disabled,
  onCommit,
}: {
  value: unknown;
  horizonWeeks: number;
  /** ISO date of run week 0's first day (the project start), when the project states its window. */
  weekOneStart?: string | null;
  rowLabel: string;
  disabled?: boolean;
  onCommit: (schedule: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const schedule = asSchedule(value);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={
          schedule
            ? `Requested delivery schedule — ${schedule.length} week(s). Click to edit.`
            : "No delivery schedule entered yet — click to enter the quantity for each week"
        }
        className={cn(
          "block h-5 w-full min-w-0 truncate rounded-sm border border-transparent px-[5px] text-left font-mono text-[11px] hover:bg-[#fafafa] focus:border-[--zinc-border] focus:outline-none",
          schedule ? "text-[#111]" : "text-[#b4b4b4]",
        )}
      >
        {schedule ? scheduleSummary(schedule, horizonWeeks) : "enter schedule…"}
      </button>
      {open && (
        <DeliveryScheduleDialog
          open={open}
          onOpenChange={setOpen}
          initial={schedule}
          horizonWeeks={horizonWeeks}
          weekOneStart={weekOneStart}
          rowLabel={rowLabel}
          onApply={(v) => {
            onCommit(v);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const toText = (n: number) => (n === 0 ? "" : String(n));

function DeliveryScheduleDialog({
  open,
  onOpenChange,
  initial,
  horizonWeeks,
  weekOneStart,
  rowLabel,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: number[] | null;
  horizonWeeks: number;
  weekOneStart?: string | null;
  rowLabel: string;
  onApply: (schedule: number[]) => void;
}) {
  const startWeeks = Math.max(horizonWeeks, initial?.length ?? 0);
  // Cells are edited as TEXT so a half-typed "1." is not rewritten under the cursor.
  const [cells, setCells] = useState<string[]>(() => resizeSchedule(initial ?? [], startWeeks).map(toText));
  const [weeks, setWeeks] = useState(startWeeks);
  const [fill, setFill] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  useEffect(() => {
    setCells((c) => Array.from({ length: weeks }, (_, i) => c[i] ?? ""));
  }, [weeks]);

  const values = useMemo(() => cells.map((t) => (t.trim() === "" ? 0 : Number(t))), [cells]);
  const invalid = values.map((n) => !Number.isFinite(n) || n < 0);
  const anyInvalid = invalid.some(Boolean);
  const total = anyInvalid ? null : values.reduce((a, b) => a + b, 0);


  const applyPaste = () => {
    const r = parseSchedulePaste(paste);
    if ("error" in r) {
      setPasteError(r.error);
      return;
    }
    setPasteError(null);
    setWeeks(Math.max(weeks, r.values.length));
    setCells((c) => {
      const next = Array.from({ length: Math.max(weeks, r.values.length) }, (_, i) => c[i] ?? "");
      r.values.forEach((v, i) => (next[i] = toText(v)));
      return next;
    });
    setPaste("");
  };

  const applyFill = () => {
    const n = Number(fill);
    if (fill.trim() === "" || !Number.isFinite(n) || n < 0) return;
    setCells((c) => c.map(() => toText(n)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(DIALOG_AS_SHEET, "md:max-w-3xl")}>
        <DialogHeader>
          <DialogTitle>Requested delivery schedule · {rowLabel}</DialogTitle>
          <DialogDescription>
            The quantity this customer asks to receive each week, from run week 0 (the project start). The run uses it
            exactly — no spread around it — and a week past the last one has no demand. A blank week is 0.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Weeks</span>
            <Input
              type="number"
              min={1}
              max={MAX_SCHEDULE_WEEKS}
              value={weeks}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n) && n >= 1 && n <= MAX_SCHEDULE_WEEKS) setWeeks(n);
              }}
              className="h-11 w-20 font-mono md:h-8"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Fill every week with</span>
            <div className="flex gap-1">
              <Input
                inputMode="decimal"
                value={fill}
                onChange={(e) => setFill(e.target.value)}
                placeholder="units / wk"
                className="h-11 w-28 font-mono md:h-8"
              />
              <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={applyFill}>
                Fill
              </Button>
            </div>
          </label>
          <span className="ml-auto font-mono text-muted-foreground">
            {weeks} wk{weeks !== horizonWeeks ? ` (run: ${horizonWeeks})` : ""} · total{" "}
            {total === null ? "—" : Math.round(total * 100) / 100} · avg{" "}
            {total === null ? "—" : Math.round((total / Math.max(1, weeks)) * 100) / 100} / wk
          </span>
        </div>

        <div className="grid max-h-[45svh] grid-cols-4 gap-1.5 overflow-auto py-1 md:grid-cols-[repeat(13,minmax(0,1fr))]">
          {cells.map((t, i) => (
            <label key={i} className="flex min-w-0 flex-col" title={scheduleCellLabel(weekOneStart, i).title}>
              <span className="font-mono text-[9.5px] text-muted-foreground">{scheduleCellLabel(weekOneStart, i).short}</span>
              <input
                inputMode="decimal"
                value={t}
                placeholder="0"
                aria-label={`Run week ${i} quantity`}
                onChange={(e) => {
                  const v = e.target.value;
                  setCells((c) => c.map((x, j) => (j === i ? v : x)));
                }}
                className={cn(
                  "h-11 w-full min-w-0 rounded-sm border md:h-7 bg-background px-1 text-right font-mono text-[11px] outline-none focus:border-foreground",
                  invalid[i] ? "border-destructive" : "border-border",
                )}
              />
            </label>
          ))}
        </div>

        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            Paste from a spreadsheet — one value per week, as a column or a row (fills from run week 0)
          </span>
          <div className="flex items-start gap-2">
            <Textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={2}
              placeholder={"120\n80\n0\n150"}
              className="min-h-0 flex-1 font-mono text-[11px]"
            />
            <Button variant="outline" size="sm" onClick={applyPaste} disabled={paste.trim() === ""}>
              Paste
            </Button>
          </div>
          {pasteError && <span className="text-destructive">{pasteError}</span>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={anyInvalid} onClick={() => onApply(values)}>
            Use schedule
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

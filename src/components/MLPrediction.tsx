import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Info, Table2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useGlobalProject } from '@/hooks/useGlobalProject';
import { M, MobileButton, MobileNote, MobilePanel, MobileRow } from '@/components/mobile';
import {
  DEFAULT_SORT,
  baselineLine,
  durationsOf,
  eur,
  scenarioLine,
  sortRows,
  staleNotes,
  zeroReasonText,
  type SortDir,
  type SortKey,
  type StressResult,
  type StressRow,
} from '@/lib/nexus/stressResults';

type RpcResult = Promise<{ data: unknown; error: { message?: string } | null }>;
/** `get_nexus_stress_results` is newer than the generated client types. */
const sb = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => RpcResult };

interface MLPredictionProps {
  /**
   * Kept for the three pages that pass it. The battery is per PROJECT (§27): one
   * stored result describes the whole project's suppliers and materials.
   */
  selectedPlant: string | null;
  /**
   * Wear the mobile skin (v2 §4C). Mounted by both platforms, so the skin arrives
   * as a prop. Same figures, same copy, same table — the skin only changes the
   * vocabulary of the summary around it.
   */
  skin?: boolean;
}

const NOT_PREPARED =
  'Not prepared for this project yet. The stress test is run in advance on the ' +
  "project's Validated Model; nothing runs from this card.";
const METHOD_NOTE =
  'Lost sales in € over the KPI window, each outage compared with the same run ' +
  'without it, on the same seeds. One supplier or material at a time; no compound events.';

/**
 * Nexus node prediction — PLAN.md §27 WP 17.5 (§4 D310).
 *
 * The card READS a battery prepared in advance (`get_nexus_stress_results`): every
 * supplier and supplied material disrupted alone under one shared scenario, ranked
 * by the lost sales the outage costs. It states the baseline the figures belong to
 * before it shows one, and opens the full table — one sortable column per outage
 * duration and an Average, opened sorted by the Average — in a dialog. It computes
 * nothing and has no Run button.
 */
export default function MLPrediction(props: MLPredictionProps) {
  // A demo session has no stress results to show and no right to read them: the card
  // would only say it could not read anything, so it is not drawn (src/lib/demo).
  const { demo } = useAuth();
  return demo ? null : <NexusPredictionCard {...props} />;
}

function NexusPredictionCard({ skin = false }: MLPredictionProps) {
  const [result, setResult] = useState<StressResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const { globalSelectedProjectId } = useGlobalProject();

  const fetchResult = useCallback(async () => {
    if (!globalSelectedProjectId || !user?.id) {
      setResult(null);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      const { data, error } = await sb.rpc('get_nexus_stress_results', {
        p_project_id: globalSelectedProjectId,
        p_user_id: user.id,
      });
      if (error) throw error;
      setResult((data as StressResult | null) ?? { run_id: null });
    } catch (err) {
      console.error('Error reading the nexus stress results:', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [globalSelectedProjectId, user?.id]);

  useEffect(() => {
    void fetchResult();
  }, [fetchResult]);

  const has = Boolean(result?.run_id);
  const materials = result?.materials ?? [];
  const suppliers = result?.suppliers ?? [];
  const prepared = result?.finished_at ? new Date(result.finished_at).toLocaleString() : null;
  const notes = has && result ? staleNotes(result) : [];
  const status = !globalSelectedProjectId
    ? 'Select a project first — the results belong to one project.'
    : loading ? 'Reading the prepared results…'
    : failed ? 'The prepared results could not be read.'
    : !has ? NOT_PREPARED
    : null;

  const table = has && result && (
    <NexusDialog open={open} onOpenChange={setOpen} result={result} />
  );

  if (skin) {
    return (
      <>
        <MobilePanel label="Nexus node prediction">
          {status ? (
            <MobileRow chevron={false} label={status} />
          ) : (
            <>
              <MobileRow chevron={false} label="Baseline" sub={baselineLine(result!)} />
              <MobileRow chevron={false} label="Scenario" sub={scenarioLine(result!)} />
              <MobileRow chevron={false} label="Prepared" sub={prepared ?? '—'}
                         dot={notes.length ? M.blocking : undefined} />
            </>
          )}
          <MobileRow
            label="What a nexus node is"
            sub="opens the reference"
            onClick={() => window.open('/docs/nexus-node.md', '_blank', 'noopener,noreferrer')}
          />
        </MobilePanel>
        {has && (
          <>
            <TopMobile label="Nexus materials" rows={materials} />
            <TopMobile label="Nexus suppliers" rows={suppliers} />
            <div className="px-3">
              <MobileButton block onClick={() => setOpen(true)}>Open the stress-test table</MobileButton>
            </div>
          </>
        )}
        {notes.map((n) => <MobileNote key={n} tone="caveat" mark="·">{n}</MobileNote>)}
        {has && <MobileNote tone="caveat" mark="·">{METHOD_NOTE}</MobileNote>}
        {table}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex items-center justify-between pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            Nexus node prediction
            {/* Spec 2.4: 44px hit area below `md`, the negative margin giving the
                space back; `md:` restores the bare 16px icon. */}
            <a
              href="/docs/nexus-node.md"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="What a nexus node is"
              title="What a nexus node is"
              className="-my-3.5 -mr-3.5 grid h-11 w-11 shrink-0 place-items-center
                         md:m-0 md:h-4 md:w-4"
            >
              <Info className="h-4 w-4 text-muted-foreground hover:text-primary cursor-pointer" />
            </a>
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3">
          {status ? (
            <p className="text-[12px] leading-relaxed text-muted-foreground">{status}</p>
          ) : (
            <>
              <div className="space-y-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <div><span className="font-medium text-foreground">Baseline</span> · {baselineLine(result!)}</div>
                <div>{scenarioLine(result!)}</div>
                <div>Prepared {prepared ?? '—'}</div>
              </div>
              <TopList label="Nexus materials" rows={materials} />
              <TopList label="Nexus suppliers" rows={suppliers} />
              <Button className="w-full" variant="outline" onClick={() => setOpen(true)}>
                <Table2 className="mr-2 h-4 w-4" />
                Open the stress-test table
              </Button>
              {notes.map((n) => (
                <p key={n} className="text-[11.5px] leading-relaxed text-[#bf2330]">{n}</p>
              ))}
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">{METHOD_NOTE}</p>
            </>
          )}
        </CardContent>
      </Card>
      {table}
    </div>
  );
}

/** The three highest by Average — the card's summary; the dialog holds the rest. */
function TopList({ label, rows }: { label: string; rows: StressRow[] }) {
  const top = rows.slice(0, 3);
  return (
    <div>
      <div className="pb-1 text-xs font-medium text-muted-foreground">
        {label} · {rows.length} ranked by average lost sales
      </div>
      {top.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">None in this project.</p>
      ) : (
        <ul className="space-y-1">
          {top.map((r) => (
            <li key={r.id} className="flex min-w-0 items-baseline justify-between gap-2 text-[12px] leading-snug">
              <span className="min-w-0 truncate font-medium" title={r.id}>{r.rank}. {r.id}</span>
              <span className="whitespace-nowrap tabular-nums">{eur(r.average_eur)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TopMobile({ label, rows }: { label: string; rows: StressRow[] }) {
  return (
    <MobilePanel label={label} counter={String(rows.length)}>
      {rows.slice(0, 3).map((r) => (
        <MobileRow key={r.id} chevron={false} label={`${r.rank}. ${r.id}`}
                   sub={zeroReasonText(r.zero_reason) ?? 'average over the outage durations'}
                   value={eur(r.average_eur)} />
      ))}
      {rows.length === 0 && <MobileRow chevron={false} label="None in this project." />}
    </MobilePanel>
  );
}

function NexusDialog({ open, onOpenChange, result }: {
  open: boolean; onOpenChange: (v: boolean) => void; result: StressResult;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[76%] max-w-5xl overflow-y-auto landscape:max-h-full md:max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Nexus stress test — lost sales by outage duration</DialogTitle>
          <DialogDescription className="space-y-0.5 text-[12px]">
            <span className="block">{baselineLine(result)}</span>
            <span className="block">{scenarioLine(result)}</span>
            {result.summary?.clean_lost_sales_eur?.mean != null && (
              <span className="block">
                Without any disruption the baseline already loses {eur(result.summary.clean_lost_sales_eur.mean)};
                every figure below is the extra loss the outage causes.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="materials">
          <TabsList>
            <TabsTrigger value="materials">Materials ({result.materials?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="suppliers">Suppliers ({result.suppliers?.length ?? 0})</TabsTrigger>
          </TabsList>
          <TabsContent value="materials">
            <StressTable rows={result.materials ?? []} durations={durationsOf(result)} idLabel="Material" />
          </TabsContent>
          <TabsContent value="suppliers">
            <StressTable rows={result.suppliers ?? []} durations={durationsOf(result)} idLabel="Supplier" />
          </TabsContent>
        </Tabs>
        {staleNotes(result).map((n) => (
          <p key={n} className="text-[11.5px] text-[#bf2330]">{n}</p>
        ))}
        <p className="text-[11.5px] text-muted-foreground">{METHOD_NOTE}</p>
      </DialogContent>
    </Dialog>
  );
}

const sameKey = (a: SortKey, b: SortKey) =>
  a.kind === b.kind && (a.kind !== 'duration' || (b.kind === 'duration' && a.weeks === b.weeks));

export function StressTable({ rows, durations, idLabel }: { rows: StressRow[]; durations: number[]; idLabel: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>(DEFAULT_SORT);
  const ordered = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const click = (key: SortKey) =>
    setSort((s) => (sameKey(s.key, key) ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const aria = (key: SortKey) =>
    sameKey(sort.key, key) ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none';
  const mark = (key: SortKey) => (sameKey(sort.key, key) ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '');
  const th = 'border-b border-[--hair-border] px-2 py-1.5 text-[11px] font-medium text-muted-foreground';

  if (rows.length === 0) return <p className="py-3 text-[12px] text-muted-foreground">None in this project.</p>;
  const columns: Array<{ key: SortKey; label: string }> = [
    ...durations.map((w) => ({ key: { kind: 'duration', weeks: w } as SortKey, label: `${w} wk` })),
    { key: { kind: 'average' }, label: 'Average' },
  ];
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse whitespace-nowrap text-[12px]">
          <thead>
            <tr>
              <th aria-sort={aria({ kind: 'rank' })}
                  className={`${th} sticky left-0 z-[1] bg-background text-left`}>
                <button type="button" onClick={() => click({ kind: 'rank' })}>
                  #{mark({ kind: 'rank' })} {idLabel}
                </button>
              </th>
              {columns.map((c) => (
                <th key={c.label} aria-sort={aria(c.key)} className={`${th} text-right`}>
                  <button type="button" onClick={() => click(c.key)}>{c.label}{mark(c.key)}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => {
              const why = zeroReasonText(r.zero_reason);
              return (
                <tr key={r.id} className="hover:bg-[#fcfcfc]">
                  {/* The frozen identifying column (spec §2.7): narrow on a phone, so the
                      zero-reason wraps under the id instead of widening it. */}
                  <td className="sticky left-0 z-[1] max-w-[10.5rem] whitespace-normal border-b border-[--hair-border]
                                 bg-background px-2 py-1.5 text-left md:max-w-none">
                    <span className="text-muted-foreground">{r.rank}.</span>{' '}
                    <span className="font-medium">{r.id}</span>
                    {why && <span className="block text-[10.5px] text-muted-foreground">{why}</span>}
                  </td>
                  {durations.map((w) => (
                    <td key={w} className="border-b border-[--hair-border] px-2 py-1.5 text-right tabular-nums">
                      {eur(r.by_duration[String(w)]?.mean)}
                    </td>
                  ))}
                  <td className="border-b border-[--hair-border] px-2 py-1.5 text-right font-medium tabular-nums">
                    {eur(r.average_eur)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="pt-1 text-[11px] text-muted-foreground md:hidden">
        swipe the table sideways for the remaining columns
      </p>
    </div>
  );
}

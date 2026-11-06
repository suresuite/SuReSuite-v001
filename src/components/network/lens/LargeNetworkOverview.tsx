/**
 * The SUMMARY tab of a large network lens: the same network as counts, breakdowns and a ranking
 * (see `lib/network/scale.ts` for the thresholds and for what this does NOT claim). The network
 * itself is drawn by `LargeGraphCanvas`; this is the second way to read it.
 *
 *   notice        says it is a summary, why, and what the ranking is (T2)
 *   stat strip    nodes, edges, the busiest node, how many hang by a single connection
 *   breakdowns    by class, by the lens's second grouping (country, tier), by connections
 *   ranking       a searchable list of every node, highest first, paged 25 at a time;
 *                 "Focus" hands one node back to the graph at a size it can be read at
 *
 * Presentational: the page owns the graph and the focus; this draws counts it is given.
 */
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  RANK_BASIS,
  breakdown,
  degreeHistogram,
  rankNodes,
  type OverviewNode,
  type RankBy,
} from '@/lib/network/scale';
import { LENS } from './tokens';
import { BarRows, LensCard, type BarRow } from './LensAnalytics';
import type { LegendItem } from './GraphCard';

const PAGE = 25;
const NEUTRAL = '#9a9a9a';
const NEUTRAL_DARK = '#6b6b6b';
const fmt = (n: number) => n.toLocaleString('en-US');

export interface LargeNetworkOverviewProps {
  /** The lens's classes, in flow order, with their colours and counts. */
  legend: LegendItem[];
  nodes: OverviewNode[];
  edgeCount: number;
  /** Name of the lens's own figure (e.g. "Flow", "Revenue"); omit when it has none. */
  weightLabel?: string;
  weightFormat?: (v: number) => string;
  /** Title of the second grouping (e.g. "Country"); omit when the lens has none. */
  secondaryTitle?: string;
  focusedId: string | null;
  onFocus: (id: string) => void;
  onShowGraph: () => void;
}

export function LargeNetworkOverview({
  legend,
  nodes,
  edgeCount,
  weightLabel,
  weightFormat = (v) => fmt(Math.round(v)),
  secondaryTitle,
  focusedId,
  onFocus,
  onShowGraph,
}: LargeNetworkOverviewProps) {
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [by, setBy] = useState<RankBy>('degree');
  const [shown, setShown] = useState(PAGE);

  const color = useMemo(() => new Map(legend.map((l) => [l.key, l.color])), [legend]);
  const label = useMemo(() => new Map(legend.map((l) => [l.key, l.label])), [legend]);

  const byGroup: BarRow[] = useMemo(
    () =>
      legend.map((l) => ({
        key: l.key,
        label: l.label,
        value: nodes.filter((n) => n.group === l.key).length,
        display: fmt(nodes.filter((n) => n.group === l.key).length),
        color: l.color,
      })),
    [legend, nodes],
  );
  const bySecondary: BarRow[] = useMemo(
    () =>
      secondaryTitle
        ? breakdown(nodes, (n) => n.secondary, 10).map((r) => ({
            key: r.key, label: r.key, value: r.count, display: fmt(r.count), color: NEUTRAL_DARK,
          }))
        : [],
    [nodes, secondaryTitle],
  );
  const histogram: BarRow[] = useMemo(
    () => degreeHistogram(nodes).map((r) => ({ key: r.key, label: r.key, value: r.count, display: fmt(r.count), color: NEUTRAL })),
    [nodes],
  );

  const ranked = useMemo(() => rankNodes(nodes, { group, query, by }), [nodes, group, query, by]);
  const maxRank = useMemo(
    () => Math.max(1, ...ranked.slice(0, 1).map((n) => (by === 'weight' ? n.weight ?? 0 : n.degree))),
    [ranked, by],
  );
  const busiest = useMemo(() => nodes.reduce((m, n) => (n.degree > m.degree ? n : m), nodes[0]), [nodes]);
  const single = useMemo(() => nodes.filter((n) => n.degree === 1).length, [nodes]);

  const stat = (k: string, v: string, sub?: string) => (
    <div key={k} className="min-w-0">
      <div className={cn('text-[11px]', LENS.muted)}>{k}</div>
      <div className={cn('font-mono text-[18px] tabular-nums leading-tight', LENS.ink)}>{v}</div>
      {sub && <div className={cn('truncate text-[11px]', LENS.quiet)} title={sub}>{sub}</div>}
    </div>
  );

  return (
    <div className="absolute inset-0 overflow-auto bg-white p-4" data-testid="large-overview">
      <div className={cn('mb-3 flex flex-wrap items-start justify-between gap-3 rounded-[4px] border px-3 py-2', LENS.border)}>
        <p className={cn('min-w-0 flex-1 text-[12px]', LENS.body)}>
          <strong className={LENS.ink}>Large network — summary.</strong>{' '}
          {fmt(nodes.length)} nodes and {fmt(edgeCount)} edges are too many to read as one graph, so this shows
          counts and a ranking instead; focus a node to see its own supply path. {RANK_BASIS}
        </p>
        <button
          type="button"
          onClick={onShowGraph}
          className={cn('flex-none rounded-[4px] border px-2.5 py-1 text-[12px]', LENS.border, LENS.ink, LENS.hoverControl)}
        >
          Show the network
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stat('Nodes', fmt(nodes.length))}
        {stat('Edges', fmt(edgeCount))}
        {stat('Busiest node', busiest ? fmt(busiest.degree) : '—', busiest ? `${busiest.label} · connections` : undefined)}
        {stat('One connection only', fmt(single), nodes.length ? `${Math.round((single / nodes.length) * 100)}% of nodes` : undefined)}
      </div>

      <div className={cn('mb-4 grid gap-4', secondaryTitle ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        <LensCard title="By class" subtitle="Nodes in each class">
          <BarRows rows={byGroup} />
        </LensCard>
        {secondaryTitle && (
          <LensCard title={`By ${secondaryTitle.toLowerCase()}`} subtitle="Largest first; the rest folded into Other">
            <BarRows rows={bySecondary} />
          </LensCard>
        )}
        <LensCard title="Connections per node" subtitle="How many nodes have 0, 1, 2 … connections">
          <BarRows rows={histogram} />
        </LensCard>
      </div>

      <LensCard title="Ranking" subtitle={`${fmt(ranked.length)} of ${fmt(nodes.length)} nodes`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {[{ key: null as string | null, label: 'All' }, ...legend.map((l) => ({ key: l.key, label: l.label }))].map((c) => (
            <button
              key={c.key ?? 'all'}
              type="button"
              aria-pressed={group === c.key}
              onClick={() => { setGroup(c.key); setShown(PAGE); }}
              className={cn(
                'rounded-[4px] border px-2 py-0.5 text-[12px]',
                LENS.border,
                group === c.key ? 'bg-[var(--brand-ink)] text-white' : cn(LENS.ink, LENS.hoverControl),
              )}
            >
              {c.label}
            </button>
          ))}
          <input
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
            placeholder="Search by id or name"
            aria-label="Search nodes"
            className={cn('ml-auto h-7 w-[200px] rounded-[4px] border px-2 text-[12px]', LENS.border, LENS.ink)}
          />
          {weightLabel && (
            <label className={cn('flex items-center gap-1.5 text-[12px]', LENS.muted)}>
              Rank by
              <select
                value={by}
                onChange={(e) => { setBy(e.target.value as RankBy); setShown(PAGE); }}
                className={cn('h-7 rounded-[4px] border bg-white px-1.5 text-[12px]', LENS.border, LENS.ink)}
              >
                <option value="degree">Connections</option>
                <option value="weight">{weightLabel}</option>
              </select>
            </label>
          )}
        </div>

        {ranked.length === 0 ? (
          <p className={cn('py-4 text-center text-[12px]', LENS.muted)}>No node matches.</p>
        ) : (
          <ul className="flex flex-col">
            {ranked.slice(0, shown).map((n, i) => {
              const v = by === 'weight' ? n.weight ?? 0 : n.degree;
              return (
                <li
                  key={n.id}
                  className={cn('flex items-center gap-3 border-t py-1.5 text-[12px]', LENS.hairline, LENS.hoverRow)}
                >
                  <span className={cn('w-8 flex-none text-right font-mono text-[11px] tabular-nums', LENS.quiet)}>{i + 1}</span>
                  <span aria-hidden className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: color.get(n.group) ?? NEUTRAL }} />
                  <span className={cn('w-[180px] flex-none truncate font-mono', LENS.ink)} title={n.label}>{n.label}</span>
                  <span className={cn('hidden w-[110px] flex-none truncate sm:block', LENS.muted)}>{label.get(n.group) ?? n.group}</span>
                  <span className={cn('hidden min-w-0 flex-1 sm:block h-2.5 overflow-hidden rounded-[2px]', LENS.track)}>
                    <span
                      className="block h-full rounded-[2px]"
                      style={{ width: `${Math.max(2, (v / maxRank) * 100)}%`, background: color.get(n.group) ?? NEUTRAL }}
                    />
                  </span>
                  <span className={cn('w-[72px] flex-none text-right font-mono tabular-nums', LENS.body)}>
                    {by === 'weight' ? (n.weight == null ? '—' : weightFormat(n.weight)) : fmt(n.degree)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFocus(n.id)}
                    aria-label={`Focus ${n.label}`}
                    className={cn(
                      'flex-none rounded-[4px] border px-2 py-0.5',
                      LENS.border,
                      focusedId === n.id ? 'bg-[var(--brand-ink)] text-white' : cn(LENS.ink, LENS.hoverControl),
                    )}
                  >
                    Focus
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {ranked.length > shown && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => setShown((s) => s + PAGE)}
              className={cn('rounded-[4px] border px-3 py-1 text-[12px]', LENS.border, LENS.ink, LENS.hoverControl)}
            >
              Show {Math.min(PAGE, ranked.length - shown)} more
            </button>
          </div>
        )}
      </LensCard>
    </div>
  );
}

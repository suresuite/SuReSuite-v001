// The chart components, loaded when a chart is first drawn.
//
// They all draw with recharts (~100 kB gzip with its dependencies), and a person
// opening /policies or /simulation-lab sees no chart until they reach a finished
// run. Importing them from here instead of from their own files keeps recharts out
// of the page's first download; the first chart pays the fetch, behind a placeholder
// of the same footprint. Props and behaviour are the real components' — this file
// only defers them. (`lazyChunk` reloads once if a deploy has replaced the chunk.)
import { Suspense, type ComponentProps } from "react";
import { lazyChunk } from "@/lib/lazyChunk";
import type { ConvergencePlot as ConvergencePlotT } from "./ConvergencePlot";
import type { InventoryOverTime as InventoryOverTimeT } from "./InventoryOverTime";
import type { CapacityOverTime as CapacityOverTimeT } from "./CapacityOverTime";
import type { ReplicationSeedExplorer as ReplicationSeedExplorerT } from "./ReplicationSeedExplorer";
import type { ExperimentResultsPanel as ExperimentResultsPanelT } from "./ExperimentResultsPanel";
import type { ItemCharts as ItemChartsT } from "./inventory/ItemCharts";
import type { WeeklyTraceLines as WeeklyTraceLinesT } from "./WeeklyTraceLines";

function ChartPlaceholder({ height = 200 }: { height?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading chart"
      className="grid h-full w-full place-content-center text-[12px] text-muted-foreground"
      style={{ minHeight: height }}
    >
      Loading chart…
    </div>
  );
}

const ConvergencePlotL = lazyChunk(() => import("./ConvergencePlot").then((m) => ({ default: m.ConvergencePlot })));
const InventoryOverTimeL = lazyChunk(() => import("./InventoryOverTime").then((m) => ({ default: m.InventoryOverTime })));
const CapacityOverTimeL = lazyChunk(() => import("./CapacityOverTime").then((m) => ({ default: m.CapacityOverTime })));
const ReplicationSeedExplorerL = lazyChunk(() =>
  import("./ReplicationSeedExplorer").then((m) => ({ default: m.ReplicationSeedExplorer })),
);
const ExperimentResultsPanelL = lazyChunk(() =>
  import("./ExperimentResultsPanel").then((m) => ({ default: m.ExperimentResultsPanel })),
);
const WeeklyTraceLinesL = lazyChunk(() => import("./WeeklyTraceLines").then((m) => ({ default: m.WeeklyTraceLines })));
const ItemChartsL = lazyChunk(() => import("./inventory/ItemCharts").then((m) => ({ default: m.ItemCharts })));

export function ConvergencePlot(props: ComponentProps<typeof ConvergencePlotT>) {
  return <Suspense fallback={<ChartPlaceholder />}><ConvergencePlotL {...props} /></Suspense>;
}
export function InventoryOverTime(props: ComponentProps<typeof InventoryOverTimeT>) {
  return <Suspense fallback={<ChartPlaceholder height={props.height} />}><InventoryOverTimeL {...props} /></Suspense>;
}
export function CapacityOverTime(props: ComponentProps<typeof CapacityOverTimeT>) {
  return <Suspense fallback={<ChartPlaceholder />}><CapacityOverTimeL {...props} /></Suspense>;
}
export function ReplicationSeedExplorer(props: ComponentProps<typeof ReplicationSeedExplorerT>) {
  return <Suspense fallback={<ChartPlaceholder />}><ReplicationSeedExplorerL {...props} /></Suspense>;
}
export function ExperimentResultsPanel(props: ComponentProps<typeof ExperimentResultsPanelT>) {
  return <Suspense fallback={<ChartPlaceholder />}><ExperimentResultsPanelL {...props} /></Suspense>;
}
export function ItemCharts(props: ComponentProps<typeof ItemChartsT>) {
  return <Suspense fallback={<ChartPlaceholder />}><ItemChartsL {...props} /></Suspense>;
}
export function WeeklyTraceLines(props: ComponentProps<typeof WeeklyTraceLinesT>) {
  return <Suspense fallback={<ChartPlaceholder height={0} />}><WeeklyTraceLinesL {...props} /></Suspense>;
}

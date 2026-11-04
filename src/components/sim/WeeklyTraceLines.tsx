// The line chart inside the Run & Validate "weekly series" panel: one thin line per
// replication, with an optional warm-up marker. Split out of RunValidateStage so the
// page does not carry recharts until a chart is drawn (see lazyCharts.tsx).
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface WeeklyTraceLinesProps {
  /** One row per week: `{ week, r0, r1, … }`. */
  data: Array<Record<string, number>>;
  /** How many `r<i>` columns to draw. */
  traceCount: number;
  warmupWeeks?: number | null;
  /** The warm-up marker's colour (the caller owns the palette). */
  warmupColor: string;
}

export function WeeklyTraceLines({ data, traceCount, warmupWeeks, warmupColor }: WeeklyTraceLinesProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} />
        <XAxis dataKey="week" tick={{ fontSize: 9 }} />
        <YAxis tick={{ fontSize: 9 }} width={36} domain={["auto", "auto"]} />
        <RTooltip contentStyle={{ fontSize: 10 }} />
        {warmupWeeks != null && warmupWeeks > 0 && (
          <ReferenceLine
            x={warmupWeeks}
            stroke={warmupColor}
            strokeDasharray="4 3"
            label={{ value: "warm-up", fontSize: 9, fill: warmupColor }}
          />
        )}
        {Array.from({ length: traceCount }, (_, i) => (
          <Line
            key={i}
            type="monotone"
            dataKey={`r${i}`}
            stroke={`hsl(${(i * 47) % 360} 70% 50%)`}
            strokeWidth={1.2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

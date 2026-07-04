// =============================================================================
// UtilizationChart — Utilization / Timely-Closures concept chart (S7B)
// -----------------------------------------------------------------------------
// Renders the "thin vertical black bars + thin overlay line + one lime
// highlight bar" combo seen in the Overview Panel concept (Utilization and
// Timely Closures cards). Token-driven; switches palette via `data-surface`.
//
// Props
//   data       — array of { x, bar, line, highlight? }
//   height     — pixel height (default 120)
//   highlight  — optional index of bar to colour with `--accent`
// =============================================================================

import * as React from 'react';
import {
  ComposedChart, Bar, Line, XAxis, ResponsiveContainer, Cell, YAxis, Tooltip,
} from 'recharts';

export interface UtilPoint {
  x:    string;
  bar:  number;
  line: number;
}

export interface UtilizationChartProps {
  data:      UtilPoint[];
  /** Index of the bar to fill with --accent (default = last). */
  highlight?: number;
  height?:    number;
  /** Render the trailing-month axis line ("Jun … Jul" labels). */
  axis?:      boolean;
}

export function UtilizationChart({
  data,
  highlight,
  height = 120,
  axis = true,
}: UtilizationChartProps) {
  const hl = highlight ?? data.length - 1;
  return (
    <div style={{ width: '100%', height }} aria-hidden="true">
      <ResponsiveContainer>
        <ComposedChart
          data={data}
          margin={{ top: 4, right: 0, bottom: axis ? 18 : 4, left: 0 }}
          barCategoryGap={1}
        >
          {axis && (
            <XAxis
              dataKey="x"
              axisLine={false}
              tickLine={false}
              interval={Math.max(1, Math.floor(data.length / 6))}
              tick={{
                fontSize: 10,
                fill: 'var(--fg-muted)',
                fontFamily: 'var(--font-sans)',
              }}
              height={16}
            />
          )}
          <YAxis hide domain={[0, 'dataMax + 4']} />
          <Tooltip
            cursor={{ fill: 'color-mix(in oklch, var(--accent) 12%, transparent)' }}
            contentStyle={{
              background:   'var(--surface-elevated)',
              border:       '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              fontSize:     11,
              color:        'var(--fg)',
              boxShadow:    'var(--shadow-popover)',
            }}
            labelStyle={{ color: 'var(--fg-muted)' }}
          />
          <Bar dataKey="bar" radius={[2, 2, 0, 0]} maxBarSize={4}>
            {data.map((_, i) => (
              <Cell key={i} fill={i === hl ? 'var(--accent)' : 'var(--fg)'} />
            ))}
          </Bar>
          <Line
            type="monotone"
            dataKey="line"
            stroke="var(--fg)"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

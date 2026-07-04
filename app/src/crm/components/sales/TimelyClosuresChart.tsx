// =============================================================================
// TimelyClosuresChart — alias of UtilizationChart with a default highlight
// position matching the "Timely Closures" concept tile.
// -----------------------------------------------------------------------------
// Kept as a separate file so call-sites read semantically and so a future
// designer-driven variation can diverge without touching every consumer.
// =============================================================================

import { UtilizationChart, type UtilPoint } from './UtilizationChart';

export interface TimelyClosuresChartProps {
  data:   UtilPoint[];
  height?: number;
  axis?:  boolean;
}

export function TimelyClosuresChart({ data, height, axis }: TimelyClosuresChartProps) {
  // Concept image places the highlight at the right edge.
  const hl = data.length - 1;
  return <UtilizationChart data={data} highlight={hl} height={height} axis={axis} />;
}

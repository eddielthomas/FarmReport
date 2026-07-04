// =============================================================================
// AccountInsightsHero — the frosted-green hero stack (S7B)
// -----------------------------------------------------------------------------
// Wraps `GlassPanel` with the concept's literal copy: "Last month, automation
// boosted your time savings to 48.3 hours." Re-rendered with real data when
// passed `hours` + `period`. The visual stack (front panel + two ghosted
// backplanes) is owned by GlassPanel; this file owns content only.
//
// Props
//   hours   — number of hours saved (default 48.3)
//   period  — short label (default "Last month")
//   onOpen  — top-right arrow click handler
// =============================================================================

import * as React from 'react';
import { GlassPanel } from '@crm/components/ui/glass-panel';
import { Zap } from 'lucide-react';

export interface AccountInsightsHeroProps {
  hours?:  number;
  period?: string;
  onOpen?: () => void;
  className?: string;
}

export function AccountInsightsHero({
  hours = 48.3,
  period = 'Last month',
  onOpen,
  className,
}: AccountInsightsHeroProps) {
  // Format with one decimal, comma-decimal optional. Concept board uses '.'.
  const fmt = Number.isFinite(hours) ? hours.toFixed(1) : '0.0';

  return (
    <GlassPanel
      title={
        <span className="block">
          <span className="font-bold">{period}</span>, automation boosted your time savings to <span className="font-bold">{fmt} hours</span>
        </span>
      }
      kicker={
        <span className="inline-flex items-center gap-1.5">
          <Zap className="size-3.5" />
          <span>Account Insights</span>
        </span>
      }
      stackSize={2}
      onAction={onOpen}
      className={className}
    />
  );
}

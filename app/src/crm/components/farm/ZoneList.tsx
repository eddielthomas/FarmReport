// =============================================================================
// ZoneList — monitoring zones for one farm, each with its intent chips.
// -----------------------------------------------------------------------------
// A zone's `intent` JSON is the monitoring contract the buyer set at onboarding:
// whether water flow is expected, whether standing water is allowed, how much
// vegetation matters, and how sensitive alerting should be. We surface each as a
// labeled chip (never color-alone) so an analyst reads the rule at a glance.
// The kind dot/label reuse FarmMap's intent classification so map and list agree.
// =============================================================================

import * as React from 'react';
import { Droplet, Waves, Leaf, BellRing, Layers } from 'lucide-react';
import { classifyZone, ZONE_KIND, type Zone } from './FarmMap';

// Priority/sensitivity words carry a subtle weight tint — but always with text.
function levelTint(level: string | undefined): string {
  switch ((level ?? '').toLowerCase()) {
    case 'high': return 'var(--risk-stress)';
    case 'medium': return 'var(--risk-watch)';
    case 'low': return 'var(--fg-subtle)';
    default: return 'var(--fg-subtle)';
  }
}

function IntentChip({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: string; tint?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface-sunken)]/60 px-2 py-0.5 text-[11px] text-[var(--fg-muted)]"
      title={`${label}: ${value}`}
    >
      <span className="text-[var(--fg-subtle)]" style={tint ? { color: tint } : undefined}>{icon}</span>
      <span className="text-[var(--fg-subtle)]">{label}</span>
      <span className="font-medium capitalize" style={tint ? { color: tint } : { color: 'var(--fg)' }}>{value}</span>
    </span>
  );
}

export function ZoneList({ zones, onSelect }: { zones: Zone[]; onSelect?: (zone: Zone) => void }) {
  if (zones.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 px-4 py-6 text-center text-[13px] text-[var(--fg-muted)]">
        No monitoring zones defined. Confirm AI-detected zones in onboarding to set each one's intent.
      </div>
    );
  }

  return (
    <ul className="space-y-2.5">
      {zones.map((z) => {
        const kind = classifyZone(z);
        const meta = ZONE_KIND[kind];
        const intent = z.intent ?? {};
        const Row = onSelect ? 'button' : 'div';
        return (
          <li key={z.id}>
            <Row
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(z) } : {})}
              className={`w-full text-left rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3 transition-all duration-[var(--duration-normal)] ease-[var(--easing-spring)] ${
                onSelect ? 'hover:border-[var(--accent)] hover:shadow-[var(--shadow-accent)] cursor-pointer' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="grid place-items-center size-6 rounded-[var(--radius-sm)] shrink-0"
                    style={{ background: `color-mix(in oklch, ${meta.color} 18%, transparent)`, color: meta.color }}
                  >
                    <meta.Icon className="size-3.5" />
                  </span>
                  <span className="font-semibold text-[13px] text-[var(--fg)] truncate">{z.name}</span>
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-[var(--radius-full)] px-2 py-0.5 text-[11px] font-medium shrink-0"
                  style={{ color: meta.color, background: `color-mix(in oklch, ${meta.color} 14%, transparent)` }}
                >
                  {meta.label}
                </span>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <IntentChip
                  icon={<Droplet className="size-3" />}
                  label="Water flow"
                  value={intent.expectedWaterFlow ? 'expected' : 'none'}
                  tint={intent.expectedWaterFlow ? 'var(--cyan)' : undefined}
                />
                <IntentChip
                  icon={<Waves className="size-3" />}
                  label="Standing water"
                  value={intent.standingWaterAllowed ? 'allowed' : 'flag'}
                  tint={intent.standingWaterAllowed ? undefined : 'var(--risk-stress)'}
                />
                {intent.vegetationPriority != null && (
                  <IntentChip
                    icon={<Leaf className="size-3" />}
                    label="Vegetation"
                    value={String(intent.vegetationPriority)}
                    tint={levelTint(String(intent.vegetationPriority))}
                  />
                )}
                {intent.alertSensitivity != null && (
                  <IntentChip
                    icon={<BellRing className="size-3" />}
                    label="Alerts"
                    value={String(intent.alertSensitivity)}
                    tint={levelTint(String(intent.alertSensitivity))}
                  />
                )}
              </div>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

// Re-export so callers can pull the zone shape from one obvious place.
export type { Zone } from './FarmMap';

// Small header helper mirrors the Panel section head in PortfolioDashboard.
export function ZoneListHeader({ count }: { count: number }) {
  return (
    <div className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
      <Layers className="size-3.5" /> {count} zone{count === 1 ? '' : 's'}
    </div>
  );
}

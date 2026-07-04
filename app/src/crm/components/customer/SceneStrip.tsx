// =============================================================================
// SceneStrip — horizontal scene picker for the customer portal hero map.
// -----------------------------------------------------------------------------
// Sprint 14C.  Lives directly under the hero map card.  One scene per card:
//   • brand-gradient swatch on the left (4-stop linear gradient)
//   • title (Urbanist 600 14px)
//   • description (12px muted, truncated)
//   • active dot when this scene is currently displayed
//
// On narrow screens the strip becomes a touch-scrolling row with ≥44 px tap
// targets so it stays usable on phones.  When only one scene exists we still
// show the strip so users see the affordance — when zero we hide entirely
// (parent decides via the early return).
// =============================================================================

import { BRAND_GRADIENTS, type CustomerScene } from '@crm/lib/customer-scenes';
import { cn } from '@crm/lib/utils';

interface SceneStripProps {
  scenes:     CustomerScene[];
  activeId?:  string;
  onPick:     (scene: CustomerScene) => void;
}

export function SceneStrip({ scenes, activeId, onPick }: SceneStripProps) {
  if (!scenes.length) return null;

  return (
    <div
      role="tablist"
      aria-label="Project scenes"
      className={cn(
        'flex gap-2 overflow-x-auto -mx-1 px-1 pb-1',
        // hide WebKit scrollbar so the row reads as a clean rail
        '[&::-webkit-scrollbar]:h-1.5',
        '[&::-webkit-scrollbar-thumb]:bg-[var(--border)] [&::-webkit-scrollbar-thumb]:rounded-full',
        '[scrollbar-width:thin]',
        // touch-scroll on mobile
        '[scroll-snap-type:x_mandatory] sm:[scroll-snap-type:none]',
      )}
      data-coachmark="customer.scenes"
    >
      {scenes.map((s) => {
        const active = s.id === activeId;
        const gradient = BRAND_GRADIENTS[s.basemap_id] ?? BRAND_GRADIENTS.satellite;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(s)}
            className={cn(
              'group flex items-center gap-2.5 shrink-0 min-w-[220px] max-w-[280px]',
              'min-h-[64px] rounded-[var(--radius-lg)] border p-2.5 text-left',
              'bg-[var(--surface)] transition-[border-color,box-shadow,transform] duration-150',
              '[scroll-snap-align:start]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-strong)] focus-visible:ring-offset-2',
              active
                ? 'border-[var(--accent-strong)] shadow-[var(--shadow-card)]'
                : 'border-[var(--border)] hover:border-[var(--accent-strong)]/60 hover:-translate-y-0.5',
            )}
          >
            {/* Brand-gradient swatch */}
            <div
              aria-hidden="true"
              className={cn(
                'w-12 h-12 rounded-[var(--radius-md)] shrink-0',
                'ring-1 ring-inset ring-[var(--border)]',
              )}
              style={{ backgroundImage: gradient }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="text-[14px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] truncate">
                  {s.title || 'Untitled scene'}
                </div>
                {s.is_default && (
                  <span className={cn(
                    'shrink-0 text-[9px] font-semibold uppercase tracking-[var(--tracking-wider)]',
                    'px-1.5 py-0.5 rounded-[var(--radius-full)]',
                    'border border-[var(--border)] bg-[var(--bg)] text-[var(--fg-muted)]',
                  )}>
                    Default
                  </span>
                )}
              </div>
              <div className="text-[12px] text-[var(--fg-muted)] leading-snug line-clamp-2">
                {s.description || s.basemap_id}
              </div>
            </div>
            {active && (
              <div
                aria-hidden="true"
                className={cn(
                  'w-2 h-2 rounded-full shrink-0 self-start mt-1.5',
                  'bg-[var(--accent-strong)] shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_30%,transparent)]',
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Badge — pill / chip primitive (S7A token rewrite)
// -----------------------------------------------------------------------------
// Concept boards show two badge families:
//   * Solid black / accent / white CTA chips.
//   * Bordered status pills ("Hot Client", "Great interest", "Medium interest",
//     "Low interest", "Non interest", "Overdue", "Won").
//
// Variants below mirror that taxonomy. `statusVariant()` is preserved as a
// helper for the legacy lead-status / case-status strings used across pages.
// =============================================================================

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@crm/lib/utils';

const badgeVariants = cva(
  [
    'inline-flex items-center gap-1 whitespace-nowrap',
    'font-sans font-medium tracking-normal',
    'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
  ].join(' '),
  {
    variants: {
      variant: {
        // Solid CTA chips
        solid:        'bg-[var(--fg)] text-[var(--fg-inverted)] border border-transparent',
        accent:       'bg-[var(--accent)] text-[var(--fg-on-accent)] border border-transparent',
        outline:      'bg-transparent text-[var(--fg)] border border-[var(--border-strong)]',
        soft:         'bg-[var(--surface-sunken)] text-[var(--fg)] border border-transparent',

        // Status-tinted (paired with status palette tokens)
        hot:          'bg-transparent text-[var(--red)]    border border-[var(--red)]/40',
        great:        'bg-transparent text-[var(--green)]  border border-[var(--green)]/40',
        medium:       'bg-transparent text-[var(--yellow)] border border-[var(--yellow)]/45',
        low:          'bg-transparent text-[var(--orange)] border border-[var(--orange)]/45',
        non:          'bg-transparent text-[var(--fg-muted)] border border-[var(--border-strong)]',
        won:          'bg-[color-mix(in_oklch,var(--green)_18%,transparent)]  text-[var(--green)] border border-[var(--green)]/40',
        lost:         'bg-[color-mix(in_oklch,var(--red)_18%,transparent)]    text-[var(--red)]   border border-[var(--red)]/40',
        info:         'bg-[color-mix(in_oklch,var(--blue)_18%,transparent)]   text-[var(--blue)]  border border-[var(--blue)]/40',
        success:      'bg-[color-mix(in_oklch,var(--green)_18%,transparent)]  text-[var(--green)] border border-[var(--green)]/40',
        warning:      'bg-[color-mix(in_oklch,var(--yellow)_22%,transparent)] text-[var(--yellow)] border border-[var(--yellow)]/45',
        destructive:  'bg-[color-mix(in_oklch,var(--red)_18%,transparent)]    text-[var(--red)]   border border-[var(--red)]/45',

        // Legacy shadcn names — kept for back-compat with existing pages.
        default:      'bg-[var(--accent)] text-[var(--fg-on-accent)] border border-transparent',
        secondary:    'bg-[var(--surface-sunken)] text-[var(--fg)] border border-transparent',
      },
      size: {
        sm: 'h-5 px-2 text-[10px] rounded-[var(--radius-full)]',
        md: 'h-6 px-2.5 text-[11px] rounded-[var(--radius-full)]',
        lg: 'h-8 px-3.5 text-[12px] rounded-[var(--radius-full)]',
      },
    },
    defaultVariants: { variant: 'soft', size: 'md' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...p }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...p} />;
}

// -----------------------------------------------------------------------------
// statusVariant — map lead / case / priority strings onto the new palette.
// Returns one of the variant keys defined above.
// -----------------------------------------------------------------------------
export function statusVariant(status: string): BadgeProps['variant'] {
  const s = (status ?? '').toLowerCase();
  if (s === 'hot' || s === 'critical' || s === 'overdue')                 return 'hot';
  if (s === 'great' || s === 'high' || s === 'won' || s === 'client')     return 'won';
  if (s === 'medium' || s === 'in_progress' || s === 'assigned')          return 'medium';
  if (s === 'low' || s === 'info request' || s === 'open' || s === 'new') return 'low';
  if (s === 'non' || s === 'non interest' || s === 'archived')            return 'non';
  if (s === 'lost' || s === 'blocked')                                    return 'lost';
  if (s === 'closed')                                                     return 'won';
  if (s === 'lead')                                                       return 'info';
  return 'soft';
}

export { badgeVariants };

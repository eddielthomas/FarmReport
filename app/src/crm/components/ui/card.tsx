// =============================================================================
// Card — surface container primitive (S7A token rewrite)
// -----------------------------------------------------------------------------
// Concept boards show a rounded-2xl white card with a soft drop shadow and a
// 1px hairline border. The card is the universal container for KPIs, tables,
// pipeline columns, etc.
//
// Sub-components: Card, CardHeader, CardTitle, CardDescription, CardContent,
// CardFooter. Spacing tokens chosen to match the generous breathing room in
// the concept boards (--space-5 / 20 px default padding).
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-[var(--radius-2xl)] border border-[var(--border)]',
        'bg-[var(--surface)] text-[var(--fg)]',
        'shadow-[var(--shadow-card)]',
        className,
      )}
      {...p}
    />
  ),
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...p} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...p }, ref) => (
    <h3
      ref={ref}
      className={cn(
        'text-[14px] font-medium tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight',
        className,
      )}
      {...p}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...p }, ref) => (
    <p ref={ref} className={cn('text-[12px] text-[var(--fg-muted)] leading-snug', className)} {...p} />
  ),
);
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, ref) => (
    <div ref={ref} className={cn('p-5 pt-0', className)} {...p} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center gap-2 p-5 pt-3 border-t border-[var(--border)]',
        className,
      )}
      {...p}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

// =============================================================================
// Button — primary primitive (S7A token rewrite)
// -----------------------------------------------------------------------------
// Variants:
//   default     — solid black on light / solid white on dark
//   secondary   — sunken neutral surface
//   outline     — 1px border, transparent bg
//   ghost       — no bg, hover tint
//   destructive — red
//   accent      — signature lime CTA
//   link        — text-only with underline-on-hover
//
// Sizes: xs · sm · md · lg · icon
// Shapes: default (rounded-md) or `rounded=full` pill via prop.
//
// ARIA: native <button> element; consumers should pass aria-label for icon-only
// buttons (`size='icon'`). Focus ring uses `--ring-accent` for accent buttons
// and `--ring` otherwise. All transitions respect `prefers-reduced-motion`
// via the motion duration tokens.
// =============================================================================

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@crm/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-sans font-medium leading-none tracking-normal',
    'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default:     'bg-[var(--fg)] text-[var(--fg-inverted)] hover:bg-[var(--fg)]/90 focus-visible:ring-[var(--ring)]',
        secondary:   'bg-[var(--surface-sunken)] text-[var(--fg)] hover:bg-[var(--surface-sunken)]/80 focus-visible:ring-[var(--ring)]',
        outline:     'border border-[var(--border-strong)] bg-transparent text-[var(--fg)] hover:bg-[var(--surface-sunken)] focus-visible:ring-[var(--ring)]',
        ghost:       'bg-transparent text-[var(--fg)] hover:bg-[var(--surface-sunken)] focus-visible:ring-[var(--ring)]',
        destructive: 'bg-[var(--red)] text-[var(--fg-inverted)] hover:bg-[var(--red)]/90 focus-visible:ring-[var(--red)]',
        accent:      'bg-[var(--accent)] text-[var(--fg-on-accent)] hover:bg-[var(--accent-strong)] focus-visible:ring-[var(--ring-accent)] shadow-[var(--shadow-accent)]',
        link:        'bg-transparent text-[var(--fg)] underline-offset-4 hover:underline focus-visible:ring-[var(--ring)]',
      },
      size: {
        xs:    'h-6  px-2  text-[10px] rounded-[var(--radius-sm)]  [&_svg]:size-3',
        sm:    'h-7  px-2.5 text-[11px] rounded-[var(--radius-md)] [&_svg]:size-3.5',
        md:    'h-9  px-3.5 text-[13px] rounded-[var(--radius-md)]',
        lg:    'h-11 px-5   text-[14px] rounded-[var(--radius-lg)]',
        icon:  'size-9 rounded-[var(--radius-md)]',
      },
      pill: {
        true:  '!rounded-[var(--radius-full)] px-5',
        false: '',
      },
    },
    defaultVariants: { variant: 'default', size: 'md', pill: false },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pill, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref as never}
        className={cn(buttonVariants({ variant, size, pill }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };

// =============================================================================
// Input · Textarea · Label (S7A token rewrite)
// -----------------------------------------------------------------------------
// Two shape options on Input:
//   default — rounded-md, used in forms.
//   variant='search' — rounded-full pill with leading icon support, matching
//     the top-bar "Type Client Name or ID" search seen in the concepts.
//
// All variants consume tokens only — no hex literals.
// =============================================================================

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@crm/lib/utils';

const inputVariants = cva(
  [
    'flex w-full font-sans text-[13px] leading-tight',
    'bg-[var(--surface)] text-[var(--fg)] placeholder:text-[var(--fg-subtle)]',
    'border border-[var(--border)]',
    'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
    'disabled:cursor-not-allowed disabled:opacity-50',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'h-9 px-3 rounded-[var(--radius-md)]',
        search:  'h-10 pl-4 pr-4 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] border-transparent',
        ghost:   'h-9 px-3 rounded-[var(--radius-md)] bg-transparent border-transparent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', variant, ...p }, ref) => (
    <input ref={ref} type={type} className={cn(inputVariants({ variant }), className)} {...p} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...p }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-[var(--radius-md)] border border-[var(--border)]',
        'bg-[var(--surface)] text-[var(--fg)] placeholder:text-[var(--fg-subtle)]',
        'px-3 py-2 text-[13px] leading-snug',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...p}
    />
  ),
);
Textarea.displayName = 'Textarea';

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...p }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-[11px] font-medium tracking-[var(--tracking-wide)] uppercase text-[var(--fg-muted)] cursor-default',
        className,
      )}
      {...p}
    />
  ),
);
Label.displayName = 'Label';

export { inputVariants };

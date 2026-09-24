import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums',
  {
    variants: {
      tone: {
        neutral: 'bg-subtle text-muted',
        accent: 'bg-accent text-accent-ink',
        highlight: 'bg-highlight text-black/85',
        outline: 'border border-line text-faint',
      },
      size: {
        sm: 'min-w-[18px] px-1.5 text-[11px] leading-[18px]',
        md: 'min-w-[22px] px-2 text-[11.5px] leading-[20px]',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ tone, size, className, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

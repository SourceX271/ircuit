import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

const iconButtonVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      size: {
        sm: 'size-6 [&_svg]:size-3.5',
        md: 'size-7 [&_svg]:size-4',
        lg: 'size-8 [&_svg]:size-[18px]',
      },
      tone: {
        ghost: 'text-muted hover:bg-subtle hover:text-ink',
        accent: 'text-accent hover:bg-accent-soft',
      },
    },
    defaultVariants: { size: 'md', tone: 'ghost' },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof iconButtonVariants> {
  /** 无障碍名称；图标按钮必须提供，否则屏幕阅读器读不出来。 */
  label: string;
  children: ReactNode;
}

export function IconButton({ label, size, tone, className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(iconButtonVariants({ size, tone }), className)}
      {...props}
    >
      {children}
    </button>
  );
}

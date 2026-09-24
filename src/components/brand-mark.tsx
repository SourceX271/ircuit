import { Hash } from 'lucide-react';

import { cn } from '@/lib/cn';

/**
 * 应用标识。
 *
 * 用 `#`（IRC 频道符号）而不是抽象图形：一眼能认出这是 IRC 工具，
 * 且在 16px 下依然清晰。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-[7px]',
        'bg-linear-to-br from-accent to-accent-alt',
        'text-accent-ink shadow-[0_1px_2px_rgb(0_0_0/0.18)]',
        className,
      )}
    >
      <Hash className="size-4" strokeWidth={2.75} />
    </span>
  );
}

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  /** 同时作为无障碍名称与悬浮提示。 */
  label: string;
  /** 提供图标时只显示图标，文字转为 `sr-only`。 */
  icon?: ReactNode;
}

export interface SegmentedProps<T extends string> {
  /** 整组控件的无障碍名称。 */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

/**
 * 分段控件。
 *
 * 用 `aria-pressed` 的切换按钮组而不是 radio，是因为这里语义上是「切换视图」
 * 而非表单取值，键盘 Tab 与空格即可完成全部操作。
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex items-center gap-0.5 rounded-md bg-subtle p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11.5px] font-medium transition-colors duration-150 [&_svg]:size-3.5',
              active
                ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
                : 'text-muted hover:text-ink',
            )}
          >
            {option.icon}
            <span className={option.icon ? 'sr-only' : undefined}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

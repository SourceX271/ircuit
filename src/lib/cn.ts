import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并类名：clsx 负责条件拼接，tailwind-merge 负责让后写的同类工具覆盖先写的。
 *
 * 例：`cn('px-2', isWide && 'px-4')` → 结果是 `px-4`，而不是两个 padding 打架。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

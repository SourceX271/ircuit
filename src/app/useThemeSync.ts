import { useEffect } from 'react';

import { applyTheme, resolveTheme, type ResolvedTheme } from '@/lib/theme';
import { useUiStore } from '@/store/ui';

/**
 * 让 DOM 上的主题与 store 保持一致。
 *
 * 单独成 hook 的原因：`system` 模式必须跟随系统实时变化，
 * 而 store 的 setter 只会在用户手动切换时触发。
 *
 * 返回当前生效的外观，供需要区分的组件（例如图表配色）使用。
 */
export function useThemeSync(): ResolvedTheme {
  const themeMode = useUiStore((state) => state.themeMode);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const sync = () => {
      applyTheme(document.documentElement, resolveTheme(themeMode, media.matches));
    };

    sync();

    if (themeMode !== 'system') return;

    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themeMode]);

  return resolveTheme(themeMode, window.matchMedia('(prefers-color-scheme: dark)').matches);
}

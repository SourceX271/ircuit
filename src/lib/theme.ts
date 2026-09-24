/**
 * 主题解析与持久化。
 *
 * 这里刻意只放纯函数与最小的 DOM 副作用，方便单测覆盖；
 * 「跟随系统」的监听放在 React 层（见 `@/app/useThemeSync`）。
 */

/** 用户可选的三种外观模式。 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 实际应用到 DOM 的两种外观。 */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ircuit.theme';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** 把系统偏好与用户选择合成为最终外观。 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** 读取已保存的外观模式；未保存或值非法时回退到「跟随系统」。 */
export function readStoredTheme(storage: Pick<Storage, 'getItem'>): ThemeMode {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(raw) ? raw : 'system';
}

export function persistTheme(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): void {
  storage.setItem(THEME_STORAGE_KEY, mode);
}

/**
 * 把外观写到 `<html>` 上。
 *
 * 只切一个 class，所有颜色由 CSS 变量接管，因此不存在「逐个组件改样式」的问题。
 */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.classList.toggle('dark', theme === 'dark');
}

/** 在浏览器当前状态下，该模式对应的最终外观。 */
export function resolveCurrentTheme(
  mode: ThemeMode,
  matchMedia: (query: string) => Pick<MediaQueryList, 'matches'> = (query) =>
    window.matchMedia(query),
): ResolvedTheme {
  return resolveTheme(mode, matchMedia('(prefers-color-scheme: dark)').matches);
}

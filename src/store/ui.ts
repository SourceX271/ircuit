import { create } from 'zustand';

import i18n, { type Language, persistLanguage, readStoredLanguage } from '@/i18n';
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  resolveCurrentTheme,
  type ThemeMode,
} from '@/lib/theme';

/**
 * 界面偏好（外观、语言）。
 *
 * 只放「与后端无关的界面状态」。网络、buffer、消息等状态在 M1/M2 由
 * Rust 核心推送后建立，不放在这里。
 */
export interface UiState {
  themeMode: ThemeMode;
  language: Language;
  setThemeMode: (mode: ThemeMode) => void;
  setLanguage: (language: Language) => void;
}

export const useUiStore = create<UiState>((set) => ({
  themeMode: readStoredTheme(window.localStorage),
  language: readStoredLanguage(window.localStorage),

  setThemeMode: (mode) => {
    persistTheme(window.localStorage, mode);
    // 立刻落地，避免等 React 重渲染才变色。
    applyTheme(document.documentElement, resolveCurrentTheme(mode));
    set({ themeMode: mode });
  },

  setLanguage: (language) => {
    persistLanguage(window.localStorage, language);
    void i18n.changeLanguage(language);
    set({ language });
  },
}));

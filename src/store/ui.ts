import { create } from 'zustand';

import i18n, { type Language, persistLanguage, readStoredLanguage } from '@/i18n';
import {
  COLLAPSED_NETWORKS_KEY,
  parseNetworkIds,
  persistJson,
  persistMembersOpen,
  persistSendOnEnter,
  persistSidebarOpen,
  readStoredJson,
  readStoredMembersOpen,
  readStoredSendOnEnter,
  readStoredSidebarOpen,
} from '@/lib/prefs';
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  resolveCurrentTheme,
  type ThemeMode,
} from '@/lib/theme';

/**
 * 界面偏好（外观、语言、布局、输入习惯）。
 *
 * 只放「与后端无关的界面状态」。网络、buffer、消息等状态在 M1/M2 由
 * Rust 核心推送后建立，不放在这里。
 */
export interface UiState {
  themeMode: ThemeMode;
  language: Language;
  /** 按 Enter 直接发送；关闭后 Enter 换行，需要 Ctrl/Cmd + Enter 才发送。 */
  sendOnEnter: boolean;
  /** 左侧网络/频道栏是否展开。 */
  sidebarOpen: boolean;
  /** 右侧成员栏是否展开。 */
  membersOpen: boolean;
  /** 命令面板是否打开。不持久化：没有人希望启动时面板是开着的。 */
  paletteOpen: boolean;
  /** 新建连接的对话框是否打开。同样不持久化。 */
  connectionDialogOpen: boolean;
  /** 会话树里被折叠起来的网络。折叠状态持久化：它表达的是布局偏好。 */
  collapsedNetworks: string[];

  setThemeMode: (mode: ThemeMode) => void;
  setLanguage: (language: Language) => void;
  setSendOnEnter: (value: boolean) => void;
  toggleSidebar: () => void;
  toggleMembers: () => void;
  toggleNetworkCollapsed: (networkId: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setConnectionDialogOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  themeMode: readStoredTheme(window.localStorage),
  language: readStoredLanguage(window.localStorage),
  sendOnEnter: readStoredSendOnEnter(window.localStorage),
  sidebarOpen: readStoredSidebarOpen(window.localStorage),
  membersOpen: readStoredMembersOpen(window.localStorage),
  paletteOpen: false,
  connectionDialogOpen: false,
  collapsedNetworks: readStoredJson(
    window.localStorage,
    COLLAPSED_NETWORKS_KEY,
    parseNetworkIds,
    [],
  ),

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

  setSendOnEnter: (value) => {
    persistSendOnEnter(window.localStorage, value);
    set({ sendOnEnter: value });
  },

  toggleSidebar: () => {
    const value = !get().sidebarOpen;
    persistSidebarOpen(window.localStorage, value);
    set({ sidebarOpen: value });
  },

  toggleMembers: () => {
    const value = !get().membersOpen;
    persistMembersOpen(window.localStorage, value);
    set({ membersOpen: value });
  },

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  setConnectionDialogOpen: (open) => set({ connectionDialogOpen: open }),

  toggleNetworkCollapsed: (networkId) => {
    const current = get().collapsedNetworks;

    const next = current.includes(networkId)
      ? current.filter((id) => id !== networkId)
      : [...current, networkId];

    persistJson(window.localStorage, COLLAPSED_NETWORKS_KEY, next);
    set({ collapsedNetworks: next });
  },
}));

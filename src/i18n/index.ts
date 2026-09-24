import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_STORAGE_KEY = 'ircuit.language';

export const DEFAULT_LANGUAGE: Language = 'zh-CN';

export const LANGUAGE_LABELS: Record<Language, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 把任意语言标记归一到受支持的语言。
 *
 * 只按主语言匹配，因此 `zh`、`zh-Hans`、`zh-Hant` 都会落到简体中文，
 * 中文网络里的用户不会因为 locale 写得粗略而看到英文界面。
 */
export function detectLanguage(candidate: string | null | undefined): Language {
  if (!candidate) return DEFAULT_LANGUAGE;

  const lower = candidate.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';

  return DEFAULT_LANGUAGE;
}

export function readStoredLanguage(storage: Pick<Storage, 'getItem'>): Language {
  const raw = storage.getItem(LANGUAGE_STORAGE_KEY);
  return isLanguage(raw) ? raw : detectLanguage(globalThis.navigator?.language);
}

export function persistLanguage(storage: Pick<Storage, 'setItem'>, language: Language): void {
  storage.setItem(LANGUAGE_STORAGE_KEY, language);
}

export const resources = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLanguage(window.localStorage),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: {
    // React 本身就会转义，i18next 再转一次会把中文标点变成实体。
    escapeValue: false,
  },
});

export default i18n;

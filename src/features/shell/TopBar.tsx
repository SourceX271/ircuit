import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BrandMark } from '@/components/brand-mark';
import { Badge } from '@/components/ui/badge';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '@/i18n';
import { THEME_MODES, type ThemeMode } from '@/lib/theme';
import { useUiStore } from '@/store/ui';

const THEME_ICONS: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function TopBar() {
  const { t } = useTranslation();

  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);
  const language = useUiStore((state) => state.language);
  const setLanguage = useUiStore((state) => state.setLanguage);

  const themeOptions: SegmentedOption<ThemeMode>[] = THEME_MODES.map((mode) => {
    const Icon = THEME_ICONS[mode];
    return { value: mode, label: t(`theme.${mode}`), icon: <Icon /> };
  });

  const languageOptions: SegmentedOption<Language>[] = SUPPORTED_LANGUAGES.map((value) => ({
    value,
    label: LANGUAGE_LABELS[value],
  }));

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark />
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-[14px] font-semibold tracking-tight text-ink">{t('app.name')}</h1>
          <span className="hidden truncate text-[11.5px] text-faint sm:inline">
            {t('app.tagline')}
          </span>
        </div>
        <Badge tone="outline" size="md" className="ml-1 hidden md:inline-flex">
          {t('shell.milestone')}
        </Badge>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Segmented
          label={t('theme.label')}
          value={themeMode}
          options={themeOptions}
          onChange={setThemeMode}
        />
        <Segmented
          label={t('language.label')}
          value={language}
          options={languageOptions}
          onChange={setLanguage}
        />
      </div>
    </header>
  );
}

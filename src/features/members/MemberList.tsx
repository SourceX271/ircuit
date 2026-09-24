import { useTranslation } from 'react-i18next';

/**
 * Placeholder for the member list.
 *
 * Membership tracking — NAMES, WHO, prefixes, away state — is part of the
 * channel model in M2. Showing a fabricated list here would be worse than
 * showing none, so this states plainly what is missing.
 */
export function MemberList() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-baseline gap-2 px-3 py-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {t('members.title')}
        </h2>
      </header>

      <p className="px-3 text-[11.5px] text-faint">{t('members.unavailable')}</p>
    </div>
  );
}

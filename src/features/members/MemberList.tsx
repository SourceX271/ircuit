import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import { useSessionStore } from '@/store/session';

/** Colour of the prefix glyph, by privilege. */
const PREFIX_TONE: Record<string, string> = {
  '~': 'text-warning',
  '&': 'text-warning',
  '%': 'text-warning',
  '@': 'text-accent',
  '+': 'text-success',
};

/** Human-readable name for a prefix character. */
const PREFIX_LABEL: Record<string, string> = {
  '~': 'members.prefix.owner',
  '&': 'members.prefix.admin',
  '%': 'members.prefix.halfop',
  '@': 'members.prefix.op',
  '+': 'members.prefix.voice',
};

/**
 * The member list for the channel on screen.
 *
 * Reads the channel snapshot out of the store; the backend has already sorted
 * members by privilege and folded nicknames using the server's own rules, so
 * there is nothing to recompute here.
 */
export function MemberList() {
  const { t } = useTranslation();

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const channels = useSessionStore((state) => state.channels);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;
  const channel = activeBufferId ? (channels[activeBufferId] ?? null) : null;

  // Only a channel has members. A query shows the other person, the server
  // buffer shows nobody.
  if (!buffer || buffer.kind !== 'channel') {
    return (
      <Shell title={t('members.title')}>
        <p className="px-3 text-[11.5px] text-faint">{t('members.notAChannel')}</p>
      </Shell>
    );
  }

  if (!channel || !channel.names_received) {
    return (
      <Shell title={t('members.title')}>
        <p className="px-3 text-[11.5px] text-faint">{t('members.loading')}</p>
      </Shell>
    );
  }

  return (
    <Shell title={t('members.title')} count={channel.members.length}>
      <ul className="flex-1 overflow-y-auto px-1.5 pb-2">
        {channel.members.map((member) => (
          <li
            key={member.nick}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[13px]',
              'transition-colors duration-150 hover:bg-sidebar-hover',
              member.away ? 'text-faint' : 'text-muted hover:text-ink',
            )}
            title={member.away ? t('members.away') : member.nick}
          >
            {member.prefix ? (
              <span
                className={cn(
                  'w-2 shrink-0 font-mono text-[12px] font-bold',
                  PREFIX_TONE[member.prefix] ?? 'text-faint',
                )}
                title={t(PREFIX_LABEL[member.prefix] ?? 'members.prefix.op')}
              >
                {member.prefix}
              </span>
            ) : (
              <span aria-hidden className="w-2 shrink-0" />
            )}

            <span className={cn('min-w-0 flex-1 truncate', member.away && 'italic')}>
              {member.nick}
            </span>

            {member.account ? (
              <span
                aria-hidden
                className="size-1 shrink-0 rounded-full bg-success"
                title={t('members.identified')}
              />
            ) : null}
            {member.away ? (
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-faint" />
            ) : null}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Shell({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-baseline gap-2 px-3 py-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {title}
        </h2>
        {count !== undefined ? (
          <span className="text-[11px] tabular-nums text-faint">
            {t('members.count', { count })}
          </span>
        ) : null}
      </header>
      {children}
    </div>
  );
}

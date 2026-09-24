import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import type { PlaceholderMember } from '@/data/placeholder';

const PREFIX_ORDER: Record<PlaceholderMember['prefix'], number> = {
  '~': 0,
  '&': 1,
  '@': 2,
  '+': 3,
  '': 4,
};

const PREFIX_TONE: Record<Exclude<PlaceholderMember['prefix'], ''>, string> = {
  '~': 'text-warning',
  '&': 'text-warning',
  '@': 'text-accent',
  '+': 'text-success',
};

const PREFIX_LABEL_KEY = {
  '~': 'members.owner',
  '&': 'members.admin',
  '@': 'members.op',
  '+': 'members.voice',
} as const;

/** 先按权限前缀，再按昵称字典序 —— 与 IRC 客户端的习惯顺序一致。 */
function sortMembers(members: readonly PlaceholderMember[]): PlaceholderMember[] {
  return [...members].sort((left, right) => {
    const byPrefix = PREFIX_ORDER[left.prefix] - PREFIX_ORDER[right.prefix];
    if (byPrefix !== 0) return byPrefix;
    return left.nick.localeCompare(right.nick);
  });
}

function MemberRow({ member }: { member: PlaceholderMember }) {
  const { t } = useTranslation();

  return (
    <li
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[13px]',
        'transition-colors duration-150 hover:bg-sidebar-hover',
        member.away ? 'text-faint' : 'text-muted hover:text-ink',
      )}
      title={member.away ? t('members.away') : member.nick}
    >
      {member.prefix ? (
        <span
          className={cn('w-2 shrink-0 font-mono text-[12px] font-bold', PREFIX_TONE[member.prefix])}
          title={t(PREFIX_LABEL_KEY[member.prefix])}
        >
          {member.prefix}
        </span>
      ) : (
        <span aria-hidden className="w-2 shrink-0" />
      )}

      <span className={cn('min-w-0 flex-1 truncate', member.away && 'italic')}>{member.nick}</span>

      {member.away ? <span aria-hidden className="size-1 shrink-0 rounded-full bg-faint" /> : null}
    </li>
  );
}

export function MemberList({ members }: { members: PlaceholderMember[] }) {
  const { t } = useTranslation();
  const sorted = sortMembers(members);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-baseline gap-2 px-3 py-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {t('members.title')}
        </h2>
        <span className="text-[11px] tabular-nums text-faint">
          {t('members.count', { count: sorted.length })}
        </span>
      </header>

      <ul className="flex-1 overflow-y-auto px-1.5 pb-2">
        {sorted.map((member) => (
          <MemberRow key={member.nick} member={member} />
        ))}
      </ul>
    </div>
  );
}

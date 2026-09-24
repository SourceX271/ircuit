import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ContextMenu, type MenuItem } from '@/components/ui/context-menu';
import { cn } from '@/lib/cn';
import { banUser, kickUser, setMemberMode, whois, type MemberInfo } from '@/lib/ipc';
import { isIgnored, useSessionStore } from '@/store/session';

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

/** Prefixes that may kick and ban. Voice does not count. */
const MODERATOR_PREFIXES = new Set(['~', '&', '%', '@']);

export function MemberList() {
  const { t } = useTranslation();

  const [menu, setMenu] = useState<{ x: number; y: number; member: MemberInfo } | null>(null);

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const channels = useSessionStore((state) => state.channels);
  const networks = useSessionStore((state) => state.networks);
  const ignored = useSessionStore((state) => state.ignored);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;
  const channel = activeBufferId ? (channels[activeBufferId] ?? null) : null;
  const networkId = buffer?.networkId ?? null;
  const selfNick = networks.find((network) => network.id === networkId)?.nick ?? null;

  const ignoredForNetwork = (networkId !== null && ignored[networkId]) || [];

  const items = useMemo<MenuItem[]>(() => {
    if (!menu || !buffer || buffer.kind !== 'channel' || networkId === null) return [];

    const { member } = menu;
    const lowerNick = member.nick.toLowerCase();
    const isSelf = selfNick !== null && lowerNick === selfNick.toLowerCase();

    // Only an operator may moderate, and the server enforces that anyway.
    // Offering a command that is certain to be refused is just noise.
    const self = channel?.members.find(
      (candidate) => selfNick !== null && candidate.nick.toLowerCase() === selfNick.toLowerCase(),
    );
    const selfPrefix = self?.prefix ?? null;
    const canModerate = selfPrefix !== null && MODERATOR_PREFIXES.has(selfPrefix);
    const canKickOrBan = canModerate && !isSelf;

    const isOp = member.prefix === '@' || member.prefix === '~' || member.prefix === '&';
    const isVoiced = member.prefix === '+';

    const run = (action: () => Promise<void>) => () => {
      void action().catch((error: unknown) => {
        console.error('[ircuit] 成员操作失败', error);
      });
    };

    return [
      {
        id: 'whois',
        label: t('members.actions.whois'),
        onSelect: run(() => whois(networkId, member.nick)),
      },
      {
        id: 'query',
        label: t('members.actions.query'),
        disabled: isSelf,
        onSelect: () => useSessionStore.getState().openQuery(networkId, member.nick),
      },
      {
        id: 'op',
        label: isOp ? t('members.actions.deop') : t('members.actions.op'),
        separatorBefore: true,
        disabled: !canModerate,
        onSelect: run(() => setMemberMode(networkId, buffer.target, member.nick, 'o', !isOp)),
      },
      {
        id: 'voice',
        label: isVoiced ? t('members.actions.devoice') : t('members.actions.voice'),
        disabled: !canModerate,
        onSelect: run(() => setMemberMode(networkId, buffer.target, member.nick, 'v', !isVoiced)),
      },
      {
        id: 'kick',
        label: t('members.actions.kick'),
        separatorBefore: true,
        danger: true,
        disabled: !canKickOrBan,
        onSelect: run(() => kickUser(networkId, buffer.target, member.nick, null)),
      },
      {
        id: 'ban',
        label: t('members.actions.ban'),
        danger: true,
        disabled: !canKickOrBan,
        onSelect: run(() => banUser(networkId, buffer.target, member.nick)),
      },
      {
        id: 'ignore',
        label: isIgnored(ignoredForNetwork, member.nick)
          ? t('members.actions.unignore')
          : t('members.actions.ignore'),
        separatorBefore: true,
        disabled: isSelf,
        onSelect: () => useSessionStore.getState().toggleIgnored(networkId, member.nick),
      },
    ];
  }, [buffer, channel, ignoredForNetwork, menu, networkId, selfNick, t]);

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

  const openMenu = (event: MouseEvent, member: MemberInfo) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, member });
  };

  return (
    <>
      <Shell title={t('members.title')} count={channel.members.length}>
        <ul className="flex-1 overflow-y-auto px-1.5 pb-2">
          {channel.members.map((member) => (
            <MemberRow
              key={member.nick}
              member={member}
              muted={isIgnored(ignoredForNetwork, member.nick)}
              onContextMenu={(event) => openMenu(event, member)}
            />
          ))}
        </ul>
      </Shell>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}

function MemberRow({
  member,
  muted,
  onContextMenu,
}: {
  member: MemberInfo;
  muted: boolean;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const { t } = useTranslation();

  return (
    <li>
      <button
        type="button"
        onContextMenu={onContextMenu}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-[3px] text-left text-[13px]',
          'transition-colors duration-150 hover:bg-sidebar-hover',
          member.away || muted ? 'text-faint' : 'text-muted hover:text-ink',
          muted && 'line-through',
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
      </button>
    </li>
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

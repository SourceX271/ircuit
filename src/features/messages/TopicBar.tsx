import { Hash, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import type { ConnectionState } from '@/lib/ipc';
import type { SessionBuffer } from '@/store/session';

const STATE_DOT: Record<ConnectionState, string> = {
  connecting: 'animate-pulse bg-warning',
  connected: 'bg-warning',
  registered: 'bg-success',
  disconnected: 'bg-faint',
};

export interface TopicBarProps {
  buffer: SessionBuffer | null;
  networkName: string | null;
  state: ConnectionState | null;
}

/**
 * The strip above the message list.
 *
 * For now it carries the buffer identity and connection state. The real channel
 * topic arrives with the channel model in M2; showing a fake one would be worse
 * than showing none.
 */
export function TopicBar({ buffer, networkName, state }: TopicBarProps) {
  const { t } = useTranslation();

  const isServer = buffer === null || buffer.kind === 'server';

  const title = !buffer
    ? t('app.name')
    : isServer
      ? (networkName ?? t('sidebar.server'))
      : buffer.target;

  const hint = !buffer
    ? t('network.title')
    : isServer
      ? t('topic.serverBuffer')
      : t('topic.channelHint');

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-topicbar px-3">
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-ink">
        {buffer && buffer.kind === 'channel' ? (
          <Hash className="size-3.5 text-faint" strokeWidth={2.5} />
        ) : null}
        {isServer && buffer ? <Server className="size-3.5 text-faint" strokeWidth={2.5} /> : null}
        <span className="max-w-[28ch] truncate">{title}</span>
      </span>

      {state ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span aria-hidden className={cn('size-1.5 rounded-full', STATE_DOT[state])} />
          <span className="text-[11px] text-faint">{t(`network.state.${state}`)}</span>
        </span>
      ) : null}

      <span aria-hidden className="text-line-strong">
        |
      </span>

      <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={hint}>
        {hint}
      </p>
    </div>
  );
}

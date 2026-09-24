import { Hash, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import type { ConnectionState } from '@/lib/ipc';
import { useSessionStore, type SessionBuffer } from '@/store/session';

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
 * The strip above the message list: which buffer, what the channel's topic is,
 * and how the connection is doing.
 */
export function TopicBar({ buffer, networkName, state }: TopicBarProps) {
  const { t } = useTranslation();

  // Only channels carry a topic and modes; the server buffer and queries do not.
  const channel = useSessionStore((store) =>
    buffer && buffer.kind === 'channel' ? (store.channels[buffer.id] ?? null) : null,
  );

  const isServer = buffer === null || buffer.kind === 'server';

  const title = !buffer
    ? t('app.name')
    : isServer
      ? (networkName ?? t('sidebar.server'))
      : buffer.target;

  const subtitle = (() => {
    if (!buffer) return t('network.title');
    if (isServer) return t('topic.serverBuffer');
    if (buffer.kind === 'channel') return channel?.topic ?? t('topic.noTopic');
    return buffer.target;
  })();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-topicbar px-3">
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-ink">
        {buffer && buffer.kind === 'channel' ? (
          <Hash className="size-3.5 text-faint" strokeWidth={2.5} />
        ) : null}
        {isServer && buffer ? <Server className="size-3.5 text-faint" strokeWidth={2.5} /> : null}
        <span className="max-w-[28ch] truncate">{title}</span>
      </span>

      {channel && channel.modes ? (
        <span
          className="shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
          title={t('topic.modes')}
        >
          {channel.modes}
        </span>
      ) : null}

      {state ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span aria-hidden className={cn('size-1.5 rounded-full', STATE_DOT[state])} />
          <span className="text-[11px] text-faint">{t(`network.state.${state}`)}</span>
        </span>
      ) : null}

      <span aria-hidden className="text-line-strong">
        |
      </span>

      <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted" title={subtitle}>
        {subtitle}
      </p>
    </div>
  );
}

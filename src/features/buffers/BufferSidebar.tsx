import { Hash, Plus, Power, Server, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { disconnectNetwork, type ConnectionState } from '@/lib/ipc';
import { useSessionStore, type SessionBuffer } from '@/store/session';

/** Colour of the per-network status dot. */
const STATE_DOT: Record<ConnectionState, string> = {
  connecting: 'animate-pulse bg-warning',
  connected: 'bg-warning',
  registered: 'bg-success',
  disconnected: 'bg-faint',
};

const BUFFER_ICONS = {
  server: Server,
  channel: Hash,
  query: User,
} as const;

/** Server buffer first, then channels, then conversations. */
const KIND_ORDER: Record<SessionBuffer['kind'], number> = {
  server: 0,
  channel: 1,
  query: 2,
};

function BufferRow({ buffer }: { buffer: SessionBuffer }) {
  const { t } = useTranslation();

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const selectBuffer = useSessionStore((state) => state.selectBuffer);

  const active = buffer.id === activeBufferId;
  const Icon = BUFFER_ICONS[buffer.kind];
  const label = buffer.kind === 'server' ? t('sidebar.server') : buffer.target;

  return (
    <button
      type="button"
      onClick={() => selectBuffer(buffer.id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-md py-[5px] pl-2.5 pr-2 text-left',
        'transition-colors duration-150',
        active ? 'bg-sidebar-active text-ink' : 'text-muted hover:bg-sidebar-hover hover:text-ink',
      )}
    >
      {/* A slim accent bar reads as "current" without washing out the text. */}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full transition-opacity',
          active ? 'bg-accent opacity-100' : 'opacity-0',
        )}
      />
      <Icon
        className={cn('size-3.5 shrink-0', active ? 'text-accent' : 'text-faint')}
        strokeWidth={2.25}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px]',
          buffer.highlight && !active ? 'font-semibold text-ink' : undefined,
        )}
      >
        {label}
      </span>
      {buffer.unread > 0 ? (
        <Badge tone={buffer.highlight ? 'highlight' : 'neutral'}>{buffer.unread}</Badge>
      ) : null}
    </button>
  );
}

function NetworkGroup({ networkId }: { networkId: string }) {
  const { t } = useTranslation();

  const network = useSessionStore((state) =>
    state.networks.find((candidate) => candidate.id === networkId),
  );
  const buffers = useSessionStore((state) => state.buffers);
  const removeNetwork = useSessionStore((state) => state.removeNetwork);

  if (!network) return null;

  const owned = buffers
    .filter((buffer) => buffer.networkId === networkId)
    .sort((left, right) => {
      const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
      return byKind !== 0 ? byKind : left.target.localeCompare(right.target);
    });

  const onDisconnect = () => {
    void disconnectNetwork(networkId)
      .then(() => removeNetwork(networkId))
      .catch((error: unknown) => {
        console.error('[ircuit] 断开连接失败', error);
      });
  };

  return (
    <section className="mb-3">
      <header className="group flex items-center gap-2 px-2.5 py-1">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT[network.state])}
        />
        <h2 className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {network.name}
        </h2>
        <IconButton
          label={t('sidebar.disconnect')}
          size="sm"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onDisconnect}
        >
          <Power />
        </IconButton>
      </header>

      <div className="flex flex-col gap-px px-1.5">
        {owned.map((buffer) => (
          <BufferRow key={buffer.id} buffer={buffer} />
        ))}
      </div>
    </section>
  );
}

export interface BufferSidebarProps {
  onAddNetwork: () => void;
}

export function BufferSidebar({ onAddNetwork }: BufferSidebarProps) {
  const { t } = useTranslation();
  const networks = useSessionStore((state) => state.networks);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {t('sidebar.networks')}
        </span>
        <IconButton label={t('sidebar.addNetwork')} size="sm" onClick={onAddNetwork}>
          <Plus />
        </IconButton>
      </div>

      <nav aria-label={t('sidebar.bufferActions')} className="flex-1 overflow-y-auto pb-3">
        {networks.map((network) => (
          <NetworkGroup key={network.id} networkId={network.id} />
        ))}
      </nav>
    </aside>
  );
}

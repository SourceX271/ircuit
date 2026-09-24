import { Hash, Lock, Plus, Server, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import type { PlaceholderBuffer, PlaceholderNetwork } from '@/data/placeholder';
import { useShellStore } from '@/store/shell';

const BUFFER_ICONS = {
  server: Server,
  channel: Hash,
  query: User,
} as const;

function BufferRow({
  buffer,
  active,
  onSelect,
}: {
  buffer: PlaceholderBuffer;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = BUFFER_ICONS[buffer.kind];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-md py-[5px] pl-2.5 pr-2 text-left',
        'transition-colors duration-150',
        active ? 'bg-sidebar-active text-ink' : 'text-muted hover:bg-sidebar-hover hover:text-ink',
      )}
    >
      {/* 当前 buffer 的强调条：比整行高亮更克制，也不影响文字对比度 */}
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
        {buffer.name}
      </span>
      {buffer.unread > 0 ? (
        <Badge tone={buffer.highlight ? 'highlight' : 'neutral'}>{buffer.unread}</Badge>
      ) : null}
    </button>
  );
}

function NetworkGroup({
  network,
  activeBufferId,
  onSelect,
}: {
  network: PlaceholderNetwork;
  activeBufferId: string;
  onSelect: (bufferId: string) => void;
}) {
  return (
    <section className="mb-3">
      <header className="flex items-center gap-2 px-2.5 py-1">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            network.connected ? 'bg-success' : 'bg-faint',
          )}
        />
        <h2 className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {network.name}
        </h2>
        {network.connected ? <Lock className="size-3 text-faint" strokeWidth={2.25} /> : null}
      </header>

      <div className="flex flex-col gap-px px-1.5">
        {network.buffers.map((buffer) => (
          <BufferRow
            key={buffer.id}
            buffer={buffer}
            active={buffer.id === activeBufferId}
            onSelect={() => onSelect(buffer.id)}
          />
        ))}
      </div>
    </section>
  );
}

export function BufferSidebar() {
  const { t } = useTranslation();

  const networks = useShellStore((state) => state.networks);
  const activeBufferId = useShellStore((state) => state.activeBufferId);
  const selectBuffer = useShellStore((state) => state.selectBuffer);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {t('sidebar.networks')}
        </span>
        <IconButton label={t('sidebar.addNetwork')} size="sm">
          <Plus />
        </IconButton>
      </div>

      <nav aria-label={t('sidebar.bufferActions')} className="flex-1 overflow-y-auto pb-3">
        {networks.map((network) => (
          <NetworkGroup
            key={network.id}
            network={network}
            activeBufferId={activeBufferId}
            onSelect={selectBuffer}
          />
        ))}
      </nav>
    </aside>
  );
}

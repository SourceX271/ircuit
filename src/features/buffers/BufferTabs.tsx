import { Hash, Server, User, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import { orderedBuffers, useSessionStore, type SessionBuffer } from '@/store/session';

import { closeSessionBuffer } from './actions';

/**
 * The tab strip above the message pane.
 *
 * The sidebar and this bar answer different questions: the sidebar is "what
 * exists", the strip is "what am I juggling right now, in the order I expect".
 * Ten channels on three networks is exactly the point at which the tree stops
 * being enough on its own.
 *
 * The order comes from `orderedBuffers`, the same function the sidebar and the
 * Ctrl+PageDown shortcut use — a strip that disagreed with either would be worse
 * than no strip.
 */

const TAB_ICONS = {
  server: Server,
  channel: Hash,
  query: User,
} as const;

function Tab({ buffer }: { buffer: SessionBuffer }) {
  const { t } = useTranslation();

  const active = useSessionStore((state) => state.activeBufferId === buffer.id);
  const selectBuffer = useSessionStore((state) => state.selectBuffer);
  const networkName = useSessionStore(
    (state) => state.networks.find((network) => network.id === buffer.networkId)?.name ?? '',
  );

  const Icon = TAB_ICONS[buffer.kind];
  const label = buffer.kind === 'server' ? t('sidebar.server') : buffer.target;

  return (
    <div
      className={cn(
        'group relative flex max-w-44 shrink-0 items-center rounded-md',
        active ? 'bg-sidebar-active text-ink' : 'text-muted hover:bg-sidebar-hover hover:text-ink',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // Which network a tab belongs to matters once there is more than one,
        // and the label alone does not say it.
        title={networkName === '' ? label : `${networkName} · ${label}`}
        onClick={() => selectBuffer(buffer.id)}
        className="flex min-w-0 items-center gap-1.5 py-[5px] pl-2 pr-1 text-left"
      >
        <Icon
          aria-hidden
          className={cn('size-3.5 shrink-0', active ? 'text-accent' : 'text-faint')}
          strokeWidth={2.25}
        />
        <span
          className={cn(
            'truncate text-[12.5px]',
            buffer.highlight && !active ? 'font-semibold text-ink' : undefined,
          )}
        >
          {label}
        </span>
      </button>

      {buffer.unread > 0 && !active ? (
        <span
          aria-label={t('tabs.unread', { count: buffer.unread })}
          className={cn(
            'mr-1 shrink-0 rounded-full px-1.5 text-[10px] tabular-nums',
            buffer.highlight ? 'bg-highlight text-black/85' : 'bg-subtle text-muted',
          )}
        >
          {buffer.unread}
        </span>
      ) : null}

      <button
        type="button"
        aria-label={t('tabs.close', { name: label })}
        onClick={() => void closeSessionBuffer(buffer).catch(() => undefined)}
        className={cn(
          'mr-1 shrink-0 rounded p-0.5 text-faint hover:text-ink',
          // Revealed on hover or when current, so a strip of twenty tabs is not
          // twenty close buttons.
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function BufferTabs() {
  const { t } = useTranslation();

  const networks = useSessionStore((state) => state.networks);
  const buffers = useSessionStore((state) => state.buffers);

  const ordered = orderedBuffers(networks, buffers);
  if (ordered.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={t('tabs.label')}
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-1.5 py-1"
    >
      {ordered.map((buffer) => (
        <Tab key={buffer.id} buffer={buffer} />
      ))}
    </div>
  );
}

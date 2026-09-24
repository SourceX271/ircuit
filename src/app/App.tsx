import { PanelLeft, PanelRight } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import { BufferSidebar } from '@/features/buffers/BufferSidebar';
import { BufferTabs } from '@/features/buffers/BufferTabs';
import { Composer } from '@/features/composer/Composer';
import { MemberList } from '@/features/members/MemberList';
import { MessageList } from '@/features/messages/MessageList';
import { TopicBar } from '@/features/messages/TopicBar';
import { NetworkDialog } from '@/features/networks/NetworkDialog';
import { NotificationStack } from '@/features/notifications/NotificationStack';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { CoreModulesCard } from '@/features/selfcheck/CoreModulesCard';
import { useCoreBridge } from '@/features/selfcheck/useCoreBridge';
import { StatusBar } from '@/features/shell/StatusBar';
import { TopBar } from '@/features/shell/TopBar';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';
import { cn } from '@/lib/cn';
import { composeTitle, setWindowTitle } from '@/lib/windowTitle';
import { useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import { useSessionBridge } from './useSessionBridge';
import { useThemeSync } from './useThemeSync';

/**
 * Main window: top bar, three columns, status bar.
 *
 * The message list takes every remaining pixel because it is the point of the
 * application; both side columns are fixed-width and can be collapsed when the
 * window is narrow or the user simply wants more room to read.
 */
export function App() {
  const { t } = useTranslation();
  useThemeSync();
  useSessionBridge();
  useShortcuts();

  const bridge = useCoreBridge();

  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const membersOpen = useUiStore((state) => state.membersOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleMembers = useUiStore((state) => state.toggleMembers);
  const connectionDialogOpen = useUiStore((state) => state.connectionDialogOpen);
  const setConnectionDialogOpen = useUiStore((state) => state.setConnectionDialogOpen);

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const networks = useSessionStore((state) => state.networks);

  // Counts of buffers, not of messages: the title is a "something needs you"
  // signal, and a number that grows with every line stops being one. Selecting
  // the count rather than the filtered array also keeps this from re-rendering
  // the whole window on every message.
  const unreadBuffers = useSessionStore((state) =>
    state.buffers.reduce((total, buffer) => total + (buffer.unread > 0 ? 1 : 0), 0),
  );
  const highlightBuffers = useSessionStore((state) =>
    state.buffers.reduce((total, buffer) => total + (buffer.highlight ? 1 : 0), 0),
  );

  useEffect(() => {
    void setWindowTitle(composeTitle(t('app.name'), highlightBuffers, unreadBuffers));
  }, [highlightBuffers, unreadBuffers, t]);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;
  const network = networks.find((candidate) => candidate.id === buffer?.networkId) ?? null;

  return (
    <div className="flex h-full flex-col bg-app text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-ink focus:shadow-lg"
      >
        {t('a11y.skipToContent')}
      </a>

      <TopBar />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? (
          <BufferSidebar
            onAddNetwork={() => setConnectionDialogOpen(true)}
            onCollapse={toggleSidebar}
          />
        ) : (
          <CollapsedRail side="left" onExpand={toggleSidebar} label={t('shell.showSidebar')} />
        )}

        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <BufferTabs />
          <TopicBar
            buffer={buffer}
            networkName={network?.name ?? null}
            state={network?.state ?? null}
          />
          <MessageList />
          <Composer />
        </main>

        {membersOpen ? (
          <aside
            aria-label={t('members.title')}
            className="flex w-56 shrink-0 flex-col border-l border-line bg-sidebar"
          >
            <MemberList onCollapse={toggleMembers} />
            <CoreModulesCard bridge={bridge} />
          </aside>
        ) : (
          <CollapsedRail side="right" onExpand={toggleMembers} label={t('shell.showMembers')} />
        )}
      </div>

      <StatusBar bridge={bridge} />

      <NotificationStack />

      <NetworkDialog open={connectionDialogOpen} onClose={() => setConnectionDialogOpen(false)} />

      <CommandPalette />
    </div>
  );
}

/**
 * What is left of a collapsed sidebar: one button, at the edge.
 *
 * A collapsed column that leaves nothing behind is a dead end for anyone who
 * does not know the shortcut, so the expand affordance stays visible.
 */
function CollapsedRail({
  side,
  onExpand,
  label,
}: {
  side: 'left' | 'right';
  onExpand: () => void;
  label: string;
}) {
  const Icon = side === 'left' ? PanelLeft : PanelRight;

  return (
    <div
      className={cn(
        'flex w-9 shrink-0 flex-col items-center border-line pt-2',
        side === 'left' ? 'border-r bg-sidebar' : 'border-l bg-sidebar',
      )}
    >
      <IconButton label={label} size="sm" onClick={onExpand}>
        <Icon />
      </IconButton>
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BufferSidebar } from '@/features/buffers/BufferSidebar';
import { Composer } from '@/features/composer/Composer';
import { MemberList } from '@/features/members/MemberList';
import { MessageList } from '@/features/messages/MessageList';
import { TopicBar } from '@/features/messages/TopicBar';
import { NetworkDialog } from '@/features/networks/NetworkDialog';
import { CoreModulesCard } from '@/features/selfcheck/CoreModulesCard';
import { useCoreBridge } from '@/features/selfcheck/useCoreBridge';
import { StatusBar } from '@/features/shell/StatusBar';
import { TopBar } from '@/features/shell/TopBar';
import { useSessionStore } from '@/store/session';

import { useSessionBridge } from './useSessionBridge';
import { useThemeSync } from './useThemeSync';

/**
 * Main window: top bar, three columns, status bar.
 *
 * The message list takes every remaining pixel because it is the point of the
 * application; both side columns are fixed-width and can be read at a glance.
 */
export function App() {
  const { t } = useTranslation();
  useThemeSync();
  useSessionBridge();

  const bridge = useCoreBridge();

  const [networkDialogOpen, setNetworkDialogOpen] = useState(false);

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const networks = useSessionStore((state) => state.networks);

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
        <BufferSidebar onAddNetwork={() => setNetworkDialogOpen(true)} />

        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <TopicBar
            buffer={buffer}
            networkName={network?.name ?? null}
            state={network?.state ?? null}
          />
          <MessageList />
          <Composer />
        </main>

        <aside
          aria-label={t('members.title')}
          className="flex w-56 shrink-0 flex-col border-l border-line bg-sidebar"
        >
          <MemberList />
          <CoreModulesCard bridge={bridge} />
        </aside>
      </div>

      <StatusBar bridge={bridge} />

      <NetworkDialog open={networkDialogOpen} onClose={() => setNetworkDialogOpen(false)} />
    </div>
  );
}

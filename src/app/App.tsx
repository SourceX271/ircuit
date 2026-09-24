import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { BufferSidebar } from '@/features/buffers/BufferSidebar';
import { Composer } from '@/features/composer/Composer';
import { MemberList } from '@/features/members/MemberList';
import { MessageList } from '@/features/messages/MessageList';
import { TopicBar } from '@/features/messages/TopicBar';
import { CoreModulesCard } from '@/features/selfcheck/CoreModulesCard';
import { useCoreBridge } from '@/features/selfcheck/useCoreBridge';
import { StatusBar } from '@/features/shell/StatusBar';
import { TopBar } from '@/features/shell/TopBar';
import { resolveActiveBuffer, useShellStore } from '@/store/shell';

import { useThemeSync } from './useThemeSync';

/**
 * 主窗口骨架：顶部栏 + 三栏 + 状态栏。
 *
 * 三栏中的消息流占据全部剩余宽度 —— 它是这个应用的绝对主角，
 * 两侧栏都做成可滚动但不抢视线。
 */
export function App() {
  const { t } = useTranslation();
  useThemeSync();

  const bridge = useCoreBridge();

  const networks = useShellStore((state) => state.networks);
  const activeBufferId = useShellStore((state) => state.activeBufferId);
  const topic = useShellStore((state) => state.topic);
  const members = useShellStore((state) => state.members);
  const messages = useShellStore((state) => state.messages);

  const active = useMemo(
    () => resolveActiveBuffer(networks, activeBufferId),
    [networks, activeBufferId],
  );

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
        <BufferSidebar />

        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <TopicBar buffer={active.buffer} topic={topic} />
          <MessageList messages={messages} />
          <Composer />
        </main>

        <aside
          aria-label={t('members.title')}
          className="flex w-56 shrink-0 flex-col border-l border-line bg-sidebar"
        >
          <MemberList members={members} />
          <CoreModulesCard bridge={bridge} />
        </aside>
      </div>

      <StatusBar bridge={bridge} />
    </div>
  );
}

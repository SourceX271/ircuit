import { Hash, Search, Settings, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import type { PlaceholderBuffer } from '@/data/placeholder';

export interface TopicBarProps {
  buffer: PlaceholderBuffer | undefined;
  topic: string;
}

export function TopicBar({ buffer, topic }: TopicBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-topicbar px-3">
      {buffer ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-ink">
          {buffer.kind === 'channel' ? (
            <Hash className="size-3.5 text-faint" strokeWidth={2.5} />
          ) : null}
          {buffer.name}
        </span>
      ) : (
        <span className="text-[13px] text-faint">—</span>
      )}

      <span aria-hidden className="text-line-strong">
        |
      </span>

      <p
        className="min-w-0 flex-1 truncate text-[12.5px] text-muted"
        title={topic}
        aria-label={t('topic.label')}
      >
        {topic || t('topic.noTopic')}
      </p>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={t('members.title')} size="sm">
          <Users />
        </IconButton>
        <IconButton label="Search" size="sm">
          <Search />
        </IconButton>
        <IconButton label="Settings" size="sm">
          <Settings />
        </IconButton>
      </div>
    </div>
  );
}

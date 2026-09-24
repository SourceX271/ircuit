import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import { PLACEHOLDER_SELF_NICK, type PlaceholderMessage } from '@/data/placeholder';

/** 昵称配色只能按下标动态取用，故用内联样式指向 design token。 */
function nickStyle(nickColor: number): { color: string } {
  return { color: `var(--ir-nick-${nickColor % 8})` };
}

function TimeCell({ time }: { time: string }) {
  return (
    <time className="w-10 shrink-0 pt-[3px] text-right font-mono text-[11px] tabular-nums text-faint">
      {time}
    </time>
  );
}

function MessageRow({ message }: { message: PlaceholderMessage }) {
  if (message.kind === 'system') {
    return (
      <div className="px-4 py-[3px]">
        <p className="pl-[52px] text-[12.5px] text-faint">{message.body}</p>
      </div>
    );
  }

  const isAction = message.kind === 'action';
  const isNotice = message.kind === 'notice';

  return (
    <div
      className={cn(
        'group flex gap-3 rounded-[4px] px-4 py-[3px] transition-colors duration-75',
        message.highlight ? 'bg-highlight-soft' : 'hover:bg-message-hover',
      )}
    >
      <TimeCell time={message.time} />

      {isAction ? (
        <p className="min-w-0 flex-1 text-[14px] italic leading-[1.55] text-muted">
          <span className="text-faint">* </span>
          <span className="font-semibold" style={nickStyle(message.nickColor)}>
            {message.nick}
          </span>{' '}
          {message.body}
        </p>
      ) : (
        <>
          <span
            className={cn(
              'w-[104px] shrink-0 truncate pt-[1px] text-[13px] font-semibold',
              isNotice && 'font-medium',
            )}
            style={nickStyle(message.nickColor)}
            title={message.nick}
          >
            {message.nick}
          </span>
          <p
            className={cn(
              'min-w-0 flex-1 text-[14px] leading-[1.55]',
              isNotice ? 'italic text-muted' : 'text-ink',
            )}
          >
            {message.body}
          </p>
        </>
      )}
    </div>
  );
}

export function MessageList({ messages }: { messages: PlaceholderMessage[] }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
      <p className="mx-4 mb-2 rounded-md border border-dashed border-line px-3 py-1.5 text-[11.5px] text-faint">
        {t('shell.placeholderNotice')}
      </p>

      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}

      <div className="px-4 pt-3">
        <p className="pl-[52px] text-[12px] text-faint">
          {t('app.name')} · {PLACEHOLDER_SELF_NICK}
        </p>
      </div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import type { MessageKind } from '@/lib/ipc';
import {
  parseBufferId,
  useSessionStore,
  type SessionLine,
  type TrafficLine,
} from '@/store/session';

/** Nickname colours are indexed tokens, so the choice has to be inline. */
function nickColor(nick: string): string {
  let hash = 0;
  for (let index = 0; index < nick.length; index += 1) {
    hash = (hash * 31 + nick.charCodeAt(index)) | 0;
  }
  return `var(--ir-nick-${Math.abs(hash) % 8})`;
}

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const KIND_TEXT: Record<MessageKind, string> = {
  message: 'text-ink',
  notice: 'italic text-muted',
  action: 'italic text-muted',
  system: 'text-faint',
};

function LineRow({ line }: { line: SessionLine }) {
  const isAction = line.kind === 'action';

  if (line.kind === 'system') {
    return (
      <div className="px-4 py-[3px]">
        <p className="pl-[52px] text-[12.5px] text-faint">{line.text}</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex gap-3 rounded-[4px] px-4 py-[3px]',
        line.highlight ? 'bg-highlight-soft' : 'hover:bg-message-hover',
      )}
    >
      <time className="w-10 shrink-0 pt-[3px] text-right font-mono text-[11px] tabular-nums text-faint">
        {formatTime(line.timestamp)}
      </time>

      {isAction ? (
        <p className={cn('min-w-0 flex-1 text-[14px] leading-[1.55]', KIND_TEXT.action)}>
          <span className="text-faint">* </span>
          <span className="font-semibold" style={{ color: nickColor(line.nick) }}>
            {line.nick}
          </span>{' '}
          {line.text}
        </p>
      ) : (
        <>
          <span
            className="w-[104px] shrink-0 truncate pt-[1px] text-[13px] font-semibold"
            style={{ color: nickColor(line.nick) }}
            title={line.nick}
          >
            {line.nick}
          </span>
          <p className={cn('min-w-0 flex-1 text-[14px] leading-[1.55]', KIND_TEXT[line.kind])}>
            {line.text}
          </p>
        </>
      )}
    </div>
  );
}

function TrafficRow({ line }: { line: TrafficLine }) {
  const inbound = line.direction === 'inbound';

  return (
    <div className="flex gap-3 px-4 py-[2px] font-mono text-[12px] leading-[1.5] hover:bg-message-hover">
      <span
        aria-hidden
        className={cn(
          'w-3 shrink-0 select-none pt-[1px] text-center',
          inbound ? 'text-success' : 'text-accent',
        )}
        title={line.direction}
      >
        {inbound ? '←' : '→'}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-muted">{line.line}</span>
    </div>
  );
}

/** Scroll container shared by both views, so the layout rules stay in one place. */
function Scrolling({ children, count }: { children: ReactNode; count: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  // A chat log is read from the bottom; jumping there on new content is the
  // only behaviour that matches expectations.
  useEffect(() => {
    const element = scrollerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);

  return (
    <div ref={scrollerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
      {children}
    </div>
  );
}

export function MessageList() {
  const { t } = useTranslation();

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const lines = useSessionStore((state) => state.lines);
  const traffic = useSessionStore((state) => state.traffic);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;

  if (!buffer) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
        <div>
          <p className="text-[14px] font-medium text-ink">{t('empty.title')}</p>
          <p className="mt-1 text-[12.5px] text-faint">{t('empty.hint')}</p>
        </div>
      </div>
    );
  }

  if (buffer.kind === 'server') {
    const networkId = parseBufferId(buffer.id).networkId;
    const entries = traffic[networkId] ?? [];

    return (
      <Scrolling count={entries.length}>
        {entries.length === 0 ? (
          <p className="px-4 text-[12.5px] text-faint">{t('network.state.connecting')}…</p>
        ) : (
          entries.map((line) => <TrafficRow key={line.id} line={line} />)
        )}
      </Scrolling>
    );
  }

  const entries = lines[buffer.id] ?? [];

  return (
    <Scrolling count={entries.length}>
      {entries.length === 0 ? (
        <p className="px-4 text-[12.5px] text-faint">{t('topic.channelHint')}</p>
      ) : (
        entries.map((line) => <LineRow key={line.id} line={line} />)
      )}
    </Scrolling>
  );
}

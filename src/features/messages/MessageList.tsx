import { Fragment, useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import { openExternal, type MessageKind, type MessageSegment } from '@/lib/ipc';
import { parseBufferId, useSessionStore, type TrafficLine } from '@/store/session';

import { isPlainStyle, segmentStyle } from './formatting';
import { buildBlocks, type DisplayRow } from './grouping';
import { hrefFor, tokenizeLinks, type TextToken } from './links';

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

/**
 * The sender's mark: IRC has no avatars, so a coloured initial derived from the
 * nickname is the honest version of one.
 */
function Avatar({ nick }: { nick: string }) {
  const initial = [...nick][0]?.toUpperCase() ?? '?';
  const color = nickColor(nick);

  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-[5px] text-[10px] font-semibold"
      style={{
        color,
        backgroundColor: `color-mix(in oklab, ${color} 20%, transparent)`,
      }}
    >
      {initial}
    </span>
  );
}

/**
 * Render one run of text, linkifying whatever looks like a URL.
 *
 * A plain run with no links is emitted as bare text, which is the common case
 * and avoids a span per message.
 */
function Segment({ segment, tokens }: { segment: MessageSegment; tokens: TextToken[] }) {
  const style = isPlainStyle(segment.style) ? undefined : segmentStyle(segment.style);

  if (tokens.length === 1 && tokens[0]?.kind === 'text') {
    return style ? <span style={style}>{segment.text}</span> : <>{segment.text}</>;
  }

  return (
    <span style={style}>
      {tokens.map((token, index) =>
        token.kind === 'link' ? (
          <Link key={index} value={token.value} />
        ) : (
          <Fragment key={index}>{token.value}</Fragment>
        ),
      )}
    </span>
  );
}

/**
 * A clickable link.
 *
 * The click is always intercepted: letting the webview follow the link would
 * navigate the application itself away from its own UI.
 */
function Link({ value }: { value: string }) {
  const target = hrefFor(value);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternal(target).catch((error: unknown) => {
      console.error('[ircuit] 打开链接失败', error);
    });
  };

  return (
    <a
      href={target}
      onClick={onClick}
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
    >
      {value}
    </a>
  );
}

/** Render a message body: formatting first, then links inside each run. */
function Body({ segments, fallback }: { segments: MessageSegment[]; fallback: string }) {
  const parts = useMemo(
    () => segments.map((segment) => ({ segment, tokens: tokenizeLinks(segment.text) })),
    [segments],
  );

  if (segments.length === 0) return <>{fallback}</>;

  const nothingToDo = parts.every(
    ({ segment, tokens }) =>
      isPlainStyle(segment.style) && tokens.length === 1 && tokens[0]?.kind === 'text',
  );
  if (nothingToDo) return <>{segments.map((segment) => segment.text).join('')}</>;

  return (
    <>
      {parts.map(({ segment, tokens }, index) => (
        <Segment key={index} segment={segment} tokens={tokens} />
      ))}
    </>
  );
}

function DayDivider({ day, locale }: { day: string; locale: string }) {
  const label = useMemo(() => {
    const [year, month, date] = day.split('-').map(Number);
    const value = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
    return new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(value);
  }, [day, locale]);

  return (
    <div className="my-2 flex items-center gap-3 px-4" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] font-medium text-faint">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function LineRow({ row }: { row: DisplayRow }) {
  const { line, startsGroup } = row;

  if (line.kind === 'system') {
    return (
      <div className="px-4 py-[3px]">
        <p className="pl-[84px] text-[12.5px] text-faint">
          <Body segments={line.segments} fallback={line.text} />
        </p>
      </div>
    );
  }

  const isAction = line.kind === 'action';

  return (
    <div
      className={cn(
        'flex gap-2.5 px-4',
        startsGroup ? 'pb-[2px] pt-[6px]' : 'py-[1px]',
        line.highlight ? 'bg-highlight-soft' : 'hover:bg-message-hover',
      )}
    >
      <time className="w-10 shrink-0 pt-[3px] text-right font-mono text-[11px] tabular-nums text-faint">
        {startsGroup ? formatTime(line.timestamp) : ''}
      </time>

      <span className="w-5 shrink-0 pt-[1px]">
        {startsGroup ? <Avatar nick={line.nick} /> : null}
      </span>

      {isAction ? (
        <p className={cn('min-w-0 flex-1 text-[14px] leading-[1.55]', KIND_TEXT.action)}>
          <span className="text-faint">* </span>
          <span className="font-semibold" style={{ color: nickColor(line.nick) }}>
            {line.nick}
          </span>{' '}
          <Body segments={line.segments} fallback={line.text} />
        </p>
      ) : (
        <>
          <span
            className="w-[92px] shrink-0 truncate pt-[1px] text-[13px] font-semibold"
            style={{ color: startsGroup ? nickColor(line.nick) : undefined }}
            title={line.nick}
          >
            {startsGroup ? line.nick : ''}
          </span>
          <p className={cn('min-w-0 flex-1 text-[14px] leading-[1.55]', KIND_TEXT[line.kind])}>
            <Body segments={line.segments} fallback={line.text} />
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
  const { t, i18n } = useTranslation();

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const lines = useSessionStore((state) => state.lines);
  const traffic = useSessionStore((state) => state.traffic);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;
  const entries = buffer ? (lines[buffer.id] ?? []) : [];
  const blocks = useMemo(() => buildBlocks(entries), [entries]);

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
    const log = traffic[networkId] ?? [];

    return (
      <Scrolling count={log.length}>
        {log.length === 0 ? (
          <p className="px-4 text-[12.5px] text-faint">{t('network.state.connecting')}…</p>
        ) : (
          log.map((line) => <TrafficRow key={line.id} line={line} />)
        )}
      </Scrolling>
    );
  }

  return (
    <Scrolling count={entries.length}>
      {entries.length === 0 ? (
        <p className="px-4 text-[12.5px] text-faint">{t('topic.channelHint')}</p>
      ) : (
        blocks.map((block, index) => (
          <Fragment key={index}>
            {block.daySeparator ? (
              <DayDivider day={block.daySeparator} locale={i18n.language} />
            ) : null}
            {block.rows.map((row) => (
              <LineRow key={row.line.id} row={row} />
            ))}
          </Fragment>
        ))
      )}
    </Scrolling>
  );
}

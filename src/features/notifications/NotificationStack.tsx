import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { useSessionStore } from '@/store/session';
import { useNotificationsStore, VISIBLE_NOTIFICATIONS } from '@/store/notifications';

/**
 * The banner stack: what arrived in a buffer the user is not looking at.
 *
 * Deliberately not a modal and deliberately not infinite. It sits in a corner,
 * shows the most recent few, and clicking one goes to the line. The unread
 * badges in the sidebar remain the durable record, so dismissing a banner loses
 * nothing — which is what makes it acceptable to only show a few.
 */
export function NotificationStack() {
  const { t } = useTranslation();

  const notifications = useNotificationsStore((state) => state.notifications);
  const dismiss = useNotificationsStore((state) => state.dismiss);
  const clearAll = useNotificationsStore((state) => state.clearNotifications);

  const selectBuffer = useSessionStore((state) => state.selectBuffer);

  if (notifications.length === 0) return null;

  // Newest first, and only the top few: the stack must never become the thing
  // the user has to clean up before reading their messages.
  const visible = [...notifications].reverse().slice(0, VISIBLE_NOTIFICATIONS);
  const hidden = notifications.length - visible.length;

  return (
    <div
      aria-label={t('notifications.title')}
      // `polite` rather than `assertive`: a highlight is worth a glance, not an
      // interruption of whatever the screen reader is already saying.
      aria-live="polite"
      // Absolute inside the message pane rather than fixed to the window, so a
      // banner never lands on the buffer tree or the member list.
      className="pointer-events-none absolute bottom-2 right-3 z-30 flex w-72 flex-col gap-1.5"
    >
      {visible.map((notification) => (
        <div
          key={notification.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 shadow-lg',
            'border-l-2 border-l-highlight',
          )}
        >
          <button
            type="button"
            onClick={() => {
              selectBuffer(notification.bufferId);
              dismiss(notification.id);
            }}
            className="min-w-0 flex-1 text-left"
          >
            <span className="flex items-baseline gap-1.5 text-[11px] text-faint">
              <span className="truncate font-medium text-ink">{notification.nick}</span>
              <span className="truncate">
                {notification.bufferLabel === ''
                  ? notification.networkName
                  : `${notification.networkName} · ${notification.bufferLabel}`}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-muted">
              {notification.text}
            </span>
          </button>

          <IconButton
            label={t('notifications.dismiss')}
            size="sm"
            onClick={() => dismiss(notification.id)}
          >
            <X />
          </IconButton>
        </div>
      ))}

      {hidden > 0 || visible.length > 1 ? (
        <button
          type="button"
          onClick={clearAll}
          className="pointer-events-auto self-end rounded-md px-2 py-0.5 text-[11px] text-faint hover:text-ink"
        >
          {hidden > 0
            ? t('notifications.moreAndClear', { count: hidden })
            : t('notifications.clear')}
        </button>
      ) : null}
    </div>
  );
}

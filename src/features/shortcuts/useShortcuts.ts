/**
 * The single global key listener.
 *
 * Mounted once, from `App`. Everything it can do goes through the same paths the
 * UI already uses — `closeSessionBuffer`, the session store, the ui store — so a
 * shortcut cannot behave differently from clicking.
 *
 * While the command palette is open it swallows every other shortcut except the
 * one that closes it: the palette has its own arrow-key handling, and running
 * `Ctrl+W` behind it would act on a buffer the user cannot see.
 */

import { useEffect } from 'react';

import { closeSessionBuffer } from '@/features/buffers/actions';
import { orderedBuffers, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import { findShortcut, isMacLike, currentPlatform, type ShortcutMatch } from './shortcuts';

/** Move `delta` places through the buffers, wrapping at both ends. */
export function neighbourBufferId(
  ids: readonly string[],
  activeId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) return null;

  const index = activeId === null ? -1 : ids.indexOf(activeId);
  if (index < 0) return ids[0] ?? null;

  return ids[(index + delta + ids.length) % ids.length] ?? null;
}

export function useShortcuts(): void {
  useEffect(() => {
    const mac = isMacLike(currentPlatform());

    const onKeyDown = (event: KeyboardEvent) => {
      const match = findShortcut(event, undefined, mac);
      if (!match) return;

      const ui = useUiStore.getState();

      if (match.spec.id === 'palette.open') {
        event.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }

      // Anything else waits until the palette is out of the way.
      if (ui.paletteOpen) return;

      if (handle(match)) event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Run the action for a shortcut. Returns whether it did anything. */
function handle(match: ShortcutMatch): boolean {
  const session = useSessionStore.getState();
  const ui = useUiStore.getState();

  switch (match.spec.id) {
    case 'sidebar.toggle':
      ui.toggleSidebar();
      return true;

    case 'members.toggle':
      ui.toggleMembers();
      return true;

    case 'buffer.next':
    case 'buffer.previous': {
      const ordered = orderedBuffers(session.networks, session.buffers);
      const delta = match.spec.id === 'buffer.next' ? 1 : -1;

      const next = neighbourBufferId(
        ordered.map((buffer) => buffer.id),
        session.activeBufferId,
        delta,
      );

      if (next === null) return false;
      session.selectBuffer(next);
      return true;
    }

    case 'buffer.jump': {
      if (match.digit === null) return false;

      const ordered = orderedBuffers(session.networks, session.buffers);
      const target = ordered[match.digit - 1];
      if (!target) return false;

      session.selectBuffer(target.id);
      return true;
    }

    case 'buffer.close': {
      const active = session.buffers.find((buffer) => buffer.id === session.activeBufferId);
      if (!active) return false;

      void closeSessionBuffer(active).catch((error: unknown) => {
        console.error('[ircuit] 关闭缓冲区失败', error);
      });
      return true;
    }

    default:
      return false;
  }
}

/**
 * The window title, which is the one piece of chrome that is visible when the
 * application is not.
 *
 * A desktop client lives in the taskbar, so `(3) Ircuit` is how a user notices
 * that something needs them without switching windows. The title has to be set
 * through Tauri as well as the document: Tauri's window title does not follow
 * `document.title`, and `core:window:allow-set-title` is what makes the call
 * permitted.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Set the title the OS shows.
 *
 * Failures are swallowed on purpose: outside a Tauri window — the test
 * environment, a plain browser — there is no window to rename, and that is not
 * a condition the user needs to hear about.
 */
export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;

  try {
    await getCurrentWindow().setTitle(title);
  } catch {
    // Not running under Tauri, or the permission was removed.
  }
}

/**
 * Compose the title from the unread state.
 *
 * The count is of buffers with something waiting, not of messages: "3" meaning
 * three conversations beats a number that grows by the second and stops meaning
 * anything.
 */
export function composeTitle(base: string, highlightCount: number, unreadCount: number): string {
  // A highlight is the reason to look up; if there is one, it is what the title
  // reports, because 40 unread lines and one mention are not the same thing.
  const count = highlightCount > 0 ? highlightCount : unreadCount;
  if (count === 0) return base;

  return highlightCount > 0 ? `(${count}) ● ${base}` : `(${count}) ${base}`;
}

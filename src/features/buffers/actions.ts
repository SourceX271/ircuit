/**
 * Buffer-level operations shared by every entry point.
 *
 * `/close`, the command palette and the Ctrl+W shortcut all mean the same thing
 * by "close this buffer", and they used to be three copies of the same four
 * lines. Duplicated intent drifts: one of them would eventually stop parting the
 * channel.
 */

import { partChannel } from '@/lib/ipc';
import { useSessionStore, type SessionBuffer } from '@/store/session';

/**
 * Close a buffer the way a user means it.
 *
 * A channel belongs to the server, so closing it means leaving it — the window
 * sticks around with its history until the server confirms. A query exists only
 * in this client, so it is removed here and now.
 */
export async function closeSessionBuffer(buffer: SessionBuffer): Promise<void> {
  if (buffer.kind === 'channel') {
    await partChannel(buffer.networkId, buffer.target, null);
    return;
  }

  useSessionStore.getState().closeBuffer(buffer.id);
}

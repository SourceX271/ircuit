import { useEffect } from 'react';

import {
  getNetworkBacklog,
  listNetworks,
  onIncomingMessage,
  onNetworkStatus,
  onRawTraffic,
} from '@/lib/ipc';
import { useSessionStore } from '@/store/session';

/**
 * Feed the backend's IPC events into the session store.
 *
 * Mounted once, at the top of the tree. Subscriptions live for the lifetime of
 * the window: unmounting and re-subscribing would drop whatever the backend
 * emitted in between, which for `network-status` means a network stuck showing
 * "connecting" forever.
 *
 * # Why subscribe before replaying
 *
 * Tauri events are fire-and-forget, so anything emitted before this effect ran
 * — an entire registration handshake, if the connection was opened at startup —
 * would otherwise be invisible. Subscribing first and then asking for the
 * backlog closes that window; the two overlap, and the sequence numbers on each
 * event make the replay idempotent.
 *
 * The StrictMode double-mount is handled by the `cancelled` flag, so a
 * subscription that resolves after teardown is immediately removed.
 */
export function useSessionBridge(): void {
  const setNetworks = useSessionStore((state) => state.setNetworks);
  const applyNetworkStatus = useSessionStore((state) => state.applyNetworkStatus);
  const applyMessage = useSessionStore((state) => state.applyMessage);
  const applyTraffic = useSessionStore((state) => state.applyTraffic);

  useEffect(() => {
    let cancelled = false;
    const stops: Array<() => void> = [];

    const track = (subscription: Promise<() => void>) => {
      subscription
        .then((stop) => {
          if (cancelled) stop();
          else stops.push(stop);
        })
        .catch((error: unknown) => {
          console.error('[ircuit] 订阅 IPC 事件失败', error);
        });
    };

    track(onNetworkStatus(applyNetworkStatus));
    track(onIncomingMessage(applyMessage));
    track(onRawTraffic(applyTraffic));

    void (async () => {
      try {
        const networks = await listNetworks();
        if (cancelled) return;
        setNetworks(networks);

        for (const network of networks) {
          const backlog = await getNetworkBacklog(network.id);
          if (cancelled) return;

          // Traffic and messages share one sequence counter, so they have to be
          // replayed *interleaved* in sequence order. Applying one stream first
          // would push the high-water mark past the other and silently discard
          // every entry in it.
          const replay = [
            ...backlog.traffic.map((traffic) => ({
              seq: traffic.seq,
              apply: () => applyTraffic(traffic),
            })),
            ...backlog.messages.map((message) => ({
              seq: message.seq,
              apply: () => applyMessage(message),
            })),
          ].sort((left, right) => left.seq - right.seq);

          for (const entry of replay) entry.apply();
        }
      } catch (error) {
        console.error('[ircuit] 读取网络状态失败', error);
      }
    })();

    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, [setNetworks, applyNetworkStatus, applyMessage, applyTraffic]);
}

/**
 * Live session state: networks, buffers and the lines in them.
 *
 * Everything here is derived from Rust events. The store owns two mappings that
 * the UI reads directly — lines per buffer, and raw traffic per network — plus
 * the bookkeeping the backend has no reason to know about (unread counts, which
 * buffer is on screen).
 *
 * The in-memory rings stay bounded; the archive behind them does not. Scrolling
 * to the top of a buffer pulls the previous page from SQLite, which is why a
 * buffer's `lines` array is not just "what arrived this session".
 */

import { create } from 'zustand';

import { isHighlight } from '@/lib/highlight';
import { loadHistory as loadHistoryPage } from '@/lib/ipc';
import type {
  ChannelClosed,
  ChannelSnapshot,
  HistoryCursor,
  HistoryPage,
  IncomingMessage,
  MessageKind,
  MessageSegment,
  NetworkStatus,
  NetworkSummary,
  RawTraffic,
  TrafficDirection,
} from '@/lib/ipc';

import { nextNotificationId, shouldNotify, useNotificationsStore } from './notifications';

/** How many lines one page of history holds. */
export const HISTORY_PAGE_SIZE = 100;

/** How far back the archive has been walked for one buffer. */
export interface HistoryState {
  /** A page is in flight; further scroll events must not start another. */
  loading: boolean;
  /** The beginning of the buffer has been reached. */
  exhausted: boolean;
  /** Why the last page failed, if it did. */
  error: string | null;
}

/** An unstyled run, for text with no formatting codes left in it. */
const PLAIN_STYLE = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  monospace: false,
  reverse: false,
  fg_index: null,
  bg_index: null,
  fg_hex: null,
  bg_hex: null,
} as const;

export type BufferKind = 'server' | 'channel' | 'query';

/** A conversation the user can look at. */
export interface SessionBuffer {
  /** Stable id: `<networkId>|<target>`, with an empty target for the server buffer. */
  id: string;
  networkId: string;
  /** Channel name or conversation partner; empty for the server buffer. */
  target: string;
  kind: BufferKind;
  unread: number;
  /** Unread lines that mentioned us. */
  highlight: boolean;
  /** Whether the user has ever opened this buffer. */
  seen: boolean;
}

/** One conversation line, ready to render. */
export interface SessionLine {
  id: string;
  nick: string;
  kind: MessageKind;
  /** Plain text with formatting removed, for search and notifications. */
  text: string;
  /** The same line with formatting preserved, for rendering. */
  segments: MessageSegment[];
  /** Unix seconds. */
  timestamp: number;
  isSelf: boolean;
  /** Whether the line mentions us. */
  highlight: boolean;
  /**
   * The row this line came from, when it was loaded from history.
   *
   * Live lines have none: they are stored asynchronously, and waiting for a rowid
   * before showing a message would put a disk write in front of every line. Its
   * only use is as the cursor for paging further back.
   */
  historyId?: string;
}

/** One raw protocol line, for the server buffer. */
export interface TrafficLine {
  id: string;
  direction: TrafficDirection;
  /** The line as it went on the wire, formatting codes and all. */
  line: string;
  /**
   * The same line parsed into styled runs, when it carries formatting.
   *
   * Empty for most lines. The server buffer renders these with the same styling
   * as a message; `line` stays as the literal fallback so a control byte that
   * has no styling meaning can still be shown for what it is.
   */
  segments: MessageSegment[];
  timestamp: number;
}

/** How many conversation lines to keep per buffer. */
export const MAX_LINES_PER_BUFFER = 2000;

/** How many raw protocol lines to keep per network. */
export const MAX_TRAFFIC_LINES = 1000;

/** Build the stable id for a buffer. */
export function bufferId(networkId: string, target: string): string {
  return `${networkId}|${target}`;
}

/** Split a buffer id back into its parts. */
export function parseBufferId(id: string): { networkId: string; target: string } {
  const separator = id.indexOf('|');
  if (separator < 0) return { networkId: id, target: '' };
  return { networkId: id.slice(0, separator), target: id.slice(separator + 1) };
}

/**
 * Whether a target names a channel.
 *
 * Only the two universally supported prefixes are treated as channels. Servers
 * may advertise others through `CHANTYPES`; supporting those needs the ISUPPORT
 * parsing that arrives with the channel model in M2.
 */
export function isChannelName(target: string): boolean {
  return target.startsWith('#') || target.startsWith('&');
}

function kindForTarget(target: string): BufferKind {
  if (target === '') return 'server';
  return isChannelName(target) ? 'channel' : 'query';
}

/** Server buffer first, then channels, then conversations. */
const KIND_ORDER: Record<BufferKind, number> = {
  server: 0,
  channel: 1,
  query: 2,
};

/**
 * Buffers in the order the sidebar shows them.
 *
 * Shared with keyboard navigation rather than duplicated: "next buffer" that
 * jumps somewhere other than the row below the current one is worse than no
 * shortcut at all.
 */
export function orderedBuffers(
  networks: readonly NetworkSummary[],
  buffers: readonly SessionBuffer[],
): SessionBuffer[] {
  const result: SessionBuffer[] = [];

  for (const network of networks) {
    const owned = buffers
      .filter((buffer) => buffer.networkId === network.id)
      .sort((left, right) => {
        const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
        return byKind !== 0 ? byKind : left.target.localeCompare(right.target);
      });

    result.push(...owned);
  }

  return result;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Reset the id counter. Test-only. */
export function resetLineSequence(): void {
  sequence = 0;
}

export interface SessionState {
  networks: NetworkSummary[];
  buffers: SessionBuffer[];
  lines: Record<string, SessionLine[]>;
  traffic: Record<string, TrafficLine[]>;
  activeBufferId: string | null;
  /**
   * Highest event sequence seen per network.
   *
   * The bridge subscribes and *then* asks for the backlog, so the same event can
   * legitimately arrive twice. Comparing sequences makes the replay idempotent
   * without having to order the two operations.
   */
  lastSeq: Record<string, number>;
  /**
   * Channel state per buffer id.
   *
   * Snapshots rather than deltas: the backend sends the whole channel every time
   * it changes, so a dropped or reordered event can never leave the member list
   * subtly wrong — an older snapshot simply loses to a newer one.
   */
  channels: Record<string, ChannelSnapshot>;
  /**
   * Nicknames hidden from this client, per network.
   *
   * Filtering here rather than in the renderer means an ignored user's lines
   * never reach unread counts or (later) notifications either — hiding them only
   * at the last moment would still let them make noise.
   */
  ignored: Record<string, string[]>;
  /**
   * How far back the archive has been walked, per buffer.
   *
   * `loading` is what stops a scroll gesture from firing the same page several
   * times; `exhausted` is set once a page comes back short, so the UI can stop
   * offering "load more" without another round trip.
   */
  history: Record<string, HistoryState>;

  setNetworks: (networks: NetworkSummary[]) => void;
  applyNetworkStatus: (status: NetworkStatus) => void;
  applyMessage: (message: IncomingMessage) => void;
  applyTraffic: (traffic: RawTraffic) => void;
  applyChannelSnapshot: (snapshot: ChannelSnapshot) => void;
  applyChannelClosed: (closed: ChannelClosed) => void;
  selectBuffer: (id: string) => void;
  /** Open a private conversation with `nick`, creating the buffer if needed. */
  openQuery: (networkId: string, nick: string) => void;
  /** Forget a buffer and its history. Local only; does not leave a channel. */
  closeBuffer: (id: string) => void;
  /** Drop a buffer's history but keep the buffer itself. */
  clearBuffer: (id: string) => void;
  toggleIgnored: (networkId: string, nick: string) => void;
  removeNetwork: (networkId: string) => void;
  /**
   * Load the newest page of a buffer from the archive.
   *
   * Does nothing if the buffer already has lines: whatever is in memory is
   * strictly newer, and re-loading would duplicate it.
   */
  loadHistory: (id: string) => Promise<void>;
  /** Load the page before the oldest line on screen. */
  loadOlder: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  networks: [],
  buffers: [],
  lines: {},
  traffic: {},
  activeBufferId: null,
  lastSeq: {},
  channels: {},
  ignored: {},
  history: {},

  setNetworks: (networks) => {
    set((state) => {
      const buffers = [...state.buffers];
      for (const network of networks) {
        ensureBufferIndex(buffers, network.id, '');
      }

      return {
        networks,
        buffers,
        activeBufferId: state.activeBufferId ?? buffers[0]?.id ?? null,
      };
    });
  },

  applyNetworkStatus: (status) => {
    set((state) => {
      const summary: NetworkSummary = {
        id: status.network_id,
        name: status.name,
        host: status.host,
        port: status.port,
        tls: status.tls,
        state: status.state,
        nick: status.nick,
        capabilities: status.capabilities,
        detail: status.detail,
        attempt: status.attempt,
      };

      const index = state.networks.findIndex((network) => network.id === status.network_id);
      const networks = [...state.networks];
      if (index >= 0) networks[index] = { ...networks[index], ...summary };
      else networks.push(summary);

      const buffers = [...state.buffers];
      ensureBufferIndex(buffers, status.network_id, '');

      return {
        networks,
        buffers,
        activeBufferId: state.activeBufferId ?? bufferId(status.network_id, ''),
      };
    });
  },

  applyMessage: (message) => {
    const state = get();
    const network = state.networks.find((candidate) => candidate.id === message.network_id);

    // The backend's own nickname wins over the one in our network list. That list
    // is empty for the first few milliseconds after startup, and an
    // auto-connected session's opening lines arrive exactly then — classifying
    // them with "no nickname known" silently un-highlights every mention of the
    // user, and the sequence dedup means they are never looked at again.
    const selfNick = message.self_nick ?? network?.nick ?? null;

    // An ignored user's lines never enter the store at all: filtering them in
    // the renderer would still let them bump unread counts and, later,
    // notifications.
    if (!message.is_self && isIgnored(state.ignored[message.network_id] ?? [], message.nick)) {
      return;
    }

    // Which conversation this belongs to is decided by the backend, because
    // history is stored under the same key. Deriving it twice is how a private
    // message ends up in a buffer nothing ever reads.
    const target = message.buffer;
    const id = bufferId(message.network_id, target);
    const active = state.activeBufferId === id;

    const rules = useNotificationsStore.getState().rules;
    const highlight = !message.is_self && isHighlight(message.text, selfNick, rules);

    const line: SessionLine = {
      id: nextId('line'),
      nick: message.nick,
      kind: message.kind,
      text: message.text,
      segments: message.segments,
      timestamp: message.timestamp,
      isSelf: message.is_self,
      highlight,
    };

    set((current) => {
      if (message.seq <= (current.lastSeq[message.network_id] ?? 0)) {
        // Already delivered live; this is the backlog catching up.
        return {};
      }

      const buffers = [...current.buffers];
      const index = ensureBufferIndex(buffers, message.network_id, target);

      // Copy before mutating: the object in the previous state must not change.
      const buffer: SessionBuffer = { ...buffers[index] };

      const existing = current.lines[id] ?? [];
      const lines = [...existing, line];
      if (lines.length > MAX_LINES_PER_BUFFER) {
        lines.splice(0, lines.length - MAX_LINES_PER_BUFFER);
      }

      // Only conversation lines count as activity; a join does not.
      const isActivity = !line.isSelf && (line.kind === 'message' || line.kind === 'action');
      if (isActivity && !active) {
        buffer.unread += 1;
        buffer.highlight ||= line.highlight;
      }
      if (active) buffer.seen = true;

      buffers[index] = buffer;

      // Raised here rather than in the bridge because everything that decides
      // eligibility is already in this function: the ignore filter above, the
      // replay dedup just now, and whether the buffer is on screen. A second
      // copy of those rules elsewhere is a second copy to get wrong.
      if (
        shouldNotify({
          text: line.text,
          selfNick,
          rules,
          isSelf: line.isSelf,
          isActivity,
          isActiveBuffer: active,
        })
      ) {
        useNotificationsStore.getState().notify({
          id: nextNotificationId(),
          bufferId: id,
          bufferLabel: target === '' ? '' : target,
          networkId: message.network_id,
          networkName: network?.name ?? message.network_id,
          nick: line.nick,
          text: line.text,
          timestamp: line.timestamp,
        });
      }

      return {
        buffers,
        lines: { ...current.lines, [id]: lines },
        lastSeq: { ...current.lastSeq, [message.network_id]: message.seq },
      };
    });
  },

  applyTraffic: (traffic) => {
    set((state) => {
      if (traffic.seq <= (state.lastSeq[traffic.network_id] ?? 0)) {
        return {};
      }

      const line: TrafficLine = {
        id: nextId('traffic'),
        direction: traffic.direction,
        line: traffic.line,
        // Absent on a line with no formatting; the store normalises it so the
        // renderer never has to check for both.
        segments: traffic.segments ?? [],
        timestamp: traffic.timestamp,
      };

      const existing = state.traffic[traffic.network_id] ?? [];
      const lines = [...existing, line];
      if (lines.length > MAX_TRAFFIC_LINES) {
        lines.splice(0, lines.length - MAX_TRAFFIC_LINES);
      }

      return {
        traffic: { ...state.traffic, [traffic.network_id]: lines },
        lastSeq: { ...state.lastSeq, [traffic.network_id]: traffic.seq },
      };
    });
  },

  selectBuffer: (id) => {
    set((state) => ({
      activeBufferId: id,
      buffers: state.buffers.map((buffer) =>
        buffer.id === id ? { ...buffer, unread: 0, highlight: false, seen: true } : buffer,
      ),
    }));
  },

  openQuery: (networkId, nick) => {
    set((state) => {
      const buffers = [...state.buffers];
      const index = ensureBufferIndex(buffers, networkId, nick);

      const buffer: SessionBuffer = { ...buffers[index], unread: 0, highlight: false, seen: true };
      buffers[index] = buffer;

      return { buffers, activeBufferId: buffer.id };
    });
  },

  closeBuffer: (id) => {
    set((state) => {
      const index = state.buffers.findIndex((buffer) => buffer.id === id);
      if (index < 0) return {};

      const buffers = state.buffers.filter((buffer) => buffer.id !== id);

      const lines = { ...state.lines };
      delete lines[id];

      const channels = { ...state.channels };
      delete channels[id];

      // Selecting a neighbour keeps the keyboard flow intact: closing the last
      // buffer must not leave the main pane empty while others are still open.
      const activeBufferId =
        state.activeBufferId === id
          ? (buffers[Math.min(index, buffers.length - 1)]?.id ?? null)
          : state.activeBufferId;

      return { buffers, lines, channels, activeBufferId };
    });
  },

  clearBuffer: (id) => {
    set((state) => (state.lines[id] ? { lines: { ...state.lines, [id]: [] } } : {}));
  },

  toggleIgnored: (networkId, nick) => {
    set((state) => {
      const current = state.ignored[networkId] ?? [];
      const folded = foldNick(nick);

      const next = current.includes(folded)
        ? current.filter((entry) => entry !== folded)
        : [...current, folded];

      return { ignored: { ...state.ignored, [networkId]: next } };
    });
  },

  applyChannelSnapshot: (snapshot) => {
    set((state) => {
      const id = bufferId(snapshot.network_id, snapshot.name);
      const existing = state.channels[id];

      // Snapshots carry the same clock as messages, so an older one arriving
      // late must not clobber a newer one.
      if (existing && existing.seq > snapshot.seq) return {};

      return { channels: { ...state.channels, [id]: snapshot } };
    });
  },

  applyChannelClosed: (closed) => {
    set((state) => {
      const id = bufferId(closed.network_id, closed.name);
      const existing = state.channels[id];
      if (existing && existing.seq > closed.seq) return {};

      const channels = { ...state.channels };
      delete channels[id];

      // The buffer itself stays: the part or kick is already in its history and
      // the user may still want to read it.
      return { channels };
    });
  },

  removeNetwork: (networkId) => {
    set((state) => {
      const buffers = state.buffers.filter((buffer) => buffer.networkId !== networkId);

      const lines: Record<string, SessionLine[]> = {};
      for (const [id, value] of Object.entries(state.lines)) {
        if (parseBufferId(id).networkId !== networkId) lines[id] = value;
      }

      const traffic = { ...state.traffic };
      delete traffic[networkId];

      const lastSeq = { ...state.lastSeq };
      delete lastSeq[networkId];

      const channels: Record<string, ChannelSnapshot> = {};
      for (const [id, value] of Object.entries(state.channels)) {
        if (parseBufferId(id).networkId !== networkId) channels[id] = value;
      }

      const ignored = { ...state.ignored };
      delete ignored[networkId];

      const activeStillExists = buffers.some((buffer) => buffer.id === state.activeBufferId);

      return {
        networks: state.networks.filter((network) => network.id !== networkId),
        buffers,
        lines,
        traffic,
        lastSeq,
        channels,
        ignored,
        activeBufferId: activeStillExists ? state.activeBufferId : (buffers[0]?.id ?? null),
      };
    });
  },

  loadHistory: async (id) => {
    const state = get();
    // Memory wins. Anything already on screen is newer than the archive's newest
    // page, so loading it would only produce duplicates.
    if ((state.lines[id] ?? []).length > 0) return;
    if (state.history[id]?.loading) return;

    await fetchPage(id, null);
  },

  loadOlder: async (id) => {
    const state = get();
    if (state.history[id]?.loading || state.history[id]?.exhausted) return;

    const oldest = state.lines[id]?.[0];
    if (!oldest) {
      // Nothing on screen at all: the newest page *is* the right answer.
      await fetchPage(id, null);
      return;
    }

    // The cursor is built from the line the user can see, not from a row id. A
    // line that arrived live has no row yet — its insert is still in flight — and
    // waiting for one would mean "scroll up" does nothing until the write lands.
    // Paging by time alone asks for everything strictly before that second, which
    // is exactly what is missing. The cost is that lines sharing the oldest
    // second can be missed, and no cursor can avoid that: the row ids that would
    // break the tie are precisely the ones not known yet.
    await fetchPage(id, { at: oldest.timestamp, id: oldest.historyId ?? '0' });
  },
}));

/**
 * One page of history, prepended to a buffer.
 *
 * Prepending is why the backend hands pages back oldest-first: no reversing, and
 * no chance of getting the order wrong in one of the two callers.
 */
async function fetchPage(id: string, before: HistoryCursor | null): Promise<void> {
  const { networkId, target } = parseBufferId(id);
  const store = useSessionStore;

  const mark = (patch: Partial<HistoryState>) =>
    store.setState((state) => {
      const current = state.history[id] ?? { loading: false, exhausted: false, error: null };
      return { history: { ...state.history, [id]: { ...current, ...patch } } };
    });

  mark({ loading: true, error: null });

  let page: HistoryPage;
  try {
    page = await loadHistoryPage(networkId, target, before, HISTORY_PAGE_SIZE);
  } catch (error) {
    // A failed page is not worth an alert: the conversation above is untouched,
    // and scrolling up again retries.
    mark({ loading: false, error: String(error) });
    return;
  }

  store.setState((state) => {
    const existing = state.lines[id] ?? [];
    const seen = new Set(existing.map(lineKey));
    const network = state.networks.find((candidate) => candidate.id === networkId);
    const selfNick = network?.nick ?? null;
    const rules = useNotificationsStore.getState().rules;

    const loaded: SessionLine[] = [];
    for (const message of page.messages) {
      // The archive's newest page can overlap what arrived live between the two
      // calls, and the same line must not appear twice.
      const candidate: SessionLine = {
        id: nextId('line'),
        nick: message.nick,
        kind: message.kind,
        text: message.body,
        // History stores text, not styled runs; a body with no codes is exactly
        // one unstyled run.
        segments: [{ text: message.body, style: PLAIN_STYLE }],
        timestamp: message.at,
        isSelf: message.is_self,
        highlight: !message.is_self && isHighlight(message.body, selfNick, rules),
        historyId: message.id,
      };

      const key = lineKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      loaded.push(candidate);
    }

    return {
      lines: { ...state.lines, [id]: [...loaded, ...existing] },
      history: {
        ...state.history,
        [id]: { loading: false, exhausted: page.exhausted, error: null },
      },
    };
  });
}

/**
 * Identity of a line for de-duplication across the archive and the live stream.
 *
 * Content, not the row id: a line that arrived live has no row id yet, and the
 * whole point is to recognise it again when the same line comes back from the
 * database. Nick, kind, second and text together are specific enough — two
 * different lines agreeing on all four would be the same line by any measure a
 * user has.
 */
function lineKey(line: SessionLine): string {
  return `${line.nick}\u0000${line.kind}\u0000${line.timestamp}\u0000${line.text}`;
}

/** Fold a nickname for comparison.
 *
 * Approximates rfc1459 case mapping with plain lowercasing: the exact rules
 * depend on the server's `CASEMAPPING`, which the backend applies when it builds
 * channel state. Ignoring is a local convenience, so an approximation is fine —
 * but it must at least be consistent with itself.
 */
function foldNick(nick: string): string {
  return nick.toLowerCase();
}

/** Whether `nick` is on an ignore list. */
export function isIgnored(ignored: readonly string[], nick: string): boolean {
  return ignored.includes(foldNick(nick));
}

/**
 * Index of the buffer for `(networkId, target)`, creating it if needed. *
 * Returns an index rather than a reference on purpose: handing back the object
 * that lives in the state array invites mutating it in place, which would edit
 * the previous state behind the store's back.
 */
function ensureBufferIndex(buffers: SessionBuffer[], networkId: string, target: string): number {
  const id = bufferId(networkId, target);
  const existing = buffers.findIndex((buffer) => buffer.id === id);
  if (existing >= 0) return existing;

  buffers.push({
    id,
    networkId,
    target,
    kind: kindForTarget(target),
    unread: 0,
    highlight: false,
    seen: target === '',
  });

  return buffers.length - 1;
}

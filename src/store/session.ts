/**
 * Live session state: networks, buffers and the lines in them.
 *
 * Everything here is derived from Rust events. The store owns two mappings that
 * the UI reads directly — lines per buffer, and raw traffic per network — plus
 * the bookkeeping the backend has no reason to know about (unread counts, which
 * buffer is on screen).
 *
 * In-memory only for now. M3 moves history into SQLite with paging and search;
 * the caps below are what keeps a long-running session's memory bounded until
 * then.
 */

import { create } from 'zustand';

import type {
  ChannelClosed,
  ChannelSnapshot,
  IncomingMessage,
  MessageKind,
  MessageSegment,
  NetworkStatus,
  NetworkSummary,
  RawTraffic,
  TrafficDirection,
} from '@/lib/ipc';

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
}

/** One raw protocol line, for the server buffer. */
export interface TrafficLine {
  id: string;
  direction: TrafficDirection;
  line: string;
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

/**
 * Decide which buffer a line belongs to.
 *
 * The tricky case is a private message: the protocol addresses it to *us*, but
 * the conversation belongs under the sender's name, otherwise every PM would
 * pile into one buffer named after ourselves.
 */
export function resolveBufferTarget(
  message: Pick<IncomingMessage, 'target' | 'nick' | 'is_self'>,
  selfNick: string | null,
): string {
  if (isChannelName(message.target)) return message.target;

  // Server chatter (joins, quits, mode changes) carries no target.
  if (message.target === '') return '';

  const addressedToUs =
    selfNick !== null && message.target.toLowerCase() === selfNick.toLowerCase();

  // An inbound PM belongs to the sender; our own echo belongs to the recipient.
  if (addressedToUs) return message.is_self ? message.target : message.nick;

  return message.target;
}

function kindForTarget(target: string): BufferKind {
  if (target === '') return 'server';
  return isChannelName(target) ? 'channel' : 'query';
}

/** Whether the text mentions `nick` as a word-ish token. */ export function mentions(
  text: string,
  nick: string | null,
): boolean {
  if (!nick) return false;

  const haystack = text.toLowerCase();
  const needle = nick.toLowerCase();
  if (!haystack.includes(needle)) return false;

  // A crude boundary check: the characters around the match must not be
  // nickname characters. This keeps "bob" from matching "bobcat".
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index === 0 ? '' : haystack[index - 1]!;
    const after = haystack[index + needle.length] ?? '';
    const isNickChar = (ch: string) => /[a-z0-9_\-[\]\\^{}|`]/.test(ch);

    if (!isNickChar(before) && !isNickChar(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }

  return false;
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

  setNetworks: (networks: NetworkSummary[]) => void;
  applyNetworkStatus: (status: NetworkStatus) => void;
  applyMessage: (message: IncomingMessage) => void;
  applyTraffic: (traffic: RawTraffic) => void;
  applyChannelSnapshot: (snapshot: ChannelSnapshot) => void;
  applyChannelClosed: (closed: ChannelClosed) => void;
  selectBuffer: (id: string) => void;
  /** Open a private conversation with `nick`, creating the buffer if needed. */
  openQuery: (networkId: string, nick: string) => void;
  toggleIgnored: (networkId: string, nick: string) => void;
  removeNetwork: (networkId: string) => void;
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
    const selfNick = network?.nick ?? null;

    // An ignored user's lines never enter the store at all: filtering them in
    // the renderer would still let them bump unread counts and, later,
    // notifications.
    if (!message.is_self && isIgnored(state.ignored[message.network_id] ?? [], message.nick)) {
      return;
    }

    const target = resolveBufferTarget(message, selfNick);
    const id = bufferId(message.network_id, target);
    const active = state.activeBufferId === id;

    const line: SessionLine = {
      id: nextId('line'),
      nick: message.nick,
      kind: message.kind,
      text: message.text,
      segments: message.segments,
      timestamp: message.timestamp,
      isSelf: message.is_self,
      highlight: !message.is_self && mentions(message.text, selfNick),
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
}));

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

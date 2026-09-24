import { beforeEach, describe, expect, it } from 'vitest';

import {
  bufferId,
  isChannelName,
  MAX_LINES_PER_BUFFER,
  MAX_TRAFFIC_LINES,
  mentions,
  parseBufferId,
  resetLineSequence,
  resolveBufferTarget,
  useSessionStore,
} from './session';
import type { IncomingMessage, NetworkStatus } from '@/lib/ipc';

const NETWORK = 'irc.libera.chat:6697';

let nextSeq = 1;

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    network_id: NETWORK,
    nick: 'alice',
    kind: 'message',
    target: '#rust',
    text: 'hello',
    segments: [
      {
        text: 'hello',
        style: {
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
        },
      },
    ],
    timestamp: 1_700_000_000,
    is_self: false,
    seq: nextSeq++,
    ...overrides,
  };
}

function status(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    network_id: NETWORK,
    name: 'irc.libera.chat',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    state: 'registered',
    nick: 'me',
    capabilities: [],
    detail: null,
    attempt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useSessionStore.setState({
    networks: [],
    buffers: [],
    lines: {},
    traffic: {},
    activeBufferId: null,
    lastSeq: {},
  });
  resetLineSequence();
  nextSeq = 1;
});

describe('buffer ids', () => {
  it('round trip through encode and decode', () => {
    const id = bufferId('irc.example.net:6697', '#rust');
    expect(id).toBe('irc.example.net:6697|#rust');
    expect(parseBufferId(id)).toEqual({
      networkId: 'irc.example.net:6697',
      target: '#rust',
    });
  });

  it('encode the server buffer with an empty target', () => {
    expect(parseBufferId(bufferId(NETWORK, ''))).toEqual({
      networkId: NETWORK,
      target: '',
    });
  });

  it('survive an id with no separator', () => {
    expect(parseBufferId('garbage')).toEqual({ networkId: 'garbage', target: '' });
  });
});

describe('isChannelName', () => {
  it('recognises the two standard prefixes', () => {
    expect(isChannelName('#rust')).toBe(true);
    expect(isChannelName('&local')).toBe(true);
  });

  it('treats nicknames as conversations', () => {
    expect(isChannelName('alice')).toBe(false);
    expect(isChannelName('')).toBe(false);
  });
});

describe('resolveBufferTarget', () => {
  it('routes a channel message to its channel', () => {
    expect(resolveBufferTarget({ target: '#rust', nick: 'alice', is_self: false }, 'me')).toBe(
      '#rust',
    );
  });

  it('routes server chatter to the server buffer', () => {
    expect(resolveBufferTarget({ target: '', nick: 'alice', is_self: false }, 'me')).toBe('');
  });

  it('files an incoming private message under the sender', () => {
    // The protocol addresses it to us, but the conversation is with alice.
    expect(resolveBufferTarget({ target: 'me', nick: 'alice', is_self: false }, 'me')).toBe(
      'alice',
    );
  });

  it('files our own echoed private message under the recipient', () => {
    expect(resolveBufferTarget({ target: 'bob', nick: 'me', is_self: true }, 'me')).toBe('bob');
  });

  it('matches our nickname case-insensitively', () => {
    expect(resolveBufferTarget({ target: 'ME', nick: 'alice', is_self: false }, 'me')).toBe(
      'alice',
    );
  });

  it('falls back to the target when we do not know our nickname', () => {
    expect(resolveBufferTarget({ target: 'me', nick: 'alice', is_self: false }, null)).toBe('me');
  });
});

describe('mentions', () => {
  it('matches a whole nickname token', () => {
    expect(mentions('hello me how are you', 'me')).toBe(true);
    expect(mentions('me: ping', 'me')).toBe(true);
    expect(mentions('ping (me)', 'me')).toBe(true);
    expect(mentions('well, me too', 'me')).toBe(true);
  });

  it('does not match a nickname inside a longer word', () => {
    expect(mentions('bobcat', 'bob')).toBe(false);
    expect(mentions('something', 'me')).toBe(false);
  });

  it('treats bracket characters as part of a nickname', () => {
    // `[`, `]`, `\`, `^`, `{`, `}`, `|` and backtick are all legal IRC nickname
    // characters, so `[me]` reads as one token rather than a mention of `me`.
    expect(mentions('[me] ping', 'me')).toBe(false);
  });

  it('is false without a nickname', () => {
    expect(mentions('anything', null)).toBe(false);
  });
});

describe('session store', () => {
  it('creates a server buffer when a network appears', () => {
    useSessionStore.getState().applyNetworkStatus(status());

    const state = useSessionStore.getState();
    expect(state.networks).toHaveLength(1);
    expect(state.buffers.map((buffer) => buffer.id)).toEqual([bufferId(NETWORK, '')]);
    expect(state.activeBufferId).toBe(bufferId(NETWORK, ''));
    expect(state.networks[0]?.nick).toBe('me');
  });

  it('updates an existing network rather than duplicating it', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyNetworkStatus(status({ state: 'connecting', nick: null }));

    const state = useSessionStore.getState();
    expect(state.networks).toHaveLength(1);
    expect(state.networks[0]?.state).toBe('connecting');
  });

  it('appends a line and creates the buffer it belongs to', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));

    const state = useSessionStore.getState();
    const id = bufferId(NETWORK, '#rust');
    expect(state.buffers.some((buffer) => buffer.id === id)).toBe(true);
    expect(state.lines[id]).toHaveLength(1);
    expect(state.lines[id]?.[0]?.text).toBe('hello');
  });

  it('counts unread activity only for buffers that are not on screen', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));

    const id = bufferId(NETWORK, '#rust');
    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.unread).toBe(1);
    expect(buffer?.seen).toBe(false);
  });

  it('does not count server chatter as unread activity', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore
      .getState()
      .applyMessage(message({ target: '', kind: 'system', text: 'x joined' }));

    const id = bufferId(NETWORK, '');
    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.unread).toBe(0);
  });

  it('does not count our own echoed lines as unread', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore
      .getState()
      .applyMessage(message({ target: '#rust', is_self: true, nick: 'me' }));

    const id = bufferId(NETWORK, '#rust');
    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.unread).toBe(0);
  });

  it('flags a highlight when our nickname is mentioned', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'me: ping' }));

    const id = bufferId(NETWORK, '#rust');
    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.highlight).toBe(true);
    expect(useSessionStore.getState().lines[id]?.[0]?.highlight).toBe(true);
  });

  it('clears unread when the buffer is opened', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'me: ping' }));

    const id = bufferId(NETWORK, '#rust');
    useSessionStore.getState().selectBuffer(id);

    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.unread).toBe(0);
    expect(buffer?.highlight).toBe(false);
    expect(buffer?.seen).toBe(true);
  });

  it('caps the number of retained lines', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    for (let index = 0; index < MAX_LINES_PER_BUFFER + 50; index += 1) {
      useSessionStore.getState().applyMessage(message({ target: '#rust', text: `line ${index}` }));
    }

    const id = bufferId(NETWORK, '#rust');
    const lines = useSessionStore.getState().lines[id] ?? [];
    expect(lines).toHaveLength(MAX_LINES_PER_BUFFER);
    // The newest line must survive; dropping the tail would be far worse.
    expect(lines.at(-1)?.text).toBe(`line ${MAX_LINES_PER_BUFFER + 49}`);
  });

  it('caps raw traffic per network', () => {
    for (let index = 0; index < MAX_TRAFFIC_LINES + 20; index += 1) {
      useSessionStore.getState().applyTraffic({
        network_id: NETWORK,
        direction: 'inbound',
        line: `PING ${index}`,
        timestamp: 0,
        seq: index + 1,
      });
    }

    expect(useSessionStore.getState().traffic[NETWORK]).toHaveLength(MAX_TRAFFIC_LINES);
  });

  it('ignores a replayed event whose sequence is not newer', () => {
    useSessionStore.getState().applyNetworkStatus(status());

    const live = message({ target: '#rust', seq: 7, text: 'live' });
    useSessionStore.getState().applyMessage(live);

    // The backlog overlaps the live stream; the same line must not appear twice.
    useSessionStore.getState().applyMessage(live);
    useSessionStore.getState().applyMessage(message({ target: '#rust', seq: 5, text: 'older' }));

    const id = bufferId(NETWORK, '#rust');
    const lines = useSessionStore.getState().lines[id] ?? [];
    expect(lines.map((line) => line.text)).toEqual(['live']);
  });

  it('deduplicates replayed traffic independently of messages', () => {
    const traffic = {
      network_id: NETWORK,
      direction: 'inbound' as const,
      line: 'PING :1',
      timestamp: 0,
      seq: 3,
    };

    useSessionStore.getState().applyTraffic(traffic);
    useSessionStore.getState().applyTraffic(traffic);

    expect(useSessionStore.getState().traffic[NETWORK]).toHaveLength(1);
  });

  it('removes every trace of a network', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));
    useSessionStore.getState().applyTraffic({
      network_id: NETWORK,
      direction: 'inbound',
      line: 'PING',
      timestamp: 0,
      seq: 1,
    });

    useSessionStore.getState().removeNetwork(NETWORK);

    const state = useSessionStore.getState();
    expect(state.networks).toHaveLength(0);
    expect(state.buffers).toHaveLength(0);
    expect(Object.keys(state.lines)).toHaveLength(0);
    expect(state.traffic[NETWORK]).toBeUndefined();
    expect(state.activeBufferId).toBeNull();
  });

  it('does not mutate the object held by the previous state', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));

    const id = bufferId(NETWORK, '#rust');
    const before = useSessionStore.getState().buffers.find((buffer) => buffer.id === id);

    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'second' }));

    const after = useSessionStore.getState().buffers.find((buffer) => buffer.id === id);
    expect(before?.unread).toBe(1);
    expect(after?.unread).toBe(2);
    expect(before).not.toBe(after);
  });

  it('closes a buffer, its history and its channel state', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));
    useSessionStore.getState().applyChannelSnapshot({
      network_id: NETWORK,
      name: '#rust',
      topic: null,
      members: [],
      modes: '',
      names_received: true,
      seq: 1,
    });

    const id = bufferId(NETWORK, '#rust');
    useSessionStore.getState().closeBuffer(id);

    const state = useSessionStore.getState();
    expect(state.buffers.some((buffer) => buffer.id === id)).toBe(false);
    expect(state.lines[id]).toBeUndefined();
    expect(state.channels[id]).toBeUndefined();
  });

  it('selects a neighbour when the active buffer is closed', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));
    useSessionStore.getState().applyMessage(message({ target: '#ruby' }));

    const rust = bufferId(NETWORK, '#rust');
    const ruby = bufferId(NETWORK, '#ruby');

    useSessionStore.getState().selectBuffer(ruby);
    useSessionStore.getState().closeBuffer(ruby);

    // Closing the last buffer must not leave the main pane pointing at nothing
    // while other buffers are still open.
    expect(useSessionStore.getState().activeBufferId).toBe(rust);
  });

  it('leaves the selection alone when an inactive buffer is closed', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));

    const server = bufferId(NETWORK, '');
    const rust = bufferId(NETWORK, '#rust');

    useSessionStore.getState().selectBuffer(server);
    useSessionStore.getState().closeBuffer(rust);

    expect(useSessionStore.getState().activeBufferId).toBe(server);
  });

  it('clears a buffer without removing it', () => {
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));

    const id = bufferId(NETWORK, '#rust');
    useSessionStore.getState().clearBuffer(id);

    expect(useSessionStore.getState().lines[id]).toEqual([]);
    expect(useSessionStore.getState().buffers.some((buffer) => buffer.id === id)).toBe(true);
  });
});

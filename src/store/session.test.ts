import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bufferId,
  isChannelName,
  MAX_LINES_PER_BUFFER,
  MAX_TRAFFIC_LINES,
  parseBufferId,
  resetLineSequence,
  useSessionStore,
} from './session';
import type { HistoryMessage, IncomingMessage, NetworkStatus } from '@/lib/ipc';
import { createRule } from '@/lib/highlight';
import { useNotificationsStore } from './notifications';

// The archive is the one thing a store test cannot reach: it lives behind IPC.
// Everything else in the module stays real.
const { loadHistoryPage } = vi.hoisted(() => ({ loadHistoryPage: vi.fn() }));

vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  loadHistory: loadHistoryPage,
}));

const NETWORK = 'irc.libera.chat:6697';

let nextSeq = 1;

/** An unstyled run, the baseline every style is described against. */
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
};

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    network_id: NETWORK,
    nick: 'alice',
    kind: 'message',
    target: '#rust',
    // Follows `target` unless a test is deliberately exercising the case where the
    // two differ, which is exactly a private message. An explicit `buffer` in
    // `overrides` still wins, because the spread below comes last.
    buffer: overrides.target ?? '#rust',
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
    self_nick: null,
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
    channels: {},
    ignored: {},
    history: {},
  });
  // The session store writes into the notification stack, so it has to start
  // every test empty or the counts leak between cases.
  useNotificationsStore.setState({ rules: [], notifications: [] });
  resetLineSequence();
  nextSeq = 1;
  loadHistoryPage.mockReset();
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

  it('flags a highlight from the nick the backend sent, with no network list yet', () => {
    // The shape of a startup race: an auto-connected session's first lines
    // arrive over the event stream before `listNetworks()` has answered, so the
    // store has no network entry to look a nickname up in. The backend already
    // knows the nick — it is what `is_self` was derived from — so it sends it,
    // and the mention must still be highlighted. Getting this wrong is silent:
    // the sequence dedup means those lines are never classified again.
    useNotificationsStore.setState({ rules: [], notifications: [] });

    useSessionStore
      .getState()
      .applyMessage(message({ target: '#rust', text: 'me: ping', self_nick: 'me' }));

    const id = bufferId(NETWORK, '#rust');
    expect(useSessionStore.getState().networks).toHaveLength(0);
    expect(useSessionStore.getState().lines[id]?.[0]?.highlight).toBe(true);

    const buffer = useSessionStore.getState().buffers.find((candidate) => candidate.id === id);
    expect(buffer?.highlight).toBe(true);
  });

  it('raises a banner for that line too', () => {
    useNotificationsStore.setState({ rules: [], notifications: [] });

    useSessionStore
      .getState()
      .applyMessage(message({ target: '#rust', text: 'me: ping', self_nick: 'me' }));

    const notifications = useNotificationsStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.bufferLabel).toBe('#rust');
  });

  it('highlights a line that matches a keyword rule', () => {
    useNotificationsStore.setState({ rules: [createRule('rust')], notifications: [] });
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'a rust question' }));

    const id = bufferId(NETWORK, '#rust');
    expect(useSessionStore.getState().lines[id]?.[0]?.highlight).toBe(true);

    useNotificationsStore.setState({ rules: [] });
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

  it('keeps the parsed formatting a traffic line arrived with', () => {
    useSessionStore.getState().applyTraffic({
      network_id: NETWORK,
      direction: 'inbound',
      line: ':alice!a@h PRIVMSG #rust :\u{0002}bold\u{0002}',
      segments: [
        {
          text: ':alice!a@h PRIVMSG #rust :',
          style: PLAIN_STYLE,
        },
        { text: 'bold', style: { ...PLAIN_STYLE, bold: true } },
      ],
      timestamp: 0,
      seq: 1,
    });

    const line = useSessionStore.getState().traffic[NETWORK]?.[0];
    expect(line?.segments).toHaveLength(2);
    expect(line?.segments[1]?.style.bold).toBe(true);
    // The literal text stays alongside it, so the server buffer can still show
    // what actually arrived.
    expect(line?.line).toBe(':alice!a@h PRIVMSG #rust :\u{0002}bold\u{0002}');
  });

  it('normalises a traffic line that carries no formatting', () => {
    useSessionStore.getState().applyTraffic({
      network_id: NETWORK,
      direction: 'outbound',
      line: 'PING :1',
      timestamp: 0,
      seq: 1,
    });

    // The backend omits the field entirely for plain lines; the store fills it
    // in so the renderer never has to check for both shapes.
    expect(useSessionStore.getState().traffic[NETWORK]?.[0]?.segments).toEqual([]);
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

  it('raises a banner for a highlight in a buffer that is not on screen', () => {
    useNotificationsStore.setState({ rules: [], notifications: [] });
    useSessionStore.getState().applyNetworkStatus(status());

    // The server buffer is active, so the channel is off screen.
    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'me: ping' }));

    const notifications = useNotificationsStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.bufferId).toBe(bufferId(NETWORK, '#rust'));
    expect(notifications[0]?.bufferLabel).toBe('#rust');
    expect(notifications[0]?.nick).toBe('alice');
  });

  it('raises no banner for the buffer being read', () => {
    useNotificationsStore.setState({ rules: [], notifications: [] });
    useSessionStore.getState().applyNetworkStatus(status());

    const id = bufferId(NETWORK, '#rust');
    useSessionStore.getState().applyMessage(message({ target: '#rust' }));
    useSessionStore.getState().selectBuffer(id);

    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'me: ping', seq: 2 }));
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });

  it('raises no banner for a replayed backlog line', () => {
    useNotificationsStore.setState({ rules: [], notifications: [] });
    useSessionStore.getState().applyNetworkStatus(status());

    const live = message({ target: '#rust', text: 'me: ping', seq: 5 });
    useSessionStore.getState().applyMessage(live);
    expect(useNotificationsStore.getState().notifications).toHaveLength(1);

    // The same line arriving again from the backlog is not a new event.
    useSessionStore.getState().applyMessage(live);
    expect(useNotificationsStore.getState().notifications).toHaveLength(1);
  });

  it('raises no banner for an ignored user', () => {
    useNotificationsStore.setState({ rules: [], notifications: [] });
    useSessionStore.getState().applyNetworkStatus(status());
    useSessionStore.getState().toggleIgnored(NETWORK, 'alice');

    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'me: ping' }));
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });
});

describe('history paging', () => {
  const ID = bufferId(NETWORK, '#rust');

  function stored(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
    return {
      id: '1',
      network_id: NETWORK,
      buffer: '#rust',
      nick: 'alice',
      kind: 'message',
      body: 'hello',
      at: 1_700_000_000,
      is_self: false,
      ...overrides,
    };
  }

  /** Newest first, the way the archive returns a page. */
  function page(messages: HistoryMessage[], exhausted: boolean) {
    return { messages, exhausted };
  }

  beforeEach(() => {
    useSessionStore.getState().applyNetworkStatus(status());
  });

  it('fills an empty buffer from the archive, oldest first', async () => {
    loadHistoryPage.mockResolvedValue(
      page([stored({ id: '1', body: 'oldest' }), stored({ id: '2', body: 'newest' })], true),
    );

    await useSessionStore.getState().loadHistory(ID);

    const lines = useSessionStore.getState().lines[ID] ?? [];
    expect(lines.map((line) => line.text)).toEqual(['oldest', 'newest']);
    expect(lines[0]?.historyId).toBe('1');
    expect(useSessionStore.getState().history[ID]?.exhausted).toBe(true);
  });

  it('leaves a buffer that already has lines alone', async () => {
    useSessionStore.getState().applyMessage(message({ target: '#rust', text: 'live' }));

    await useSessionStore.getState().loadHistory(ID);

    // Whatever is in memory is newer than the archive's newest page, so loading
    // it could only add duplicates.
    expect(loadHistoryPage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().lines[ID]?.map((line) => line.text)).toEqual(['live']);
  });

  it('asks for the page before the oldest line on screen', async () => {
    useSessionStore.setState({
      lines: {
        [ID]: [
          {
            id: 'line-1',
            nick: 'alice',
            kind: 'message',
            text: 'oldest on screen',
            segments: [],
            timestamp: 1_700_000_050,
            isSelf: false,
            highlight: false,
            historyId: '77',
          },
        ],
      },
    });
    loadHistoryPage.mockResolvedValue(page([stored({ id: '50', body: 'even older' })], false));

    await useSessionStore.getState().loadOlder(ID);

    expect(loadHistoryPage).toHaveBeenCalledWith(
      NETWORK,
      '#rust',
      { at: 1_700_000_050, id: '77' },
      100,
    );
    const lines = useSessionStore.getState().lines[ID] ?? [];
    expect(lines.map((line) => line.text)).toEqual(['even older', 'oldest on screen']);
  });

  it('does not show a line twice when the archive overlaps what arrived live', async () => {
    // The shape of the race: a page is requested, and the same lines arrive over
    // the event stream before the answer does.
    useSessionStore
      .getState()
      .applyMessage(message({ target: '#rust', text: 'both places', timestamp: 1_700_000_000 }));
    loadHistoryPage.mockResolvedValue(
      page([stored({ id: '9', body: 'both places', at: 1_700_000_000 })], false),
    );

    // Force the load even though the buffer is no longer empty, which is what the
    // store would do if the page had been in flight when the line arrived.
    await useSessionStore.getState().loadOlder(ID);

    const lines = useSessionStore.getState().lines[ID] ?? [];
    expect(lines.filter((line) => line.text === 'both places')).toHaveLength(1);
  });

  it('stops asking once the beginning has been reached', async () => {
    loadHistoryPage.mockResolvedValue(page([stored({ body: 'only line' })], true));

    await useSessionStore.getState().loadHistory(ID);
    await useSessionStore.getState().loadOlder(ID);

    expect(loadHistoryPage).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().history[ID]?.exhausted).toBe(true);
  });

  it('surfaces a failure without disturbing what is on screen', async () => {
    loadHistoryPage.mockRejectedValue(new Error('database is locked'));

    await useSessionStore.getState().loadHistory(ID);

    const state = useSessionStore.getState();
    expect(state.history[ID]?.error).toContain('database is locked');
    expect(state.history[ID]?.loading).toBe(false);
    expect(state.lines[ID] ?? []).toEqual([]);
  });

  it('does not treat loaded history as unread activity', async () => {
    // A conversation opened by hand has a buffer and no lines, which is when the
    // newest page is what fills it.
    useSessionStore.getState().openQuery(NETWORK, 'alice');
    const query = bufferId(NETWORK, 'alice');
    loadHistoryPage.mockResolvedValue(
      page(
        [
          {
            id: '1',
            network_id: NETWORK,
            buffer: 'alice',
            nick: 'alice',
            kind: 'message',
            body: 'me: ping',
            at: 1_700_000_000,
            is_self: false,
          },
        ],
        true,
      ),
    );

    await useSessionStore.getState().loadHistory(query);

    const buffer = useSessionStore.getState().buffers.find((entry) => entry.id === query);
    expect(buffer?.unread).toBe(0);
    expect(buffer?.highlight).toBe(false);
  });

  it('pages back from a live line, which has no row id yet', async () => {
    // The state after a restart plus a rejoin: the buffer holds live lines, the
    // archive holds everything before them. Waiting for a row id would make
    // "scroll up" do nothing at all.
    useSessionStore
      .getState()
      .applyMessage(message({ target: '#rust', text: 'live line', timestamp: 1_700_000_100 }));
    loadHistoryPage.mockResolvedValue(page([stored({ id: '3', body: 'archived', at: 5 })], true));

    await useSessionStore.getState().loadOlder(ID);

    expect(loadHistoryPage).toHaveBeenCalledWith(
      NETWORK,
      '#rust',
      { at: 1_700_000_100, id: '0' },
      100,
    );
    const lines = useSessionStore.getState().lines[ID] ?? [];
    expect(lines.map((line) => line.text)).toEqual(['archived', 'live line']);
  });

  it('recomputes a highlight from the archive against the current rules', async () => {
    useNotificationsStore.setState({
      rules: [createRule('ping')],
      notifications: [],
    });
    useSessionStore.getState().openQuery(NETWORK, 'alice');
    const query = bufferId(NETWORK, 'alice');
    loadHistoryPage.mockResolvedValue(
      page(
        [
          {
            id: '1',
            network_id: NETWORK,
            buffer: 'alice',
            nick: 'alice',
            kind: 'message',
            body: 'me: ping',
            at: 1_700_000_000,
            is_self: false,
          },
        ],
        true,
      ),
    );

    await useSessionStore.getState().loadHistory(query);

    expect(useSessionStore.getState().lines[query]?.[0]?.highlight).toBe(true);
  });
});

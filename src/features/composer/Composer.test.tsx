import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { ChannelSnapshot } from '@/lib/ipc';
import { bufferId, useSessionStore } from '@/store/session';
import { useNotificationsStore } from '@/store/notifications';
import { useUiStore } from '@/store/ui';

import { Composer } from './Composer';
import { useComposerStore } from './composerStore';

// Pin the language: the assertions below read rendered labels, and jsdom's
// `navigator.language` is not something a test should depend on.
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';
const CHANNEL = bufferId(NETWORK, '#ircuit');
const SERVER = bufferId(NETWORK, '');

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  const resolved = () => vi.fn().mockResolvedValue(undefined);

  return {
    ...actual,
    sendMessage: resolved(),
    sendNotice: resolved(),
    sendRawCommand: resolved(),
    joinChannel: resolved(),
    partChannel: resolved(),
    setNick: resolved(),
    setTopic: resolved(),
    setAway: resolved(),
    setMode: resolved(),
    kickUser: resolved(),
    inviteUser: resolved(),
    whois: resolved(),
    disconnectNetwork: resolved(),
  };
});

const ipc = await import('@/lib/ipc');

function snapshot(): ChannelSnapshot {
  return {
    network_id: NETWORK,
    name: '#ircuit',
    topic: null,
    members: [
      { nick: 'ircuit', prefix: '@', away: false, account: null },
      { nick: 'alice', prefix: null, away: false, account: null },
      { nick: 'alicia', prefix: null, away: false, account: null },
      { nick: 'bob', prefix: null, away: false, account: null },
    ],
    modes: '',
    names_received: true,
    seq: 1,
  };
}

/** Put a registered channel on screen and return the textarea. */
function seed(): HTMLTextAreaElement {
  useSessionStore.setState({
    networks: [
      {
        id: NETWORK,
        name: '127.0.0.1',
        host: '127.0.0.1',
        port: 6667,
        tls: false,
        state: 'registered',
        nick: 'ircuit',
        capabilities: [],
        detail: null,
        attempt: 1,
      },
    ],
    buffers: [
      {
        id: SERVER,
        networkId: NETWORK,
        target: '',
        kind: 'server',
        unread: 0,
        highlight: false,
        seen: true,
      },
      {
        id: CHANNEL,
        networkId: NETWORK,
        target: '#ircuit',
        kind: 'channel',
        unread: 0,
        highlight: false,
        seen: true,
      },
    ],
    lines: {},
    traffic: {},
    activeBufferId: CHANNEL,
    lastSeq: {},
    channels: { [CHANNEL]: snapshot() },
    ignored: {},
  });

  render(<Composer />);
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

/** Type into the textarea the way a user would. */
function type(box: HTMLTextAreaElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
}

/**
 * Switch buffers the way the store does.
 *
 * Wrapped in `act` because the composer loads the new buffer's draft in an
 * effect; without flushing it here, the effect would run after the next
 * `type()` and wipe out what the test just typed.
 */
async function switchTo(id: string) {
  await act(async () => {
    useSessionStore.setState({ activeBufferId: id });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useComposerStore.setState({ drafts: {}, history: {} });
  useNotificationsStore.setState({ rules: [], notifications: [] });
  useUiStore.setState({ sendOnEnter: true });
});

describe('Composer', () => {
  it('sends a message on Enter', async () => {
    const box = seed();
    type(box, 'hello everyone');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.sendMessage).toHaveBeenCalledWith(NETWORK, '#ircuit', 'hello everyone');
    });

    expect(box.value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    const box = seed();
    type(box, 'not yet');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(box.value).toBe('not yet');
  });

  it('swaps the keys when sendOnEnter is off', async () => {
    useUiStore.setState({ sendOnEnter: false });

    const box = seed();
    type(box, 'sent with ctrl');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(ipc.sendMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(ipc.sendMessage).toHaveBeenCalledWith(NETWORK, '#ircuit', 'sent with ctrl');
    });
  });

  it('sends plain text as a raw command on the server buffer', async () => {
    const box = seed();
    await switchTo(SERVER);
    type(box, 'WHOIS alice');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.sendRawCommand).toHaveBeenCalledWith(NETWORK, 'WHOIS alice');
    });
    expect(ipc.sendMessage).not.toHaveBeenCalled();
  });

  it('completes a nickname with Tab and addresses it', async () => {
    const box = seed();
    type(box, 'bo');
    fireEvent.keyDown(box, { key: 'Tab' });

    // Completion is applied with the caret at the end, so React's committed
    // value is what we assert on.
    await waitFor(() => expect(box.value).toBe('bob: '));
  });

  it('cycles through nicknames on repeated Tab', async () => {
    const box = seed();
    type(box, 'al');

    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(box.value).toBe('alic'));

    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(box.value).toBe('alice: '));

    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(box.value).toBe('alicia: '));
  });

  it('completes a command name with Tab', async () => {
    const box = seed();
    type(box, '/jo');
    fireEvent.keyDown(box, { key: 'Tab' });

    await waitFor(() => expect(box.value).toBe('/join'));
  });

  it('offers command help while a command name is being typed', async () => {
    const box = seed();
    type(box, '/jo');

    expect(screen.getByLabelText('匹配的命令')).toBeInTheDocument();
    expect(screen.getByText(/加入频道/)).toBeInTheDocument();
  });

  it('hides the command help once the arguments start', async () => {
    const box = seed();
    type(box, '/join #ircuit');

    expect(screen.queryByLabelText('匹配的命令')).not.toBeInTheDocument();
  });

  it('walks the history with the arrow keys', async () => {
    const box = seed();

    type(box, 'first');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));

    type(box, 'second');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(2));

    // Up walks back through what was sent, newest first.
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(box.value).toBe('second'));

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(box.value).toBe('first'));

    // Down returns to the present.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(box.value).toBe('second'));

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('keeps a draft per buffer', async () => {
    const box = seed();
    type(box, 'work in progress');

    // Switching away must not lose it, and switching back must restore it.
    await switchTo(SERVER);
    expect(box.value).toBe('');

    await switchTo(CHANNEL);
    expect(box.value).toBe('work in progress');
  });

  it('dispatches /me as an action', async () => {
    const box = seed();
    type(box, '/me waves');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.sendMessage).toHaveBeenCalledWith(
        NETWORK,
        '#ircuit',
        '\u{0001}ACTION waves\u{0001}',
      );
    });
  });

  it('dispatches /topic to the current channel', async () => {
    const box = seed();
    type(box, '/topic hello world');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.setTopic).toHaveBeenCalledWith(NETWORK, '#ircuit', 'hello world');
    });
  });

  it('turns /op into a mode change', async () => {
    const box = seed();
    type(box, '/op bob');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.setMode).toHaveBeenCalledWith(NETWORK, '#ircuit', '+o', ['bob']);
    });
  });

  it('refuses a channel command outside a channel', async () => {
    const box = seed();
    await switchTo(SERVER);
    type(box, '/topic hi');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('该命令需要在一个频道里使用');
    });
    expect(ipc.setTopic).not.toHaveBeenCalled();
  });

  it('reports an unknown command instead of sending it', async () => {
    const box = seed();
    type(box, '/frobnicate');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('未知命令：/frobnicate');
    });
    expect(ipc.sendMessage).not.toHaveBeenCalled();
  });

  it('sends text beginning with a slash when it is escaped', async () => {
    const box = seed();
    type(box, '//join is a command');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.sendMessage).toHaveBeenCalledWith(NETWORK, '#ircuit', '/join is a command');
    });
  });

  it('ignores someone locally without telling the server', async () => {
    const box = seed();
    type(box, '/ignore bob');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(useSessionStore.getState().ignored[NETWORK]).toEqual(['bob']);
    });
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(ipc.sendRawCommand).not.toHaveBeenCalled();
  });

  it('toggles /set sendOnEnter', async () => {
    const box = seed();
    type(box, '/set sendOnEnter off');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(useUiStore.getState().sendOnEnter).toBe(false));
  });

  it('adds and removes a highlight word', async () => {
    const box = seed();

    type(box, '/highlight rust');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(useNotificationsStore.getState().rules.map((rule) => rule.pattern)).toEqual(['rust']);
    });

    type(box, '/unhighlight rust');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(useNotificationsStore.getState().rules).toHaveLength(0));
  });

  it('says so when there are no highlight words yet', async () => {
    const box = seed();
    type(box, '/highlight');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/还没有高亮词/)).toBeInTheDocument();
    });
  });

  it('closes a query buffer but only parts a channel', async () => {
    const box = seed();

    const queryId = bufferId(NETWORK, 'bob');
    await act(async () => {
      useSessionStore.setState((state) => ({
        buffers: [
          ...state.buffers,
          {
            id: queryId,
            networkId: NETWORK,
            target: 'bob',
            kind: 'query' as const,
            unread: 0,
            highlight: false,
            seen: true,
          },
        ],
      }));
    });
    await switchTo(queryId);

    type(box, '/close');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(useSessionStore.getState().buffers.some((b) => b.id === queryId)).toBe(false);
    });
    expect(ipc.partChannel).not.toHaveBeenCalled();
  });

  it('clears a buffer without removing it', async () => {
    const box = seed();

    await act(async () => {
      useSessionStore.setState((state) => ({
        lines: {
          ...state.lines,
          [CHANNEL]: [
            {
              id: 'line-1',
              nick: 'alice',
              kind: 'message' as const,
              text: 'hi',
              segments: [],
              timestamp: 0,
              isSelf: false,
              highlight: false,
            },
          ],
        },
      }));
    });

    type(box, '/clear');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(useSessionStore.getState().lines[CHANNEL]).toEqual([]);
      expect(useSessionStore.getState().buffers.some((b) => b.id === CHANNEL)).toBe(true);
    });
  });
});

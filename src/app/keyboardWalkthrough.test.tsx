import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';
import { useComposerStore } from '@/features/composer/composerStore';
import { useNotificationsStore } from '@/store/notifications';
import { useUiStore } from '@/store/ui';

import { App } from './App';

/**
 * The M2 acceptance criterion: every core operation is reachable from the
 * keyboard alone.
 *
 * Nothing in this file touches the mouse. Each case is one operation a user
 * actually performs — switch conversation, send, complete a nickname, run a
 * command, find something — driven the way a keyboard user drives it, so a
 * regression that only shows up in the interaction between the shortcut map,
 * the palette and the composer is caught here rather than by hand.
 */

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

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
    // `listNetworks` is deliberately *not* stubbed to resolve: the bridge would
    // then overwrite the seeded networks with an empty list, and every
    // composer assertion below would be testing a disabled input box.
  };
});

const ipc = await import('@/lib/ipc');

const NETWORK = '127.0.0.1:6667';

/** Press a key on the window, the way the global map sees it. */
function press(init: KeyboardEventInit, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init }),
    );
  });
}

/** Three buffers: the server console and two conversations. */
function seed() {
  const server = bufferId(NETWORK, '');
  const rust = bufferId(NETWORK, '#rust');
  const bob = bufferId(NETWORK, 'bob');

  useSessionStore.setState({
    networks: [
      {
        id: NETWORK,
        name: 'libera',
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
        id: server,
        networkId: NETWORK,
        target: '',
        kind: 'server',
        unread: 0,
        highlight: false,
        seen: true,
      },
      {
        id: rust,
        networkId: NETWORK,
        target: '#rust',
        kind: 'channel',
        unread: 0,
        highlight: false,
        seen: true,
      },
      {
        id: bob,
        networkId: NETWORK,
        target: 'bob',
        kind: 'query',
        unread: 0,
        highlight: false,
        seen: true,
      },
    ],
    lines: {},
    traffic: {},
    activeBufferId: rust,
    lastSeq: {},
    channels: {
      [rust]: {
        network_id: NETWORK,
        name: '#rust',
        topic: null,
        members: [
          { nick: 'ircuit', prefix: '@', away: false, account: null },
          { nick: 'bob', prefix: null, away: false, account: null },
        ],
        modes: '',
        names_received: true,
        seq: 1,
      },
    },
    ignored: {},
  });

  return { server, rust, bob };
}

/** Type into the composer the way a keyboard user does. */
function type(text: string) {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
}

beforeEach(() => {
  vi.clearAllMocks();
  useComposerStore.setState({ drafts: {}, history: {}, focusToken: 0 });
  useNotificationsStore.setState({ rules: [], notifications: [] });
  useUiStore.setState({
    paletteOpen: false,
    connectionDialogOpen: false,
    sidebarOpen: true,
    membersOpen: true,
    sendOnEnter: true,
  });
});

describe('keyboard walkthrough', () => {
  it('finds and runs an action through the palette', async () => {
    seed();
    render(<App />);

    press({ key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '添加网络' } });
    press({ key: 'Enter' }, screen.getByRole('combobox'));

    expect(useUiStore.getState().connectionDialogOpen).toBe(true);
    // And the dialog is dismissible from the keyboard too.
    press({ key: 'Escape' });
    await waitFor(() => expect(useUiStore.getState().connectionDialogOpen).toBe(false));
  });

  it('moves between conversations without touching the sidebar', () => {
    const { rust, bob } = seed();
    render(<App />);

    press({ key: 'PageDown', ctrlKey: true });
    expect(useSessionStore.getState().activeBufferId).toBe(bob);

    press({ key: 'PageUp', ctrlKey: true });
    expect(useSessionStore.getState().activeBufferId).toBe(rust);

    // And straight to a numbered slot.
    press({ key: '1', ctrlKey: true });
    expect(useSessionStore.getState().activeBufferId).toBe(bufferId(NETWORK, ''));
  });

  it('reclaims screen space and gives it back', () => {
    seed();
    render(<App />);

    press({ key: 'b', ctrlKey: true });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    press({ key: 'b', ctrlKey: true });
    expect(screen.getByRole('navigation')).toBeInTheDocument();

    press({ key: 'B', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('button', { name: '展开成员栏' })).toBeInTheDocument();
  });

  it('closes a conversation from the keyboard', async () => {
    const { bob } = seed();
    render(<App />);

    act(() => {
      useSessionStore.getState().selectBuffer(bob);
    });
    press({ key: 'w', ctrlKey: true });

    await waitFor(() => {
      expect(useSessionStore.getState().buffers.some((buffer) => buffer.id === bob)).toBe(false);
    });
  });

  it('completes a nickname, sends, and recalls the line', async () => {
    seed();
    render(<App />);

    const box = type('bo');
    press({ key: 'Tab' }, box);
    await waitFor(() => expect(box.value).toBe('bob: '));

    type('bob: are you there?');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(ipc.sendMessage).toHaveBeenCalledWith(NETWORK, '#rust', 'bob: are you there?');
    });

    // Up arrow brings the line back; Enter sends it again without retyping.
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(box.value).toBe('bob: are you there?'));

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(2));
  });

  it('joins a channel by typing a slash command', async () => {
    seed();
    render(<App />);

    const box = type('/join rust');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(ipc.joinChannel).toHaveBeenCalledWith(NETWORK, '#rust'));
  });

  it('adds a highlight word without a settings screen', async () => {
    seed();
    render(<App />);

    const box = type('/highlight rust');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(useNotificationsStore.getState().rules.map((rule) => rule.pattern)).toEqual(['rust']);
    });
  });

  it('reads command help from the keyboard', async () => {
    seed();
    render(<App />);

    const box = type('/help topic');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/\/topic/)).toBeInTheDocument();
    });
  });

  it('jumps to the next highlighted conversation', async () => {
    seed();
    // Two conversations want attention; the palette action walks them.
    act(() => {
      useSessionStore.setState((state) => ({
        buffers: state.buffers.map((buffer) =>
          buffer.kind === 'server' ? buffer : { ...buffer, unread: 1, highlight: true },
        ),
      }));
    });

    render(<App />);

    press({ key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '高亮会话' } });
    press({ key: 'Enter' }, screen.getByRole('combobox'));

    expect(useSessionStore.getState().activeBufferId).toBe(bufferId(NETWORK, 'bob'));
  });

  it('dismisses the palette on Escape and leaves nothing focused behind', () => {
    seed();
    render(<App />);

    press({ key: 'k', ctrlKey: true });
    press({ key: 'Escape' }, screen.getByRole('combobox'));

    expect(useUiStore.getState().paletteOpen).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

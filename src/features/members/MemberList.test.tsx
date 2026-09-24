import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

import { MemberList } from './MemberList';
import { bufferId, useSessionStore } from '@/store/session';
import type { ChannelSnapshot, MemberInfo } from '@/lib/ipc';

// Pin the language: the assertions below read the rendered labels, and jsdom's
// `navigator.language` is not something a test should depend on.
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    whois: vi.fn().mockResolvedValue(undefined),
    setMemberMode: vi.fn().mockResolvedValue(undefined),
    kickUser: vi.fn().mockResolvedValue(undefined),
    banUser: vi.fn().mockResolvedValue(undefined),
  };
});

const ipc = await import('@/lib/ipc');

function member(nick: string, prefix: string | null): MemberInfo {
  return { nick, prefix, away: false, account: null };
}

function snapshot(members: MemberInfo[]): ChannelSnapshot {
  return {
    network_id: NETWORK,
    name: '#ircuit',
    topic: null,
    members,
    modes: '',
    names_received: true,
    seq: 1,
  };
}

/** Put a channel with the given members on screen and return nothing useful. */
function seed(members: MemberInfo[], selfNick = 'ircuit') {
  const id = bufferId(NETWORK, '#ircuit');

  useSessionStore.setState({
    networks: [
      {
        id: NETWORK,
        name: '127.0.0.1',
        host: '127.0.0.1',
        port: 6667,
        tls: false,
        state: 'registered',
        nick: selfNick,
        capabilities: [],
        detail: null,
        attempt: 1,
      },
    ],
    buffers: [
      {
        id,
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
    activeBufferId: id,
    lastSeq: {},
    channels: { [id]: snapshot(members) },
    ignored: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemberList', () => {
  it('shows the members the server reported, with their prefixes', () => {
    seed([member('ircuit', '@'), member('bob', '+'), member('alice', null)]);
    render(<MemberList onCollapse={() => {}} />);

    expect(screen.getByText('ircuit')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();

    // The count comes from the snapshot rather than being recomputed.
    expect(screen.getByText(/3/)).toBeInTheDocument();
  });

  it('says so while the member list is still arriving', () => {
    seed([member('ircuit', '@')]);
    useSessionStore.setState((state) => ({
      channels: {
        ...state.channels,
        [bufferId(NETWORK, '#ircuit')]: { ...snapshot([]), names_received: false },
      },
    }));

    render(<MemberList onCollapse={() => {}} />);
    // An empty list before NAMES arrives means "not asked yet", not "empty".
    expect(screen.getByText(/正在获取成员列表/)).toBeInTheDocument();
  });

  it('opens a menu on right-click with the member actions', () => {
    seed([member('ircuit', '@'), member('bob', '+')]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /WHOIS/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /私聊/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /设为操作员/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /取消语音/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /踢出频道/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /封禁/ })).toBeInTheDocument();
  });

  it('offers to remove a prefix the member already holds', () => {
    seed([member('ircuit', '@'), member('alice', '@')]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('alice'));
    expect(screen.getByRole('menuitem', { name: /取消操作员/ })).toBeInTheDocument();
  });

  it('disables the actions that would apply to ourselves', () => {
    seed([member('ircuit', '@'), member('bob', null)]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('ircuit'));

    expect(screen.getByRole('menuitem', { name: /私聊/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /踢出频道/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /封禁/ })).toBeDisabled();
  });

  it('disables moderation for someone without operator rights', () => {
    // A plain member cannot kick or ban, and offering it would only produce a
    // refusal from the server.
    seed([member('ircuit', null), member('bob', null)]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));

    expect(screen.getByRole('menuitem', { name: /踢出频道/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /封禁/ })).toBeDisabled();
    // Whois and a conversation are always available.
    expect(screen.getByRole('menuitem', { name: /WHOIS/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /私聊/ })).toBeEnabled();
  });

  it('sends the command the menu item names', () => {
    seed([member('ircuit', '@'), member('bob', null)]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: /设为操作员/ }));

    expect(ipc.setMemberMode).toHaveBeenCalledWith(NETWORK, '#ircuit', 'bob', 'o', true);
  });

  it('closes the menu after an action runs', () => {
    seed([member('ircuit', '@'), member('bob', null)]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: /WHOIS/ }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(ipc.whois).toHaveBeenCalledWith(NETWORK, 'bob');
  });

  it('closes the menu on Escape', () => {
    seed([member('ircuit', '@'), member('bob', null)]);
    render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('toggles an ignore, and shows the member as struck through', () => {
    seed([member('ircuit', '@'), member('bob', null)]);
    const { rerender } = render(<MemberList onCollapse={() => {}} />);

    fireEvent.contextMenu(screen.getByText('bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: '忽略此人' }));

    expect(useSessionStore.getState().ignored[NETWORK]).toEqual(['bob']);

    rerender(<MemberList onCollapse={() => {}} />);
    // The row itself is struck through, not just the nickname span.
    expect(screen.getByRole('button', { name: 'bob' }).className).toContain('line-through');

    // And back again: the menu now offers the inverse.
    fireEvent.contextMenu(screen.getByText('bob'));
    expect(screen.getByRole('menuitem', { name: '取消忽略' })).toBeInTheDocument();
  });

  it('explains itself when the buffer is not a channel', () => {
    seed([member('ircuit', '@')]);
    useSessionStore.setState({ buffers: [], activeBufferId: null });

    render(<MemberList onCollapse={() => {}} />);
    expect(screen.getByText(/这里没有成员列表/)).toBeInTheDocument();
  });
});

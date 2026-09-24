import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';

import { BufferTabs } from './BufferTabs';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, partChannel: vi.fn().mockResolvedValue(undefined) };
});

const ipc = await import('@/lib/ipc');

/** One network with a server buffer, a channel and a conversation. */
function seed(options: { unread?: number; highlight?: boolean; active?: string } = {}) {
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
        unread: options.unread ?? 0,
        highlight: options.highlight ?? false,
        seen: false,
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
    activeBufferId: options.active ?? rust,
    lastSeq: {},
    channels: {},
    ignored: {},
  });

  return { server, rust, bob };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ networks: [], buffers: [], activeBufferId: null });
});

describe('BufferTabs', () => {
  it('renders one tab per buffer, in sidebar order', () => {
    seed();
    render(<BufferTabs />);

    const tabs = screen.getAllByRole('tab');
    // Server, then channels, then conversations — the same order the sidebar
    // and Ctrl+PageDown use.
    expect(tabs.map((tab) => tab.textContent)).toEqual(['服务器', '#rust', 'bob']);
  });

  it('marks the buffer being read', () => {
    const { rust } = seed();
    render(<BufferTabs />);

    expect(screen.getByRole('tab', { name: /#rust/ })).toHaveAttribute('aria-selected', 'true');
    expect(useSessionStore.getState().activeBufferId).toBe(rust);
  });

  it('switches buffer when a tab is used', () => {
    const { bob } = seed();
    render(<BufferTabs />);

    fireEvent.click(screen.getByRole('tab', { name: /bob/ }));

    expect(useSessionStore.getState().activeBufferId).toBe(bob);
  });

  it('shows the unread count on the tab that is waiting', () => {
    // The count belongs to a buffer the user is *not* reading.
    seed({ unread: 4, highlight: true, active: bufferId(NETWORK, '') });
    render(<BufferTabs />);

    expect(screen.getByLabelText('4 条未读')).toBeInTheDocument();
  });

  it('hides the count on the tab being read', () => {
    seed({ unread: 4 });
    render(<BufferTabs />);

    // The active tab is right there; a badge on it would be noise.
    expect(screen.queryByLabelText('4 条未读')).not.toBeInTheDocument();
  });

  it('names the network in the tab tooltip', () => {
    seed();
    render(<BufferTabs />);

    // With more than one network, the label alone does not say which one.
    expect(screen.getByRole('tab', { name: /#rust/ })).toHaveAttribute('title', 'libera · #rust');
  });

  it('closes a conversation without leaving the client', async () => {
    const { bob } = seed();
    render(<BufferTabs />);

    fireEvent.click(screen.getByRole('button', { name: '关闭 bob' }));

    await waitFor(() => {
      expect(useSessionStore.getState().buffers.some((buffer) => buffer.id === bob)).toBe(false);
    });
  });

  it('parts the channel rather than forgetting it', async () => {
    seed();
    render(<BufferTabs />);

    fireEvent.click(screen.getByRole('button', { name: '关闭 #rust' }));

    // A channel belongs to the server, so closing the tab means leaving it.
    await waitFor(() => expect(ipc.partChannel).toHaveBeenCalledWith(NETWORK, '#rust', null));
  });

  it('renders nothing when there is nothing open', () => {
    render(<BufferTabs />);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

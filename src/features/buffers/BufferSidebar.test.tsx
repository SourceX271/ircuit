import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import { BufferSidebar } from './BufferSidebar';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, disconnectNetwork: vi.fn().mockResolvedValue(undefined) };
});

const ipc = await import('@/lib/ipc');

function seed(options: { unread?: number; highlight?: boolean } = {}) {
  const rust = bufferId(NETWORK, '#rust');

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
        id: bufferId(NETWORK, ''),
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
    ],
    lines: {},
    traffic: {},
    activeBufferId: bufferId(NETWORK, ''),
    lastSeq: {},
    channels: {},
    ignored: {},
  });

  return { rust };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ networks: [], buffers: [], activeBufferId: null });
  useUiStore.setState({ collapsedNetworks: [] });
});

describe('BufferSidebar', () => {
  it('groups buffers under their network', () => {
    seed();
    render(<BufferSidebar onAddNetwork={() => {}} onCollapse={() => {}} />);

    expect(screen.getByRole('heading', { name: 'libera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#rust/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /服务器/ })).toBeInTheDocument();
  });

  it('folds a network away and keeps the count visible', () => {
    seed({ unread: 3, highlight: true });
    render(<BufferSidebar onAddNetwork={() => {}} onCollapse={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '折叠 libera' }));

    expect(screen.queryByRole('button', { name: /#rust/ })).not.toBeInTheDocument();
    // Folding must not become a way to lose messages.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(useUiStore.getState().collapsedNetworks).toEqual([NETWORK]);
  });

  it('unfolds again', () => {
    seed();
    render(<BufferSidebar onAddNetwork={() => {}} onCollapse={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '折叠 libera' }));
    expect(screen.queryByRole('button', { name: /#rust/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开 libera' }));
    expect(screen.getByRole('button', { name: /#rust/ })).toBeInTheDocument();
  });

  it('adds a network from the header', () => {
    seed();
    const onAddNetwork = vi.fn();
    render(<BufferSidebar onAddNetwork={onAddNetwork} onCollapse={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '添加网络' }));

    expect(onAddNetwork).toHaveBeenCalled();
  });

  it('collapses the whole column from its header', () => {
    seed();
    const onCollapse = vi.fn();
    render(<BufferSidebar onAddNetwork={() => {}} onCollapse={onCollapse} />);

    fireEvent.click(screen.getByRole('button', { name: '收起网络栏' }));

    expect(onCollapse).toHaveBeenCalled();
  });

  it('disconnects a network and forgets it', async () => {
    seed();
    render(<BufferSidebar onAddNetwork={() => {}} onCollapse={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '断开' }));

    await waitFor(() => expect(ipc.disconnectNetwork).toHaveBeenCalledWith(NETWORK));
    await waitFor(() => expect(useSessionStore.getState().networks).toHaveLength(0));
  });
});

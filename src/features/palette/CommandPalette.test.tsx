import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerStore } from '@/features/composer/composerStore';
import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import { CommandPalette, nextLanguage, nextTheme } from './CommandPalette';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    disconnectNetwork: vi.fn().mockResolvedValue(undefined),
    partChannel: vi.fn().mockResolvedValue(undefined),
  };
});

/** Two buffers on one network, which is all the palette needs to browse. */
function seed() {
  const server = bufferId(NETWORK, '');
  const channel = bufferId(NETWORK, '#rust');

  useSessionStore.setState({
    networks: [
      {
        id: NETWORK,
        name: 'libera',
        host: '127.0.0.1',
        port: 6667,
        tls: false,
        state: 'registered',
        nick: 'me',
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
        id: channel,
        networkId: NETWORK,
        target: '#rust',
        kind: 'channel',
        unread: 0,
        highlight: false,
        seen: true,
      },
    ],
    lines: {},
    traffic: {},
    activeBufferId: channel,
    lastSeq: {},
    channels: {},
    ignored: {},
  });

  return { server, channel };
}

async function open() {
  await act(async () => {
    useUiStore.getState().setPaletteOpen(true);
  });
}

beforeEach(() => {
  useComposerStore.setState({ drafts: {}, history: {}, focusToken: 0 });
  useUiStore.setState({
    paletteOpen: false,
    connectionDialogOpen: false,
    sidebarOpen: true,
    membersOpen: true,
    themeMode: 'system',
    language: 'zh-CN',
  });
});

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    seed();
    render(<CommandPalette />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists buffers, actions and commands in groups', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('会话')).toBeInTheDocument();
    expect(screen.getByText('操作')).toBeInTheDocument();
    expect(screen.getByText('命令')).toBeInTheDocument();

    expect(screen.getByRole('option', { name: /#rust/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\/join/ })).toBeInTheDocument();
  });

  it('filters as the user types', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'quit' } });

    expect(screen.getByRole('option', { name: /\/quit/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /\/join/ })).not.toBeInTheDocument();
  });

  it('matches hidden keywords too', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    // "断开" only appears in the /quit description, not in any label.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '断开网络' } });

    expect(screen.getByRole('option', { name: /\/quit/ })).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzzz' } });
    expect(screen.getByText('没有匹配项')).toBeInTheDocument();
  });

  it('jumps to a buffer on Enter', async () => {
    const { server } = seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '服务器' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(useSessionStore.getState().activeBufferId).toBe(server);
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('runs the selection made with the arrow keys', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '会话' } });

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The second entry under 会话 is the channel buffer, so that is what got
    // selected and run.
    expect(useSessionStore.getState().activeBufferId).toBe(bufferId(NETWORK, '#rust'));
  });

  it('toggles a layout action', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '收起网络栏' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('inserts a command into the composer instead of running it', async () => {
    const { channel } = seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'join' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    // Most commands need arguments, so the palette hands the user the syntax.
    expect(useComposerStore.getState().drafts[channel]).toBe('/join ');
    expect(useComposerStore.getState().focusToken).toBe(1);
  });

  it('keeps text that was already being typed', async () => {
    const { channel } = seed();
    useComposerStore.setState({ drafts: { [channel]: 'half a thought' } });

    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'join' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    // Inserting must never destroy an unsent message.
    expect(useComposerStore.getState().drafts[channel]).toBe('half a thought /join ');
  });

  it('closes on Escape without running anything', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('opens the connection dialog from the action list', async () => {
    seed();
    render(<CommandPalette />);
    await open();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '添加网络' } });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(useUiStore.getState().connectionDialogOpen).toBe(true);
  });
});

describe('cycling helpers', () => {
  it('cycles the theme and wraps', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('system')).toBe('light');
  });

  it('cycles the language and wraps', () => {
    expect(nextLanguage('zh-CN')).toBe('en');
    expect(nextLanguage('en')).toBe('zh-CN');
  });
});

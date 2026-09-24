import { act, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';
import { App } from './App';

// Pin the language: the shortcut assertions read rendered labels, and jsdom's
// `navigator.language` is not something a test should depend on.
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

/**
 * Render the whole shell.
 *
 * This is the cheapest guard against the failure mode that a build cannot catch:
 * a runtime exception during the first render leaves the window blank, and the
 * only place that shows up is a webview console nobody is watching.
 *
 * Tauri's IPC is unavailable here, so every bridge call rejects. That is fine —
 * the point is that the shell still renders and the rejections are handled.
 */
describe('App', () => {
  it('renders the shell without throwing', () => {
    render(<App />);

    // The three columns plus the chrome must all be present.
    expect(screen.getByRole('heading', { name: 'Ircuit' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('shows the empty state when no network is connected', () => {
    render(<App />);
    expect(screen.getByText(/还没有连接任何网络|Not connected to any network/)).toBeInTheDocument();
  });

  it('offers the composer but keeps it disabled while offline', () => {
    render(<App />);
    const composer = screen.getByRole('textbox');

    expect(composer).toBeDisabled();
    expect(composer.getAttribute('placeholder')).toMatch(
      /尚未连接任何网络|Not connected to any network/,
    );
  });
});

/**
 * The global keyboard map.
 *
 * These go through the real window listener rather than calling the handler
 * directly: the interesting failures are about *which* events reach it, and a
 * unit test that skips the listener cannot see those.
 */
describe('keyboard shortcuts', () => {
  const NETWORK = '127.0.0.1:6667';

  function press(init: KeyboardEventInit) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
    });
  }

  beforeEach(() => {
    useUiStore.setState({
      paletteOpen: false,
      connectionDialogOpen: false,
      sidebarOpen: true,
      membersOpen: true,
    });
    useSessionStore.setState({ networks: [], buffers: [], activeBufferId: null });
  });

  it('opens and closes the command palette with Ctrl+K', () => {
    render(<App />);

    press({ key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeInTheDocument();

    press({ key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('collapses and restores both side columns', () => {
    render(<App />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();

    press({ key: 'b', ctrlKey: true });
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // The rail that replaces it is how a mouse user gets it back.
    expect(screen.getByRole('button', { name: '展开网络栏' })).toBeInTheDocument();

    press({ key: 'b', ctrlKey: true });
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('keeps the two sidebar toggles apart', () => {
    render(<App />);

    press({ key: 'B', ctrlKey: true, shiftKey: true });

    // The member column went away and the network column stayed.
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开成员栏' })).toBeInTheDocument();
  });

  it('walks the buffers with Ctrl+PageDown and Ctrl+PageUp', () => {
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
      activeBufferId: server,
    });

    render(<App />);

    press({ key: 'PageDown', ctrlKey: true });
    expect(useSessionStore.getState().activeBufferId).toBe(channel);

    press({ key: 'PageUp', ctrlKey: true });
    expect(useSessionStore.getState().activeBufferId).toBe(server);
  });

  it('ignores Ctrl+W while the palette is open', () => {
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
          id: channel,
          networkId: NETWORK,
          target: '#rust',
          kind: 'query',
          unread: 0,
          highlight: false,
          seen: true,
        },
      ],
      activeBufferId: channel,
    });

    render(<App />);

    press({ key: 'k', ctrlKey: true });
    press({ key: 'w', ctrlKey: true });

    // Acting on a buffer the user cannot see is the kind of surprise shortcuts
    // have to avoid.
    expect(useSessionStore.getState().buffers).toHaveLength(1);
  });

  it('leaves plain typing alone', () => {
    render(<App />);

    press({ key: 'k' });
    press({ key: 'Tab' });
    press({ key: 'ArrowDown' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

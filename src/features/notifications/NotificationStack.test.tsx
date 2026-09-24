import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { bufferId, useSessionStore } from '@/store/session';
import {
  MAX_NOTIFICATIONS,
  nextNotificationId,
  resetNotificationSequence,
  useNotificationsStore,
  VISIBLE_NOTIFICATIONS,
  type AppNotification,
} from '@/store/notifications';

import { NotificationStack } from './NotificationStack';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const NETWORK = '127.0.0.1:6667';

function notify(overrides: Partial<AppNotification> = {}) {
  useNotificationsStore.getState().notify({
    id: nextNotificationId(),
    bufferId: bufferId(NETWORK, '#rust'),
    bufferLabel: '#rust',
    networkId: NETWORK,
    networkName: 'libera',
    nick: 'alice',
    text: 'me: are you there?',
    timestamp: 0,
    ...overrides,
  });
}

beforeEach(() => {
  resetNotificationSequence();
  useNotificationsStore.setState({ rules: [], notifications: [] });
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
        id: bufferId(NETWORK, ''),
        networkId: NETWORK,
        target: '',
        kind: 'server',
        unread: 0,
        highlight: false,
        seen: true,
      },
      {
        id: bufferId(NETWORK, '#rust'),
        networkId: NETWORK,
        target: '#rust',
        kind: 'channel',
        unread: 1,
        highlight: true,
        seen: false,
      },
    ],
    activeBufferId: bufferId(NETWORK, ''),
  });
});

describe('NotificationStack', () => {
  it('renders nothing when there is nothing to say', () => {
    render(<NotificationStack />);
    expect(screen.queryByLabelText('高亮提醒')).not.toBeInTheDocument();
  });

  it('shows who said what, and where', () => {
    notify();
    render(<NotificationStack />);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('libera · #rust')).toBeInTheDocument();
    expect(screen.getByText('me: are you there?')).toBeInTheDocument();
  });

  it('jumps to the buffer and dismisses itself when clicked', () => {
    notify();
    render(<NotificationStack />);

    fireEvent.click(screen.getByText('me: are you there?'));

    expect(useSessionStore.getState().activeBufferId).toBe(bufferId(NETWORK, '#rust'));
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });

  it('dismisses without jumping', () => {
    notify();
    render(<NotificationStack />);

    fireEvent.click(screen.getByRole('button', { name: '关闭提醒' }));

    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
    // The buffer stayed where it was: dismissing is not navigating.
    expect(useSessionStore.getState().activeBufferId).toBe(bufferId(NETWORK, ''));
  });

  it('shows the newest few and says how many are hidden', () => {
    for (let index = 0; index < MAX_NOTIFICATIONS; index += 1) {
      notify({ text: `line ${index}` });
    }

    render(<NotificationStack />);

    const hidden = MAX_NOTIFICATIONS - VISIBLE_NOTIFICATIONS;
    expect(screen.getByText(`还有 ${hidden} 条 · 全部清除`)).toBeInTheDocument();
    // The newest is on screen, the oldest is not.
    expect(screen.getByText(`line ${MAX_NOTIFICATIONS - 1}`)).toBeInTheDocument();
    expect(screen.queryByText('line 0')).not.toBeInTheDocument();
  });

  it('clears everything at once', () => {
    for (let index = 0; index < MAX_NOTIFICATIONS; index += 1) {
      notify({ text: `line ${index}` });
    }

    render(<NotificationStack />);
    fireEvent.click(screen.getByText(/全部清除/));

    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });
});

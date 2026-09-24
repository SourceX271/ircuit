import { beforeEach, describe, expect, it } from 'vitest';

import { createRule } from '@/lib/highlight';

import {
  MAX_NOTIFICATIONS,
  nextNotificationId,
  parseRules,
  resetNotificationSequence,
  shouldNotify,
  useNotificationsStore,
  type AppNotification,
} from './notifications';

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: nextNotificationId(),
    bufferId: 'net|#rust',
    bufferLabel: '#rust',
    networkId: 'net',
    networkName: 'libera',
    nick: 'alice',
    text: 'me: ping',
    timestamp: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetNotificationSequence();
  useNotificationsStore.setState({ rules: [], notifications: [] });
});

describe('highlight rules', () => {
  it('adds a rule', () => {
    useNotificationsStore.getState().addRule(createRule('rust'));

    expect(useNotificationsStore.getState().rules).toHaveLength(1);
    expect(useNotificationsStore.getState().rules[0]?.pattern).toBe('rust');
  });

  it('replaces a rule with the same word instead of stacking it', () => {
    // `/highlight rust` twice means one rule, not two identical ones.
    const store = useNotificationsStore.getState();
    store.addRule(createRule('rust'));
    store.addRule(createRule('RUST', { caseSensitive: true }));

    const rules = useNotificationsStore.getState().rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.caseSensitive).toBe(true);
  });

  it('removes a rule by its folded pattern', () => {
    const store = useNotificationsStore.getState();
    store.addRule(createRule('rust'));
    store.addRule(createRule('ping'));
    store.removeRule('RUST');

    expect(useNotificationsStore.getState().rules.map((rule) => rule.pattern)).toEqual(['ping']);
  });

  it('keeps unrelated rules when one is removed', () => {
    const store = useNotificationsStore.getState();
    store.addRule(createRule('rust'));
    store.removeRule('nothing-here');

    expect(useNotificationsStore.getState().rules).toHaveLength(1);
  });
});

describe('parseRules', () => {
  it('accepts a well-formed list', () => {
    const parsed = parseRules([{ pattern: 'rust', caseSensitive: true, wholeWord: false }]);

    expect(parsed).toEqual([
      { pattern: 'rust', caseSensitive: true, wholeWord: false, enabled: true },
    ]);
  });

  it('drops entries that are not rules', () => {
    // Stored state can be old, hand-edited, or written by something else.
    const parsed = parseRules([{ pattern: 'rust' }, { pattern: '' }, 'nonsense', null, 42]);

    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.pattern).toBe('rust');
  });

  it('rejects anything that is not a list', () => {
    expect(parseRules({ pattern: 'rust' })).toBeNull();
    expect(parseRules('rust')).toBeNull();
  });

  it('defaults the flags rather than trusting them', () => {
    const parsed = parseRules([{ pattern: 'rust', caseSensitive: 'yes', wholeWord: 'no' }]);

    expect(parsed?.[0]?.caseSensitive).toBe(false);
    expect(parsed?.[0]?.wholeWord).toBe(true);
  });
});

describe('the notification stack', () => {
  it('keeps the newest entries in order', () => {
    const store = useNotificationsStore.getState();
    store.notify(notification({ text: 'first' }));
    store.notify(notification({ text: 'second' }));

    expect(useNotificationsStore.getState().notifications.map((item) => item.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('drops the oldest entries once it is full', () => {
    // An unbounded stack would eventually cover the message list.
    const store = useNotificationsStore.getState();
    for (let index = 0; index <= MAX_NOTIFICATIONS + 3; index += 1) {
      store.notify(notification({ text: `line ${index}` }));
    }

    const stack = useNotificationsStore.getState().notifications;
    expect(stack).toHaveLength(MAX_NOTIFICATIONS);
    expect(stack[stack.length - 1]?.text).toBe(`line ${MAX_NOTIFICATIONS + 3}`);
  });

  it('dismisses one and clears all', () => {
    const store = useNotificationsStore.getState();
    store.notify(notification());
    const id = useNotificationsStore.getState().notifications[0]!.id;

    store.dismiss(id);
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);

    store.notify(notification());
    store.notify(notification());
    useNotificationsStore.getState().clearNotifications();
    expect(useNotificationsStore.getState().notifications).toHaveLength(0);
  });
});

describe('shouldNotify', () => {
  const base = {
    text: 'me: ping',
    selfNick: 'me',
    rules: [],
    isSelf: false,
    isActivity: true,
    isActiveBuffer: false,
  };

  it('raises a banner for a highlight in a buffer that is not on screen', () => {
    expect(shouldNotify(base)).toBe(true);
  });

  it('stays quiet for the buffer being read', () => {
    // A banner about the line already on screen is pure noise.
    expect(shouldNotify({ ...base, isActiveBuffer: true })).toBe(false);
  });

  it('stays quiet for our own lines', () => {
    expect(shouldNotify({ ...base, isSelf: true })).toBe(false);
  });

  it('stays quiet for joins and parts', () => {
    expect(shouldNotify({ ...base, isActivity: false })).toBe(false);
  });

  it('stays quiet when nothing matched', () => {
    expect(shouldNotify({ ...base, text: 'good morning' })).toBe(false);
  });

  it('honours a keyword rule', () => {
    expect(shouldNotify({ ...base, text: 'a rust question', rules: [createRule('rust')] })).toBe(
      true,
    );
  });
});

describe('notification ids', () => {
  it('are unique', () => {
    const first = nextNotificationId();
    const second = nextNotificationId();

    expect(first).not.toBe(second);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageKind } from '@/lib/ipc';
import type { SessionLine } from '@/store/session';

import {
  completionNicks,
  HISTORY_LIMIT,
  lastSpeakerOf,
  stepHistory,
  useComposerStore,
} from './composerStore';

function line(overrides: Partial<SessionLine> = {}): SessionLine {
  return {
    id: 'line-1',
    nick: 'alice',
    kind: 'message' as MessageKind,
    text: 'hi',
    segments: [],
    timestamp: 0,
    isSelf: false,
    highlight: false,
    ...overrides,
  };
}

beforeEach(() => {
  useComposerStore.setState({ drafts: {}, history: {} });
});

describe('drafts', () => {
  it('remembers text per buffer', () => {
    const store = useComposerStore.getState();
    store.setDraft('net|#a', 'half a thought');
    store.setDraft('net|#b', 'another');

    expect(useComposerStore.getState().drafts['net|#a']).toBe('half a thought');
    expect(useComposerStore.getState().drafts['net|#b']).toBe('another');
  });

  it('forgets a draft once it is empty', () => {
    // An empty draft is the absence of one; keeping `''` around would grow the
    // map for every buffer ever visited.
    const store = useComposerStore.getState();
    store.setDraft('net|#a', 'text');
    store.setDraft('net|#a', '');

    expect(useComposerStore.getState().drafts['net|#a']).toBeUndefined();
  });
});

describe('history', () => {
  it('records sent lines in order', () => {
    const store = useComposerStore.getState();
    store.pushHistory('net|#a', 'one');
    store.pushHistory('net|#a', 'two');

    expect(useComposerStore.getState().history['net|#a']).toEqual(['one', 'two']);
  });

  it('ignores blank lines', () => {
    useComposerStore.getState().pushHistory('net|#a', '   ');
    expect(useComposerStore.getState().history['net|#a']).toBeUndefined();
  });

  it('does not repeat the previous line', () => {
    // Re-sending the same thing is common; filling the history with copies of
    // it is not what Up arrow should walk through.
    const store = useComposerStore.getState();
    store.pushHistory('net|#a', 'one');
    store.pushHistory('net|#a', 'one');

    expect(useComposerStore.getState().history['net|#a']).toEqual(['one']);
  });

  it('keeps the newest entries when it overflows', () => {
    const store = useComposerStore.getState();
    for (let index = 0; index <= HISTORY_LIMIT + 5; index += 1) {
      store.pushHistory('net|#a', `line ${index}`);
    }

    const history = useComposerStore.getState().history['net|#a']!;
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[history.length - 1]).toBe(`line ${HISTORY_LIMIT + 5}`);
  });
});

describe('stepHistory', () => {
  const history = ['one', 'two', 'three'];

  it('walks backwards from the most recent entry', () => {
    expect(stepHistory(history, null, -1, 'draft')).toEqual({ index: 2, value: 'three' });
    expect(stepHistory(history, 2, -1, 'draft')).toEqual({ index: 1, value: 'two' });
    expect(stepHistory(history, 1, -1, 'draft')).toEqual({ index: 0, value: 'one' });
  });

  it('clamps at the oldest entry instead of wrapping', () => {
    // Wrapping would teleport from the first thing ever typed to the last.
    expect(stepHistory(history, 0, -1, 'draft')).toEqual({ index: 0, value: 'one' });
  });

  it('returns the stashed line when walking past the newest entry', () => {
    expect(stepHistory(history, 2, 1, 'draft')).toEqual({ index: null, value: 'draft' });
  });

  it('does nothing on ArrowDown when not browsing', () => {
    expect(stepHistory(history, null, 1, 'draft')).toEqual({ index: null, value: 'draft' });
  });

  it('handles an empty history', () => {
    expect(stepHistory([], null, -1, 'draft')).toEqual({ index: null, value: 'draft' });
    expect(stepHistory([], 0, 1, 'draft')).toEqual({ index: null, value: 'draft' });
  });
});

describe('lastSpeakerOf', () => {
  it('finds the most recent other person', () => {
    expect(lastSpeakerOf([line({ nick: 'alice' }), line({ nick: 'bob' })])).toBe('bob');
  });

  it('skips our own lines and non-conversation events', () => {
    const lines = [
      line({ nick: 'alice' }),
      line({ nick: 'me', isSelf: true }),
      line({ nick: 'carol', kind: 'system' }),
    ];

    expect(lastSpeakerOf(lines)).toBe('alice');
  });

  it('returns null when nobody has spoken', () => {
    expect(lastSpeakerOf([])).toBeNull();
    expect(lastSpeakerOf(undefined)).toBeNull();
    expect(lastSpeakerOf([line({ nick: 'carol', kind: 'system' })])).toBeNull();
  });
});

describe('completionNicks', () => {
  it('prefers the member list', () => {
    expect(completionNicks([{ nick: 'alice' }, { nick: 'bob' }], 'carol')).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('falls back to the other party in a query', () => {
    expect(completionNicks(undefined, 'carol')).toEqual(['carol']);
    expect(completionNicks([], 'carol')).toEqual(['carol']);
  });

  it('offers nobody on the server buffer', () => {
    // A line there is a raw protocol command, so a nick completion would send
    // nonsense.
    expect(completionNicks(undefined, null)).toEqual([]);
  });
});

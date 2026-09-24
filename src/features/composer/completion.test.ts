import { describe, expect, it } from 'vitest';

import {
  commandQuery,
  complete,
  longestCommonPrefix,
  matchingCommands,
  type CompletionContext,
  type CompletionSession,
} from './completion';

function context(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    value: '',
    caret: 0,
    nicks: ['alice', 'alicia', 'bob'],
    channels: ['#rust', '#ruby'],
    selfNick: 'me',
    lastSpeaker: 'bob',
    ...overrides,
  };
}

/** Type `text` and press Tab, returning the new value. */
function tab(text: string, ctx: Partial<CompletionContext> = {}, shift = false): string | null {
  const base = context({ value: text, caret: text.length, ...ctx });
  const edit = complete(base, null, shift ? -1 : 1);
  return edit === null ? null : edit.value;
}

/** Press Tab repeatedly, carrying the session along. */
function tabTimes(text: string, times: number, ctx: Partial<CompletionContext> = {}): string {
  let value = text;
  let session: CompletionSession | null = null;

  for (let index = 0; index < times; index += 1) {
    const edit = complete(context({ value, caret: value.length, ...ctx }), session, 1);
    if (!edit) break;
    value = edit.value;
    session = edit.session;
  }

  return value;
}

describe('longestCommonPrefix', () => {
  it('returns the shared prefix', () => {
    expect(longestCommonPrefix(['alice', 'alicia'])).toBe('alic');
    expect(longestCommonPrefix(['#rust', '#ruby'])).toBe('#ru');
  });

  it('ignores case differences in the comparison but keeps the first spelling', () => {
    expect(longestCommonPrefix(['Alice', 'ALICIA'])).toBe('Alic');
  });

  it('handles the degenerate cases', () => {
    expect(longestCommonPrefix([])).toBe('');
    expect(longestCommonPrefix(['alice'])).toBe('alice');
    expect(longestCommonPrefix(['alice', 'bob'])).toBe('');
  });
});

describe('complete', () => {
  it('does nothing when the caret is not in a word', () => {
    // Tab after a finished word should not delete or duplicate anything.
    expect(tab('hello ')).toBeNull();
    expect(tab('hello world ')).toBeNull();
  });

  it('completes a unique nickname, addressing them when it is the first word', () => {
    // The colon is the whole reason to complete a nick at the start of a line.
    expect(tab('bo')).toBe('bob: ');
  });

  it('does not add a colon mid-sentence', () => {
    expect(tab('hello bo')).toBe('hello bob');
  });

  it('never addresses ourselves', () => {
    expect(tab('m', { nicks: ['me', 'matt'] })).toBe('matt: ');
  });

  it('extends to the shared prefix before cycling', () => {
    // First Tab: as far as the candidates agree.
    expect(tab('al')).toBe('alic');
    // Then the cycle actually walks them.
    expect(tabTimes('al', 2)).toBe('alice: ');
    expect(tabTimes('al', 3)).toBe('alicia: ');
    expect(tabTimes('al', 4)).toBe('alice: ');
  });

  it('cycles backwards with Shift+Tab', () => {
    const ctx = context({ value: 'al', caret: 2 });
    const first = complete(ctx, null, -1);
    expect(first?.value).toBe('alic');

    const second = complete(
      context({ value: first!.value, caret: first!.value.length }),
      first!.session,
      -1,
    );
    expect(second?.value).toBe('alicia: ');
  });

  it('replaces a colon already in place instead of doubling it', () => {
    // Two Tabs in a row must not produce `alice:: `.
    expect(tabTimes('al', 2)).toBe('alice: ');
    expect(tabTimes('alice', 1)).toBe('alice: ');
  });

  it('splices into the middle of the line without disturbing the rest', () => {
    const ctx = context({ value: 'hi bo how are you', caret: 5 });
    const edit = complete(ctx, null, 1);
    expect(edit?.value).toBe('hi bob how are you');
    expect(edit?.caret).toBe(6);
  });

  it('answers the last speaker on an empty line', () => {
    expect(tab('')).toBe('bob: ');
  });

  it('does not address ourselves on an empty line', () => {
    expect(tab('', { lastSpeaker: 'me' })).toBeNull();
  });

  it('does nothing on an empty line when nobody has spoken', () => {
    expect(tab('', { lastSpeaker: null })).toBeNull();
  });

  it('completes command names', () => {
    expect(tab('/jo')).toBe('/join');
    expect(tab('/qu')).toBe('/quit');
  });

  it('starts cycling commands once the prefix cannot be extended', () => {
    // `/j` matches both `/join` and its `/j` alias, and they share only `/j`.
    expect(tabTimes('/j', 1)).toBe('/join');
    expect(tabTimes('/j', 2)).toBe('/j');
  });

  it('does not complete arguments as commands', () => {
    // Once the caret is past the command name, `/`-less words are people.
    expect(tab('/me bo')).toBe('/me bob');
  });

  it('suggests channels for the arguments of channel commands', () => {
    // Typed without the sigil, completed with it — that is what goes on the wire.
    expect(tab('/join rust')).toBe('/join #rust');
    // Two channels share only `#ru`, so the first Tab stops there.
    expect(tab('/join ru')).toBe('/join #ru');
    // A leading `#` is a channel even where a nick would be expected.
    expect(tab('/msg #ruby')).toBe('/msg #ruby');
  });

  it('offers people and channels after /msg', () => {
    expect(tab('/msg bo')).toBe('/msg bob');
  });

  it('leaves the text alone when nothing matches', () => {
    expect(tab('zzz')).toBeNull();
    expect(tab('/nosuchcommand')).toBeNull();
  });

  it('offers nobody on the server buffer', () => {
    // A bare line there is a raw protocol command; inserting a nick would send
    // nonsense to the server.
    expect(tab('bo', { nicks: [], channels: [] })).toBeNull();
  });

  it('starts a fresh cycle when the text was edited', () => {
    const first = complete(context({ value: 'al', caret: 2 }), null, 1);
    expect(first?.value).toBe('alic');

    // The user typed a letter on top of the completion: the session no longer
    // owns that range, so this is a new completion rather than a cycle.
    const edited = 'alicz';
    const second = complete(context({ value: edited, caret: edited.length }), first!.session, 1);
    expect(second).toBeNull();
  });

  it('keeps cycling when the caret moved but the text did not', () => {
    const first = complete(context({ value: 'al', caret: 2 }), null, 1);
    const value = first!.value;

    // `alice: ` is the second cycle; the caret sits at the end either way.
    const second = complete(context({ value, caret: value.length }), first!.session, 1);
    expect(second?.value).toBe('alice: ');
  });
});

describe('commandQuery', () => {
  it('returns the partial name while typing it', () => {
    expect(commandQuery('/', 1)).toBe('');
    expect(commandQuery('/jo', 3)).toBe('jo');
    expect(commandQuery('/join', 5)).toBe('join');
  });

  it('stops once the caret moves into the arguments', () => {
    expect(commandQuery('/join #rust', 11)).toBeNull();
  });

  it('returns nothing for ordinary text', () => {
    expect(commandQuery('hello', 5)).toBeNull();
    expect(commandQuery('', 0)).toBeNull();
  });
});

describe('matchingCommands', () => {
  it('matches by prefix', () => {
    const names = matchingCommands('jo').map((spec) => spec.name);
    expect(names).toEqual(['join']);
  });

  it('deduplicates aliases so /j does not list join twice', () => {
    const names = matchingCommands('j').map((spec) => spec.name);
    expect(names).toEqual(['join']);
  });

  it('lists everything for a bare slash', () => {
    expect(matchingCommands('').length).toBeGreaterThan(20);
  });
});

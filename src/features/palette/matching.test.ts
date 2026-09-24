import { describe, expect, it } from 'vitest';

import { filterEntries, fuzzyScore, scoreEntry, stepIndex } from './matching';

describe('fuzzyScore', () => {
  it('scores an empty query as a neutral match', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
  });

  it('matches a prefix', () => {
    expect(fuzzyScore('/join', 'join')).toBeGreaterThan(0);
  });

  it('matches a subsequence, which is what makes typing fast', () => {
    // The whole point: `/jn` should still find `/join`.
    expect(fuzzyScore('/join', 'jn')).toBeGreaterThan(0);
    expect(fuzzyScore('#rust', 'rt')).toBeGreaterThan(0);
  });

  it('rejects anything that is not a subsequence', () => {
    expect(fuzzyScore('/join', 'xyz')).toBe(-1);
    expect(fuzzyScore('#rust', 'rsut')).toBe(-1);
    // Order matters, not just presence.
    expect(fuzzyScore('abc', 'cba')).toBe(-1);
  });

  it('rejects a query longer than the text', () => {
    expect(fuzzyScore('ab', 'abc')).toBe(-1);
  });

  it('ranks a prefix above a match buried in the middle', () => {
    expect(fuzzyScore('join', 'jo')).toBeGreaterThan(fuzzyScore('rejoin', 'jo'));
  });

  it('rewards consecutive characters', () => {
    expect(fuzzyScore('join', 'jo')).toBeGreaterThan(fuzzyScore('j-o-i-n', 'jo'));
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('JOIN', 'join')).toBe(fuzzyScore('join', 'JOIN'));
  });
});

describe('scoreEntry', () => {
  it('counts keyword matches', () => {
    expect(
      scoreEntry({ label: '/msg', keywords: 'query private' }, 'query'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('never lets a keyword outrank the label it is attached to', () => {
    const byLabel = scoreEntry({ label: 'join', keywords: 'channel' }, 'join');
    const byKeyword = scoreEntry({ label: 'join', keywords: 'channel' }, 'channel');

    expect(byLabel).toBeGreaterThan(byKeyword);
  });

  it('returns -1 when neither the label nor the keywords match', () => {
    expect(scoreEntry({ label: 'join', keywords: 'channel' }, 'zzz')).toBe(-1);
  });
});

describe('filterEntries', () => {
  const entries = [
    { label: '/join', keywords: 'channel' },
    { label: '/quit', keywords: 'disconnect' },
    { label: '/notice', keywords: 'private' },
  ];

  it('keeps the given order for an empty query', () => {
    // That order is deliberate — buffers first, actions, then commands — and
    // re-sorting it would throw it away.
    expect(filterEntries(entries, '').map((entry) => entry.label)).toEqual([
      '/join',
      '/quit',
      '/notice',
    ]);
  });

  it('drops everything that does not match', () => {
    expect(filterEntries(entries, 'quit').map((entry) => entry.label)).toEqual(['/quit']);
    expect(filterEntries(entries, 'zzz')).toEqual([]);
  });

  it('ranks by score, not by input order', () => {
    // `no` is a prefix of `/notice` and scattered inside `/join`, so the prefix
    // has to win even though it comes last in the input.
    expect(filterEntries(entries, 'no')[0]?.label).toBe('/notice');
  });

  it('matches hidden keywords', () => {
    expect(filterEntries(entries, 'disconnect').map((entry) => entry.label)).toEqual(['/quit']);
  });

  it('honours the limit', () => {
    expect(filterEntries(entries, '', 2)).toHaveLength(2);
  });

  it('prefers the shorter label when scores tie', () => {
    const tied = [{ label: 'ab-longer' }, { label: 'ab' }];
    expect(filterEntries(tied, 'ab').map((entry) => entry.label)).toEqual(['ab', 'ab-longer']);
  });
});

describe('stepIndex', () => {
  it('moves and wraps in both directions', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it('enters the list at the right end', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
  });

  it('reports nothing to select for an empty list', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

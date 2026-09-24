import { describe, expect, it } from 'vitest';

import { createRule, isHighlight, matchesRule, mentions, ruleKey } from './highlight';

describe('mentions', () => {
  it('matches a whole nickname token', () => {
    expect(mentions('hello me how are you', 'me')).toBe(true);
    expect(mentions('me: ping', 'me')).toBe(true);
    expect(mentions('ping (me)', 'me')).toBe(true);
    expect(mentions('well, me too', 'me')).toBe(true);
  });

  it('does not match a nickname inside a longer word', () => {
    expect(mentions('bobcat', 'bob')).toBe(false);
    expect(mentions('something', 'me')).toBe(false);
  });

  it('treats bracket characters as part of a nickname', () => {
    // `[`, `]`, `\`, `^`, `{`, `}`, `|` and backtick are all legal IRC nickname
    // characters, so `[me]` reads as one token rather than a mention of `me`.
    expect(mentions('[me] ping', 'me')).toBe(false);
  });

  it('is false without a nickname', () => {
    expect(mentions('anything', null)).toBe(false);
  });
});

describe('createRule', () => {
  it('trims and defaults to a case-insensitive whole word', () => {
    expect(createRule('  rust  ')).toEqual({
      pattern: 'rust',
      caseSensitive: false,
      wholeWord: true,
      enabled: true,
    });
  });

  it('accepts overrides', () => {
    expect(createRule('Rust', { caseSensitive: true, wholeWord: false })).toEqual({
      pattern: 'Rust',
      caseSensitive: true,
      wholeWord: false,
      enabled: true,
    });
  });
});

describe('ruleKey', () => {
  it('folds and trims, so the same word is one rule', () => {
    expect(ruleKey({ pattern: ' Rust ' })).toBe('rust');
    expect(ruleKey(createRule('RUST'))).toBe(ruleKey(createRule('rust')));
  });
});

describe('matchesRule', () => {
  it('is case-insensitive by default', () => {
    const rule = createRule('rust');
    expect(matchesRule('I love Rust', rule)).toBe(true);
    expect(matchesRule('i love RUST', rule)).toBe(true);
  });

  it('respects a case-sensitive rule', () => {
    const rule = createRule('Rust', { caseSensitive: true });
    expect(matchesRule('I love Rust', rule)).toBe(true);
    expect(matchesRule('i love rust', rule)).toBe(false);
  });

  it('requires a whole word by default', () => {
    const rule = createRule('rust');
    expect(matchesRule('rust is good', rule)).toBe(true);
    expect(matchesRule('rustacean', rule)).toBe(false);
    expect(matchesRule('trust', rule)).toBe(false);
  });

  it('matches substrings when asked to', () => {
    const rule = createRule('rust', { wholeWord: false });
    expect(matchesRule('rustacean', rule)).toBe(true);
  });

  it('ignores rules that are turned off', () => {
    const rule = createRule('rust', { enabled: false });
    expect(matchesRule('rust is good', rule)).toBe(false);
  });

  it('ignores an empty pattern', () => {
    // An empty pattern would otherwise match every line, which is the loudest
    // possible way to get a rule wrong.
    expect(matchesRule('anything', createRule(''))).toBe(false);
  });

  it('finds a match that is not the first candidate occurrence', () => {
    // `rust` appears inside `rustacean` first; the whole-word check has to keep
    // looking rather than give up.
    const rule = createRule('rust');
    expect(matchesRule('rustacean and rust', rule)).toBe(true);
  });

  it('matches a phrase', () => {
    const rule = createRule('release day');
    expect(matchesRule('happy release day everyone', rule)).toBe(true);
    expect(matchesRule('release days', rule)).toBe(false);
  });

  it('matches CJK keywords without needing word boundaries', () => {
    // CJK has no spaces, so treating a Chinese character as a word character
    // would make a Chinese keyword unusable in a sentence.
    const rule = createRule('发布');
    expect(matchesRule('今天发布了新版本', rule)).toBe(true);
  });

  it('treats punctuation as a boundary', () => {
    const rule = createRule('rust');
    expect(matchesRule('(rust)', rule)).toBe(true);
    expect(matchesRule('rust, ruby', rule)).toBe(true);
    expect(matchesRule('rust_lang', rule)).toBe(false);
  });
});

describe('isHighlight', () => {
  it('is true when the line names us', () => {
    expect(isHighlight('me: ping', 'me', [])).toBe(true);
  });

  it('is true when a rule matches', () => {
    expect(isHighlight('a rust question', 'me', [createRule('rust')])).toBe(true);
  });

  it('is false when neither applies', () => {
    expect(isHighlight('good morning', 'me', [createRule('rust')])).toBe(false);
  });

  it('works without a nickname', () => {
    expect(isHighlight('a rust question', null, [createRule('rust')])).toBe(true);
    expect(isHighlight('good morning', null, [])).toBe(false);
  });
});

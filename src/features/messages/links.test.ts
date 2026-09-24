import { describe, expect, it } from 'vitest';

import { hrefFor, splitTrailingPunctuation, tokenizeLinks } from './links';

describe('tokenizeLinks', () => {
  it('leaves plain text alone', () => {
    expect(tokenizeLinks('nothing to see here')).toEqual([
      { kind: 'text', value: 'nothing to see here' },
    ]);
  });

  it('finds a link in the middle of a sentence', () => {
    expect(tokenizeLinks('see https://example.com for details')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.com' },
      { kind: 'text', value: ' for details' },
    ]);
  });

  it('finds several links', () => {
    const tokens = tokenizeLinks('https://a.example and https://b.example');
    expect(tokens.filter((token) => token.kind === 'link').map((token) => token.value)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('recognises irc links', () => {
    expect(tokenizeLinks('irc://irc.libera.chat/rust')).toEqual([
      { kind: 'link', value: 'irc://irc.libera.chat/rust' },
    ]);
  });

  it('recognises a bare www host', () => {
    expect(tokenizeLinks('www.example.com is a site')).toEqual([
      { kind: 'link', value: 'www.example.com' },
      { kind: 'text', value: ' is a site' },
    ]);
  });

  it('does not linkify a scheme we would refuse to open', () => {
    // Rendering these as links would offer a click that must then be refused.
    expect(tokenizeLinks('javascript:alert(1)')).toEqual([
      { kind: 'text', value: 'javascript:alert(1)' },
    ]);
    expect(tokenizeLinks('file:///etc/passwd')).toEqual([
      { kind: 'text', value: 'file:///etc/passwd' },
    ]);
  });

  it('strips sentence punctuation from the end of a link', () => {
    expect(tokenizeLinks('go to https://example.com.')).toEqual([
      { kind: 'text', value: 'go to ' },
      { kind: 'link', value: 'https://example.com' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('keeps a balanced bracket inside the link', () => {
    // Wikipedia URLs end in a bracket often enough that stripping eagerly
    // would break them.
    expect(tokenizeLinks('https://en.wikipedia.org/wiki/Rust_(programming_language)')).toEqual([
      { kind: 'link', value: 'https://en.wikipedia.org/wiki/Rust_(programming_language)' },
    ]);
  });

  it('drops an unbalanced closing bracket', () => {
    expect(tokenizeLinks('(see https://example.com)')).toEqual([
      { kind: 'text', value: '(see ' },
      { kind: 'link', value: 'https://example.com' },
      { kind: 'text', value: ')' },
    ]);
  });

  it('preserves the text around links exactly', () => {
    const input = '  spaced  https://example.com  trailing  ';
    const tokens = tokenizeLinks(input);
    expect(tokens.map((token) => token.value).join('')).toBe(input);
  });

  it('ignores a bare www with nothing after it', () => {
    expect(tokenizeLinks('www.')).toEqual([{ kind: 'text', value: 'www.' }]);
  });

  it('is repeatable on the same string', () => {
    // The pattern carries the global flag, so a stale lastIndex would make the
    // second call return something different.
    const input = 'https://example.com/a https://example.com/b';
    expect(tokenizeLinks(input)).toEqual(tokenizeLinks(input));
  });
});

describe('splitTrailingPunctuation', () => {
  it('peels off several punctuation characters', () => {
    expect(splitTrailingPunctuation('https://example.com),')).toEqual({
      url: 'https://example.com',
      trailing: '),',
    });
  });

  it('leaves a clean url untouched', () => {
    expect(splitTrailingPunctuation('https://example.com/a')).toEqual({
      url: 'https://example.com/a',
      trailing: '',
    });
  });

  it('keeps balanced parentheses', () => {
    expect(splitTrailingPunctuation('https://example.com/(a)')).toEqual({
      url: 'https://example.com/(a)',
      trailing: '',
    });
  });
});

describe('hrefFor', () => {
  it('adds a scheme to a bare host', () => {
    // The opener requires a scheme it recognises.
    expect(hrefFor('www.example.com')).toBe('https://www.example.com');
  });

  it('leaves an absolute url alone', () => {
    expect(hrefFor('https://example.com')).toBe('https://example.com');
    expect(hrefFor('irc://irc.libera.chat')).toBe('irc://irc.libera.chat');
  });
});

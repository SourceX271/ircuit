import { describe, expect, it } from 'vitest';

import { composeTitle } from './windowTitle';

describe('composeTitle', () => {
  it('is the bare name when nothing is waiting', () => {
    expect(composeTitle('Ircuit', 0, 0)).toBe('Ircuit');
  });

  it('counts buffers with unread lines', () => {
    expect(composeTitle('Ircuit', 0, 3)).toBe('(3) Ircuit');
  });

  it('prefers the highlight count when there is one', () => {
    // 40 unread lines and one mention are not the same thing, and the mention is
    // the reason to look up.
    expect(composeTitle('Ircuit', 1, 40)).toBe('(1) ● Ircuit');
  });

  it('marks a highlight so the two counts cannot be confused', () => {
    expect(composeTitle('Ircuit', 2, 0)).toBe('(2) ● Ircuit');
  });
});

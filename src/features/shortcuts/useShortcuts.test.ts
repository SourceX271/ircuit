import { describe, expect, it } from 'vitest';

import { neighbourBufferId } from './useShortcuts';

const ids = ['a', 'b', 'c'];

describe('neighbourBufferId', () => {
  it('moves forward and backward', () => {
    expect(neighbourBufferId(ids, 'a', 1)).toBe('b');
    expect(neighbourBufferId(ids, 'b', -1)).toBe('a');
  });

  it('wraps at both ends', () => {
    // Stopping dead at the last buffer makes tab-switching feel broken.
    expect(neighbourBufferId(ids, 'c', 1)).toBe('a');
    expect(neighbourBufferId(ids, 'a', -1)).toBe('c');
  });

  it('starts at the first buffer when nothing is selected', () => {
    expect(neighbourBufferId(ids, null, 1)).toBe('a');
    expect(neighbourBufferId(ids, null, -1)).toBe('a');
  });

  it('recovers when the active buffer no longer exists', () => {
    expect(neighbourBufferId(ids, 'gone', 1)).toBe('a');
  });

  it('returns nothing when there are no buffers', () => {
    expect(neighbourBufferId([], null, 1)).toBeNull();
  });
});

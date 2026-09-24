import { describe, expect, it } from 'vitest';

import {
  SHORTCUTS,
  findShortcut,
  formatBinding,
  formatShortcut,
  isMacLike,
  matchesBinding,
  shortcutById,
  type KeyEventLike,
} from './shortcuts';

function key(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: 'k',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('isMacLike', () => {
  it('recognises the platforms that use Command', () => {
    expect(isMacLike('MacIntel')).toBe(true);
    expect(isMacLike('iPhone')).toBe(true);
    expect(isMacLike('Win32')).toBe(false);
    expect(isMacLike('Linux x86_64')).toBe(false);
  });
});

describe('matchesBinding', () => {
  it('matches the primary modifier per platform', () => {
    const binding = { key: 'k', mod: true };

    expect(matchesBinding(binding, key({ ctrlKey: true }), false)).toBe(true);
    // On a Mac the same binding is Command, not Control.
    expect(matchesBinding(binding, key({ metaKey: true }), true)).toBe(true);
    expect(matchesBinding(binding, key({ ctrlKey: true }), true)).toBe(false);
    expect(matchesBinding(binding, key({ metaKey: true }), false)).toBe(false);
  });

  it('is exact about modifiers', () => {
    const binding = { key: 'k', mod: true };

    // Ctrl+Shift+K is a different shortcut; firing this one too would make both
    // of them unreliable.
    expect(matchesBinding(binding, key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesBinding(binding, key({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it('ignores the case of the key', () => {
    // Shift makes `event.key` uppercase, so a shift binding would never match
    // otherwise.
    expect(
      matchesBinding(
        { key: 'b', mod: true, shift: true },
        key({ key: 'B', ctrlKey: true, shiftKey: true }),
        false,
      ),
    ).toBe(true);
  });

  it('accepts digits only for a digits binding', () => {
    expect(
      matchesBinding({ key: '1', mod: true }, key({ key: '5', ctrlKey: true }), false, true),
    ).toBe(true);
    // 0 and the function keys are not buffer slots.
    expect(
      matchesBinding({ key: '1', mod: true }, key({ key: '0', ctrlKey: true }), false, true),
    ).toBe(false);
    expect(
      matchesBinding({ key: '1', mod: true }, key({ key: '5', ctrlKey: true }), false, false),
    ).toBe(false);
  });
});

describe('findShortcut', () => {
  it('finds the palette shortcut', () => {
    const match = findShortcut(key({ ctrlKey: true }), SHORTCUTS, false);
    expect(match?.spec.id).toBe('palette.open');
  });

  it('tells the difference between the two sidebar toggles', () => {
    expect(findShortcut(key({ ctrlKey: true, key: 'b' }), SHORTCUTS, false)?.spec.id).toBe(
      'sidebar.toggle',
    );
    expect(
      findShortcut(key({ ctrlKey: true, shiftKey: true, key: 'B' }), SHORTCUTS, false)?.spec.id,
    ).toBe('members.toggle');
  });

  it('reports which buffer slot was pressed', () => {
    const match = findShortcut(key({ ctrlKey: true, key: '3' }), SHORTCUTS, false);
    expect(match?.spec.id).toBe('buffer.jump');
    expect(match?.digit).toBe(3);
  });

  it('accepts both spellings of next and previous', () => {
    expect(findShortcut(key({ ctrlKey: true, key: 'PageDown' }), SHORTCUTS, false)?.spec.id).toBe(
      'buffer.next',
    );
    expect(findShortcut(key({ ctrlKey: true, key: 'Tab' }), SHORTCUTS, false)?.spec.id).toBe(
      'buffer.next',
    );
    expect(findShortcut(key({ ctrlKey: true, key: 'PageUp' }), SHORTCUTS, false)?.spec.id).toBe(
      'buffer.previous',
    );
    expect(
      findShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }), SHORTCUTS, false)?.spec.id,
    ).toBe('buffer.previous');
  });

  it('ignores an unmodified key', () => {
    expect(findShortcut(key({ key: 'k' }), SHORTCUTS, false)).toBeNull();
    expect(findShortcut(key({ key: 'Enter' }), SHORTCUTS, false)).toBeNull();
  });
});

describe('formatBinding', () => {
  it('spells shortcuts the way Windows does', () => {
    expect(formatBinding({ key: 'k', mod: true }, false)).toBe('Ctrl+K');
    expect(formatBinding({ key: 'b', mod: true, shift: true }, false)).toBe('Ctrl+Shift+B');
    expect(formatBinding({ key: '1', mod: true }, false, true)).toBe('Ctrl+1…9');
  });

  it('uses symbols on a Mac', () => {
    expect(formatBinding({ key: 'k', mod: true }, true)).toBe('⌘K');
    expect(formatBinding({ key: 'b', mod: true, shift: true }, true)).toBe('⌘⇧B');
  });

  it('shows the first spelling of a shortcut that has several', () => {
    const next = shortcutById('buffer.next');
    expect(next).not.toBeNull();
    expect(formatShortcut(next!, false)).toBe('Ctrl+PageDown');
  });
});

describe('the shortcut table', () => {
  it('has unique ids', () => {
    const ids = SHORTCUTS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds every shortcut to at least one key', () => {
    for (const spec of SHORTCUTS) {
      expect(spec.keys.length).toBeGreaterThan(0);
    }
  });

  it('describes every shortcut', () => {
    for (const spec of SHORTCUTS) {
      expect(spec.descriptionKey).not.toBe('');
    }
  });

  it('does not bind the same combination twice', () => {
    // Two shortcuts on one combination means one of them silently never fires.
    const seen = new Set<string>();

    for (const spec of SHORTCUTS) {
      for (const binding of spec.keys) {
        const spelling = `${binding.key}|${binding.mod ?? false}|${binding.ctrl ?? false}|${binding.alt ?? false}|${binding.shift ?? false}|${spec.digits ?? false}`;
        expect(seen.has(spelling)).toBe(false);
        seen.add(spelling);
      }
    }
  });

  it('looks shortcuts up by id', () => {
    expect(shortcutById('palette.open')?.group).toBe('view');
    expect(shortcutById('nope')).toBeNull();
  });
});

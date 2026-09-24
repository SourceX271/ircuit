/**
 * The keyboard map.
 *
 * One table, for the same reason the slash commands have one: the dispatcher,
 * the command palette and any future "keyboard shortcuts" help panel all read
 * from here, so a shortcut cannot exist in one place and be missing from
 * another. It is also the only place that knows how a binding is spelled, which
 * is what keeps `Ctrl+K` and `⌘K` from being two hard-coded strings.
 *
 * Matching is deliberately exact about modifiers: `Ctrl+Shift+K` must not also
 * trigger `Ctrl+K`, or half the shortcuts would fire on the wrong key.
 */

/** A key plus the modifiers that must be held with it. */
export interface KeyBinding {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Ctrl on Windows and Linux, Command on macOS. */
  mod?: boolean;
  /** Ctrl everywhere, for the rare binding that really means the control key. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutGroup = 'view' | 'navigation' | 'buffer';

export interface ShortcutSpec {
  id: string;
  /** Every combination that triggers this shortcut. */
  keys: readonly KeyBinding[];
  /** i18n key under `shortcuts` describing what it does. */
  descriptionKey: string;
  group: ShortcutGroup;
  /**
   * The binding's key is a digit `1`–`9`, and the handler is told which one.
   *
   * Nine near-identical rows would be noise in this table and in the palette;
   * one row that says "jump to buffer 1–9" is what a reader wants.
   */
  digits?: boolean;
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  {
    id: 'palette.open',
    keys: [{ key: 'k', mod: true }],
    descriptionKey: 'paletteOpen',
    group: 'view',
  },
  {
    id: 'sidebar.toggle',
    keys: [{ key: 'b', mod: true }],
    descriptionKey: 'toggleSidebar',
    group: 'view',
  },
  {
    id: 'members.toggle',
    keys: [{ key: 'b', mod: true, shift: true }],
    descriptionKey: 'toggleMembers',
    group: 'view',
  },
  {
    id: 'buffer.next',
    keys: [
      { key: 'PageDown', mod: true },
      { key: 'Tab', mod: true },
    ],
    descriptionKey: 'nextBuffer',
    group: 'navigation',
  },
  {
    id: 'buffer.previous',
    keys: [
      { key: 'PageUp', mod: true },
      { key: 'Tab', mod: true, shift: true },
    ],
    descriptionKey: 'previousBuffer',
    group: 'navigation',
  },
  {
    id: 'buffer.jump',
    keys: [{ key: '1', mod: true }],
    descriptionKey: 'jumpToBuffer',
    group: 'navigation',
    digits: true,
  },
  {
    id: 'buffer.close',
    keys: [{ key: 'w', mod: true }],
    descriptionKey: 'closeBuffer',
    group: 'buffer',
  },
];

/** The parts of a keyboard event this module needs, so it can be tested. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Whether the platform uses Command where the rest of the world uses Control. */
export function isMacLike(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The platform string to decide key names with. */
export function currentPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.platform || navigator.userAgent || '';
}

function isDigit(key: string): boolean {
  return key.length === 1 && key >= '1' && key <= '9';
}

/**
 * Whether `event` is exactly this binding.
 *
 * `digits` comes from the owning spec rather than the binding: it describes what
 * the shortcut means, and repeating it on every key combination would invite the
 * two to disagree.
 */
export function matchesBinding(
  binding: KeyBinding,
  event: KeyEventLike,
  mac: boolean,
  digits = false,
): boolean {
  if (digits) {
    if (!isDigit(event.key)) return false;
  } else if (event.key.toLowerCase() !== binding.key.toLowerCase()) {
    return false;
  }

  // `mod` resolves to whatever the platform calls the primary modifier; every
  // other modifier has to match exactly, in both directions.
  const wantCtrl = Boolean(binding.ctrl) || (Boolean(binding.mod) && !mac);
  const wantMeta = Boolean(binding.mod) && mac;

  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.altKey === Boolean(binding.alt) &&
    event.shiftKey === Boolean(binding.shift)
  );
}

export interface ShortcutMatch {
  spec: ShortcutSpec;
  /** The digit pressed for a `digits` shortcut, otherwise `null`. */
  digit: number | null;
}

/** The shortcut this event triggers, if any. */
export function findShortcut(
  event: KeyEventLike,
  specs: readonly ShortcutSpec[] = SHORTCUTS,
  mac = isMacLike(currentPlatform()),
): ShortcutMatch | null {
  for (const spec of specs) {
    for (const binding of spec.keys) {
      if (matchesBinding(binding, event, mac, spec.digits ?? false)) {
        return { spec, digit: spec.digits ? Number(event.key) : null };
      }
    }
  }

  return null;
}

/** A lookup, so the palette can show what each shortcut is bound to. */
export function shortcutById(id: string): ShortcutSpec | null {
  return SHORTCUTS.find((spec) => spec.id === id) ?? null;
}

const MAC_SYMBOLS = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' } as const;

/**
 * How a key is written.
 *
 * Single characters are uppercased: `Ctrl+k` reads as a typo, and the key name
 * in the table is lowercase only so it can be compared case-insensitively.
 */
function displayKey(binding: KeyBinding, digits: boolean): string {
  if (digits) return '1…9';
  return binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
}

/** How a binding is written for humans, e.g. `Ctrl+Shift+B` or `⌘⇧B`. */
export function formatBinding(binding: KeyBinding, mac: boolean, digits = false): string {
  const key = displayKey(binding, digits);

  if (mac) {
    const symbols =
      `${binding.mod ? MAC_SYMBOLS.mod : ''}` +
      `${binding.ctrl ? MAC_SYMBOLS.ctrl : ''}` +
      `${binding.alt ? MAC_SYMBOLS.alt : ''}` +
      `${binding.shift ? MAC_SYMBOLS.shift : ''}`;

    return `${symbols}${key}`;
  }

  const parts: string[] = [];
  if (binding.mod || binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(key);

  return parts.join('+');
}

/** The primary spelling of a shortcut, for the palette and the help list. */
export function formatShortcut(spec: ShortcutSpec, mac: boolean): string {
  const [first] = spec.keys;
  return first ? formatBinding(first, mac, spec.digits ?? false) : '';
}

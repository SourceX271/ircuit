import { describe, expect, it } from 'vitest';

import {
  contrastText,
  escapeControlCharacters,
  isPlainMessage,
  PALETTE_BUCKETS,
  PALETTE_BUCKET_COUNT,
  paletteVariable,
  segmentStyle,
} from './formatting';
import type { MessageSegment, MessageStyle } from '@/lib/ipc';

const PLAIN: MessageStyle = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  monospace: false,
  reverse: false,
  fg_index: null,
  bg_index: null,
  fg_hex: null,
  bg_hex: null,
};

function style(overrides: Partial<MessageStyle> = {}): MessageStyle {
  return { ...PLAIN, ...overrides };
}

function segment(text: string, overrides: Partial<MessageStyle> = {}): MessageSegment {
  return { text, style: style(overrides) };
}

describe('PALETTE_BUCKETS', () => {
  it('covers the whole mIRC palette', () => {
    // The palette table runs 0..=99: the 16 classic colours followed by the
    // extended cube and greyscale ramp.
    expect(PALETTE_BUCKETS).toHaveLength(100);
  });

  it('leaves the 16 classic colours where they are', () => {
    for (let index = 0; index < PALETTE_BUCKET_COUNT; index += 1) {
      expect(PALETTE_BUCKETS[index]).toBe(index);
    }
  });

  it('folds every extended colour onto a real bucket', () => {
    for (const bucket of PALETTE_BUCKETS) {
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(PALETTE_BUCKET_COUNT);
    }
  });

  it('maps the dark reds and greys where you would expect', () => {
    // 52 is (95,0,0) → dark red; 59 is (95,95,95) → grey.
    expect(PALETTE_BUCKETS[52]).toBe(5);
    expect(PALETTE_BUCKETS[59]).toBe(14);
  });
});
describe('paletteVariable', () => {
  it('points at a theme token rather than a fixed colour', () => {
    // The whole point: the renderer must not hard-code what red looks like.
    expect(paletteVariable(4)).toBe('var(--ir-mirc-4)');
    expect(paletteVariable(0)).toBe('var(--ir-mirc-0)');
  });

  it('falls back instead of throwing on an out-of-range index', () => {
    expect(paletteVariable(200)).toBe('inherit');
    expect(paletteVariable(-1)).toBe('inherit');
  });
});

describe('segmentStyle', () => {
  it('produces nothing for a plain run', () => {
    expect(segmentStyle(PLAIN)).toEqual({});
  });

  it('maps attributes onto CSS properties', () => {
    expect(segmentStyle(style({ bold: true })).fontWeight).toBe(600);
    expect(segmentStyle(style({ italic: true })).fontStyle).toBe('italic');
    expect(segmentStyle(style({ monospace: true })).fontFamily).toBe('var(--font-mono)');
  });

  it('combines underline and strikethrough', () => {
    expect(segmentStyle(style({ underline: true, strikethrough: true })).textDecoration).toBe(
      'underline line-through',
    );
  });

  it('uses the theme variable for an indexed colour', () => {
    expect(segmentStyle(style({ fg_index: 4 })).color).toBe('var(--ir-mirc-4)');
  });

  it('uses the exact value for a hex colour', () => {
    // A 24-bit colour is an explicit request, so it is honoured as given.
    expect(segmentStyle(style({ fg_hex: 'FF8800' })).color).toBe('#FF8800');
  });

  it('ignores a malformed hex colour', () => {
    expect(segmentStyle(style({ fg_hex: 'nope' })).color).toBeUndefined();
  });

  it('swaps foreground and background for a reversed run', () => {
    const result = segmentStyle(style({ fg_index: 4, bg_index: 0, reverse: true }));
    expect(result.color).toBe('var(--ir-mirc-0)');
    expect(result.backgroundColor).toBe('var(--ir-mirc-4)');
  });

  it('picks readable text over a sender-chosen background', () => {
    const dark = segmentStyle(style({ bg_hex: '101010' }));
    expect(dark.color).toBe('#f5f6f8');

    const light = segmentStyle(style({ bg_hex: 'F0F0F0' }));
    expect(light.color).toBe('#14171c');
  });

  it('leaves an explicit foreground alone even with a background', () => {
    const result = segmentStyle(style({ fg_index: 4, bg_hex: '101010' }));
    expect(result.color).toBe('var(--ir-mirc-4)');
  });
});

describe('contrastText', () => {
  it('returns light text for dark backgrounds and dark text for light ones', () => {
    expect(contrastText('000000')).toBe('#f5f6f8');
    expect(contrastText('FFFFFF')).toBe('#14171c');
  });

  it('does not throw on garbage', () => {
    expect(contrastText('zzz')).toBe('inherit');
  });
});

describe('isPlainMessage', () => {
  it('is true when nothing is styled', () => {
    expect(isPlainMessage([segment('a'), segment('b')])).toBe(true);
  });

  it('is false as soon as anything is styled', () => {
    expect(isPlainMessage([segment('a'), segment('b', { bold: true })])).toBe(false);
    expect(isPlainMessage([segment('a', { fg_index: 4 })])).toBe(false);
  });
});

describe('escapeControlCharacters', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeControlCharacters('PRIVMSG #rust :hello')).toBe('PRIVMSG #rust :hello');
    expect(escapeControlCharacters('中文消息')).toBe('中文消息');
  });

  it('writes mIRC codes as readable escapes instead of tofu boxes', () => {
    // The traffic view is where these bytes are visible at all, and a box tells
    // the reader nothing about which code it was.
    expect(escapeControlCharacters('\u{0002}bold\u{0002}')).toBe('\\x02bold\\x02');
    expect(escapeControlCharacters('\u{0003}04red\u{0003}')).toBe('\\x0304red\\x03');
  });

  it('shows CTCP framing', () => {
    expect(escapeControlCharacters('\u{0001}VERSION\u{0001}')).toBe('\\x01VERSION\\x01');
  });

  it('covers DEL and the other C0 codes', () => {
    expect(escapeControlCharacters('\u{0000}')).toBe('\\x00');
    expect(escapeControlCharacters('\u{0007}')).toBe('\\x07');
    expect(escapeControlCharacters('\u{007f}')).toBe('\\x7f');
  });

  it('keeps characters that are real text', () => {
    // A zero-width joiner is part of emoji sequences; escaping it would be wrong.
    const family = '\u{1F468}\u{200D}\u{1F469}';
    expect(escapeControlCharacters(family)).toBe(family);
  });
});

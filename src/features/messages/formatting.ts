/**
 * Turning protocol formatting into something the DOM can render.
 *
 * The backend reports colours exactly as the protocol expressed them — a mIRC
 * palette index (`0..=98`) or a 24-bit value — because the protocol layer has no
 * business deciding what looks good. This module is where that decision is made,
 * and it makes it by pointing at theme tokens rather than at fixed colours, so
 * light and dark can each choose sensible values (see `--ir-mirc-*` in
 * `src/styles/index.css`).
 *
 * The extended palette (indices `16..=98`) is folded onto the 16 classic
 * colours, since those are what people actually type.
 */

import type { CSSProperties } from 'react';

import type { MessageSegment, MessageStyle } from '@/lib/ipc';

/**
 * Palette index to one of the 16 classic colours.
 *
 * Generated from the palette table in `ircuit-proto`, so it cannot drift from
 * the values the protocol layer decodes:
 *
 * ```text
 * cargo test -p ircuit-proto -- --ignored --nocapture dump_palette_buckets
 * ```
 */
export const PALETTE_BUCKETS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2, 2, 2, 12, 12, 3, 10, 10, 10, 10, 12,
  3, 10, 10, 10, 10, 10, 3, 10, 10, 10, 10, 11, 9, 10, 10, 10, 11, 11, 9, 9, 10, 11, 11, 11, 5, 6,
  6, 6, 6, 12, 5, 14, 14, 14, 14, 12, 3, 14, 14, 14, 14, 14, 3, 14, 14, 14, 14, 15, 9, 14, 14, 14,
  15, 11, 9, 9, 14, 15, 11, 11, 5, 6, 6, 6, 6, 6, 5, 14, 14, 14, 14, 14,
];

/** The number of distinct buckets the palette folds onto. */
export const PALETTE_BUCKET_COUNT = 16;

/**
 * Resolve a palette index to the CSS variable for its bucket.
 *
 * Out-of-range indices are a bug in the sending client; falling back to the
 * default colour keeps the line readable instead of dropping it.
 */
export function paletteVariable(index: number): string {
  const bucket = PALETTE_BUCKETS[index];
  if (bucket === undefined) return 'inherit';
  return `var(--ir-mirc-${bucket % PALETTE_BUCKET_COUNT})`;
}

/**
 * Whether a colour is dark enough that text on top of it should be light.
 *
 * Used for background colours, where the sender's choice would otherwise make
 * the text unreadable — a light background with the theme's light text is
 * invisible.
 */
export function contrastText(hex: string): string {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return 'inherit';

  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;

  // Rec. 601 luma is close enough for "is this background light or dark".
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? '#14171c' : '#f5f6f8';
}

/** Build the inline style for one run of text. */
export function segmentStyle(style: MessageStyle): CSSProperties {
  const css: CSSProperties = {};

  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  if (style.monospace) css.fontFamily = 'var(--font-mono)';

  // Strikethrough and underline can coexist; `text-decoration` is a list.
  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) css.textDecoration = decorations.join(' ');

  const foreground = colorValue(style.fg_index, style.fg_hex);
  const background = colorValue(style.bg_index, style.bg_hex);

  // `reverse` swaps the two, which is what the code means.
  const [fg, bg] = style.reverse ? [background, foreground] : [foreground, background];

  if (fg) css.color = fg;
  if (bg) {
    css.backgroundColor = bg;
    // A sender-chosen background does not know what the theme's text colour is,
    // so pick one that stays readable on top of it.
    if (!fg && style.bg_hex) css.color = contrastText(style.bg_hex);
  }

  return css;
}

/** Render a hex colour, normalising the missing-leading-zero case. */
function hexToCss(hex: string): string | null {
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

function colorValue(index: number | null, hex: string | null): string | null {
  if (hex !== null) {
    // A 24-bit colour is an explicit request, so it is used as given. The theme
    // only steps in for the indexed palette, where the sender was choosing from
    // a fixed set rather than picking a specific value.
    return hexToCss(hex);
  }
  if (index !== null) return paletteVariable(index);
  return null;
}

/**
 * Whether every run of a message is unstyled.
 *
 * Lets the renderer skip wrapping plain lines in a span per run.
 */
export function isPlainMessage(segments: readonly MessageSegment[]): boolean {
  return segments.every((segment) => isPlainStyle(segment.style));
}

export function isPlainStyle(style: MessageStyle): boolean {
  return (
    !style.bold &&
    !style.italic &&
    !style.underline &&
    !style.strikethrough &&
    !style.monospace &&
    !style.reverse &&
    style.fg_index === null &&
    style.bg_index === null &&
    style.fg_hex === null &&
    style.bg_hex === null
  );
}

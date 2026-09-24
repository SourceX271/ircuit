//! mIRC text formatting.
//!
//! IRC predates markup, so clients agreed on a set of in-band control codes
//! embedded in message text: bold/italic/underline/strikethrough/monospace,
//! indexed colours, and 24-bit colours. This module turns that byte soup into a
//! sequence of styled runs, which is what a renderer actually wants.
//!
//! References: the de-facto mIRC behaviour, as documented by modern clients.

use std::iter::Peekable;
use std::str::Chars;

/// Bold. Toggles.
pub const BOLD: char = '\u{0002}';
/// Italic. Toggles.
pub const ITALIC: char = '\u{001D}';
/// Underline. Toggles.
pub const UNDERLINE: char = '\u{001F}';
/// Strikethrough. Toggles.
pub const STRIKETHROUGH: char = '\u{001E}';
/// Monospace. Toggles.
pub const MONOSPACE: char = '\u{0011}';
/// Reverse foreground and background. Toggles.
pub const REVERSE: char = '\u{0016}';
/// Clear every attribute.
pub const RESET: char = '\u{000F}';
/// Colour: `fg[,bg]` using the mIRC palette.
pub const COLOR: char = '\u{0003}';
/// Colour: `RRGGBB[,RRGGBB]`.
pub const HEX_COLOR: char = '\u{0004}';
/// Bell. Not renderable, dropped.
const BELL: char = '\u{0007}';

/// A colour, either from the 99-entry mIRC palette or a 24-bit value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    /// Palette index, `0..=99`.
    Indexed(u8),
    /// 24-bit `0xRRGGBB`.
    Hex(u32),
}

impl Color {
    /// Split into `(r, g, b)` using the classic mIRC palette for indexed colours.
    #[must_use]
    pub fn to_rgb(self) -> (u8, u8, u8) {
        match self {
            Self::Hex(value) => (
                ((value >> 16) & 0xFF) as u8,
                ((value >> 8) & 0xFF) as u8,
                (value & 0xFF) as u8,
            ),
            // An out-of-range index is a bug in the sending client, not a reason
            // to panic or drop the message; fall back to the default colour.
            Self::Indexed(index) => MIRC_PALETTE
                .get(index as usize)
                .copied()
                .unwrap_or(DEFAULT_RGB),
        }
    }
}

/// Used when a colour index is outside the palette.
const DEFAULT_RGB: (u8, u8, u8) = (255, 255, 255);

/// The mIRC palette.
///
/// The first 16 entries are standardised; the rest is the widely implemented
/// greyscale/216-colour extension, so getting it wrong is cosmetic only.
#[rustfmt::skip]
const MIRC_PALETTE: &[(u8, u8, u8)] = &[
    (255, 255, 255), (0, 0, 0), (0, 0, 127), (0, 147, 0),
    (255, 0, 0), (127, 0, 0), (156, 0, 156), (252, 127, 0),
    (255, 255, 0), (0, 252, 0), (0, 147, 147), (0, 255, 255),
    (0, 0, 252), (255, 0, 255), (127, 127, 127), (202, 202, 202),
    (0, 0, 0), (0, 0, 95), (0, 0, 135), (0, 0, 175),
    (0, 0, 215), (0, 0, 255), (0, 95, 0), (0, 95, 95),
    (0, 95, 135), (0, 95, 175), (0, 95, 215), (0, 95, 255),
    (0, 135, 0), (0, 135, 95), (0, 135, 135), (0, 135, 175),
    (0, 135, 215), (0, 135, 255), (0, 175, 0), (0, 175, 95),
    (0, 175, 135), (0, 175, 175), (0, 175, 215), (0, 175, 255),
    (0, 215, 0), (0, 215, 95), (0, 215, 135), (0, 215, 175),
    (0, 215, 215), (0, 215, 255), (0, 255, 0), (0, 255, 95),
    (0, 255, 135), (0, 255, 175), (0, 255, 215), (0, 255, 255),
    (95, 0, 0), (95, 0, 95), (95, 0, 135), (95, 0, 175),
    (95, 0, 215), (95, 0, 255), (95, 95, 0), (95, 95, 95),
    (95, 95, 135), (95, 95, 175), (95, 95, 215), (95, 95, 255),
    (95, 135, 0), (95, 135, 95), (95, 135, 135), (95, 135, 175),
    (95, 135, 215), (95, 135, 255), (95, 175, 0), (95, 175, 95),
    (95, 175, 135), (95, 175, 175), (95, 175, 215), (95, 175, 255),
    (95, 215, 0), (95, 215, 95), (95, 215, 135), (95, 215, 175),
    (95, 215, 215), (95, 215, 255), (95, 255, 0), (95, 255, 95),
    (95, 255, 135), (95, 255, 175), (95, 255, 215), (95, 255, 255),
    (135, 0, 0), (135, 0, 95), (135, 0, 135), (135, 0, 175),
    (135, 0, 215), (135, 0, 255), (135, 95, 0), (135, 95, 95),
    (135, 95, 135), (135, 95, 175), (135, 95, 215), (135, 95, 255),
];

/// The attributes in effect for a run of text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub monospace: bool,
    pub reverse: bool,
    pub fg: Option<Color>,
    pub bg: Option<Color>,
}

impl Style {
    /// Whether this run carries no formatting at all.
    #[must_use]
    pub fn is_plain(&self) -> bool {
        *self == Self::default()
    }
}

/// A run of text sharing one [`Style`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub style: Style,
}

/// Split `input` into styled runs.
///
/// Empty runs are never produced, so a renderer can map segments straight to
/// elements without filtering.
#[must_use]
pub fn parse(input: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut style = Style::default();
    let mut buffer = String::new();

    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            BOLD => toggle(&mut segments, &mut buffer, &mut style, |s| &mut s.bold),
            ITALIC => toggle(&mut segments, &mut buffer, &mut style, |s| &mut s.italic),
            UNDERLINE => toggle(&mut segments, &mut buffer, &mut style, |s| &mut s.underline),
            STRIKETHROUGH => {
                toggle(&mut segments, &mut buffer, &mut style, |s| {
                    &mut s.strikethrough
                });
            }
            MONOSPACE => toggle(&mut segments, &mut buffer, &mut style, |s| &mut s.monospace),
            REVERSE => toggle(&mut segments, &mut buffer, &mut style, |s| &mut s.reverse),
            RESET => {
                flush(&mut segments, &mut buffer, style);
                style = Style::default();
            }
            COLOR => {
                flush(&mut segments, &mut buffer, style);
                style.fg = read_decimal(&mut chars);
                style.bg = read_optional_color(&mut chars, read_decimal);
            }
            HEX_COLOR => {
                flush(&mut segments, &mut buffer, style);
                style.fg = read_hex(&mut chars).map(Color::Hex);
                style.bg = read_optional_color(&mut chars, |chars| read_hex(chars).map(Color::Hex));
            }
            BELL => {}
            _ => buffer.push(ch),
        }
    }

    flush(&mut segments, &mut buffer, style);
    segments
}

/// `input` with every formatting code removed.
///
/// Used for notifications, search indexing and log export — anywhere the markup
/// would be noise.
#[must_use]
pub fn strip(input: &str) -> String {
    let mut out = String::with_capacity(input.len());

    for segment in parse(input) {
        out.push_str(&segment.text);
    }

    out
}

fn toggle(
    segments: &mut Vec<Segment>,
    buffer: &mut String,
    style: &mut Style,
    field: impl FnOnce(&mut Style) -> &mut bool,
) {
    flush(segments, buffer, *style);
    let flag = field(style);
    *flag = !*flag;
}

fn flush(segments: &mut Vec<Segment>, buffer: &mut String, style: Style) {
    if buffer.is_empty() {
        return;
    }

    segments.push(Segment {
        text: std::mem::take(buffer),
        style,
    });
}

/// Consume up to `max` characters satisfying `predicate`.
fn take_while_max(
    chars: &mut Peekable<Chars<'_>>,
    max: usize,
    predicate: fn(char) -> bool,
) -> String {
    let mut out = String::new();

    while out.len() < max {
        match chars.peek() {
            Some(&candidate) if predicate(candidate) => {
                out.push(candidate);
                chars.next();
            }
            _ => break,
        }
    }

    out
}

/// Read a 1–2 digit mIRC palette index.
fn read_decimal(chars: &mut Peekable<Chars<'_>>) -> Option<Color> {
    let digits = take_while_max(chars, 2, |c| c.is_ascii_digit());
    if digits.is_empty() {
        return None;
    }

    digits.parse::<u8>().ok().map(Color::Indexed)
}

/// Read exactly six hex digits, without consuming anything if there are fewer.
///
/// The hex extension is fixed-width, so a short run is not a colour at all; the
/// lookahead keeps those characters in the message rather than swallowing them.
fn read_hex(chars: &mut Peekable<Chars<'_>>) -> Option<u32> {
    let mut probe = chars.clone();
    let digits = take_while_max(&mut probe, 6, |c| c.is_ascii_hexdigit());

    if digits.len() != 6 {
        return None;
    }

    let value = u32::from_str_radix(&digits, 16).ok();
    if value.is_some() {
        *chars = probe;
    }

    value
}

/// Read `[,color]`, leaving the comma unconsumed when no colour follows.
fn read_optional_color(
    chars: &mut Peekable<Chars<'_>>,
    read: impl FnOnce(&mut Peekable<Chars<'_>>) -> Option<Color>,
) -> Option<Color> {
    if chars.peek() != Some(&',') {
        return None;
    }

    let mut probe = chars.clone();
    probe.next();

    match read(&mut probe) {
        Some(color) => {
            *chars = probe;
            Some(color)
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_yields_one_default_segment() {
        let segments = parse("hello world");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "hello world");
        assert!(segments[0].style.is_plain());
    }

    #[test]
    fn empty_input_yields_no_segments() {
        assert!(parse("").is_empty());
        // A lone formatting code must not produce an empty run either.
        assert!(parse(&BOLD.to_string()).is_empty());
    }

    #[test]
    fn bold_toggles_around_the_text() {
        let input = format!("a{BOLD}bold{BOLD}c");
        let segments = parse(&input);

        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].text, "a");
        assert!(!segments[0].style.bold);
        assert!(segments[1].style.bold);
        assert_eq!(segments[1].text, "bold");
        assert!(!segments[2].style.bold);
    }

    #[test]
    fn every_attribute_code_is_recognised() {
        // Asserting one code at a time keeps each failure self-explanatory.
        fn applied(input: &str, read: impl Fn(&Style) -> bool) -> bool {
            let segments = parse(input);
            segments.len() == 1 && read(&segments[0].style)
        }

        assert!(applied(&format!("{ITALIC}x"), |s| s.italic));
        assert!(applied(&format!("{UNDERLINE}x"), |s| s.underline));
        assert!(applied(&format!("{STRIKETHROUGH}x"), |s| s.strikethrough));
        assert!(applied(&format!("{MONOSPACE}x"), |s| s.monospace));
        assert!(applied(&format!("{REVERSE}x"), |s| s.reverse));
    }

    #[test]
    fn reset_clears_everything() {
        let input = format!("{BOLD}{COLOR}4x{RESET}y");
        let segments = parse(&input);

        assert!(segments[0].style.bold);
        assert_eq!(segments[0].style.fg, Some(Color::Indexed(4)));
        assert!(segments[1].style.is_plain());
        assert_eq!(segments[1].text, "y");
    }

    #[test]
    fn parses_indexed_colour_with_background() {
        let input = format!("{COLOR}04,12x");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, Some(Color::Indexed(4)));
        assert_eq!(segments[0].style.bg, Some(Color::Indexed(12)));
        assert_eq!(segments[0].text, "x");
    }

    #[test]
    fn single_digit_colour_is_valid() {
        let input = format!("{COLOR}4x");
        assert_eq!(parse(&input)[0].style.fg, Some(Color::Indexed(4)));
    }

    #[test]
    fn bare_colour_code_resets_to_default() {
        let input = format!("{COLOR}4a{COLOR}b");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, Some(Color::Indexed(4)));
        assert_eq!(segments[1].style.fg, None);
        assert_eq!(segments[1].style.bg, None);
    }

    #[test]
    fn colour_digits_are_not_rendered_as_text() {
        let input = format!("{COLOR}04,12hello");
        assert_eq!(strip(&input), "hello");
    }

    #[test]
    fn comma_without_a_background_colour_stays_as_text() {
        let input = format!("{COLOR}4,x");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, Some(Color::Indexed(4)));
        assert_eq!(segments[0].text, ",x");
    }

    #[test]
    fn parses_hex_colour() {
        let input = format!("{HEX_COLOR}FF8800x");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, Some(Color::Hex(0xFF8800)));
        assert_eq!(segments[0].text, "x");
    }

    #[test]
    fn parses_hex_foreground_and_background() {
        let input = format!("{HEX_COLOR}FFFFFF,000080x");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, Some(Color::Hex(0xFFFFFF)));
        assert_eq!(segments[0].style.bg, Some(Color::Hex(0x000080)));
    }

    #[test]
    fn short_hex_run_is_left_as_text() {
        // Only five digits: not a colour, so nothing may be swallowed.
        let input = format!("{HEX_COLOR}FF880x");
        let segments = parse(&input);

        assert_eq!(segments[0].style.fg, None);
        assert_eq!(segments[0].text, "FF880x");
    }

    #[test]
    fn bell_is_dropped() {
        assert_eq!(strip("ding\u{0007}!"), "ding!");
    }

    #[test]
    fn strip_removes_all_codes() {
        let input = format!("{BOLD}bold{RESET} {COLOR}04red{RESET} plain");
        assert_eq!(strip(&input), "bold red plain");
    }

    #[test]
    fn palette_lookup_covers_the_ends() {
        assert_eq!(Color::Indexed(0).to_rgb(), (255, 255, 255));
        assert_eq!(Color::Indexed(4).to_rgb(), (255, 0, 0));
        assert_eq!(Color::Hex(0x123456).to_rgb(), (0x12, 0x34, 0x56));
        // Out-of-range indices must not panic.
        assert_eq!(Color::Indexed(200).to_rgb(), (255, 255, 255));
    }

    #[test]
    fn cjk_text_is_not_mangled() {
        let input = format!("{BOLD}中文消息{RESET}");
        let segments = parse(&input);

        assert_eq!(segments[0].text, "中文消息");
        assert!(segments[0].style.bold);
    }
}

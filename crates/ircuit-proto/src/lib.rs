//! IRC wire format: RFC 1459 / RFC 2812 message parsing and serialization,
//! IRCv3 message tags, mIRC formatting codes, and line splitting.
//!
//! This crate is deliberately pure and I/O-free: it only converts between bytes
//! and typed values. That keeps the most error-prone part of the client
//! exhaustively unit-testable and independent of the network layer.
//!
//! # Text encoding
//!
//! IRC is byte-oriented, but modern networks are UTF-8 and everything here works
//! on `&str`. Converting raw bytes to text is the transport layer's job (see
//! `ircuit-encoding`); the protocol layer never guesses.
//!
//! # Example
//!
//! ```
//! use ircuit_proto::{Command, Message};
//!
//! let message = Message::parse(":bob!b@example.com PRIVMSG #rust :hello world").unwrap();
//! assert_eq!(message.nick(), Some("bob"));
//! assert_eq!(message.command, Command::Privmsg);
//! assert_eq!(message.param(1), Some("hello world"));
//! assert_eq!(message.to_wire(), ":bob!b@example.com PRIVMSG #rust :hello world");
//! ```

pub mod formatting;
pub mod message;
pub mod split;
pub mod tags;

pub use formatting::{parse as parse_formatting, strip as strip_formatting, Color, Segment, Style};
pub use message::{Command, Message, ParseError, Prefix};
pub use split::{privmsg_budget, split_privmsg, split_text, SplitError};
pub use tags::Tags;

/// Maximum size of a single IRC protocol line, including the trailing `CRLF`.
///
/// RFC 1459 §2.3 limits a message to 512 bytes *including* the trailing CRLF,
/// which leaves 510 bytes of payload. Servers that advertise `message-tags`
/// allow a larger limit for the tag section; callers that care should pass an
/// explicit budget instead of relying on this constant.
pub const MAX_LINE_BYTES: usize = 512;

#[cfg(test)]
mod tests {
    use super::{strip_formatting, Command, Message, MAX_LINE_BYTES};

    #[test]
    fn line_limit_counts_the_trailing_crlf() {
        assert_eq!(
            MAX_LINE_BYTES, 512,
            "RFC 1459 §2.3 counts the trailing CRLF"
        );
    }

    #[test]
    fn the_modules_compose() {
        // A realistic line: tags, prefix, a formatting code and Chinese text.
        let line = "@account=bob :bob!b@h PRIVMSG #rust :\u{0002}你好\u{000F} world";
        let message = Message::parse(line).unwrap();

        assert_eq!(message.command, Command::Privmsg);
        assert_eq!(message.tag("account"), Some("bob"));
        assert_eq!(strip_formatting(message.param(1).unwrap()), "你好 world");
    }
}

//! IRC wire format: RFC 1459 / RFC 2812 message parsing and serialization,
//! IRCv3 message tags, and mIRC formatting code handling.
//!
//! This crate is deliberately pure and I/O-free: it only converts between bytes
//! and typed values. That keeps the most error-prone part of the client
//! exhaustively unit-testable and independent of the network layer.
//!
//! **M0 scope**: crate skeleton only. The implementation lands in M1.

/// Maximum size of a single IRC protocol line, including the trailing `CRLF`.
///
/// RFC 1459 §2.3 limits a message to 512 bytes *including* the trailing CRLF,
/// which leaves 510 bytes of payload. IRCv3 servers that advertise
/// `message-tags` allow a larger limit for the tag section; that is handled
/// separately when the protocol implementation lands in M1.
pub const MAX_LINE_BYTES: usize = 512;

#[cfg(test)]
mod tests {
    use super::MAX_LINE_BYTES;

    #[test]
    fn line_limit_counts_the_trailing_crlf() {
        assert_eq!(
            MAX_LINE_BYTES, 512,
            "RFC 1459 §2.3 counts the trailing CRLF"
        );
    }
}

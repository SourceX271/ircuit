//! Splitting long outgoing messages into protocol-legal lines.
//!
//! IRC lines are capped at 512 bytes including the trailing CRLF, and the cap
//! covers the command and target too. Splitting naively by byte index would cut
//! UTF-8 sequences in half and turn Chinese text into mojibake, so this module
//! only ever breaks on character boundaries and prefers whitespace.

use thiserror::Error;

/// Why a message could not be split.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SplitError {
    /// The command and target alone exceed the line budget, leaving no room.
    #[error("target {target:?} leaves no room for text within {max_line_bytes} bytes")]
    NoRoomForText {
        target: String,
        max_line_bytes: usize,
    },
}

/// How many bytes of message text fit in a `PRIVMSG` to `target`.
///
/// Returns `None` when the command and target alone already exceed the budget.
#[must_use]
pub fn privmsg_budget(target: &str, max_line_bytes: usize) -> Option<usize> {
    // "PRIVMSG " + target + " :" + CRLF
    let overhead = "PRIVMSG ".len() + target.len() + " :".len() + 2;

    max_line_bytes
        .checked_sub(overhead)
        .filter(|budget| *budget > 0)
}

/// Split `text` into `PRIVMSG` lines for `target`, each within the line limit.
///
/// A short message yields exactly one line, so callers can use this
/// unconditionally rather than checking the length first.
pub fn split_privmsg(
    target: &str,
    text: &str,
    max_line_bytes: usize,
) -> Result<Vec<String>, SplitError> {
    let budget =
        privmsg_budget(target, max_line_bytes).ok_or_else(|| SplitError::NoRoomForText {
            target: target.to_owned(),
            max_line_bytes,
        })?;

    if text.is_empty() {
        // An empty message is still a message; send one empty line rather than
        // silently sending nothing.
        return Ok(vec![String::new()]);
    }

    Ok(split_text(text, budget))
}

/// Split `text` into chunks of at most `budget` bytes, on character boundaries.
#[must_use]
pub fn split_text(text: &str, budget: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut rest = text;

    while !rest.is_empty() {
        if rest.len() <= budget {
            chunks.push(rest.to_owned());
            break;
        }

        // Largest index within budget that is a character boundary.
        let mut cut = budget;
        while cut > 0 && !rest.is_char_boundary(cut) {
            cut -= 1;
        }

        if cut == 0 {
            // A single character is wider than the whole budget. Emit it alone
            // so the loop always makes progress; the caller's line will exceed
            // the limit, but dropping the character would be worse.
            let width = rest.chars().next().map_or(1, char::len_utf8);
            chunks.push(rest[..width].to_owned());
            rest = &rest[width..];
            continue;
        }

        let window = &rest[..cut];

        // Only fall back to a whitespace break when the budget actually lands
        // inside a word. If the window already ends at a word boundary, using it
        // whole wastes nothing.
        let ends_at_word_boundary = rest[cut..].chars().next().is_some_and(char::is_whitespace);

        let split_at = if ends_at_word_boundary {
            None
        } else {
            // Prefer the last whitespace so words are not cut in half.
            window.rfind(char::is_whitespace).filter(|index| *index > 0)
        };

        match split_at {
            Some(index) => {
                chunks.push(rest[..index].to_owned());
                rest = rest[index..].trim_start();
            }
            None => {
                chunks.push(window.to_owned());
                rest = rest[cut..].trim_start();
            }
        }
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_LINE_BYTES;

    #[test]
    fn budget_accounts_for_command_target_and_crlf() {
        // "PRIVMSG " (8) + "#rust" (5) + " :" (2) + CRLF (2) = 17
        assert_eq!(
            privmsg_budget("#rust", MAX_LINE_BYTES),
            Some(MAX_LINE_BYTES - 17)
        );
    }

    #[test]
    fn absurdly_long_target_has_no_budget() {
        let target = "x".repeat(MAX_LINE_BYTES);
        assert_eq!(privmsg_budget(&target, MAX_LINE_BYTES), None);
    }

    #[test]
    fn short_message_is_a_single_line() {
        let lines = split_privmsg("#rust", "hello", MAX_LINE_BYTES).unwrap();
        assert_eq!(lines, vec!["hello"]);
    }

    #[test]
    fn empty_message_still_produces_one_line() {
        assert_eq!(
            split_privmsg("#rust", "", MAX_LINE_BYTES).unwrap(),
            vec![""]
        );
    }

    #[test]
    fn every_produced_line_fits_the_budget() {
        let budget = privmsg_budget("#rust", MAX_LINE_BYTES).unwrap();
        let text = "word ".repeat(500);
        let lines = split_privmsg("#rust", &text, MAX_LINE_BYTES).unwrap();

        assert!(lines.len() > 1);
        for line in &lines {
            assert!(
                line.len() <= budget,
                "line of {} bytes exceeds {budget}",
                line.len()
            );
        }
    }

    #[test]
    fn splitting_prefers_whitespace() {
        let text = "alpha beta gamma delta";
        // Budget that fits "alpha beta" (10) but not "alpha beta " (11).
        let chunks = split_text(text, 10);
        assert_eq!(chunks, vec!["alpha beta", "gamma", "delta"]);
    }

    #[test]
    fn splits_words_only_when_a_word_cannot_fit() {
        let chunks = split_text("abcdefghij", 4);
        assert_eq!(chunks, vec!["abcd", "efgh", "ij"]);
    }

    #[test]
    fn never_cuts_a_utf8_sequence() {
        // Each han character is 3 bytes; a budget of 4 fits one character.
        let text = "中文消息测试";
        let chunks = split_text(text, 4);

        for chunk in &chunks {
            assert!(chunk.is_char_boundary(chunk.len()));
        }
        assert_eq!(chunks.join(""), text);
    }

    #[test]
    fn reassembling_chunks_loses_nothing_but_separators() {
        let text = "the quick brown fox jumps over the lazy dog";
        let chunks = split_text(text, 12);
        assert_eq!(chunks.join(" "), text);
    }

    #[test]
    fn a_character_wider_than_the_budget_still_makes_progress() {
        let chunks = split_text("中", 1);
        assert_eq!(chunks, vec!["中"]);
    }

    #[test]
    fn zero_budget_is_reported_rather_than_looping() {
        let target = "y".repeat(MAX_LINE_BYTES);
        assert!(matches!(
            split_privmsg(&target, "hi", MAX_LINE_BYTES),
            Err(SplitError::NoRoomForText { .. })
        ));
    }
}

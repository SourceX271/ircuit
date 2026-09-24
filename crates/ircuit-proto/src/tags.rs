//! IRCv3 message tags.
//!
//! Tags arrive as `@key=value;key2=value2 ` at the head of a message. Both the
//! key and the value may contain characters that would otherwise break the
//! framing, so the spec defines an escape scheme that this module implements in
//! both directions.
//!
//! The wire format is **not** UTF-8-safe in general (the spec is byte-oriented),
//! but tags in practice carry UTF-8 text. Decoding raw bytes into text is the
//! transport layer's job (see `ircuit-encoding`); this module works on `&str`.

use std::fmt::Write as _;

/// Maximum size of the tag section, per the IRCv3 `message-tags` specification.
pub const MAX_TAG_BYTES: usize = 8191;

/// Escape a tag value for the wire.
///
/// The five substitutions are mandated by the specification and must be applied
/// in this order: the backslash escape has to come last, otherwise the
/// backslashes introduced by the earlier replacements would be escaped again.
#[must_use]
pub fn escape_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());

    for ch in value.chars() {
        match ch {
            ';' => out.push_str("\\:"),
            ' ' => out.push_str("\\s"),
            '\\' => out.push_str("\\\\"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }

    out
}

/// Undo [`escape_value`].
///
/// An unknown escape sequence is passed through verbatim rather than rejected:
/// being lenient here keeps us talking to servers that emit slightly invalid
/// tags, which is strictly better than dropping the message.
#[must_use]
pub fn unescape_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }

    out
}

/// An ordered set of IRCv3 tags.
///
/// Order is preserved because it is observable on the wire and makes test
/// failures far easier to read. Duplicate keys are kept as-received; [`Tags::get`]
/// returns the first match.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tags {
    entries: Vec<(String, Option<String>)>,
}

impl Tags {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse the tag section, i.e. everything after `@` and before the space.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let mut tags = Self::new();

        for pair in raw.split(';') {
            if pair.is_empty() {
                continue;
            }

            match pair.split_once('=') {
                Some((key, value)) => {
                    tags.entries
                        .push((key.to_owned(), Some(unescape_value(value))));
                }
                None => tags.entries.push((pair.to_owned(), None)),
            }
        }

        tags
    }

    /// Render the tag section, without the leading `@` or trailing space.
    #[must_use]
    pub fn to_wire(&self) -> String {
        let mut out = String::new();

        for (index, (key, value)) in self.entries.iter().enumerate() {
            if index > 0 {
                out.push(';');
            }

            out.push_str(key);

            if let Some(value) = value {
                // Writing into a String cannot fail.
                let _ = write!(out, "={}", escape_value(value));
            }
        }

        out
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.entries.push((key.into(), Some(value.into())));
    }

    /// Insert a tag that carries no value, e.g. `@draft/reply` used as a marker.
    pub fn insert_valueless(&mut self, key: impl Into<String>) {
        self.entries.push((key.into(), None));
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(candidate, _)| candidate == key)
            .and_then(|(_, value)| value.as_deref())
    }

    /// Whether a valueless tag is present.
    #[must_use]
    pub fn contains(&self, key: &str) -> bool {
        self.entries.iter().any(|(candidate, _)| candidate == key)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, Option<&str>)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_deref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_covers_every_special_character() {
        assert_eq!(escape_value("a;b c\\d\re\nf"), "a\\:b\\sc\\\\d\\re\\nf");
    }

    #[test]
    fn backslash_is_escaped_exactly_once() {
        // A naive implementation that escapes '\' first would turn this into
        // "\\\\s" and the space would survive unescaped on the wire.
        assert_eq!(escape_value("\\s"), "\\\\s");
    }

    #[test]
    fn unescape_is_the_inverse_of_escape() {
        let original = "semi; space \\ cr\r lf\n plain";
        assert_eq!(unescape_value(&escape_value(original)), original);
    }

    #[test]
    fn unknown_escape_is_preserved_verbatim() {
        assert_eq!(unescape_value("a\\qb"), "a\\qb");
        assert_eq!(unescape_value("trailing\\"), "trailing\\");
    }

    #[test]
    fn parses_valueless_and_valued_tags() {
        let tags = Tags::parse("time=2024-01-01T00:00:00.000Z;draft/reply;msgid=abc");
        assert_eq!(tags.len(), 3);
        assert_eq!(tags.get("time"), Some("2024-01-01T00:00:00.000Z"));
        assert_eq!(tags.get("msgid"), Some("abc"));
        assert!(tags.contains("draft/reply"));
        assert_eq!(tags.get("draft/reply"), None);
    }

    #[test]
    fn empty_tag_section_yields_no_tags() {
        assert!(Tags::parse("").is_empty());
        // A stray separator must not produce a phantom empty tag.
        assert!(Tags::parse(";;").is_empty());
    }

    #[test]
    fn value_may_contain_equals_signs() {
        let tags = Tags::parse("key=a=b=c");
        assert_eq!(tags.get("key"), Some("a=b=c"));
    }

    #[test]
    fn round_trips_through_the_wire() {
        let mut tags = Tags::new();
        tags.insert("msgid", "abc");
        tags.insert("draft/reply", "parent;with space");
        tags.insert_valueless("account");

        let wire = tags.to_wire();
        assert_eq!(wire, "msgid=abc;draft/reply=parent\\:with\\sspace;account");

        let reparsed = Tags::parse(&wire);
        assert_eq!(reparsed.get("draft/reply"), Some("parent;with space"));
        assert!(reparsed.contains("account"));
        assert_eq!(reparsed, tags);
    }
}

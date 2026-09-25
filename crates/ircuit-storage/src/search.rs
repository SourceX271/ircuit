//! Turning user text into something FTS5 can actually match.
//!
//! FTS5 with the `unicode61` tokenizer splits on Unicode word boundaries. For
//! Latin scripts that is exactly right. For Chinese and Japanese it is useless:
//! there are no spaces, so `今天发布了新版本` becomes **one** token and searching
//! for `发布` matches nothing. That is not a bug in SQLite — without a
//! dictionary, "word" has no meaning in those scripts.
//!
//! The fix used here needs no dictionary and no extra dependency: index a copy
//! of the text with every CJK character separated by a space, so the ordinary
//! tokenizer sees one token per character. A two-character word then becomes a
//! two-token adjacency, which a quoted phrase matches.
//!
//! `trigram` is the other tokenizer that handles CJK, but it cannot match
//! queries shorter than three characters — and two-character Chinese words are
//! everywhere — so it is not a substitute.
//!
//! Both functions are pure, and they must agree: whatever [`segment`] does to
//! the text being stored, [`to_match_query`] must do to the text being searched.

/// Whether a character is written without spaces between words.
///
/// Covers CJK ideographs (including the extensions), Japanese kana and Hangul
/// syllables. Hangul is included even though Korean is written with spaces:
/// segmenting it changes nothing for text that already has them, and a
/// space-less Korean run would otherwise be one unsearchable token.
fn is_unspaced_script(ch: char) -> bool {
    matches!(ch,
        // CJK radical supplement, Kangxi radicals, CJK symbols and punctuation
        // are deliberately excluded: they are punctuation-like and splitting
        // them adds tokens without helping any real query.
        '\u{3040}'..='\u{309F}'   // Hiragana
        | '\u{30A0}'..='\u{30FF}' // Katakana
        | '\u{3400}'..='\u{4DBF}' // CJK unified ideographs extension A
        | '\u{4E00}'..='\u{9FFF}' // CJK unified ideographs
        | '\u{AC00}'..='\u{D7AF}' // Hangul syllables
        | '\u{F900}'..='\u{FAFF}' // CJK compatibility ideographs
        | '\u{20000}'..='\u{2FA1F}' // extensions B onwards
    )
}

/// Split every unspaced-script character onto its own token.
///
/// Latin text is returned unchanged (modulo collapsed whitespace), so the index
/// pays the extra storage only for scripts that need it.
///
/// ```
/// # use ircuit_storage::search::segment;
/// assert_eq!(segment("今天发布了新版本"), "今 天 发 布 了 新 版 本");
/// assert_eq!(segment("release day"), "release day");
/// assert_eq!(segment("今天 release 了"), "今 天 release 了");
/// ```
#[must_use]
pub fn segment(text: &str) -> String {
    let mut spaced = String::with_capacity(text.len() + 8);

    for ch in text.chars() {
        if is_unspaced_script(ch) {
            if !spaced.is_empty() && !spaced.ends_with(' ') {
                spaced.push(' ');
            }
            spaced.push(ch);
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }

    // Collapse the runs the loop can produce, and drop the padding at the ends.
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The value to store in `message.body_indexed`, or `None` when there is
/// nothing to store.
///
/// For a Latin-script message the segmented copy is byte-for-byte the original,
/// and keeping both would nearly double the size of an archive the user chose to
/// keep forever. `None` means "the index should read `body` directly"; the
/// triggers spell that as `COALESCE(body_indexed, body)`.
///
/// ```
/// # use ircuit_storage::search::indexed_copy;
/// assert_eq!(indexed_copy("hello"), None);
/// assert_eq!(indexed_copy("今天"), Some("今 天".to_owned()));
/// ```
#[must_use]
pub fn indexed_copy(text: &str) -> Option<String> {
    let segmented = segment(text);
    if segmented == text {
        None
    } else {
        Some(segmented)
    }
}

/// Build an FTS5 `MATCH` expression for a user's query.
///
/// Every term is quoted. FTS5 has its own little query language — `AND`, `OR`,
/// `NEAR`, `*`, `:`, `-`, parentheses — and a user typing `foo-bar` or `C++`
/// would otherwise get a syntax error or, worse, a silently different query. A
/// quoted string is a phrase of plain tokens, which is what someone typing into
/// a search box means.
///
/// Returns `None` for a query with nothing searchable in it.
#[must_use]
pub fn to_match_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        // A term made only of punctuation produces no token at all, and quoting
        // it would build an empty phrase that FTS5 rejects as a syntax error.
        .filter(|term| term.chars().any(char::is_alphanumeric))
        // Segment first, then quote: the segmentation is what turns a
        // two-character Chinese word into an adjacency the phrase can match.
        .map(|term| format!("\"{}\"", segment(term).replace('"', "\"\"")))
        .collect();

    if terms.is_empty() {
        return None;
    }

    // Space between quoted phrases is FTS5's implicit AND, which is what a
    // multi-word query should mean.
    Some(terms.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin_text_is_left_alone() {
        assert_eq!(segment("hello world"), "hello world");
        assert_eq!(segment("café au lait"), "café au lait");
    }

    #[test]
    fn chinese_is_split_per_character() {
        assert_eq!(segment("今天发布了新版本"), "今 天 发 布 了 新 版 本");
    }

    #[test]
    fn japanese_is_split_per_character() {
        assert_eq!(segment("テストします"), "テ ス ト し ま す");
    }

    #[test]
    fn hangul_is_split_per_syllable() {
        assert_eq!(segment("안녕하세요"), "안 녕 하 세 요");
    }

    #[test]
    fn mixed_text_keeps_its_words_whole() {
        // The Latin run must stay one token, or "release" would never match.
        assert_eq!(segment("今天 release 了"), "今 天 release 了");
        assert_eq!(segment("发布v2.5版本"), "发 布 v2.5 版 本");
    }

    #[test]
    fn whitespace_in_the_input_is_normalised() {
        assert_eq!(segment("  a   b  "), "a b");
        assert_eq!(segment("今\n天"), "今 天");
        assert_eq!(segment(""), "");
    }

    #[test]
    fn queries_are_quoted_so_fts_syntax_cannot_leak_in() {
        assert_eq!(to_match_query("hello").as_deref(), Some("\"hello\""));

        // `foo-bar`, `C++` and `NEAR` would all mean something else unquoted.
        assert_eq!(to_match_query("foo-bar").as_deref(), Some("\"foo-bar\""));
        assert_eq!(to_match_query("C++").as_deref(), Some("\"C++\""));
        assert_eq!(to_match_query("NEAR").as_deref(), Some("\"NEAR\""));
    }

    #[test]
    fn a_chinese_word_becomes_a_phrase() {
        // Two characters, two tokens, adjacent — this is the whole trick.
        assert_eq!(to_match_query("发布").as_deref(), Some("\"发 布\""));
    }

    #[test]
    fn several_terms_are_combined_with_and() {
        assert_eq!(
            to_match_query("hello 发布").as_deref(),
            Some("\"hello\" \"发 布\"")
        );
    }

    #[test]
    fn embedded_quotes_are_escaped_rather_than_closing_the_phrase() {
        // A lone `"` would otherwise end the phrase and leave the rest as
        // query syntax.
        assert_eq!(
            to_match_query("say \"hi\"").as_deref(),
            Some("\"say\" \"\"\"hi\"\"\"")
        );
    }

    #[test]
    fn only_text_that_changed_is_stored_a_second_time() {
        // The whole point of the nullable column: Latin messages must not pay
        // for a feature only CJK text needs.
        assert_eq!(indexed_copy("hello world"), None);
        assert_eq!(indexed_copy("café"), None);
        assert_eq!(indexed_copy(""), None);
        assert_eq!(indexed_copy("今天"), Some("今 天".to_owned()));
        assert_eq!(indexed_copy("今天 hello"), Some("今 天 hello".to_owned()));
    }

    #[test]
    fn nothing_searchable_yields_no_query() {
        assert_eq!(to_match_query(""), None);
        assert_eq!(to_match_query("   "), None);
        // Punctuation alone carries no token, and quoting it would produce an
        // empty phrase that FTS5 rejects.
        assert_eq!(to_match_query("\""), None);
    }
}

//! Local persistence: message history, full-text search, settings and
//! credential storage.
//!
//! Planned split:
//!
//! - message history in SQLite (`rusqlite`, bundled) with an FTS5 index
//! - schema migrations applied on startup, versioned rather than ad hoc
//! - network credentials in the OS keychain (`keyring`) — never in SQLite and
//!   never in a plain-text config file
//!
//! **M0 scope**: crate skeleton only. The `rusqlite` and `keyring`
//! dependencies are introduced in M3 together with the actual schema, so that
//! M0 does not pay the cost of compiling bundled SQLite.
//!
//! **Current state**: the SQLite dependency is in place and the two questions
//! that could have invalidated the M3 design have been answered by the tests
//! below — that FTS5 is really compiled in, and that a hundred thousand
//! messages are searchable well inside the acceptance budget.

/// The schema version this build expects.
///
/// Migrations are versioned from the first release rather than added later:
/// an ad hoc `CREATE TABLE IF NOT EXISTS` cannot express "change this column",
/// and the first time one is needed the database is already in users' hands.
pub const SCHEMA_VERSION: i32 = 1;

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use rusqlite::Connection;

    /// FTS5 is a compile-time option of SQLite.
    ///
    /// A system SQLite usually has it, but "usually" is not something a shipped
    /// binary can rely on — hence `bundled`. This test is what proves the
    /// feature flag chain actually reached the C build; if it did not, every
    /// search in M3 would fail at runtime with "no such module: fts5" and the
    /// cause would look like a SQL mistake.
    #[test]
    fn fts5_is_compiled_in() {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE probe USING fts5(body);
                 INSERT INTO probe(body) VALUES ('hello world');",
            )
            .expect("FTS5 must be available in the bundled build");

        let hits: i64 = connection
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .expect("query");

        assert_eq!(hits, 1);
    }

    /// Case folding and diacritics work as expected out of the box.
    #[test]
    fn the_unicode_tokenizer_folds_case_and_diacritics() {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = \"unicode61 remove_diacritics 2\");
                 INSERT INTO probe(body) VALUES ('a café in town'), ('SHOUTING ABOUT RUST');",
            )
            .expect("unicode61 tokenizer");

        let folded: i64 = connection
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH 'cafe'",
                [],
                |row| row.get(0),
            )
            .expect("folded query");
        let cased: i64 = connection
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH 'rust'",
                [],
                |row| row.get(0),
            )
            .expect("case query");

        assert_eq!(
            folded, 1,
            "remove_diacritics should make 'cafe' find 'café'"
        );
        assert_eq!(cased, 1, "search should be case-insensitive");
    }

    /// Chinese history needs an explicit workaround, and this records why.
    ///
    /// `unicode61` classifies CJK ideographs as ordinary letters, so a whole
    /// Chinese run becomes **one** token: `今天发布了新版本` is a single term and
    /// searching `发布` finds nothing. That is not a bug in SQLite — it is what
    /// "word" means without a dictionary to segment with.
    ///
    /// The fix that needs no extra dependency and no dictionary is to index a
    /// copy of the text with every CJK character separated by a space, so the
    /// ordinary tokenizer sees one token per character and a phrase query can
    /// match a two-character word. `trigram` is the other built-in candidate,
    /// but it cannot match queries shorter than three characters, and two-
    /// character Chinese words are everywhere.
    #[test]
    fn cjk_is_unsearchable_without_segmentation_and_works_with_it() {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = \"unicode61\");
                 INSERT INTO probe(body) VALUES ('今天发布了新版本');",
            )
            .expect("schema");

        let naive: i64 = connection
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH '发布'",
                [],
                |row| row.get(0),
            )
            .expect("naive query");

        // The whole run is one token, so a substring query cannot match it.
        assert_eq!(naive, 0, "unicode61 alone cannot search inside a CJK run");

        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE segmented USING fts5(body, tokenize = \"unicode61\");
                 INSERT INTO segmented(body) VALUES ('今 天 发 布 了 新 版 本');",
            )
            .expect("segmented schema");

        // A two-character word becomes a two-token phrase, which FTS5 matches
        // on adjacency.
        let segmented: i64 = connection
            .query_row(
                "SELECT count(*) FROM segmented WHERE segmented MATCH '\"发 布\"'",
                [],
                |row| row.get(0),
            )
            .expect("segmented query");

        assert_eq!(segmented, 1, "segmented indexing makes Chinese searchable");

        // And a single character still works, which `trigram` could not do.
        let single: i64 = connection
            .query_row(
                "SELECT count(*) FROM segmented WHERE segmented MATCH '发'",
                [],
                |row| row.get(0),
            )
            .expect("single character query");

        assert_eq!(single, 1);
    }

    /// The M3 acceptance target, measured rather than assumed.
    ///
    /// Ignored by default: inserting a hundred thousand rows takes seconds, and
    /// a suite that slow stops being run. Run it with
    /// `cargo test -p ircuit-storage -- --ignored --nocapture` when touching the
    /// schema or the index.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn searching_a_hundred_thousand_messages_is_fast() {
        const ROWS: usize = 100_000;

        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE TABLE message (
                     id      INTEGER PRIMARY KEY,
                     target  TEXT NOT NULL,
                     nick    TEXT NOT NULL,
                     body    TEXT NOT NULL,
                     at      INTEGER NOT NULL
                 );
                 CREATE VIRTUAL TABLE message_fts USING fts5(
                     body,
                     content = 'message',
                     content_rowid = 'id',
                     tokenize = \"unicode61 remove_diacritics 2\"
                 );",
            )
            .expect("schema");

        let insert_started = Instant::now();
        {
            let mut insert = connection
                .prepare("INSERT INTO message (target, nick, body, at) VALUES (?1, ?2, ?3, ?4)")
                .expect("prepare insert");
            let mut index = connection
                .prepare("INSERT INTO message_fts (rowid, body) VALUES (?1, ?2)")
                .expect("prepare index");

            connection.execute_batch("BEGIN").expect("begin");

            for row in 0..ROWS {
                let target = format!("#channel{}", row % 50);
                let nick = format!("user{}", row % 200);
                // One row in a thousand carries the needle, so the query has to
                // actually find something rather than scan and give up.
                let body = if row % 1000 == 0 {
                    format!("row {row} mentions the needle we are looking for")
                } else {
                    format!("row {row} is ordinary chatter about nothing in particular")
                };

                insert
                    .execute(rusqlite::params![target, nick, body, row as i64])
                    .expect("insert");
                let id = connection.last_insert_rowid();
                index.execute(rusqlite::params![id, body]).expect("index");
            }

            connection.execute_batch("COMMIT").expect("commit");
        }
        let insert_time = insert_started.elapsed();

        let mut search = connection
            .prepare("SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1")
            .expect("prepare search");

        // Warm the page cache first: the first query pays for reading the index
        // off disk, and the acceptance number is about steady-state search.
        let _: i64 = search
            .query_row(["needle"], |row| row.get(0))
            .expect("warmup");

        let mut worst = std::time::Duration::ZERO;
        let mut hits = 0;
        for _ in 0..20 {
            let started = Instant::now();
            hits = search
                .query_row(["needle"], |row| row.get(0))
                .expect("search");
            worst = worst.max(started.elapsed());
        }

        println!("inserted {ROWS} rows in {insert_time:?}");
        println!("worst of 20 searches: {worst:?} ({hits} hits)");

        assert_eq!(hits, (ROWS / 1000) as i64);
        assert!(
            worst < std::time::Duration::from_millis(100),
            "search took {worst:?}, over the 100ms budget"
        );
    }

    /// A rough size check, so "unlimited history" is a decision made with a
    /// number attached rather than a guess.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn a_hundred_thousand_messages_costs_a_sensible_amount_of_disk() {
        let path = std::env::temp_dir().join("ircuit-size-probe.sqlite");
        let _ = std::fs::remove_file(&path);

        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE message (
                     id     INTEGER PRIMARY KEY,
                     target TEXT NOT NULL,
                     nick   TEXT NOT NULL,
                     body   TEXT NOT NULL,
                     at     INTEGER NOT NULL
                 );
                 CREATE VIRTUAL TABLE message_fts USING fts5(
                     body, content = 'message', content_rowid = 'id'
                 );
                 BEGIN;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
                 INSERT INTO message (target, nick, body, at)
                     SELECT '#rust', 'user' || (n % 200),
                            'message number ' || n || ' with a typical amount of text in it',
                            1700000000 + n
                     FROM seq;
                 INSERT INTO message_fts (rowid, body) SELECT id, body FROM message;
                 COMMIT;",
            )
            .expect("seed");

        let bytes = std::fs::metadata(&path).expect("metadata").len();
        println!(
            "100k messages occupy {:.1} MiB",
            bytes as f64 / 1024.0 / 1024.0
        );

        // Deliberately loose: the point is to catch an order-of-magnitude
        // surprise, not to pin an exact figure that depends on SQLite's version.
        assert!(bytes < 64 * 1024 * 1024, "100k messages took {bytes} bytes");

        let _ = std::fs::remove_file(&path);
    }
}

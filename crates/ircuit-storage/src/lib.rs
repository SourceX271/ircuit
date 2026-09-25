//! Local persistence: message history, full-text search, settings and
//! credential storage.
//!
//! The split:
//!
//! - [`schema`] owns the tables and the versioned migrations that create them
//! - [`search`] turns user text into something FTS5 can match, including the
//!   CJK segmentation SQLite cannot do on its own
//! - message history lives in SQLite (`rusqlite`, bundled) with an FTS5 index
//! - network credentials go in the OS keychain — never in SQLite and never in a
//!   plain-text config file
//!
//! Credentials are deliberately *not* here even though this is the persistence
//! crate: a password in the same file as the chat log forces the log to be
//! protected like a secret, and the log is the thing users want to back up, copy
//! and grep.

pub mod error;
pub mod schema;
pub mod search;

pub use error::{Result, StorageError};
pub use schema::{migrate, open, open_in_memory, schema_version};

/// The schema version this build expects.
///
/// Kept as a constant so callers can compare it against a stored value without
/// going through [`schema_version`], which exists for the migration itself.
pub const SCHEMA_VERSION: i32 = 1;

#[cfg(test)]
mod probes {
    //! Measurements that back the M3 acceptance criteria.
    //!
    //! Ignored by default: inserting a hundred thousand rows takes seconds, and
    //! a suite that slow stops being run. Run them with
    //! `cargo test -p ircuit-storage -- --ignored --nocapture` when touching the
    //! schema or the index.

    use std::time::{Duration, Instant};

    use crate::schema::open_in_memory;
    use crate::search::to_match_query;

    /// A hundred thousand messages, searched the way the UI will search them.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn searching_a_hundred_thousand_messages_is_fast() {
        const ROWS: usize = 100_000;

        let connection = open_in_memory().unwrap();

        let insert_started = Instant::now();
        {
            let transaction = connection.unchecked_transaction().unwrap();
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO message (network_id, target, nick, kind, body, body_indexed, at)
                         VALUES ('net', ?1, ?2, 'message', ?3, ?4, ?5)",
                    )
                    .unwrap();

                for row in 0..ROWS {
                    let target = format!("#channel{}", row % 50);
                    let nick = format!("user{}", row % 200);
                    // One row in a thousand carries the needle, so the query has
                    // to actually find something rather than scan and give up.
                    let body = if row % 1000 == 0 {
                        format!("row {row} mentions the needle we are looking for")
                    } else {
                        format!("row {row} is ordinary chatter about nothing in particular")
                    };
                    let indexed = crate::search::indexed_copy(&body);

                    insert
                        .execute(rusqlite::params![target, nick, body, indexed, row as i64])
                        .unwrap();
                }
            }
            transaction.commit().unwrap();
        }
        let insert_time = insert_started.elapsed();

        let mut search = connection
            .prepare("SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1")
            .unwrap();
        let query = to_match_query("needle").unwrap();

        // Warm the page cache: the first query pays for reading the index, and
        // the acceptance number is about steady-state search.
        let _: i64 = search.query_row([&query], |row| row.get(0)).unwrap();

        let mut worst = Duration::ZERO;
        let mut hits = 0;
        for _ in 0..20 {
            let started = Instant::now();
            hits = search.query_row([&query], |row| row.get(0)).unwrap();
            worst = worst.max(started.elapsed());
        }

        println!("inserted {ROWS} rows in {insert_time:?}");
        println!("worst of 20 searches: {worst:?} ({hits} hits)");

        assert_eq!(hits, (ROWS / 1000) as i64);
        assert!(
            worst < Duration::from_millis(100),
            "search took {worst:?}, over the 100ms budget"
        );
    }

    /// The same query, but for Chinese.
    ///
    /// This is the probe that would have caught the tokenizer trap: without
    /// segmentation the same query returns nothing at all, which no amount of
    /// speed makes up for.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn searching_chinese_messages_works_at_volume() {
        const ROWS: usize = 50_000;

        let connection = open_in_memory().unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO message (network_id, target, nick, kind, body, body_indexed, at)
                     VALUES ('net', '#中文', '用户', 'message', ?1, ?2, ?3)",
                )
                .unwrap();

            for row in 0..ROWS {
                let body = if row % 500 == 0 {
                    format!("第 {row} 条：今天发布了新版本")
                } else {
                    format!("第 {row} 条：随便说点什么")
                };
                let indexed = crate::search::indexed_copy(&body);
                insert
                    .execute(rusqlite::params![body, indexed, row as i64])
                    .unwrap();
            }
        }
        transaction.commit().unwrap();

        let query = to_match_query("发布").unwrap();
        assert_eq!(query, "\"发 布\"");

        let mut search = connection
            .prepare("SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1")
            .unwrap();

        let _: i64 = search.query_row([&query], |row| row.get(0)).unwrap();

        let mut worst = Duration::ZERO;
        let mut hits = 0;
        for _ in 0..20 {
            let started = Instant::now();
            hits = search.query_row([&query], |row| row.get(0)).unwrap();
            worst = worst.max(started.elapsed());
        }

        println!("worst of 20 Chinese searches over {ROWS} rows: {worst:?} ({hits} hits)");

        assert_eq!(hits, (ROWS / 500) as i64);
        assert!(worst < Duration::from_millis(100));
    }

    /// A rough size check, so "unlimited history" is a decision made with a
    /// number attached rather than a guess.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn a_hundred_thousand_messages_costs_a_sensible_amount_of_disk() {
        let directory = std::env::temp_dir().join("ircuit-size-probe");
        let _ = std::fs::remove_dir_all(&directory);
        let path = directory.join("history.sqlite");

        let connection = crate::schema::open(&path).unwrap();
        connection
            .execute_batch(
                "BEGIN;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
                 INSERT INTO message (network_id, target, nick, kind, body, at)
                     SELECT 'net', '#rust', 'user' || (n % 200), 'message',
                            'message number ' || n || ' with a typical amount of text in it',
                            1700000000 + n
                     FROM seq;
                 COMMIT;",
            )
            .unwrap();

        // WAL means the file on disk is not the whole story.
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();

        let bytes = std::fs::metadata(&path).unwrap().len();
        println!(
            "100k messages occupy {:.1} MiB",
            bytes as f64 / 1024.0 / 1024.0
        );

        // Deliberately loose: the point is to catch an order-of-magnitude
        // surprise, not to pin a figure that moves with SQLite's version.
        assert!(bytes < 96 * 1024 * 1024, "100k messages took {bytes} bytes");

        drop(connection);
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// The design has to survive the query the UI actually runs: one buffer,
    /// newest first, a page at a time.
    #[test]
    #[ignore = "timing probe; run explicitly with --ignored --nocapture"]
    fn paging_a_buffer_does_not_scan_the_whole_table() {
        let connection = open_in_memory().unwrap();
        connection
            .execute_batch(
                "BEGIN;
                 WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
                 INSERT INTO message (network_id, target, nick, kind, body, body_indexed, at)
                     SELECT 'net', CASE WHEN n % 2 = 0 THEN '#rust' ELSE '#other' END,
                            'user', 'message', 'message', 'message', 1700000000 + n
                     FROM seq;
                 COMMIT;",
            )
            .unwrap();

        let plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN
                 SELECT id FROM message
                 WHERE network_id = 'net' AND target = '#rust'
                 ORDER BY at DESC, id DESC LIMIT 50",
                [],
                |row| row.get(3),
            )
            .unwrap();

        println!("paging plan: {plan}");

        // A full scan here would mean the index does not match the query's
        // order, and every scroll would get slower as history grows.
        assert!(
            plan.contains("message_buffer_time"),
            "paging should use the buffer index, got: {plan}"
        );
    }
}

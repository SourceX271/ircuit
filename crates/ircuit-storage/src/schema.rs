//! The database schema, and how it gets from one version to the next.
//!
//! Migrations are a list of numbered steps applied in order inside a
//! transaction, tracked with SQLite's own `user_version`. The alternative —
//! `CREATE TABLE IF NOT EXISTS` on every start — cannot express "add a column"
//! or "change what this value means", and both of those happen to every real
//! database. Versioning from the first release costs almost nothing and is
//! impossible to retrofit once users have files.

use rusqlite::Connection;

use crate::error::{Result, StorageError};

/// Every migration, in order. Index + 1 is the schema version it produces.
///
/// Never edit a step that has shipped: a database in the wild has already run
/// it, and changing the text means new installs and old ones disagree about what
/// version 3 means. Add a new step instead.
const MIGRATIONS: &[&str] = &[
    // ---- v1: networks, channels, messages, an FTS5 index and settings ----
    r#"
    CREATE TABLE network (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        host       TEXT NOT NULL,
        port       INTEGER NOT NULL,
        tls        INTEGER NOT NULL DEFAULT 0,
        nick       TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE channel (
        id           INTEGER PRIMARY KEY,
        network_id   TEXT NOT NULL REFERENCES network(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        topic        TEXT,
        topic_set_by TEXT,
        topic_set_at INTEGER,
        joined_at    INTEGER,
        UNIQUE (network_id, name)
    );

    CREATE TABLE message (
        id           INTEGER PRIMARY KEY,
        network_id   TEXT NOT NULL,
        -- Channel name, conversation partner, or '' for the server buffer.
        target       TEXT NOT NULL,
        nick         TEXT NOT NULL,
        -- message | notice | action | system
        kind         TEXT NOT NULL,
        -- What the user sees. Never the segmented copy.
        body         TEXT NOT NULL,
        -- The index copy: `body` with CJK characters separated by spaces, or
        -- NULL when that would be identical — which is every message in a Latin
        -- script. Storing the same text twice would nearly double an archive the
        -- user chose to keep forever. See `search::segment`.
        body_indexed TEXT,
        -- Unix seconds, from `server-time` when the server offered it.
        at           INTEGER NOT NULL,
        is_self      INTEGER NOT NULL DEFAULT 0,
        -- IRCv3 `msgid`, when the server sent one.
        msgid        TEXT,
        account      TEXT
    );

    -- The paging query is "newest first for one buffer", so the index has to
    -- match that order exactly or SQLite sorts the whole table per page.
    CREATE INDEX message_buffer_time ON message (network_id, target, at DESC, id DESC);
    CREATE INDEX message_time ON message (at DESC, id DESC);

    -- A msgid identifies one message for the whole network, so a reconnect that
    -- replays history cannot store it twice. Partial, because most messages have
    -- no msgid and SQLite treats NULLs as distinct anyway.
    CREATE UNIQUE INDEX message_msgid ON message (network_id, msgid) WHERE msgid IS NOT NULL;

    -- Contentless: the index keeps its own tokens and nothing else. An
    -- external-content table would read the indexed text back for snippets, and
    -- for Chinese that text is the space-separated copy — not what anyone wants
    -- to read in a result list. Preview text comes from `message.body` instead,
    -- so the index has no reason to store it.
    CREATE VIRTUAL TABLE message_fts USING fts5(
        body_indexed,
        content = '',
        tokenize = "unicode61 remove_diacritics 2"
    );

    -- Triggers rather than application-managed indexing: any writer keeps the
    -- index consistent, including a future export/import or a manual repair.
    -- `COALESCE(body_indexed, body)` is the single definition of "the text as
    -- indexed", used identically on the way in and on the way out — a mismatch
    -- there would leave entries that can never be removed.
    CREATE TRIGGER message_after_insert AFTER INSERT ON message BEGIN
        INSERT INTO message_fts (rowid, body_indexed)
        VALUES (new.id, COALESCE(new.body_indexed, new.body));
    END;

    CREATE TRIGGER message_after_delete AFTER DELETE ON message BEGIN
        INSERT INTO message_fts (message_fts, rowid, body_indexed)
        VALUES ('delete', old.id, COALESCE(old.body_indexed, old.body));
    END;

    CREATE TRIGGER message_after_update AFTER UPDATE ON message BEGIN
        INSERT INTO message_fts (message_fts, rowid, body_indexed)
        VALUES ('delete', old.id, COALESCE(old.body_indexed, old.body));
        INSERT INTO message_fts (rowid, body_indexed)
        VALUES (new.id, COALESCE(new.body_indexed, new.body));
    END;

    -- Per-buffer UI state that has to survive a restart: unread counts, the
    -- highlight flag, and the unsent draft.
    CREATE TABLE buffer_state (
        network_id TEXT NOT NULL,
        target     TEXT NOT NULL,
        unread     INTEGER NOT NULL DEFAULT 0,
        highlight  INTEGER NOT NULL DEFAULT 0,
        seen       INTEGER NOT NULL DEFAULT 0,
        draft      TEXT,
        PRIMARY KEY (network_id, target)
    );

    -- Cached user metadata, refreshed from WHOIS and account-notify.
    CREATE TABLE user (
        network_id TEXT NOT NULL,
        nick       TEXT NOT NULL,
        account    TEXT,
        host       TEXT,
        away       INTEGER NOT NULL DEFAULT 0,
        last_seen  INTEGER NOT NULL,
        PRIMARY KEY (network_id, nick)
    );

    CREATE TABLE setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

/// The schema version this build expects.
#[must_use]
pub fn schema_version() -> i32 {
    MIGRATIONS.len() as i32
}

/// Open the database at `path`, creating and migrating it as needed.
pub fn open(path: &std::path::Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| StorageError::Open {
            path: parent.to_path_buf(),
            // The only failure that can happen before SQLite is involved; report
            // it as an open failure so the caller has one thing to handle.
            source: rusqlite::Error::InvalidPath(error.to_string().into()),
        })?;
    }

    let mut connection = Connection::open(path).map_err(|source| StorageError::Open {
        path: path.to_path_buf(),
        source,
    })?;

    prepare(&connection)?;
    migrate(&mut connection)?;

    Ok(connection)
}

/// An in-memory database with the full schema, for tests.
pub fn open_in_memory() -> Result<Connection> {
    let mut connection = Connection::open_in_memory()?;
    prepare(&connection)?;
    migrate(&mut connection)?;
    Ok(connection)
}

/// Connection-level settings that must be applied before anything else.
///
/// `foreign_keys` is off by default in SQLite for backwards compatibility, which
/// means the `ON DELETE CASCADE` from `channel` to `network` would silently do
/// nothing.
fn prepare(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

/// Bring the database up to [`schema_version`].
///
/// Returns the version it ended at, which is the version it started at when
/// there was nothing to do.
///
/// Each step runs in its own transaction together with the `user_version`
/// bump, so a failure part-way leaves a database that is consistent with a
/// known version rather than half-migrated.
pub fn migrate(connection: &mut Connection) -> Result<i32> {
    let mut version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    let supported = schema_version();
    if version > supported {
        return Err(StorageError::SchemaTooNew {
            found: version,
            supported,
        });
    }

    while version < supported {
        let next = version + 1;
        let sql = MIGRATIONS[(next - 1) as usize];

        let transaction = connection.transaction()?;
        transaction
            .execute_batch(sql)
            .map_err(|source| StorageError::Migration {
                version: next,
                source,
            })?;
        // `PRAGMA user_version` does not accept a bound parameter.
        transaction.execute_batch(&format!("PRAGMA user_version = {next}"))?;
        transaction.commit()?;

        version = next;
    }

    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Table names present in the database, for checking a migration landed.
    fn tables(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();

        let names = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(std::result::Result::unwrap)
            .collect();

        names
    }

    #[test]
    fn a_fresh_database_lands_on_the_current_version() {
        let connection = open_in_memory().unwrap();

        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();

        assert_eq!(version, schema_version());
    }

    #[test]
    fn a_fresh_database_has_every_table() {
        let connection = open_in_memory().unwrap();
        let names = tables(&connection);

        for expected in [
            "network",
            "channel",
            "message",
            "message_fts",
            "buffer_state",
            "user",
            "setting",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing table {expected}, have {names:?}"
            );
        }
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let mut connection = open_in_memory().unwrap();
        let before = tables(&connection);

        // Startup runs this every time, so it has to be a no-op once current.
        let version = migrate(&mut connection).unwrap();

        assert_eq!(version, schema_version());
        assert_eq!(tables(&connection), before);
    }

    #[test]
    fn a_database_from_the_future_is_refused_rather_than_guessed_at() {
        let mut connection = open_in_memory().unwrap();
        connection
            .execute_batch(&format!("PRAGMA user_version = {}", schema_version() + 1))
            .unwrap();

        let error = migrate(&mut connection).unwrap_err();

        // Opening it anyway risks writing values a newer schema means
        // differently, which corrupts data rather than failing loudly.
        assert!(matches!(error, StorageError::SchemaTooNew { .. }));
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let connection = open_in_memory().unwrap();

        // `PRAGMA foreign_keys` is off by default, which would leave the
        // cascade from channel to network doing nothing at all.
        let enabled: i32 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);

        let orphan = connection.execute(
            "INSERT INTO channel (network_id, name) VALUES ('nope', '#rust')",
            [],
        );
        assert!(orphan.is_err(), "an orphan channel should be rejected");
    }

    #[test]
    fn deleting_a_network_cascades_to_its_channels() {
        let connection = open_in_memory().unwrap();
        connection
            .execute_batch(
                "INSERT INTO network (id, name, host, port, created_at)
                     VALUES ('net', 'libera', '127.0.0.1', 6697, 0);
                 INSERT INTO channel (network_id, name) VALUES ('net', '#rust');",
            )
            .unwrap();

        connection
            .execute("DELETE FROM network WHERE id = 'net'", [])
            .unwrap();

        let remaining: i64 = connection
            .query_row("SELECT count(*) FROM channel", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    /// Number of rows the index still matches for `query`.
    fn matches(connection: &Connection, query: &str) -> i64 {
        let expression = crate::search::to_match_query(query).expect("a searchable query");
        connection
            .query_row(
                "SELECT count(*) FROM message_fts WHERE message_fts MATCH ?1",
                [&expression],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Insert one message, storing the segmented copy only when it differs.
    fn insert(connection: &Connection, body: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO message (network_id, target, nick, kind, body, body_indexed, at)
                 VALUES ('net', '#rust', 'alice', 'message', ?1, ?2, 1)",
                rusqlite::params![body, crate::search::indexed_copy(body)],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn the_insert_trigger_indexes_the_row() {
        let connection = open_in_memory().unwrap();
        insert(&connection, "hello world");

        assert_eq!(matches(&connection, "hello"), 1);
    }

    /// The `body_indexed IS NULL` path is the one that can silently rot: the
    /// trigger has to fall back to `body` on the way in *and* on the way out.
    #[test]
    fn a_row_without_a_segmented_copy_is_indexed_and_unindexed_via_its_body() {
        let connection = open_in_memory().unwrap();
        let id = insert(&connection, "a plain latin message");

        assert_eq!(matches(&connection, "plain"), 1);

        connection
            .execute("DELETE FROM message WHERE id = ?1", [id])
            .unwrap();

        // A stale entry is worse than a missing one: it makes searches return
        // rows that no longer exist.
        assert_eq!(matches(&connection, "plain"), 0);
    }

    #[test]
    fn a_row_with_a_segmented_copy_is_indexed_and_unindexed_via_it() {
        let connection = open_in_memory().unwrap();
        let id = insert(&connection, "今天发布了新版本");

        assert_eq!(matches(&connection, "发布"), 1);

        connection
            .execute("DELETE FROM message WHERE id = ?1", [id])
            .unwrap();

        assert_eq!(matches(&connection, "发布"), 0);
    }

    #[test]
    fn updating_a_message_reindexes_it() {
        let connection = open_in_memory().unwrap();
        let id = insert(&connection, "the old text");

        connection
            .execute(
                "UPDATE message SET body = 'the new text', body_indexed = NULL WHERE id = ?1",
                [id],
            )
            .unwrap();

        assert_eq!(matches(&connection, "old"), 0);
        assert_eq!(matches(&connection, "new"), 1);
    }

    /// The end-to-end check that matters most: Chinese history is searchable
    /// through the real schema, with the real triggers and the real query
    /// builder. Every piece of this was wrong in the naive design.
    #[test]
    fn chinese_history_is_searchable_end_to_end() {
        let connection = open_in_memory().unwrap();

        insert(&connection, "今天发布了新版本");
        insert(&connection, "今天天气不错");
        insert(&connection, "an unrelated english line");

        // A two-character word: the case `trigram` could not handle.
        assert_eq!(matches(&connection, "发布"), 1);
        // A single character.
        assert_eq!(matches(&connection, "天"), 2);
        // Mixed scripts in one query.
        assert_eq!(matches(&connection, "发布 english"), 0);
        assert_eq!(matches(&connection, "今天 天气"), 1);
        // Latin still works exactly as before.
        assert_eq!(matches(&connection, "unrelated"), 1);
    }

    #[test]
    fn deleting_a_message_removes_it_from_search_results() {
        let connection = open_in_memory().unwrap();
        let id = insert(&connection, "ephemeral");

        assert_eq!(matches(&connection, "ephemeral"), 1);

        connection
            .execute("DELETE FROM message WHERE id = ?1", [id])
            .unwrap();

        assert_eq!(matches(&connection, "ephemeral"), 0);
    }

    #[test]
    fn a_msgid_can_only_be_stored_once_per_network() {
        let connection = open_in_memory().unwrap();
        connection
            .execute_batch(
                "INSERT INTO message (network_id, target, nick, kind, body, at, msgid)
                     VALUES ('net', '#rust', 'alice', 'message', 'once', 1, 'abc');
                 INSERT INTO message (network_id, target, nick, kind, body, at, msgid)
                     VALUES ('other', '#rust', 'alice', 'message', 'other net', 1, 'abc');",
            )
            .unwrap();

        // A reconnect that replays history must not double-store a message the
        // server already gave us.
        let duplicate = connection.execute(
            "INSERT INTO message (network_id, target, nick, kind, body, at, msgid)
             VALUES ('net', '#rust', 'bob', 'message', 'twice', 2, 'abc')",
            [],
        );
        assert!(duplicate.is_err(), "the same msgid was accepted twice");
    }

    #[test]
    fn messages_without_a_msgid_are_not_constrained() {
        let connection = open_in_memory().unwrap();

        // Most messages carry no msgid, and NULLs must not collide.
        insert(&connection, "one");
        insert(&connection, "two");

        let count: i64 = connection
            .query_row("SELECT count(*) FROM message", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn opening_a_file_creates_the_directory_and_reopens_cleanly() {
        let directory = std::env::temp_dir().join("ircuit-schema-test");
        let _ = std::fs::remove_dir_all(&directory);
        let path = directory.join("nested").join("history.sqlite");

        {
            let connection = open(&path).unwrap();
            connection
                .execute(
                    "INSERT INTO setting (key, value) VALUES ('theme', 'dark')",
                    [],
                )
                .unwrap();
        }

        // Reopening an existing file must not try to re-run migrations.
        let connection = open(&path).unwrap();
        let value: String = connection
            .query_row("SELECT value FROM setting WHERE key = 'theme'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "dark");

        drop(connection);
        let _ = std::fs::remove_dir_all(&directory);
    }
}

//! Reading and writing conversation history.
//!
//! Two queries carry almost all the weight, and both are shaped by how the UI
//! uses them:
//!
//! - **paging**: one buffer, newest first, a screenful at a time. Uses a keyset
//!   cursor rather than `OFFSET`, because `OFFSET` makes the database walk and
//!   discard every skipped row — fine at a thousand messages, visibly slow at a
//!   million, and wrong at any size once new lines arrive mid-scroll.
//! - **search**: FTS5 across every buffer at once, with the buffer and message
//!   id the UI needs to jump back to the hit.
//!
//! `body_indexed` is never a parameter. It is derived here, in one place, from
//! `search::indexed_copy` — a caller that forgot it would silently make Chinese
//! history unsearchable, and that is not a mistake worth leaving available.

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::search;

/// What kind of line this is.
///
/// Mirrors the frontend's `MessageKind`, stored as text so the file stays
/// readable and a future value does not renumber anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    /// An ordinary message.
    Message,
    /// A `NOTICE`, which by convention must not be answered automatically.
    Notice,
    /// A CTCP `ACTION`, i.e. `/me waves`.
    Action,
    /// Server-generated: joins, parts, kicks, mode changes.
    System,
}

impl MessageKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Notice => "notice",
            Self::Action => "action",
            Self::System => "system",
        }
    }

    /// Parse the stored form, defaulting to [`MessageKind::Message`].
    ///
    /// Deliberately not a `FromStr` implementation: that trait is allowed to
    /// fail, and this one must not. An unknown value means a newer build wrote
    /// it, and refusing to show a line is a worse outcome than showing it
    /// plainly.
    #[must_use]
    pub fn from_stored(value: &str) -> Self {
        match value {
            "notice" => Self::Notice,
            "action" => Self::Action,
            "system" => Self::System,
            _ => Self::Message,
        }
    }
}

/// A line as it comes back out of the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub id: i64,
    pub network_id: String,
    /// Channel name, conversation partner, or `''` for the server buffer.
    pub target: String,
    pub nick: String,
    pub kind: MessageKind,
    pub body: String,
    /// Unix seconds, from `server-time` when the server offered it.
    pub at: i64,
    pub is_self: bool,
    pub msgid: Option<String>,
    pub account: Option<String>,
}

/// A line on its way in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMessage {
    pub network_id: String,
    pub target: String,
    pub nick: String,
    pub kind: MessageKind,
    pub body: String,
    pub at: i64,
    pub is_self: bool,
    /// IRCv3 `msgid`, when the server sent one.
    pub msgid: Option<String>,
    pub account: Option<String>,
}

impl NewMessage {
    /// The common case: a plain message from someone.
    #[must_use]
    pub fn new(
        network_id: impl Into<String>,
        target: impl Into<String>,
        nick: impl Into<String>,
        body: impl Into<String>,
        at: i64,
    ) -> Self {
        Self {
            network_id: network_id.into(),
            target: target.into(),
            nick: nick.into(),
            kind: MessageKind::Message,
            body: body.into(),
            at,
            is_self: false,
            msgid: None,
            account: None,
        }
    }
}

/// What happened to an insert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    /// A new row, with its id.
    New(i64),
    /// The network already had a message with this `msgid`.
    ///
    /// Not an error: a reconnect that replays recent history hands us the same
    /// message again, and that is the whole reason `msgid` is stored.
    Duplicate,
}

/// Where a page stopped, so the next one can continue from it.
///
/// Carries the id as well as the timestamp because two messages can share a
/// second — a join burst, or a server without `server-time` — and a cursor on
/// `at` alone would then either loop or skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub at: i64,
    pub id: i64,
}

impl Cursor {
    #[must_use]
    pub fn of(message: &StoredMessage) -> Self {
        Self {
            at: message.at,
            id: message.id,
        }
    }
}

/// One search result.
///
/// Not `Eq`, because `rank` is a float; `PartialEq` is all a test needs.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub message: StoredMessage,
    /// FTS5's relevance score. More negative is a better match, which is
    /// `bm25()`'s convention, and relying on that is why results come back
    /// already ordered.
    pub rank: f64,
}

const COLUMNS: &str = "id, network_id, target, nick, kind, body, at, is_self, msgid, account";

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredMessage> {
    Ok(StoredMessage {
        id: row.get(0)?,
        network_id: row.get(1)?,
        target: row.get(2)?,
        nick: row.get(3)?,
        kind: MessageKind::from_stored(&row.get::<_, String>(4)?),
        body: row.get(5)?,
        at: row.get(6)?,
        is_self: row.get(7)?,
        msgid: row.get(8)?,
        account: row.get(9)?,
    })
}

/// Store one line.
///
/// The segmented index copy is derived here rather than accepted from the
/// caller, so no call site can forget it.
pub fn insert(connection: &Connection, message: &NewMessage) -> Result<Inserted> {
    let indexed = search::indexed_copy(&message.body);

    let changed = connection.execute(
        "INSERT INTO message
             (network_id, target, nick, kind, body, body_indexed, at, is_self, msgid, account)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (network_id, msgid) WHERE msgid IS NOT NULL DO NOTHING",
        rusqlite::params![
            message.network_id,
            message.target,
            message.nick,
            message.kind.as_str(),
            message.body,
            indexed,
            message.at,
            message.is_self,
            message.msgid,
            message.account,
        ],
    )?;

    if changed == 0 {
        return Ok(Inserted::Duplicate);
    }

    Ok(Inserted::New(connection.last_insert_rowid()))
}

/// The newest page of one buffer.
///
/// Pass the last message of the previous page as `before` to walk backwards
/// through history.
pub fn page(
    connection: &Connection,
    network_id: &str,
    target: &str,
    before: Option<Cursor>,
    limit: u32,
) -> Result<Vec<StoredMessage>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM message
         WHERE network_id = ?1 AND target = ?2
           AND (?3 IS NULL OR at < ?3 OR (at = ?3 AND id < ?4))
         ORDER BY at DESC, id DESC
         LIMIT ?5"
    ))?;

    let (at, id) = match before {
        Some(cursor) => (Some(cursor.at), cursor.id),
        None => (None, 0),
    };

    let rows = statement.query_map(
        rusqlite::params![network_id, target, at, id, i64::from(limit)],
        row_to_message,
    )?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row?);
    }

    Ok(messages)
}

/// Full-text search across every buffer, or one network.
///
/// Results come back ordered by relevance. Each hit carries the buffer and
/// message id, which is what the UI needs to jump to the line and highlight it —
/// the confirmed design keeps one timeline per conversation rather than a
/// second, parallel "search results" buffer.
pub fn search(
    connection: &Connection,
    query: &str,
    network_id: Option<&str>,
    limit: u32,
) -> Result<Vec<SearchHit>> {
    let Some(expression) = search::to_match_query(query) else {
        return Ok(Vec::new());
    };

    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS}, bm25(message_fts) AS rank
         FROM message_fts
         JOIN message ON message.id = message_fts.rowid
         WHERE message_fts MATCH ?1
           AND (?2 IS NULL OR message.network_id = ?2)
         ORDER BY rank
         LIMIT ?3"
    ))?;

    let rows = statement.query_map(
        rusqlite::params![expression, network_id, i64::from(limit)],
        |row| {
            Ok(SearchHit {
                message: row_to_message(row)?,
                rank: row.get(10)?,
            })
        },
    )?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }

    Ok(hits)
}

/// How many lines a buffer holds.
pub fn count(connection: &Connection, network_id: &str, target: &str) -> Result<i64> {
    let count = connection.query_row(
        "SELECT count(*) FROM message WHERE network_id = ?1 AND target = ?2",
        rusqlite::params![network_id, target],
        |row| row.get(0),
    )?;

    Ok(count)
}

/// The timestamp of the oldest line in a buffer, if it has any.
pub fn oldest(connection: &Connection, network_id: &str, target: &str) -> Result<Option<i64>> {
    let at = connection
        .query_row(
            "SELECT min(at) FROM message WHERE network_id = ?1 AND target = ?2",
            rusqlite::params![network_id, target],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();

    Ok(at)
}

/// Forget one buffer's history.
///
/// The triggers remove the search entries too, so a cleared buffer cannot keep
/// turning up in results.
pub fn delete_buffer(connection: &Connection, network_id: &str, target: &str) -> Result<usize> {
    let removed = connection.execute(
        "DELETE FROM message WHERE network_id = ?1 AND target = ?2",
        rusqlite::params![network_id, target],
    )?;

    Ok(removed)
}

/// Forget everything belonging to one network.
///
/// The confirmed retention policy is "unlimited by default, with manual
/// clearing per network" — this is the second half of that.
pub fn delete_network(connection: &Connection, network_id: &str) -> Result<usize> {
    let removed = connection.execute(
        "DELETE FROM message WHERE network_id = ?1",
        rusqlite::params![network_id],
    )?;

    Ok(removed)
}

/// Every buffer a network has history for, with how much.
///
/// Used to rebuild the sidebar after a restart without loading any messages.
pub fn buffers(connection: &Connection, network_id: &str) -> Result<Vec<(String, i64)>> {
    let mut statement = connection.prepare(
        "SELECT target, count(*) FROM message WHERE network_id = ?1 GROUP BY target ORDER BY target",
    )?;

    let rows = statement.query_map(rusqlite::params![network_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut buffers = Vec::new();
    for row in rows {
        buffers.push(row?);
    }

    Ok(buffers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::open_in_memory;

    fn store(connection: &Connection, target: &str, body: &str, at: i64) -> i64 {
        match insert(
            connection,
            &NewMessage::new("net", target, "alice", body, at),
        ) {
            Ok(Inserted::New(id)) => id,
            other => panic!("expected a new row, got {other:?}"),
        }
    }

    #[test]
    fn a_stored_message_comes_back_whole() {
        let connection = open_in_memory().unwrap();
        let mut message = NewMessage::new("net", "#rust", "alice", "hello", 1_700_000_000);
        message.kind = MessageKind::Action;
        message.msgid = Some("abc".to_owned());
        message.account = Some("alice".to_owned());

        insert(&connection, &message).unwrap();

        let page = page(&connection, "net", "#rust", None, 10).unwrap();
        assert_eq!(page.len(), 1);

        let stored = &page[0];
        assert_eq!(stored.nick, "alice");
        assert_eq!(stored.body, "hello");
        assert_eq!(stored.kind, MessageKind::Action);
        assert_eq!(stored.msgid.as_deref(), Some("abc"));
        assert_eq!(stored.account.as_deref(), Some("alice"));
        assert!(!stored.is_self);
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [
            MessageKind::Message,
            MessageKind::Notice,
            MessageKind::Action,
            MessageKind::System,
        ] {
            assert_eq!(MessageKind::from_stored(kind.as_str()), kind);
        }
    }

    #[test]
    fn an_unknown_kind_reads_as_a_plain_message() {
        // A value a newer build wrote must not stop us showing the line.
        assert_eq!(
            MessageKind::from_stored("something-new"),
            MessageKind::Message
        );
    }

    #[test]
    fn a_replayed_msgid_is_not_stored_twice() {
        let connection = open_in_memory().unwrap();
        let mut message = NewMessage::new("net", "#rust", "alice", "once", 1);
        message.msgid = Some("abc".to_owned());

        assert!(matches!(
            insert(&connection, &message).unwrap(),
            Inserted::New(_)
        ));

        // The same line arriving again after a reconnect.
        assert_eq!(insert(&connection, &message).unwrap(), Inserted::Duplicate);

        assert_eq!(count(&connection, "net", "#rust").unwrap(), 1);
    }

    #[test]
    fn the_same_msgid_on_another_network_is_a_different_message() {
        let connection = open_in_memory().unwrap();
        let mut first = NewMessage::new("net", "#rust", "alice", "one", 1);
        first.msgid = Some("abc".to_owned());

        let mut second = NewMessage::new("other", "#rust", "alice", "two", 1);
        second.msgid = Some("abc".to_owned());

        insert(&connection, &first).unwrap();
        assert!(matches!(
            insert(&connection, &second).unwrap(),
            Inserted::New(_)
        ));
    }

    #[test]
    fn messages_without_a_msgid_are_never_deduplicated() {
        // Saying the same thing twice is normal and must not be swallowed.
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "hello", 1);
        store(&connection, "#rust", "hello", 1);

        assert_eq!(count(&connection, "net", "#rust").unwrap(), 2);
    }

    #[test]
    fn a_page_is_newest_first() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "oldest", 1);
        store(&connection, "#rust", "middle", 2);
        store(&connection, "#rust", "newest", 3);

        let bodies: Vec<String> = page(&connection, "net", "#rust", None, 10)
            .unwrap()
            .into_iter()
            .map(|message| message.body)
            .collect();

        assert_eq!(bodies, vec!["newest", "middle", "oldest"]);
    }

    #[test]
    fn walking_backwards_covers_everything_exactly_once() {
        let connection = open_in_memory().unwrap();
        for index in 0..25 {
            store(&connection, "#rust", &format!("line {index}"), index);
        }

        let mut seen = Vec::new();
        let mut cursor = None;

        loop {
            let batch = page(&connection, "net", "#rust", cursor, 10).unwrap();
            if batch.is_empty() {
                break;
            }
            cursor = Some(Cursor::of(batch.last().unwrap()));
            seen.extend(batch.into_iter().map(|message| message.body));
        }

        // No overlap between pages, no gap, and newest first throughout.
        assert_eq!(seen.len(), 25);
        let unique: std::collections::HashSet<_> = seen.iter().collect();
        assert_eq!(unique.len(), 25, "a page repeated or skipped a line");
        assert_eq!(seen.first().unwrap(), "line 24");
        assert_eq!(seen.last().unwrap(), "line 0");
    }

    #[test]
    fn paging_is_stable_when_many_messages_share_a_timestamp() {
        // A join burst, or a server without `server-time`, gives equal `at`.
        // A cursor on the timestamp alone would loop or skip here.
        let connection = open_in_memory().unwrap();
        for index in 0..12 {
            store(&connection, "#rust", &format!("same second {index}"), 100);
        }

        let first = page(&connection, "net", "#rust", None, 5).unwrap();
        let second = page(
            &connection,
            "net",
            "#rust",
            Some(Cursor::of(first.last().unwrap())),
            5,
        )
        .unwrap();
        let third = page(
            &connection,
            "net",
            "#rust",
            Some(Cursor::of(second.last().unwrap())),
            5,
        )
        .unwrap();

        let mut ids: Vec<i64> = first
            .iter()
            .chain(&second)
            .chain(&third)
            .map(|message| message.id)
            .collect();
        assert_eq!(ids.len(), 12);

        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "a message appeared on two pages");
    }

    #[test]
    fn pages_are_scoped_to_one_buffer() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "in rust", 1);
        store(&connection, "#other", "elsewhere", 2);

        let page = page(&connection, "net", "#rust", None, 10).unwrap();

        assert_eq!(page.len(), 1);
        assert_eq!(page[0].body, "in rust");
    }

    #[test]
    fn pages_are_scoped_to_the_network_as_well() {
        let connection = open_in_memory().unwrap();
        insert(
            &connection,
            &NewMessage::new("net", "#rust", "alice", "ours", 1),
        )
        .unwrap();
        insert(
            &connection,
            &NewMessage::new("other", "#rust", "alice", "theirs", 2),
        )
        .unwrap();

        let page = page(&connection, "net", "#rust", None, 10).unwrap();

        // Two networks can both have a #rust, and mixing them would be a bug
        // that only shows up once someone is on two servers.
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].body, "ours");
    }

    #[test]
    fn search_finds_a_message_and_points_back_at_its_buffer() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "the needle is here", 5);
        store(&connection, "#rust", "unrelated", 6);
        store(&connection, "#other", "also unrelated", 7);

        let hits = search(&connection, "needle", None, 10).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.target, "#rust");
        assert_eq!(hits[0].message.at, 5);
    }

    #[test]
    fn search_works_for_chinese_history() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#中文", "今天发布了新版本", 1);
        store(&connection, "#中文", "今天天气不错", 2);

        let hits = search(&connection, "发布", None, 10).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.body, "今天发布了新版本");
    }

    #[test]
    fn search_can_be_narrowed_to_one_network() {
        let connection = open_in_memory().unwrap();
        insert(
            &connection,
            &NewMessage::new("net", "#a", "alice", "shared word", 1),
        )
        .unwrap();
        insert(
            &connection,
            &NewMessage::new("other", "#b", "alice", "shared word", 2),
        )
        .unwrap();

        assert_eq!(search(&connection, "shared", None, 10).unwrap().len(), 2);
        assert_eq!(
            search(&connection, "shared", Some("net"), 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn search_ranks_the_better_match_first() {
        let connection = open_in_memory().unwrap();
        store(
            &connection,
            "#rust",
            "a long line that happens to contain the word needle once among many others",
            1,
        );
        store(&connection, "#rust", "needle", 2);

        let hits = search(&connection, "needle", None, 10).unwrap();

        assert_eq!(hits.len(), 2);
        // bm25 rewards the shorter document, which is the one the user meant.
        assert_eq!(hits[0].message.body, "needle");
        assert!(
            hits[0].rank <= hits[1].rank,
            "results are not in rank order"
        );
    }

    #[test]
    fn a_query_with_nothing_searchable_returns_nothing_rather_than_failing() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "anything", 1);

        // FTS5 would treat a bare quote as a syntax error.
        for query in ["", "   ", "\"", "!!!"] {
            assert!(search(&connection, query, None, 10).unwrap().is_empty());
        }
    }

    #[test]
    fn search_respects_the_limit() {
        let connection = open_in_memory().unwrap();
        for index in 0..10 {
            store(&connection, "#rust", &format!("needle {index}"), index);
        }

        assert_eq!(search(&connection, "needle", None, 3).unwrap().len(), 3);
    }

    #[test]
    fn deleting_a_buffer_takes_its_search_entries_with_it() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "needle in rust", 1);
        store(&connection, "#other", "needle elsewhere", 2);

        let removed = delete_buffer(&connection, "net", "#rust").unwrap();

        assert_eq!(removed, 1);
        let hits = search(&connection, "needle", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.target, "#other");
    }

    #[test]
    fn deleting_a_network_takes_everything_with_it() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "needle one", 1);
        store(&connection, "#other", "needle two", 2);
        insert(
            &connection,
            &NewMessage::new("other", "#rust", "alice", "needle three", 3),
        )
        .unwrap();

        let removed = delete_network(&connection, "net").unwrap();

        assert_eq!(removed, 2);
        assert_eq!(count(&connection, "net", "#rust").unwrap(), 0);
        assert!(search(&connection, "needle", Some("net"), 10)
            .unwrap()
            .is_empty());
        // The other network is untouched.
        assert_eq!(
            search(&connection, "needle", Some("other"), 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn buffers_lists_what_a_network_has_history_for() {
        let connection = open_in_memory().unwrap();
        store(&connection, "#rust", "one", 1);
        store(&connection, "#rust", "two", 2);
        store(&connection, "bob", "three", 3);
        insert(
            &connection,
            &NewMessage::new("other", "#rust", "alice", "four", 4),
        )
        .unwrap();

        let buffers = buffers(&connection, "net").unwrap();

        assert_eq!(
            buffers,
            vec![("#rust".to_owned(), 2), ("bob".to_owned(), 1)]
        );
    }

    #[test]
    fn the_oldest_timestamp_is_reported() {
        let connection = open_in_memory().unwrap();
        assert_eq!(oldest(&connection, "net", "#rust").unwrap(), None);

        store(&connection, "#rust", "later", 200);
        store(&connection, "#rust", "earlier", 100);

        assert_eq!(oldest(&connection, "net", "#rust").unwrap(), Some(100));
    }

    #[test]
    fn the_server_buffer_is_an_ordinary_buffer() {
        // `''` is the server buffer's target, and it must not need special
        // handling anywhere in the storage layer.
        let connection = open_in_memory().unwrap();
        store(&connection, "", "server chatter", 1);

        let page = page(&connection, "net", "", None, 10).unwrap();

        assert_eq!(page.len(), 1);
        assert_eq!(page[0].body, "server chatter");
    }
}

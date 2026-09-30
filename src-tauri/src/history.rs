//! The bridge between the async runtime and the synchronous history database.
//!
//! Two facts shape everything here:
//!
//! 1. **SQLite is synchronous.** Every call blocks the thread it runs on, and
//!    `rusqlite` has no async surface. Calling it directly from a Tokio task
//!    would stall a runtime worker — and a search over a large archive is tens of
//!    microseconds, not nanoseconds, so this is not theoretical. Everything is
//!    therefore pushed onto the blocking pool.
//! 2. **History is not worth losing a connection over.** A full disk, a
//!    read-only home directory or a database from a newer build must degrade the
//!    archive, never the conversation. Writes report their failure and the caller
//!    carries on; the first failure is logged loudly and the rest are counted, so
//!    a broken disk produces one useful message instead of one per message.
//!
//! The `Mutex` is a `std::sync::Mutex`, held only inside the blocking closure. It
//! is never held across an `.await`, which is what makes that safe.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use ircuit_storage::messages::{self, Inserted, NewMessage, StoredMessage};
use ircuit_storage::rusqlite;
use ircuit_storage::{schema, Cursor};

use crate::events::{HistoryCursor, HistoryMessage, HistoryPage, IncomingMessage, MessageKind};

/// Turn a line that was just shown into a row to store.
///
/// Keyed by `buffer`, not `target`: history is read back per conversation, and a
/// private message belongs to the sender's conversation even though the protocol
/// addressed it to us.
///
/// `msgid` and `account` stay empty for now — the IRCv3 tags that carry them are
/// not plumbed through yet (M7). The schema already has the columns and the
/// uniqueness rule, so backfilling them later needs no migration.
#[must_use]
pub fn new_message(message: &IncomingMessage) -> NewMessage {
    NewMessage {
        network_id: message.network_id.clone(),
        target: message.buffer.clone(),
        nick: message.nick.clone(),
        kind: message.kind.into_storage(),
        body: message.text.clone(),
        at: i64::from(message.timestamp),
        is_self: message.is_self,
        msgid: None,
        account: None,
    }
}

impl MessageKind {
    /// The storage crate's kind, mapped onto the wire value the UI already knows.
    #[must_use]
    pub fn from_storage(kind: messages::MessageKind) -> Self {
        match kind {
            messages::MessageKind::Message => Self::Message,
            messages::MessageKind::Notice => Self::Notice,
            messages::MessageKind::Action => Self::Action,
            messages::MessageKind::System => Self::System,
        }
    }

    /// The storage crate's kind, for writing.
    #[must_use]
    pub fn into_storage(self) -> messages::MessageKind {
        match self {
            Self::Message => messages::MessageKind::Message,
            Self::Notice => messages::MessageKind::Notice,
            Self::Action => messages::MessageKind::Action,
            Self::System => messages::MessageKind::System,
        }
    }
}

/// Where history lives, and what to do when it cannot be written.
pub struct HistoryStore {
    connection: Arc<Mutex<rusqlite::Connection>>,
    path: Option<PathBuf>,
    /// Failures since the last success. Kept so a broken disk can be reported
    /// once rather than on every line.
    failures: AtomicU64,
}

impl HistoryStore {
    /// Open (and create, and migrate) the database at `path`.
    pub fn open(path: &Path) -> Result<Self, ircuit_storage::StorageError> {
        let connection = schema::open(path)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path: Some(path.to_path_buf()),
            failures: AtomicU64::new(0),
        })
    }

    /// An in-memory database, for tests.
    pub fn in_memory() -> Result<Self, ircuit_storage::StorageError> {
        let connection = schema::open_in_memory()?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path: None,
            failures: AtomicU64::new(0),
        })
    }

    /// The file backing this store, if it is a file at all.
    #[must_use]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Run one blocking database call.
    ///
    /// A poisoned mutex is recovered rather than propagated: the guard is only
    /// ever held across SQLite calls that do not panic in practice, and refusing
    /// to save chat history because an unrelated thread panicked once is the
    /// wrong trade.
    async fn with<T, F>(&self, work: F) -> Result<T, String>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T, ircuit_storage::StorageError>
            + Send
            + 'static,
        T: Send + 'static,
    {
        // The clone, not a borrow: the closure runs on another thread and so has
        // to own everything it touches.
        let connection = Arc::clone(&self.connection);

        tokio::task::spawn_blocking(move || {
            let guard = connection.lock().unwrap_or_else(PoisonError::into_inner);
            work(&guard).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("history worker failed: {error}"))?
    }

    /// Store one line.
    ///
    /// Returns whether it was new; a duplicate `msgid` is not an error, it is the
    /// same message arriving twice.
    pub async fn record(&self, message: NewMessage) -> Result<Inserted, String> {
        let result = self
            .with(move |connection| messages::insert(connection, &message))
            .await;

        match &result {
            Ok(_) => {
                self.failures.store(0, Ordering::Relaxed);
            }
            Err(error) => {
                let previous = self.failures.fetch_add(1, Ordering::Relaxed);
                if previous == 0 {
                    tracing::warn!(%error, "无法写入历史记录；对话继续，但这一段不会留存");
                }
            }
        }

        result
    }

    /// One page of a buffer's history, oldest first.
    pub async fn page(
        &self,
        network_id: String,
        buffer: String,
        before: Option<HistoryCursor>,
        limit: u32,
    ) -> Result<HistoryPage, String> {
        let before = before.map(|cursor| cursor.into_storage());

        self.with(move |connection| {
            // One extra row answers "is there more?" without a second query.
            let mut rows = messages::page(connection, &network_id, &buffer, before, limit + 1)?;

            let exhausted = rows.len() <= limit as usize;
            rows.truncate(limit as usize);

            // Storage hands back newest first because that is the order the index
            // serves; the UI prepends a page, so it wants the order it draws.
            rows.reverse();

            Ok(HistoryPage {
                messages: rows.into_iter().map(HistoryMessage::from_stored).collect(),
                exhausted,
            })
        })
        .await
    }

    /// How many lines one buffer holds.
    pub async fn count(&self, network_id: String, buffer: String) -> Result<u32, String> {
        self.with(move |connection| {
            let count = messages::count(connection, &network_id, &buffer)?;
            // Saturating rather than wrapping: a counter that big is a display
            // problem, not a reason to report a negative number.
            Ok(u32::try_from(count).unwrap_or(u32::MAX))
        })
        .await
    }

    /// Forget one buffer.
    pub async fn delete_buffer(&self, network_id: String, buffer: String) -> Result<u32, String> {
        self.with(move |connection| {
            let removed = messages::delete_buffer(connection, &network_id, &buffer)?;
            Ok(u32::try_from(removed).unwrap_or(u32::MAX))
        })
        .await
    }

    /// Forget every buffer on one network.
    pub async fn delete_network(&self, network_id: String) -> Result<u32, String> {
        self.with(move |connection| {
            let removed = messages::delete_network(connection, &network_id)?;
            Ok(u32::try_from(removed).unwrap_or(u32::MAX))
        })
        .await
    }
}

impl HistoryMessage {
    /// Project a stored row onto the IPC shape.
    #[must_use]
    pub fn from_stored(message: StoredMessage) -> Self {
        Self {
            // A rowid does not fit the IPC integer rule (see docs §7), so it
            // travels as text. It is an opaque handle to the UI, never arithmetic.
            id: message.id.to_string(),
            network_id: message.network_id,
            buffer: message.target,
            nick: message.nick,
            kind: MessageKind::from_storage(message.kind),
            body: message.body,
            at: u32::try_from(message.at).unwrap_or_default(),
            is_self: message.is_self,
        }
    }
}

impl HistoryCursor {
    /// The cursor that continues just before `message`.
    ///
    /// Used to walk further back from the oldest line on screen.
    #[must_use]
    pub fn before(message: &HistoryMessage) -> Self {
        Self {
            at: message.at,
            id: message.id.clone(),
        }
    }

    /// Back to the form the paging query takes.
    ///
    /// An id that does not parse cannot come from this application — it would
    /// have to be a hand-edited file or a bug — so it degrades to the cursor's
    /// `at` alone rather than failing the whole page.
    #[must_use]
    pub fn into_storage(self) -> Cursor {
        Cursor {
            at: i64::from(self.at),
            id: self.id.parse().unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> HistoryStore {
        HistoryStore::in_memory().expect("in-memory history")
    }

    fn message(network: &str, buffer: &str, body: &str, at: i64) -> NewMessage {
        let mut message = NewMessage::new(network, buffer, "alice", body, at);
        message.kind = messages::MessageKind::Message;
        message
    }

    #[tokio::test]
    async fn a_stored_line_comes_back_out() {
        let store = store();
        store
            .record(message("net", "#rust", "hello there", 1_700_000_000))
            .await
            .unwrap();

        let page = store
            .page("net".to_owned(), "#rust".to_owned(), None, 50)
            .await
            .unwrap();

        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].body, "hello there");
        assert_eq!(page.messages[0].buffer, "#rust");
        assert_eq!(page.messages[0].at, 1_700_000_000);
        assert!(page.exhausted);
    }

    #[tokio::test]
    async fn pages_come_back_in_the_order_the_ui_draws_them() {
        let store = store();
        for index in 0..5 {
            store
                .record(message(
                    "net",
                    "#rust",
                    &format!("line {index}"),
                    100 + index,
                ))
                .await
                .unwrap();
        }

        let page = store
            .page("net".to_owned(), "#rust".to_owned(), None, 2)
            .await
            .unwrap();

        // Newest page, oldest first: the UI prepends it above what it already has.
        assert_eq!(
            page.messages
                .iter()
                .map(|message| message.body.as_str())
                .collect::<Vec<_>>(),
            ["line 3", "line 4"]
        );
        assert!(!page.exhausted, "line 2 is still older than the page");
    }

    #[tokio::test]
    async fn walking_backwards_with_a_cursor_reaches_the_start() {
        let store = store();
        for index in 0..5 {
            store
                .record(message(
                    "net",
                    "#rust",
                    &format!("line {index}"),
                    100 + index,
                ))
                .await
                .unwrap();
        }

        let newest = store
            .page("net".to_owned(), "#rust".to_owned(), None, 2)
            .await
            .unwrap();
        let oldest = HistoryCursor::before(&newest.messages[0]);

        let older = store
            .page("net".to_owned(), "#rust".to_owned(), Some(oldest), 2)
            .await
            .unwrap();

        assert_eq!(
            older
                .messages
                .iter()
                .map(|message| message.body.as_str())
                .collect::<Vec<_>>(),
            ["line 1", "line 2"]
        );

        let oldest = HistoryCursor::before(&older.messages[0]);
        let rest = store
            .page("net".to_owned(), "#rust".to_owned(), Some(oldest), 2)
            .await
            .unwrap();

        assert_eq!(rest.messages.len(), 1);
        assert_eq!(rest.messages[0].body, "line 0");
        assert!(rest.exhausted, "nothing is older than the first line");
    }

    #[tokio::test]
    async fn buffers_do_not_see_each_others_lines() {
        let store = store();
        store
            .record(message("net", "#rust", "in rust", 1))
            .await
            .unwrap();
        store
            .record(message("net", "#ops", "in ops", 2))
            .await
            .unwrap();

        let page = store
            .page("net".to_owned(), "#rust".to_owned(), None, 50)
            .await
            .unwrap();

        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].body, "in rust");
    }

    #[tokio::test]
    async fn a_brand_new_buffer_is_empty_rather_than_an_error() {
        let store = store();
        let page = store
            .page("net".to_owned(), "#never".to_owned(), None, 50)
            .await
            .unwrap();

        assert!(page.messages.is_empty());
        assert!(page.exhausted);
    }

    #[tokio::test]
    async fn chinese_history_is_retrievable() {
        // Not a search test — that is M3-4 — but the write path has to survive
        // non-ASCII text end to end.
        let store = store();
        store
            .record(message("net", "#中文", "今天发布了新版本", 1))
            .await
            .unwrap();

        let page = store
            .page("net".to_owned(), "#中文".to_owned(), None, 50)
            .await
            .unwrap();

        assert_eq!(page.messages[0].body, "今天发布了新版本");
        assert_eq!(page.messages[0].buffer, "#中文");
    }

    #[tokio::test]
    async fn counting_and_clearing_a_buffer() {
        let store = store();
        for index in 0..3 {
            store
                .record(message("net", "#rust", "line", 100 + index))
                .await
                .unwrap();
        }

        assert_eq!(
            store
                .count("net".to_owned(), "#rust".to_owned())
                .await
                .unwrap(),
            3
        );

        assert_eq!(
            store
                .delete_buffer("net".to_owned(), "#rust".to_owned())
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            store
                .count("net".to_owned(), "#rust".to_owned())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn clearing_one_network_leaves_the_others_alone() {
        let store = store();
        store.record(message("a", "#rust", "one", 1)).await.unwrap();
        store.record(message("b", "#rust", "two", 2)).await.unwrap();

        assert_eq!(store.delete_network("a".to_owned()).await.unwrap(), 1);
        assert_eq!(
            store
                .count("b".to_owned(), "#rust".to_owned())
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn history_survives_closing_and_reopening_the_file() {
        // This is the M3 acceptance in one test: what was said in one run is
        // still there in the next. An in-memory store would pass every other test
        // in this module and fail this one.
        let directory = std::env::temp_dir().join("ircuit-history-reopen");
        let _ = std::fs::remove_dir_all(&directory);
        let path = directory.join("history.sqlite");

        {
            let store = HistoryStore::open(&path).expect("open");
            store
                .record(message("net", "#rust", "before the restart", 1_700_000_000))
                .await
                .unwrap();

            // Dropped the way the application drops it: the process ends, and the
            // only thing that carries over is the file. A missing checkpoint or a
            // WAL that never gets flushed would show up here.
        }

        let reopened = HistoryStore::open(&path).expect("reopen");
        let page = reopened
            .page("net".to_owned(), "#rust".to_owned(), None, 50)
            .await
            .unwrap();

        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].body, "before the restart");
        assert_eq!(page.messages[0].at, 1_700_000_000);

        // And the archive keeps growing across runs rather than starting over.
        reopened
            .record(message("net", "#rust", "after the restart", 1_700_000_100))
            .await
            .unwrap();
        assert_eq!(
            reopened
                .count("net".to_owned(), "#rust".to_owned())
                .await
                .unwrap(),
            2
        );

        drop(reopened);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn a_read_only_database_reports_failures_without_breaking_reads() {
        // "The disk went away", in a form a test can produce: an archive that can
        // be read but not written. The conversation has to survive it.
        let store = store();
        store
            .record(message("net", "#rust", "kept", 1))
            .await
            .unwrap();

        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = ON")
            .unwrap();

        assert!(
            store
                .record(message("net", "#rust", "lost", 2))
                .await
                .is_err(),
            "a write to a read-only database must be reported, not swallowed"
        );

        let page = store
            .page("net".to_owned(), "#rust".to_owned(), None, 50)
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].body, "kept", "reading must keep working");

        // Recovering resets the failure count, so a later problem is reported
        // rather than suppressed as a repeat of the first.
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = OFF")
            .unwrap();
        assert!(store
            .record(message("net", "#rust", "saved again", 3))
            .await
            .is_ok());
        assert_eq!(store.failures.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_cursor_round_trips_through_the_wire_shape() {
        let message = HistoryMessage {
            id: "42".to_owned(),
            network_id: "net".to_owned(),
            buffer: "#rust".to_owned(),
            nick: "alice".to_owned(),
            kind: MessageKind::Message,
            body: "hi".to_owned(),
            at: 1_700_000_000,
            is_self: false,
        };

        let cursor = HistoryCursor::before(&message);
        assert_eq!(cursor.id, "42");
        assert_eq!(cursor.at, 1_700_000_000);

        let back = cursor.into_storage();
        assert_eq!(back.at, 1_700_000_000);
        assert_eq!(back.id, 42);
    }

    #[test]
    fn a_stored_row_projects_onto_the_wire_shape() {
        let stored = StoredMessage {
            id: 42,
            network_id: "net".to_owned(),
            target: "#rust".to_owned(),
            nick: "alice".to_owned(),
            kind: messages::MessageKind::Action,
            body: "waves".to_owned(),
            at: 1_700_000_000,
            is_self: true,
            msgid: None,
            account: None,
        };

        let wire = HistoryMessage::from_stored(stored);
        assert_eq!(wire.id, "42");
        assert_eq!(wire.buffer, "#rust");
        assert_eq!(wire.kind, MessageKind::Action);
        assert_eq!(wire.at, 1_700_000_000);
        assert!(wire.is_self);
    }

    #[test]
    fn a_cursor_with_a_corrupt_id_still_pages_by_time() {
        let cursor = HistoryCursor {
            at: 5,
            id: "not a number".to_owned(),
        };

        let storage = cursor.into_storage();
        assert_eq!(storage.at, 5);
        assert_eq!(storage.id, 0);
    }

    #[test]
    fn stored_kinds_map_onto_the_wire_kinds() {
        assert_eq!(
            MessageKind::from_storage(messages::MessageKind::Message),
            MessageKind::Message
        );
        assert_eq!(
            MessageKind::from_storage(messages::MessageKind::Notice),
            MessageKind::Notice
        );
        assert_eq!(
            MessageKind::from_storage(messages::MessageKind::Action),
            MessageKind::Action
        );
        assert_eq!(
            MessageKind::from_storage(messages::MessageKind::System),
            MessageKind::System
        );
    }
}

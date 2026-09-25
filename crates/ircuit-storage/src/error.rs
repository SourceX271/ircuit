//! What can go wrong when talking to local storage.

use std::path::PathBuf;

/// A storage failure.
///
/// The database is the one place where a failure is usually *not* the user's
/// fault and is almost always unrecoverable in place — a corrupt file, a full
/// disk, a schema from a newer build. Keeping the variants distinct is what
/// lets the caller decide between "tell the user and carry on in memory" and
/// "refuse to start", which are very different outcomes.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("cannot open the database at {path}: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },

    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// The file was written by a newer build than this one.
    ///
    /// Downgrading is the dangerous case: the newer schema may have dropped a
    /// column this build still writes to, or changed what a value means.
    #[error(
        "the database is at schema version {found}, but this build only understands {supported}"
    )]
    SchemaTooNew { found: i32, supported: i32 },

    /// A migration failed, leaving the database at the last good version.
    #[error("migration to version {version} failed: {source}")]
    Migration {
        version: i32,
        #[source]
        source: rusqlite::Error,
    },
}

/// Result alias for storage operations.
pub type Result<T> = std::result::Result<T, StorageError>;

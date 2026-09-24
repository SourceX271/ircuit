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

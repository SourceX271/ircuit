//! IRC connection layer: TCP/TLS transport, capability negotiation, SASL
//! authentication, keepalive and automatic reconnection.
//!
//! The crate owns sockets and connection state, and nothing else. It has no
//! dependency on Tauri, so it can be driven from tests, a CLI, or a future CLI
//! tool — see `ircuit-testserver` for how the integration tests use it.
//!
//! # Shape
//!
//! [`session::spawn`] starts one connection and hands back a
//! [`session::NetworkHandle`] for sending plus a stream of
//! [`session::NetworkEvent`]. Commands go in, events come out, and the socket
//! never escapes.
//!
//! ```no_run
//! use ircuit_client::{BackoffPolicy, ClientCommand, ConnectionConfig, spawn};
//!
//! # async fn example() {
//! let config = ConnectionConfig::new("irc.libera.chat", "ircuit-test");
//! let (handle, mut events) = spawn(config, BackoffPolicy::default());
//!
//! while let Some(event) = events.recv().await {
//!     println!("{event:?}");
//! }
//! # let _ = handle.send(ClientCommand::Shutdown).await;
//! # }
//! ```
//!
//! # What is not here yet
//!
//! SCRAM-SHA-256 and client certificates (M4), DCC (M5) and the IRCv3 features
//! that need batch handling (M7).

pub mod cap;
pub mod config;
pub mod error;
pub mod reconnect;
pub mod sasl;
pub mod session;
pub mod transport;

pub use cap::{CapNegotiator, SaslOutcome, DEFAULT_CAPABILITIES};
pub use config::{ConnectionConfig, SaslConfig, TlsMode};
pub use error::Error;
pub use reconnect::BackoffPolicy;
pub use session::{spawn, ClientCommand, NetworkEvent, NetworkHandle};
pub use transport::{LineReader, Transport};

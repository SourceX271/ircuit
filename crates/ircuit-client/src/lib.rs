//! IRC connection layer: TCP/TLS transport, capability negotiation, SASL
//! authentication, keepalive, and automatic reconnection.
//!
//! Planned module layout (filled in from M1 onward):
//!
//! - `transport` — plain TCP and TLS (`rustls`) byte streams behind one trait
//! - `cap` — IRCv3 capability negotiation state machine
//! - `sasl` — PLAIN / EXTERNAL / SCRAM-SHA-256 mechanisms
//! - `session` — per-network connection driver and event emission
//! - `reconnect` — exponential backoff with connection-storm protection
//!
//! **M0 scope**: crate skeleton only.

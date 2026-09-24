//! Authoritative in-memory model of what the client believes about the network:
//! networks, channels, membership, user prefixes, modes, topics and per-buffer
//! read state.
//!
//! The UI never derives protocol state on its own — it renders what this crate
//! reports and sends intents back through the command layer.
//!
//! **M0 scope**: crate skeleton only. Models land alongside the connection
//! implementation in M1 and are persisted from M3.

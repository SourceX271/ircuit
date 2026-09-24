//! The client's model of what it knows about the network.
//!
//! The UI never derives protocol state on its own — it renders what this crate
//! reports and sends intents back through the command layer.
//!
//! **M1 scope**: [`view`], which turns protocol messages into displayable lines.
//! Membership, modes and topics are modelled in M2 and persisted from M3.

pub mod view;

pub use view::{normalize, parse_server_time, MessageKind, ViewMessage};

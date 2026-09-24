//! The client's model of what it knows about the network.
//!
//! The UI never derives protocol state on its own — it renders what this crate
//! reports and sends intents back through the command layer.
//!
//! - [`channel`] tracks membership, prefixes, modes and topics per channel.
//! - [`view`] turns protocol messages into lines a message list can render.
//!
//! Persistence arrives in M3; everything here is in-memory.

pub mod channel;
pub mod view;

pub use channel::{
    CaseMapping, Channel, Isupport, Member, NetworkState as ChannelState, StateChange,
};
pub use view::{normalize, parse_server_time, MessageKind, ViewMessage};

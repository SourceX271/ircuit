//! The Rust → frontend IPC contract.
//!
//! Everything here is generated into TypeScript, so these types *are* the
//! interface. Keep them free of Rust-only details and keep field names stable —
//! renaming one is a breaking change for the UI.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Core runtime status snapshot.
///
/// Started life as an M0 heartbeat proving the event channel worked; it remains
/// the cheapest way to tell "backend alive" from "backend wedged".
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct CoreStatus {
    /// Seconds since the application started.
    ///
    /// `u32` rather than `u64` on purpose: integers crossing IPC become JS
    /// numbers, and specta refuses to export 64-bit integers to avoid silent
    /// precision loss. Seconds fit 136 years. See `docs/实施计划.md` §7.
    pub uptime_seconds: u32,
    /// Networks currently registered.
    pub connected_networks: u32,
    /// Open buffers.
    pub active_buffers: u32,
}

/// Where a connection is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    /// Socket not open yet, or waiting to retry.
    Connecting,
    /// Socket open, registration not finished.
    Connected,
    /// Registered with the server.
    Registered,
    /// Closed and not retrying.
    Disconnected,
}

/// How a line should be presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Message,
    Notice,
    /// A CTCP `ACTION`, i.e. `/me waves`.
    Action,
    /// Server-generated: joins, parts, kicks, mode changes.
    System,
}

/// Which way a raw protocol line was travelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TrafficDirection {
    Inbound,
    Outbound,
}

/// Emitted whenever a connection's state changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct NetworkStatus {
    pub network_id: String,
    /// Display name, currently the host.
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub state: ConnectionState,
    /// The nickname in use, once the server has accepted one.
    pub nick: Option<String>,
    /// Capabilities the server granted.
    pub capabilities: Vec<String>,
    /// The most recent disconnect or failure reason.
    pub detail: Option<String>,
    /// Which connection attempt this is, counting from 1.
    pub attempt: u32,
}

/// A line destined for a message list.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct IncomingMessage {
    pub network_id: String,
    /// Sender's display name; empty for server-generated lines.
    pub nick: String,
    pub kind: MessageKind,
    /// Channel or user this line belongs to.
    pub target: String,
    pub text: String,
    /// Unix seconds, from the `server-time` tag when available.
    pub timestamp: u32,
    /// Whether we sent it.
    pub is_self: bool,
    /// Monotonic per-network sequence.
    ///
    /// Exists so the UI can subscribe *and* replay the backlog without
    /// duplicating whatever arrived in between: an entry is applied only when
    /// its sequence is newer than the last one seen.
    pub seq: u32,
}

/// A raw protocol line, for the server buffer.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct RawTraffic {
    pub network_id: String,
    pub direction: TrafficDirection,
    pub line: String,
    pub timestamp: u32,
    /// Monotonic per-network sequence; see [`IncomingMessage::seq`].
    pub seq: u32,
}

/// Recently emitted events for one network, for a UI that subscribed late.
///
/// Tauri events are not buffered, so anything emitted between "connection
/// started" and "window finished mounting" would otherwise be lost forever —
/// which includes the entire registration handshake when a connection is opened
/// at startup.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NetworkBacklog {
    pub network_id: String,
    /// Oldest first.
    pub messages: Vec<IncomingMessage>,
    /// Oldest first.
    pub traffic: Vec<RawTraffic>,
}

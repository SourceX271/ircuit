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

/// Formatting for one run of a message.
///
/// Colours are reported exactly as the protocol expressed them — a palette index
/// or a 24-bit value. Turning those into something that reads well on the
/// current theme is the renderer's job, not the protocol layer's.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MessageStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub monospace: bool,
    pub reverse: bool,
    /// mIRC palette index, `0..=98`.
    pub fg_index: Option<u8>,
    pub bg_index: Option<u8>,
    /// `RRGGBB`, from the hex colour extension.
    pub fg_hex: Option<String>,
    pub bg_hex: Option<String>,
}

/// One styled run of a message.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MessageSegment {
    pub text: String,
    pub style: MessageStyle,
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
    /// The line with formatting codes removed, for search and notifications.
    pub text: String,
    /// The same line with formatting preserved. Always at least one run.
    pub segments: Vec<MessageSegment>,
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

/// One member of a channel, as the UI needs them.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MemberInfo {
    pub nick: String,
    /// Highest privilege prefix, e.g. `@`. `None` for an ordinary member.
    pub prefix: Option<String>,
    pub away: bool,
    /// Services account, when the server told us.
    pub account: Option<String>,
}

/// The full state of one channel.
///
/// Snapshots rather than deltas: channel state is small, and a delta protocol
/// would mean the UI could drift out of sync with no way to notice. A newer
/// snapshot always replaces an older one, so a late or reordered delivery is
/// harmless as long as `seq` is respected.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct ChannelSnapshot {
    pub network_id: String,
    pub name: String,
    pub topic: Option<String>,
    /// Highest privilege first, then by nickname.
    pub members: Vec<MemberInfo>,
    /// Channel modes as a user would type them, e.g. `+nt`.
    pub modes: String,
    /// Whether the initial `NAMES` burst has finished.
    ///
    /// Until it has, an empty member list means "not asked yet", which the UI
    /// must not render as "empty channel".
    pub names_received: bool,
    /// Monotonic per-network sequence; a newer snapshot always wins.
    pub seq: u32,
}

/// A channel the client is no longer in.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct ChannelClosed {
    pub network_id: String,
    pub name: String,
    pub seq: u32,
}

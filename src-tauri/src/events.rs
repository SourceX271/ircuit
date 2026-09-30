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

/// Project protocol formatting onto the flat shape the UI consumes.
///
/// Lives next to the types it builds rather than next to the connection code:
/// this is the IPC contract's adapter, and the contract is what has to stay
/// stable.
pub(crate) fn convert_segments(segments: &[ircuit_state::MessageSegment]) -> Vec<MessageSegment> {
    segments
        .iter()
        .map(|segment| {
            let (fg_index, fg_hex) = split_color(segment.style.fg);
            let (bg_index, bg_hex) = split_color(segment.style.bg);

            MessageSegment {
                text: segment.text.clone(),
                style: MessageStyle {
                    bold: segment.style.bold,
                    italic: segment.style.italic,
                    underline: segment.style.underline,
                    strikethrough: segment.style.strikethrough,
                    monospace: segment.style.monospace,
                    reverse: segment.style.reverse,
                    fg_index,
                    bg_index,
                    fg_hex,
                    bg_hex,
                },
            }
        })
        .collect()
}

/// Map a normalized message kind onto the wire value the UI switches on.
pub(crate) fn convert_kind(kind: ircuit_state::MessageKind) -> MessageKind {
    match kind {
        ircuit_state::MessageKind::Message => MessageKind::Message,
        ircuit_state::MessageKind::Notice => MessageKind::Notice,
        ircuit_state::MessageKind::Action => MessageKind::Action,
        ircuit_state::MessageKind::System => MessageKind::System,
    }
}

/// Colours arrive either as a palette index or as a 24-bit value; the renderer
/// has to tell them apart, so they travel in separate fields rather than as a
/// union the generated TypeScript would have to narrow.
fn split_color(color: Option<ircuit_state::MessageColor>) -> (Option<u8>, Option<String>) {
    match color {
        Some(ircuit_state::MessageColor::Indexed(index)) => (Some(index), None),
        Some(ircuit_state::MessageColor::Hex(value)) => (None, Some(format!("{value:06X}"))),
        None => (None, None),
    }
}

/// A line destined for a message list.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct IncomingMessage {
    pub network_id: String,
    /// Sender's display name; empty for server-generated lines.
    pub nick: String,
    pub kind: MessageKind,
    /// Channel or user the line names, exactly as the protocol addressed it.
    pub target: String,
    /// The conversation buffer this line belongs to.
    ///
    /// Not always `target`: a private message is addressed to *us*, while the
    /// conversation belongs to the sender. The backend resolves it (see
    /// `ircuit_state::view::ViewMessage::buffer`) because history is keyed by it
    /// — a UI that derived it differently would file lines under a key nothing
    /// reads and show an empty conversation, with no error anywhere.
    pub buffer: String,
    /// The line with formatting codes removed, for search and notifications.
    pub text: String,
    /// The same line with formatting preserved. Always at least one run.
    pub segments: Vec<MessageSegment>,
    /// Unix seconds, from the `server-time` tag when available.
    pub timestamp: u32,
    /// Whether we sent it.
    pub is_self: bool,
    /// Our nickname on this network as it was when the line was classified.
    ///
    /// Sent so the UI never has to *infer* it. The store used to look the nick up
    /// in its network list, which is empty for the first few milliseconds after
    /// startup — exactly when an auto-connected session's first lines arrive. Any
    /// line that landed in that window was classified with no nickname known, so
    /// a mention of the user was silently not a highlight, and the sequence
    /// dedup meant it was never re-examined. The backend already knows the nick:
    /// it is what `is_self` was computed from.
    pub self_nick: Option<String>,
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
    /// The line exactly as it went on the wire, with its formatting codes intact.
    pub line: String,
    /// The same line parsed into styled runs, when it carries any formatting.
    ///
    /// Empty for the great majority of lines — `PING`, numerics, plain chatter —
    /// so the ring buffer does not pay for a parse it will never show. The
    /// frontend falls back to [`Self::line`] whenever this is empty.
    ///
    /// The raw text is kept alongside rather than replaced: the server buffer is
    /// also the place someone looks to find out what actually arrived, and a
    /// rendered line cannot answer "was that bold, or was it `\u{0002}`".
    #[serde(default)]
    pub segments: Vec<MessageSegment>,
    pub timestamp: u32,
    /// Monotonic per-network sequence; see [`IncomingMessage::seq`].
    pub seq: u32,
}

impl RawTraffic {
    /// Build a traffic entry, parsing formatting only when there is any.
    #[must_use]
    pub fn new(
        network_id: String,
        direction: TrafficDirection,
        line: String,
        timestamp: u32,
        seq: u32,
    ) -> Self {
        let parsed = ircuit_proto::formatting::parse(&line);
        let styled = parsed
            .iter()
            .any(|segment| segment.style != ircuit_proto::formatting::Style::default());

        Self {
            network_id,
            direction,
            line,
            segments: if styled {
                convert_segments(&parsed)
            } else {
                Vec::new()
            },
            timestamp,
            seq,
        }
    }
}

/// One line of stored history on its way to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HistoryMessage {
    /// The database rowid, as text.
    ///
    /// A rowid does not fit the IPC integer rule (docs §7). It is an opaque
    /// handle to the UI — only ever handed back as a cursor, never arithmetic.
    pub id: String,
    pub network_id: String,
    /// The conversation buffer this line belongs to.
    pub buffer: String,
    pub nick: String,
    pub kind: MessageKind,
    /// The line with formatting codes removed.
    ///
    /// History stores text rather than styled runs: the codes were already
    /// interpreted once, and an archive that has to be re-parsed to be read is
    /// one schema change away from unreadable.
    pub body: String,
    /// Unix seconds.
    pub at: u32,
    pub is_self: bool,
}

/// Where to continue paging backwards from.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HistoryCursor {
    pub at: u32,
    /// Rowid as text; see [`HistoryMessage::id`].
    pub id: String,
}

/// One page of history, oldest line first.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HistoryPage {
    /// Oldest first — the order the UI draws them in, so a page can be prepended
    /// without reversing anything at the call site.
    pub messages: Vec<HistoryMessage>,
    /// Whether this page reached the beginning of the buffer.
    ///
    /// Decided by the backend with one extra row, rather than by the UI guessing
    /// from a short page — a full page that happens to be the last one is
    /// otherwise indistinguishable from one that is not.
    pub exhausted: bool,
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

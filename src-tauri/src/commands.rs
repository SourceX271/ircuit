//! Tauri IPC command layer: the only way the frontend can reach the backend.
//!
//! Commands here validate arguments and forward; the actual work lives in
//! `crates/`. Keeping it that way is what lets the protocol and connection logic
//! be tested without a webview.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use ircuit_client::ClientCommand;

use crate::events::{ChannelSnapshot, NetworkBacklog};
use crate::net::{NetworkManager, NetworkRequest, NetworkSummary};

/// Application and runtime information.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppInfo {
    /// Product name.
    pub name: String,
    /// Application version.
    pub version: String,
    /// The Tauri version this build links against.
    pub tauri_version: String,
    /// Target operating system, e.g. `windows` / `macos` / `linux`.
    pub platform: String,
    /// Target CPU architecture, e.g. `x86_64` / `aarch64`.
    pub arch: String,
    /// Whether this is a debug build.
    pub debug: bool,
}

/// A core crate describing itself, shown in the architecture panel.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CoreModule {
    /// Crate name.
    pub name: String,
    /// What the crate is responsible for.
    pub responsibility: String,
    /// The milestone that delivers it.
    pub milestone: String,
}

/// Return application and runtime information.
#[tauri::command]
#[specta::specta]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: "Ircuit".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        tauri_version: tauri::VERSION.to_owned(),
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        debug: cfg!(debug_assertions),
    }
}

/// Return the list of core crates and their status.
#[tauri::command]
#[specta::specta]
pub fn list_core_modules() -> Vec<CoreModule> {
    fn module(name: &str, responsibility: &str, milestone: &str) -> CoreModule {
        CoreModule {
            name: name.to_owned(),
            responsibility: responsibility.to_owned(),
            milestone: milestone.to_owned(),
        }
    }

    vec![
        module(
            "ircuit-proto",
            "IRC 报文编解码、IRCv3 标签、格式码",
            "M1 已完成",
        ),
        module(
            "ircuit-client",
            "连接、CAP 协商、SASL、保活与重连",
            "M1 已完成",
        ),
        module("ircuit-state", "消息归一化与状态模型", "M1 已完成"),
        module("ircuit-storage", "历史、FTS5 检索、凭据保管", "M3"),
        module("ircuit-encoding", "编码检测与转换", "M4"),
        module("ircuit-dcc", "DCC CHAT 与文件传输", "M5"),
        module("ircuit-plugin", "QuickJS 插件宿主与 API", "M6"),
    ]
}

/// Open a connection to a network.
#[tauri::command]
#[specta::specta]
pub async fn connect_network(
    app: AppHandle,
    manager: State<'_, Arc<NetworkManager>>,
    request: NetworkRequest,
) -> Result<NetworkSummary, String> {
    manager.inner().connect(&app, request).await
}

/// Close a connection and stop retrying it.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_network(
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
) -> Result<(), String> {
    manager.inner().disconnect(&network_id).await
}

/// Every network the application is tracking.
#[tauri::command]
#[specta::specta]
pub async fn list_networks(
    manager: State<'_, Arc<NetworkManager>>,
) -> Result<Vec<NetworkSummary>, String> {
    Ok(manager.inner().list().await)
}

/// Recent events for one network, so a freshly mounted UI can catch up.
///
/// Tauri events are not buffered: without this, anything emitted before the
/// window finished loading would be lost — including an entire registration
/// handshake when the connection was opened at startup.
#[tauri::command]
#[specta::specta]
pub async fn get_network_backlog(
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
) -> Result<NetworkBacklog, String> {
    manager
        .inner()
        .backlog(&network_id)
        .await
        .ok_or_else(|| format!("no such network: {network_id}"))
}

/// The current state of every channel on a network.
#[tauri::command]
#[specta::specta]
pub async fn list_channels(
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
) -> Result<Vec<ChannelSnapshot>, String> {
    manager
        .inner()
        .channel_snapshots(&network_id)
        .await
        .ok_or_else(|| format!("no such network: {network_id}"))
}

/// Send a message to a channel or user.
#[tauri::command]
#[specta::specta]
pub async fn send_message(
    app: AppHandle,
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
    target: String,
    text: String,
) -> Result<(), String> {
    manager
        .inner()
        .send(&app, &network_id, ClientCommand::Privmsg { target, text })
        .await
}

/// Join a channel.
#[tauri::command]
#[specta::specta]
pub async fn join_channel(
    app: AppHandle,
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
    channel: String,
) -> Result<(), String> {
    manager
        .inner()
        .send(&app, &network_id, ClientCommand::Join(channel))
        .await
}

/// Open a URL from a message in the user's browser.
///
/// The URL is validated against a scheme allowlist first: links arrive from
/// strangers, and handing `file://` or `javascript:` to the system opener is a
/// real attack. See [`crate::opener`].
#[tauri::command]
#[specta::specta]
pub fn open_external(url: String) -> Result<(), String> {
    let url = crate::opener::validate_external_url(&url)?;
    crate::opener::launch(url).map_err(|error| error.to_string())
}

/// Send a raw protocol line, for the command console.
#[tauri::command]
#[specta::specta]
pub async fn send_raw_command(
    app: AppHandle,
    manager: State<'_, Arc<NetworkManager>>,
    network_id: String,
    line: String,
) -> Result<(), String> {
    manager
        .inner()
        .send(&app, &network_id, ClientCommand::Raw(line))
        .await
}

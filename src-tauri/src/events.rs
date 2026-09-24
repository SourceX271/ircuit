//! 由 Rust 核心推送到前端的事件。
//!
//! 事件是单向的（Rust → 前端），用于状态变化与运行期通知；
//! 前端向后端表达意图一律走 `commands`。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 核心运行时状态快照。
///
/// M0 阶段只是一个心跳，用来验证 IPC 事件通道可用；随着 M1/M2 落地，
/// 这里的字段会变成真实的网络与 buffer 计数。
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct CoreStatus {
    /// 应用已运行的秒数。
    ///
    /// 刻意用 `u32` 而非 `u64`：跨 IPC 的整数最终是 JS 的 `number`，
    /// specta 会直接拒绝导出 64 位整数以避免精度丢失。秒粒度的 u32
    /// 可以表示 136 年，对运行时长完全够用。
    /// 约定见 `docs/实施计划.md` 的「IPC 整数约定」。
    pub uptime_seconds: u32,
    /// 当前已连接的网络数量。
    pub connected_networks: u32,
    /// 当前打开的 buffer 数量。
    pub active_buffers: u32,
}

/// 周期性地把 [`CoreStatus`] 推给前端。
pub fn spawn_status_heartbeat(app: tauri::AppHandle) {
    use tauri_specta::Event as _;

    let started = std::time::Instant::now();

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(2));

        loop {
            ticker.tick().await;

            let elapsed = started.elapsed().as_secs();
            let status = CoreStatus {
                uptime_seconds: u32::try_from(elapsed).unwrap_or(u32::MAX),
                connected_networks: 0,
                active_buffers: 0,
            };

            if let Err(error) = status.emit(&app) {
                tracing::warn!(%error, "推送 CoreStatus 事件失败");
            }
        }
    });
}

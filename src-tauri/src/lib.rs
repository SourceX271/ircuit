//! Ircuit 桌面应用入口。
//!
//! 这一层刻意保持很薄：它只负责装配 Tauri、注册 IPC 命令与事件、拉起后台运行时。
//! 所有协议与状态逻辑都住在 `crates/` 里，不依赖 Tauri，因而可以独立测试。

pub mod bindings;
pub mod commands;
pub mod events;
pub mod history;
pub mod logging;
pub mod net;
pub mod opener;

use std::sync::Arc;

use tauri::Manager;

/// Where the history database lives under the app data directory.
const HISTORY_FILE: &str = "history.sqlite";

/// Open the history database, falling back to one that forgets.
///
/// Losing the archive is bad; refusing to start the client because the archive
/// cannot be opened is worse. A user on a read-only home directory, or with a
/// database left behind by a newer build, can still chat — the log says what they
/// are missing.
fn open_history(app: &tauri::AppHandle) -> Arc<history::HistoryStore> {
    let path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(HISTORY_FILE));

    match path.as_deref().map(history::HistoryStore::open) {
        Some(Ok(store)) => {
            if let Some(path) = path.as_deref() {
                tracing::info!(path = %path.display(), "历史数据库已打开");
            }
            Arc::new(store)
        }
        Some(Err(error)) => {
            tracing::warn!(%error, "无法打开历史数据库；本次运行不会保存聊天记录");
            forgetful()
        }
        None => {
            tracing::warn!("找不到应用数据目录；本次运行不会保存聊天记录");
            forgetful()
        }
    }
}

/// The last resort when no database can be opened at all.
///
/// Panicking here would mean no client whatsoever, and the only ways to reach it
/// are a failed allocation or a broken SQLite build — at which point the process
/// has larger problems than chat history.
fn forgetful() -> Arc<history::HistoryStore> {
    Arc::new(
        history::HistoryStore::in_memory()
            .expect("SQLite could not even open an in-memory database"),
    )
}

/// 启动桌面应用。
pub fn run() {
    logging::init();

    // 绑定只能由 `pnpm cargo:bindings`（专用的 export-bindings bin）生成。
    //
    // 这里刻意**不**顺带导出：debug 构建曾经在启动时重写 `src/lib/bindings.ts`，
    // 于是运行一个陈旧的二进制就会把新生成的绑定覆盖回旧版本，前端随即在
    // 调用不存在的命令时崩溃，且症状（窗口全白）与原因毫无关联。
    let builder = bindings::builder();

    let manager = std::sync::Arc::new(net::NetworkManager::default());
    let heartbeat_manager = std::sync::Arc::clone(&manager);
    #[cfg(debug_assertions)]
    let autoconnect_manager = std::sync::Arc::clone(&manager);

    tauri::Builder::default()
        .manage(manager)
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            // Registered here rather than before `setup` because the app data
            // directory is only resolvable once there is an app handle.
            app.manage(open_history(app.handle()));

            net::spawn_status_heartbeat(app.handle().clone(), heartbeat_manager);

            #[cfg(debug_assertions)]
            net::maybe_autoconnect(app.handle().clone(), autoconnect_manager);

            tracing::info!(version = env!("CARGO_PKG_VERSION"), "Ircuit 已启动");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

#[cfg(test)]
mod tests {
    /// 冒烟测试：确认工作区内的核心 crate 确实被链接进来。
    #[test]
    fn core_crates_are_linked() {
        assert_eq!(ircuit_proto::MAX_LINE_BYTES, 512);
    }
}

//! Ircuit 桌面应用入口。
//!
//! 这一层刻意保持很薄：它只负责装配 Tauri、注册 IPC 命令与事件、拉起后台运行时。
//! 所有协议与状态逻辑都住在 `crates/` 里，不依赖 Tauri，因而可以独立测试。

pub mod bindings;
pub mod commands;
pub mod events;
pub mod logging;

/// 启动桌面应用。
pub fn run() {
    logging::init();

    let builder = bindings::builder();

    // 开发构建下顺带刷新 TS 绑定，避免前后端类型漂移。
    #[cfg(debug_assertions)]
    if let Err(error) = bindings::export() {
        tracing::warn!(%error, "生成 IPC 类型绑定失败");
    }

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            events::spawn_status_heartbeat(app.handle().clone());
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

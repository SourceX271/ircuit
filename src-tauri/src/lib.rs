//! Ircuit 桌面应用入口。
//!
//! 这一层刻意保持很薄：它只负责装配 Tauri、注册 IPC 命令与事件、拉起后台运行时。
//! 所有协议与状态逻辑都住在 `crates/` 里，不依赖 Tauri，因而可以独立测试。

pub mod bindings;
pub mod commands;
pub mod events;
pub mod logging;
pub mod net;

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

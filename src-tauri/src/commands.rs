//! Tauri IPC 命令层：前端唯一能调用后端的入口。
//!
//! 这里的命令应当只做参数校验与转发，业务逻辑放在 `crates/` 中。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 应用与运行时的基本信息。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppInfo {
    /// 产品名。
    pub name: String,
    /// 应用版本号。
    pub version: String,
    /// 所依赖的 Tauri 版本。
    pub tauri_version: String,
    /// 目标操作系统，例如 `windows` / `macos` / `linux`。
    pub platform: String,
    /// 目标 CPU 架构，例如 `x86_64` / `aarch64`。
    pub arch: String,
    /// 是否为 debug 构建。
    pub debug: bool,
}

/// 一个核心模块在界面上的自我描述。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CoreModule {
    /// crate 名。
    pub name: String,
    /// 该模块负责什么。
    pub responsibility: String,
    /// 计划落地的里程碑。
    pub milestone: String,
}

/// 返回应用与运行时信息。
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

/// 返回核心模块清单，供界面展示架构就绪情况。
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
            "RFC 1459 / IRCv3 报文编解码、格式码处理",
            "M1",
        ),
        module(
            "ircuit-client",
            "连接状态机、CAP 协商、SASL、自动重连",
            "M1",
        ),
        module("ircuit-state", "网络 / 频道 / 用户状态模型", "M1"),
        module("ircuit-storage", "SQLite 历史、FTS5 检索、凭据保管", "M3"),
        module("ircuit-encoding", "编码检测与转换", "M4"),
        module("ircuit-dcc", "DCC CHAT 与文件传输", "M5"),
        module("ircuit-plugin", "QuickJS 插件宿主与 API", "M6"),
    ]
}

//! IPC 类型绑定的集中登记与导出。
//!
//! **`src/lib/bindings.ts` 由本模块生成，不要手写。**
//!
//! 命令与事件只在这里登记一次，前端拿到的 TS 类型与 Rust 定义永远一致：
//! 改了 Rust 结构体却忘了改 TS，编译期就会报错。

use std::path::PathBuf;

use tauri_specta::{collect_commands, collect_events, Builder};

/// 相对 `src-tauri/` 的绑定输出路径。
const BINDINGS_RELATIVE_PATH: &str = "../src/lib/bindings.ts";

/// 构造 IPC builder：所有命令与事件都必须在这里登记。
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::commands::get_app_info,
            crate::commands::list_core_modules,
        ])
        .events(collect_events![crate::events::CoreStatus])
}

/// TypeScript 绑定的输出路径（绝对路径，与调用时的当前目录无关）。
pub fn bindings_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BINDINGS_RELATIVE_PATH)
}

/// 生成 TypeScript 绑定，返回写入的路径。
pub fn export() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = bindings_path();
    builder().export(specta_typescript::Typescript::default(), &path)?;
    Ok(path)
}

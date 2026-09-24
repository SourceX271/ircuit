//! 日志初始化。
//!
//! 通过 `IRCUIT_LOG` 环境变量控制级别（语法同 `RUST_LOG`），例如：
//!
//! ```text
//! IRCUIT_LOG=ircuit_client=trace,ircuit=debug
//! ```

use tracing_subscriber::{fmt, EnvFilter};

/// 安装全局日志订阅器。重复调用是安全的（后一次会被忽略）。
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    // 失败只可能是已经装过订阅器，此处无需处理。
    let _ = fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_level(true)
        .try_init();
}

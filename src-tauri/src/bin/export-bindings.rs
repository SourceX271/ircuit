//! 在不启动应用的情况下重新生成 TypeScript IPC 绑定。
//!
//! 用法：`pnpm cargo:bindings`
//!
//! 独立成 bin 而不是塞进 `run()`，是为了让 CI 能在无显示环境下校验绑定是否漂移。

fn main() {
    match ircuit_lib::bindings::export() {
        Ok(path) => println!("IPC 绑定已生成: {}", path.display()),
        Err(error) => {
            eprintln!("生成 IPC 绑定失败: {error}");
            std::process::exit(1);
        }
    }
}

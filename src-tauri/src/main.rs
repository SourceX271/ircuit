// Windows 的发布版不额外弹出控制台窗口；debug 构建保留，方便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ircuit_lib::run();
}

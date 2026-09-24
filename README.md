# Ircuit

现代、简洁美观、功能完整的跨平台桌面 IRC 客户端。

**IRC 的协议深度 + 现代 IM 的界面品质 + 纯本地的历史与全文搜索。**

---

## 状态

**M0（工程骨架）已完成**，下一步是 M1（协议内核）。里程碑规划见 [`docs/实施计划.md`](docs/实施计划.md)，需求基线见 [`docs/需求文档.md`](docs/需求文档.md)。

| 里程碑 | 状态 |
| --- | --- |
| M0 工程骨架 | ✅ 已完成 |
| M1 协议内核 | 下一步 |
| M2 会话 UI | 未开始 |
| M3 持久化与检索 | 未开始 |
| M4 兼容性 | 未开始 |
| M5 DCC 与文件 | 未开始 |
| M6 插件系统 | 未开始 |
| M7 IRCv3 高级 | 未开始 |
| M8 打磨 | 未开始 |
| M9 发布 | 未开始 |

---

## 技术栈

- **外壳**：[Tauri 2](https://tauri.app/)（Rust 后端 + 系统 WebView）
- **后端**：Rust（`tokio` 异步、`rustls` TLS、自研 IRC 协议栈）
- **前端**：[React 19](https://react.dev/) + TypeScript + [Vite](https://vite.dev/)
- **样式**：[Tailwind CSS v4](https://tailwindcss.com/) + shadcn/ui 风格组件 + 三层 design token
- **数据**：SQLite + FTS5（M3 起）

---

## 目录结构

```
Ircuit/
├─ crates/                     # Rust 核心（与 UI 完全解耦）
│  ├─ ircuit-proto/            # RFC 1459 / IRCv3 报文编解码
│  ├─ ircuit-client/           # 连接状态机、CAP 协商、SASL、重连
│  ├─ ircuit-state/            # network / channel / user 状态模型
│  ├─ ircuit-encoding/         # 编码检测与转换
│  ├─ ircuit-storage/          # SQLite + FTS5 + 配置 + Keyring
│  ├─ ircuit-dcc/              # DCC CHAT / SEND / RESUME
│  └─ ircuit-plugin/           # QuickJS 插件宿主
├─ src-tauri/                  # Tauri 应用与 IPC 命令层
├─ src/                        # React 前端
└─ docs/                       # 需求与实施文档
```

---

## 开发环境

要求：Node.js ≥ 20、pnpm ≥ 9、Rust ≥ 1.77。

```powershell
# 1) 安装前端依赖
pnpm install

# 2) 指定项目内的 CARGO_HOME（本机沙箱限制，详见 .cache/cargo/config.toml）
$env:CARGO_HOME = "D:\Project\Tauri\Ircuit\.cache\cargo"

# 3) 启动桌面应用（会同时拉起 Vite 开发服务器）
pnpm tauri dev
```

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 只启动前端（浏览器调试，无 Tauri API） |
| `pnpm tauri dev` | 启动桌面应用 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 前端单元测试 |
| `pnpm cargo:test` | Rust 测试（并重新生成 IPC 类型绑定） |
| `pnpm cargo:clippy` | Rust lint（warnings 视为错误） |
| `pnpm cargo:fmt` | Rust 格式化 |

> 所有 `pnpm cargo:*` 脚本已内置 `CARGO_HOME` 指向，无需手动设置。

### 受限环境

在缓存目录不可写、或禁止带管道子进程的环境（容器、CI 沙箱、受管终端）里，
需要额外两步。原因与原理见 [`docs/实施计划.md`](docs/实施计划.md) 第 8 节。

```powershell
# 1) 启动本机 cargo registry 代理（仅首次拉取依赖时需要）
node scripts/dev/cargo-proxy.mjs

# 2) 让 Node 容忍被拒的子进程 spawn（Vite / vitest 需要）
$env:NODE_OPTIONS = '--import ./scripts/dev/sandbox-shim.mjs'
pnpm test
```

界面无法用普通截屏验证（窗口被遮挡）时：

```powershell
pwsh -File scripts/dev/capture-window.ps1 -ProcessName ircuit -OutputPath .cache/ui.png
```

---

## IPC 类型绑定

前端与 Rust 之间的类型由 [`tauri-specta`](https://github.com/specta-rs/tauri-specta) 自动生成，**不要手写** `src/lib/bindings.ts`。

- 生成时机：运行 `pnpm tauri dev`（debug 构建）或 `pnpm cargo:bindings`。
- 契约来源：`src-tauri/src/commands.rs` 中的命令与事件定义。

---

## 许可

MIT OR Apache-2.0

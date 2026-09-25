import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri 在需要时（例如真机调试）会通过该变量告知外部可访问的 HMR 主机地址。
const devHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Tauri 自行管理控制台输出，禁止 Vite 清屏以免吞掉 Rust 侧的日志。
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: devHost ?? false,
    hmr: devHost ? { protocol: 'ws', host: devHost, port: 1421 } : undefined,
    watch: {
      // Rust 侧由 cargo 负责重建，Vite 不必跟着刷新。
      //
      // 最后一条是给「就地写文件」的编辑器/工具留的：某些写法会先在目标旁边建一个
      // `<名字>.<pid>.<uuid>.tmpdir/` 再原子替换，watcher 去 watch 那个临时文件时
      // 会撞上 EBUSY 并**直接让 dev server 崩掉**（不是警告，是进程退出）。
      ignored: [
        '**/src-tauri/**',
        '**/crates/**',
        '**/.cache/**',
        '**/target/**',
        '**/.*.tmpdir/**',
      ],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],

  build: {
    // Tauri 使用系统 WebView：Windows 是 WebView2(Chromium)，macOS / Linux 是 WebKit。
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // 交给 Vite 选默认压缩器（Vite 8 是 oxc）；debug 构建保留可读产物便于调试。
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 用工作线程而不是派生子进程：少一层进程开销，且在禁止 spawn 的
    // 受限环境（容器、沙箱）里也能跑。
    pool: 'threads',
  },
});

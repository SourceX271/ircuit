/**
 * 受限沙箱兼容垫片（预加载模块）。
 *
 * ## 它解决什么
 *
 * Vite 在 Windows 上启动时会执行 `net use` 来探测网络驱动器映射
 * （`vite/dist/node/chunks/node.js` 里的 `optimizeSafeRealPathSync`）。
 * 在禁止创建带管道子进程的环境里，`child_process.exec` 会**同步抛出**
 * `EPERM`，于是 Vite 连配置文件都没读完就整个崩掉。
 *
 * 这个问题本质上是 Vite 的健壮性缺口：一次「探测」失败不应该让整个进程挂掉。
 * 本模块把这类失败降级为「探测不可用」，让 Vite 回退到默认的 realpath 实现。
 *
 * ## 使用
 *
 * 仅在受限环境中需要，通过 NODE_OPTIONS 预加载（相对仓库根目录）：
 *
 *     $env:NODE_OPTIONS = '--import ./scripts/dev/sandbox-shim.mjs'
 *     pnpm test
 *
 * 正常开发机上本模块**不做任何事**：只有 spawn 因权限被拒（EPERM）时才介入，
 * 其它错误一律原样抛出，绝不掩盖真实问题。
 */
import childProcess from 'node:child_process';

/** 只有权限被拒才降级；其它错误保持原样抛出。 */
const isSandboxDenial = (error) => error?.code === 'EPERM' || error?.code === 'EACCES';

function patch(name) {
  const original = childProcess[name];
  if (typeof original !== 'function') return;

  childProcess[name] = function sandboxTolerant(...args) {
    try {
      return original.apply(this, args);
    } catch (error) {
      if (!isSandboxDenial(error)) throw error;

      // 把失败交回回调，调用方会按「命令执行失败」处理 —— 这正是我们想要的。
      const callback = [...args].reverse().find((arg) => typeof arg === 'function');
      if (typeof callback === 'function') {
        queueMicrotask(() => callback(error, '', ''));
        return undefined;
      }

      // 没有回调说明调用方期望同步拿到结果，无法安全降级。
      throw error;
    }
  };
}

patch('exec');
patch('execFile');

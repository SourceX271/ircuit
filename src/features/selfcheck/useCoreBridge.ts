import { useEffect, useState } from 'react';

import {
  getAppInfo,
  listCoreModules,
  onCoreStatus,
  type AppInfo,
  type CoreModule,
  type CoreStatus,
} from '@/lib/ipc';

export type IpcState = 'pending' | 'ok' | 'error';

export interface CoreBridgeState {
  /** IPC 通道的整体健康状况。 */
  ipcState: IpcState;
  /** 应用与运行时信息，取自一次命令往返。 */
  appInfo: AppInfo | null;
  /** Rust 核心模块清单。 */
  modules: CoreModule[];
  /** 最近一次核心状态事件。 */
  status: CoreStatus | null;
  /** 最近一次命令往返耗时（毫秒）。 */
  latencyMs: number | null;
  /** 已收到的状态事件数量。 */
  heartbeatCount: number;
  /** 最近一次事件到达的本地时间戳。 */
  lastHeartbeatAt: number | null;
}

/**
 * 校验 M0 的两条 IPC 通道是否真的通了。
 *
 * - **命令**（前端 → 后端，一问一答）：取应用信息与模块清单，并顺带测出往返耗时；
 * - **事件**（后端 → 前端，单向推送）：靠核心状态心跳持续验证。
 *
 * 只有两条都通，界面才敢显示「IPC 正常」—— 只通一条是最容易被忽略的故障模式。
 */
export function useCoreBridge(): CoreBridgeState {
  const [state, setState] = useState<CoreBridgeState>({
    ipcState: 'pending',
    appInfo: null,
    modules: [],
    status: null,
    latencyMs: null,
    heartbeatCount: 0,
    lastHeartbeatAt: null,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const startedAt = performance.now();
        const [appInfo, modules] = await Promise.all([getAppInfo(), listCoreModules()]);
        const latencyMs = Math.round(performance.now() - startedAt);

        if (cancelled) return;
        setState((previous) => ({ ...previous, ipcState: 'ok', appInfo, modules, latencyMs }));
      } catch (error) {
        if (cancelled) return;
        console.error('[ircuit] IPC 命令调用失败', error);
        setState((previous) => ({ ...previous, ipcState: 'error' }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onCoreStatus((status) => {
      setState((previous) => ({
        ...previous,
        ipcState: 'ok',
        status,
        heartbeatCount: previous.heartbeatCount + 1,
        lastHeartbeatAt: Date.now(),
      }));
    })
      .then((stop) => {
        // StrictMode 下 effect 会跑两次，这里必须处理「订阅完成时已卸载」。
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.error('[ircuit] 订阅核心状态事件失败', error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return state;
}

/**
 * IPC 适配层：**唯一**直接引用自动生成绑定的模块。
 *
 * `src/lib/bindings.ts` 由 Rust 侧生成（`pnpm cargo:bindings`），不要手写、
 * 也不要让其它模块直接 import 它。把生成的代码收敛在这一个文件里，
 * 生成器升级或命名风格变化时只需要改这里。
 */

import { commands, events, type AppInfo, type CoreModule, type CoreStatus } from './bindings';

export type { AppInfo, CoreModule, CoreStatus };

/** 取应用与运行时信息。 */
export function getAppInfo(): Promise<AppInfo> {
  return commands.getAppInfo();
}

/** 取 Rust 核心模块清单。 */
export function listCoreModules(): Promise<CoreModule[]> {
  return commands.listCoreModules();
}

/**
 * 订阅核心状态心跳。
 *
 * @returns 取消订阅的函数；组件卸载时必须调用，否则会泄漏监听。
 */
export function onCoreStatus(handler: (status: CoreStatus) => void): Promise<() => void> {
  return events.coreStatus.listen((event) => handler(event.payload));
}

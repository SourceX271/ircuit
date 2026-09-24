/**
 * IPC 适配层：**唯一**直接引用自动生成绑定的模块。
 *
 * `src/lib/bindings.ts` 由 Rust 侧生成（`pnpm cargo:bindings`），不要手写、
 * 也不要让其它模块直接 import 它。把生成的代码收敛在这一个文件里，
 * 生成器升级或命名风格变化时只需要改这里。
 *
 * 另外这一层把生成的 `Result` 联合体收敛成「失败即 reject 的 Promise」，
 * 调用点不需要每次都判断 `status`。
 */

import type { UnlistenFn } from '@tauri-apps/api/event';

import {
  commands,
  events,
  type AppInfo,
  type ChannelClosed,
  type ChannelSnapshot,
  type ConnectionState,
  type CoreModule,
  type CoreStatus,
  type IncomingMessage,
  type MemberInfo,
  type MessageKind,
  type NetworkBacklog,
  type NetworkRequest,
  type NetworkStatus,
  type NetworkSummary,
  type RawTraffic,
  type TrafficDirection,
} from './bindings';

export type {
  AppInfo,
  ChannelClosed,
  ChannelSnapshot,
  ConnectionState,
  CoreModule,
  CoreStatus,
  IncomingMessage,
  MemberInfo,
  MessageKind,
  NetworkBacklog,
  NetworkRequest,
  NetworkStatus,
  NetworkSummary,
  RawTraffic,
  TrafficDirection,
};

/** 生成器为 Rust `Result` 返回值使用的形状。 */
type CommandResult<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** 结算命令结果，把 error 分支转成 rejected promise。 */
async function unwrap<T>(result: Promise<CommandResult<T, string>>): Promise<T> {
  const settled = await result;
  if (settled.status === 'ok') return settled.data;
  throw new Error(settled.error);
}

/** 应用与运行时信息。 */
export function getAppInfo(): Promise<AppInfo> {
  return commands.getAppInfo();
}

/** 核心 crate 清单与交付状态。 */
export function listCoreModules(): Promise<CoreModule[]> {
  return commands.listCoreModules();
}

/** 建立一条网络连接。 */
export function connectNetwork(request: NetworkRequest): Promise<NetworkSummary> {
  return unwrap(commands.connectNetwork(request));
}

/** 断开一条网络连接，并停止自动重连。 */
export async function disconnectNetwork(networkId: string): Promise<void> {
  await unwrap(commands.disconnectNetwork(networkId));
}

/** 当前后端跟踪的所有网络。 */
export function listNetworks(): Promise<NetworkSummary[]> {
  return unwrap(commands.listNetworks());
}

/**
 * 取某个网络最近的事件，供界面刚挂载时补齐。
 *
 * Tauri 事件不做缓冲，挂载前发出的事件不会重放；没有这个接口，
 * 「启动即连接」的场景会连整段注册握手都看不见。
 */
export function getNetworkBacklog(networkId: string): Promise<NetworkBacklog> {
  return unwrap(commands.getNetworkBacklog(networkId));
}

/** 向频道或用户发送消息。 */
export async function sendMessage(networkId: string, target: string, text: string): Promise<void> {
  await unwrap(commands.sendMessage(networkId, target, text));
}

/** 加入频道。 */
export async function joinChannel(networkId: string, channel: string): Promise<void> {
  await unwrap(commands.joinChannel(networkId, channel));
}

/** 发送一条原始协议行。 */
export async function sendRawCommand(networkId: string, line: string): Promise<void> {
  await unwrap(commands.sendRawCommand(networkId, line));
}

/** 订阅核心状态心跳。 */
export function onCoreStatus(handler: (status: CoreStatus) => void): Promise<UnlistenFn> {
  return events.coreStatus.listen((event) => handler(event.payload));
}

/** 订阅网络状态变化。 */
export function onNetworkStatus(handler: (status: NetworkStatus) => void): Promise<UnlistenFn> {
  return events.networkStatus.listen((event) => handler(event.payload));
}

/** 订阅归一化后的会话消息。 */
export function onIncomingMessage(
  handler: (message: IncomingMessage) => void,
): Promise<UnlistenFn> {
  return events.incomingMessage.listen((event) => handler(event.payload));
}

/** 订阅原始协议流量（双向）。 */
export function onRawTraffic(handler: (traffic: RawTraffic) => void): Promise<UnlistenFn> {
  return events.rawTraffic.listen((event) => handler(event.payload));
}

/** 订阅频道状态快照。 */
export function onChannelSnapshot(
  handler: (snapshot: ChannelSnapshot) => void,
): Promise<UnlistenFn> {
  return events.channelSnapshot.listen((event) => handler(event.payload));
}

/** 订阅频道关闭（自己离开或被踢出）。 */
export function onChannelClosed(handler: (closed: ChannelClosed) => void): Promise<UnlistenFn> {
  return events.channelClosed.listen((event) => handler(event.payload));
}

/** 取某个网络当前的频道状态。 */
export function listChannels(networkId: string): Promise<ChannelSnapshot[]> {
  return unwrap(commands.listChannels(networkId));
}

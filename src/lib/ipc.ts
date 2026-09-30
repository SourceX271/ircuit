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
  type HistoryCursor,
  type HistoryMessage,
  type HistoryPage,
  type IncomingMessage,
  type MemberInfo,
  type MessageKind,
  type MessageSegment,
  type MessageStyle,
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
  HistoryCursor,
  HistoryMessage,
  HistoryPage,
  IncomingMessage,
  MemberInfo,
  MessageKind,
  MessageSegment,
  MessageStyle,
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

/**
 * 取某个会话的一页历史，最旧的在前。
 *
 * 不传 `before` 即取最新一页（打开会话时用）；传最旧一行的游标则继续往前翻。
 */
export function loadHistory(
  networkId: string,
  buffer: string,
  before: HistoryCursor | null,
  limit: number,
): Promise<HistoryPage> {
  return unwrap(commands.loadHistory(networkId, buffer, before, limit));
}

/** 某个会话在存档里有多少条。 */
export function countHistory(networkId: string, buffer: string): Promise<number> {
  return unwrap(commands.countHistory(networkId, buffer));
}

/**
 * 清除历史：给了 `buffer` 就清那一个会话，否则清掉整个网络。
 *
 * 注意空字符串是**服务器缓冲区**，不是「全部」——要清整个网络就不传这个参数。
 * 返回被删掉的条数。
 */
export function clearHistory(networkId: string, buffer?: string): Promise<number> {
  return unwrap(commands.clearHistory(networkId, buffer ?? null));
}

/** 发送 NOTICE。按惯例 NOTICE 不得触发自动回复。 */
export async function sendNotice(networkId: string, target: string, text: string): Promise<void> {
  await unwrap(commands.sendNotice(networkId, target, text));
}

/** 加入频道。 */
export async function joinChannel(networkId: string, channel: string): Promise<void> {
  await unwrap(commands.joinChannel(networkId, channel));
}

/** 离开频道，可附原因。 */
export async function partChannel(
  networkId: string,
  channel: string,
  reason: string | null,
): Promise<void> {
  await unwrap(commands.partChannel(networkId, channel, reason));
}

/** 切换昵称。 */
export async function setNick(networkId: string, nick: string): Promise<void> {
  await unwrap(commands.setNick(networkId, nick));
}

/**
 * 读取 / 设置 / 清除频道主题。
 *
 * `null` 表示查询当前主题，空字符串表示清除——两者在有线协议上是不同的
 * 请求，因此不能让 `undefined` 顺手代表其中一种。
 */
export async function setTopic(
  networkId: string,
  channel: string,
  topic: string | null,
): Promise<void> {
  await unwrap(commands.setTopic(networkId, channel, topic));
}

/** 设置或清除离开状态。 */
export async function setAway(networkId: string, message: string | null): Promise<void> {
  await unwrap(commands.setAway(networkId, message));
}

/** 邀请某人加入频道。 */
export async function inviteUser(networkId: string, nick: string, channel: string): Promise<void> {
  await unwrap(commands.inviteUser(networkId, nick, channel));
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

/**
 * 用系统默认浏览器打开一个链接。
 *
 * 后端会先做协议白名单校验；`file://` 与 `javascript:` 这类链接来自不可信
 * 消息，绝不能交给系统打开器。
 */
export async function openExternal(url: string): Promise<void> {
  await unwrap(commands.openExternal(url));
}

/** 向服务器查询某个昵称。 */
export async function whois(networkId: string, nick: string): Promise<void> {
  await unwrap(commands.whois(networkId, nick));
}

/**
 * 设置频道 / 用户模式，例如 `MODE #rust +o alice`。
 *
 * 这是模式操作的唯一出口：`op`、`voice`、`ban` 之间只差模式字母与参数，
 * 因此具体动作在前端拼装（见 `setMemberMode` / `banUser`），Rust 侧只保留
 * 这一条通用路径。
 */
export async function setMode(
  networkId: string,
  target: string,
  modes: string,
  args: string[],
): Promise<void> {
  await unwrap(commands.setMode(networkId, target, modes, args));
}

/** 把某人踢出频道。 */
export async function kickUser(
  networkId: string,
  channel: string,
  nick: string,
  reason: string | null,
): Promise<void> {
  await unwrap(commands.kickUser(networkId, channel, nick, reason));
}

/** 授予或撤销频道权限，例如 `+o` / `-v`。 */
export async function setMemberMode(
  networkId: string,
  channel: string,
  nick: string,
  mode: string,
  grant: boolean,
): Promise<void> {
  await setMode(networkId, channel, `${grant ? '+' : '-'}${mode}`, [nick]);
}

/**
 * 封禁某人（按昵称掩码）。
 *
 * 掩码只约束昵称，任意用户名与主机都命中。更紧的封禁需要用户的 host，
 * 那要一次 WHOIS 往返——留到以后，不在这里猜。
 */
export async function banUser(networkId: string, channel: string, nick: string): Promise<void> {
  await setMode(networkId, channel, '+b', [`${nick}!*@*`]);
}

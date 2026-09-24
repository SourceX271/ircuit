import { create } from 'zustand';

import {
  PLACEHOLDER_MEMBERS,
  PLACEHOLDER_MESSAGES,
  PLACEHOLDER_NETWORKS,
  PLACEHOLDER_TOPIC,
  type PlaceholderBuffer,
  type PlaceholderMember,
  type PlaceholderMessage,
  type PlaceholderNetwork,
} from '@/data/placeholder';

/**
 * 会话界面状态。
 *
 * M0 用占位数据初始化；M1 起这些字段改由 Rust 核心通过 IPC 事件推送填充，
 * 组件不必改动 —— 这正是把数据访问收敛到 store 的目的。
 */
export interface ShellState {
  networks: PlaceholderNetwork[];
  activeBufferId: string;
  topic: string;
  members: PlaceholderMember[];
  messages: PlaceholderMessage[];
  selectBuffer: (bufferId: string) => void;
}

/** 是否已连接到任何网络。M0 恒为 false。 */
export const DEFAULT_BUFFER_ID = 'libera:#ircuit';

export const useShellStore = create<ShellState>((set) => ({
  networks: PLACEHOLDER_NETWORKS,
  activeBufferId: DEFAULT_BUFFER_ID,
  topic: PLACEHOLDER_TOPIC,
  members: PLACEHOLDER_MEMBERS,
  messages: PLACEHOLDER_MESSAGES,

  selectBuffer: (bufferId) => set({ activeBufferId: bufferId }),
}));

export interface ActiveBuffer {
  network: PlaceholderNetwork | undefined;
  buffer: PlaceholderBuffer | undefined;
}

/** 在扁平化的网络列表中定位当前 buffer。 */
export function resolveActiveBuffer(
  networks: readonly PlaceholderNetwork[],
  activeBufferId: string,
): ActiveBuffer {
  for (const network of networks) {
    const buffer = network.buffers.find((candidate) => candidate.id === activeBufferId);
    if (buffer) return { network, buffer };
  }

  return { network: undefined, buffer: undefined };
}

/**
 * 简体中文文案。这是**基准语言**：其余语言必须完整实现同一份结构，
 * 缺键会在 `tsc` 阶段直接报错，不会留到运行时才发现。
 */
export const zhCN = {
  app: {
    name: 'Ircuit',
    tagline: '现代 IRC 客户端',
  },

  shell: {
    milestone: 'M0 · 工程骨架',
    placeholderNotice: '当前为骨架界面：数据均为占位示例，M2 起接入真实会话。',
  },

  a11y: {
    skipToContent: '跳到主内容',
  },

  sidebar: {
    networks: '网络',
    channels: '频道',
    direct: '私聊',
    addNetwork: '添加网络',
    bufferActions: '会话操作',
  },

  topic: {
    label: '频道主题',
    noTopic: '（无主题）',
  },

  members: {
    title: '成员',
    count: '{{count}} 人',
    owner: '所有者',
    admin: '管理员',
    op: '管理员',
    voice: '语音',
    away: '离开',
  },

  composer: {
    placeholder: '发送消息…（Enter 发送，Shift + Enter 换行）',
    offlinePlaceholder: '尚未连接任何网络',
    send: '发送',
    format: '格式',
    emoji: '表情',
    attach: '附件',
  },

  status: {
    ipc: 'IPC',
    events: '事件通道',
    uptime: '运行时长',
    modules: '核心模块',
    platform: '平台',
    ok: '正常',
    waiting: '等待中',
    down: '中断',
  },

  theme: {
    label: '外观',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
  },

  language: {
    label: '语言',
  },

  arch: {
    title: '核心模块',
    subtitle: '工作区已就绪，按里程碑逐个落地',
    planned: '计划',
  },

  selfCheck: {
    title: 'M0 自检',
    appInfo: '应用信息',
    version: '版本',
    tauri: 'Tauri',
    build: '构建',
    buildDebug: '调试',
    buildRelease: '发布',
    roundtrip: 'IPC 往返',
    latency: '最近耗时',
    heartbeat: '事件心跳',
    notYet: '尚未收到',
    measured: '{{value}} ms 前测量',
  },
};

/** 所有语言都必须满足的结构。 */
export type TranslationSchema = typeof zhCN;

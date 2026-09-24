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
    milestone: 'M1 · 协议内核',
  },

  a11y: {
    skipToContent: '跳到主内容',
  },

  sidebar: {
    networks: '网络',
    server: '服务器',
    addNetwork: '添加网络',
    bufferActions: '会话操作',
    disconnect: '断开',
  },

  network: {
    title: '添加网络',
    host: '服务器地址',
    hostPlaceholder: 'irc.libera.chat',
    port: '端口',
    portPlaceholder: '留空使用默认端口',
    tls: '使用 TLS',
    nick: '昵称',
    realname: '真实名称',
    realnamePlaceholder: '留空则与昵称相同',
    saslAccount: 'SASL 账号',
    saslPassword: 'SASL 密码',
    saslHint: '账号与密码都填写才启用 SASL（PLAIN）',
    connect: '连接',
    cancel: '取消',
    state: {
      connecting: '连接中',
      connected: '握手中',
      registered: '已就绪',
      disconnected: '已断开',
    },
    attempt: '第 {{count}} 次尝试',
    capabilities: '已协商能力',
  },

  empty: {
    title: '还没有连接任何网络',
    hint: '点击左侧的 + 添加一个网络开始。',
  },

  topic: {
    label: '频道主题',
    noTopic: '（无主题）',
    serverBuffer: '原始协议流量',
    channelHint: '输入 /join #频道 加入频道',
  },

  members: {
    title: '成员',
    count: '{{count}} 人',
    unavailable: 'M2 起提供成员列表',
  },

  composer: {
    placeholder: '发送消息…（Enter 发送，Shift + Enter 换行）',
    offlinePlaceholder: '尚未连接任何网络',
    send: '发送',
    format: '格式',
    emoji: '表情',
    attach: '附件',
    commandHint: '可用命令：/join /msg /me /raw',
    unknownCommand: '未知命令：/{{command}}',
    actionNeedsTarget: '/me 需要在一个频道或私聊里使用',
  },

  status: {
    ipc: 'IPC',
    events: '事件通道',
    uptime: '运行时长',
    modules: '核心模块',
    platform: '平台',
    networks: '网络',
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
    title: '诊断',
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

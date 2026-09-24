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
    milestone: 'M2 · 会话 UI',
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
    modes: '频道模式',
  },

  members: {
    title: '成员',
    count: '{{count}} 人',
    loading: '正在获取成员列表…',
    notAChannel: '这里没有成员列表',
    away: '离开',
    identified: '已登录服务',
    prefix: {
      owner: '所有者',
      admin: '管理员',
      halfop: '半权限',
      op: '操作员',
      voice: '语音',
    },
    actions: {
      whois: '查询信息（WHOIS）',
      query: '私聊',
      op: '设为操作员（+o）',
      deop: '取消操作员（-o）',
      voice: '授予语音（+v）',
      devoice: '取消语音（-v）',
      kick: '踢出频道',
      ban: '封禁',
      ignore: '忽略此人',
      unignore: '取消忽略',
    },
  },

  composer: {
    placeholder: '发送消息…（Enter 发送，Shift + Enter 换行）',
    placeholderMultiline: '发送消息…（Ctrl + Enter 发送）',
    offlinePlaceholder: '尚未连接任何网络',
    send: '发送',
    format: '格式',
    emoji: '表情',
    attach: '附件',
    suggestions: '匹配的命令',
    commandHint: 'Tab 补全 · ↑ 历史 · /help 查看全部命令',
    ignoredCount: '已忽略 {{count}} 人',
    unknownCommand: '未知命令：/{{command}}',
    actionNeedsTarget: '/me 需要在一个频道或私聊里使用',

    errors: {
      needsChannel: '该命令需要在一个频道里使用',
    },

    ignore: {
      applied: '已忽略 {{nick}}',
      removed: '已取消忽略 {{nick}}',
    },

    set: {
      applied: '已设置 {{option}}',
      usage: '/set sendOnEnter <on|off>',
      unknownOption: '未知选项：{{option}}',
    },

    help: {
      all: '全部命令：{{commands}}',
      usage: '{{usage}} — {{description}}',
      unknown: '未知命令：/{{command}}',
    },

    commands: {
      me: '发送一个动作',
      msg: '打开私聊或发送私信',
      notice: '发送 NOTICE（按惯例不触发自动回复）',
      join: '加入频道',
      part: '离开频道',
      topic: '查看、设置或清除频道主题',
      nick: '修改昵称',
      away: '设置或清除离开状态',
      mode: '设置频道或用户模式',
      op: '授予管理员权限',
      deop: '撤销管理员权限',
      voice: '授予发言权限',
      devoice: '撤销发言权限',
      ban: '封禁某个昵称',
      unban: '解除封禁',
      kick: '把某人踢出频道',
      invite: '邀请某人加入频道',
      whois: '查询某个昵称',
      ignore: '不再显示某人的发言',
      unignore: '恢复显示某人的发言',
      ctcp: '发送 CTCP 请求',
      raw: '发送一条原始协议行',
      clear: '清空当前缓冲区',
      close: '关闭当前缓冲区',
      quit: '断开网络连接',
      set: '修改客户端选项',
      help: '查看命令帮助',
    },
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

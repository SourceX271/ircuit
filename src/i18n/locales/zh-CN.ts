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
    hideSidebar: '收起网络栏',
    showSidebar: '展开网络栏',
    hideMembers: '收起成员栏',
    showMembers: '展开成员栏',
  },

  palette: {
    title: '命令面板',
    placeholder: '输入命令、频道或动作…',
    empty: '没有匹配项',
    groups: {
      buffers: '会话',
      actions: '操作',
      commands: '命令',
    },
    actions: {
      focusComposer: '跳到输入框',
      showSidebar: '展开网络栏',
      hideSidebar: '收起网络栏',
      showMembers: '展开成员栏',
      hideMembers: '收起成员栏',
      cycleTheme: '切换到{{theme}}外观',
      switchLanguage: '切换语言为{{language}}',
      connect: '添加网络…',
      closeBuffer: '关闭当前会话',
      clearBuffer: '清空当前会话记录',
      disconnect: '断开 {{network}}',
      nextHighlight: '跳到下一个高亮会话',
      nextHighlightCount: '共 {{count}} 个',
      clearNotifications: '清除全部高亮提醒',
    },
  },

  shortcuts: {
    paletteOpen: '命令面板',
    toggleSidebar: '展开 / 收起网络栏',
    toggleMembers: '展开 / 收起成员栏',
    nextBuffer: '下一个会话',
    previousBuffer: '上一个会话',
    jumpToBuffer: '跳到第 1–9 个会话',
    closeBuffer: '关闭当前会话',
  },

  notifications: {
    title: '高亮提醒',
    dismiss: '关闭提醒',
    clear: '全部清除',
    moreAndClear: '还有 {{count}} 条 · 全部清除',
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
    collapseNetwork: '折叠 {{network}}',
    expandNetwork: '展开 {{network}}',
  },

  tabs: {
    label: '打开的会话',
    close: '关闭 {{name}}',
    unread: '{{count}} 条未读',
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

    highlight: {
      added: '已高亮「{{word}}」',
      removed: '已取消高亮「{{word}}」',
      none: '还没有高亮词，用 /highlight <词> 添加',
      list: '高亮词：{{words}}',
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
      highlight: '添加一个高亮词（可选 --case / --substring）',
      unhighlight: '移除一个高亮词',
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

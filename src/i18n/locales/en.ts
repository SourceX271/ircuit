import type { TranslationSchema } from './zh-CN';

/** English copy. Typed against the Chinese baseline so no key can go missing. */
export const en: TranslationSchema = {
  app: {
    name: 'Ircuit',
    tagline: 'A modern IRC client',
  },

  shell: {
    milestone: 'M1 · Protocol core',
  },

  a11y: {
    skipToContent: 'Skip to main content',
  },

  sidebar: {
    networks: 'Networks',
    server: 'Server',
    addNetwork: 'Add network',
    bufferActions: 'Buffer actions',
    disconnect: 'Disconnect',
  },

  network: {
    title: 'Add a network',
    host: 'Server address',
    hostPlaceholder: 'irc.libera.chat',
    port: 'Port',
    portPlaceholder: 'Leave blank for the default port',
    tls: 'Use TLS',
    nick: 'Nickname',
    realname: 'Real name',
    realnamePlaceholder: 'Defaults to the nickname',
    saslAccount: 'SASL account',
    saslPassword: 'SASL password',
    saslHint: 'SASL (PLAIN) is enabled only when both fields are filled in',
    connect: 'Connect',
    cancel: 'Cancel',
    state: {
      connecting: 'Connecting',
      connected: 'Handshaking',
      registered: 'Ready',
      disconnected: 'Disconnected',
    },
    attempt: 'Attempt {{count}}',
    capabilities: 'Negotiated capabilities',
  },

  empty: {
    title: 'Not connected to any network',
    hint: 'Use the + button on the left to add one.',
  },

  topic: {
    label: 'Channel topic',
    noTopic: '(no topic set)',
    serverBuffer: 'Raw protocol traffic',
    channelHint: 'Type /join #channel to join a channel',
  },

  members: {
    title: 'Members',
    count: '{{count}} members',
    unavailable: 'The member list arrives in M2',
  },

  composer: {
    placeholder: 'Send a message… (Enter to send, Shift + Enter for a new line)',
    offlinePlaceholder: 'Not connected to any network',
    send: 'Send',
    format: 'Formatting',
    emoji: 'Emoji',
    attach: 'Attach',
    commandHint: 'Commands: /join /msg /me /raw',
    unknownCommand: 'Unknown command: /{{command}}',
    actionNeedsTarget: '/me needs a channel or a conversation',
  },

  status: {
    ipc: 'IPC',
    events: 'Event stream',
    uptime: 'Uptime',
    modules: 'Core modules',
    platform: 'Platform',
    networks: 'Networks',
    ok: 'online',
    waiting: 'waiting',
    down: 'down',
  },

  theme: {
    label: 'Appearance',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
  },

  language: {
    label: 'Language',
  },

  arch: {
    title: 'Core modules',
    subtitle: 'Workspace is in place; modules land milestone by milestone',
    planned: 'Planned',
  },

  selfCheck: {
    title: 'Diagnostics',
    appInfo: 'App info',
    version: 'Version',
    tauri: 'Tauri',
    build: 'Build',
    buildDebug: 'Debug',
    buildRelease: 'Release',
    roundtrip: 'IPC round-trip',
    latency: 'Last latency',
    heartbeat: 'Event heartbeat',
    notYet: 'not received yet',
    measured: 'measured {{value}} ms ago',
  },
};

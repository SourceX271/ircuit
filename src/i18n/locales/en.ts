import type { TranslationSchema } from './zh-CN';

/** English copy. Typed against the Chinese baseline so no key can go missing. */
export const en: TranslationSchema = {
  app: {
    name: 'Ircuit',
    tagline: 'A modern IRC client',
  },

  shell: {
    milestone: 'M0 · Skeleton',
    placeholderNotice:
      'Skeleton build: all content below is placeholder data. Real sessions arrive in M2.',
  },

  a11y: {
    skipToContent: 'Skip to main content',
  },

  sidebar: {
    networks: 'Networks',
    channels: 'Channels',
    direct: 'Direct messages',
    addNetwork: 'Add network',
    bufferActions: 'Buffer actions',
  },

  topic: {
    label: 'Channel topic',
    noTopic: '(no topic set)',
  },

  members: {
    title: 'Members',
    count: '{{count}} members',
    owner: 'Owner',
    admin: 'Admin',
    op: 'Operator',
    voice: 'Voice',
    away: 'Away',
  },

  composer: {
    placeholder: 'Send a message… (Enter to send, Shift + Enter for a new line)',
    offlinePlaceholder: 'Not connected to any network',
    send: 'Send',
    format: 'Formatting',
    emoji: 'Emoji',
    attach: 'Attach',
  },

  status: {
    ipc: 'IPC',
    events: 'Event stream',
    uptime: 'Uptime',
    modules: 'Core modules',
    platform: 'Platform',
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
    title: 'M0 self-check',
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

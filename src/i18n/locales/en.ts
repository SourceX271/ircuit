import type { TranslationSchema } from './zh-CN';

/** English copy. Typed against the Chinese baseline so no key can go missing. */
export const en: TranslationSchema = {
  app: {
    name: 'Ircuit',
    tagline: 'A modern IRC client',
  },

  shell: {
    milestone: 'M2 · Session UI',
    hideSidebar: 'Collapse the network list',
    showSidebar: 'Expand the network list',
    hideMembers: 'Collapse the member list',
    showMembers: 'Expand the member list',
  },

  palette: {
    title: 'Command palette',
    placeholder: 'Type a command, buffer or action…',
    empty: 'Nothing matches',
    groups: {
      buffers: 'Buffers',
      actions: 'Actions',
      commands: 'Commands',
    },
    actions: {
      focusComposer: 'Focus the input',
      showSidebar: 'Show the network list',
      hideSidebar: 'Hide the network list',
      showMembers: 'Show the member list',
      hideMembers: 'Hide the member list',
      cycleTheme: 'Switch to the {{theme}} theme',
      switchLanguage: 'Switch the language to {{language}}',
      connect: 'Add a network…',
      closeBuffer: 'Close this buffer',
      clearBuffer: 'Clear this buffer',
      disconnect: 'Disconnect {{network}}',
    },
  },

  shortcuts: {
    paletteOpen: 'Command palette',
    toggleSidebar: 'Show or hide the network list',
    toggleMembers: 'Show or hide the member list',
    nextBuffer: 'Next buffer',
    previousBuffer: 'Previous buffer',
    jumpToBuffer: 'Jump to buffer 1–9',
    closeBuffer: 'Close this buffer',
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
    modes: 'Channel modes',
  },

  members: {
    title: 'Members',
    count: '{{count}} members',
    loading: 'Fetching the member list…',
    notAChannel: 'No member list here',
    away: 'Away',
    identified: 'Identified to services',
    prefix: {
      owner: 'Owner',
      admin: 'Admin',
      halfop: 'Half-op',
      op: 'Operator',
      voice: 'Voice',
    },
    actions: {
      whois: 'Whois',
      query: 'Open a conversation',
      op: 'Give operator (+o)',
      deop: 'Remove operator (-o)',
      voice: 'Give voice (+v)',
      devoice: 'Remove voice (-v)',
      kick: 'Kick from channel',
      ban: 'Ban',
      ignore: 'Ignore',
      unignore: 'Stop ignoring',
    },
  },

  composer: {
    placeholder: 'Send a message… (Enter to send, Shift + Enter for a new line)',
    placeholderMultiline: 'Send a message… (Ctrl + Enter to send)',
    offlinePlaceholder: 'Not connected to any network',
    send: 'Send',
    format: 'Formatting',
    emoji: 'Emoji',
    attach: 'Attach',
    suggestions: 'Matching commands',
    commandHint: 'Tab completes · ↑ history · /help for commands',
    ignoredCount: '{{count}} ignored',
    unknownCommand: 'Unknown command: /{{command}}',
    actionNeedsTarget: '/me needs a channel or a conversation',

    errors: {
      needsChannel: 'This command needs a channel',
    },

    ignore: {
      applied: 'Ignoring {{nick}}',
      removed: 'No longer ignoring {{nick}}',
    },

    set: {
      applied: 'Set {{option}}',
      usage: '/set sendOnEnter <on|off>',
      unknownOption: 'Unknown option: {{option}}',
    },

    help: {
      all: 'Commands: {{commands}}',
      usage: '{{usage}} — {{description}}',
      unknown: 'Unknown command: /{{command}}',
    },

    commands: {
      me: 'Send an action',
      msg: 'Open a conversation or send privately',
      notice: 'Send a notice (never triggers a reply)',
      join: 'Join a channel',
      part: 'Leave a channel',
      topic: 'Show, set or clear the channel topic',
      nick: 'Change your nickname',
      away: 'Set or clear your away message',
      mode: 'Set channel or user modes',
      op: 'Give channel operator status',
      deop: 'Remove channel operator status',
      voice: 'Give voice',
      devoice: 'Remove voice',
      ban: 'Ban a nickname',
      unban: 'Lift a ban',
      kick: 'Remove someone from the channel',
      invite: 'Invite someone to a channel',
      whois: 'Look up a nickname',
      ignore: 'Hide everything someone says',
      unignore: 'Stop hiding someone',
      ctcp: 'Send a CTCP request',
      raw: 'Send a raw protocol line',
      clear: 'Clear this buffer',
      close: 'Close this buffer',
      quit: 'Disconnect from the network',
      set: 'Change a client option',
      help: 'Show command help',
    },
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

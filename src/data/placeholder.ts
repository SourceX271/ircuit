/**
 * M0 占位数据。
 *
 * 骨架阶段还没有真实连接，但界面需要内容才能把视觉语言定下来。
 * 这些数据不在任何业务路径上，M1 接入真实网络后本文件整体删除。
 */

export type BufferKind = 'server' | 'channel' | 'query';

export interface PlaceholderBuffer {
  id: string;
  kind: BufferKind;
  name: string;
  /** 未读条数，0 表示已读完。 */
  unread: number;
  /** 是否包含提到自己的消息。 */
  highlight: boolean;
}

export interface PlaceholderNetwork {
  id: string;
  name: string;
  connected: boolean;
  buffers: PlaceholderBuffer[];
}

export type MessageKind = 'message' | 'action' | 'notice' | 'system';

export interface PlaceholderMessage {
  id: string;
  kind: MessageKind;
  nick: string;
  /** 昵称配色下标，对应 CSS 变量 `--ir-nick-*`。 */
  nickColor: number;
  time: string;
  body: string;
  /** 是否提到当前用户。 */
  highlight?: boolean;
  /** 是否是自己发出的消息。 */
  self?: boolean;
}

export const PLACEHOLDER_SELF_NICK = 'circuit';

export const PLACEHOLDER_NETWORKS: PlaceholderNetwork[] = [
  {
    id: 'libera',
    name: 'Libera.Chat',
    connected: true,
    buffers: [
      { id: 'libera:server', kind: 'server', name: 'irc.libera.chat', unread: 0, highlight: false },
      { id: 'libera:#ircuit', kind: 'channel', name: '#ircuit', unread: 3, highlight: true },
      { id: 'libera:#rust', kind: 'channel', name: '#rust', unread: 12, highlight: false },
      { id: 'libera:alice', kind: 'query', name: 'alice', unread: 1, highlight: false },
    ],
  },
  {
    id: 'oftc',
    name: 'OFTC',
    connected: false,
    buffers: [
      { id: 'oftc:server', kind: 'server', name: 'irc.oftc.net', unread: 0, highlight: false },
      { id: 'oftc:#debian', kind: 'channel', name: '#debian', unread: 0, highlight: false },
    ],
  },
];

export const PLACEHOLDER_TOPIC = 'Ircuit 开发讨论 · 现代跨平台 IRC 客户端 · 需求与里程碑见 docs/';

export const PLACEHOLDER_MESSAGES: PlaceholderMessage[] = [
  {
    id: 'm1',
    kind: 'system',
    nick: '',
    nickColor: 0,
    time: '14:02',
    body: 'circuit 加入了 #ircuit',
  },
  {
    id: 'm2',
    kind: 'message',
    nick: 'alice',
    nickColor: 1,
    time: '14:03',
    body: '新的骨架跑起来了，三栏布局和主题切换都通了。',
  },
  {
    id: 'm3',
    kind: 'message',
    nick: 'bob',
    nickColor: 2,
    time: '14:04',
    body: '深色主题的对比度看着很舒服，消息流终于是主角了。',
  },
  {
    id: 'm4',
    kind: 'action',
    nick: 'carol',
    nickColor: 3,
    time: '14:05',
    body: '正在翻 docs/实施计划.md',
  },
  {
    id: 'm5',
    kind: 'message',
    nick: 'dave',
    nickColor: 4,
    time: '14:07',
    body: 'circuit: 编码那块建议默认 UTF-8 加自动检测，老中文服务器还能兜住。',
    highlight: true,
  },
  {
    id: 'm6',
    kind: 'message',
    nick: 'circuit',
    nickColor: 0,
    time: '14:08',
    body: '同意，手动设置优先级高于检测结果，检测错了要能一键改回来。',
    self: true,
  },
  {
    id: 'm7',
    kind: 'notice',
    nick: 'NickServ',
    nickColor: 5,
    time: '14:09',
    body: 'You are now identified for circuit.',
  },
  {
    id: 'm8',
    kind: 'message',
    nick: 'erin',
    nickColor: 6,
    time: '14:11',
    body: 'DCC 在 NAT 后面容易不通，界面上最好别把它说成万能的。',
  },
  {
    id: 'm9',
    kind: 'message',
    nick: 'bob',
    nickColor: 2,
    time: '14:12',
    body: '所以配了图床兜底，粘贴截图直接出链接，这个体验最接近现代 IM。',
  },
];

export interface PlaceholderMember {
  nick: string;
  /** 频道前缀：`~` 所有者、`&` 管理员、`@` 操作员、`+` 语音。 */
  prefix: '' | '~' | '&' | '@' | '+';
  away: boolean;
}

export const PLACEHOLDER_MEMBERS: PlaceholderMember[] = [
  { nick: 'alice', prefix: '~', away: false },
  { nick: 'bob', prefix: '@', away: false },
  { nick: 'carol', prefix: '@', away: false },
  { nick: 'dave', prefix: '+', away: true },
  { nick: 'erin', prefix: '', away: false },
  { nick: 'frank', prefix: '', away: false },
  { nick: 'grace', prefix: '', away: true },
  { nick: 'heidi', prefix: '', away: false },
  { nick: 'ivan', prefix: '', away: false },
  { nick: 'judy', prefix: '', away: false },
  { nick: 'mallory', prefix: '', away: true },
  { nick: 'circuit', prefix: '', away: false },
];

/**
 * The tiny command language a chat box needs.
 *
 * Kept separate from the component so it can be tested directly — input parsing
 * is exactly the kind of thing that looks fine and then mangles a message with a
 * slash in it.
 *
 * Commands are described once, as a table of metadata plus a parse function, so
 * the parser, the Tab-completion candidate list and the `/help` output can never
 * disagree about which commands exist. A hand-maintained `switch` next to a
 * hand-maintained help string drifts apart the first time someone adds a verb.
 */

/** CTCP framing used to express `/me`. */
export const ACTION_WRAPPER = '\u{0001}ACTION ';

/** Closes a CTCP sequence. */
export const CTCP_END = '\u{0001}';

/** What the user is looking at, so commands can omit an obvious target. */
export interface ComposerContext {
  /** Active buffer target: a channel name, a nick, or `''` for the server buffer. */
  target: string;
  /** Whether the active buffer is a channel, which is what enables `/topic` etc. */
  isChannel: boolean;
}

/** Everything the user's input can mean. */
export type ComposerAction =
  | { kind: 'message'; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'notice'; target: string; text: string }
  | { kind: 'join'; channel: string; key: string | null }
  | { kind: 'part'; channel: string; reason: string | null }
  | { kind: 'msg'; target: string; text: string }
  | { kind: 'nick'; nick: string }
  | { kind: 'topic'; channel: string; topic: string | null }
  | { kind: 'away'; message: string | null }
  | { kind: 'mode'; target: string; modes: string; args: string[] }
  | { kind: 'kick'; channel: string; nick: string; reason: string | null }
  | { kind: 'invite'; nick: string; channel: string }
  | { kind: 'whois'; nick: string }
  | { kind: 'raw'; line: string }
  | { kind: 'ignore'; nick: string; on: boolean }
  | { kind: 'clear' }
  | { kind: 'close' }
  | { kind: 'quit'; reason: string | null }
  | { kind: 'set'; key: string; value: string }
  | { kind: 'help'; command: string | null }
  /** Add or remove a keyword that should be highlighted. */
  | {
      kind: 'highlight';
      pattern: string;
      on: boolean;
      caseSensitive: boolean;
      wholeWord: boolean;
    }
  /** Report the current highlight rules. */
  | { kind: 'highlightList' }
  /** Understood but unusable here, e.g. `/topic` outside a channel. */
  | { kind: 'error'; key: string }
  | { kind: 'unknown'; command: string };

/** One command, described once. */
export interface CommandSpec {
  /** Primary name, without the slash. */
  name: string;
  /** Accepted spellings. */
  aliases: readonly string[];
  /** Argument sketch, shown after the name in help and completion. */
  usage: string;
  /** i18n key under `composer.commands` describing what it does. */
  descriptionKey: string;
  parse: (args: string, ctx: ComposerContext) => ComposerAction | null;
}

/** Split into whitespace-separated tokens, dropping empties. */
function tokens(input: string): string[] {
  return input.split(/\s+/).filter((token) => token !== '');
}

/**
 * Peel off the first token, keeping the remainder verbatim.
 *
 * The remainder is what makes `/msg alice  two  spaces` and multi-line `/me`
 * bodies survive intact; re-joining tokens would collapse the spacing.
 */
function takeFirst(input: string): { head: string; tail: string } {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(input.trim());
  if (!match) return { head: '', tail: '' };
  return { head: match[1] ?? '', tail: match[2] ?? '' };
}

/** Add the channel prefix when the user typed a bare name. */
function asChannel(name: string): string {
  return /^[#&]/.test(name) ? name : `#${name}`;
}

/** Whether a token can only be a channel name. */
function looksLikeChannel(token: string): boolean {
  return token.startsWith('#') || token.startsWith('&');
}

/**
 * Build a channel-relative action.
 *
 * Commands like `/kick` and `/topic` address the channel you are looking at, so
 * the target is not something the user should have to repeat. Outside a channel
 * there is no sensible default, and guessing one would aim the command at
 * whatever happened to be in the buffer.
 */
function inChannel(
  ctx: ComposerContext,
  build: (channel: string) => ComposerAction,
): ComposerAction {
  if (!ctx.isChannel || ctx.target === '') return { kind: 'error', key: 'needsChannel' };
  return build(ctx.target);
}

/** `/op`, `/voice`, `/ban` and friends differ only in this. */
function modeCommand(
  mode: string,
  grant: boolean,
  mask: boolean,
): (args: string, ctx: ComposerContext) => ComposerAction | null {
  return (args, ctx) => {
    const [nick] = tokens(args);
    if (!nick) return null;

    const param = mask ? `${nick}!*@*` : nick;
    return inChannel(ctx, (channel) => ({
      kind: 'mode',
      target: channel,
      modes: `${grant ? '+' : '-'}${mode}`,
      args: [param],
    }));
  };
}

/** Assembled once so the parser, completion and `/help` cannot disagree. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'me',
    aliases: ['action'],
    usage: '<action>',
    descriptionKey: 'me',
    parse: (args) => (args === '' ? null : { kind: 'action', text: args }),
  },
  {
    name: 'msg',
    aliases: ['query'],
    usage: '<target> [text]',
    descriptionKey: 'msg',
    parse: (args) => {
      const { head, tail } = takeFirst(args);
      if (head === '') return null;
      // No body means "open the conversation", which is what `/query` implies.
      return { kind: 'msg', target: head, text: tail };
    },
  },
  {
    name: 'notice',
    aliases: [],
    usage: '<target> <text>',
    descriptionKey: 'notice',
    parse: (args) => {
      const { head, tail } = takeFirst(args);
      if (head === '' || tail === '') return null;
      return { kind: 'notice', target: head, text: tail };
    },
  },
  {
    name: 'join',
    aliases: ['j'],
    usage: '<channel> [key]',
    descriptionKey: 'join',
    parse: (args) => {
      const [channel, key] = tokens(args);
      if (!channel) return null;
      return { kind: 'join', channel: asChannel(channel), key: key ?? null };
    },
  },
  {
    name: 'part',
    aliases: ['leave'],
    usage: '[channel] [reason]',
    descriptionKey: 'part',
    parse: (args, ctx) => {
      const { head, tail } = takeFirst(args);

      // An explicit channel is only recognised when it looks like one, so
      // `/part bye everyone` reads as "leave here, saying bye everyone".
      if (looksLikeChannel(head)) {
        return { kind: 'part', channel: head, reason: tail === '' ? null : tail };
      }

      return inChannel(ctx, (channel) => ({
        kind: 'part',
        channel,
        reason: args === '' ? null : args,
      }));
    },
  },
  {
    name: 'topic',
    aliases: [],
    usage: '[text]',
    descriptionKey: 'topic',
    parse: (args, ctx) =>
      // Bare `/topic` asks the server; `/topic ` + text clears it when the text
      // is empty, which is why `null` and `''` stay distinguishable.
      inChannel(ctx, (channel) => ({ kind: 'topic', channel, topic: args === '' ? null : args })),
  },
  {
    name: 'nick',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'nick',
    parse: (args) => {
      const [nick] = tokens(args);
      return nick ? { kind: 'nick', nick } : null;
    },
  },
  {
    name: 'away',
    aliases: ['back'],
    usage: '[message]',
    descriptionKey: 'away',
    parse: (args) => ({ kind: 'away', message: args === '' ? null : args }),
  },
  {
    name: 'mode',
    aliases: [],
    usage: '<target> <modes> [args…]',
    descriptionKey: 'mode',
    parse: (args) => {
      const parsed = tokens(args);
      const [target, modes, ...rest] = parsed;
      if (!target || !modes) return null;
      return { kind: 'mode', target, modes, args: rest };
    },
  },
  {
    name: 'op',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'op',
    parse: modeCommand('o', true, false),
  },
  {
    name: 'deop',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'deop',
    parse: modeCommand('o', false, false),
  },
  {
    name: 'voice',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'voice',
    parse: modeCommand('v', true, false),
  },
  {
    name: 'devoice',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'devoice',
    parse: modeCommand('v', false, false),
  },
  {
    name: 'ban',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'ban',
    parse: modeCommand('b', true, true),
  },
  {
    name: 'unban',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'unban',
    parse: modeCommand('b', false, true),
  },
  {
    name: 'kick',
    aliases: [],
    usage: '<nick> [reason]',
    descriptionKey: 'kick',
    parse: (args, ctx) => {
      const { head, tail } = takeFirst(args);
      if (head === '') return null;
      return inChannel(ctx, (channel) => ({
        kind: 'kick',
        channel,
        nick: head,
        reason: tail === '' ? null : tail,
      }));
    },
  },
  {
    name: 'invite',
    aliases: [],
    usage: '<nick> [channel]',
    descriptionKey: 'invite',
    parse: (args, ctx) => {
      const [nick, channel] = tokens(args);
      if (!nick) return null;
      // An explicit channel wins; otherwise invite to the one we are in.
      if (channel) return { kind: 'invite', nick, channel: asChannel(channel) };
      return inChannel(ctx, (current) => ({ kind: 'invite', nick, channel: current }));
    },
  },
  {
    name: 'whois',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'whois',
    parse: (args) => {
      const [nick] = tokens(args);
      return nick ? { kind: 'whois', nick } : null;
    },
  },
  {
    name: 'ignore',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'ignore',
    parse: (args) => {
      const [nick] = tokens(args);
      return nick ? { kind: 'ignore', nick, on: true } : null;
    },
  },
  {
    name: 'unignore',
    aliases: [],
    usage: '<nick>',
    descriptionKey: 'unignore',
    parse: (args) => {
      const [nick] = tokens(args);
      return nick ? { kind: 'ignore', nick, on: false } : null;
    },
  },
  {
    name: 'ctcp',
    aliases: [],
    usage: '<target> <verb> [args…]',
    descriptionKey: 'ctcp',
    parse: (args) => {
      const { head, tail } = takeFirst(args);
      if (head === '' || tail === '') return null;

      // Only the verb is folded: CTCP verbs are uppercase by convention, but
      // the arguments after one (a DCC filename, say) are case-sensitive.
      const { head: verb, tail: rest } = takeFirst(tail);
      const payload = rest === '' ? verb.toUpperCase() : `${verb.toUpperCase()} ${rest}`;

      return { kind: 'raw', line: `PRIVMSG ${head} :${CTCP_END}${payload}${CTCP_END}` };
    },
  },
  {
    name: 'highlight',
    aliases: ['hilight'],
    usage: '[--case] [--substring] [word]',
    descriptionKey: 'highlight',
    parse: (args) => {
      const parts = tokens(args);
      // Flags are stripped before joining, so a phrase like `rust release`
      // stays one pattern.
      const flags = parts.filter((part) => part.startsWith('--'));
      const words = parts.filter((part) => !part.startsWith('--'));

      if (words.length === 0) return { kind: 'highlightList' };

      return {
        kind: 'highlight',
        pattern: words.join(' '),
        on: true,
        caseSensitive: flags.includes('--case'),
        wholeWord: !flags.includes('--substring'),
      };
    },
  },
  {
    name: 'unhighlight',
    aliases: ['unhilight'],
    usage: '<word>',
    descriptionKey: 'unhighlight',
    parse: (args) => {
      const pattern = tokens(args)
        .filter((part) => !part.startsWith('--'))
        .join(' ');

      if (pattern === '') return null;
      return { kind: 'highlight', pattern, on: false, caseSensitive: false, wholeWord: true };
    },
  },
  {
    name: 'raw',
    aliases: ['quote'],
    usage: '<line>',
    descriptionKey: 'raw',
    parse: (args) => (args === '' ? null : { kind: 'raw', line: args }),
  },
  {
    name: 'clear',
    aliases: [],
    usage: '',
    descriptionKey: 'clear',
    parse: () => ({ kind: 'clear' }),
  },
  {
    name: 'close',
    aliases: [],
    usage: '',
    descriptionKey: 'close',
    parse: () => ({ kind: 'close' }),
  },
  {
    name: 'quit',
    aliases: ['disconnect'],
    usage: '[reason]',
    descriptionKey: 'quit',
    parse: (args) => ({ kind: 'quit', reason: args === '' ? null : args }),
  },
  {
    name: 'set',
    aliases: [],
    usage: '<option> <value>',
    descriptionKey: 'set',
    parse: (args) => {
      const { head, tail } = takeFirst(args);
      return head === '' ? null : { kind: 'set', key: head, value: tail };
    },
  },
  {
    name: 'help',
    aliases: [],
    usage: '[command]',
    descriptionKey: 'help',
    parse: (args) => {
      const [command] = tokens(args);
      return { kind: 'help', command: command ?? null };
    },
  },
];

/**
 * Every accepted spelling, for Tab completion and the `/help` listing.
 *
 * Primary names come first, aliases after, so cycling prefers the canonical
 * spelling: typing `/qu` completes to `/quit` rather than to `/query`, which is
 * the alias of a different command.
 */
export const COMMAND_NAMES: readonly string[] = [
  ...COMMANDS.map((spec) => spec.name),
  ...COMMANDS.flatMap((spec) => spec.aliases),
];

/** Look up a command by any of its names. */
export function findCommand(name: string): CommandSpec | null {
  const folded = name.toLowerCase();
  return COMMANDS.find((spec) => spec.name === folded || spec.aliases.includes(folded)) ?? null;
}

/** Commands whose arguments name a channel, used to steer Tab completion. */
export const CHANNEL_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set([
  'join',
  'j',
  'part',
  'leave',
  'topic',
  'invite',
]);

/**
 * Interpret what the user typed.
 *
 * Returns `null` for input that should not be sent at all (blank), which lets
 * the caller use this as the single gate before touching the network.
 *
 * A line starting with `/` is a command only when the slash is followed by a
 * known word. Anything else is reported as an unknown command rather than sent:
 * a typo silently becoming a public message is worse than a complaint, and
 * `//text` is the escape hatch for text that really does start with a slash.
 */
export function parseComposerInput(input: string, ctx: ComposerContext): ComposerAction | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text: input.trimEnd() };
  }

  if (trimmed.startsWith('//')) {
    return { kind: 'message', text: trimmed.slice(1) };
  }

  const { head, tail } = takeFirst(trimmed.slice(1));
  const spec = findCommand(head);

  if (!spec) return { kind: 'unknown', command: head.toLowerCase() };

  return spec.parse(tail, ctx);
}

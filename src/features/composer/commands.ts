/**
 * The tiny command language a chat box needs.
 *
 * Kept separate from the component so it can be tested directly — input parsing
 * is exactly the kind of thing that looks fine and then mangles a message with a
 * slash in it.
 */

export type ComposerAction =
  | { kind: 'message'; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'join'; channel: string }
  | { kind: 'msg'; target: string; text: string }
  | { kind: 'raw'; line: string }
  | { kind: 'unknown'; command: string };

/** CTCP framing used to express `/me`. */
export const ACTION_WRAPPER = '\u{0001}ACTION ';

/**
 * Interpret what the user typed.
 *
 * Returns `null` for input that should not be sent at all (blank), which lets
 * the caller use this as the single gate before touching the network.
 *
 * A line starting with `/` is only treated as a command when the slash is
 * followed by a known word; otherwise it is a message. People write things like
 * "and/or" and `/etc/passwd` at the start of a line, and silently swallowing
 * those would be worse than sending them.
 */
export function parseComposerInput(input: string): ComposerAction | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text: input.trimEnd() };
  }

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const command = (separator < 0 ? withoutSlash : withoutSlash.slice(0, separator)).toLowerCase();
  const rest = separator < 0 ? '' : withoutSlash.slice(separator + 1).trim();

  switch (command) {
    case 'me':
      return rest === '' ? null : { kind: 'action', text: rest };

    case 'join': {
      const channel = rest.split(/\s+/)[0] ?? '';
      if (channel === '') return null;
      // A bare name is a channel, matching what every other client does.
      return { kind: 'join', channel: channel.startsWith('#') ? channel : `#${channel}` };
    }

    case 'msg':
    case 'query': {
      const [target, ...remainder] = rest.split(/\s+/);
      if (!target) return null;
      return { kind: 'msg', target, text: remainder.join(' ') };
    }

    case 'raw':
    case 'quote':
      return rest === '' ? null : { kind: 'raw', line: rest };

    default:
      // Looks like a command but is not one we know: tell the user rather than
      // sending it, so a typo does not become a message.
      return { kind: 'unknown', command };
  }
}

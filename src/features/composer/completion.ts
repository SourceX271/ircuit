/**
 * Tab completion for the composer.
 *
 * Pure functions over a plain string: no DOM, no React, no caret juggling
 * through refs. The composer owns exactly one piece of state — the in-flight
 * [`CompletionSession`] — and everything else is derived, which is what makes
 * the interesting cases testable without a browser.
 *
 * The behaviour follows what IRC users already have in their fingers:
 *
 * * the first Tab extends as far as the candidates agree, later Tabs cycle;
 * * Shift+Tab cycles backwards;
 * * completing a nick as the first word of a line appends `: `, because
 *   addressing someone is the whole reason to complete a nick there;
 * * Tab is never destructive — when nothing matches, the text is left alone.
 */

import {
  CHANNEL_ARGUMENT_COMMANDS,
  COMMAND_NAMES,
  findCommand,
  type CommandSpec,
} from './commands';

export interface CompletionContext {
  /** The full composer text. */
  value: string;
  /** Caret offset into `value`. */
  caret: number;
  /** Nicknames in the active buffer; empty on the server buffer. */
  nicks: readonly string[];
  /** Channel names known on the active network. */
  channels: readonly string[];
  /** Our own nickname, excluded from the candidate list. */
  selfNick: string | null;
  /**
   * Who spoke last in this buffer.
   *
   * Used when Tab is pressed on an empty line, which is the fastest way to
   * answer someone without reaching for the mouse.
   */
  lastSpeaker: string | null;
}

/** Which candidate list applies at the caret. */
type Target = 'command' | 'channel' | 'nick' | 'either';

/**
 * A cycle in progress, so repeated Tabs walk the candidate list.
 *
 * Identity is the exact text written into `[start, end)` plus a caret still
 * inside that range: if both still hold, the user has not touched the completion
 * and the next Tab keeps cycling. Comparing the typed word instead would break
 * the moment the first Tab extends a prefix and changes the word out from under
 * the session.
 */
export interface CompletionSession {
  start: number;
  end: number;
  /** The text this session last wrote into `[start, end)`. */
  text: string;
  matches: readonly string[];
  /** Index of the applied match, or `-1` when only the shared prefix was applied. */
  index: number;
  target: Target;
}

export interface CompletionEdit {
  value: string;
  caret: number;
  /** `null` when the completion finished and the next Tab should start fresh. */
  session: CompletionSession | null;
}

/** Fold for comparison. IRC case mapping is the backend's job; this is a UI aid. */
function fold(value: string): string {
  return value.toLowerCase();
}

/**
 * The whitespace-delimited word around the caret.
 *
 * A trailing colon is excluded from both the match and the replaced range: a
 * nick completed at the start of a line gets one appended, and without this the
 * next Tab would hunt for a nick called `alice:` and find nothing.
 */
function wordAt(value: string, caret: number): { start: number; end: number; word: string } {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1;

  let end = caret;
  while (end < value.length && !/\s/.test(value[end]!)) end += 1;

  let word = value.slice(start, end);
  if (word.endsWith(':')) {
    word = word.slice(0, -1);
    end -= 1;
  }

  return { start, end, word };
}

/** The first whitespace-delimited token of the line, and where it ends. */
function firstToken(value: string): { text: string; end: number } {
  const match = /^\s*(\S+)/.exec(value);
  if (!match) return { text: '', end: 0 };
  return { text: match[1] ?? '', end: (match[0] ?? '').length };
}

/** Whether the caret sits in the first word of the line. */
function isFirstWord(value: string, start: number): boolean {
  return value.slice(0, start).trim() === '';
}

/**
 * Decide which candidates make sense.
 *
 * Order matters: a token starting with `#` is a channel even inside `/msg`, and
 * a leading slash is a command name only while the caret is still in the first
 * word.
 */
function targetFor(value: string, start: number, word: string, caret: number): Target {
  const first = firstToken(value);

  if (isFirstWord(value, start) && word.startsWith('/')) return 'command';
  if (word.startsWith('#') || word.startsWith('&')) return 'channel';

  // Past the command name, the command decides what its arguments look like.
  if (caret > first.end && first.text.startsWith('/')) {
    const command = fold(first.text.slice(1));
    if (CHANNEL_ARGUMENT_COMMANDS.has(command)) return 'channel';
    // These take a person or a channel, and there is no way to tell which from
    // a prefix — so offer both.
    if (command === 'msg' || command === 'query' || command === 'notice') return 'either';
  }

  return 'nick';
}

function candidatesFor(target: Target, ctx: CompletionContext, selfNick: string | null): string[] {
  const others = <T extends string>(values: readonly T[]): T[] =>
    values.filter((value) => fold(value) !== fold(selfNick ?? ''));

  switch (target) {
    case 'command':
      return [...COMMAND_NAMES];
    case 'channel':
      return others(ctx.channels);
    case 'nick':
      return others(ctx.nicks);
    case 'either':
      return [...others(ctx.nicks), ...others(ctx.channels)];
  }
}

/** Longest string every candidate starts with, compared case-insensitively. */
export function longestCommonPrefix(values: readonly string[]): string {
  const [first, ...rest] = values;
  if (first === undefined) return '';

  let length = first.length;
  for (const value of rest) {
    length = Math.min(length, value.length);
    let index = 0;
    while (index < length && fold(first[index]!) === fold(value[index]!)) index += 1;
    length = index;
    if (length === 0) break;
  }

  return first.slice(0, length);
}

/**
 * The text a match turns into.
 *
 * A nick completed as the whole first word gets a colon: that is the address
 * form, and typing it by hand is the tedium completion exists to remove. Anywhere
 * else the nick is inserted bare, because it is part of a sentence.
 */
function finish(match: string, target: Target, value: string, start: number, end: number): string {
  // The replaced range covers the slash the user typed, so it has to go back on.
  if (target === 'command') return `/${match}`;

  const addresses = target === 'nick' || target === 'either';
  if (!addresses || !isFirstWord(value, start)) return match;

  // `end` stops before an existing colon, so re-adding it is correct whether or
  // not the previous cycle already inserted one.
  return value[end] === ':' ? `${match}:` : `${match}: `;
}

/**
 * Advance the completion.
 *
 * `previous` is the session from the last Tab. Returns `null` when there is
 * nothing to complete, so the caller can decide what Tab means instead.
 */
export function complete(
  ctx: CompletionContext,
  previous: CompletionSession | null,
  direction: 1 | -1 = 1,
): CompletionEdit | null {
  // Continuing an in-flight cycle: neither the text this session wrote nor the
  // caret position may have moved. Typing after a completion is a new word, and
  // the next Tab must complete that instead of cycling the old list.
  if (
    previous &&
    ctx.caret >= previous.start &&
    ctx.caret <= previous.end &&
    ctx.value.slice(previous.start, previous.end) === previous.text
  ) {
    const { matches, target, start, end } = previous;

    const next =
      previous.index < 0
        ? direction === 1
          ? 0
          : matches.length - 1
        : (previous.index + direction + matches.length) % matches.length;

    const text = finish(matches[next]!, target, ctx.value, start, end);
    return {
      value: `${ctx.value.slice(0, start)}${text}${ctx.value.slice(end)}`,
      caret: start + text.length,
      session: { start, end: start + text.length, text, matches, index: next, target },
    };
  }

  const { start, end, word } = wordAt(ctx.value, ctx.caret);

  if (word === '') {
    // Tab on an empty first word is the "answer the last speaker" shortcut.
    if (!isFirstWord(ctx.value, start) || ctx.lastSpeaker === null) return null;
    if (fold(ctx.lastSpeaker) === fold(ctx.selfNick ?? '')) return null;

    const text = `${ctx.lastSpeaker}: `;
    return {
      value: `${ctx.value.slice(0, start)}${text}${ctx.value.slice(end)}`,
      caret: start + text.length,
      session: null,
    };
  }

  const target = targetFor(ctx.value, start, word, ctx.caret);
  const needle = fold(target === 'command' ? word.slice(1) : word);

  const matches = candidatesFor(target, ctx, ctx.selfNick).filter((candidate) => {
    const folded = fold(candidate);
    if (folded.startsWith(needle)) return true;

    // Channel arguments are usually typed without the sigil — `/join rust` — so
    // the prefix also has to match the name behind it. The replacement still
    // carries the sigil, because that is what has to go on the wire.
    return (
      (candidate.startsWith('#') || candidate.startsWith('&')) && folded.slice(1).startsWith(needle)
    );
  });

  if (matches.length === 0) return null;

  /**
   * Replace the word with `text`.
   *
   * `isMatch` is false for a shared prefix: it is a fragment, not a finished
   * name, so it must not be decorated like one.
   */
  const apply = (text: string, index: number, isMatch = true): CompletionEdit => {
    const replacement = isMatch ? finish(text, target, ctx.value, start, end) : text;
    return {
      value: `${ctx.value.slice(0, start)}${replacement}${ctx.value.slice(end)}`,
      caret: start + replacement.length,
      session: {
        start,
        end: start + replacement.length,
        text: replacement,
        matches,
        index,
        target,
      },
    };
  };

  if (matches.length === 1) return apply(matches[0]!, 0);

  // Several candidates: extend to what they share, and only start cycling once
  // there is nothing left to extend.
  const shared = longestCommonPrefix(matches);
  const prefix = target === 'command' ? `/${shared}` : shared;
  if (fold(prefix).length > fold(word).length) return apply(prefix, -1, false);

  const index = direction === 1 ? 0 : matches.length - 1;
  return apply(matches[index]!, index);
}

/**
 * The partial command name at the caret, or `null` when the caret is not in one.
 *
 * Drives the hint list: typing `/` should show what is available rather than
 * asking the user to remember a verb.
 */
export function commandQuery(value: string, caret: number): string | null {
  const match = /^\s*\/(\S*)/.exec(value);
  if (!match) return null;

  // `caret > firstTokenEnd` means the caret is past the name, in the arguments.
  const nameEnd = (match[0] ?? '').length;
  if (caret > nameEnd) return null;

  return match[1] ?? '';
}

/** Commands matching a partial name, for the hint list. */
export function matchingCommands(query: string): CommandSpec[] {
  const needle = fold(query);
  const seen = new Set<string>();

  const specs: CommandSpec[] = [];
  for (const name of COMMAND_NAMES) {
    if (!fold(name).startsWith(needle)) continue;

    const spec = findCommand(name);
    if (!spec || seen.has(spec.name)) continue;

    seen.add(spec.name);
    specs.push(spec);
  }

  return specs;
}

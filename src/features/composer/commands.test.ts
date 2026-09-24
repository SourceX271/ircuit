import { describe, expect, it } from 'vitest';

import { parseComposerInput, type ComposerContext } from './commands';

const channel: ComposerContext = { target: '#rust', isChannel: true };
const query: ComposerContext = { target: 'alice', isChannel: false };
const server: ComposerContext = { target: '', isChannel: false };

describe('parseComposerInput', () => {
  it('treats plain text as a message', () => {
    expect(parseComposerInput('hello world', channel)).toEqual({
      kind: 'message',
      text: 'hello world',
    });
  });

  it('ignores blank input', () => {
    expect(parseComposerInput('', channel)).toBeNull();
    expect(parseComposerInput('   ', channel)).toBeNull();
  });

  it('preserves trailing text exactly for messages', () => {
    // Only the trailing whitespace that a textarea adds by accident is dropped;
    // the spacing inside the message is the user's business.
    expect(parseComposerInput('  spaced  out  ', channel)).toEqual({
      kind: 'message',
      text: '  spaced  out',
    });
  });

  it('reports unknown commands instead of sending them', () => {
    // A typo silently becoming a public message is worse than a complaint.
    expect(parseComposerInput('/frobnicate', channel)).toEqual({
      kind: 'unknown',
      command: 'frobnicate',
    });
    expect(parseComposerInput('/etc/passwd is the file', channel)).toEqual({
      kind: 'unknown',
      command: 'etc/passwd',
    });
  });

  it('lets // escape text that really starts with a slash', () => {
    expect(parseComposerInput('//etc/passwd', channel)).toEqual({
      kind: 'message',
      text: '/etc/passwd',
    });
  });

  it('leaves mid-sentence slashes alone', () => {
    expect(parseComposerInput('and/or that', channel)).toEqual({
      kind: 'message',
      text: 'and/or that',
    });
  });

  it('parses /me and its alias', () => {
    expect(parseComposerInput('/me waves', channel)).toEqual({ kind: 'action', text: 'waves' });
    expect(parseComposerInput('/ME waves', channel)).toEqual({ kind: 'action', text: 'waves' });
    expect(parseComposerInput('/action waves', channel)).toEqual({ kind: 'action', text: 'waves' });
    expect(parseComposerInput('/me', channel)).toBeNull();
  });

  it('parses /msg with a multi-word body', () => {
    expect(parseComposerInput('/msg alice hello there', channel)).toEqual({
      kind: 'msg',
      target: 'alice',
      text: 'hello there',
    });
  });

  it('treats /msg without a body as opening a conversation', () => {
    // `/query alice` is how people start a private conversation; requiring a
    // message would make the alias useless.
    expect(parseComposerInput('/query alice', channel)).toEqual({
      kind: 'msg',
      target: 'alice',
      text: '',
    });
  });

  it('keeps the body of /msg verbatim', () => {
    expect(parseComposerInput('/msg alice two  spaces', channel)).toEqual({
      kind: 'msg',
      target: 'alice',
      text: 'two  spaces',
    });
  });

  it('requires a body for /notice', () => {
    expect(parseComposerInput('/notice alice hi there', channel)).toEqual({
      kind: 'notice',
      target: 'alice',
      text: 'hi there',
    });
    expect(parseComposerInput('/notice alice', channel)).toBeNull();
  });

  it('parses /join and adds the channel prefix', () => {
    expect(parseComposerInput('/join #rust', channel)).toEqual({
      kind: 'join',
      channel: '#rust',
      key: null,
    });
    expect(parseComposerInput('/join rust', channel)).toEqual({
      kind: 'join',
      channel: '#rust',
      key: null,
    });
    expect(parseComposerInput('/j rust s3cret', channel)).toEqual({
      kind: 'join',
      channel: '#rust',
      key: 's3cret',
    });
    expect(parseComposerInput('/join', channel)).toBeNull();
  });

  it('keeps the whole channel name after /join', () => {
    expect(parseComposerInput('/join #a-b_c', channel)).toEqual({
      kind: 'join',
      channel: '#a-b_c',
      key: null,
    });
  });

  it('parts the current channel by default', () => {
    expect(parseComposerInput('/part', channel)).toEqual({
      kind: 'part',
      channel: '#rust',
      reason: null,
    });
    expect(parseComposerInput('/leave bye everyone', channel)).toEqual({
      kind: 'part',
      channel: '#rust',
      reason: 'bye everyone',
    });
  });

  it('parts an explicitly named channel', () => {
    expect(parseComposerInput('/part #other', channel)).toEqual({
      kind: 'part',
      channel: '#other',
      reason: null,
    });
    expect(parseComposerInput('/part #other done here', channel)).toEqual({
      kind: 'part',
      channel: '#other',
      reason: 'done here',
    });
  });

  it('refuses channel commands outside a channel', () => {
    // Aiming `/kick` at whatever buffer happens to be open would send it to a
    // person, so the parser refuses instead of guessing.
    expect(parseComposerInput('/part', query)).toEqual({ kind: 'error', key: 'needsChannel' });
    expect(parseComposerInput('/topic hi', server)).toEqual({
      kind: 'error',
      key: 'needsChannel',
    });
    expect(parseComposerInput('/kick bob', query)).toEqual({
      kind: 'error',
      key: 'needsChannel',
    });
  });

  it('parses /topic as a query or a set', () => {
    expect(parseComposerInput('/topic', channel)).toEqual({
      kind: 'topic',
      channel: '#rust',
      topic: null,
    });
    expect(parseComposerInput('/topic hello world', channel)).toEqual({
      kind: 'topic',
      channel: '#rust',
      topic: 'hello world',
    });
  });

  it('parses /nick and /away', () => {
    expect(parseComposerInput('/nick bob', channel)).toEqual({ kind: 'nick', nick: 'bob' });
    expect(parseComposerInput('/nick', channel)).toBeNull();

    expect(parseComposerInput('/away lunch', channel)).toEqual({
      kind: 'away',
      message: 'lunch',
    });
    // Bare `/away` (and its `/back` alias) is how you come back.
    expect(parseComposerInput('/away', channel)).toEqual({ kind: 'away', message: null });
    expect(parseComposerInput('/back', channel)).toEqual({ kind: 'away', message: null });
  });

  it('parses a general /mode', () => {
    expect(parseComposerInput('/mode #rust +m', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '+m',
      args: [],
    });
    expect(parseComposerInput('/mode #rust +o alice bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '+o',
      args: ['alice', 'bob'],
    });
    expect(parseComposerInput('/mode #rust', channel)).toBeNull();
  });

  it('turns the privilege shortcuts into modes on the current channel', () => {
    expect(parseComposerInput('/op bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '+o',
      args: ['bob'],
    });
    expect(parseComposerInput('/deop bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '-o',
      args: ['bob'],
    });
    expect(parseComposerInput('/voice bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '+v',
      args: ['bob'],
    });
    expect(parseComposerInput('/devoice bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '-v',
      args: ['bob'],
    });
    expect(parseComposerInput('/op', channel)).toBeNull();
  });

  it('bans by nickname mask', () => {
    // The mask is deliberately loose: a tighter one needs the user's host, which
    // means a WHOIS round trip rather than a guess.
    expect(parseComposerInput('/ban bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '+b',
      args: ['bob!*@*'],
    });
    expect(parseComposerInput('/unban bob', channel)).toEqual({
      kind: 'mode',
      target: '#rust',
      modes: '-b',
      args: ['bob!*@*'],
    });
  });

  it('parses /kick with an optional reason', () => {
    expect(parseComposerInput('/kick bob', channel)).toEqual({
      kind: 'kick',
      channel: '#rust',
      nick: 'bob',
      reason: null,
    });
    expect(parseComposerInput('/kick bob please stop', channel)).toEqual({
      kind: 'kick',
      channel: '#rust',
      nick: 'bob',
      reason: 'please stop',
    });
    expect(parseComposerInput('/kick', channel)).toBeNull();
  });

  it('parses /invite with and without an explicit channel', () => {
    expect(parseComposerInput('/invite bob', channel)).toEqual({
      kind: 'invite',
      nick: 'bob',
      channel: '#rust',
    });
    expect(parseComposerInput('/invite bob other', channel)).toEqual({
      kind: 'invite',
      nick: 'bob',
      channel: '#other',
    });
  });

  it('parses /whois, /ignore and /unignore', () => {
    expect(parseComposerInput('/whois bob', channel)).toEqual({ kind: 'whois', nick: 'bob' });
    expect(parseComposerInput('/ignore bob', channel)).toEqual({
      kind: 'ignore',
      nick: 'bob',
      on: true,
    });
    expect(parseComposerInput('/unignore bob', channel)).toEqual({
      kind: 'ignore',
      nick: 'bob',
      on: false,
    });
  });

  it('frames /ctcp and folds only the verb', () => {
    const action = parseComposerInput('/ctcp bob version', channel);
    expect(action).toEqual({
      kind: 'raw',
      line: 'PRIVMSG bob :\u{0001}VERSION\u{0001}',
    });

    // Arguments after the verb are case-sensitive: a DCC filename is not a verb.
    expect(parseComposerInput('/ctcp bob ping 12345', channel)).toEqual({
      kind: 'raw',
      line: 'PRIVMSG bob :\u{0001}PING 12345\u{0001}',
    });
  });

  it('parses /raw and /quote', () => {
    expect(parseComposerInput('/raw WHOIS alice', channel)).toEqual({
      kind: 'raw',
      line: 'WHOIS alice',
    });
    expect(parseComposerInput('/quote MODE me +i', channel)).toEqual({
      kind: 'raw',
      line: 'MODE me +i',
    });
    expect(parseComposerInput('/raw', channel)).toBeNull();
  });

  it('parses the local commands', () => {
    expect(parseComposerInput('/clear', channel)).toEqual({ kind: 'clear' });
    expect(parseComposerInput('/close', channel)).toEqual({ kind: 'close' });
    expect(parseComposerInput('/quit bye', channel)).toEqual({ kind: 'quit', reason: 'bye' });
    expect(parseComposerInput('/disconnect', channel)).toEqual({ kind: 'quit', reason: null });
    expect(parseComposerInput('/set sendOnEnter off', channel)).toEqual({
      kind: 'set',
      key: 'sendOnEnter',
      value: 'off',
    });
    expect(parseComposerInput('/help join', channel)).toEqual({ kind: 'help', command: 'join' });
    expect(parseComposerInput('/help', channel)).toEqual({ kind: 'help', command: null });
  });

  it('adds a highlight word with sensible defaults', () => {
    expect(parseComposerInput('/highlight rust', channel)).toEqual({
      kind: 'highlight',
      pattern: 'rust',
      on: true,
      caseSensitive: false,
      wholeWord: true,
    });
  });

  it('reads the highlight flags', () => {
    expect(parseComposerInput('/highlight --case Rust', channel)).toEqual({
      kind: 'highlight',
      pattern: 'Rust',
      on: true,
      caseSensitive: true,
      wholeWord: true,
    });
    expect(parseComposerInput('/highlight --substring rust', channel)).toEqual({
      kind: 'highlight',
      pattern: 'rust',
      on: true,
      caseSensitive: false,
      wholeWord: false,
    });
  });

  it('keeps a multi-word highlight phrase together', () => {
    expect(parseComposerInput('/highlight release day', channel)).toEqual({
      kind: 'highlight',
      pattern: 'release day',
      on: true,
      caseSensitive: false,
      wholeWord: true,
    });
  });

  it('lists the highlight words when none is given', () => {
    expect(parseComposerInput('/highlight', channel)).toEqual({ kind: 'highlightList' });
  });

  it('removes a highlight word', () => {
    expect(parseComposerInput('/unhighlight rust', channel)).toEqual({
      kind: 'highlight',
      pattern: 'rust',
      on: false,
      caseSensitive: false,
      wholeWord: true,
    });
    expect(parseComposerInput('/unhighlight', channel)).toBeNull();
  });

  it('is case-insensitive about command names', () => {
    expect(parseComposerInput('/JOIN #rust', channel)).toEqual({
      kind: 'join',
      channel: '#rust',
      key: null,
    });
  });
});

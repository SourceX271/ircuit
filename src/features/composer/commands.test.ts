import { describe, expect, it } from 'vitest';

import { parseComposerInput } from './commands';

describe('parseComposerInput', () => {
  it('treats plain text as a message', () => {
    expect(parseComposerInput('hello world')).toEqual({
      kind: 'message',
      text: 'hello world',
    });
  });

  it('ignores blank input', () => {
    expect(parseComposerInput('')).toBeNull();
    expect(parseComposerInput('   ')).toBeNull();
  });

  it('leaves paths and mid-sentence slashes alone', () => {
    // A leading slash with an unknown word is far more likely to be prose than
    // a command; mangling it would lose the message.
    expect(parseComposerInput('/etc/passwd is the file')).toEqual({
      kind: 'unknown',
      command: 'etc/passwd',
    });

    expect(parseComposerInput('and/or that')).toEqual({
      kind: 'message',
      text: 'and/or that',
    });
  });

  it('parses /me', () => {
    expect(parseComposerInput('/me waves')).toEqual({ kind: 'action', text: 'waves' });
    expect(parseComposerInput('/ME waves')).toEqual({ kind: 'action', text: 'waves' });
    expect(parseComposerInput('/me')).toBeNull();
  });

  it('parses /join and adds the channel prefix', () => {
    expect(parseComposerInput('/join #rust')).toEqual({ kind: 'join', channel: '#rust' });
    expect(parseComposerInput('/join rust')).toEqual({ kind: 'join', channel: '#rust' });
    expect(parseComposerInput('/join')).toBeNull();
  });

  it('keeps the whole channel name after /join', () => {
    expect(parseComposerInput('/join #a-b_c')).toEqual({ kind: 'join', channel: '#a-b_c' });
  });

  it('parses /msg with a multi-word body', () => {
    expect(parseComposerInput('/msg alice hello there')).toEqual({
      kind: 'msg',
      target: 'alice',
      text: 'hello there',
    });
    expect(parseComposerInput('/query alice hi')).toEqual({
      kind: 'msg',
      target: 'alice',
      text: 'hi',
    });
  });

  it('parses /raw and /quote', () => {
    expect(parseComposerInput('/raw WHOIS alice')).toEqual({
      kind: 'raw',
      line: 'WHOIS alice',
    });
    expect(parseComposerInput('/quote MODE me +i')).toEqual({
      kind: 'raw',
      line: 'MODE me +i',
    });
    expect(parseComposerInput('/raw')).toBeNull();
  });

  it('reports unknown commands instead of sending them', () => {
    expect(parseComposerInput('/frobnicate')).toEqual({
      kind: 'unknown',
      command: 'frobnicate',
    });
  });

  it('preserves trailing text exactly for messages', () => {
    expect(parseComposerInput('  spaced  out  ')).toEqual({
      kind: 'message',
      text: '  spaced  out',
    });
  });
});

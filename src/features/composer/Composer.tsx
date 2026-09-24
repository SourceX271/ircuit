import { FaceSlightlySmiling, Paperclip, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import {
  disconnectNetwork,
  inviteUser,
  joinChannel,
  kickUser,
  partChannel,
  sendMessage,
  sendNotice,
  sendRawCommand,
  setAway,
  setMode,
  setNick,
  setTopic,
  whois,
} from '@/lib/ipc';
import { isIgnored, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import {
  ACTION_WRAPPER,
  COMMANDS,
  CTCP_END,
  parseComposerInput,
  type ComposerAction,
  type ComposerContext,
} from './commands';
import { commandQuery, complete, matchingCommands, type CompletionSession } from './completion';
import { completionNicks, lastSpeakerOf, stepHistory, useComposerStore } from './composerStore';

/** Above this the box scrolls internally instead of eating the message list. */
const MAX_COMPOSER_HEIGHT = 180;

/** How many command suggestions to show at once. */
const MAX_SUGGESTIONS = 8;

/** Values that read as "on" for a boolean `/set` option. */
const TRUTHY = new Set(['on', 'true', 'yes', '1']);
const FALSY = new Set(['off', 'false', 'no', '0']);

/** `/set` spellings for the send key, because nobody remembers one spelling. */
const SEND_ON_ENTER_OPTIONS = new Set(['sendonenter', 'send-on-enter', 'send_on_enter']);

export function Composer() {
  const { t } = useTranslation();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Completion and history cursors are deliberately refs: they are read and
  // written inside key handlers that already produce a state update, so making
  // them reactive would only cause extra renders.
  const sessionRef = useRef<CompletionSession | null>(null);
  const historyIndexRef = useRef<number | null>(null);
  const historyStashRef = useRef('');

  const activeBufferId = useSessionStore((state) => state.activeBufferId);
  const buffers = useSessionStore((state) => state.buffers);
  const networks = useSessionStore((state) => state.networks);
  const ignored = useSessionStore((state) => state.ignored);

  const sendOnEnter = useUiStore((state) => state.sendOnEnter);

  const buffer = buffers.find((candidate) => candidate.id === activeBufferId) ?? null;
  const network = networks.find((candidate) => candidate.id === buffer?.networkId) ?? null;

  const bufferKey = activeBufferId ?? '';

  // The draft *is* the composer's value. Keeping a second copy in local state
  // would need a sync effect on every buffer switch, and that effect is a race:
  // anything else that writes a draft — the command palette, say — gets
  // overwritten by it.
  const value = useComposerStore((state) => state.drafts[bufferKey] ?? '');
  const focusToken = useComposerStore((state) => state.focusToken);

  const lines = useSessionStore((state) => state.lines[bufferKey]);
  const channel = useSessionStore((state) => state.channels[bufferKey] ?? null);

  // Only a registered connection can accept input. Sending into a half-open
  // socket would queue commands that may never be delivered.
  const ready = network?.state === 'registered';
  const isServerBuffer = buffer?.kind === 'server';
  const networkId = network?.id ?? '';

  const nicks = useMemo(
    () => completionNicks(channel?.members, buffer?.kind === 'query' ? buffer.target : null),
    [channel?.members, buffer?.kind, buffer?.target],
  );

  const knownChannels = useMemo(
    () =>
      buffers
        .filter((candidate) => candidate.networkId === networkId && candidate.kind === 'channel')
        .map((candidate) => candidate.target),
    [buffers, networkId],
  );

  const lastSpeaker = useMemo(() => lastSpeakerOf(lines), [lines]);

  const context: ComposerContext = {
    target: buffer?.target ?? '',
    isChannel: buffer?.kind === 'channel',
  };

  const suggestions = useMemo(() => {
    const query = commandQuery(value, caret);
    return query === null ? [] : matchingCommands(query).slice(0, MAX_SUGGESTIONS);
  }, [value, caret]);

  const ignoredCount = ignored[networkId]?.length ?? 0;

  // Reset the per-buffer cursors and transient messages when the buffer
  // changes. The text itself needs no loading: it is read straight from the
  // draft, so a buffer switch cannot lose or resurrect anything.
  useEffect(() => {
    setCaret(0);
    setError(null);
    setNotice(null);

    sessionRef.current = null;
    historyIndexRef.current = null;
  }, [bufferKey]);

  // Focus when something outside the composer asks for it, e.g. right after the
  // command palette inserted a command.
  useEffect(() => {
    if (focusToken === 0) return;
    textareaRef.current?.focus();
  }, [focusToken]);

  // Autosize.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [value]);

  /**
   * Write text into the box.
   *
   * The draft is the value, so this is the only write path and the caret is the
   * only thing left to place by hand.
   */
  const edit = (next: string, nextCaret?: number) => {
    useComposerStore.getState().setDraft(bufferKey, next);
    setCaret(nextCaret ?? next.length);

    if (nextCaret !== undefined) {
      // The caret can only be placed after React has committed the new value.
      queueMicrotask(() => textareaRef.current?.setSelectionRange(nextCaret, nextCaret));
    }
  };

  /** `/set`: the options that belong to the input box itself. */
  const applyOption = (key: string, raw: string) => {
    const option = key.toLowerCase();
    if (!SEND_ON_ENTER_OPTIONS.has(option)) {
      throw new Error(t('composer.set.unknownOption', { option: key }));
    }

    const literal = raw.toLowerCase();
    if (TRUTHY.has(literal)) useUiStore.getState().setSendOnEnter(true);
    else if (FALSY.has(literal)) useUiStore.getState().setSendOnEnter(false);
    else throw new Error(t('composer.set.usage'));

    setNotice(t('composer.set.applied', { option: 'sendOnEnter' }));
  };

  /** `/help`: usage for one command, or the whole list. */
  const showHelp = (name: string | null) => {
    if (name === null) {
      const names = COMMANDS.map((spec) => `/${spec.name}`).join(' ');
      setNotice(t('composer.help.all', { commands: names }));
      return;
    }

    const spec = COMMANDS.find((candidate) => candidate.name === name.toLowerCase());
    if (!spec) {
      setError(t('composer.help.unknown', { command: name }));
      return;
    }

    setNotice(
      t('composer.help.usage', {
        usage: `/${spec.name} ${spec.usage}`.trim(),
        description: t(`composer.commands.${spec.descriptionKey}`),
      }),
    );
  };

  /** Carry out a parsed action. Throws with a displayable message on failure. */
  const runAction = async (action: ComposerAction) => {
    if (!buffer || !network) return;

    const store = useSessionStore.getState;

    switch (action.kind) {
      case 'message':
        // On the server buffer a bare line is a raw command, which is what the
        // console convention leads users to expect.
        if (buffer.kind === 'server') await sendRawCommand(network.id, action.text);
        else await sendMessage(network.id, buffer.target, action.text);
        break;

      case 'action':
        if (buffer.kind === 'server') throw new Error(t('composer.actionNeedsTarget'));
        await sendMessage(network.id, buffer.target, `${ACTION_WRAPPER}${action.text}${CTCP_END}`);
        break;

      case 'notice':
        await sendNotice(network.id, action.target, action.text);
        break;

      case 'join':
        await joinChannel(network.id, action.channel);
        break;

      // Leaving keeps the buffer: the PART is already part of its history, and
      // scrollback someone deliberately looked at should not vanish. `/close` is
      // the command that removes the window.
      case 'part':
        await partChannel(network.id, action.channel, action.reason);
        break;

      case 'msg':
        // No body means "open the conversation", which is the `/query` case.
        if (action.text === '') store().openQuery(network.id, action.target);
        else await sendMessage(network.id, action.target, action.text);
        break;

      case 'nick':
        await setNick(network.id, action.nick);
        break;

      case 'topic':
        await setTopic(network.id, action.channel, action.topic);
        break;

      case 'away':
        await setAway(network.id, action.message);
        break;

      case 'mode':
        await setMode(network.id, action.target, action.modes, action.args);
        break;

      case 'kick':
        await kickUser(network.id, action.channel, action.nick, action.reason);
        break;

      case 'invite':
        await inviteUser(network.id, action.nick, action.channel);
        break;

      case 'whois':
        await whois(network.id, action.nick);
        break;

      case 'raw':
        await sendRawCommand(network.id, action.line);
        break;

      case 'ignore': {
        const already = isIgnored(store().ignored[network.id] ?? [], action.nick);

        // Toggling is the only mutation the store offers, so only toggle when
        // the requested state differs — `/ignore` on someone already ignored
        // must not quietly unignore them.
        if (already !== action.on) store().toggleIgnored(network.id, action.nick);

        setNotice(
          t(action.on ? 'composer.ignore.applied' : 'composer.ignore.removed', {
            nick: action.nick,
          }),
        );
        break;
      }

      case 'clear':
        store().clearBuffer(buffer.id);
        break;

      case 'close':
        // A channel is the server's to close; a query exists only here.
        if (buffer.kind === 'channel') await partChannel(network.id, buffer.target, null);
        else store().closeBuffer(buffer.id);
        break;

      case 'quit':
        await disconnectNetwork(network.id);
        break;

      case 'set':
        applyOption(action.key, action.value);
        break;

      case 'help':
        showHelp(action.command);
        break;

      case 'error':
        throw new Error(t(`composer.errors.${action.key}`));

      case 'unknown':
        throw new Error(t('composer.unknownCommand', { command: action.command }));
    }
  };

  const submit = async () => {
    if (!buffer || !network) return;

    const action = parseComposerInput(value, context);
    if (!action) return;

    setError(null);
    setNotice(null);

    try {
      await runAction(action);

      // Pushing before clearing means the draft is replaced by an empty one and
      // the sent line is what ArrowUp brings back.
      useComposerStore.getState().pushHistory(bufferKey, value);

      edit('');
      historyIndexRef.current = null;
      sessionRef.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Walk the per-buffer history, stashing whatever was being typed. */
  const moveHistory = (direction: -1 | 1) => {
    const history = useComposerStore.getState().history[bufferKey] ?? [];

    // The line being composed is not history yet: remember it so ArrowDown can
    // bring it back instead of losing it.
    if (historyIndexRef.current === null && direction === -1) historyStashRef.current = value;

    const step = stepHistory(history, historyIndexRef.current, direction, historyStashRef.current);
    historyIndexRef.current = step.index;

    if (step.value !== value) edit(step.value, step.value.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ready) return;

    const element = event.currentTarget;

    // Tab completes. It must never move focus: in a composer, Tab belongs to
    // the text, and losing the caret mid-sentence is worse than doing nothing.
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();

      const result = complete(
        {
          value,
          caret: element.selectionStart,
          nicks,
          channels: knownChannels,
          selfNick: network?.nick ?? null,
          lastSpeaker,
        },
        sessionRef.current,
        event.shiftKey ? -1 : 1,
      );

      if (result) {
        sessionRef.current = result.session;
        edit(result.value, result.caret);
      }
      return;
    }

    // Any other key invalidates the cycle, so the next Tab starts fresh.
    sessionRef.current = null;

    if (event.key === 'Escape') {
      historyIndexRef.current = null;
      setNotice(null);
      return;
    }

    if (event.key === 'ArrowUp' && !event.shiftKey) {
      const onFirstLine = !value.slice(0, element.selectionStart).includes('\n');
      if (onFirstLine) {
        event.preventDefault();
        moveHistory(-1);
        return;
      }
    }

    if (event.key === 'ArrowDown' && !event.shiftKey) {
      const onLastLine = !value.slice(element.selectionStart).includes('\n');
      if (onLastLine && historyIndexRef.current !== null) {
        event.preventDefault();
        moveHistory(1);
        return;
      }
    }

    // `isComposing` guards IME input: pressing Enter to accept a candidate must
    // not send a half-finished message.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const withModifier = event.ctrlKey || event.metaKey;
      const shouldSend = withModifier || (sendOnEnter && !event.shiftKey);

      if (shouldSend) {
        event.preventDefault();
        void submit();
      }
    }
  };

  const placeholder = !ready
    ? t('composer.offlinePlaceholder')
    : sendOnEnter
      ? t('composer.placeholder')
      : t('composer.placeholderMultiline');

  return (
    <div className="shrink-0 border-t border-line bg-composer px-3 py-2.5">
      {error ? (
        <p role="alert" className="mb-1.5 px-1 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}

      {notice ? <p className="mb-1.5 px-1 text-[11.5px] text-muted">{notice}</p> : null}

      <div className="relative">
        {suggestions.length > 0 ? (
          <ul
            aria-label={t('composer.suggestions')}
            className="absolute bottom-full left-0 mb-1.5 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
          >
            {suggestions.map((spec) => (
              <li
                key={spec.name}
                className="flex items-baseline gap-2 px-2.5 py-1 text-[12px] leading-tight"
              >
                <code className="shrink-0 font-mono text-accent">
                  /{spec.name}
                  {spec.usage === '' ? '' : ` ${spec.usage}`}
                </code>
                <span className="truncate text-faint">
                  {t(`composer.commands.${spec.descriptionKey}`)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-1.5 rounded-lg border border-line bg-surface px-1.5 py-1.5 transition-colors focus-within:border-accent">
          <IconButton label={t('composer.emoji')} size="md" disabled>
            <FaceSlightlySmiling />
          </IconButton>
          <IconButton label={t('composer.attach')} size="md" disabled>
            <Paperclip />
          </IconButton>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(event) => edit(event.target.value, event.target.selectionStart)}
            onKeyDown={onKeyDown}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            placeholder={placeholder}
            aria-label={t('composer.placeholder')}
            disabled={!ready}
            className="min-h-[26px] min-w-0 flex-1 resize-none self-center bg-transparent py-0.5 text-[14px] leading-[1.5] text-ink outline-none placeholder:text-faint disabled:opacity-60"
          />

          <IconButton
            label={t('composer.send')}
            size="md"
            tone="accent"
            disabled={!ready || value.trim().length === 0}
            onClick={() => void submit()}
          >
            <Send />
          </IconButton>
        </div>
      </div>

      {ready && !isServerBuffer ? (
        <p className="mt-1 px-1 text-[11px] text-faint">
          {t('composer.commandHint')}
          {ignoredCount > 0 ? ` · ${t('composer.ignoredCount', { count: ignoredCount })}` : ''}
        </p>
      ) : null}
    </div>
  );
}

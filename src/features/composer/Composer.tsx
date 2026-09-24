import { FaceSlightlySmiling, Paperclip, Send } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';
import { joinChannel, sendMessage, sendRawCommand } from '@/lib/ipc';
import { useSessionStore } from '@/store/session';

import { ACTION_WRAPPER, parseComposerInput } from './commands';

/** Above this the box scrolls internally instead of eating the message list. */
const MAX_COMPOSER_HEIGHT = 180;

/** Closes a CTCP sequence. */
const CTCP_END = '\u{0001}';

export function Composer() {
  const { t } = useTranslation();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const buffer = useSessionStore(
    (state) => state.buffers.find((candidate) => candidate.id === state.activeBufferId) ?? null,
  );
  const network = useSessionStore(
    (state) => state.networks.find((candidate) => candidate.id === buffer?.networkId) ?? null,
  );

  // Only a registered connection can accept input. Sending into a half-open
  // socket would queue commands that may never be delivered.
  const ready = network?.state === 'registered';
  const isServerBuffer = buffer?.kind === 'server';

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [value]);

  const submit = async () => {
    if (!buffer || !network) return;

    const action = parseComposerInput(value);
    if (!action) return;

    setError(null);

    try {
      switch (action.kind) {
        case 'message':
          // On the server buffer a bare line is a raw command, which is what the
          // console convention leads users to expect.
          if (buffer.kind === 'server') await sendRawCommand(network.id, action.text);
          else await sendMessage(network.id, buffer.target, action.text);
          break;

        case 'action':
          if (buffer.kind === 'server') throw new Error(t('composer.actionNeedsTarget'));
          await sendMessage(
            network.id,
            buffer.target,
            `${ACTION_WRAPPER}${action.text}${CTCP_END}`,
          );
          break;

        case 'join':
          await joinChannel(network.id, action.channel);
          break;

        case 'msg':
          await sendMessage(network.id, action.target, action.text);
          break;

        case 'raw':
          await sendRawCommand(network.id, action.line);
          break;

        case 'unknown':
          throw new Error(t('composer.unknownCommand', { command: action.command }));
      }

      setValue('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ready) return;

    // `isComposing` guards IME input: pressing Enter to accept a candidate must
    // not send a half-finished message.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-composer px-3 py-2.5">
      {error ? (
        <p role="alert" className="mb-1.5 px-1 text-[11.5px] text-danger">
          {error}
        </p>
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
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={ready ? t('composer.placeholder') : t('composer.offlinePlaceholder')}
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

      {ready && !isServerBuffer ? (
        <p className="mt-1 px-1 text-[11px] text-faint">{t('composer.commandHint')}</p>
      ) : null}
    </div>
  );
}

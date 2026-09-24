import { FaceSlightlySmiling, Paperclip, Send } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '@/components/ui/icon-button';

/** 输入框自增高的上限，超过后内部滚动，避免吃掉整个消息区。 */
const MAX_COMPOSER_HEIGHT = 180;

export function Composer() {
  const { t } = useTranslation();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');

  // M0 没有真实连接，因此 Enter 不拦截：换行就是换行。
  // M1 接入会话后这里改为「Enter 发送 / Shift+Enter 换行」。
  const connected = false;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!connected) return;

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-composer px-3 py-2.5">
      <div className="flex items-end gap-1.5 rounded-lg border border-line bg-surface px-1.5 py-1.5 transition-colors focus-within:border-accent">
        <IconButton label={t('composer.emoji')} size="md" disabled={!connected}>
          <FaceSlightlySmiling />
        </IconButton>
        <IconButton label={t('composer.attach')} size="md" disabled={!connected}>
          <Paperclip />
        </IconButton>

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? t('composer.placeholder') : t('composer.offlinePlaceholder')}
          aria-label={t('composer.placeholder')}
          className="min-h-[26px] min-w-0 flex-1 resize-none self-center bg-transparent py-0.5 text-[14px] leading-[1.5] text-ink outline-none placeholder:text-faint"
        />

        <IconButton
          label={t('composer.send')}
          size="md"
          tone="accent"
          disabled={!connected || value.trim().length === 0}
        >
          <Send />
        </IconButton>
      </div>
    </div>
  );
}

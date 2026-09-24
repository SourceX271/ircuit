import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { connectNetwork } from '@/lib/ipc';

/** Styling shared by every input in the dialog. */
const FIELD_CLASS =
  'w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none transition-colors placeholder:text-faint focus:border-accent';

const LABEL_CLASS = 'mb-1 block text-[11.5px] font-medium text-muted';

export interface NetworkDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The connection form.
 *
 * Hand-rolled rather than built on a component library: the only behaviour it
 * needs beyond plain markup is initial focus and Escape to close, which is not
 * worth a dependency.
 */
export function NetworkDialog({ open, onClose }: NetworkDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();

  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState('irc.libera.chat');
  const [port, setPort] = useState('');
  const [tls, setTls] = useState(true);
  const [nick, setNick] = useState('');
  const [realname, setRealname] = useState('');
  const [saslAccount, setSaslAccount] = useState('');
  const [saslPassword, setSaslPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    firstFieldRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await connectNetwork({
        host,
        // An empty box means "the default port for this transport".
        port: port.trim() === '' ? 0 : Number.parseInt(port, 10),
        tls,
        nick,
        realname: realname.trim() === '' ? null : realname,
        sasl_account: saslAccount.trim() === '' ? null : saslAccount,
        sasl_password: saslPassword.trim() === '' ? null : saslPassword,
      });
      onClose();
    } catch (cause) {
      // Validation and connection failures both land here; the message comes
      // from the Rust side and is already specific.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={(event) => {
        // Clicking the backdrop closes; clicking inside must not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-line bg-elevated p-5 shadow-2xl"
      >
        <h2 id={titleId} className="mb-4 text-[15px] font-semibold text-ink">
          {t('network.title')}
        </h2>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label className={LABEL_CLASS} htmlFor="network-host">
                {t('network.host')}
              </label>
              <input
                id="network-host"
                ref={firstFieldRef}
                className={FIELD_CLASS}
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder={t('network.hostPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>

            <div className="w-24 shrink-0">
              <label className={LABEL_CLASS} htmlFor="network-port">
                {t('network.port')}
              </label>
              <input
                id="network-port"
                className={FIELD_CLASS}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder={tls ? '6697' : '6667'}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={tls}
              onChange={(event) => setTls(event.target.checked)}
              className="size-3.5 accent-[var(--ir-accent)]"
            />
            {t('network.tls')}
          </label>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label className={LABEL_CLASS} htmlFor="network-nick">
                {t('network.nick')}
              </label>
              <input
                id="network-nick"
                className={FIELD_CLASS}
                value={nick}
                onChange={(event) => setNick(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>

            <div className="min-w-0 flex-1">
              <label className={LABEL_CLASS} htmlFor="network-realname">
                {t('network.realname')}
              </label>
              <input
                id="network-realname"
                className={FIELD_CLASS}
                value={realname}
                onChange={(event) => setRealname(event.target.value)}
                placeholder={t('network.realnamePlaceholder')}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label className={LABEL_CLASS} htmlFor="network-sasl-account">
                {t('network.saslAccount')}
              </label>
              <input
                id="network-sasl-account"
                className={FIELD_CLASS}
                value={saslAccount}
                onChange={(event) => setSaslAccount(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="min-w-0 flex-1">
              <label className={LABEL_CLASS} htmlFor="network-sasl-password">
                {t('network.saslPassword')}
              </label>
              <input
                id="network-sasl-password"
                type="password"
                className={FIELD_CLASS}
                value={saslPassword}
                onChange={(event) => setSaslPassword(event.target.value)}
                autoComplete="off"
              />
            </div>
          </div>

          <p className="text-[11px] text-faint">{t('network.saslHint')}</p>

          {error ? (
            <p
              role="alert"
              className="rounded-md bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-subtle hover:text-ink"
            >
              {t('network.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {t('network.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

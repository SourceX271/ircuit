import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/cn';
import type { CoreBridgeState } from '@/features/selfcheck/useCoreBridge';

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;

  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}`;
}

function StatusDot({ state }: { state: CoreBridgeState['ipcState'] }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'ok' && 'bg-success',
        state === 'pending' && 'animate-pulse bg-warning',
        state === 'error' && 'bg-danger',
      )}
    />
  );
}

export function StatusBar({ bridge }: { bridge: CoreBridgeState }) {
  const { t } = useTranslation();

  const ipcLabel = {
    ok: t('status.ok'),
    pending: t('status.waiting'),
    error: t('status.down'),
  }[bridge.ipcState];

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface px-3 text-[11px] text-faint">
      <span className="flex items-center gap-1.5">
        <StatusDot state={bridge.ipcState} />
        <span className="text-muted">{t('status.ipc')}</span>
        <span>{ipcLabel}</span>
        {bridge.latencyMs !== null ? (
          <span className="font-mono tabular-nums">{bridge.latencyMs} ms</span>
        ) : null}
      </span>

      <span className="flex items-center gap-1.5">
        <span className="text-muted">{t('status.events')}</span>
        <span className="font-mono tabular-nums">{bridge.heartbeatCount}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <span className="text-muted">{t('status.uptime')}</span>
        <span className="font-mono tabular-nums">
          {formatUptime(bridge.status?.uptime_seconds ?? null)}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        <span className="text-muted">{t('status.modules')}</span>
        <span className="font-mono tabular-nums">{bridge.modules.length}</span>
      </span>

      <span className="ml-auto flex items-center gap-1.5">
        <span className="text-muted">{t('status.platform')}</span>
        <span className="font-mono">
          {bridge.appInfo ? `${bridge.appInfo.platform}/${bridge.appInfo.arch}` : '—'}
        </span>
      </span>
    </footer>
  );
}

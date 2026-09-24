import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import type { CoreBridgeState } from './useCoreBridge';

/** 一行「标签 : 值」，用于自检卡片里的键值对。 */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="shrink-0 text-[11.5px] text-faint">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[11.5px] tabular-nums text-muted">{value}</dd>
    </div>
  );
}

export function CoreModulesCard({ bridge }: { bridge: CoreBridgeState }) {
  const { t } = useTranslation();
  const { appInfo, modules, latencyMs, heartbeatCount, lastHeartbeatAt } = bridge;

  const heartbeatValue =
    lastHeartbeatAt === null
      ? t('selfCheck.notYet')
      : t('selfCheck.measured', { value: Date.now() - lastHeartbeatAt });

  return (
    <section className="shrink-0 border-t border-line px-3 py-2.5">
      <header className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
          {t('selfCheck.title')}
        </h2>
      </header>

      <dl className="mb-3">
        <Field label={t('selfCheck.version')} value={appInfo?.version ?? '—'} />
        <Field label={t('selfCheck.tauri')} value={appInfo?.tauri_version ?? '—'} />
        <Field
          label={t('selfCheck.build')}
          value={
            appInfo
              ? appInfo.debug
                ? t('selfCheck.buildDebug')
                : t('selfCheck.buildRelease')
              : '—'
          }
        />
        <Field
          label={t('selfCheck.latency')}
          value={latencyMs === null ? '—' : `${latencyMs} ms`}
        />
        <Field label={t('selfCheck.heartbeat')} value={`${heartbeatCount} · ${heartbeatValue}`} />
      </dl>

      <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
        {t('arch.title')}
      </h3>

      <ul className="flex flex-col gap-1.5">
        {modules.map((module) => (
          <li key={module.name} className="flex items-start gap-2">
            <code className="mt-[2px] min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
              {module.name}
            </code>
            <Badge tone="outline" className="mt-[2px]">
              {module.milestone}
            </Badge>
            <span className="sr-only">{module.responsibility}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

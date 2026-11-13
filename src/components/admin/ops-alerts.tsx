import { getFormatter, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/ui/empty-state';
import type { ConsoleAlert, ConsoleJobRun } from '@/repositories/console.repository';
import { BlockedMoneyAlert } from './blocked-money-alert';
import { RequeueEmailsButton, ResolveAlertButton, StuckResolver } from './alert-actions';

/** Tipos de descuadre que la conciliación puede registrar (`detailJson.kind`): cualquier otro valor no se pinta (no tiene texto). */
const RECONCILIATION_KINDS = new Set(['MISSING_LOCALLY', 'MISSING_AT_PSP', 'AMOUNT_MISMATCH', 'AUTHCODE_MISMATCH', 'CLEARING_NEGATIVE', 'RAISED_MISMATCH']);
const SEVERITY_STYLE = { CRITICAL: 'bg-red-100 text-red-950', WARNING: 'bg-amber-100 text-amber-950', INFO: 'bg-slate-100 text-slate-900' } as const;
/** Las horas se ven en la hora de España: el servidor puede estar en UTC y una hora de diferencia en una alerta confunde. */
const TIME = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;

/**
 * Bandeja de alertas abiertas (Sprint 5.1): gravedad, repeticiones, entidad afectada, el tipo de descuadre en la conciliación con Paycomet y
 * el botón de resolver. Las devoluciones y facturas de resultado desconocido solo se cierran con su resolución a mano (comprobando antes qué pasó).
 */
export async function OpsAlerts({ alerts, openTotal, locale }: { alerts: ConsoleAlert[]; openTotal: number; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'admin' });
  const format = await getFormatter({ locale });

  if (alerts.length === 0) return <EmptyState headingLevel={3} title={t('noAlertsTitle')} description={t('noAlertsText')} />;

  return (
    <>
      {openTotal > alerts.length ? <p className="text-sm text-ink-soft">{t('alertsCapped', { shown: alerts.length, total: openTotal })}</p> : null}
      <ul className="flex flex-col gap-3" data-testid="ops-alerts">
        {alerts.map((alert) => (
          <li key={alert.id} className="flex flex-col gap-3 rounded-xl border-2 border-varsity-navy/15 bg-white p-3" data-alert={alert.type}>
            <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
              <p id={`alert-title-${alert.id}`} className="font-bold text-varsity-navy">
                <span className={`me-2 rounded-full px-2 py-0.5 text-xs font-extrabold ${SEVERITY_STYLE[alert.severity]}`}>{t(`severity.${alert.severity}`)}</span>
                {t(`alertType.${alert.type}`)}
                {alert.organization ? ` · ${alert.organization.name}` : ''}
                {alert.kind && RECONCILIATION_KINDS.has(alert.kind) ? <span className="mt-1 block text-sm font-normal text-ink-soft">{t(`alerts.kind.${alert.kind}`)}</span> : null}
              </p>
              <p className="text-sm text-ink-soft">{t('alertMeta', { count: alert.occurrences, date: format.dateTime(alert.lastSeenAt, TIME) })}</p>
            </div>
            {alert.type === 'PAYOUT_BLOCKED' || alert.type === 'ACTIVITY_FUND_WINDOW' ? (
              <BlockedMoneyAlert alertId={alert.id} type={alert.type} figures={alert.figures} describedBy={`alert-title-${alert.id}`} />
            ) : (alert.type === 'REFUND_STUCK' || alert.type === 'INVOICE_STUCK') && alert.resolvableId !== null ? (
              <StuckResolver alertType={alert.type} id={alert.resolvableId} />
            ) : (
              <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-start">
                {alert.requeueTemplate !== null ? <RequeueEmailsButton alertId={alert.id} describedBy={`alert-title-${alert.id}`} /> : null}
                <ResolveAlertButton alertId={alert.id} describedBy={`alert-title-${alert.id}`} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Última ejecución de cada tarea programada (tabla `Job`): estado, cuándo y cuántos intentos. El texto del error vive en la alerta, no aquí. */
export async function JobRuns({ jobs, locale }: { jobs: ConsoleJobRun[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'admin.jobs' });
  const format = await getFormatter({ locale });

  if (jobs.length === 0) return <p className="text-ink-soft">{t('none')}</p>;

  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('region')} data-testid="job-runs">
      <table className="w-full min-w-lg border-collapse text-start">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b-2 border-varsity-navy/20 text-sm">
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('task')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('status')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-corp font-bold">
              {t('lastRun')}
            </th>
            <th scope="col" className="px-2 py-2 text-end font-corp font-bold">
              {t('attempts')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-patio-rule">
          {jobs.map((job) => (
            <tr key={job.type} data-job={job.type}>
              <th scope="row" className="px-2 py-2 text-start font-semibold">
                {t(`type.${job.type}`)}
              </th>
              <td className={`px-2 py-2 font-bold ${job.status === 'FAILED' ? 'text-red-800' : ''}`}>{t(`state.${job.status}`)}</td>
              <td className="px-2 py-2">{format.dateTime(job.updatedAt, TIME)}</td>
              <td className="px-2 py-2 text-end tabular-nums">{job.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

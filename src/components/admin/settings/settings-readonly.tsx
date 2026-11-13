import { useLocale, useTranslations } from 'next-intl';
import { FocusWhenChanged } from './settings-kit';
import { Link } from '@/i18n/navigation';
import { HISTORY_PAGE, type HistoryRow, type SecurityView, type SettingsView } from '@/services/admin/platform-settings-view';

const WHEN = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;
const NOTICE = 'rounded-xl border-2 border-amber-600/40 bg-amber-50 p-3 text-sm font-semibold text-amber-950';
const ALERT_TYPES = ['CARD_DELETE_FAILED', 'PRIVACY_REQUEST_OVERDUE', 'ENCRYPTION_KEY_MISSING'] as const;

/**
 * Claves de cifrado y alertas de seguridad: la versión de la clave actual, cuántas anteriores quedan configuradas, cuántos valores siguen cifrados con una clave que no es la actual (con todo a 0 se
 * puede vaciar `ENCRYPTION_PREVIOUS_KEYS`, DECISIONES §5) y las alertas abiertas de tarjetas, privacidad y claves. Es solo de lectura: las claves no se tocan desde la pantalla.
 */
export function SecurityPanel({ security }: { security: SecurityView }) {
  const t = useTranslations('admin.settings.security');
  const tables = Object.entries(security.pending);
  // Una alerta de clave que falta (valores que ninguna clave configurada descifra) manda sobre una rotación en marcha: no se esconde detrás de ella.
  const state = security.alerts.ENCRYPTION_KEY_MISSING > 0 ? 'orphaned' : security.previousKeys > 0 ? (security.pendingTotal === 0 ? 'readyToRetire' : 'rotating') : security.pendingTotal > 0 ? 'orphaned' : 'ok';
  return (
    <div className="flex flex-col gap-4" data-testid="security-panel">
      <dl className="mobile-stack grid gap-3 md:grid-cols-3">
        <div className="korum-trust-vault p-4">
          <dt className="text-sm font-semibold text-ink-soft">{t('keyVersion')}</dt>
          <dd className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">{security.keyVersion}</dd>
        </div>
        <div className="korum-trust-vault p-4">
          <dt className="text-sm font-semibold text-ink-soft">{t('previousKeys')}</dt>
          <dd className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">{security.previousKeys}</dd>
        </div>
        <div className="korum-trust-vault p-4">
          <dt className="text-sm font-semibold text-ink-soft">{t('pendingTotal')}</dt>
          <dd className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy" data-testid="pending-total">
            {security.pendingTotal}
          </dd>
        </div>
      </dl>
      <p role="note" className={state === 'orphaned' ? NOTICE : 'rounded-xl bg-varsity-navy/5 p-3 text-sm'} data-testid="rotation-state">
        {t(`state.${state}`)}
      </p>
      {security.pendingTotal > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('pendingByTable')}>
          {tables
            .filter(([, count]) => count > 0)
            .map(([name, count]) => (
              <li key={name} className="rounded-full bg-varsity-navy/5 px-3 py-1 text-sm font-semibold">
                {t('pendingRow', { table: t.has(`tables.${name}`) ? t(`tables.${name}`) : name, count })}
              </li>
            ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('alertsTitle')}</h3>
        <ul className="flex flex-col gap-1">
          {ALERT_TYPES.map((type) => (
            <li key={type} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`security-alert-${type}`}>
              <span className="font-semibold">{t(`alerts.${type}`)}</span>
              <span className="font-corp tabular-nums">{security.alerts[type]}</span>
              {security.alerts[type] > 0 ? (
                <Link href="/admin#avisos" className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline">
                  {t('alertsLink')}
                </Link>
              ) : (
                <span className="text-ink-soft">{t('alertsNone')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Nombre en lenguaje llano de lo que se cambió: el ajuste, la clave, el texto legal o la conexión probada (nunca la clave técnica sola). */
function targetOf(t: ReturnType<typeof useTranslations>, all: ReturnType<typeof useTranslations>, row: HistoryRow): string {
  if (row.action.startsWith('superadmin.')) return t('person');
  const id = row.target.replaceAll('.', '_');
  if (row.target === 'privacy.policyVersion') return t('targets.policyVersion');
  const legal = /^legal\.(terminos|privacidad|cookies|aviso-legal)\.(es|ca|en)$/.exec(row.target);
  if (legal) return t('targets.legal', { document: all(`legal.documents.${legal[1] as 'terminos'}`), locale: all(`legal.locales.${legal[2] as 'es'}`) });
  if (row.action === 'settings.connection_tested') return t.has(`targets.connection.${row.target}`) ? t(`targets.connection.${row.target}`) : row.target;
  if (all.has(`fields.${id}.label`)) return all(`fields.${id}.label`);
  if (all.has(`secrets.${id}.label`)) return all(`secrets.${id}.label`);
  return row.target;
}

function detailOf(t: ReturnType<typeof useTranslations>, row: HistoryRow): string {
  const parts: string[] = [];
  if (row.legal) parts.push(t('detail.legal', { version: row.legal.version, status: row.legal.status ? t(`detail.legalStatus.${row.legal.status}` as 'detail.legalStatus.PUBLICADO') : '' }));
  if (row.value !== null) parts.push(t('detail.value', { value: row.value }));
  if (row.status) parts.push(t.has(`detail.status.${row.status}`) ? t(`detail.status.${row.status}`) : row.status);
  // En un texto legal, «versión» es la del texto (la fecha de publicación): la del ajuste solo confundiría.
  if (!row.legal && row.version !== null && row.version > 0 && row.action.startsWith('settings.setting')) parts.push(t('detail.version', { version: row.version }));
  if (row.sessionsClosed !== null) parts.push(t('detail.sessions', { count: row.sessionsClosed }));
  if (row.walletConfirmed) parts.push(t('detail.walletConfirmed'));
  return parts.join(' · ');
}

/** Historial de cambios de ajustes y del equipo: de más reciente a más antiguo, con quién lo hizo. Nunca muestra un secreto ni un dato personal de la persona afectada. */
export function HistoryTable({ history }: { history: SettingsView['history'] }) {
  const t = useTranslations('admin.settings.history');
  const all = useTranslations('admin.settings');
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, WHEN);
  if (history.rows.length === 0) {
    return (
      <p className="rounded-xl bg-varsity-navy/5 p-3 text-sm" data-testid="history-empty">
        {t('empty')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <FocusWhenChanged id="history-region" value={history.limit} />
      <div id="history-region" tabIndex={0} role="region" aria-label={t('title')} className="overflow-x-auto rounded-xl border-2 border-varsity-navy/15">
        <table className="w-full min-w-[44rem] text-left text-sm" data-testid="history-table">
          <thead className="bg-varsity-navy/5 text-varsity-navy">
            <tr>
              {(['when', 'who', 'what', 'target', 'detail'] as const).map((column) => (
                <th key={column} scope="col" className="p-2 font-bold">
                  {t(`columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.rows.map((row) => (
              <tr key={row.id} className="border-t border-varsity-navy/10 align-top">
                <td className="whitespace-nowrap p-2">{format.format(row.occurredAt)}</td>
                <td className="break-all p-2">{row.actorEmail ?? t('system')}</td>
                <td className="p-2 font-semibold">{t(`actions.${row.action.replaceAll('.', '_')}` as 'actions.settings_setting_updated')}</td>
                <td className="break-words p-2">{targetOf(t, all, row)}</td>
                <td className="p-2">{detailOf(t, row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.hasMore ? (
        <Link href={{ pathname: '/admin/ajustes', query: { historial: String(history.limit + HISTORY_PAGE) }, hash: 'historial' }} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline" data-testid="history-more">
          {t('more')}
        </Link>
      ) : null}
    </div>
  );
}

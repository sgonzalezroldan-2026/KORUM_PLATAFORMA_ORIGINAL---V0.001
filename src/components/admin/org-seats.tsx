import { useFormatter, useTranslations } from 'next-intl';
import type { Org360View } from '@/services/admin/org-360-data';

const DATE = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' } as const;

/**
 * Quién firma por la entidad y cómo, **solo para consultarlo** (Sprint 5.2). Decisión del promotor del 2026-11-12: el Super-Admin no gestiona ni confirma a las
 * personas que firman. Cada entidad elige si exige una firma o dos y cambia a sus firmantes desde su propio panel, y cada cambio queda en un registro que la
 * entidad no puede borrar. La consola enseña solo el estado, sin botones (el visor del registro de auditoría queda para más adelante).
 */
export function OrgSeats({ seats, handover, signatureMode }: { seats: Org360View['seats']; handover: Org360View['handover']; signatureMode: Org360View['organization']['signatureMode'] }) {
  const t = useTranslations('admin.org360.seats');
  const format = useFormatter();

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-xl bg-patio-paper p-3 text-sm font-semibold text-varsity-navy" data-testid="signature-mode" data-mode={signatureMode}>
        {t(`mode.${signatureMode}`)}
      </p>
      <ul className="flex flex-col gap-2" data-testid="seats-list">
        {seats.map((seat) => (
          <li key={seat.id} className="flex flex-col gap-1 rounded-xl border border-patio-rule p-3" data-seat={seat.role}>
            <p>
              <strong>{t(`role.${seat.role}`)}</strong>
              {` · ${seat.name}${seat.roleLabel ? ` (${seat.roleLabel})` : ''}`}
            </p>
            <span className="block text-sm text-ink-soft">{`${seat.maskedEmail} · ${seat.twoFactor ? t('twoFactorOn') : t('twoFactorOff')}`}</span>
            <span className="block text-sm text-ink-soft" data-testid="seat-since">
              {t('since', { date: format.dateTime(new Date(seat.since), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}
            </span>
          </li>
        ))}
        {seats.length === 0 ? <li className="text-ink-soft">{t('none')}</li> : null}
      </ul>
      {handover ? (
        <p className={`rounded-xl p-3 ${handover.expired ? 'bg-red-50 text-red-950' : 'bg-amber-50 text-amber-950'}`} data-testid="handover-state" data-expired={handover.expired}>
          <strong>{t(handover.expired ? 'handover.EXPIRED' : 'handover.INVITED', { role: t(`role.${handover.role}`) })}</strong>{' '}
          {handover.expired ? t('handoverExpired', { date: format.dateTime(new Date(handover.expiresAt), DATE) }) : t('handoverUntil', { date: format.dateTime(new Date(handover.expiresAt), DATE) })}
        </p>
      ) : (
        <p className="text-sm text-ink-soft">{t('noHandover')}</p>
      )}
      <p className="text-sm text-ink-soft">{t('entityRegulates')}</p>
    </div>
  );
}

import { useTranslations } from 'next-intl';
import type { SeatRole } from '@/core/panel/team-rules';
import type { SignerTeamData } from '@/services/panel/signer-team.service';
import { HandoverForm } from './handover-form';
import { HandoverStatus } from './handover-status';
import { ResendInvitationButton } from './resend-invitation-button';
import { RoleLabelForm } from './role-label-form';

/**
 * «Equipo que firma» en los ajustes de la entidad (Sprint 4.2e): los dos puestos (dirección y cofirma) con su nombre y su cargo, la invitación de
 * la cofirma si aún no la ha aceptado, el relevo abierto y el formulario para proponer uno. Capa Varsity: es gobierno del dinero. Del resto de
 * personas solo el nombre, el cargo y si ya puede firmar; de quien se invita, el nombre escrito y el email a medias (completo solo para quien da su
 * visto bueno mientras decide).
 */
export function SignerTeamSection({ orgSlug, team, canEdit, email }: { orgSlug: string; team: SignerTeamData; canEdit: boolean; email: string }) {
  const t = useTranslations('panel.settings.team');
  const seatName = (role: SeatRole) => t(`seat.${role}`);
  const isDirector = team.myRole === 'DIRECTOR';
  const cosignerSeat = team.seats.find((seat) => seat.role === 'COSIGNER');
  // El propio puesto primero; el de la otra persona solo si está ocupado (un puesto vacío se invita, no se releva).
  const relayable = team.seats
    .filter((seat) => seat.isMe || seat.role !== team.myRole)
    .sort((a, b) => Number(b.isMe) - Number(a.isMe))
    .map((seat) => ({
      role: seat.role,
      mine: seat.isMe,
      label: seat.isMe ? t('form.seatMine', { seat: seatName(seat.role) }) : t('form.seatOther', { seat: seatName(seat.role), name: seat.name })
    }));

  return (
    <div className="korum-trust-vault flex flex-col gap-4 p-4 sm:p-5">
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label={t('seatsLabel')}>
        {team.seats.map((seat) => (
          <li key={seat.role} className="flex flex-col gap-2 rounded-2xl border-2 border-varsity-navy/20 bg-white p-4" data-testid={`seat-${seat.role}`}>
            <p className="text-sm font-bold uppercase tracking-wide text-varsity-emerald">{seatName(seat.role)}</p>
            <p className="font-corp text-lg font-extrabold text-varsity-navy wrap-anywhere">
              {seat.name}
              {seat.isMe ? <span className="ml-2 rounded-full bg-varsity-navy px-2 py-0.5 align-middle text-xs font-bold text-white">{t('you')}</span> : null}
            </p>
            <p className="text-ink">{seat.roleLabel ?? t('noRoleLabel')}</p>
            <p className="text-sm font-semibold text-ink-soft">{t(seat.ready ? 'ready' : seat.isMe ? 'needsTwoFactorMine' : 'needsTwoFactor')}</p>
            {seat.isMe && canEdit ? <RoleLabelForm orgSlug={orgSlug} current={seat.roleLabel} /> : null}
          </li>
        ))}
        {!cosignerSeat && team.pendingCosigner ? (
          <li className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-varsity-navy/40 bg-varsity-ivory p-4" data-testid="seat-COSIGNER-pending">
            <p className="text-sm font-bold uppercase tracking-wide text-varsity-emerald">{seatName('COSIGNER')}</p>
            <p className="font-corp text-lg font-extrabold text-varsity-navy wrap-anywhere">{team.pendingCosigner.displayName}</p>
            <p className="text-ink">{team.pendingCosigner.roleLabel ?? t('noRoleLabel')}</p>
            <p className="text-sm font-semibold text-ink-soft">
              {t(team.pendingCosigner.expired ? 'pendingExpired' : 'pending', {
                email: team.pendingCosigner.maskedEmail
              })}
            </p>
          </li>
        ) : null}
        {!cosignerSeat && !team.pendingCosigner ? (
          <li className="flex flex-col gap-2 rounded-2xl border-2 border-dashed border-red-700/60 bg-red-50 p-4" data-testid="seat-COSIGNER-empty">
            <p className="text-sm font-bold uppercase tracking-wide text-varsity-emerald">{seatName('COSIGNER')}</p>
            <p className="font-semibold text-red-900">{t('cosignerEmpty')}</p>
          </li>
        ) : null}
      </ul>

      {team.handover ? <HandoverStatus orgSlug={orgSlug} handover={team.handover} seatLabel={seatName(team.handover.role)} canEdit={canEdit} email={email} /> : null}

      {/* Con la cofirma sin aceptar (o sin invitación: caducó y se purgó), quien dirige la invita o corrige a quién se invita. */}
      {canEdit && isDirector && !cosignerSeat ? (
        <section aria-labelledby="team-correct" className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4">
          <h3 id="team-correct" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t(team.pendingCosigner ? 'correctTitle' : 'inviteTitle')}
          </h3>
          {team.pendingCosigner ? <ResendInvitationButton orgSlug={orgSlug} /> : null}
          <HandoverForm orgSlug={orgSlug} mode="correct" seats={[]} email={email} />
        </section>
      ) : null}

      {canEdit && !team.handover && relayable.length > 0 ? (
        <section aria-labelledby="team-propose" className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4">
          <h3 id="team-propose" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t('proposeTitle')}
          </h3>
          {/* Con un solo puesto relevable (el propio), la explicación ya está en el formulario. */}
          {relayable.length > 1 ? <p className="text-sm text-ink-soft">{t('rule')}</p> : null}
          <HandoverForm orgSlug={orgSlug} mode="propose" seats={relayable} email={email} />
        </section>
      ) : null}
    </div>
  );
}

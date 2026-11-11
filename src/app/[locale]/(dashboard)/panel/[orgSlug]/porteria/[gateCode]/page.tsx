import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { GateScanner } from '@/components/gate/gate-scanner';
import { GatePinForm, LeaveGateButton } from '@/components/panel/gate-pin-form';
import { EmptyState } from '@/components/ui/empty-state';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { getGateSummary } from '@/core/ticketing/check-in.service';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { resolveGateAccess } from '../gate-request';

export const dynamic = 'force-dynamic';

/**
 * Puerta de un evento (QA-SEC05, QA-S04). La dirección lleva el **código de la puerta** (no adivinable), no el identificador numérico. Sin sesión de portería válida
 * para **este** evento se pide el PIN; con ella, el lector de entradas con el aforo en directo (o, en una rifa, el acceso al sorteo) y nada más: ni importes, ni datos
 * de las personas, ni ajustes. Una sesión ya abierta sigue valiendo aunque el PIN se haya revocado por abuso: la puerta no debe pararse por un ataque. Cada
 * petición cuenta contra el límite de la red antes de leer nada.
 */
export default async function GateEventPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string; gateCode: string }> }) {
  const { locale, orgSlug, gateCode } = await params;
  setRequestLocale(locale);
  if (!GATE_CODE_PATTERN.test(gateCode)) notFound();
  const t = await getTranslations({ locale, namespace: 'gate' });
  const access = await resolveGateAccess(gateCode);
  if (access.status === 'BUSY') {
    return (
      <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
        <EmptyState title={t('busyTitle')} description={t('errors.BUSY')} />
      </div>
    );
  }
  const now = new Date();
  const event = await getPrisma().initiative.findFirst({
    where: { gateCode, format: 'TICKETING', organization: { slug: orgSlug, archivedAt: null } },
    select: { id: true, title: true, organizationId: true, ticketSubtype: true, gatePinHash: true, gatePinExpiresAt: true }
  });
  if (!event) notFound();
  const inside = access.status === 'OK' && access.event.initiativeId === event.id && access.event.organizationId === event.organizationId;
  const pinActive = event.gatePinHash !== null && event.gatePinExpiresAt !== null && event.gatePinExpiresAt > now;
  if (!inside && !pinActive) notFound();
  const summary = inside && access.status === 'OK' ? await getGateSummary(access.db, access.actor, access.event) : null;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-corp break-words text-2xl font-extrabold">{event.title}</h1>
      {summary ? (
        event.ticketSubtype === 'RAFFLE' ? (
          <section aria-labelledby="gate-raffle" className="flex flex-col gap-4 rounded-2xl bg-varsity-ivory p-5 text-ink">
            <h2 id="gate-raffle" className="font-corp text-lg font-extrabold text-varsity-navy">
              {t('raffleTitle')}
            </h2>
            <p>{t('raffleText')}</p>
            <Link href={`/panel/${orgSlug}/porteria/${gateCode}/sorteo`} className="tactile-btn w-full justify-center" data-testid="gate-raffle-link">
              {t('raffleOpen')}
            </Link>
            <LeaveGateButton eventId={event.id} />
          </section>
        ) : (
          <GateScanner eventId={event.id} initialSummary={summary} />
        )
      ) : (
        <GatePinForm gateCode={gateCode} />
      )}
    </div>
  );
}

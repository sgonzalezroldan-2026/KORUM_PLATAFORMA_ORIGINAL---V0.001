import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { GatePinForm, LeaveGateButton } from '@/components/panel/gate-pin-form';
import { getEnv } from '@/config/env';
import { getGateSummary } from '@/core/ticketing/check-in.service';
import { resolveGateSession } from '@/core/ticketing/gate-session.service';
import type { Locale } from '@/i18n/routing';
import { currentRequestMeta } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { readGateToken } from '../gate-cookie';

export const dynamic = 'force-dynamic';

/**
 * Puerta de un evento (QA-SEC05). Sin sesión de portería válida para **este** evento se pide el PIN; con ella, el aforo en directo y nada
 * más: ni importes, ni datos de las personas, ni ajustes. El lector de QR y el sorteo llegan con la ficha 4.5.
 */
export default async function GateEventPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string; eventId: string }> }) {
  const { locale, orgSlug, eventId } = await params;
  setRequestLocale(locale);
  const id = Number(eventId);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const db = getPrisma();
  const event = await db.initiative.findFirst({ where: { id, format: 'TICKETING', gatePinHash: { not: null }, gatePinExpiresAt: { gt: new Date() }, organization: { slug: orgSlug, archivedAt: null } }, select: { id: true, title: true, organizationId: true } });
  if (!event) notFound();
  const t = await getTranslations({ locale, namespace: 'gate' });
  const token = await readGateToken();
  const actor = token ? await resolveGateSession(db, getEnv().DATA_HMAC_SECRET, token, await currentRequestMeta()) : null;
  const inside = actor !== null && actor.initiativeId === event.id && actor.organizationId === event.organizationId;
  const summary = inside ? await getGateSummary(db, actor, { organizationId: event.organizationId, initiativeId: event.id }) : null;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-corp text-2xl font-extrabold">{event.title}</h1>
      {summary ? (
        <section aria-labelledby="gate-capacity" className="flex flex-col gap-4 rounded-2xl bg-varsity-ivory p-5 text-ink">
          <h2 id="gate-capacity" className="font-corp text-lg font-extrabold text-varsity-navy">
            {t('capacityTitle')}
          </h2>
          <p role="status" className="font-corp text-4xl font-extrabold tabular-nums text-varsity-emerald">
            {t('capacity', { checkedIn: summary.checkedIn, capacity: summary.capacity })}
          </p>
          <p className="text-sm text-ink-soft">{t('insideHint')}</p>
          <LeaveGateButton />
        </section>
      ) : (
        <GatePinForm eventId={event.id} />
      )}
    </div>
  );
}

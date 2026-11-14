import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RaffleStage } from '@/components/gate/raffle-stage';
import { EmptyState } from '@/components/ui/empty-state';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { loadRaffleView } from '@/core/ticketing/raffle-state.service';
import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { resolveGateAccess } from '../../gate-request';

export const dynamic = 'force-dynamic';

/** Título propio de la pestaña (WCAG 2.4.2; antes heredaba el genérico de KORUM, auditoría de experiencia del 5.5a). */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'gate.raffle' });
  return { title: t('title') };
}

/**
 * Sorteo certificado de una rifa (QA-S04, QA-REG01), para proyectar en la fiesta. Solo con sesión de portería de este evento; sin ella vuelve a pedir el PIN.
 * La dirección lleva el código de la puerta. La pantalla no muestra datos de nadie: la papeleta ganadora se anuncia por su número.
 */
export default async function RafflePage({ params }: { params: Promise<{ locale: Locale; orgSlug: string; gateCode: string }> }) {
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
  if (access.status !== 'OK') return redirect({ href: `/panel/${orgSlug}/porteria/${gateCode}`, locale });
  const view = await loadRaffleView(access.db, access.actor, access.event);

  return (
    <div className="flex flex-col gap-5">
      <RaffleStage eventId={access.event.initiativeId} initial={view} />
      <Link href={`/panel/${orgSlug}/porteria/${gateCode}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4 print:hidden">
        {t('raffleBack')}
      </Link>
    </div>
  );
}

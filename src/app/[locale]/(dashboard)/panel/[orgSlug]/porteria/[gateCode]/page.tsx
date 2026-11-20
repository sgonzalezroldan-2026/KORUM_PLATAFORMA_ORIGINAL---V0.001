import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { GateScanner } from '@/components/gate/gate-scanner';
import { VoucherStation } from '@/components/gate/voucher-station';
import { GatePinForm } from '@/components/panel/gate-pin-form';
import { EmptyState } from '@/components/ui/empty-state';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { getGateSummary } from '@/core/ticketing/check-in.service';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { resolveGateAccess } from '../gate-request';

export const dynamic = 'force-dynamic';

/** Título propio de la pestaña (WCAG 2.4.2; antes heredaba el genérico de KORUM, auditoría de experiencia del 5.5a). */
export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'gate' });
  return { title: t('metaTitle') };
}

/**
 * Puerta de un evento (QA-SEC05, QA-S04). La dirección lleva el **código de la puerta** (no adivinable), no el identificador numérico. Sin sesión de portería válida
 * para **este** evento se pide el PIN; con ella, el lector de entradas con el aforo en directo y nada más: ni importes, ni datos
 * de las personas, ni ajustes. Una sesión ya abierta sigue valiendo aunque el PIN se haya revocado por abuso: la puerta no debe pararse por un ataque. Cada
 * petición cuenta contra el límite de la red antes de leer nada. Desde el Sprint 5.14c, el enlace de una venta de vales abre su **puesto de canje**: se lee el QR,
 * se ve cuántos vales quedan y se teclea cuántos se gastan.
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
    select: { id: true, title: true, organizationId: true, gatePinHash: true, gatePinExpiresAt: true, ticketSubtype: true, voucherValidUntil: true }
  });
  if (!event) notFound();
  const inside = access.status === 'OK' && access.event.initiativeId === event.id && access.event.organizationId === event.organizationId;
  const pinActive = event.gatePinHash !== null && event.gatePinExpiresAt !== null && event.gatePinExpiresAt > now;
  // Un puesto de vales cerrado (PIN cambiado, venta cancelada o vales caducados) lo dice en lenguaje llano a quien tenía su enlace; la portería de un evento
  // sigue respondiendo como inexistente.
  if (!inside && !pinActive && event.ticketSubtype === 'VOUCHER') {
    return (
      <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
        <EmptyState title={t('vouchers.closed.title')} description={t('vouchers.closed.text')} headingLevel={1} />
      </div>
    );
  }
  if (!inside && !pinActive) notFound();
  const vouchers = event.ticketSubtype === 'VOUCHER' && event.voucherValidUntil !== null;
  const summary = inside && access.status === 'OK' && !vouchers ? await getGateSummary(access.db, access.actor, access.event) : null;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-corp wrap-break-word text-2xl font-extrabold">{event.title}</h1>
      {inside && vouchers ? (
        <VoucherStation saleId={event.id} validUntil={event.voucherValidUntil!.toISOString()} />
      ) : summary ? (
        <GateScanner eventId={event.id} initialSummary={summary} />
      ) : (
        <GatePinForm gateCode={gateCode} vouchers={vouchers} />
      )}
    </div>
  );
}

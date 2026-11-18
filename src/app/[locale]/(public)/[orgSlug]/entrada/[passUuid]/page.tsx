import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { PassActions } from '@/components/checkout/pass-actions';
import { EmptyState } from '@/components/ui/empty-state';
import { buildPassQrPayload, verifyPassViewSignature } from '@/core/ticketing/qr-signature';
import { getEnv } from '@/config/env';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { passPath } from '@/lib/seo/portal-routes';
import { getPassForView } from '@/repositories/public.repository';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.pass' });
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** El pase, solo con su firma de visualización válida. Sin ella, de otra entidad o inexistente: `null`, sin distinguir. */
async function authorizedPass(orgSlug: string, passUuid: string, rawSignature: string | string[] | undefined) {
  const signature = typeof rawSignature === 'string' ? rawSignature : '';
  const authorized = UUID.test(passUuid) && VIEW_SIGNATURE.test(signature) && verifyPassViewSignature(getEnv().QR_HMAC_SECRET, passUuid, signature);
  return authorized ? getPassForView(getPrisma(), orgSlug, passUuid) : null;
}

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; passUuid: string }>;
  searchParams: Promise<{ sig?: string | string[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEW_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Pase del invitado (Sprint 3.3), imprimible y con envío por WhatsApp (Sprint 3.4; la celebración está en la vuelta del pago). El enlace lleva la firma de **visualización**
 * (`verifyPassViewSignature`), distinta de la del QR de la puerta: aquí nunca se acepta la firma de la puerta y el QR solo se compone en el
 * servidor después de comprobar esta. Enlace sin firma válida, pase de otra entidad o inexistente responden lo mismo: no se revela cuál es.
 */
export default async function PassPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, passUuid } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'portal.pass' });
  const format = await getFormatter({ locale });
  const rawSignature = (await searchParams).sig;
  const signature = typeof rawSignature === 'string' ? rawSignature : '';
  const secret = getEnv().QR_HMAC_SECRET;

  const pass = await authorizedPass(orgSlug, passUuid, rawSignature);

  if (!pass) {
    return <EmptyState icon="🎟️" title={t('invalid.title')} description={t('invalid.description')} headingLevel={1} role="alert" />;
  }
  if (pass.revokedAt) {
    return <EmptyState icon="↩️" title={t('revoked.title')} description={t('revoked.description')} headingLevel={1} role="alert" />;
  }

  // Un SVG de la propia biblioteca de QR (sin datos del usuario en el marcado): se incrusta tal cual.
  const qrSvg = await QRCode.toString(buildPassQrPayload(secret, pass.uuid), { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  // La fecha del evento es cuándo se celebra.
  const when = format.dateTime(pass.initiative.closesAt, { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid' });

  return (
    <section className="korum-trust-vault mx-auto max-w-md space-y-4 p-6 text-center" aria-labelledby="pass-title">
      <h1 id="pass-title" className="font-joy text-2xl font-bold text-varsity-navy">
        <span aria-hidden="true">{'🎟️ '}</span>
        {t('title')}
      </h1>
      <p className="font-corp text-lg font-extrabold text-varsity-navy">{pass.initiative.title}</p>
      <p className="text-sm text-ink-soft">
        {[pass.initiative.organization.name, when, pass.initiative.ticketVenue].filter(Boolean).join(' · ')}
      </p>
      <div role="img" aria-label={t('qrAlt')} className="mx-auto w-64 max-w-full rounded-xl border-2 border-varsity-navy bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <p className="font-bold text-varsity-navy">{t('quantity', { count: pass.quantity })}</p>
      <p className="font-mono text-sm text-ink-soft">{t('serial', { serial: pass.serialCode })}</p>
      <p className="text-sm font-semibold text-emerald-900">{t('show')}</p>
      <PassActions title={pass.initiative.title} url={`${absoluteUrl(locale, passPath(orgSlug, pass.uuid))}?sig=${signature}`} />
    </section>
  );
}

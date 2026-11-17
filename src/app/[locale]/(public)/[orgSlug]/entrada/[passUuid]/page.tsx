import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { PassActions } from '@/components/checkout/pass-actions';
import { EmptyState } from '@/components/ui/empty-state';
import { buildPassQrPayload, verifyPassViewSignature } from '@/core/ticketing/qr-signature';
import { raffleOutcomeForPass } from '@/core/ticketing/raffle-pass-outcome';
import { getEnv } from '@/config/env';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { passPath } from '@/lib/seo/portal-routes';
import { getPassForView } from '@/repositories/public.repository';

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale, orgSlug, passUuid } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.pass' });
  // El título de la pestaña distingue entrada de papeletas solo si el enlace es válido (misma comprobación que la página): sin firma, el genérico.
  const pass = await authorizedPass(orgSlug, passUuid, (await searchParams).sig);
  return { title: t(pass?.subtype === 'RAFFLE' ? 'titleRaffle' : 'title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
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
    // Una rifa no tiene puerta: sus papeletas anuladas dejan de valer para el sorteo (Sprint 5.9).
    const revokedKey = pass.subtype === 'RAFFLE' ? 'revokedRaffle' : 'revoked';
    return <EmptyState icon="↩️" title={t(`${revokedKey}.title`)} description={t(`${revokedKey}.description`)} headingLevel={1} role="alert" />;
  }

  // Un SVG de la propia biblioteca de QR (sin datos del usuario en el marcado): se incrusta tal cual.
  const qrSvg = await QRCode.toString(buildPassQrPayload(secret, pass.uuid), { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  // Una papeleta no abre ninguna puerta (la rifa no usa lector): sus textos hablan de papeletas y de recoger el premio, no de entrar (repaso del Sprint 5.6).
  const raffle = pass.subtype === 'RAFFLE';
  // La fecha de un evento es cuándo se celebra; la de una rifa, el día del sorteo, y se dice (sin hora: la pone la entidad en su acto).
  const when = raffle
    ? t('drawOn', { date: format.dateTime(pass.initiative.closesAt, { dateStyle: 'full', timeZone: 'Europe/Madrid' }) })
    : format.dateTime(pass.initiative.closesAt, { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid' });

  // Solo una rifa: si ya hubo sorteo y si alguno de sus números ha salido (solo números de las actas, nunca personas).
  const outcome = raffle
    ? raffleOutcomeForPass({
        numbers: pass.raffleNumbers,
        prizeCount: pass.initiative.rafflePrizeCount,
        draws: pass.initiative.raffleDraws.map((draw) => ({ winningNumbers: draw.winningNumbers, replacedNumbers: draw.replacedNumbers, extra: draw.extraRoundReason !== null }))
      })
    : null;

  return (
    <section className="korum-trust-vault mx-auto max-w-md space-y-4 p-6 text-center" aria-labelledby="pass-title">
      <h1 id="pass-title" className="font-joy text-2xl font-bold text-varsity-navy">
        <span aria-hidden="true">{'🎟️ '}</span>
        {raffle ? t('titleRaffle') : t('title')}
      </h1>
      <p className="font-corp text-lg font-extrabold text-varsity-navy">{pass.initiative.title}</p>
      <p className="text-sm text-ink-soft">
        {[pass.initiative.organization.name, when, pass.initiative.ticketVenue].filter(Boolean).join(' · ')}
      </p>
      <div role="img" aria-label={t(raffle ? 'qrAltRaffle' : 'qrAlt')} className="mx-auto w-64 max-w-full rounded-xl border-2 border-varsity-navy bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <p className="font-bold text-varsity-navy">{t(raffle ? 'quantityRaffle' : 'quantity', { count: pass.quantity })}</p>
      {raffle && pass.raffleNumbers.length > 0 ? (
        <div>
          <p className="text-sm font-bold text-ink-soft">{t('numbers', { count: pass.raffleNumbers.length })}</p>
          <p className="font-corp text-lg font-extrabold tabular-nums text-varsity-navy">{pass.raffleNumbers.join(' · ')}</p>
        </div>
      ) : null}
      {outcome ? (
        <p
          role="status"
          data-testid="raffle-outcome"
          data-state={outcome.state}
          className={`rounded-xl border-2 p-3 text-sm font-bold ${outcome.state === 'WON' ? 'border-emerald-700 bg-emerald-50 text-emerald-950' : 'border-patio-rule-strong bg-patio-cream text-varsity-navy'}`}
        >
          <span aria-hidden="true">{outcome.state === 'WON' ? '🎉 ' : '🎟️ '}</span>
          {outcome.state === 'WON' || outcome.state === 'REPLACED'
            ? t(`outcome.${outcome.state === 'WON' ? 'won' : 'replaced'}`, { count: outcome.numbers.length, numbers: outcome.numbers.join(' · ') })
            : t(`outcome.${outcome.state === 'NOT_DRAWN' ? 'notDrawn' : outcome.state === 'IN_PROGRESS' ? 'inProgress' : 'notWon'}`)}
        </p>
      ) : null}
      <p className="font-mono text-sm text-ink-soft">{t('serial', { serial: pass.serialCode })}</p>
      {/* El pie solo aparece cuando sigue siendo útil: con el sorteo completo y ningún número suyo, «guárdalas por si sale» contradice al resultado (Sprint 5.9). */}
      {raffle && (outcome?.state === 'NOT_WON' || outcome?.state === 'REPLACED') ? null : (
        <p className="text-sm font-semibold text-emerald-900">
          {raffle ? (outcome?.state === 'WON' ? t('showRaffleWon', { count: outcome.numbers.length }) : t('showRaffle', { count: pass.quantity })) : t('show')}
        </p>
      )}
      <PassActions raffle={raffle} title={pass.initiative.title} url={`${absoluteUrl(locale, passPath(orgSlug, pass.uuid))}?sig=${signature}`} />
    </section>
  );
}

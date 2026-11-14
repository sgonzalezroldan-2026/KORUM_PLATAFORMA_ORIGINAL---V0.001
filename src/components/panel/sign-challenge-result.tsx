'use client';

import { useTranslations } from 'next-intl';
import type { RefObject } from 'react';
import type { SignResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/firmar/actions';
import { Confetti } from '@/components/checkout/checkout-celebration';
import { Link } from '@/i18n/navigation';

/**
 * Resultado de una firma (Sprint 4.2a; separado del formulario en el 4.4a). Dice qué ha pasado con lo firmado: la idea convertida, la liquidación del Fondo
 * (4.2f) o la de una campaña (4.4a). Si las dos firmas cuentan pero el dinero no sale, título propio y tono de atención, no de éxito.
 */

type Done = Extract<SignResult, { status: 'SIGNED' }>;

/** Qué ha pasado con una liquidación del Fondo al completarse las dos firmas (Sprint 4.2f), como clave de `panel.sign.done.fund`. */
function fundOutcome(done: Done): string | null {
  if (!done.fund || !done.complete) return null;
  const settlement = done.fund.settlement;
  if (!settlement) return 'pending';
  if (settlement.status === 'EXECUTED') return 'executed';
  if (settlement.status === 'NOT_APPROVED') {
    if (settlement.reason === 'FUND_CHANGED') return 'changed';
    if (settlement.reason === 'WINDOW_EXPIRED') return 'expired';
    return settlement.reason === 'KYB_NOT_VERIFIED' || settlement.reason === 'DESTINATION_ACCOUNT_MISSING' ? 'blocked' : 'pending';
  }
  return 'pending';
}

/** Lo mismo para la liquidación de una campaña (Sprint 4.4a), como clave de `panel.sign.done.payout`. */
function payoutOutcome(done: Done): string | null {
  if (!done.payout || !done.complete) return null;
  const settlement = done.payout.settlement;
  if (!settlement) return 'pending';
  if (settlement.status === 'EXECUTED') return 'executed';
  if (settlement.status !== 'NOT_APPROVED') return 'pending';
  switch (settlement.reason) {
    case 'FIGURES_CHANGED':
    case 'ESCROW_MISMATCH':
      return 'changed';
    case 'KYB_NOT_VERIFIED':
    case 'DESTINATION_ACCOUNT_MISSING':
      return 'blocked';
    case 'NOT_GOAL':
    case 'RAFFLE_NOT_DRAWN':
    case 'SPONSORS_PENDING':
      return 'notReady';
    case 'INVOICE_INVALID':
      return 'invoice';
    case 'PROVIDER_UNAVAILABLE':
      return 'provider';
    case 'WINDOW_EXPIRED':
      return 'expired';
    default:
      return 'pending';
  }
}

const WARNINGS = new Set(['changed', 'blocked', 'expired', 'notReady', 'invoice', 'provider']);

export function SignChallengeResult({ orgSlug, done, resultRef }: { orgSlug: string; done: Done; resultRef: RefObject<HTMLHeadingElement | null> }) {
  const t = useTranslations('panel.sign');
  const fundKey = fundOutcome(done);
  const payoutKey = payoutOutcome(done);
  const family = fundKey ? 'fund' : payoutKey ? 'payout' : null;
  const outcome = fundKey ?? payoutKey;
  const warning = outcome !== null && WARNINGS.has(outcome);
  // Dos firmas, pero el dinero aún no ha salido: tono informativo, para que «completa» no se lea como «enviado».
  const info = !warning && outcome === 'pending';
  const celebrate = done.complete && (done.initiativeId !== null || payoutKey === 'executed');
  const backHref =
    outcome === 'blocked' ? `/panel/${orgSlug}/ajustes#documentos` : done.fund ? `/panel/${orgSlug}/fondo` : done.payout ? `/panel/${orgSlug}/liquidaciones` : `/panel/${orgSlug}/aprobaciones`;
  const cta = outcome === 'blocked' ? 'done.ctaDocuments' : done.fund ? 'done.ctaFund' : done.payout ? 'done.ctaPayouts' : 'done.cta';

  return (
    <section
      className={
        warning
          ? 'flex flex-col gap-3 rounded-2xl border-2 border-amber-400 bg-amber-50 p-5'
          : info
            ? 'korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-varsity-ivory p-5'
            : 'korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-emerald bg-emerald-50 p-5'
      }
      data-testid="sign-done"
    >
      {/* Una idea convertida o una campaña liquidada: momento de celebración. El confeti solo se pinta con movimiento permitido. */}
      {celebrate ? <Confetti /> : null}
      <h1 ref={resultRef} tabIndex={-1} className={warning ? 'font-corp text-2xl font-extrabold text-amber-950' : info ? 'font-corp text-2xl font-extrabold text-varsity-navy' : 'font-corp text-2xl font-extrabold text-emerald-950'}>
        {warning && family ? t(`done.${family}.${outcome}Title`) : done.complete ? t('done.completeTitle') : t('done.partialTitle')}
      </h1>
      {/* Sello de tampón (EXPERIENCIA §6): la firma ya se anuncia en el título, así que el sello es decorativo. Nunca en un aviso. */}
      {/* Con las dos firmas pero el dinero aún sin salir (tono informativo), el sello dice «Firmado», no «Aprobado»: no debe leerse como «hecho». */}
      {!warning ? (
        <p aria-hidden="true" className="korum-stamp-badge korum-stamp-in self-start text-lg uppercase" data-testid="sign-stamp">
          {done.complete && !info ? t('done.stamp.complete') : t('done.stamp.partial')}
        </p>
      ) : null}
      {celebrate ? (
        <p className="die-cut-sticker korum-sticker-pop self-start font-joy text-lg font-bold text-varsity-navy">
          <span aria-hidden="true">{'🎉 '}</span>
          {t(done.initiativeId !== null ? 'done.celebrate' : 'done.payout.celebrate')}
        </p>
      ) : null}
      <p>
        {done.complete
          ? done.initiativeId !== null
            ? t('done.completeIdea')
            : family && outcome
              ? t(`done.${family}.${outcome}`)
              : t('done.completePayout')
          : done.otherSignerNotified
            ? t('done.partialNotified')
            : t('done.partialWaiting')}
      </p>
      <Link href={backHref} className="tactile-btn justify-center">
        {t(cta)}
      </Link>
      {payoutKey === 'executed' ? (
        <Link href={`/panel/${orgSlug}/logros`} className="inline-flex min-h-11 items-center justify-center font-bold text-varsity-navy underline underline-offset-4">
          {t('done.payout.photosCta')}
        </Link>
      ) : null}
    </section>
  );
}

'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { approveSponsorAction, rejectSponsorAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { CurrencyText } from '@/components/ui/currency-text';
import { formatCents } from '@/core/finance/money';
import { SPONSOR_REJECTION_REASON_MAX, SPONSOR_REJECTION_REASON_MIN } from '@/core/sponsors/sponsor-moderation-rules';
import type { ModerationSponsorView } from '@/services/panel/sponsor-moderation-data';
import { useApprovalsNotice } from './approvals-notice';
import { SponsorLogoForm } from './sponsor-logo-form';
import { SponsorMoneyDetail } from './sponsor-money-detail';

/**
 * Un comercio amigo en la bandeja de aprobaciones (`id="sch-sponsors-moderation-list"`, `function moderateSponsor` del prototipo). Enseña lo que la
 * entidad necesita para decidir: quién es, qué ventaja ofrece, a qué iniciativa va su dinero y cuánto, y a quién llamar. Aprobar lo publica 12 meses
 * (y activa su bolsa Matching 2x, si la eligió); no admitirlo pide un motivo, que el comercio lee en su email, y le devuelve el 100 % de lo pagado.
 */

const BADGE: Record<string, string> = { ORO: '🥇', PLATA: '🥈', BRONCE: '🥉' };

export function SponsorModerationCard({ orgSlug, sponsor, canModerate, maxLogoBytes }: { orgSlug: string; sponsor: ModerationSponsorView; canModerate: boolean; maxLogoBytes: number }) {
  const t = useTranslations('panel.sponsors');
  const tErrors = useTranslations('panel.approvals.errors');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const announce = useApprovalsNotice();
  const ids = {
    heading: useId(),
    reason: useId(),
    reasonHelp: useId(),
    reasonError: useId()
  };
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const openRejectButton = useRef<HTMLButtonElement>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: 'medium',
      timeZone: 'Europe/Madrid'
    });
  const money = (cents: number) => formatCents(cents, locale as 'es' | 'ca' | 'en');

  function act(operation: () => ReturnType<typeof approveSponsorAction>, success: string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.status === 'ERROR') setError(result.reason === 'INVALID_INPUT' ? t('reject.tooShort', { min: SPONSOR_REJECTION_REASON_MIN }) : tErrors(result.reason));
        else {
          announce(success);
          setRejecting(false);
          router.refresh();
        }
      } catch {
        setError(tErrors('failed'));
      }
    });
  }

  const approve = () =>
    act(() => approveSponsorAction(orgSlug, { sponsorId: sponsor.id }), sponsor.matching ? t('notices.approvedMatching', { name: sponsor.name }) : t('notices.approved', { name: sponsor.name }));
  const reject = (event: React.FormEvent) => {
    event.preventDefault();
    // El error del motivo va dentro del formulario y asociado al campo (Regla 03 §8): el foco vuelve al campo, que lo anuncia.
    if (reason.trim().length < SPONSOR_REJECTION_REASON_MIN) {
      setReasonError(t('reject.tooShort', { min: SPONSOR_REJECTION_REASON_MIN }));
      reasonField.current?.focus();
      return;
    }
    setReasonError(null);
    act(
      () => rejectSponsorAction(orgSlug, { sponsorId: sponsor.id, reason }),
      t('notices.rejected', {
        name: sponsor.name,
        amount: money(sponsor.refundCents)
      })
    );
  };
  const active = sponsor.status === 'PENDING' || sponsor.status === 'APPROVED' || sponsor.status === 'CREDIT_POOL';
  // Si su dinero ya salió de la campaña que eligió (reasignado o en su bolsa, Sprint 4.2d), dónde está lo cuenta la ficha: aquí no se nombra esa campaña.
  const inOrigin = sponsor.needsDecision || sponsor.money.originCents > 0;
  const returned = sponsor.status === 'REJECTED' || sponsor.status === 'REFUNDED';
  const cancelReject = () => {
    setRejecting(false);
    setReasonError(null);
    setError(null);
    requestAnimationFrame(() => openRejectButton.current?.focus());
  };

  return (
    <article aria-labelledby={ids.heading} className="flex flex-col gap-3 rounded-2xl border-2 border-stone-200 bg-white p-4" data-testid="moderation-sponsor" data-status={sponsor.status}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- logotipo público servido por /api/files/public */}
          {sponsor.logoSrc ? <img src={sponsor.logoSrc} alt="" className="size-12 shrink-0 rounded-lg border border-stone-200 object-contain" /> : null}
          <h3 id={ids.heading} className="min-w-0 wrap-anywhere font-corp text-lg font-extrabold text-varsity-navy">
            <span aria-hidden="true">{`${BADGE[sponsor.level] ?? '🏪'} `}</span>
            {sponsor.name}
          </h3>
        </div>
        <span className="rounded-full border-2 border-varsity-navy/30 bg-varsity-ivory px-3 py-1 text-sm font-bold text-varsity-navy">
          {t(`status.${sponsor.needsDecision ? 'PENDING' : sponsor.status === 'PENDING' ? 'UNPAID' : sponsor.renewed ? 'RENEWED' : sponsor.status}`)}
        </span>
      </header>
      <p className="text-sm text-ink-soft">
        {sponsor.paidAt
          ? t('meta', {
              level: t(`level.${sponsor.level}`),
              sector: sponsor.sector || t('sectorFallback'),
              date: date(sponsor.paidAt)
            })
          : t('metaUnpaid', {
              level: t(`level.${sponsor.level}`),
              sector: sponsor.sector || t('sectorFallback')
            })}
      </p>

      <dl className="korum-trust-vault grid gap-2 p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-bold text-ink-soft">{t(returned ? 'returnedAmount' : !inOrigin ? 'moved' : sponsor.matching ? 'toPool' : 'toEscrow')}</dt>
          <dd className="flex flex-wrap items-baseline gap-1">
            <CurrencyText cents={sponsor.amountCents} className="font-corp text-lg font-extrabold text-varsity-emerald" />
            {sponsor.initiative && (returned || inOrigin) ? (
              <span className="wrap-anywhere text-ink">
                {t('forInitiative', {
                  title: sponsor.initiative.title,
                  wallet: sponsor.initiative.walletEscrowId
                })}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-ink-soft">{t('feeLabel')}</dt>
          <dd className="tabular-nums text-ink">
            {t('feeValue', {
              fee: money(sponsor.feeCents),
              vat: money(sponsor.vatCents)
            })}
          </dd>
        </div>
      </dl>

      <dl className="grid gap-1 text-sm sm:grid-cols-2">
        {sponsor.email ? (
          <div>
            <dt className="font-bold text-ink-soft">{t('contact')}</dt>
            <dd className="wrap-anywhere">
              {`${sponsor.contactPerson} · `}
              <a href={`tel:${sponsor.phone.replace(/[^\d+]/g, '')}`} className="font-semibold text-sky-800 underline">
                {sponsor.phone}
              </a>
              {' · '}
              <a href={`mailto:${sponsor.email}`} className="font-semibold text-sky-800 underline">
                {sponsor.email}
              </a>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-bold text-ink-soft">{t('promo')}</dt>
          <dd className="wrap-anywhere">
            {sponsor.promo
              ? sponsor.code
                ? t('promoWithCode', {
                    promo: sponsor.promo,
                    code: sponsor.code
                  })
                : sponsor.promo
              : t('promoNone')}
          </dd>
        </div>
      </dl>
      {/* La renovación solo tiene sentido para un comercio vigente o por decidir: en uno devuelto sería falso. */}
      {/* Ya renovado: su año nuevo es otra tarjeta, y esta ya no está visible ni se renueva (revisión de experiencia del 4.2d). */}
      {sponsor.renewed ? <p className="text-sm text-ink-soft">{t('renewedElsewhere')}</p> : null}
      {!sponsor.renewed && (sponsor.status === 'APPROVED' || sponsor.status === 'CREDIT_POOL' || sponsor.needsDecision) ? (
        <p className="text-sm text-ink-soft">
          {sponsor.status === 'APPROVED' || sponsor.status === 'CREDIT_POOL' ? `${t('visibleUntil', { date: date(sponsor.expiresAt) })} ` : null}
          {t(sponsor.autoRenew ? 'renewalNotice' : 'renewalNone')}
        </p>
      ) : null}

      {canModerate && sponsor.needsDecision && !rejecting ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={approve} disabled={pending} className="tactile-btn disabled:opacity-60">
            <span aria-hidden="true">{'✅ '}</span>
            {t('approve')}
          </button>
          <button
            ref={openRejectButton}
            type="button"
            onClick={() => {
              setError(null);
              setRejecting(true);
              requestAnimationFrame(() => reasonField.current?.focus());
            }}
            disabled={pending}
            className="inline-flex min-h-11 items-center rounded-xl border-2 border-red-700 px-4 font-bold text-red-800 disabled:opacity-60"
          >
            <span aria-hidden="true">{'❌ '}</span>
            {t('reject.open')}
          </button>
        </div>
      ) : null}
      {canModerate && sponsor.needsDecision && rejecting ? (
        <form onSubmit={reject} className="flex flex-col gap-2 rounded-xl border-2 border-red-200 bg-red-50/40 p-3" noValidate>
          <label htmlFor={ids.reason} className="font-bold text-varsity-navy">
            {t('reject.label')}
          </label>
          <textarea
            ref={reasonField}
            id={ids.reason}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={SPONSOR_REJECTION_REASON_MIN}
            maxLength={SPONSOR_REJECTION_REASON_MAX}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? `${ids.reasonHelp} ${ids.reasonError}` : ids.reasonHelp}
            className="w-full rounded-lg border-2 border-varsity-navy bg-white p-2 text-base"
          />
          <p id={ids.reasonHelp} className="text-sm text-ink-soft">
            {t('reject.help', {
              min: SPONSOR_REJECTION_REASON_MIN,
              max: SPONSOR_REJECTION_REASON_MAX,
              amount: money(sponsor.refundCents)
            })}
          </p>
          {reasonError ? (
            <p id={ids.reasonError} role="alert" className="rounded-lg border-2 border-red-700 bg-red-50 p-2 text-sm font-semibold text-red-900">
              {reasonError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center rounded-xl bg-red-800 px-4 font-bold text-white disabled:opacity-60">
              {pending ? t('reject.sending') : t('reject.confirm', { amount: money(sponsor.refundCents) })}
            </button>
            <button type="button" onClick={cancelReject} disabled={pending} className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy">
              {t('reject.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      {!canModerate && sponsor.needsDecision ? <p className="text-sm text-ink-soft">{t('readOnly')}</p> : null}
      {error ? <FormAlert>{error}</FormAlert> : null}

      {active && sponsor.paidAt && !sponsor.needsDecision ? <SponsorMoneyDetail orgSlug={orgSlug} sponsor={sponsor} canModerate={canModerate} /> : null}

      {canModerate && active && sponsor.paidAt ? (
        <details className="rounded-xl border border-stone-200 p-3">
          <summary className="min-h-11 cursor-pointer font-bold text-varsity-navy">{t(sponsor.logoSrc ? 'logo.summaryReplace' : 'logo.summary')}</summary>
          <div className="pt-2">
            <SponsorLogoForm orgSlug={orgSlug} sponsorId={sponsor.id} sponsorName={sponsor.name} hasLogo={sponsor.logoSrc !== null} maxBytes={maxLogoBytes} />
          </div>
        </details>
      ) : null}
    </article>
  );
}

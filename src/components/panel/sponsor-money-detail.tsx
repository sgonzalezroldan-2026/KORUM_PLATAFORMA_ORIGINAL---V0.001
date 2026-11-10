'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { assignPooledSponsorAction, sendSponsorRenewalLinkAction } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/aprobaciones/actions';
import { FormAlert } from '@/components/auth/auth-ui';
import { formatCents } from '@/core/finance/money';
import type { ModerationSponsorView } from '@/services/panel/sponsor-moderation-data';
import { useApprovalsNotice } from './approvals-notice';

/**
 * Ficha del comercio (`function openSponsorDetailPopup` del prototipo, «🔍 Ficha / Renovar»), plegada dentro de su tarjeta: dónde está **ahora** su
 * dinero (su campaña, otras a las que se llevó o su bolsa con el plazo), su renovación anual y, para las dos personas firmantes, llevar lo que espera
 * en la bolsa a una campaña y enviarle el enlace de pago de la renovación. Nunca el CIF (decisión del 4.2b).
 */
export function SponsorMoneyDetail({ orgSlug, sponsor, canModerate }: { orgSlug: string; sponsor: ModerationSponsorView; canModerate: boolean }) {
  const t = useTranslations('panel.sponsors.detail');
  const tErrors = useTranslations('panel.approvals.errors');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const announce = useApprovalsNotice();
  const ids = { target: useId(), help: useId(), invite: useId() };
  const [chosen, setTarget] = useState<string>(String(sponsor.assignable[0]?.id ?? ''));
  // Si al recargar cambian las campañas elegibles, la elección vuelve a una que exista (se calcula, no se guarda dos veces).
  const target = sponsor.assignable.some((option) => String(option.id) === chosen) ? chosen : String(sponsor.assignable[0]?.id ?? '');
  const targetTitle = sponsor.assignable.find((option) => String(option.id) === target)?.title ?? '';
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const money = (cents: number) => formatCents(cents, locale as 'es' | 'ca' | 'en');
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Madrid' });
  const { originCents, placed, poolCents, poolDeadline, fundCents } = sponsor.money;

  function act(operation: () => ReturnType<typeof assignPooledSponsorAction>, success: (result: { title?: string }) => string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await operation();
        if (result.status === 'ERROR') setError(tErrors(result.reason));
        else {
          announce(success(result));
          router.refresh();
        }
      } catch {
        setError(tErrors('failed'));
      }
    });
  }

  const assign = (event: React.FormEvent) => {
    event.preventDefault();
    act(
      () => assignPooledSponsorAction(orgSlug, { sponsorId: sponsor.id, initiativeId: Number(target) }),
      (result) => t('assigned', { name: sponsor.name, amount: money(poolCents), title: result.title ?? '' })
    );
  };
  const sendLink = () => act(() => sendSponsorRenewalLinkAction(orgSlug, { sponsorId: sponsor.id }), () => t('linkSent', { name: sponsor.name }));
  const sendInvite = () => act(() => sendSponsorRenewalLinkAction(orgSlug, { sponsorId: sponsor.id }), () => t('inviteSent', { name: sponsor.name }));
  const nothingHeld = originCents === 0 && placed.length === 0 && poolCents === 0 && fundCents === 0;

  return (
    <details className="rounded-xl border border-stone-200 p-3" data-testid="sponsor-detail">
      <summary className="min-h-11 cursor-pointer font-bold text-varsity-navy">
        <span aria-hidden="true">{'🔍 '}</span>
        {t('summary')}
        <span className="sr-only">{` ${t('summaryFor', { name: sponsor.name })}`}</span>
      </summary>
      <div className="flex flex-col gap-3 pt-2 text-sm">
        <section className="korum-trust-vault flex flex-col gap-1 p-3">
          <h4 className="font-corp font-extrabold text-varsity-navy">{t('moneyTitle')}</h4>
          <ul className="flex flex-col gap-1 tabular-nums wrap-anywhere" data-testid="sponsor-money">
            {originCents > 0 && sponsor.initiative ? <li>{t('origin', { amount: money(originCents), title: sponsor.initiative.title, wallet: sponsor.initiative.walletEscrowId })}</li> : null}
            {placed.map((entry) => (
              <li key={entry.initiativeId}>{t('placed', { amount: money(entry.amountCents), title: entry.title, wallet: entry.walletEscrowId })}</li>
            ))}
            {poolCents > 0 ? <li className="font-semibold text-amber-950">{poolDeadline ? t('pool', { amount: money(poolCents), date: date(poolDeadline) }) : t('poolNoDate', { amount: money(poolCents) })}</li> : null}
            {fundCents > 0 ? <li className="font-semibold text-varsity-navy">{t('fund', { amount: money(fundCents) })}</li> : null}
            {nothingHeld ? <li>{t('nothingHeld')}</li> : null}
          </ul>
        </section>

        {canModerate && sponsor.status === 'CREDIT_POOL' && poolCents > 0 ? (
          sponsor.assignable.length > 0 ? (
            <form onSubmit={assign} className="flex flex-col gap-2" noValidate>
              <label htmlFor={ids.target} className="font-bold text-varsity-navy">
                {t('assignLabel')}
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  id={ids.target}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  aria-describedby={ids.help}
                  className="min-h-11 w-full max-w-full rounded-xl border-2 border-varsity-navy bg-white px-3 font-bold text-varsity-navy sm:w-auto"
                >
                  {sponsor.assignable.map((option) => (
                    <option key={option.id} value={option.id}>
                      {t('assignOption', { title: option.title, date: date(option.closesAt) })}
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={pending} className="tactile-btn wrap-anywhere disabled:opacity-60">
                  {pending ? t('assigning') : t('assign', { amount: money(poolCents), title: targetTitle })}
                </button>
              </div>
              <p id={ids.help} className="text-ink-soft">
                {t('assignHelp')}
              </p>
            </form>
          ) : (
            <p className="text-ink-soft">{t('noTargets')}</p>
          )
        ) : null}

        <section className="flex flex-col gap-1">
          <h4 className="font-corp font-extrabold text-varsity-navy">{t('renewalTitle')}</h4>
          {sponsor.isRenewal ? <p>{t('isRenewal')}</p> : null}
          <p>{sponsor.renewed ? t('renewed') : sponsor.autoRenew ? t('renewalAuto') : t('renewalOff')}</p>
          {canModerate && sponsor.renewalOpensAt ? <p className="text-ink-soft">{t('renewalOpensOn', { date: date(sponsor.renewalOpensAt) })}</p> : null}
          {canModerate && sponsor.renewalOpen ? (
            <button type="button" onClick={sendLink} disabled={pending} className="inline-flex min-h-11 items-center self-start rounded-xl border-2 border-varsity-emerald px-4 font-bold text-varsity-emerald disabled:opacity-60">
              <span aria-hidden="true">{'🔄 '}</span>
              {pending ? t('sending') : t('sendLink')}
            </button>
          ) : null}
          {canModerate && sponsor.renewalInvitable ? (
            <div className="flex flex-col gap-1">
              <button type="button" onClick={sendInvite} disabled={pending} aria-describedby={ids.invite} className="inline-flex min-h-11 items-center self-start rounded-xl border-2 border-varsity-emerald px-4 font-bold text-varsity-emerald disabled:opacity-60">
                <span aria-hidden="true">{'✉️ '}</span>
                {pending ? t('sending') : t('sendInvite')}
              </button>
              <p id={ids.invite} className="text-ink-soft">
                {t('inviteHelp')}
              </p>
            </div>
          ) : null}
          {sponsor.renewalInvitedAt && !sponsor.renewed ? <p className="text-ink-soft">{t('invitedOn', { date: date(sponsor.renewalInvitedAt) })}</p> : null}
        </section>
        {error ? <FormAlert>{error}</FormAlert> : null}
      </div>
    </details>
  );
}

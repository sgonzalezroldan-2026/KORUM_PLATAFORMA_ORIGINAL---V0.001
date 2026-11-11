'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { completeSignatureAction, previewSignatureAction, type PreviewResult, type SignResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/firmar/actions';
import { CodeField, FormAlert, primaryButton } from '@/components/auth/auth-ui';
import { useHydrated } from '@/components/ui/use-hydrated';
import { SignChallengeResult } from './sign-challenge-result';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';

/**
 * Firma en 1 clic desde el móvil (Sprint 4.2a, heredado del 2.6). El enlace del email lleva el token en el fragmento (`#t=…`): aquí se lee, se
 * borra de la barra (`history.replaceState`) y se guarda solo en esta pestaña (`sessionStorage`), para no perderlo si antes hay que iniciar
 * sesión o pasar el segundo factor. Primero se enseña **qué** se firma; después se pide el código de 6 dígitos del email.
 */

export type SignSessionState = 'LOGIN' | 'TWO_FACTOR' | 'READY';

const storageKey = (orgSlug: string) => `korum:double-check:${orgSlug}`;

function readStoredToken(orgSlug: string): string | null {
  try {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('t');
    if (fromHash) {
      window.sessionStorage.setItem(storageKey(orgSlug), fromHash);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return fromHash;
    }
    return window.sessionStorage.getItem(storageKey(orgSlug));
  } catch {
    return null;
  }
}

function forgetToken(orgSlug: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(orgSlug));
  } catch {
    // Sin almacenamiento (navegación privada estricta): no hay nada que borrar.
  }
}

type Preview = Extract<PreviewResult, { status: 'READY' }>;
type Done = Extract<SignResult, { status: 'SIGNED' }>;
const subscribeNever = () => () => undefined;

export function SignChallengeForm({ orgSlug, session, nextPath }: { orgSlug: string; session: SignSessionState; nextPath: string }) {
  const t = useTranslations('panel.sign');
  const format = useFormatter();
  const locale = useLocale();
  const hydrated = useHydrated();
  // El enlace vive en esta pestaña: leerlo no depende del servidor ni cambia el HTML de la hidratación.
  const token = useSyncExternalStore(
    subscribeNever,
    () => readStoredToken(orgSlug),
    () => null
  );
  const [preview, setPreview] = useState<Preview | 'INVALID' | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const resultRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!token || session !== 'READY') return;
    let active = true;
    previewSignatureAction(orgSlug, token)
      .then((result) => {
        if (!active) return;
        if (result.status === 'READY') setPreview(result);
        else {
          forgetToken(orgSlug);
          setPreview('INVALID');
        }
      })
      .catch(() => active && setLoadFailed(true));
    return () => {
      active = false;
    };
  }, [orgSlug, session, token, attempt]);

  const kind = !hydrated ? 'loading' : done ? 'done' : !token || preview === 'INVALID' ? 'missing' : session !== 'READY' ? 'session' : preview === null ? 'loading' : 'form';

  useEffect(() => {
    if (kind === 'done' || kind === 'missing') resultRef.current?.focus();
  }, [kind]);

  if (kind === 'session') {
    const href = session === 'LOGIN' ? { pathname: '/login', query: { next: nextPath } } : { pathname: '/acceso/doble-factor', query: { next: nextPath } };
    return (
      <section className="korum-trust-vault flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-5">
        <h1 className="font-corp text-2xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p>{t(session === 'LOGIN' ? 'needsLogin' : 'needsSecondFactor')}</p>
        <Link href={href} className="tactile-btn justify-center">
          {t(session === 'LOGIN' ? 'loginCta' : 'secondFactorCta')}
        </Link>
      </section>
    );
  }

  if (kind === 'loading' || (kind === 'form' && preview === null)) {
    // Siempre con su `h1`: también mientras se comprueba el enlace o si la comprobación falla (revisión de experiencia del 4.2a).
    return (
      <section className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy bg-white p-5">
        <h1 className="font-corp text-2xl font-extrabold text-varsity-navy">{t('title')}</h1>
        {loadFailed ? (
          <>
            <FormAlert>{t('errors.failed')}</FormAlert>
            <button
              type="button"
              className="tactile-btn justify-center"
              onClick={() => {
                setLoadFailed(false);
                setAttempt(attempt + 1);
              }}
            >
              {t('retry')}
            </button>
          </>
        ) : (
          <p role="status" className="text-ink-soft">
            {t('loading')}
          </p>
        )}
      </section>
    );
  }

  if (kind === 'missing') {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border-2 border-stone-300 bg-white p-5" data-testid="sign-missing">
        <h1 ref={resultRef} tabIndex={-1} className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('missing.title')}
        </h1>
        <p>{t('missing.body')}</p>
        <Link href={`/panel/${orgSlug}/aprobaciones`} className="tactile-btn justify-center">
          {t('missing.cta')}
        </Link>
      </section>
    );
  }

  if (done) return <SignChallengeResult orgSlug={orgSlug} done={done} resultRef={resultRef} />;

  if (preview === null || preview === 'INVALID') return null;
  const money = (cents: number) => formatCents(cents, isLocale(locale) ? locale : 'es');

  function sign(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(otp)) {
      setError(t('errors.otpFormat'));
      return;
    }
    startTransition(async () => {
      try {
        const result = await completeSignatureAction({ token, otp });
        if (result.status === 'SIGNED') {
          forgetToken(orgSlug);
          setDone(result);
        } else if (result.status === 'INVALID_OTP') {
          setOtp('');
          if (result.attemptsLeft <= 0) forgetToken(orgSlug);
          setError(result.attemptsLeft > 0 ? t('errors.otp', { count: result.attemptsLeft }) : t('errors.locked'));
        } else if (result.status === 'NOT_ALLOWED') setError(t(`blocked.${result.reason}`));
        else if (result.status === 'INVALID_INPUT') setError(t('errors.otpFormat'));
        else {
          forgetToken(orgSlug);
          setError(t(`errors.${result.status}`));
        }
      } catch {
        setError(t('errors.failed'));
      }
    });
  }

  return (
    <form onSubmit={sign} noValidate aria-busy={pending} className="korum-trust-vault flex flex-col gap-4 rounded-2xl border-2 border-varsity-navy bg-white p-5">
      <h1 className="font-corp text-2xl font-extrabold text-varsity-navy">{t('title')}</h1>
      <section aria-labelledby="sign-what" className="flex flex-col gap-1 rounded-xl border border-varsity-navy/20 bg-varsity-ivory p-4">
        <h2 id="sign-what" className="text-sm font-extrabold uppercase text-ink-soft">
          {t('what')}
        </h2>
        {preview.targetType === 'IDEA_APPROVAL' ? (
          <>
            <p className="wrap-break-word font-corp text-lg font-extrabold text-varsity-navy">{preview.idea.title}</p>
            <p className="text-sm text-ink-soft">
              {t('ideaMeta', {
                alias: preview.idea.alias,
                category: preview.idea.category,
                votes: preview.idea.verifiedVotes
              })}
            </p>
            {preview.idea.revalidatedVotes > 0 ? (
              <p className="text-sm font-semibold text-amber-950">{`⚠️ ${t('ideaRevalidated', { count: preview.idea.revalidatedVotes })}`}</p>
            ) : null}
            <p className="whitespace-pre-line wrap-break-word">{preview.idea.description}</p>
            <p className="text-sm font-semibold text-varsity-navy">{t('ideaEffect')}</p>
          </>
        ) : preview.targetType === 'ACTIVITY_FUND_PAYOUT' ? (
          <>
            <p className="font-corp text-lg font-extrabold text-varsity-navy">{t('fundTitle', { reference: preview.fund.reference })}</p>
            <p className="font-corp tabular-nums">{t('fundMeta', { amount: money(preview.fund.amountCents), count: preview.fund.sponsors })}</p>
            <p className="text-sm font-semibold text-ink-soft">{t('fundPurpose')}</p>
            <p className="whitespace-pre-line wrap-break-word">{preview.fund.purpose}</p>
            <p className="text-sm font-semibold text-varsity-navy">{t('fundEffect')}</p>
          </>
        ) : (
          <>
            <p className="wrap-break-word font-corp text-lg font-extrabold text-varsity-navy">{preview.payout.initiativeTitle}</p>
            <p className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy" data-testid="sign-payout-amount">
              {money(preview.payout.netPaidCents)}
            </p>
            <p className="font-corp tabular-nums">
              {t('payoutMeta', {
                wallet: preview.payout.walletEscrowId,
                amount: money(preview.payout.netPaidCents),
                destination: t(`destinations.${preview.payout.destinationType}`)
              })}
            </p>
            <p className="wrap-break-word text-sm" data-testid="sign-payout-beneficiary">
              {preview.payout.ibanLast4
                ? t('payoutBeneficiaryIban', { name: preview.payout.beneficiaryName, bank: preview.payout.ibanBank ?? '····', last4: preview.payout.ibanLast4 })
                : t('payoutBeneficiary', { name: preview.payout.beneficiaryName })}
            </p>
            {preview.payout.requestedBy ? (
              <p className="text-sm text-ink-soft" data-testid="sign-payout-requested">
                {t('payoutRequestedBy', {
                  name: preview.payout.requestedBy.name,
                  date: format.dateTime(new Date(preview.payout.requestedBy.at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' })
                })}
              </p>
            ) : null}
            {preview.payout.invoiceFileId ? (
              <a
                href={`/api/panel/liquidaciones/factura/${preview.payout.invoiceFileId}?orgSlug=${encodeURIComponent(orgSlug)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4"
              >
                {t('payoutInvoice')}
              </a>
            ) : null}
            <p className="text-sm font-semibold text-varsity-navy">{t('payoutEffect')}</p>
          </>
        )}
        <p className="text-sm text-ink-soft">
          {t('expires', {
            date: format.dateTime(new Date(preview.expiresAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'Europe/Madrid'
            })
          })}
        </p>
      </section>
      <CodeField label={t('otpLabel')} hint={t('otpHint')} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} />
      {error ? <FormAlert>{error}</FormAlert> : null}
      <button type="submit" className={primaryButton} disabled={pending}>
        {pending ? t('signing') : t('submit')}
      </button>
    </form>
  );
}

'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { revokeGateSessionAction, rotateGateCodeAction, setGatePinAction, type GateAdminResult } from '@/app/[locale]/(dashboard)/panel/[orgSlug]/(gestion)/taquilla/actions';
import { FormAlert, primaryButton, secondaryButton } from '@/components/auth/auth-ui';
import { getPathname, useRouter } from '@/i18n/navigation';
import type { GateEventView } from '@/repositories/gate-admin.repository';
import { GateRaffleAdmin } from './gate-raffle-admin';

/**
 * Un evento de taquilla en «Taquilla y portería»: PIN de la puerta (se enseña una vez; cambiarlo cierra las sesiones abiertas), enlace de la portería y los
 * móviles que están dentro, que se pueden cerrar uno a uno. Solo lo usan quienes firman, con segundo factor.
 */

export function GateAdminCard({ orgSlug, event, canAct }: { orgSlug: string; event: GateEventView; canAct: boolean }) {
  const t = useTranslations('panel.gate');
  const format = useFormatter();
  const router = useRouter();
  const locale = useLocale();
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<{ pin: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<GateAdminResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const rotateRef = useRef<HTMLButtonElement | null>(null);
  const rotateConfirmRef = useRef<HTMLDivElement | null>(null);

  const run = async (action: () => Promise<GateAdminResult>) => {
    setBusy(true);
    setError(null);
    const result = await action().catch(() => ({ status: 'ERROR', reason: 'FORBIDDEN' }) as const);
    setBusy(false);
    if (result.status === 'ERROR') setError(result);
    return result;
  };

  const createPin = async () => {
    const result = await run(() => setGatePinAction(orgSlug, event.id));
    setConfirmChange(false);
    if (result.status === 'OK' && result.pin && result.expiresAt) {
      setRevealed({ pin: result.pin, expiresAt: result.expiresAt });
      router.refresh();
    }
  };

  const rotateLink = async () => {
    const result = await run(() => rotateGateCodeAction(orgSlug, event.id));
    setConfirmRotate(false);
    setTimeout(() => rotateRef.current?.focus(), 0);
    if (result.status === 'OK') router.refresh();
  };

  const closeSession = async (id: string) => {
    const result = await run(() => revokeGateSessionAction(orgSlug, id));
    if (result.status === 'OK') router.refresh();
  };

  // Al pedir confirmación el foco pasa a ella (el botón que lo tenía desaparece).
  useEffect(() => {
    if (confirmChange) confirmRef.current?.querySelector('button')?.focus();
  }, [confirmChange]);
  useEffect(() => {
    if (confirmRotate) rotateConfirmRef.current?.querySelector('button')?.focus();
  }, [confirmRotate]);

  const copyPin = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.pin);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  // Crear un PIN cierra las sesiones abiertas: con móviles dentro (también tras una anulación por abuso) se pide confirmación.
  const needsConfirm = event.pinActive || event.sessions.length > 0;
  const date = format.dateTime(new Date(event.eventDate), { dateStyle: 'long' });
  const headingId = `gate-event-${event.id}`;
  const pinText = revealed ? revealed.pin : null;

  return (
    <li className="flex flex-col gap-4 rounded-2xl border-2 border-varsity-navy bg-white p-5" data-testid="gate-admin-event" aria-labelledby={headingId}>
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="font-corp wrap-break-word text-xl font-extrabold text-varsity-navy">
          {event.title}
        </h3>
        <p className="text-sm text-ink-soft">
          {[t(event.subtype === 'RAFFLE' ? 'kind.raffle' : 'kind.event'), date, event.venue].filter(Boolean).join(' · ')}
        </p>
        <p className="text-sm font-semibold tabular-nums">{event.ticketMax === null ? t('sold', { sold: event.ticketsSold }) : t('soldOf', { sold: event.ticketsSold, max: event.ticketMax })}</p>
      </div>

      {revealed ? (
        <div role="status" className="flex flex-col gap-2 rounded-xl border-2 border-varsity-emerald bg-emerald-50 p-4 text-emerald-950" data-testid="gate-admin-pin">
          <p className="font-bold">{t('pin.created')}</p>
          <p className="font-corp text-5xl font-extrabold tabular-nums tracking-[0.3em]">
            <span aria-hidden="true" data-testid="gate-admin-pin-digits">
              {pinText}
            </span>
            <span className="sr-only">{t('pin.digits', { pin: pinText!.split('').join(' ') })}</span>
          </p>
          <button type="button" className={secondaryButton} onClick={() => void copyPin()}>
            {copied ? t('pin.copied') : t('pin.copy')}
          </button>
          <p className="text-sm">{t('pin.once', { date: format.dateTime(new Date(revealed.expiresAt), { dateStyle: 'long', timeStyle: 'short' }) })}</p>
        </div>
      ) : (
        <p className="text-sm font-semibold" data-testid="gate-admin-pin-state">
          {event.pinActive && event.pinExpiresAt ? t('pin.active', { date: format.dateTime(new Date(event.pinExpiresAt), { dateStyle: 'long', timeStyle: 'short' }) }) : event.pinRevoked ? t('pin.revoked', { count: event.sessions.length }) : t('pin.none')}
        </p>
      )}
      {error ? <FormAlert>{t(`errors.${error.status === 'ERROR' ? error.reason : 'FORBIDDEN'}`)}</FormAlert> : null}

      {canAct ? (
        confirmChange ? (
          <div ref={confirmRef} role="alert" className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy p-3">
            <p className="font-semibold">{t('pin.changeWarning', { count: event.sessions.length })}</p>
            <button type="button" className={primaryButton} disabled={busy} onClick={() => void createPin()} data-testid="gate-admin-pin-confirm">
              {t('pin.changeConfirm')}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setConfirmChange(false);
                setTimeout(() => changeRef.current?.focus(), 0);
              }}
            >
              {t('pin.changeCancel')}
            </button>
          </div>
        ) : (
          <button ref={changeRef} type="button" className={event.pinActive ? secondaryButton : primaryButton} disabled={busy} onClick={() => (needsConfirm ? setConfirmChange(true) : void createPin())} data-testid="gate-admin-pin-button">
            {event.pinActive ? t('pin.change') : event.pinRevoked ? t('pin.createNew') : t('pin.create')}
          </button>
        )
      ) : (
        <p className="text-sm text-ink-soft">{t('readOnly')}</p>
      )}

      <p className="text-sm text-ink-soft">{t('link.hint')}</p>
      {/* Un enlace normal (página nueva), no la navegación interna de la aplicación: la cámara solo se concede a la página que se carga entera en la portería. */}
      {event.gateCode ? (
        <a href={getPathname({ href: `/panel/${orgSlug}/porteria/${event.gateCode}`, locale })} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline underline-offset-4" data-testid="gate-admin-link">
          {t('link.open')}
          <span className="sr-only">{t('link.newTab')}</span>
        </a>
      ) : (
        <p className="text-sm text-ink-soft">{t('link.afterPin')}</p>
      )}
      {event.gateCode && canAct ? (
        confirmRotate ? (
          <div ref={rotateConfirmRef} role="alert" className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy p-3" data-testid="gate-admin-rotate-confirm">
            <p className="font-semibold">{t('link.rotateWarning')}</p>
            <button type="button" className={primaryButton} disabled={busy} onClick={() => void rotateLink()} data-testid="gate-admin-rotate-yes">
              {t('link.rotateYes')}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setConfirmRotate(false);
                setTimeout(() => rotateRef.current?.focus(), 0);
              }}
            >
              {t('link.rotateNo')}
            </button>
          </div>
        ) : (
          <button ref={rotateRef} type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirmRotate(true)} data-testid="gate-admin-rotate">
            {t('link.rotate')}
          </button>
        )
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="font-corp text-base font-extrabold text-varsity-navy">{t('sessions.title', { count: event.sessions.length })}</h4>
        {event.sessions.length === 0 ? (
          <p className="text-sm text-ink-soft">{t('sessions.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {event.sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-stone-200 p-3" data-testid="gate-admin-session">
                <span className="text-sm">
                  <strong>{session.deviceLabel ?? t('sessions.noName')}</strong>
                  {` · ${t('sessions.since', { time: format.dateTime(new Date(session.createdAt), { timeStyle: 'short', dateStyle: 'short' }) })} · ${t('sessions.scans', { count: session.scans })}`}
                </span>
                {canAct ? (
                  <button type="button" className="inline-flex min-h-11 items-center rounded-xl border-2 border-red-700 px-3 text-sm font-bold text-red-800 hover:bg-red-50" disabled={busy} onClick={() => void closeSession(session.id)} data-testid="gate-admin-session-close" aria-label={t('sessions.closeLabel', { device: session.deviceLabel ?? t('sessions.noName') })}>
                    {t('sessions.close')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {event.subtype === 'RAFFLE' ? <GateRaffleAdmin orgSlug={orgSlug} event={event} canAct={canAct} /> : null}
    </li>
  );
}

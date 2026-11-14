'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { registerCommunityAction, type RegisterActionResult } from '@/app/[locale]/(auth)/registro-comunidad/actions';
import { ISSUE_FIELD, LEGAL_FORMS_BY_VERTICAL, participationTemplate, registrationIssues, registrationSchema, suggestSlug } from '@/core/onboarding/registration-rules';
import { InvalidEmailError, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { Locale } from '@/i18n/routing';
import { authClient, authErrorCode, localeHeaders } from '@/lib/auth/auth-client';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { CodeField, focusFirstInvalid, FormAlert, linkButton, QuietFieldErrors, secondaryButton, SubmitButton } from './auth-ui';
import { ActivationStep, CommunityStep, SignersStep, type RegistrationDraft } from './registration-steps';

/**
 * Alta autónoma en 3 pasos (`/registro-comunidad`). Cada paso se comprueba antes de avanzar con las mismas reglas que aplica el servidor; al
 * enviar, el servidor decide. Si la cuenta de quien dirige es nueva, se verifica su email con un código y se pasa a activar el TOTP.
 */

const STEPS = ['community', 'signers', 'activation'] as const;
const STEP_FIELDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['vertical', 'name', 'slug', 'provinceCode', 'city', 'postalCode', 'legalName', 'legalForm', 'centerOwnership', 'ley49', 'contentLocale', 'publicIndexing'],
  ['director', 'cosigner'],
  ['representationDeclared']
];

function payloadOf(draft: RegistrationDraft) {
  const { passwordRepeat: _repeat, ...director } = draft.director;
  return { ...draft, centerOwnership: draft.vertical === 'SCHOOL' ? draft.centerOwnership : 'NOT_APPLICABLE', director };
}

export function RegistrationWizard({ exemptLimitCents, appHost }: { exemptLimitCents: number; appHost: string }) {
  const t = useTranslations('registration');
  const locale = useLocale() as Locale;
  const roleDefaults = (vertical: RegistrationDraft['vertical']) => ({ director: t(`roles.${vertical}.director`), cosigner: t(`roles.${vertical}.cosigner`) });
  const [draft, setDraft] = useState<RegistrationDraft>(() => ({
    vertical: 'SCHOOL',
    name: '',
    slug: '',
    provinceCode: '',
    city: '',
    postalCode: '',
    legalName: '',
    legalForm: 'PARENTS_ASSOCIATION',
    centerOwnership: 'PUBLIC',
    ley49: false,
    contentLocale: locale,
    publicIndexing: true,
    director: { name: '', email: '', phone: '', roleLabel: roleDefaults('SCHOOL').director, password: '', passwordRepeat: '' },
    cosigner: { name: '', email: '', phone: '', roleLabel: roleDefaults('SCHOOL').cosigner },
    representationDeclared: false
  }));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Extract<RegisterActionResult, { ok: true }> | null>(null);
  const [code, setCode] = useState('');
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const verifyHeadingRef = useRef<HTMLHeadingElement>(null);
  const router = useRouter();
  // Al terminar el alta, el formulario se sustituye por el de verificación: el foco pasa a su título (no se queda en el documento).
  useEffect(() => {
    if (done) verifyHeadingRef.current?.focus();
  }, [done]);

  const update = (patch: Partial<RegistrationDraft>) =>
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (patch.name !== undefined && current.slug === suggestSlug(current.name)) next.slug = suggestSlug(patch.name);
      if (patch.vertical && patch.vertical !== current.vertical) {
        const before = roleDefaults(current.vertical);
        const after = roleDefaults(patch.vertical);
        if (!LEGAL_FORMS_BY_VERTICAL[patch.vertical].includes(current.legalForm as never)) next.legalForm = LEGAL_FORMS_BY_VERTICAL[patch.vertical][0]!;
        if (current.director.roleLabel === before.director) next.director = { ...next.director, roleLabel: after.director };
        if (current.cosigner.roleLabel === before.cosigner) next.cosigner = { ...next.cosigner, roleLabel: after.cosigner };
      }
      return next;
    });

  const fieldMessage = (path: string) => t(`fieldErrors.${path.split('.').at(-1)}`);

  function validate(upTo: number): Record<string, string> {
    const found: Record<string, string> = {};
    const parsed = registrationSchema.safeParse({ ...payloadOf(draft), representationDeclared: draft.representationDeclared || undefined });
    const allowed = new Set(STEP_FIELDS.slice(0, upTo + 1).flat());
    if (!parsed.success) for (const issue of parsed.error.issues) if (allowed.has(String(issue.path[0]))) found[issue.path.join('.')] ??= fieldMessage(issue.path.join('.'));
    for (const issue of registrationIssues({ ...payloadOf(draft), legalForm: draft.legalForm as never, centerOwnership: payloadOf(draft).centerOwnership as never })) found[ISSUE_FIELD[issue]] ??= t(`issues.${issue}`);
    if (upTo >= 1) {
      if (draft.director.passwordRepeat !== draft.director.password) found['director.passwordRepeat'] = t('fieldErrors.passwordRepeat');
      try {
        if (draft.director.email && draft.cosigner.email && normalizeCanonicalEmail(draft.director.email) === normalizeCanonicalEmail(draft.cosigner.email)) found['cosigner.email'] = t('failures.SAME_INBOX');
      } catch (error) {
        if (!(error instanceof InvalidEmailError)) throw error;
      }
    }
    return found;
  }

  const firstStepWith = (found: Record<string, string>) => STEP_FIELDS.findIndex((fields) => Object.keys(found).some((key) => fields.includes(key.split('.')[0]!)));
  const moveTo = (next: number, options: { focusHeading?: boolean } = {}) => {
    setStep(next);
    if (options.focusHeading !== false) requestAnimationFrame(() => headingRef.current?.focus());
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate(step);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Un solo resumen anunciado y el foco en el primer campo con error (Sprint 5.5b, heredado del 3.2): cada campo lleva su error vinculado, sin anunciarse por separado.
      setFormError(t('fixErrors', { count: Object.keys(found).length }));
      return focusFirstInvalid(formRef.current);
    }
    if (step < STEPS.length - 1) return moveTo(step + 1);
    void submit();
  };

  async function submit() {
    setBusy(true);
    try {
      const result = await registerCommunityAction(locale, payloadOf(draft));
      if (result.ok) {
        setDone(result);
        if (!result.needsVerification) router.push(`${localizedPath(locale, '/acceso/doble-factor')}?next=${encodeURIComponent(localizedPath(locale, `/panel/${result.slug}?bienvenida=1`))}`);
        return;
      }
      const failure = result.failure;
      const found: Record<string, string> = {};
      if (failure.code === 'INVALID') {
        for (const field of failure.fields) found[field] = fieldMessage(field);
        for (const issue of failure.issues) found[ISSUE_FIELD[issue]] = t(`issues.${issue}`);
      } else if (failure.code === 'SLUG_TAKEN') found.slug = t('failures.SLUG_TAKEN');
      else if (failure.code === 'SAME_INBOX' || failure.code === 'COSIGNER_UNAVAILABLE') found['cosigner.email'] = t(`failures.${failure.code}`);
      else if (failure.code === 'DIRECTOR_EMAIL_IN_USE') found['director.email'] = t('failures.DIRECTOR_EMAIL_IN_USE');
      else if (failure.code === 'DISPOSABLE_EMAIL') found[failure.field] = t('failures.DISPOSABLE_EMAIL');
      setErrors(found);
      setFormError(failure.code === 'RATE_LIMITED' || failure.code === 'UNKNOWN' ? t(`failures.${failure.code}`) : t('fixErrors', { count: Object.keys(found).length }));
      const target = firstStepWith(found);
      if (target >= 0 && target !== step) moveTo(target, { focusHeading: false });
      if (Object.keys(found).length > 0) focusFirstInvalid(formRef.current);
    } catch {
      setFormError(t('failures.UNKNOWN'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const verify = async (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setFormError(null);
      const result = await authClient.emailOtp.verifyEmail({ email: done.email, otp: code }, localeHeaders(locale)).catch(() => ({ error: { code: 'UNKNOWN' } }));
      setBusy(false);
      if (result.error) return setFormError(t(`codeErrors.${['INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS', 'RATE_LIMITED'].includes(authErrorCode(result.error)) ? authErrorCode(result.error) : 'UNKNOWN'}`));
      router.push(`${localizedPath(locale, '/acceso/doble-factor')}?next=${encodeURIComponent(localizedPath(locale, `/panel/${done.slug}?bienvenida=1`))}`);
    };
    const resend = async () => {
      await authClient.emailOtp.sendVerificationOtp({ email: done.email, type: 'email-verification' }, localeHeaders(locale)).catch(() => undefined);
      setCodeNotice(t('verify.resent'));
    };
    return (
      <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" aria-labelledby="verify-title">
        <h2 id="verify-title" ref={verifyHeadingRef} tabIndex={-1} className="font-joy text-2xl font-bold text-varsity-navy">
          {t('verify.title', { name: draft.name })}
        </h2>
        <FormAlert tone="success">{t('verify.created', { email: done.email, cosigner: draft.cosigner.email })}</FormAlert>
        {codeNotice ? <FormAlert tone="info">{codeNotice}</FormAlert> : null}
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <CodeField label={t('verify.code')} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
        <SubmitButton busy={busy} disabled={code.length !== 6}>
          {t('verify.submit')}
        </SubmitButton>
        <button type="button" className={linkButton} onClick={() => void resend()}>
          {t('verify.resend')}
        </button>
      </form>
    );
  }

  const stepProps = { draft, errors, update };
  return (
    <form ref={formRef} onSubmit={next} className="flex flex-col gap-6" noValidate>
      <ol className="mobile-stack grid gap-2 md:grid-cols-3" aria-label={t('progress')}>
        {STEPS.map((name, index) => (
          <li key={name} aria-current={index === step ? 'step' : undefined} className={`rounded-xl border-2 px-3 py-2 text-sm font-bold ${index === step ? 'border-varsity-navy bg-varsity-navy text-varsity-ivory' : index < step ? 'border-varsity-emerald text-varsity-emerald' : 'border-varsity-navy/30 text-ink-soft'}`}>
            {t('stepLabel', { number: index + 1, total: STEPS.length })}{' · '}{t(`steps.${name}`)}
          </li>
        ))}
      </ol>
      <h2 ref={headingRef} tabIndex={-1} className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t(`steps.${STEPS[step]}`)}
      </h2>
      {formError ? <FormAlert focusOnShow={Object.keys(errors).length === 0}>{formError}</FormAlert> : null}
      <QuietFieldErrors>
        {step === 0 ? <CommunityStep {...stepProps} appHost={appHost} /> : null}
        {step === 1 ? <SignersStep {...stepProps} /> : null}
        {step === 2 ? <ActivationStep {...stepProps} exemptLimitCents={exemptLimitCents} groupCount={participationTemplate(draft.vertical).flatMap((cluster) => cluster.items).length} /> : null}
      </QuietFieldErrors>
      <div className="mobile-stack grid gap-3 md:grid-cols-2">
        {step > 0 ? (
          <button type="button" className={secondaryButton} onClick={() => moveTo(step - 1)} disabled={busy}>
            {t('back')}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <SubmitButton busy={busy}>{step === STEPS.length - 1 ? t('submit') : t('continue')}</SubmitButton>
      </div>
    </form>
  );
}

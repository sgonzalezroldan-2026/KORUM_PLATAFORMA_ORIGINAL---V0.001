import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { academicYearFor } from '@/core/finance/academic-year';
import { newWalletId } from '@/core/finance/wallet-id';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { Locale } from '@/generated/prisma/enums';
import { inTransaction, type Db } from '@/lib/db';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import { createInvitation, INVITATION_HOURS, invitationUrl, listPendingCosignerInvitations } from './invitations';
import { provinceByCode } from './provinces';
import { ownershipFor, participationTemplate, registrationIssues, registrationSchema, type RegistrationInput, type RegistrationIssue } from './registration-rules';

/**
 * Alta autónoma de una entidad (`/registro-comunidad`, QA-M02). En una sola transacción:
 *
 * 1. La entidad, con sus tarifas copiadas del motor de reglas (`GlobalConfig`): **1.000 € exentos** (o lo que fije el Super-Admin), el curso
 *    de sus cupos desde el primer día (`quotaPeriod = academicYearFor(now)`), su hucha `WLT-ESC-XXXXXX`, la plantilla de grupos de su vertical,
 *    el idioma de sus contenidos y si aparece en buscadores. KYB `PENDING`: sin documentos no podrá publicar campañas con cobro.
 * 2. La persona `DIRECTOR` (cuenta nueva con contraseña, pendiente de verificar el email con un código) y la invitación a la `COSIGNER`, que
 *    solo pasa a firmar cuando la acepta.
 * 3. El email de invitación al cofirmante, en la bandeja de salida.
 *
 * Una cuenta que ya existe nunca recibe una contraseña elegida por otra persona: si el email de quien dirige ya tiene cuenta, el alta exige
 * haber iniciado sesión con ella.
 */

export type RegistrationFailure =
  | { code: 'INVALID'; issues: RegistrationIssue[]; fields: string[] }
  | { code: 'SLUG_TAKEN' }
  | { code: 'SAME_INBOX' }
  | { code: 'DISPOSABLE_EMAIL'; field: 'director.email' | 'cosigner.email' }
  | { code: 'DIRECTOR_EMAIL_IN_USE' }
  | { code: 'COSIGNER_UNAVAILABLE' };

export class RegistrationError extends Error {
  constructor(readonly failure: RegistrationFailure) {
    super(`No se puede dar de alta la entidad: ${failure.code}.`);
    this.name = 'RegistrationError';
  }
}

export interface RegistrationContext {
  /** Cuenta con la que se ha iniciado sesión al enviar el formulario (de la sesión, nunca del formulario). */
  sessionUserId: string | null;
  /** Idioma de la página: el de las cuentas nuevas y sus emails. */
  locale: Locale;
  appUrl: string;
  hmacSecret: string;
  dispatch: DispatchEmails;
  now?: Date;
}

export interface RegistrationResult {
  organizationId: string;
  slug: string;
  directorUserId: string;
  /** La cuenta de quien dirige es nueva: hay que verificar su email con el código antes de entrar. */
  directorNeedsVerification: boolean;
}

function canonical(email: string, field: 'director.email' | 'cosigner.email'): string {
  try {
    const value = normalizeCanonicalEmail(email);
    if (isDisposableEmail(value)) throw new RegistrationError({ code: 'DISPOSABLE_EMAIL', field });
    return value;
  } catch (error) {
    if (error instanceof InvalidEmailError) throw new RegistrationError({ code: 'INVALID', issues: [], fields: [field] });
    throw error;
  }
}

/** Valida forma y reglas. Devuelve la entrada limpia o lanza `RegistrationError` con todos los campos a corregir. */
export function validateRegistration(raw: unknown): RegistrationInput {
  const parsed = registrationSchema.safeParse(raw);
  if (!parsed.success) throw new RegistrationError({ code: 'INVALID', issues: [], fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))] });
  const issues = registrationIssues(parsed.data);
  if (issues.length > 0) throw new RegistrationError({ code: 'INVALID', issues, fields: [] });
  return parsed.data;
}

export async function registerCommunity(db: Db, raw: unknown, context: RegistrationContext): Promise<RegistrationResult> {
  const input = validateRegistration(raw);
  const now = context.now ?? new Date();
  const directorCanonical = canonical(input.director.email, 'director.email');
  const cosignerCanonical = canonical(input.cosigner.email, 'cosigner.email');
  if (directorCanonical === cosignerCanonical) throw new RegistrationError({ code: 'SAME_INBOX' });

  const queued: number[] = [];
  const result = await inTransaction(db, async (tx) => {
    if (await tx.organization.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw new RegistrationError({ code: 'SLUG_TAKEN' });
    const [existingDirector, existingCosigner] = await Promise.all([
      tx.user.findUnique({ where: { canonicalEmail: directorCanonical }, select: { id: true, isSuperadmin: true, gdprAnonymizedAt: true, accounts: { where: { providerId: 'credential', password: { not: null } }, select: { id: true } } } }),
      tx.user.findUnique({ where: { canonicalEmail: cosignerCanonical }, select: { id: true, isSuperadmin: true, gdprAnonymizedAt: true } })
    ]);
    // Sin sesión de esa misma cuenta (y verificada hace poco: la decide quien llama) no se toca una cuenta existente. El Super-Admin no firma.
    if (existingDirector && (existingDirector.id !== context.sessionUserId || existingDirector.gdprAnonymizedAt || existingDirector.isSuperadmin)) throw new RegistrationError({ code: 'DIRECTOR_EMAIL_IN_USE' });
    // El Super-Admin nunca firma por una entidad, y una cuenta suprimida no puede recibir cargos.
    if (existingCosigner && (existingCosigner.isSuperadmin || existingCosigner.gdprAnonymizedAt)) throw new RegistrationError({ code: 'COSIGNER_UNAVAILABLE' });

    const rules = await tx.globalConfig.upsert({ where: { id: 'GLOBAL' }, create: { id: 'GLOBAL' }, update: {} });
    const organizationId = randomUUID();
    await tx.organization.create({
      data: {
        id: organizationId,
        slug: input.slug,
        name: input.name,
        legalName: input.legalName,
        legalForm: input.legalForm,
        centerOwnership: ownershipFor(input),
        vertical: input.vertical,
        province: provinceByCode(input.provinceCode)!.name,
        provinceCode: input.provinceCode,
        city: input.city,
        postalCode: input.postalCode,
        contactEmail: input.director.email,
        contactPhone: input.director.phone,
        walletId: newWalletId(),
        ley49: input.ley49,
        exemptLimitCents: rules.exemptLimitCents,
        exemptRemainingCents: rules.exemptLimitCents,
        t1Bps: rules.t1Bps,
        t2Bps: rules.t2Bps,
        t3Bps: rules.t3Bps,
        sponsorFeeBps: rules.sponsorFeeBps,
        fullIntegrityCheckCents: rules.fullIntegrityCheckCents,
        ticketFeeFixedCents: rules.ticketFeeFixedCents,
        ticketFeeBps: rules.ticketFeeBps,
        maintActive: rules.maintActive,
        maintPerInitCents: rules.maintPerInitCents,
        maintAnnualCapCents: rules.maintAnnualCapCents,
        quotaPeriod: academicYearFor(now),
        participationGroupsJson: participationTemplate(input.vertical).map((cluster) => ({ group: cluster.group, items: cluster.items })),
        contentLocale: input.contentLocale,
        publicIndexing: input.publicIndexing
      }
    });

    const directorUserId = existingDirector?.id ?? randomUUID();
    if (!existingDirector) {
      await tx.user.create({ data: { id: directorUserId, name: input.director.name, email: input.director.email, canonicalEmail: directorCanonical, locale: context.locale } });
    }
    if (!existingDirector || existingDirector.accounts.length === 0) {
      await tx.account.create({ data: { id: randomUUID(), userId: directorUserId, accountId: directorUserId, providerId: 'credential', password: await hashPassword(input.director.password) } });
    }
    const cosignerUserId = existingCosigner?.id ?? randomUUID();
    if (!existingCosigner) {
      await tx.user.create({ data: { id: cosignerUserId, name: input.cosigner.name, email: input.cosigner.email, canonicalEmail: cosignerCanonical, locale: input.contentLocale } });
    }
    await tx.organizationMember.create({ data: { organizationId, userId: directorUserId, role: 'DIRECTOR', roleLabel: input.director.roleLabel } });
    // La segunda firma no existe hasta que esa persona acepta la invitación (el cargo viaja en ella): nadie pasa a firmar por una entidad
    // que no conoce solo porque alguien escriba su email.

    const cosignerLocale = (await tx.user.findUniqueOrThrow({ where: { id: cosignerUserId }, select: { locale: true } })).locale;
    const { token } = await createInvitation(tx, { userId: cosignerUserId, organizationId, purpose: 'COSIGNER', roleLabel: input.cosigner.roleLabel, displayName: input.cosigner.name }, now);
    await queueAuthEmail(
      { db: tx, hmacSecret: context.hmacSecret, dispatch: (ids) => queued.push(...ids) },
      {
        template: 'auth.invitation',
        to: input.cosigner.email,
        locale: cosignerLocale,
        organizationId,
        payload: { url: invitationUrl(context.appUrl, cosignerLocale, token), hours: INVITATION_HOURS, organizationName: input.name, roleLabel: input.cosigner.roleLabel }
      }
    );
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: directorUserId,
        organizationId,
        action: 'organization.registered',
        targetType: 'Organization',
        targetId: organizationId,
        metadataJson: { vertical: input.vertical, legalForm: input.legalForm, centerOwnership: ownershipFor(input), ley49: input.ley49, representationDeclaredAt: now.toISOString() }
      }
    });
    return { organizationId, slug: input.slug, directorUserId, directorNeedsVerification: !existingDirector };
  });
  context.dispatch(queued);
  return result;
}

/** Reenvía la invitación pendiente de la persona cofirmante (aún sin aceptar). Lo decide quien llama tras `authorizeTenant` (DIRECTOR). */
export async function resendCosignerInvitation(db: Db, organizationId: string, context: Omit<RegistrationContext, 'sessionUserId' | 'locale'>): Promise<boolean> {
  const now = context.now ?? new Date();
  const pending = (await listPendingCosignerInvitations(db, organizationId)).at(-1);
  if (!pending) return false;
  const [user, organization] = await Promise.all([
    db.user.findUnique({ where: { id: pending.userId }, select: { id: true, email: true, locale: true, gdprAnonymizedAt: true } }),
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } })
  ]);
  if (!user || user.gdprAnonymizedAt) return false;
  const { token } = await createInvitation(db, { userId: user.id, organizationId, purpose: 'COSIGNER', roleLabel: pending.roleLabel, displayName: pending.displayName }, now);
  return queueAuthEmail(
    { db, hmacSecret: context.hmacSecret, dispatch: context.dispatch },
    {
      template: 'auth.invitation',
      to: user.email,
      locale: user.locale,
      organizationId,
      payload: { url: invitationUrl(context.appUrl, user.locale, token), hours: INVITATION_HOURS, organizationName: organization.name, roleLabel: pending.roleLabel }
    }
  );
}

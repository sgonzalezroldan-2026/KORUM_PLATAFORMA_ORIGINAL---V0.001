import { randomUUID } from 'node:crypto';
import { createInvitation, INVITATION_HOURS, invitationUrl } from '@/core/onboarding/invitations';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import type { Db } from '@/lib/db';
import type { Locale } from '@/generated/prisma/enums';

/**
 * Piezas compartidas del equipo que firma (Sprint 4.2e): errores, contexto de las operaciones, la cuenta de la persona invitada y el email de
 * invitación. Las usan el relevo (`signer-handover.service.ts`) y la corrección de la invitación de la cofirma (`signer-team.service.ts`).
 */

export type TeamRejection = 'REAUTH_REQUIRED' | 'INVALID' | 'ALREADY_OPEN' | 'SEAT_EMPTY' | 'SEAT_TAKEN' | 'SAME_INBOX' | 'DISPOSABLE_EMAIL' | 'UNAVAILABLE' | 'NOT_FOUND' | 'INVITEE_BUSY' | 'RATE_LIMITED' | 'SINGLE_MODE' | 'ALREADY_IN_MODE';

export class TeamRejectedError extends Error {
  constructor(
    readonly reason: TeamRejection,
    readonly fields: string[] = []
  ) {
    super(`Cambio en el equipo que firma rechazado: ${reason}.`);
    this.name = 'TeamRejectedError';
  }
}

export interface TeamContext {
  appUrl: string;
  hmacSecret: string;
  /** Envía al momento los emails escritos (en la aplicación, con `after()`). */
  dispatch: DispatchEmails;
  /** Esta sesión confirmó el código de la app de verificación hace menos de 10 minutos (`secondFactorIsFresh`, de la sesión). */
  secondFactorFresh: boolean;
  now?: Date;
}

/** Bandeja canónica de un email tecleado en el panel, o el error que se enseña junto al campo. */
export function canonicalInbox(email: string): string {
  try {
    const value = normalizeCanonicalEmail(email);
    if (isDisposableEmail(value)) throw new TeamRejectedError('DISPOSABLE_EMAIL', ['email']);
    return value;
  } catch (error) {
    if (error instanceof InvalidEmailError) throw new TeamRejectedError('INVALID', ['email']);
    throw error;
  }
}

/** Bandeja canónica de una cuenta ya guardada (sin rechazar dominios: es para comparar). */
export function storedInbox(email: string): string {
  try {
    return normalizeCanonicalEmail(email);
  } catch {
    return email.trim().toLowerCase();
  }
}

/**
 * La cuenta de la persona invitada: la suya si ya existe (sin tocar su nombre ni su contraseña) o una nueva sin contraseña, que la fija al aceptar.
 * El Super-Admin nunca firma por una entidad y una cuenta suprimida no recibe cargos.
 */
export async function findOrCreateInvitee(tx: Db, input: { name: string; email: string; canonical: string; locale: Locale }): Promise<{ userId: string; locale: Locale; email: string }> {
  const existing = await tx.user.findUnique({
    where: { canonicalEmail: input.canonical },
    select: {
      id: true,
      email: true,
      locale: true,
      isSuperadmin: true,
      gdprAnonymizedAt: true
    }
  });
  if (existing) {
    if (existing.isSuperadmin || existing.gdprAnonymizedAt) throw new TeamRejectedError('UNAVAILABLE', ['email']);
    return {
      userId: existing.id,
      locale: existing.locale,
      email: existing.email
    };
  }
  const userId = randomUUID();
  await tx.user.create({
    data: {
      id: userId,
      name: input.name,
      email: input.email,
      canonicalEmail: input.canonical,
      locale: input.locale
    }
  });
  return { userId, locale: input.locale, email: input.email };
}

/** Invitación (`auth.invitation`) a ocupar un puesto. Sin envío si la bandeja superó su límite: la operación se deshace y se dice. */
export async function sendSeatInvitation(
  tx: Db,
  context: TeamContext,
  queued: number[],
  input: {
    invitee: { userId: string; locale: Locale; email: string };
    organizationId: string;
    organizationName: string;
    roleLabel: string;
    displayName: string;
    handoverId: string | null;
  },
  now: Date
): Promise<Date> {
  const { token, expiresAt } = await createInvitation(
    tx,
    {
      userId: input.invitee.userId,
      organizationId: input.organizationId,
      purpose: input.handoverId ? 'HANDOVER' : 'COSIGNER',
      roleLabel: input.roleLabel,
      displayName: input.displayName,
      handoverId: input.handoverId
    },
    now
  );
  const sent = await queueAuthEmail(
    {
      db: tx,
      hmacSecret: context.hmacSecret,
      dispatch: (ids) => queued.push(...ids)
    },
    {
      template: 'auth.invitation',
      to: input.invitee.email,
      locale: input.invitee.locale,
      organizationId: input.organizationId,
      payload: {
        url: invitationUrl(context.appUrl, input.invitee.locale, token),
        hours: INVITATION_HOURS,
        organizationName: input.organizationName,
        roleLabel: input.roleLabel
      }
    }
  );
  if (!sent) throw new TeamRejectedError('RATE_LIMITED');
  return expiresAt;
}

/** Aviso del relevo (`signer.handover`) a una persona firmante, en la bandeja de salida. Devuelve su id para enviarlo al momento. */
export async function queueHandoverNotice(
  tx: Db,
  input: {
    handoverId: string;
    organizationId: string;
    recipientUserId: string;
    /** `MODE_SINGLE`: a la Cofirma que deja el puesto. `MODE_CHANGED`: a Dirección, para que se entere si el cambio no lo hizo ella. */
    stage: 'REQUESTED' | 'MODE_SINGLE' | 'MODE_CHANGED' | 'EXPIRED';
    role: string;
    /** Vacío si la persona no tiene cargo escrito: el email usa «Dirección» o «Cofirma» en su idioma. */
    roleLabel: string;
    mode?: 'DOUBLE' | 'SINGLE';
  }
): Promise<number | null> {
  const recipient = await tx.user.findFirst({
    where: { id: input.recipientUserId, gdprAnonymizedAt: null },
    select: { email: true, locale: true }
  });
  if (!recipient) return null;
  const message = await tx.outboxMessage.create({
    data: {
      idempotencyKey: `signer.handover:${input.handoverId}:${input.stage}:${input.recipientUserId}`,
      templateKey: 'signer.handover',
      locale: recipient.locale,
      toAddress: recipient.email,
      userId: input.recipientUserId,
      organizationId: input.organizationId,
      payloadJson: {
        stage: input.stage,
        role: input.role,
        roleLabel: input.roleLabel,
        leaving: input.stage === 'REQUESTED' || input.stage === 'MODE_SINGLE',
        ...(input.mode ? { mode: input.mode } : {})
      }
    },
    select: { id: true }
  });
  return message.id;
}

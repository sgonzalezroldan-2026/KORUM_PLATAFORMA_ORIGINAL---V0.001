import { randomUUID } from 'node:crypto';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { InvalidEmailError, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { inTransaction, type Db } from '@/lib/db';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import { createInvitation, INVITATION_HOURS, invitationUrl } from './invitations';

/**
 * Alta del primer Super-Admin (`npm run superadmin:bootstrap`, variable `SUPERADMIN_BOOTSTRAP_EMAIL`). Solo actúa si todavía no hay ningún
 * Super-Admin: así la variable olvidada en el entorno no puede crear otro más tarde. La persona recibe una invitación para fijar su
 * contraseña; después entra y activa el TOTP, sin el cual la consola no se abre.
 */

export type BootstrapOutcome = 'INVITED' | 'ALREADY_EXISTS' | 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'INVALID_EMAIL' | 'ACCOUNT_SIGNS';

export async function bootstrapSuperadmin(db: Db, input: { email: string | undefined; appUrl: string; hmacSecret: string; dispatch: DispatchEmails; now?: Date }): Promise<BootstrapOutcome> {
  if (!input.email) return 'NOT_CONFIGURED';
  let canonicalEmail: string;
  try {
    canonicalEmail = normalizeCanonicalEmail(input.email);
  } catch (error) {
    if (error instanceof InvalidEmailError) return 'INVALID_EMAIL';
    throw error;
  }
  const email = input.email.trim().toLowerCase();
  const queued: number[] = [];
  const outcome = await inTransaction(db, async (tx): Promise<BootstrapOutcome> => {
    if ((await tx.user.count({ where: { isSuperadmin: true, gdprAnonymizedAt: null } })) > 0) return 'ALREADY_EXISTS';
    const existing = await tx.user.findUnique({ where: { canonicalEmail }, select: { id: true, email: true, locale: true } });
    // Una cuenta que ya firma por una entidad (dirección o cofirma) no puede ser Super-Admin: la doble firma excluye siempre al Super-Admin. Se avisa en lugar de darle el rol.
    // La cuenta se bloquea antes de contar sus cargos (mismo orden que aceptar una invitación): una cofirma que se acepta a la vez no puede dejar a la persona con los dos papeles.
    if (existing) await tx.user.updateMany({ where: { id: existing.id }, data: { updatedAt: input.now ?? new Date() } });
    if (existing && (await tx.organizationMember.count({ where: { userId: existing.id, role: { in: [...SIGNER_ROLES] } } })) > 0) return 'ACCOUNT_SIGNS';
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { isSuperadmin: true }, select: { id: true, locale: true } })
      : await tx.user.create({ data: { id: randomUUID(), email, canonicalEmail, isSuperadmin: true }, select: { id: true, locale: true } });
    const { token } = await createInvitation(tx, { userId: user.id, organizationId: null, purpose: 'SUPERADMIN' }, input.now);
    const sent = await queueAuthEmail(
      { db: tx, hmacSecret: input.hmacSecret, dispatch: (ids) => queued.push(...ids) },
      { template: 'auth.invitation', to: existing?.email ?? email, locale: user.locale, payload: { url: invitationUrl(input.appUrl, user.locale, token), hours: INVITATION_HOURS, organizationName: null, roleLabel: null } }
    );
    await tx.auditLog.create({ data: { actorType: 'SYSTEM', action: 'superadmin.bootstrapped', targetType: 'User', targetId: user.id, metadataJson: { invited: sent } } });
    return sent ? 'INVITED' : 'RATE_LIMITED';
  });
  input.dispatch(queued);
  return outcome;
}

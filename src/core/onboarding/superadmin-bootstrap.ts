import { randomUUID } from 'node:crypto';
import { InvalidEmailError, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { inTransaction, type Db } from '@/lib/db';
import { queueAuthEmail, type DispatchEmails } from '@/lib/auth/auth-emails';
import { createInvitation, INVITATION_HOURS, invitationUrl } from './invitations';

/**
 * Alta del primer Super-Admin (`npm run superadmin:bootstrap`, variable `SUPERADMIN_BOOTSTRAP_EMAIL`). Solo actúa si todavía no hay ningún
 * Super-Admin: así la variable olvidada en el entorno no puede crear otro más tarde. La persona recibe una invitación para fijar su
 * contraseña; después entra y activa el TOTP, sin el cual la consola no se abre.
 */

export type BootstrapOutcome = 'INVITED' | 'ALREADY_EXISTS' | 'NOT_CONFIGURED' | 'RATE_LIMITED' | 'INVALID_EMAIL';

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
    const existing = await tx.user.findUnique({ where: { canonicalEmail }, select: { id: true, locale: true } });
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { isSuperadmin: true }, select: { id: true, locale: true } })
      : await tx.user.create({ data: { id: randomUUID(), email, canonicalEmail, isSuperadmin: true }, select: { id: true, locale: true } });
    // Si la cuenta ya firmaba por una entidad, deja de poder hacerlo: la doble firma excluye siempre al Super-Admin.
    const { token } = await createInvitation(tx, { userId: user.id, organizationId: null, purpose: 'SUPERADMIN' }, input.now);
    const sent = await queueAuthEmail(
      { db: tx, hmacSecret: input.hmacSecret, dispatch: (ids) => queued.push(...ids) },
      { template: 'auth.invitation', to: email, locale: user.locale, payload: { url: invitationUrl(input.appUrl, user.locale, token), hours: INVITATION_HOURS, organizationName: null, roleLabel: null } }
    );
    await tx.auditLog.create({ data: { actorType: 'SYSTEM', action: 'superadmin.bootstrapped', targetType: 'User', targetId: user.id, metadataJson: { invited: sent } } });
    return sent ? 'INVITED' : 'RATE_LIMITED';
  });
  input.dispatch(queued);
  return outcome;
}

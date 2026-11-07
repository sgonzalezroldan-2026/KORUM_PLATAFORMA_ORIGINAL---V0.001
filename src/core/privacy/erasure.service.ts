import { raiseAlert } from '@/core/jobs/ops-alerts';
import type { Keyring } from '@/core/security/crypto';
import { clearFingerprintsOf, ideaSignerMarker } from '@/core/security/device-quorum.service';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { assertVerifiedActor, revalidateActor, type VerifiedAccountActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Prisma } from '@/generated/prisma/client';
import { inTransaction, type Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';
import { deleteStoredCard } from '@/services/payments/card-tokens';
import type { PaymentProvider } from '@/services/payments/payment-provider';

/**
 * Derecho de supresión (RGPD art. 17, QA-REG03). La persona deja de ser identificable y **se conserva lo que exige la ley**:
 *
 * - **Se anonimiza:** nombre, email (de la cuenta y, si su email está verificado, de sus compras como invitada y sus entradas), NIF de la
 *   cuenta, domicilio, mensajes, soporte, votos de redimensionamiento e identificadores de dispositivo (email en `DeviceAccount`, firmas e
 *   ideas propuestas) y huellas. En firmas e ideas queda un HMAC (`ideaSignerMarker`) para que no pueda volver a firmar la misma idea.
 * - **Se borra:** sesiones, credenciales, códigos de acceso, 2FA y llaves de acceso; los cargos que no firman. Las tarjetas se revocan y se
 *   borran en Paycomet; si Paycomet no responde, la supresión sigue y la purga semanal reintenta el borrado.
 * - **Se conserva:** los asientos, las aportaciones (importes y fechas) y las firmas de liquidaciones, sin nadie identificable detrás; y el NIF,
 *   nombre y provincia de las donaciones **declarables en el Modelo 182** (completadas, sin reembolso, en entidad con Ley 49/2002 verificada),
 *   que la entidad debe poder acreditar (RGPD art. 17.3.b). `DATA_RETENTION_PURGE` las borra al vencer su plazo (6 años).
 * - **No se borran filas `DeviceAccount`:** el orden de las demás cuentas del dispositivo se calcula con ellas (regla padre y madre).
 *
 * No se puede suprimir a quien firma en una entidad (primero se le da de baja del cargo), al Super-Admin, ni con saldo en el monedero regulado.
 */

export type ErasureRequester = { kind: 'self'; actor: VerifiedAccountActor } | { kind: 'system'; reason: 'INACTIVITY' } | { kind: 'superadmin'; actor: VerifiedSuperadminActor };
export type ErasureBlock = 'SUPERADMIN_ACCOUNT' | 'ACTIVE_SIGNER' | 'WALLET_BALANCE' | 'NOT_ACCOUNT_OWNER';

export class ErasureBlockedError extends Error {
  constructor(readonly reason: ErasureBlock) {
    super(`No se puede suprimir la cuenta: ${reason}`);
    this.name = 'ErasureBlockedError';
  }
}

export interface ErasureDeps {
  paymentProvider: () => Promise<PaymentProvider>;
  keyring: Keyring;
  /** `DATA_HMAC_SECRET`, para la marca que impide volver a firmar la misma idea. */
  hmacSecret: string;
}

export interface ErasureResult {
  status: 'ERASED' | 'ALREADY_ERASED';
  /** Tarjetas que Paycomet no confirmó borrar: están revocadas y la purga semanal lo reintenta. */
  cardsPendingDeletion: number;
  /** Donaciones declarables cuyos datos fiscales se conservan por obligación legal. */
  retainedFiscalRecords: number;
}

/** Email técnico de una cuenta suprimida: único, no enrutable (`.invalid`, RFC 2606) y sin rastro del original. */
export const anonymizedEmailOf = (userId: string) => `suprimida-${userId}@anonimizado.invalid`;
/** Marca que sustituye a un email en tablas que exigen un valor (y a veces único): pases, dispositivos, votos. */
export const anonymizedMarker = (scope: string, id: string | number) => `anonimizado:${scope}:${id}`;

/** Lo mismo que puede entrar en el Modelo 182 (`exportModel182`): solo eso hay obligación de conservar. */
const DECLARABLE_DONATION = { type: 'DONATION', status: 'COMPLETED', refundedCents: 0, donorTaxIdEnc: { not: null }, organization: { ley49: true, ley49VerifiedAt: { not: null } } } satisfies Prisma.ContributionWhereInput;

interface ErasedUser {
  id: string;
  email: string;
  canonicalEmail: string;
  emailVerified: boolean;
  isSuperadmin: boolean;
  walletBalanceCents: number;
}

async function blockOf(db: Db, user: Pick<ErasedUser, 'id' | 'isSuperadmin' | 'walletBalanceCents'>): Promise<ErasureBlock | null> {
  if (user.isSuperadmin) return 'SUPERADMIN_ACCOUNT';
  if (user.walletBalanceCents !== 0) return 'WALLET_BALANCE';
  const signer = await db.organizationMember.findFirst({ where: { userId: user.id, role: { in: [...SIGNER_ROLES] } }, select: { id: true } });
  return signer ? 'ACTIVE_SIGNER' : null;
}

/** Borra las tarjetas en Paycomet antes de tocar la base: la llamada externa nunca va dentro de una transacción. Nunca impide la supresión. */
export async function deleteCardsOf(db: Db, deps: Pick<ErasureDeps, 'paymentProvider' | 'keyring'>, where: Prisma.PaymentMethodTokenWhereInput, now: Date): Promise<{ deleted: number; pending: number }> {
  const cards = await db.paymentMethodToken.findMany({ where: { ...where, providerDeletedAt: null }, select: { id: true } });
  const result = { deleted: 0, pending: 0 };
  if (cards.length === 0) return result;
  let provider: PaymentProvider | null = null;
  try {
    provider = await deps.paymentProvider();
  } catch {
    // Paycomet sin configurar o inaccesible: las tarjetas se revocan igual y el borrado queda pendiente.
  }
  for (const card of cards) {
    const outcome = provider ? await deleteStoredCard(db, provider, deps.keyring, card.id, now) : 'FAILED';
    if (outcome === 'DELETED') {
      result.deleted += 1;
      continue;
    }
    result.pending += 1;
    if (!provider) await db.paymentMethodToken.updateMany({ where: { id: card.id, revokedAt: null }, data: { revokedAt: now } });
    await raiseAlert(
      db,
      outcome === 'UNREADABLE'
        ? { type: 'ENCRYPTION_KEY_MISSING', severity: 'CRITICAL', dedupeKey: 'key-missing:PaymentMethodToken', targetType: 'PaymentMethodToken', targetId: String(card.id), detail: { table: 'PaymentMethodToken', lastId: card.id } }
        : { type: 'CARD_DELETE_FAILED', severity: 'WARNING', dedupeKey: `card-delete:${card.id}`, targetType: 'PaymentMethodToken', targetId: String(card.id), detail: { paymentMethodTokenId: card.id } },
      now
    );
  }
  return result;
}

async function anonymizeRecords(tx: Db, user: ErasedUser, hmacSecret: string, now: Date): Promise<number> {
  // Las compras como invitada solo se atribuyen a la cuenta si su email está verificado: si no, serían las de quien sí lo controla.
  const mine: Prisma.ContributionWhereInput = user.emailVerified ? { OR: [{ userId: user.id }, { canonicalEmail: user.canonicalEmail }] } : { userId: user.id };
  // Primero las entradas (se localizan por su compra) y después las compras, que pierden el email con el que se encuentran.
  await tx.ticketPass.updateMany({ where: { OR: [{ contribution: mine }, ...(user.emailVerified ? [{ holderEmail: user.email }] : [])] }, data: { holderEmail: anonymizedMarker('pase', user.id) } });
  const fiscal = await tx.contribution.updateMany({ where: { AND: [mine, DECLARABLE_DONATION] }, data: { guestEmail: null, canonicalEmail: null } });
  await tx.contribution.updateMany({
    where: { AND: [mine, { NOT: DECLARABLE_DONATION }] },
    data: { guestEmail: null, canonicalEmail: null, donorFullName: null, donorProvinceCode: null, donorTaxIdEnc: null, donorTaxIdHmac: null, donorTaxIdKeyVersion: null }
  });

  await tx.deviceAccount.updateMany({ where: { userId: user.id }, data: { canonicalEmail: anonymizedMarker('cuenta', user.id) } });
  const signerMarker = ideaSignerMarker(hmacSecret, user.canonicalEmail);
  // Por email, solo las firmas sin cuenta: una firma con el mismo email de otra cuenta (que lo tuvo antes) no es de esta persona, y
  // marcar las dos chocaría con la unicidad por idea.
  const byEmail = user.emailVerified ? [{ canonicalEmail: user.canonicalEmail, userId: null }] : [];
  await tx.ideaSignatureAudit.updateMany({ where: { OR: [{ userId: user.id }, ...byEmail] }, data: { canonicalEmail: signerMarker } });
  if (user.emailVerified) await tx.idea.updateMany({ where: { authorCanonicalEmail: user.canonicalEmail }, data: { authorCanonicalEmail: signerMarker } });
  const votes = user.emailVerified ? await tx.resizeVote.findMany({ where: { canonicalEmail: user.canonicalEmail }, select: { id: true } }) : [];
  for (const vote of votes) await tx.resizeVote.update({ where: { id: vote.id }, data: { canonicalEmail: anonymizedMarker('voto', vote.id) } });

  const messages = { OR: [{ userId: user.id }, ...(user.emailVerified ? [{ toAddress: user.email }] : [])] };
  await tx.outboxMessage.updateMany({ where: { ...messages, status: { in: ['PENDING', 'SENDING', 'FAILED'] } }, data: { status: 'CANCELLED' } });
  await tx.outboxMessage.updateMany({ where: messages, data: { toAddress: anonymizedEmailOf(user.id), payloadJson: {}, lastError: null } });
  if (user.emailVerified) await tx.supportTicket.updateMany({ where: { senderEmail: user.email }, data: { senderEmail: null } });
  await tx.consentRecord.updateMany({ where: { userId: user.id }, data: { subjectEmailHmac: null } });
  await tx.walletSubscription.updateMany({ where: { userId: user.id, status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } }, data: { status: 'CANCELLED', statusReason: 'ACCOUNT_ERASED', statusChangedAt: now } });
  await clearFingerprintsOf(tx, user.id);
  return fiscal.count;
}

async function wipeAccount(tx: Db, user: ErasedUser, now: Date): Promise<void> {
  await tx.organizationMember.deleteMany({ where: { userId: user.id } });
  await tx.session.deleteMany({ where: { userId: user.id } });
  await tx.account.deleteMany({ where: { userId: user.id } });
  await tx.twoFactor.deleteMany({ where: { userId: user.id } });
  await tx.passkey.deleteMany({ where: { userId: user.id } });
  // Códigos y enlaces de acceso pendientes: el identificador es el email, a veces con un prefijo del tipo de código.
  const identifiers = [...new Set([user.email, user.canonicalEmail])];
  await tx.verification.deleteMany({ where: { OR: identifiers.flatMap((email) => [{ identifier: email }, { identifier: { endsWith: `-${email}` } }, { identifier: { endsWith: `:${email}` } }]) } });
  await tx.paymentMethodToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
  await tx.user.update({
    where: { id: user.id },
    data: {
      name: '',
      email: anonymizedEmailOf(user.id),
      canonicalEmail: anonymizedEmailOf(user.id),
      emailVerified: false,
      emailVerifiedAt: null,
      image: null,
      twoFactorEnabled: false,
      nifEnc: null,
      nifHmac: null,
      nifKeyVersion: null,
      provinceCode: null,
      postalCode: null,
      walletExternalId: null,
      activeOrganizationId: null,
      inactivityNoticeAt: null,
      gdprAnonymizedAt: now
    }
  });
}

export async function erasePersonalData(db: Db, deps: ErasureDeps, input: { userId: string; requestedBy: ErasureRequester; requestId?: number }, now: Date = new Date()): Promise<ErasureResult> {
  const { requestedBy } = input;
  if (requestedBy.kind === 'superadmin') assertVerifiedActor(requestedBy.actor, 'verified-superadmin', 'privacy.erasure', now);
  if (requestedBy.kind === 'self') {
    assertVerifiedActor(requestedBy.actor, 'verified-account', 'privacy.erasure', now);
    // Una persona solo suprime su propia cuenta.
    if (requestedBy.actor.userId !== input.userId) throw new ErasureBlockedError('NOT_ACCOUNT_OWNER');
  }
  const user = await db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { id: true, email: true, canonicalEmail: true, emailVerified: true, isSuperadmin: true, walletBalanceCents: true, gdprAnonymizedAt: true } });
  if (user.gdprAnonymizedAt) return { status: 'ALREADY_ERASED', cardsPendingDeletion: 0, retainedFiscalRecords: 0 };
  const actorType = requestedBy.kind === 'system' ? 'SYSTEM' : 'USER';
  const actorUserId = requestedBy.kind === 'system' ? null : requestedBy.actor.userId;
  const block = await blockOf(db, user);
  if (block) {
    await writeAudit(db, { actorType, actorUserId, action: 'privacy.erasure_blocked', targetType: 'User', targetId: user.id, metadata: { reason: block } });
    throw new ErasureBlockedError(block);
  }

  const cards = await deleteCardsOf(db, deps, { userId: user.id }, now);
  const retainedFiscalRecords = await inTransaction(db, async (tx) => {
    if (requestedBy.kind !== 'system') await revalidateActor(tx, requestedBy.actor, 'privacy.erasure', now);
    // Bloquea la cuenta y vuelve a comprobarlo todo: entre la comprobación y aquí, alguien podría haberle dado un cargo.
    const locked = await tx.user.update({ where: { id: user.id }, data: { updatedAt: now }, select: { gdprAnonymizedAt: true } });
    if (locked.gdprAnonymizedAt) return 0;
    const lateBlock = await blockOf(tx, user);
    if (lateBlock) throw new ErasureBlockedError(lateBlock);

    const retained = await anonymizeRecords(tx, user, deps.hmacSecret, now);
    await wipeAccount(tx, user, now);
    if (input.requestId !== undefined) {
      await tx.privacyRequest.updateMany({ where: { id: input.requestId, userId: user.id, status: { in: ['RECEIVED', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: now } });
    }
    await writeAudit(tx, {
      actorType,
      actorUserId,
      action: 'privacy.erasure_completed',
      targetType: 'User',
      targetId: user.id,
      metadata: { requestedBy: requestedBy.kind, retainedFiscalRecords: retained, cardsPendingDeletion: cards.pending }
    });
    return retained;
  });
  return { status: 'ERASED', cardsPendingDeletion: cards.pending, retainedFiscalRecords };
}

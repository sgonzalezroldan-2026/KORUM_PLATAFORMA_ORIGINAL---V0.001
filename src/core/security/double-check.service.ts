import { randomBytes, randomInt } from 'node:crypto';
import type { DoubleCheckTargetType } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { SIGNATURE_REQUEST_RULE } from '@/lib/rate-limit-rules';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { dataHmac, safeEqual } from './data-hmac';
import { evaluateDoubleCheck, loadSignerMemberships, SIGNER_ROLES, type DoubleCheckContext, type DoubleCheckEvaluation, type SignerMembership, type SignerRole, type StoredSignature } from './double-check-evaluation';
import { computeSignatureHash, ideaTargetDigest, payoutTargetDigest } from './signature-hash';

/**
 * Doble firma mancomunada (skill korum-quorum-antifraud §3): `DIRECTOR` + `COSIGNER`, dos personas distintas, para aprobar una idea o
 * liberar una liquidación. Toda firma se hace con un enlace de un solo uso y un OTP, y además con la sesión de esa misma persona: el enlace
 * y el código van al mismo correo, y una bandeja de entrada comprometida no debe bastar para mover dinero.
 *
 * El enlace y el OTP en claro solo salen de aquí una vez, para que la capa de notificaciones los envíe. La firma nunca aprueba por sí sola
 * una liquidación: al completarse, quien llama ejecuta `approvePayout`, que vuelve a comprobarlo todo dentro de su transacción.
 */

export type SignatureTarget = { targetType: 'IDEA_APPROVAL'; ideaId: number } | { targetType: 'ESCROW_PAYOUT'; payoutId: number };

const CHALLENGE_TTL_MS = 72 * 3_600_000;
export const MAX_OTP_ATTEMPTS = 5;

export type DoubleCheckBlock = 'NOT_A_SIGNER' | 'HOLDS_BOTH_ROLES' | 'TWO_FACTOR_REQUIRED' | 'TARGET_CLOSED' | 'ALREADY_SIGNED' | 'SAME_PERSON' | 'PROVIDER_INVOICE_MISSING' | 'DESTINATION_ACCOUNT_MISSING' | 'RATE_LIMITED';

export class DoubleCheckNotAllowedError extends Error {
  readonly reason: DoubleCheckBlock;

  constructor(reason: DoubleCheckBlock) {
    super(`No se puede firmar: ${reason}.`);
    this.name = 'DoubleCheckNotAllowedError';
    this.reason = reason;
  }
}

const targetColumns = (target: SignatureTarget) => (target.targetType === 'IDEA_APPROVAL' ? { ideaId: target.ideaId } : { payoutId: target.payoutId });
const targetIdOf = (target: SignatureTarget) => (target.targetType === 'IDEA_APPROVAL' ? target.ideaId : target.payoutId);

interface LockedTarget {
  context: DoubleCheckContext;
  open: boolean;
  block: Extract<DoubleCheckBlock, 'PROVIDER_INVOICE_MISSING' | 'DESTINATION_ACCOUNT_MISSING'> | null;
  signatures: Array<StoredSignature & { signerIpHash: string | null; targetDigest: string; membershipId: number }>;
}

/** Bloquea el objetivo (dos firmantes a la vez se ordenan) y devuelve lo que se firma tal como está ahora. */
async function lockTarget(tx: Db, secret: string, target: SignatureTarget, now: Date): Promise<LockedTarget> {
  if (target.targetType === 'IDEA_APPROVAL') {
    const idea = await tx.idea.update({ where: { id: target.ideaId }, data: { votes: { increment: 0 } }, include: { doubleCheckSignatures: true } });
    const context = { organizationId: idea.organizationId, targetType: target.targetType, targetId: idea.id, targetDigest: ideaTargetDigest(secret, idea) };
    return { context, open: idea.phase === 'DOUBLE_CHECK' && idea.expiresAt > now, block: null, signatures: idea.doubleCheckSignatures };
  }
  const payout = await tx.escrowPayout.update({ where: { id: target.payoutId }, data: { netPaidCents: { increment: 0 } }, include: { signatures: true, organization: { select: { paycometSplitId: true } } } });
  const account = payout.organization.paycometSplitId;
  const context = { organizationId: payout.organizationId, targetType: target.targetType, targetId: payout.id, targetDigest: payoutTargetDigest(secret, payout, account) };
  const block = payout.destinationType === 'PROVIDER' ? (payout.providerInvoiceFileId ? null : 'PROVIDER_INVOICE_MISSING') : account ? null : 'DESTINATION_ACCOUNT_MISSING';
  return { context, open: payout.status === 'PENDING_DOUBLE_CHECK', block, signatures: payout.signatures };
}

export interface IssuedChallenge {
  signerUserId: string;
  signerRole: SignerRole;
  /** Va en el enlace; no se puede recuperar después. */
  token: string;
  /** Código de 6 dígitos; no se puede recuperar después. */
  otp: string;
  expiresAt: Date;
}

const hashToken = (secret: string, token: string) => dataHmac(secret, 'double-check-token', token);
const hashOtp = (secret: string, tokenHash: string, otp: string) => dataHmac(secret, 'double-check-otp', `${tokenHash}:${otp}`);

/** Crea un enlace y un OTP nuevos para una persona y anula los anteriores que tuviera para este objetivo. */
async function issueChallenge(tx: Db, secret: string, target: SignatureTarget, context: DoubleCheckContext, signer: { userId: string; role: SignerRole }, now: Date): Promise<IssuedChallenge> {
  await tx.doubleCheckChallenge.updateMany({ where: { targetType: target.targetType, ...targetColumns(target), signerUserId: signer.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const token = randomBytes(32).toString('base64url');
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const tokenHash = hashToken(secret, token);
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await tx.doubleCheckChallenge.create({
    data: { organizationId: context.organizationId, targetType: target.targetType, ...targetColumns(target), signerUserId: signer.userId, signerRole: signer.role, tokenHash, otpHmac: hashOtp(secret, tokenHash, otp), targetDigest: context.targetDigest, expiresAt, createdAt: now }
  });
  await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: context.organizationId, action: 'double_check.challenge_issued', targetType: target.targetType, targetId: String(targetIdOf(target)), metadataJson: { signerUserId: signer.userId, signerRole: signer.role } } });
  return { signerUserId: signer.userId, signerRole: signer.role, token, otp, expiresAt };
}

async function targetOrganization(db: Db, target: SignatureTarget): Promise<string | null> {
  const row = target.targetType === 'IDEA_APPROVAL'
    ? await db.idea.findUnique({ where: { id: target.ideaId }, select: { organizationId: true } })
    : await db.escrowPayout.findUnique({ where: { id: target.payoutId }, select: { organizationId: true } });
  return row?.organizationId ?? null;
}

/**
 * Qué impide a esta persona firmar ahora, con las firmas que siguen valiendo. La comparten pedir el enlace y usarlo: entre ambos momentos
 * pueden haber cambiado el cargo, el 2FA o las firmas de los demás.
 */
async function signerBlock(tx: Db, locked: LockedTarget, evaluation: DoubleCheckEvaluation, userId: string, memberships: readonly SignerMembership[]): Promise<{ block: DoubleCheckBlock } | { membership: SignerMembership }> {
  if (memberships.length > 1) return { block: 'HOLDS_BOTH_ROLES' };
  const membership = memberships[0];
  if (!membership) return { block: 'NOT_A_SIGNER' };
  const { twoFactorEnabled } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorEnabled: true } });
  if (!twoFactorEnabled) return { block: 'TWO_FACTOR_REQUIRED' };

  const invalidIds = new Set(evaluation.invalid.map((entry) => entry.signatureId));
  const valid = locked.signatures.filter((signature) => !invalidIds.has(signature.id) && signature.targetType === locked.context.targetType);
  if (valid.some((signature) => signature.signerUserId === userId && signature.signerRole === membership.role)) return { block: 'ALREADY_SIGNED' };
  if (valid.some((signature) => signature.signerUserId === userId)) return { block: 'SAME_PERSON' };
  if (evaluation.validRoles.includes(membership.role)) return { block: 'ALREADY_SIGNED' };
  const others = await loadSignerMemberships(tx, locked.context.organizationId, valid.map((signature) => signature.signerUserId));
  if ([...others.values()].flat().some((other) => other.canonicalEmail === membership.canonicalEmail)) return { block: 'SAME_PERSON' };
  return { membership };
}

/** La persona de la sesión pide firmar. Su rol sale de la base de datos, y el Super-Admin nunca firma por otra persona. */
export async function requestSignature(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, target: SignatureTarget, now: Date = new Date()): Promise<IssuedChallenge> {
  const targetId = targetIdOf(target);
  const probe = { organizationId, resourceType: target.targetType, resourceId: targetId };
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'double_check.request', targetType: target.targetType, targetId, allowSuperadmin: false });
  if (actor.kind !== 'user') throw new DoubleCheckNotAllowedError('NOT_A_SIGNER');
  const owner = await targetOrganization(db, target);
  if (owner === null) {
    await recordMissingResourceProbe(db, actor, probe);
    throw new ResourceNotFoundError(target.targetType);
  }
  if (owner !== organizationId) {
    await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: owner });
    throw new ResourceNotFoundError(target.targetType);
  }
  // Tras comprobar permiso y propiedad: quien no puede firmar no gasta el cupo de otra persona. Cada petición revoca el enlace anterior y
  // manda un correo nuevo, así que sin límite se podría inundar la bandeja de quien firma.
  if (!(await reserveAttempt(db, `${SIGNATURE_REQUEST_RULE.prefix}${actor.userId}:${target.targetType}:${targetId}`, SIGNATURE_REQUEST_RULE, now))) {
    await recordAudit(db, actor, { organizationId, action: 'double_check.request_rate_limited', targetType: target.targetType, targetId: String(targetId), metadata: { limit: SIGNATURE_REQUEST_RULE.limit } });
    throw new DoubleCheckNotAllowedError('RATE_LIMITED');
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTarget(tx, secret, target, now);
      if (!locked.open) throw new DoubleCheckNotAllowedError('TARGET_CLOSED');
      if (locked.block) throw new DoubleCheckNotAllowedError(locked.block);
      const memberships = (await loadSignerMemberships(tx, organizationId, [actor.userId])).get(actor.userId) ?? [];
      const evaluation = await evaluateDoubleCheck(tx, secret, locked.context, locked.signatures);
      const decision = await signerBlock(tx, locked, evaluation, actor.userId, memberships);
      if ('block' in decision) throw new DoubleCheckNotAllowedError(decision.block);
      return issueChallenge(tx, secret, target, locked.context, { userId: actor.userId, role: decision.membership.role }, now);
    });
  } catch (error) {
    if (error instanceof DoubleCheckNotAllowedError) await recordAudit(db, actor, { action: 'double_check.denied', organizationId, targetType: target.targetType, targetId: String(targetId), metadata: { stage: 'request', reason: error.reason } });
    throw error;
  }
}

export type CompleteSignatureResult =
  | { status: 'SIGNED'; signatures: number; complete: boolean; ideaConverted: boolean; /** Para la otra persona firmante, si falta su firma. */ nextChallenges: IssuedChallenge[] }
  | { status: 'INVALID_OTP'; attemptsLeft: number }
  /** El enlace no existe, ha caducado, ya se usó, se agotaron sus intentos o no es de esta persona. No se distingue, para no dar pistas. */
  | { status: 'INVALID_LINK' }
  /** Lo que se pidió firmar ha cambiado: hay que volver a revisarlo y pedir un enlace nuevo. */
  | { status: 'TARGET_CHANGED' }
  | { status: 'NOT_ALLOWED'; reason: DoubleCheckBlock };

function challengeTarget(challenge: { targetType: DoubleCheckTargetType; ideaId: number | null; payoutId: number | null }): SignatureTarget {
  return challenge.targetType === 'IDEA_APPROVAL' ? { targetType: 'IDEA_APPROVAL', ideaId: challenge.ideaId! } : { targetType: 'ESCROW_PAYOUT', payoutId: challenge.payoutId! };
}

/** Firma con enlace + OTP. Los fallos se devuelven sin lanzar: así el intento consumido y su auditoría quedan guardados aunque la firma no se haga. */
export async function completeSignature(db: KorumPrismaClient, secret: string, actor: SessionActor, input: { token: string; otp: string; signerIpHash?: string }, now: Date = new Date()): Promise<CompleteSignatureResult> {
  const tokenHash = hashToken(secret, input.token);
  const challenge = await db.doubleCheckChallenge.findUnique({ where: { tokenHash } });
  if (!challenge) return { status: 'INVALID_LINK' };
  if (actor.kind !== 'user' || actor.isSuperadmin || actor.userId !== challenge.signerUserId) {
    await recordAudit(db, actor, { action: 'double_check.wrong_signer', organizationId: challenge.organizationId, targetType: challenge.targetType, targetId: String(challenge.ideaId ?? challenge.payoutId), metadata: { challengeId: challenge.id } });
    return { status: 'INVALID_LINK' };
  }
  const target = challengeTarget(challenge);
  const targetId = targetIdOf(target);
  const signerRole = challenge.signerRole as SignerRole;

  return db.$transaction(async (tx): Promise<CompleteSignatureResult> => {
    const audit = (action: string, metadata: Record<string, string | number | null>) => tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.userId, organizationId: challenge.organizationId, action, targetType: challenge.targetType, targetId: String(targetId), ipHash: input.signerIpHash ?? null, metadataJson: metadata } });
    const notAllowed = async (reason: DoubleCheckBlock): Promise<CompleteSignatureResult> => {
      await audit('double_check.denied', { stage: 'complete', reason, challengeId: challenge.id });
      return { status: 'NOT_ALLOWED', reason };
    };
    const locked = await lockTarget(tx, secret, target, now);

    // Reservar el intento antes de comparar: dos peticiones a la vez no pueden probar más códigos de los permitidos ni usar el enlace dos veces.
    const reserved = await tx.doubleCheckChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_OTP_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
    if (reserved.count === 0) {
      await audit('double_check.denied', { stage: 'complete', reason: 'LINK_UNUSABLE', challengeId: challenge.id });
      return { status: 'INVALID_LINK' };
    }
    if (!safeEqual(hashOtp(secret, tokenHash, input.otp), challenge.otpHmac)) {
      const { attempts } = await tx.doubleCheckChallenge.findUniqueOrThrow({ where: { id: challenge.id }, select: { attempts: true } });
      if (attempts >= MAX_OTP_ATTEMPTS) await audit('double_check.otp_locked', { challengeId: challenge.id });
      return { status: 'INVALID_OTP', attemptsLeft: MAX_OTP_ATTEMPTS - attempts };
    }
    await tx.doubleCheckChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });

    if (!locked.open) return notAllowed('TARGET_CLOSED');
    if (locked.block) return notAllowed(locked.block);
    if (!safeEqual(locked.context.targetDigest, challenge.targetDigest)) {
      await audit('double_check.denied', { stage: 'complete', reason: 'TARGET_CHANGED', challengeId: challenge.id });
      return { status: 'TARGET_CHANGED' };
    }
    const memberships = (await loadSignerMemberships(tx, challenge.organizationId, [actor.userId])).get(actor.userId) ?? [];
    const evaluation = await evaluateDoubleCheck(tx, secret, locked.context, locked.signatures);
    const decision = await signerBlock(tx, locked, evaluation, actor.userId, memberships);
    if ('block' in decision) return notAllowed(decision.block);
    const { membership } = decision;
    if (membership.role !== signerRole) return notAllowed('NOT_A_SIGNER');

    // Una firma que ya no vale deja paso a la nueva. Se copia entera a la auditoría, con lo necesario para volver a verificar su huella.
    const stale = locked.signatures.find((signature) => signature.signerRole === signerRole && signature.targetType === challenge.targetType);
    if (stale) {
      await tx.doubleCheckSignature.delete({ where: { id: stale.id } });
      await audit('double_check.signature_superseded', {
        reason: evaluation.invalid.find((entry) => entry.signatureId === stale.id)?.reason ?? null,
        signatureHash: stale.signatureHash,
        targetDigest: stale.targetDigest,
        membershipId: stale.membershipId,
        previousSignerUserId: stale.signerUserId,
        signerRole: stale.signerRole,
        signedAt: stale.signedAt.toISOString(),
        otpVerifiedAt: stale.otpVerifiedAt?.toISOString() ?? null,
        signerIpHash: stale.signerIpHash
      });
    }
    const { targetDigest } = locked.context;
    const signature = await tx.doubleCheckSignature.create({
      data: {
        organizationId: challenge.organizationId,
        targetType: challenge.targetType,
        ...targetColumns(target),
        signerUserId: actor.userId,
        signerRole,
        targetDigest,
        membershipId: membership.membershipId,
        signatureHash: computeSignatureHash(secret, { ...locked.context, membershipId: membership.membershipId, signerUserId: actor.userId, signerRole, signedAt: now, otpVerifiedAt: now }),
        otpVerifiedAt: now,
        signerIpHash: input.signerIpHash ?? null,
        signedAt: now
      }
    });
    await audit('double_check.signed', { signatureId: signature.id, signerRole });

    const remaining = locked.signatures.filter((existing) => existing.id !== stale?.id);
    const after = await evaluateDoubleCheck(tx, secret, locked.context, [...remaining, signature]);
    if (after.complete) {
      if (target.targetType === 'IDEA_APPROVAL') await tx.idea.update({ where: { id: target.ideaId }, data: { phase: 'CONVERTED' } });
      return { status: 'SIGNED', signatures: 2, complete: true, ideaConverted: target.targetType === 'IDEA_APPROVAL', nextChallenges: [] };
    }
    const missingRole: SignerRole = signerRole === 'DIRECTOR' ? 'COSIGNER' : 'DIRECTOR';
    const candidates = await tx.organizationMember.findMany({ where: { organizationId: challenge.organizationId, role: missingRole, userId: { not: actor.userId }, user: { twoFactorEnabled: true } }, select: { userId: true } });
    const candidateRoles = await loadSignerMemberships(tx, challenge.organizationId, candidates.map((candidate) => candidate.userId));
    const nextChallenges: IssuedChallenge[] = [];
    for (const candidate of candidates) {
      if (candidateRoles.get(candidate.userId)?.length === 1) nextChallenges.push(await issueChallenge(tx, secret, target, locked.context, { userId: candidate.userId, role: missingRole }, now));
    }
    return { status: 'SIGNED', signatures: 1, complete: false, ideaConverted: false, nextChallenges };
  });
}

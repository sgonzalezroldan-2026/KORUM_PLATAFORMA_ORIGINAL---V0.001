import type { DoubleCheckTargetType, MemberRole } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { InvalidEmailError, normalizeCanonicalEmail } from './email-normalizer';
import { verifySignatureHash } from './signature-hash';

/**
 * Comprobación de las firmas guardadas contra los datos de ahora: huella, OTP, rol vigente y que las dos personas sean de verdad distintas.
 * La usan quien firma (para saber qué firmas siguen valiendo) y quien aprueba, dentro de su transacción.
 */

export type SignerRole = Extract<MemberRole, 'DIRECTOR' | 'COSIGNER'>;
export const SIGNER_ROLES: readonly SignerRole[] = ['DIRECTOR', 'COSIGNER'];

export type SignatureInvalidReason = 'OTHER_ORGANIZATION' | 'NOT_A_SIGNER_ROLE' | 'ROLE_LOST' | 'HOLDS_BOTH_ROLES' | 'OTP_MISSING' | 'HASH_MISMATCH' | 'SAME_INBOX';

export interface StoredSignature {
  id: number;
  organizationId: string;
  targetType: DoubleCheckTargetType;
  signerUserId: string;
  signerRole: MemberRole;
  signatureHash: string;
  otpVerifiedAt: Date | null;
  signedAt: Date;
}

export interface DoubleCheckContext {
  organizationId: string;
  targetType: DoubleCheckTargetType;
  targetId: number;
  targetDigest: string;
}

export interface DoubleCheckEvaluation {
  complete: boolean;
  validRoles: SignerRole[];
  invalid: Array<{ signatureId: number; reason: SignatureInvalidReason }>;
}

export interface SignerMembership {
  role: SignerRole;
  membershipId: number;
  canonicalEmail: string;
}

/** Bandeja de entrada de una cuenta: un valor que no se pueda normalizar se compara tal cual. */
function inboxOf(email: string): string {
  try {
    return normalizeCanonicalEmail(email);
  } catch (error) {
    if (error instanceof InvalidEmailError) return email.trim().toLowerCase();
    throw error;
  }
}

/** Cargos de firma vigentes, leídos de la base y no de la sesión. El Super-Admin y una cuenta anonimizada nunca firman. */
export async function loadSignerMemberships(db: Db, organizationId: string, userIds: readonly string[]): Promise<Map<string, SignerMembership[]>> {
  const members = await db.organizationMember.findMany({
    where: { organizationId, userId: { in: [...userIds] }, role: { in: [...SIGNER_ROLES] }, user: { isSuperadmin: false, gdprAnonymizedAt: null } },
    select: { id: true, userId: true, role: true, user: { select: { email: true } } }
  });
  const memberships = new Map<string, SignerMembership[]>();
  for (const member of members) {
    const entry = { role: member.role as SignerRole, membershipId: member.id, canonicalEmail: inboxOf(member.user.email) };
    memberships.set(member.userId, [...(memberships.get(member.userId) ?? []), entry]);
  }
  return memberships;
}

function invalidReason(secret: string, context: DoubleCheckContext, signature: StoredSignature, memberships: readonly SignerMembership[]): SignatureInvalidReason | null {
  if (signature.organizationId !== context.organizationId) return 'OTHER_ORGANIZATION';
  if (signature.signerRole !== 'DIRECTOR' && signature.signerRole !== 'COSIGNER') return 'NOT_A_SIGNER_ROLE';
  if (memberships.length > 1) return 'HOLDS_BOTH_ROLES';
  const membership = memberships[0];
  if (membership?.role !== signature.signerRole) return 'ROLE_LOST';
  if (!signature.otpVerifiedAt) return 'OTP_MISSING';
  const input = { ...context, membershipId: membership.membershipId, signerUserId: signature.signerUserId, signerRole: signature.signerRole, signedAt: signature.signedAt, otpVerifiedAt: signature.otpVerifiedAt };
  return verifySignatureHash(secret, input, signature.signatureHash) ? null : 'HASH_MISMATCH';
}

export async function evaluateDoubleCheck(db: Db, secret: string, context: DoubleCheckContext, signatures: readonly StoredSignature[]): Promise<DoubleCheckEvaluation> {
  const relevant = signatures.filter((signature) => signature.targetType === context.targetType);
  const memberships = await loadSignerMemberships(db, context.organizationId, relevant.map((signature) => signature.signerUserId));
  const invalid: DoubleCheckEvaluation['invalid'] = [];
  const valid = new Map<SignerRole, StoredSignature>();
  for (const signature of relevant) {
    const reason = invalidReason(secret, context, signature, memberships.get(signature.signerUserId) ?? []);
    if (reason) invalid.push({ signatureId: signature.id, reason });
    else valid.set(signature.signerRole as SignerRole, signature);
  }
  const director = valid.get('DIRECTOR');
  const cosigner = valid.get('COSIGNER');
  if (!director || !cosigner) return { complete: false, validRoles: [...valid.keys()], invalid };
  // Enlace y OTP llegan al correo: dos cuentas que dan a la misma bandeja son una sola persona, aunque sean dos usuarios.
  const inboxes = [director, cosigner].map((signature) => memberships.get(signature.signerUserId)?.[0]?.canonicalEmail);
  if (inboxes[0] !== inboxes[1]) return { complete: true, validRoles: [...valid.keys()], invalid };
  return { complete: false, validRoles: [], invalid: [...invalid, { signatureId: director.id, reason: 'SAME_INBOX' }, { signatureId: cosigner.id, reason: 'SAME_INBOX' }] };
}

import { inTransaction, type Db } from '@/lib/db';
import { createDeviceCookieValue, hasKnownSubnet, hashDeviceCookieId, hashFingerprint, hashIpSubnet, readDeviceCookieId } from './device-signals';
import { InvalidEmailError, isDisposableEmail, normalizeCanonicalEmail } from './email-normalizer';

/**
 * Firma de una idea con la regla padre y madre (skill korum-quorum-antifraud §1 y §2): hasta 2 cuentas por dispositivo cuentan como
 * verificadas; la 3ª o una ráfaga desde la misma red quedan como sospechosas, se registran y no suman a `verifiedVotes`, que es lo que
 * decide el quórum. La huella del navegador solo se trata con consentimiento: sin él, el valor recibido ni se guarda ni se compara.
 */

export type SignatureReasonKey = 'ideas.audit.ipBurst' | 'ideas.audit.firstAccount' | 'ideas.audit.secondAccount' | 'ideas.audit.tooManyAccounts';

export interface SignatureAuditResult {
  status: 'VERIFIED' | 'SUSPICIOUS';
  /** Clave de traducción del motivo (los textos viven en messages/{es,ca,en}.json). */
  reasonKey: SignatureReasonKey;
  deviceAccountOrder: number;
}

const MAX_FAMILY_ACCOUNTS = 2;
const BURST_THRESHOLD = 6;
const BURST_WINDOW_MS = 10 * 60_000;
const FINGERPRINT_CROSS_WINDOW_MS = 30 * 86_400_000;

export function evaluateIdeaSignatureFraud(params: { deviceAccountOrder: number; ipBurstSignaturesLast10Min: number }): SignatureAuditResult {
  const { deviceAccountOrder } = params;
  if (params.ipBurstSignaturesLast10Min >= BURST_THRESHOLD) return { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.ipBurst', deviceAccountOrder };
  if (deviceAccountOrder > MAX_FAMILY_ACCOUNTS) return { status: 'SUSPICIOUS', reasonKey: 'ideas.audit.tooManyAccounts', deviceAccountOrder };
  return { status: 'VERIFIED', reasonKey: deviceAccountOrder === 1 ? 'ideas.audit.firstAccount' : 'ideas.audit.secondAccount', deviceAccountOrder };
}

export type IdeaSignatureRejection = 'EMAIL_NOT_VERIFIED' | 'INVALID_EMAIL' | 'DISPOSABLE_EMAIL' | 'ACCOUNT_ANONYMIZED' | 'IDEA_CLOSED';

export class IdeaSignatureRejectedError extends Error {
  readonly reason: IdeaSignatureRejection;

  constructor(reason: IdeaSignatureRejection) {
    super(`La firma no se puede registrar: ${reason}.`);
    this.name = 'IdeaSignatureRejectedError';
    this.reason = reason;
  }
}

export interface SignIdeaInput {
  ideaId: number;
  /** Sale siempre de la sesión. */
  userId: string;
  /** Valor recibido de la cookie de dispositivo, si la hay. */
  deviceCookie?: string;
  ip?: string | null;
  /** Huella calculada en el navegador. Solo se tiene en cuenta si la persona ha dado su consentimiento. */
  fingerprint?: string;
}

export type SignIdeaResult =
  | { status: 'ALREADY_SIGNED' }
  | { status: 'SIGNED'; audit: SignatureAuditResult; quorumReached: boolean; /** Cookie que hay que enviar al navegador, si es nueva. */ newDeviceCookie: string | null };

function canonicalEmailOf(user: { email: string; emailVerified: boolean; gdprAnonymizedAt: Date | null }): string {
  if (user.gdprAnonymizedAt) throw new IdeaSignatureRejectedError('ACCOUNT_ANONYMIZED');
  if (!user.emailVerified) throw new IdeaSignatureRejectedError('EMAIL_NOT_VERIFIED');
  let canonicalEmail: string;
  try {
    // Se calcula aquí y no se lee de `User.canonicalEmail`: la regla no depende de cómo se guardó la cuenta.
    canonicalEmail = normalizeCanonicalEmail(user.email);
  } catch (error) {
    if (error instanceof InvalidEmailError) throw new IdeaSignatureRejectedError('INVALID_EMAIL');
    throw error;
  }
  if (isDisposableEmail(canonicalEmail)) throw new IdeaSignatureRejectedError('DISPOSABLE_EMAIL');
  return canonicalEmail;
}

/**
 * Al retirar el consentimiento, la huella se borra de todos los dispositivos de esa persona y deja de afectarle: su orden vuelve a ser el
 * de llegada en cada dispositivo, sin contar lo que sumó el cruce de huellas.
 */
export async function clearFingerprintsOf(db: Db, userId: string): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx.device.updateMany({ where: { accounts: { some: { userId } }, fingerprintHmac: { not: null } }, data: { fingerprintHmac: null } });
    const ownRows = await tx.deviceAccount.findMany({ where: { userId }, select: { id: true, deviceId: true, accountOrder: true } });
    for (const row of ownRows) {
      const onDevice = await tx.deviceAccount.findMany({ where: { deviceId: row.deviceId }, orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }], select: { id: true } });
      const accountOrder = onDevice.findIndex((account) => account.id === row.id) + 1;
      if (accountOrder !== row.accountOrder) await tx.deviceAccount.update({ where: { id: row.id }, data: { accountOrder } });
    }
  });
}

/** Último consentimiento de esta persona para la huella: `null` si nunca lo ha dado ni retirado. */
async function fingerprintConsent(tx: Db, userId: string): Promise<boolean | null> {
  const latest = await tx.consentRecord.findFirst({ where: { userId, purpose: 'DEVICE_FINGERPRINT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { granted: true } });
  return latest?.granted ?? null;
}

export async function signIdea(db: Db, secret: string, input: SignIdeaInput, now: Date = new Date()): Promise<SignIdeaResult> {
  return inTransaction(db, async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
    const canonicalEmail = canonicalEmailOf(user);

    // Bloquea la idea: las firmas de una misma idea se cuentan de una en una, sin perder votos ni firmar dos veces.
    const idea = await tx.idea.update({ where: { id: input.ideaId }, data: { votes: { increment: 0 } }, include: { organization: { select: { minVotes: true } } } });
    if (idea.phase !== 'PUBLIC_VOTING' || idea.expiresAt <= now) throw new IdeaSignatureRejectedError('IDEA_CLOSED');
    // Quien propone la idea ya cuenta como su primer voto.
    if (idea.authorCanonicalEmail === canonicalEmail) return { status: 'ALREADY_SIGNED' };
    // Por email y por persona: cambiar de email no da derecho a una segunda firma.
    const signed = await tx.ideaSignatureAudit.findFirst({ where: { ideaId: idea.id, OR: [{ canonicalEmail }, { userId: input.userId }] }, select: { id: true } });
    if (signed) return { status: 'ALREADY_SIGNED' };

    const receivedId = readDeviceCookieId(secret, input.deviceCookie);
    const newDeviceCookie = receivedId ? null : createDeviceCookieValue(secret);
    const cookieId = receivedId ?? readDeviceCookieId(secret, newDeviceCookie ?? undefined)!;
    // Bloquea el dispositivo: dos cuentas a la vez en el mismo móvil no pueden quedarse con el mismo orden.
    const device = await tx.device.upsert({ where: { cookieIdHash: hashDeviceCookieId(secret, cookieId) }, create: { cookieIdHash: hashDeviceCookieId(secret, cookieId), firstSeenAt: now, lastSeenAt: now }, update: { lastSeenAt: now } });

    const consent = await fingerprintConsent(tx, input.userId);
    const fingerprintHmac = consent === true && input.fingerprint ? hashFingerprint(secret, input.fingerprint) : null;
    if (fingerprintHmac) await tx.device.update({ where: { id: device.id }, data: { fingerprintHmac } });
    else if (consent === false) await clearFingerprintsOf(tx, input.userId);

    const ipSubnetHash = hashIpSubnet(secret, input.ip);
    const ipBurstSignaturesLast10Min = await tx.ideaSignatureAudit.count({ where: { ideaId: idea.id, ipSubnetHash, createdAt: { gte: new Date(now.getTime() - BURST_WINDOW_MS) } } });

    // Con consentimiento, borrar la cookie no reinicia la cuenta: cuentan juntos los dispositivos con la misma huella y la misma red, reciente.
    // Solo la huella no basta (dos móviles iguales de dos familias pueden darla idéntica), y sin IP válida no se sabe cuál es la red.
    const crossDevices = fingerprintHmac && hasKnownSubnet(input.ip);
    const accounts = await tx.deviceAccount.findMany({
      where: { OR: [{ deviceId: device.id }, ...(crossDevices ? [{ device: { fingerprintHmac, signatures: { some: { ipSubnetHash, createdAt: { gte: new Date(now.getTime() - FINGERPRINT_CROSS_WINDOW_MS) } } } } }] : [])] },
      orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
      select: { userId: true, deviceId: true, accountOrder: true }
    });
    const orderedUsers = [...new Set(accounts.map((account) => account.userId))];
    const position = orderedUsers.indexOf(input.userId);
    const ownRow = accounts.find((account) => account.userId === input.userId && account.deviceId === device.id);
    // El orden se fija al llegar al dispositivo y no cambia: la 3ª no pasa a ser 1ª por dejar de enviar la huella, ni una familia ya
    // conocida empeora porque otra persona con la misma huella pase por su red.
    const deviceAccountOrder = ownRow?.accountOrder ?? (position === -1 ? orderedUsers.length + 1 : position + 1);
    if (!ownRow) await tx.deviceAccount.create({ data: { deviceId: device.id, userId: input.userId, canonicalEmail, accountOrder: deviceAccountOrder, firstSeenAt: now } });

    const audit = evaluateIdeaSignatureFraud({ deviceAccountOrder, ipBurstSignaturesLast10Min });
    await tx.ideaSignatureAudit.create({ data: { ideaId: idea.id, userId: input.userId, canonicalEmail, deviceId: device.id, ipSubnetHash, accountOrder: audit.deviceAccountOrder, status: audit.status, reason: audit.reasonKey, createdAt: now } });

    const verified = audit.status === 'VERIFIED';
    const quorumReached = verified && idea.verifiedVotes + 1 >= idea.organization.minVotes;
    await tx.idea.update({
      where: { id: idea.id },
      data: { votes: { increment: 1 }, verifiedVotes: { increment: verified ? 1 : 0 }, suspiciousVotes: { increment: verified ? 0 : 1 }, ...(quorumReached ? { phase: 'DOUBLE_CHECK' as const } : {}) }
    });
    return { status: 'SIGNED', audit, quorumReached, newDeviceCookie };
  });
}

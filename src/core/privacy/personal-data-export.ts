import { CRYPTO_CONTEXT, DecryptionError, openValue, type Keyring } from '@/core/security/crypto';
import { assertVerifiedActor, revalidateActor, type VerifiedAccountActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { openDonorTaxId } from '@/core/tax/tax-id-vault';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';

/**
 * Derecho de acceso y portabilidad (RGPD arts. 15 y 20, QA-PRIV01): todo lo que KORUM guarda de una persona, en JSON. Incluye lo que
 * aportó con su cuenta y —solo si su email está verificado— lo que compró como invitada con ese email, sus entradas, consentimientos,
 * solicitudes, cargos, firmas de ideas, mensajes, soporte y lo que el antifraude sabe de sus dispositivos. El NIF va descifrado: es suyo.
 * Nunca incluye secretos (tokens de tarjeta, contraseñas, códigos de 2FA) ni datos de otras personas. Un NIF que no se puede descifrar no
 * bloquea el derecho de acceso: aparece como no disponible (`unreadableTaxIds`).
 */

export const EXPORT_FORMAT_VERSION = 1;

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export interface PersonalDataExport {
  formatVersion: number;
  generatedAt: string;
  account: { id: string; name: string; email: string; locale: string; emailVerified: boolean; twoFactorEnabled: boolean; taxId: string | null; provinceCode: string | null; postalCode: string | null; createdAt: string; lastActiveAt: string };
  contributions: Array<{
    id: number;
    createdAt: string;
    organization: string;
    initiative: string;
    type: string;
    status: string;
    paymentMethod: string;
    amountCents: number;
    guaranteeContributionCents: number;
    totalChargedCents: number;
    refundedCents: number;
    group: string | null;
    donorFullName: string | null;
    donorTaxId: string | null;
    donorProvinceCode: string | null;
    asGuest: boolean;
  }>;
  tickets: Array<{ serialCode: string; initiative: string; quantity: number; checkedInCount: number; raffleNumbers: number[]; revokedAt: string | null; createdAt: string }>;
  consents: Array<{ purpose: string; granted: boolean; policyVersion: string; source: string; createdAt: string }>;
  privacyRequests: Array<{ type: string; status: string; createdAt: string; dueAt: string; completedAt: string | null }>;
  memberships: Array<{ organization: string; role: string; roleLabel: string | null; since: string }>;
  ideaSignatures: Array<{ idea: string; status: string; reasonKey: string; accountOrder: number; createdAt: string }>;
  /** Ideas propuestas (Sprint 3.9) con lo que la familia escribió en su chat anónimo y las respuestas del centro. */
  ideaProposals: Array<{ alias: string; title: string; category: string; description: string; phase: string; createdAt: string; messages: Array<{ from: string; body: string; createdAt: string }> }>;
  devices: Array<{ firstSeenAt: string; lastSeenAt: string; accountOrder: number; fingerprintStored: boolean }>;
  savedCards: Array<{ brand: string | null; last4: string | null; expires: string | null; createdAt: string; revokedAt: string | null }>;
  /** Llaves de acceso (Sprint 3.7): nombre y fechas; nunca la clave pública ni el identificador de la credencial. */
  passkeys: Array<{ name: string | null; createdAt: string | null; deviceType: string; synced: boolean }>;
  monthlyPledges: Array<{
    organization: string | null;
    monthlyAmountCents: number;
    feePerMonthCents: number;
    executedMonths: number;
    skippedMonths: number;
    totalMonths: number;
    chargeDay: number;
    nextChargeAt: string | null;
    preferredInitiative: string | null;
    status: string;
    statusReason: string | null;
    termsVersion: string | null;
    createdAt: string;
  }>;
  notifications: Array<{ template: string; status: string; createdAt: string; sentAt: string | null }>;
  supportTickets: Array<{ ticketCode: string; subject: string; message: string; status: string; reply: string | null; createdAt: string }>;
  /** NIF guardados que ninguna clave puede descifrar (se avisa a la plataforma; el resto de la exportación es completo). */
  unreadableTaxIds: number;
}

/**
 * Quién exporta: la propia persona reautenticada (siempre sus datos: no admite otro identificador), o el Super-Admin al atender una
 * solicitud de acceso que llegó por otro canal. Discriminado por `kind`: el actor de una familia nunca acompaña a un `userId` ajeno.
 */
export type ExportRequester = { kind: 'self'; actor: VerifiedAccountActor } | { kind: 'superadmin'; actor: VerifiedSuperadminActor; userId: string };

export async function buildPersonalDataExport(db: Db, keyring: Keyring, requester: ExportRequester, now: Date = new Date()): Promise<PersonalDataExport> {
  assertVerifiedActor(requester.actor, requester.kind === 'self' ? 'verified-account' : 'verified-superadmin', 'privacy.export', now);
  await revalidateActor(db, requester.actor, 'privacy.export', now);
  const userId = requester.kind === 'self' ? requester.actor.userId : requester.userId;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  // Lo que se compró como invitada con este email solo es de esta cuenta si el email está verificado.
  const verified = user.emailVerified;
  const ownContributions: Prisma.ContributionWhereInput = verified ? { OR: [{ userId }, { canonicalEmail: user.canonicalEmail }] } : { userId };
  const [contributions, tickets, consents, requests, memberships, signatures, devices, cards, pledges, messages, support, passkeys, proposals] = await Promise.all([
    db.contribution.findMany({ where: ownContributions, orderBy: { id: 'asc' }, include: { organization: { select: { name: true } }, initiative: { select: { title: true } } } }),
    db.ticketPass.findMany({ where: { OR: [{ contribution: ownContributions }, ...(verified ? [{ holderEmail: user.email }] : [])] }, orderBy: { id: 'asc' }, include: { initiative: { select: { title: true } } } }),
    db.consentRecord.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.privacyRequest.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    db.organizationMember.findMany({ where: { userId }, orderBy: { id: 'asc' }, include: { organization: { select: { name: true } } } }),
    db.ideaSignatureAudit.findMany({ where: { userId }, orderBy: { id: 'asc' }, include: { idea: { select: { title: true } } } }),
    db.deviceAccount.findMany({ where: { userId }, orderBy: { id: 'asc' }, include: { device: { select: { firstSeenAt: true, lastSeenAt: true, fingerprintHmac: true } } } }),
    db.paymentMethodToken.findMany({ where: { userId }, orderBy: { id: 'asc' }, select: { brand: true, last4: true, expiresMonth: true, expiresYear: true, createdAt: true, revokedAt: true } }),
    db.walletSubscription.findMany({ where: { userId }, orderBy: { id: 'asc' }, include: { organization: { select: { name: true } }, initiative: { select: { title: true } } } }),
    db.outboxMessage.findMany({ where: { OR: [{ userId }, ...(verified ? [{ toAddress: user.email }] : [])] }, orderBy: { id: 'asc' }, select: { templateKey: true, status: true, createdAt: true, sentAt: true } }),
    verified ? db.supportTicket.findMany({ where: { senderEmail: user.email }, orderBy: { id: 'asc' } }) : Promise.resolve([]),
    db.passkey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { name: true, createdAt: true, deviceType: true, backedUp: true } }),
    verified ? db.idea.findMany({ where: { authorCanonicalEmail: user.canonicalEmail }, orderBy: { id: 'asc' }, include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } }) : Promise.resolve([])
  ]);

  let unreadableTaxIds = 0;
  const readable = (open: () => string): string | null => {
    try {
      return open();
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      unreadableTaxIds += 1;
      return null;
    }
  };

  const exported: PersonalDataExport = {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: now.toISOString(),
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: user.locale,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      taxId: user.nifEnc ? readable(() => openValue(keyring, user.nifEnc!, user.nifKeyVersion, CRYPTO_CONTEXT.userTaxId(user.id))) : null,
      provinceCode: user.provinceCode,
      postalCode: user.postalCode,
      createdAt: user.createdAt.toISOString(),
      lastActiveAt: user.lastActiveAt.toISOString()
    },
    contributions: contributions.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      organization: row.organization.name,
      initiative: row.initiative.title,
      type: row.type,
      status: row.status,
      paymentMethod: row.paymentMethod,
      amountCents: row.amountCents,
      guaranteeContributionCents: row.guaranteeContributionCents,
      totalChargedCents: row.totalChargedCents,
      refundedCents: row.refundedCents,
      group: row.groupName,
      donorFullName: row.donorFullName,
      donorTaxId: row.donorTaxIdEnc ? readable(() => openDonorTaxId(keyring, row.donorTaxIdEnc!, row.donorTaxIdKeyVersion)) : null,
      donorProvinceCode: row.donorProvinceCode,
      asGuest: row.userId === null
    })),
    tickets: tickets.map((pass) => ({ serialCode: pass.serialCode, initiative: pass.initiative.title, quantity: pass.quantity, checkedInCount: pass.checkedInCount, raffleNumbers: pass.raffleNumbers, revokedAt: iso(pass.revokedAt), createdAt: pass.createdAt.toISOString() })),
    consents: consents.map((row) => ({ purpose: row.purpose, granted: row.granted, policyVersion: row.policyVersion, source: row.source, createdAt: row.createdAt.toISOString() })),
    privacyRequests: requests.map((row) => ({ type: row.type, status: row.status, createdAt: row.createdAt.toISOString(), dueAt: row.dueAt.toISOString(), completedAt: iso(row.completedAt) })),
    memberships: memberships.map((row) => ({ organization: row.organization.name, role: row.role, roleLabel: row.roleLabel, since: row.createdAt.toISOString() })),
    ideaSignatures: signatures.map((row) => ({ idea: row.idea.title, status: row.status, reasonKey: row.reason, accountOrder: row.accountOrder, createdAt: row.createdAt.toISOString() })),
    ideaProposals: proposals.map((row) => ({ alias: row.alias, title: row.title, category: row.category, description: row.description, phase: row.phase, createdAt: row.createdAt.toISOString(), messages: row.messages.map((message) => ({ from: message.senderLabel, body: message.body, createdAt: message.createdAt.toISOString() })) })),
    devices: devices.map((row) => ({ firstSeenAt: row.device.firstSeenAt.toISOString(), lastSeenAt: row.device.lastSeenAt.toISOString(), accountOrder: row.accountOrder, fingerprintStored: row.device.fingerprintHmac !== null })),
    savedCards: cards.map((card) => ({
      brand: card.brand,
      last4: card.last4,
      expires: card.expiresMonth && card.expiresYear ? `${String(card.expiresMonth).padStart(2, '0')}/${card.expiresYear}` : null,
      createdAt: card.createdAt.toISOString(),
      revokedAt: iso(card.revokedAt)
    })),
    passkeys: passkeys.map((row) => ({ name: row.name, createdAt: iso(row.createdAt), deviceType: row.deviceType, synced: row.backedUp })),
    monthlyPledges: pledges.map((row) => ({
      organization: row.organization?.name ?? null,
      monthlyAmountCents: row.monthlyAmountCents,
      feePerMonthCents: row.feePerMonthCents,
      executedMonths: row.executedMonths,
      skippedMonths: row.skippedMonths,
      totalMonths: row.totalMonths,
      chargeDay: row.chargeDay,
      nextChargeAt: row.status === 'ACTIVE' ? row.nextChargeAt.toISOString() : null,
      preferredInitiative: row.initiative?.title ?? null,
      status: row.status,
      statusReason: row.statusReason,
      termsVersion: row.termsVersion,
      createdAt: row.createdAt.toISOString()
    })),
    notifications: messages.map((row) => ({ template: row.templateKey, status: row.status, createdAt: row.createdAt.toISOString(), sentAt: iso(row.sentAt) })),
    supportTickets: support.map((row) => ({ ticketCode: row.ticketCode, subject: row.subject, message: row.message, status: row.status, reply: row.replyMessage, createdAt: row.createdAt.toISOString() })),
    unreadableTaxIds: 0
  };
  exported.unreadableTaxIds = unreadableTaxIds;
  // Exportar descifra datos personales: queda constancia de quién lo hizo y de quién (sin ningún dato de la exportación).
  await writeAudit(db, { actorType: 'USER', actorUserId: requester.actor.userId, action: 'privacy.export', targetType: 'User', targetId: userId, metadata: { requestedBy: requester.kind, unreadableTaxIds } });
  return exported;
}

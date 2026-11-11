import { postJournal } from '@/core/finance/ledger.service';
import type { JournalLine } from '@/core/finance/ledger-accounts';
import type { Keyring } from '@/core/security/crypto';
import type { SignatureReasonKey } from '@/core/security/device-quorum.service';
import { computeSignatureHash, ideaTargetDigest, payoutDigestFor } from '@/core/security/signature-hash';
import { sealInvoiceRecipientTaxId } from '@/core/tax/tax-id-vault';
import type { DoubleCheckTargetType, MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { SEED_ACTOR, signerUserId } from './seed-base';
import type { SeedSecrets } from './seed-funding';
import type { KorumSeedData } from './seed-types';

/**
 * Gobierno de la semilla: liquidaciones con doble firma, facturas, buzón de ideas con su auditoría y soporte.
 * Mismos principios que `seed-funding`: idempotente y sin datos personales reales.
 */

const DAY_MS = 86_400_000;

interface SignatureInput {
  organizationId: string;
  targetType: DoubleCheckTargetType;
  targetId: number;
  targetDigest: string;
  role: Extract<MemberRole, 'DIRECTOR' | 'COSIGNER'>;
  signedAt: Date;
}

async function sign(db: KorumPrismaClient, secrets: SeedSecrets, input: SignatureInput): Promise<void> {
  const userId = signerUserId(input.organizationId, input.role);
  const membership = await db.organizationMember.findUniqueOrThrow({ where: { userId_organizationId_role: { userId, organizationId: input.organizationId, role: input.role } }, select: { id: true } });
  const hash = computeSignatureHash(secrets.hmacSecret, { organizationId: input.organizationId, targetType: input.targetType, targetId: input.targetId, targetDigest: input.targetDigest, signerUserId: userId, signerRole: input.role, membershipId: membership.id, signedAt: input.signedAt, otpVerifiedAt: input.signedAt });
  await db.doubleCheckSignature.createMany({
    data: [
      {
        organizationId: input.organizationId,
        targetType: input.targetType,
        ...(input.targetType === 'ESCROW_PAYOUT' ? { payoutId: input.targetId } : { ideaId: input.targetId }),
        signerUserId: userId,
        signerRole: input.role,
        targetDigest: input.targetDigest,
        membershipId: membership.id,
        signatureHash: hash,
        otpVerifiedAt: input.signedAt,
        signedAt: input.signedAt
      }
    ],
    skipDuplicates: true
  });
}

/**
 * Liquidaciones de las campañas que alcanzaron la meta: la cerrada (ejecutada) y la que espera la 2ª firma. El destino es la
 * ENTIDAD (su titular legal y su cuenta en Paycomet) y no un proveedor: pagar directamente al IBAN de un tercero está pendiente de confirmar
 * con Paycomet (tarea aplazada) y el importe neto incluye la contingencia, que es de la entidad. La factura del proveedor
 * (PROVIDER_INVOICE) no se adjunta en la semilla (no sube ficheros al almacén): en la que espera la 2ª firma, la entidad la adjunta desde
 * Liquidaciones (Sprint 4.4a) antes de que pueda firmar la segunda persona, y las firmas se vuelven a pedir.
 */
export async function seedPayouts(db: KorumPrismaClient, seed: KorumSeedData, secrets: SeedSecrets): Promise<Map<number, number>> {
  const payoutIds = new Map<number, number>();
  for (const initiative of seed.initiatives.filter((candidate) => candidate.status === 'GOAL_REACHED' || candidate.status === 'CLOSED')) {
    const org = seed.schools.find((candidate) => candidate.id === initiative.organizationId);
    if (!org) throw new Error(`La semilla no define la entidad ${initiative.organizationId} de la iniciativa ${initiative.id}`);
    const gatewayInGoal = initiative.absorbsGatewayCostByKorum ? 0 : initiative.gatewayFeeCents;
    const korumFee = initiative.bracketFeeCents + initiative.maintFeeCents;
    const netPaid = initiative.raisedCents - korumFee - gatewayInGoal;
    const closed = initiative.status === 'CLOSED';
    const closesAt = new Date(initiative.closesAt);

    const payout = await db.escrowPayout.upsert({
      where: { initiativeId: initiative.id },
      create: {
        organizationId: initiative.organizationId,
        initiativeId: initiative.id,
        destinationType: 'ORGANIZATION',
        beneficiaryName: org.legalName,
        netPaidCents: netPaid,
        korumFeeSettledCents: korumFee,
        status: closed ? 'EXECUTED' : 'PENDING_DOUBLE_CHECK',
        paycometTransferId: closed ? `SEED-TRF-${initiative.id}` : null,
        executedAt: closed ? new Date(closesAt.getTime() + 2 * DAY_MS) : null,
        createdAt: new Date(closesAt.getTime() + DAY_MS)
      },
      update: {}
    });
    payoutIds.set(initiative.id, payout.id);

    const { paycometSplitId } = await db.organization.findUniqueOrThrow({ where: { id: initiative.organizationId }, select: { paycometSplitId: true } });
    const target = { organizationId: initiative.organizationId, targetType: 'ESCROW_PAYOUT' as const, targetId: payout.id, targetDigest: payoutDigestFor(secrets.hmacSecret, { ...payout, providerInvoiceFile: null }, paycometSplitId) };
    await sign(db, secrets, { ...target, role: 'DIRECTOR', signedAt: new Date(closesAt.getTime() + DAY_MS + 9 * 3_600_000) });
    if (closed) await sign(db, secrets, { ...target, role: 'COSIGNER', signedAt: new Date(closesAt.getTime() + DAY_MS + 12 * 3_600_000) });

    if (closed) {
      const scope = { organizationId: initiative.organizationId, initiativeId: initiative.id };
      const approval: JournalLine[] = [
        { account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: initiative.raisedCents, ...scope },
        { account: 'ORG_PAYABLE', direction: 'CREDIT', amountCents: netPaid, organizationId: scope.organizationId }
      ];
      if (initiative.bracketFeeCents > 0) approval.push({ account: 'KORUM_REVENUE_BRACKET', direction: 'CREDIT', amountCents: initiative.bracketFeeCents, organizationId: scope.organizationId });
      if (initiative.maintFeeCents > 0) approval.push({ account: 'KORUM_REVENUE_MAINTENANCE', direction: 'CREDIT', amountCents: initiative.maintFeeCents, organizationId: scope.organizationId });
      if (gatewayInGoal > 0) approval.push({ account: 'GATEWAY_FEES_RECOVERED', direction: 'CREDIT', amountCents: gatewayInGoal, organizationId: scope.organizationId });
      await postJournal(db, {
        ...scope,
        payoutId: payout.id,
        idempotencyKey: `seed:payout-${initiative.id}:approval`,
        kind: 'PAYOUT_APPROVAL',
        description: `Liquidación aprobada con doble firma: ${initiative.title}`,
        occurredAt: new Date(closesAt.getTime() + DAY_MS + 12 * 3_600_000),
        createdById: SEED_ACTOR,
        lines: approval
      });
      await postJournal(db, {
        ...scope,
        payoutId: payout.id,
        idempotencyKey: `seed:payout-${initiative.id}:split`,
        kind: 'SPLIT_PAYOUT_ORGANIZATION',
        description: `Transferencia a la entidad ${org.legalName}`,
        occurredAt: payout.executedAt ?? closesAt,
        paycometReference: payout.paycometTransferId,
        createdById: SEED_ACTOR,
        lines: [
          { account: 'ORG_PAYABLE', direction: 'DEBIT', amountCents: netPaid, organizationId: scope.organizationId },
          { account: 'PSP_CLEARING', direction: 'CREDIT', amountCents: netPaid, organizationId: scope.organizationId }
        ]
      });
    }
  }
  return payoutIds;
}

/**
 * Facturas de KORUM tal como vienen en la semilla. Son documentos: el IVA de los patrocinios sí se asienta en el libro (ver
 * `seed-funding`), pero el de la comisión por tramos (p. ej. DEMO-2025-0014, 40,32 €) no, hasta que la asesoría fiscal lo decida.
 */
export async function seedInvoices(db: KorumPrismaClient, seed: KorumSeedData, payoutIds: Map<number, number>, keyring: Keyring): Promise<void> {
  const payouts = await db.escrowPayout.findMany({ where: { id: { in: [...payoutIds.values()] } }, select: { id: true, organizationId: true, korumFeeSettledCents: true } });
  let previousHash: string | null = null;
  for (const invoice of [...seed.invoices].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))) {
    const sponsor = seed.sponsors.find((candidate) => candidate.cif === invoice.recipientTaxId && candidate.organizationId === invoice.organizationId);
    const payout = payouts.find((candidate) => candidate.organizationId === invoice.organizationId && candidate.korumFeeSettledCents === invoice.baseAmountCents);
    const recipientTaxId = sealInvoiceRecipientTaxId(keyring, invoice.invoiceNumber, invoice.recipientTaxId);
    await db.invoice.upsert({
      where: { invoiceNumber: invoice.invoiceNumber },
      create: {
        invoiceNumber: invoice.invoiceNumber,
        // Serie propia de demostración: nunca coincide con la numeración real (`FAC-AAAA-NNNN`), ni en una base donde ya se hayan emitido facturas.
        series: 'DEMO',
        organizationId: invoice.organizationId,
        sponsorId: sponsor?.id ?? null,
        payoutId: sponsor ? null : (payout?.id ?? null),
        recipientName: invoice.recipientName,
        ...recipientTaxId,
        concept: invoice.concept,
        baseAmountCents: invoice.baseAmountCents,
        taxRateBps: invoice.taxRateBps,
        taxAmountCents: invoice.taxAmountCents,
        totalAmountCents: invoice.totalAmountCents,
        prevVerifactuHash: previousHash,
        verifactuHash: invoice.verifactuHash,
        verifactuQrUrl: invoice.verifactuQrUrl,
        verifactuStatus: 'ACCEPTED',
        issuedAt: new Date(invoice.issuedAt)
      },
      update: {}
    });
    await db.invoice.updateMany({ where: { invoiceNumber: invoice.invoiceNumber, recipientTaxIdEnc: null }, data: recipientTaxId });
    previousHash = invoice.verifactuHash;
  }
  for (const ticket of seed.supportTickets) {
    await db.supportTicket.upsert({
      where: { ticketCode: ticket.ticketCode },
      create: { ...ticket, organizationId: ticket.organizationId ?? null, createdAt: new Date(ticket.createdAt) },
      update: {}
    });
  }
}

/** La semilla describe el motivo con texto del prototipo; en la base se guarda su clave de traducción, igual que en una firma real. */
function seedReasonKey(entry: { status: string; accountOrder: number }): SignatureReasonKey {
  if (entry.status === 'SUSPICIOUS') return entry.accountOrder > 2 ? 'ideas.audit.tooManyAccounts' : 'ideas.audit.ipBurst';
  return entry.accountOrder === 1 ? 'ideas.audit.firstAccount' : 'ideas.audit.secondAccount';
}

/** Buzón de ideas: cada idea con su auditoría de firmas, su chat anónimo y, la que espera doble firma, la 1ª firma. */
export async function seedIdeas(db: KorumPrismaClient, seed: KorumSeedData, secrets: SeedSecrets): Promise<void> {
  for (const idea of seed.ideas) {
    const expiresAt = new Date(idea.expiresAt);
    const createdAt = new Date(expiresAt.getTime() - 45 * DAY_MS);
    await db.idea.upsert({
      where: { id: idea.id },
      create: {
        id: idea.id,
        organizationId: idea.organizationId,
        alias: idea.alias,
        authorCanonicalEmail: idea.authorCanonicalEmail,
        title: idea.title,
        category: idea.category,
        description: idea.description,
        phase: idea.phase,
        votes: idea.votes,
        verifiedVotes: idea.verifiedVotes,
        suspiciousVotes: idea.suspiciousVotes,
        expiresAt,
        createdAt
      },
      update: {}
    });
    await db.ideaSignatureAudit.createMany({
      data: idea.auditLog.map((entry, index) => ({
        ideaId: idea.id,
        canonicalEmail: entry.canonicalEmail,
        accountOrder: entry.accountOrder,
        status: entry.status,
        reason: seedReasonKey(entry),
        createdAt: new Date(createdAt.getTime() + (index + 1) * DAY_MS)
      })),
      skipDuplicates: true
    });
    if ((await db.ideaMessage.count({ where: { ideaId: idea.id } })) === 0) {
      await db.ideaMessage.createMany({
        data: idea.messages.map((message, index) => ({
          ideaId: idea.id,
          senderRole: message.senderRole,
          senderLabel: message.senderLabel,
          body: message.body,
          createdAt: message.createdAt ? new Date(message.createdAt) : new Date(createdAt.getTime() + (index + 1) * 3_600_000)
        }))
      });
    }
    if (idea.phase === 'DOUBLE_CHECK') {
      await sign(db, secrets, { organizationId: idea.organizationId, targetType: 'IDEA_APPROVAL', targetId: idea.id, targetDigest: ideaTargetDigest(secrets.hmacSecret, { organizationId: idea.organizationId, title: idea.title, category: idea.category, description: idea.description }), role: 'DIRECTOR', signedAt: new Date(expiresAt.getTime() - 10 * DAY_MS) });
    }
  }
}

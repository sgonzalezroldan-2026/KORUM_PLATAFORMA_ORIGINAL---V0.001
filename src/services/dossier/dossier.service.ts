import {
  DOSSIER_LIST_LIMIT,
  dossierReference,
  type DossierCheck,
  type DossierContributionView,
  type DossierData,
  type DossierInitiativeView,
  type DossierKind,
  type DossierPayoutView,
  type DossierRequest,
  type DossierScope
} from '@/core/dossier/dossier-model';
import { getRaisedFromLedger, toSafeNumber } from '@/core/finance/ledger-balances';
import { calculatePublicBreakdown4Lines, PublicBreakdownMismatchError } from '@/core/finance/tco.service';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { entityContributionTypeOf } from './dossier-kinds';
import { afterPayout, allocationKeptAfterPayout, keptAfterPayout, matchingStillInEscrow } from './dossier-raised';
import { ACTIVITY_FUND_ACTIONS, loadDossierAudit, loadDossierEmails, loadDossierLedger, loadDossierSignatures, sumLedgerEntries, type OwnEntries } from './dossier-loaders';

/**
 * Expediente exportable de una aportación, una campaña o una liquidación (Sprint 5.8b). Solo lectura: reúne lo que ya está guardado (cobro, asientos del
 * libro mayor, firmas, avisos de Paycomet, emails enviados y registro de actividad) y lo contrasta con el libro mayor. Quien llama ya ha pasado la guardia
 * (`dossier.repository.ts`) y lee dentro de una transacción de solo lectura, para que la ficha y el libro sean de un mismo instante: sin eso, un cobro
 * confirmado mientras se compone el PDF daría un «NO COINCIDE» falso. Qué datos lleva y cuáles no: `src/core/dossier/dossier-model.ts`.
 */

export interface DossierSubject {
  kind: DossierKind;
  id: number;
  organizationId: string;
  initiativeId: number;
  /** Título de la campaña, para decir qué expediente es antes de descargarlo. */
  initiativeTitle: string;
}

/** El objeto que se pide, sea de la entidad que sea: decidir si se puede ver es cosa de la guardia. `null` si no existe. */
export async function findDossierSubject(db: Db, request: DossierRequest): Promise<DossierSubject | null> {
  const initiative = { select: { title: true } };
  if (request.kind === 'initiative') {
    if (request.ref.by !== 'id') return null;
    const row = await db.initiative.findUnique({ where: { id: request.ref.id }, select: { id: true, organizationId: true, title: true } });
    return row ? { kind: 'initiative', id: row.id, organizationId: row.organizationId, initiativeId: row.id, initiativeTitle: row.title } : null;
  }
  if (request.kind === 'payout') {
    if (request.ref.by !== 'id') return null;
    const row = await db.escrowPayout.findUnique({ where: { id: request.ref.id }, select: { id: true, organizationId: true, initiativeId: true, initiative } });
    return row ? { kind: 'payout', id: row.id, organizationId: row.organizationId, initiativeId: row.initiativeId, initiativeTitle: row.initiative.title } : null;
  }
  const row = await db.contribution.findUnique({
    where: request.ref.by === 'id' ? { id: request.ref.id } : { paycometOrder: request.ref.order },
    select: { id: true, organizationId: true, initiativeId: true, initiative }
  });
  return row ? { kind: 'contribution', id: row.id, organizationId: row.organizationId, initiativeId: row.initiativeId, initiativeTitle: row.initiative.title } : null;
}

/** Cobros que tienen asiento de entrada con su mismo total: los que ya se confirmaron, sea cual sea su estado de hoy. */
const CHARGED_STATUSES = ['COMPLETED', 'REFUND_PENDING', 'REFUNDED', 'CHARGEBACK'];
const PAYIN_KINDS = ['PAYIN_DONATION', 'PAYIN_TICKET', 'PAYIN_SPONSOR', 'SELF_BOOST_INJECTION'] as const;
const PAYIN_TYPES = ['DONATION', 'TICKET', 'SPONSORSHIP', 'SELF_BOOST'];
const REFUNDABLE_TYPES = ['DONATION', 'TICKET', 'SPONSORSHIP'];
const SPLIT_KINDS = ['SPLIT_PAYOUT_ORGANIZATION', 'SPLIT_PAYOUT_PROVIDER'] as const;

async function loadInitiative(db: Db, scope: DossierScope, initiativeId: number) {
  const row = await db.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: {
      id: true, title: true, walletEscrowId: true, format: true, status: true, createdAt: true, closesAt: true, firstPayinAt: true, closedAt: true, goalCents: true, raisedCents: true,
      totalContributions: true, costMatCents: true, costInstCents: true, contingencyBps: true, sourceIdeaId: true,
      organization: { select: { name: true, legalName: true } }
    }
  });
  // Aparte, y no como segunda relación de la consulta anterior: dentro de la transacción, dos relaciones se cargarían a la vez.
  const payout = await db.escrowPayout.findUnique({ where: { initiativeId }, select: { id: true, status: true } });
  const groups = await db.contribution.groupBy({ by: ['type', 'status'], where: { initiativeId, type: { not: 'SPONSORSHIP' } }, _count: { _all: true }, _sum: { amountCents: true } });
  // Los patrocinios, uno a uno (son pocos): el que se cobró aquí pero cuyo dinero pasó entero a la bolsa del comercio no cuenta por su cobro.
  const sponsorships = await db.contribution.findMany({ where: { initiativeId, type: 'SPONSORSHIP' }, select: { id: true, status: true, amountCents: true, sponsor: { select: { amountCents: true, reassignedCents: true, isMatchingPool: true } } } });
  // Lo devuelto o contracargado con la campaña ya liquidada sigue en lo recaudado: se cuenta aparte, con su propio estado.
  const keptGroups = await db.contribution.groupBy({ by: ['type', 'status'], where: { ...keptAfterPayout(initiativeId), type: { notIn: ['SPONSORSHIP', 'MATCHING_FUND'] } }, _count: { _all: true }, _sum: { amountCents: true } });
  const keptSponsorships = new Set((await db.contribution.findMany({ where: { ...keptAfterPayout(initiativeId), type: 'SPONSORSHIP' }, select: { id: true } })).map((kept) => kept.id));
  // Lo colocado aquí desde la bolsa de cada comercio (un comercio colocado dos veces es un patrocinio, no dos), venga su cobro de otra campaña o de esta
  // misma (una renovación colocada en su campaña de referencia): quien tiene una asignación vigente ya no cuenta por su cobro (`MOVED`), así que no se
  // suma dos veces. Y cuenta también la asignación que se cerró con la campaña ya liquidada (el cobro del comercio se devolvió o se contracargó después):
  // ese dinero ya se había enviado, lo asumió KORUM y lo recaudado no bajó. Antes de liquidar, cerrar una asignación sí saca su dinero de la hucha.
  const settled = payout !== null && payout.status !== 'PENDING_DOUBLE_CHECK';
  const allocated = await db.sponsorAllocation.groupBy({
    by: ['sponsorId'],
    where: { initiativeId, OR: [{ withdrawnAt: null }, ...(settled ? [allocationKeptAfterPayout(initiativeId)] : [])] },
    _sum: { amountCents: true }
  });

  let breakdown: DossierInitiativeView['breakdown'] = null;
  if (row.format === 'BUDGET') {
    try {
      const lines = calculatePublicBreakdown4Lines(row);
      breakdown = { line1Cents: lines.line1ProviderCents, line2Cents: lines.line2InstallCents, line3Cents: lines.line3ContingencyCents, line4Cents: lines.line4EscrowAndGuaranteeCents };
    } catch (error) {
      // Unas cifras guardadas que no cuadran con la meta no se publican (tampoco en la ficha pública), pero aquí se dice: es justo lo que hay que poder ver.
      if (!(error instanceof PublicBreakdownMismatchError)) throw error;
      breakdown = 'mismatch';
    }
  }
  const merged = new Map<string, { type: string; status: string; count: number; totalCents: number }>();
  const add = (type: string, status: string, count: number, cents: number) => {
    const key = `${type}:${status}`;
    const current = merged.get(key) ?? { type, status, count: 0, totalCents: 0 };
    merged.set(key, { ...current, count: current.count + count, totalCents: toSafeNumber(current.totalCents + cents) });
  };
  // En el expediente de la entidad el Auto-Impulso es una aportación más de las que admite la campaña: suma igual y no se dice de quién es (Regla 02 §7).
  // Y la bolsa Matching 2x sale en una sola línea con lo que ha añadido (según el libro mayor). Para la entidad, sin su número: restado del de
  // donaciones, diría cuántas quedaron sin emparejar. En la consola, sus liberaciones por estado van debajo como detalle que no suma.
  const matchingAddedCents = await matchingStillInEscrow(db, initiativeId);
  const matchingDetail: DossierInitiativeView['matchingDetail'] = [];
  for (const group of groups) {
    if (group.type === 'MATCHING_FUND') {
      if (scope === 'console') matchingDetail.push({ status: group.status, count: group._count._all, totalCents: toSafeNumber(group._sum.amountCents) });
      continue;
    }
    const type = scope === 'entity' ? entityContributionTypeOf(group.type, row.format) : group.type;
    const kept = keptGroups.find((candidate) => candidate.type === group.type && candidate.status === group.status);
    const keptCount = kept?._count._all ?? 0;
    const keptCents = toSafeNumber(kept?._sum.amountCents);
    if (kept) add(type, afterPayout(group.status), keptCount, keptCents);
    if (group._count._all > keptCount) add(type, group.status, group._count._all - keptCount, toSafeNumber(toSafeNumber(group._sum.amountCents) - keptCents));
  }
  for (const sponsorship of sponsorships) {
    const charged = sponsorship.status === 'COMPLETED' && sponsorship.sponsor !== null;
    // Una bolsa Matching 2x no entra en la hucha al cobrarse sino al emparejar donaciones, y eso ya está en la línea de la bolsa: contarla aquí la sumaría dos veces.
    const sponsor = sponsorship.sponsor;
    // Primero, si pasó entero a la bolsa del comercio (también una bolsa que no llegó a emparejar nada); después, si es una bolsa, y si parte de ella se trasladó.
    // Un patrocinio normal que no se movió y se devolvió o contracargó con la campaña ya liquidada sigue en lo recaudado.
    const keptHere = sponsor !== null && !sponsor.isMatchingPool && sponsor.reassignedCents === 0 && keptSponsorships.has(sponsorship.id);
    const status = keptHere ? afterPayout(sponsorship.status) : !charged || !sponsor ? sponsorship.status : sponsor.reassignedCents >= sponsor.amountCents ? 'MOVED' : sponsor.isMatchingPool ? (sponsor.reassignedCents > 0 ? 'POOL_PARTLY_MOVED' : 'POOL') : 'COMPLETED';
    add('SPONSORSHIP', status, 1, sponsorship.amountCents);
  }
  const view: DossierInitiativeView = {
    id: row.id, title: row.title, walletEscrowId: row.walletEscrowId, format: row.format, status: row.status, createdAt: row.createdAt, closesAt: row.closesAt, firstPayinAt: row.firstPayinAt,
    closedAt: row.closedAt, goalCents: row.goalCents, raisedCents: row.raisedCents, totalContributions: row.totalContributions, breakdown,
    contributions: [...merged.values()].sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status)),
    matchingAddedCents,
    matchingDetail: matchingDetail.sort((a, b) => a.status.localeCompare(b.status)),
    sponsorAllocations: { count: allocated.length, totalCents: toSafeNumber(allocated.reduce((sum, group) => sum + toSafeNumber(group._sum.amountCents), 0)) }
  };
  return { view, entity: row.organization, sourceIdeaId: row.sourceIdeaId, payoutId: payout?.id ?? null };
}

/** ¿Tiene ya la liquidación su asiento de aprobación? (La de ejemplo de una base sembrada antes del 5.8b está enviada sin fecha de aprobación.) */
const isApproved = (payout: { approvedAt: Date | null; status: string }): boolean => payout.approvedAt !== null || payout.status === 'EXECUTED';

async function loadPayout(db: Db, scope: DossierScope, payoutId: number): Promise<DossierPayoutView> {
  const row = await db.escrowPayout.findUniqueOrThrow({
    where: { id: payoutId },
    select: {
      id: true, destinationType: true, beneficiaryName: true, beneficiaryIbanLast4: true, beneficiaryIbanBank: true, providerInvoiceFileId: true, netPaidCents: true, korumFeeSettledCents: true,
      status: true, createdAt: true, approvedAt: true, executedAt: true
    }
  });
  const summary = await db.escrowPayoutSplit.groupBy({ by: ['status'], where: { payoutId }, _count: { _all: true }, _sum: { amountCents: true } });
  // Cobro a cobro solo en la consola: la fecha y el importe de cada cobro dirían a la entidad de quién es cada aportación. Los más recientes, en su orden.
  const splits =
    scope === 'console'
      ? (await db.escrowPayoutSplit.findMany({ where: { payoutId }, orderBy: { id: 'desc' }, take: DOSSIER_LIST_LIMIT, select: { contributionId: true, amountCents: true, status: true, executedAt: true, contribution: { select: { createdAt: true } } } })).reverse()
      : [];
  const escrowOutCents = isApproved(row) ? await sumLedgerEntries(db, 'INITIATIVE_ESCROW', 'DEBIT', { payoutId, kind: 'PAYOUT_APPROVAL' }) : null;
  return {
    id: row.id, destinationType: row.destinationType, beneficiaryName: row.beneficiaryName,
    iban: row.beneficiaryIbanLast4 ? { bank: row.beneficiaryIbanBank, last4: row.beneficiaryIbanLast4 } : null,
    hasProviderInvoice: row.providerInvoiceFileId !== null, netPaidCents: row.netPaidCents, korumFeeSettledCents: row.korumFeeSettledCents, status: row.status, createdAt: row.createdAt,
    approvedAt: row.approvedAt, executedAt: row.executedAt, escrowOutCents,
    splits: splits.map((split) => ({ contributionId: split.contributionId, chargedAt: split.contribution.createdAt, amountCents: split.amountCents, status: split.status, executedAt: split.executedAt })),
    splitSummary: summary.map((group) => ({ status: group.status, count: group._count._all, totalCents: toSafeNumber(group._sum.amountCents) })).sort((a, b) => a.status.localeCompare(b.status)),
    totalSplits: summary.reduce((sum, group) => sum + group._count._all, 0)
  };
}

/**
 * Lo aprobado y lo enviado de una liquidación, frente a sus asientos. Sin aprobar aún no hay asiento con el que comparar. Lo enviado se compara siempre que
 * haya envíos registrados **o** el libro diga que salió dinero: un libro con envíos y ninguno registrado es justo lo que hay que señalar.
 */
async function payoutChecks(db: Db, payout: DossierPayoutView): Promise<DossierCheck[]> {
  if (!isApproved(payout)) return [];
  const approved = await sumLedgerEntries(db, 'ORG_PAYABLE', 'CREDIT', { payoutId: payout.id, kind: 'PAYOUT_APPROVAL' });
  const sentLedger = await sumLedgerEntries(db, 'ORG_PAYABLE', 'DEBIT', { payoutId: payout.id, kind: { in: [...SPLIT_KINDS] } });
  const sentRecord = payout.splitSummary.find((group) => group.status === 'DONE')?.totalCents ?? 0;
  const checks: DossierCheck[] = [{ key: 'payoutNet', recordCents: payout.netPaidCents, ledgerCents: approved }];
  if (payout.totalSplits > 0 || sentLedger > 0) checks.push({ key: 'payoutSent', recordCents: sentRecord, ledgerCents: sentLedger });
  return checks;
}

const jsonText = (value: Prisma.JsonValue | undefined): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

async function loadContribution(db: Db, contributionId: number): Promise<DossierContributionView> {
  const row = await db.contribution.findUniqueOrThrow({
    where: { id: contributionId },
    select: {
      id: true, type: true, status: true, paymentMethod: true, createdAt: true, fiscalYear: true, userId: true, isTaxDeductible: true, donorTaxIdHmac: true, ticketQuantity: true, amountCents: true,
      guaranteeContributionCents: true, matchedBonusCents: true, totalChargedCents: true, refundedCents: true, refundedAt: true, paycometOrder: true, paycometAuthCode: true,
      sponsor: { select: { name: true } }
    }
  });
  const payoutSplits = (await db.escrowPayoutSplit.findMany({ where: { contributionId }, orderBy: { id: 'desc' }, take: DOSSIER_LIST_LIMIT, select: { payoutId: true, amountCents: true, status: true, executedAt: true } })).reverse();
  const fundSplits = (await db.activityFundSplit.findMany({ where: { contributionId }, orderBy: { id: 'desc' }, take: DOSSIER_LIST_LIMIT, select: { payoutId: true, amountCents: true, status: true, executedAt: true } })).reverse();
  // Solo los avisos con firma válida de ese pedido, y de cada uno solo los campos que firma Paycomet (la tarjeta nunca se guarda en `WebhookEvent`).
  const notices = row.paycometOrder
    ? (await db.webhookEvent.findMany({ where: { signatureValid: true, payloadJson: { path: ['Order'], equals: row.paycometOrder } }, orderBy: { id: 'desc' }, take: DOSSIER_LIST_LIMIT, select: { receivedAt: true, status: true, payloadJson: true } })).reverse()
    : [];
  // La cuenta, aparte (una sola relación por consulta dentro de la transacción).
  const account = row.userId ? await db.user.findUnique({ where: { id: row.userId }, select: { gdprAnonymizedAt: true } }) : null;
  const payer: DossierContributionView['payer'] =
    // Lo que añade la bolsa Matching 2x no lo paga nadie en ese momento: es dinero del comercio, cobrado antes con su patrocinio.
    row.type === 'SELF_BOOST' ? { kind: 'korum' } : row.type === 'MATCHING_FUND' ? { kind: 'matching' } : row.sponsor ? { kind: 'sponsor', name: row.sponsor.name } : account ? { kind: account.gdprAnonymizedAt ? 'erasedAccount' : 'account' } : { kind: 'guest' };
  return {
    id: row.id, type: row.type, status: row.status, method: row.paymentMethod, createdAt: row.createdAt, fiscalYear: row.fiscalYear, payer,
    wantsTaxCertificate: row.isTaxDeductible && row.donorTaxIdHmac !== null,
    ticketQuantity: row.ticketQuantity, amountCents: row.amountCents, guaranteeCents: row.guaranteeContributionCents, matchedBonusCents: row.matchedBonusCents, totalChargedCents: row.totalChargedCents,
    refundedCents: row.refundedCents, refundedAt: row.refundedAt, order: row.paycometOrder, authCode: row.paycometAuthCode,
    notifications: notices.map((notice) => {
      const payload = notice.payloadJson !== null && typeof notice.payloadJson === 'object' && !Array.isArray(notice.payloadJson) ? notice.payloadJson : {};
      const amountText = jsonText(payload.Amount);
      const amount = Number(amountText);
      return { receivedAt: notice.receivedAt, transactionType: jsonText(payload.TransactionType).slice(0, 12), response: jsonText(payload.Response).slice(0, 12), amountCents: amountText !== '' && Number.isSafeInteger(amount) ? amount : null, status: notice.status };
    }),
    splits: [
      ...payoutSplits.map((split) => ({ source: 'campaign' as const, payoutId: split.payoutId, amountCents: split.amountCents, status: split.status, executedAt: split.executedAt })),
      ...fundSplits.map((split) => ({ source: 'fund' as const, payoutId: split.payoutId, amountCents: split.amountCents, status: split.status, executedAt: split.executedAt }))
    ]
  };
}

/** Lo cobrado y lo devuelto de una aportación, frente a sus asientos. */
async function contributionChecks(db: Db, contribution: DossierContributionView): Promise<DossierCheck[]> {
  const checks: DossierCheck[] = [];
  if (CHARGED_STATUSES.includes(contribution.status) && PAYIN_TYPES.includes(contribution.type)) {
    checks.push({ key: 'charged', recordCents: contribution.totalChargedCents, ledgerCents: await sumLedgerEntries(db, undefined, 'DEBIT', { contributionId: contribution.id, kind: { in: [...PAYIN_KINDS] } }) });
  }
  // Lo devuelto es lo que salió de Paycomet hacia quien pagó: la devolución normal y la que se hace después de liquidar acaban las dos ahí.
  if (contribution.refundedCents > 0 && REFUNDABLE_TYPES.includes(contribution.type)) {
    checks.push({ key: 'refunded', recordCents: contribution.refundedCents, ledgerCents: await sumLedgerEntries(db, 'PSP_CLEARING', 'CREDIT', { contributionId: contribution.id, kind: 'ESCROW_REFUND_DONOR' }) });
  }
  return checks;
}

export async function loadDossier(db: Db, scope: DossierScope, subject: DossierSubject, now: Date): Promise<DossierData> {
  const { organizationId, initiativeId } = subject;
  const { view: initiative, entity, sourceIdeaId, payoutId } = await loadInitiative(db, scope, initiativeId);
  const own: OwnEntries = { organizationId, initiativeId, format: initiative.format };
  const common = { scope, reference: dossierReference(subject.kind, subject.id), generatedAt: now, entity, initiative };
  const since = initiative.createdAt;

  if (subject.kind === 'contribution') {
    const contribution = await loadContribution(db, subject.id);
    const order = contribution.order;
    // Sus asientos, los que los corrigen y, si liberó bolsa Matching 2x, esa liberación y su anulación (van a nombre del cobro de la bolsa, con el pedido «…-match»).
    const journalWhere: Prisma.LedgerJournalWhereInput = {
      OR: [{ contributionId: subject.id }, { reversesJournal: { contributionId: subject.id } }, ...(order ? [{ paycometReference: order }, { contribution: { paycometOrder: `${order}-match` } }] : [])]
    };
    const emailKeys = ['contribution.receipt', 'ticket.pass', 'refund.issued', 'pledge.charged'].map((template) => `${template}:${subject.id}`);
    const ledger = await loadDossierLedger(db, scope, journalWhere, own);
    const emails = await loadDossierEmails(db, scope, organizationId, since, { OR: [{ idempotencyKey: { in: emailKeys } }, { payloadJson: { path: ['contributionId'], equals: subject.id } }, ...(order ? [{ payloadJson: { path: ['order'], equals: order } }] : [])] });
    const audit = await loadDossierAudit(db, scope, organizationId, { subject: { targetTypes: ['Contribution', 'CONTRIBUTION'], id: subject.id, metadataKey: 'contributionId' } });
    const checks = await contributionChecks(db, contribution);
    return { ...common, kind: 'contribution', contribution, payout: null, ledger, checks, signatures: [], emails, audit: audit.rows, auditTruncated: audit.truncated };
  }

  if (subject.kind === 'initiative') {
    const journalWhere: Prisma.LedgerJournalWhereInput = { OR: [{ initiativeId }, { entries: { some: { initiativeId } } }, ...(payoutId !== null ? [{ payoutId }] : [])] };
    const payout = payoutId !== null ? await loadPayout(db, scope, payoutId) : null;
    const ledger = await loadDossierLedger(db, scope, journalWhere, own);
    const signatures = await loadDossierSignatures(db, scope, organizationId, { ideaId: sourceIdeaId, payoutId });
    const emails = await loadDossierEmails(db, scope, organizationId, since, { payloadJson: { path: ['initiativeId'], equals: initiativeId } });
    const audit = await loadDossierAudit(db, scope, organizationId, { initiativeId });
    const checks: DossierCheck[] = [{ key: 'raised', recordCents: initiative.raisedCents, ledgerCents: await getRaisedFromLedger(db, initiativeId) }, ...(payout ? await payoutChecks(db, payout) : [])];
    return { ...common, kind: 'initiative', payout, ledger, checks, signatures, emails, audit: audit.rows, auditTruncated: audit.truncated };
  }

  const payout = await loadPayout(db, scope, subject.id);
  const journalWhere: Prisma.LedgerJournalWhereInput = { OR: [{ payoutId: subject.id }, { reversesJournal: { payoutId: subject.id } }] };
  const ledger = await loadDossierLedger(db, scope, journalWhere, own);
  const signatures = await loadDossierSignatures(db, scope, organizationId, { ideaId: null, payoutId: subject.id });
  // Solo los avisos de la liquidación de una campaña: la del Fondo de actividades guarda su propio número en el mismo campo, y es otra tabla.
  const emails = await loadDossierEmails(db, scope, organizationId, since, { templateKey: { startsWith: 'payout.' }, OR: [{ payloadJson: { path: ['payoutId'], equals: subject.id } }, { idempotencyKey: { startsWith: `payout.changed:${subject.id}:` } }] });
  const audit = await loadDossierAudit(db, scope, organizationId, { subject: { targetTypes: ['EscrowPayout', 'ESCROW_PAYOUT'], id: subject.id, metadataKey: 'payoutId' }, excludeActions: ACTIVITY_FUND_ACTIONS });
  const checks = await payoutChecks(db, payout);
  return { ...common, kind: 'payout', payout, ledger, checks, signatures, emails, audit: audit.rows, auditTruncated: audit.truncated };
}

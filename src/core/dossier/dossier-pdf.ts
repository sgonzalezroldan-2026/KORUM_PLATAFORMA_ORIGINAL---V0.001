import type { MoneyLocale } from '@/core/finance/money';
import { renderLinesPdf, type PdfLine } from '@/core/pdf/text-pdf';
import type { DossierActor, DossierAuditRow, DossierData, DossierInitiativeView, DossierJournal, DossierPayoutView, DossierSignature } from './dossier-model';
import { contributionSection } from './dossier-pdf-contribution';
import { DOSSIER_INDENT as INDENT, dossierPdfOptions, DossierSheet as Sheet, type DossierTexts } from './dossier-sheet';

export { dossierPdfOptions, pdfSafeText, type DossierTexts } from './dossier-sheet';

/**
 * Maquetación del expediente exportable (Sprint 5.8b) con el escritor de PDF del proyecto. Los textos llegan ya traducidos por las funciones de
 * `DossierTexts` (`audit.dossier.*` y los catálogos del visor de la auditoría); aquí no hay ninguno escrito ni se consulta nada: lo que no viene en
 * `DossierData` no puede salir en el PDF. Los importes pasan todos por `formatCents`.
 *
 * Orden de lectura: primero de qué entidad y de qué campaña se habla, después el objeto del expediente (la aportación o la liquidación, con sus firmas) y
 * al final lo que lo respalda (libro mayor, comprobaciones, emails y registro de actividad).
 */

function initiativeBrief(sheet: Sheet, data: DossierData) {
  const { t } = sheet.texts;
  const initiative = data.initiative;
  sheet.heading(t('sections.initiative'));
  sheet.row('labels.entity', `${data.entity.name} (${data.entity.legalName})`);
  sheet.row('labels.initiative', t('values.numbered', { id: initiative.id, name: initiative.title }));
  sheet.row('labels.wallet', initiative.walletEscrowId);
  sheet.row('labels.format', t(`formats.${initiative.format}`));
  sheet.row('labels.status', sheet.texts.status(initiative.status));
}

function initiativeFull(sheet: Sheet, data: DossierData, initiative: DossierInitiativeView) {
  const { t } = sheet.texts;
  initiativeBrief(sheet, data);
  sheet.row('labels.createdAt', sheet.moment(initiative.createdAt));
  sheet.row('labels.closesAt', sheet.moment(initiative.closesAt));
  // El primer cobro es una aportación: para la entidad, solo su día.
  sheet.row('labels.firstPayinAt', initiative.firstPayinAt === null ? t('values.notYet') : data.scope === 'entity' ? sheet.dayOf(initiative.firstPayinAt) : sheet.moment(initiative.firstPayinAt));
  // Una campaña cerrada sin fecha guardada no está «todavía sin cerrar»: no consta cuándo.
  sheet.row('labels.closedAt', initiative.closedAt ? sheet.moment(initiative.closedAt) : t(initiative.status === 'CLOSED' ? 'values.noDate' : 'values.notYet'));
  sheet.row('labels.goal', sheet.money(initiative.goalCents));
  sheet.row('labels.raised', sheet.money(initiative.raisedCents));
  sheet.row('labels.contributionCount', String(initiative.totalContributions));
  if (initiative.breakdown === 'mismatch') {
    sheet.heading(t('sections.breakdown'));
    sheet.text(t('breakdown.mismatch'));
  } else if (initiative.breakdown) {
    sheet.heading(t('sections.breakdown'));
    const { line1Cents, line2Cents, line3Cents, line4Cents } = initiative.breakdown;
    sheet.row('breakdown.line1', sheet.money(line1Cents));
    sheet.row('breakdown.line2', sheet.money(line2Cents));
    sheet.row('breakdown.line3', sheet.money(line3Cents));
    sheet.row('breakdown.line4', sheet.money(line4Cents));
    sheet.row('breakdown.total', sheet.money(line1Cents + line2Cents + line3Cents + line4Cents));
  }
  sheet.heading(t('sections.contributions'));
  const { matchingAddedCents, matchingDetail } = initiative;
  if (initiative.contributions.length === 0 && initiative.sponsorAllocations.count === 0 && matchingAddedCents === 0 && matchingDetail.length === 0) sheet.text(t('empty.contributions'));
  for (const group of initiative.contributions) {
    sheet.bullet(t('contributionGroup', { type: t(`contributionTypes.${group.type}`), status: t(`contributionStatuses.${group.status}`), count: group.count, total: sheet.money(group.totalCents) }));
  }
  // La bolsa Matching 2x: lo que ha añadido y sigue contando; en la consola, debajo, sus liberaciones por estado (detalle que no suma).
  if (matchingAddedCents > 0 || matchingDetail.length > 0) sheet.bullet(t('matchingAdded', { total: sheet.money(matchingAddedCents) }), matchingDetail.length > 0);
  matchingDetail.forEach((group, index) =>
    sheet.item(t('matchingDetail', { status: t(`contributionStatuses.${group.status}`), count: group.count, total: sheet.money(group.totalCents) }), INDENT, index < matchingDetail.length - 1)
  );
  if (initiative.sponsorAllocations.count > 0) sheet.bullet(t('sponsorAllocations', { count: initiative.sponsorAllocations.count, total: sheet.money(initiative.sponsorAllocations.totalCents) }));
  if (data.scope === 'entity') sheet.text(t('contributionsAnonymous'));
}

function payoutSection(sheet: Sheet, data: DossierData, payout: DossierPayoutView) {
  const { t } = sheet.texts;
  sheet.heading(t('sections.payout'));
  sheet.row('labels.payout', String(payout.id));
  sheet.row('labels.status', sheet.capital(t(`payoutStatuses.${payout.status}`)));
  sheet.row('labels.destination', t(`destinations.${payout.destinationType}`));
  sheet.row('labels.beneficiary', payout.beneficiaryName);
  if (payout.iban) sheet.row('labels.iban', payout.iban.bank ? t('values.ibanWithBank', { bank: payout.iban.bank, last4: payout.iban.last4 }) : t('values.iban', { last4: payout.iban.last4 }));
  sheet.row('labels.providerInvoice', sheet.yesNo(payout.hasProviderInvoice));
  sheet.row('labels.requestedAt', sheet.moment(payout.createdAt));
  sheet.row('labels.approvedAt', sheet.momentOrNotYet(payout.approvedAt));
  sheet.row('labels.executedAt', sheet.momentOrNotYet(payout.executedAt));
  sheet.row('labels.netPaid', sheet.money(payout.netPaidCents));
  sheet.row('labels.korumFee', sheet.money(payout.korumFeeSettledCents));
  // Lo que sale de la hucha al aprobar es la suma de las tres cifras: sin la pasarela, la entidad no podría cuadrar su liquidación.
  if (payout.escrowOutCents !== null) {
    const gatewayCents = payout.escrowOutCents - payout.netPaidCents - payout.korumFeeSettledCents;
    if (gatewayCents >= 0) sheet.row('labels.gatewayInGoal', sheet.money(gatewayCents));
    sheet.row('labels.escrowOut', sheet.money(payout.escrowOutCents));
    // Si de la hucha salió menos que el proyecto y la comisión juntos, algo no cuadra: se dice, no se calla.
    if (gatewayCents < 0) sheet.text(t('payoutGapMismatch'));
  }

  sheet.heading(t('sections.splits'));
  sheet.intro(t('splitsIntro'));
  if (payout.totalSplits === 0) sheet.text(t(['PENDING_DOUBLE_CHECK', 'APPROVED'].includes(payout.status) ? 'empty.splits' : 'empty.splitsMissing'));
  for (const group of payout.splitSummary) sheet.bullet(t('splitSummaryLine', { status: t(`splitStatuses.${group.status}`), count: group.count, total: sheet.money(group.totalCents) }));
  // Cobro a cobro, solo en la consola: la fecha y el importe de cada cobro dirían a la entidad de quién es cada aportación.
  if (data.scope !== 'console') return;
  for (const split of payout.splits) {
    sheet.bullet(t('splitLine', { id: split.contributionId, charged: sheet.moment(split.chargedAt), amount: sheet.money(split.amountCents), status: t(`splitStatuses.${split.status}`), date: sheet.momentOrNotYet(split.executedAt) }));
  }
  if (payout.totalSplits > payout.splits.length) sheet.text(t('truncated', { shown: payout.splits.length, total: payout.totalSplits }));
}

function signaturesSection(sheet: Sheet, signatures: readonly DossierSignature[]) {
  const { t, role } = sheet.texts;
  sheet.heading(t('sections.signatures'));
  if (signatures.length === 0) sheet.text(t('empty.signatures'));
  for (const signature of signatures) {
    sheet.bullet(
      t('signatureLine', {
        target: t(`signatureTargets.${signature.target}`),
        role: role(signature.role),
        name: signature.name ?? t('signerUnnamed'),
        date: sheet.moment(signature.signedAt),
        otp: sheet.yesNo(signature.otpVerified)
      }),
      true
    );
    sheet.item(t('signatureHash', { hash: signature.hash }), INDENT);
  }
}

function journalLines(sheet: Sheet, journal: DossierJournal) {
  const { t } = sheet.texts;
  const parts = [t('journal.title', { id: journal.id, date: sheet.moment(journal.occurredAt), kind: t(`journalKinds.${journal.kind}`) })];
  // El rótulo no se separa de su código al saltar de línea («pedido» arriba y el código abajo): van unidos con un espacio duro.
  if (journal.reference) parts.push(t('journal.reference', { reference: journal.reference }).replace(` ${journal.reference}`, () => `\u00a0${journal.reference}`));
  if (journal.reversesId !== null) parts.push(t('journal.reverses', { id: journal.reversesId }));
  // El asiento va con sus apuntes: no se queda su título al pie de una página.
  sheet.item(parts.join(' · '), '', journal.entries.length > 0);
  journal.entries.forEach((entry, index) => sheet.item(`${t(`journal.${entry.direction}`)} · ${t(`accounts.${entry.account}`)} · ${sheet.money(entry.amountCents)}`, INDENT, index < journal.entries.length - 1));
}

function ledgerSection(sheet: Sheet, data: DossierData) {
  const { t } = sheet.texts;
  if (data.scope === 'console') {
    sheet.heading(t('sections.ledger'));
    sheet.intro(t('ledgerIntro.console'));
    if (data.ledger.journals.length === 0) sheet.text(t('empty.ledger'));
    for (const journal of data.ledger.journals) journalLines(sheet, journal);
    if (data.ledger.totalJournals > data.ledger.journals.length) sheet.text(t('truncated', { shown: data.ledger.journals.length, total: data.ledger.totalJournals }));
    // Sin asientos no hay nada que cuadrar: basta con decir que no los hay.
    if (data.ledger.journals.length > 0) sheet.text(data.ledger.unbalanced === 0 ? t('ledgerBalanced', { count: data.ledger.journals.length }) : t('ledgerUnbalanced', { count: data.ledger.unbalanced }));
    return;
  }
  // Para la entidad: lo que entra y sale de lo suyo, sumado por tipo. Las dos cuentas que ve son de pasivo: el haber es una entrada.
  sheet.heading(t('sections.ledgerEntity'));
  sheet.intro(t('ledgerIntro.entity'));
  sheet.intro(t('ledgerIntro.entityGap'));
  if (data.ledger.movementsOmitted) sheet.text(t('movementsOmitted', { total: data.ledger.totalJournals }));
  else if (data.ledger.movements.length === 0) sheet.text(t('empty.movements'));
  for (const movement of data.ledger.movements) {
    const values = {
      // La anulación de lo que añadió la bolsa Matching tiene nombre propio solo en este expediente (en el libro es un contra-asiento).
      kind: movement.kind === 'MATCHING_UNDONE' ? t('matchingUndone') : t(`journalKinds.${movement.kind}`),
      side: t(movement.direction === 'CREDIT' ? 'journal.in' : 'journal.out'),
      account: t(`accounts.${movement.account}`),
      total: sheet.money(movement.totalCents)
    };
    // Lo de la bolsa Matching 2x, sin días ni número: «En toda la campaña · …».
    if (movement.count === null || movement.from === null || movement.to === null) sheet.bullet(t('movementLineUncounted', values));
    else sheet.bullet(t('movementLine', { ...values, count: movement.count, period: movement.from === movement.to ? sheet.day(movement.from) : t('values.period', { from: sheet.day(movement.from), to: sheet.day(movement.to) }) }));
  }
}

function checksSection(sheet: Sheet, data: DossierData) {
  const { t } = sheet.texts;
  if (data.checks.length === 0) return;
  sheet.heading(t(data.scope === 'console' ? 'sections.checks' : 'sections.checksEntity'));
  sheet.intro(t(`checksIntro.${data.scope}`));
  for (const check of data.checks) {
    sheet.bullet(t(`checkLine.${data.scope}`, { what: t(`checks.${check.key}`), record: sheet.money(check.recordCents), ledger: sheet.money(check.ledgerCents), result: t(check.recordCents === check.ledgerCents ? 'checkOk' : 'checkMismatch') }));
  }
}

function emailsSection(sheet: Sheet, data: DossierData) {
  const { t } = sheet.texts;
  sheet.heading(t('sections.emails'));
  sheet.intro(t('emailsIntro'));
  if (data.emails.length === 0) sheet.text(t('empty.emails'));
  for (const group of data.emails) {
    const date = data.scope === 'entity' ? sheet.dayOf : sheet.moment;
    const when = group.count === 1 || date(group.firstAt) === date(group.lastAt) ? date(group.firstAt) : t('values.between', { from: date(group.firstAt), to: date(group.lastAt) });
    sheet.bullet(t('emailLine', { template: sheet.texts.emailTemplate(group.templateKey), status: t(`emailStatuses.${group.status}`), count: group.count, when }));
  }
}

const actorText = (sheet: Sheet, actor: DossierActor): string =>
  // El cargo, con el mismo nombre que en el apartado de firmas y en el idioma del expediente (el rótulo que escribió la entidad solo está en el suyo).
  actor.kind === 'member' ? sheet.texts.t('values.member', { name: actor.name, role: sheet.texts.role(actor.role) }) : sheet.texts.actor(actor.kind);

function targetText(sheet: Sheet, target: DossierAuditRow['target']): string {
  const type = sheet.texts.target(target.type) ?? target.type;
  if (!target.id) return type;
  return target.name ? sheet.texts.t('values.targetNamed', { type, id: target.id, name: target.name }) : sheet.texts.t('values.target', { type, id: target.id });
}

/**
 * Cuándo pasó algo del registro. En el expediente de la entidad, solo el día: un cambio de estado se anota en el instante de la aportación que completa la
 * meta (o del contracargo que la reabre), y esa hora señalaría una aportación. Su panel hace lo mismo con esas filas (`isContributionInstant`). La consola
 * conserva la hora.
 */
const whenOf = (sheet: Sheet, data: DossierData) => (data.scope === 'entity' ? sheet.dayOf : sheet.moment);

function statusChangesSection(sheet: Sheet, data: DossierData) {
  const { t, status, reason } = sheet.texts;
  const changes = data.audit.filter((row) => row.statusChange !== null);
  const date = whenOf(sheet, data);
  sheet.heading(t('sections.statusChanges'));
  if (changes.length === 0) sheet.text(t('empty.statusChanges'));
  for (const row of changes) {
    const change = row.statusChange!;
    const why = change.reason ? t('values.reason', { reason: reason(change.reason) }) : t('values.noReason');
    sheet.bullet(t('statusChangeLine', { date: date(row.occurredAt), from: status(change.from), to: status(change.to), why }));
  }
}

function auditSection(sheet: Sheet, data: DossierData) {
  const { t, action } = sheet.texts;
  sheet.heading(t('sections.audit'));
  sheet.intro(t(`auditIntro.${data.scope}`));
  if (data.audit.length === 0) sheet.text(t('empty.audit'));
  const date = whenOf(sheet, data);
  for (const row of data.audit) {
    sheet.bullet(`${date(row.occurredAt)} · ${action(row.action)}`, true);
    sheet.item(t('auditLine', { who: actorText(sheet, row.actor), about: targetText(sheet, row.target) }), INDENT);
  }
  if (data.auditTruncated) sheet.text(t('auditTruncated', { shown: data.audit.length }));
}

export function buildDossierLines(data: DossierData, texts: DossierTexts, locale: MoneyLocale): PdfLine[] {
  const sheet = new Sheet(locale, texts);
  const { t } = texts;
  sheet.title(t(`title.${data.kind}`));
  sheet.row('labels.reference', data.reference);
  sheet.row('labels.generatedAt', sheet.moment(data.generatedAt));
  sheet.blank();
  sheet.text(t(`intro.${data.scope}`));

  if (data.kind === 'contribution') {
    initiativeBrief(sheet, data);
    contributionSection(sheet, data.contribution);
  } else if (data.kind === 'initiative') {
    initiativeFull(sheet, data, data.initiative);
    statusChangesSection(sheet, data);
    if (data.payout) payoutSection(sheet, data, data.payout);
    signaturesSection(sheet, data.signatures);
  } else {
    initiativeBrief(sheet, data);
    payoutSection(sheet, data, data.payout);
    signaturesSection(sheet, data.signatures);
  }
  ledgerSection(sheet, data);
  checksSection(sheet, data);
  emailsSection(sheet, data);
  auditSection(sheet, data);

  sheet.heading(t('sections.notes'));
  sheet.text(t(`notes.personalData.${data.scope}`));
  sheet.text(t('notes.platform'));
  sheet.text(t('notes.times'));
  return sheet.lines;
}

export function renderDossierPdf(data: DossierData, texts: DossierTexts, locale: MoneyLocale): Uint8Array {
  return renderLinesPdf(buildDossierLines(data, texts, locale), dossierPdfOptions(data, texts));
}

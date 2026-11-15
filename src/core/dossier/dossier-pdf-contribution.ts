import type { DossierContributionView } from './dossier-model';
import type { DossierSheet as Sheet } from './dossier-sheet';

/**
 * Apartados propios del expediente de una aportación (Sprint 5.8b): el cobro, los avisos firmados de Paycomet dichos con palabras y las liquidaciones que
 * lo han enviado. Solo existe en la consola. Los textos llegan traducidos; aquí solo hay maquetación.
 */

function operationText(sheet: Sheet, transactionType: string): string {
  const { t } = sheet.texts;
  return ['1', '2', '106'].includes(transactionType) ? t(`operations.${transactionType}`) : t('operations.other', { type: transactionType || '?' });
}

export function contributionSection(sheet: Sheet, contribution: DossierContributionView) {
  const { t } = sheet.texts;
  sheet.heading(t('sections.contribution'));
  sheet.row('labels.contribution', String(contribution.id));
  sheet.row('labels.type', t(`contributionTypes.${contribution.type}`));
  sheet.row('labels.status', sheet.capital(t(`contributionStatuses.${contribution.status}`)));
  sheet.row('labels.createdAt', sheet.moment(contribution.createdAt));
  sheet.row('labels.method', t(`methods.${contribution.method}`));
  const payer = contribution.payer;
  sheet.row('labels.payer', payer.kind === 'sponsor' ? t('payer.sponsor', { name: payer.name }) : t(`payer.${payer.kind}`));
  sheet.row('labels.amount', sheet.money(contribution.amountCents));
  sheet.row('labels.guarantee', sheet.money(contribution.guaranteeCents));
  sheet.row('labels.totalCharged', sheet.money(contribution.totalChargedCents));
  if (contribution.matchedBonusCents > 0) sheet.row('labels.matchedBonus', sheet.money(contribution.matchedBonusCents));
  if (contribution.ticketQuantity !== null) sheet.row('labels.ticketQuantity', String(contribution.ticketQuantity));
  const refunded = sheet.money(contribution.refundedCents);
  sheet.row('labels.refunded', contribution.refundedCents === 0 ? t('values.notRefunded') : contribution.refundedAt ? t('values.refunded', { amount: refunded, date: sheet.moment(contribution.refundedAt) }) : refunded);
  sheet.row('labels.order', contribution.order ?? t('none'));
  sheet.row('labels.authCode', contribution.authCode ?? t('none'));
  sheet.row('labels.fiscalYear', String(contribution.fiscalYear));
  sheet.row('labels.taxCertificate', sheet.yesNo(contribution.wantsTaxCertificate));
  sheet.text(t('contributionPrivacy'));

  sheet.heading(t('sections.notifications'));
  if (contribution.notifications.length === 0) sheet.text(t('empty.notifications'));
  for (const notice of contribution.notifications) {
    sheet.bullet(
      t('notificationLine', {
        date: sheet.moment(notice.receivedAt),
        operation: operationText(sheet, notice.transactionType),
        result: notice.response === 'OK' ? t('responses.ok') : t('responses.other', { response: notice.response || '?' }),
        amount: notice.amountCents === null ? t('none') : sheet.money(notice.amountCents),
        status: t(`notificationStatuses.${notice.status}`)
      })
    );
  }

  sheet.heading(t('sections.contributionSplits'));
  if (contribution.splits.length === 0) sheet.text(t('empty.contributionSplits'));
  for (const split of contribution.splits) {
    sheet.bullet(t(`contributionSplitLine.${split.source}`, { id: split.payoutId, amount: sheet.money(split.amountCents), status: t(`splitStatuses.${split.status}`), date: sheet.momentOrNotYet(split.executedAt) }));
  }
}

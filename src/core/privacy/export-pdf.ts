import { formatCents } from '@/core/finance/money';
import { renderLinesPdf, wrapPdfText as wrap, type PdfLine as Line } from '@/core/pdf/text-pdf';
import type { PersonalDataExport } from './personal-data-export';

/**
 * Versión legible en PDF de la exportación de datos (QA-PRIV01). El escritor de PDF es `core/pdf/text-pdf.ts` (compartido con el informe de
 * medallas del Sprint 4.1). Todos los textos salen del catálogo de traducción (`privacy.export.*`) a través de `t`; aquí solo hay maquetación.
 */

export type ExportTranslator = (key: string, values?: Record<string, string>) => string;
export type ExportLocale = 'es' | 'ca' | 'en';

function layout(data: PersonalDataExport, t: ExportTranslator, locale: ExportLocale): Line[] {
  const date = (value: string | null) => (value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(value)) : '—');
  const money = (cents: number) => formatCents(cents, locale);
  const yesNo = (value: boolean) => t(value ? 'yes' : 'no');
  const translated = (group: string, code: string) => {
    const text = t(`${group}.${code}`);
    return text === `${group}.${code}` ? code : text;
  };
  const lines: Line[] = [{ style: 'title', text: t('title') }, ...wrap(t('intro')).map((text) => ({ style: 'body' as const, text })), { style: 'body', text: t('generatedAt', { date: date(data.generatedAt) }) }];
  const section = (key: string, records: Array<Array<[string, string]>>) => {
    lines.push({ style: 'heading', text: t(`sections.${key}`) });
    if (records.length === 0) lines.push({ style: 'body', text: t('empty') });
    for (const fields of records) {
      for (const text of wrap(fields.map(([label, value]) => `${t(`fields.${label}`)}: ${value || '—'}`).join(' · '))) lines.push({ style: 'body', text });
      lines.push({ style: 'body', text: '' });
    }
  };
  const { account } = data;
  section('account', [
    [['name', account.name], ['email', account.email], ['locale', account.locale], ['taxId', account.taxId ?? ''], ['province', account.provinceCode ?? ''], ['postalCode', account.postalCode ?? '']],
    [['createdAt', date(account.createdAt)], ['lastActiveAt', date(account.lastActiveAt)], ['twoFactor', yesNo(account.twoFactorEnabled)]]
  ]);
  section('contributions', data.contributions.map((row) => [
    ['date', date(row.createdAt)], ['organization', row.organization], ['initiative', row.initiative], ['type', translated('types', row.type)], ['status', translated('statuses', row.status)],
    ['amount', money(row.amountCents)], ['guarantee', money(row.guaranteeContributionCents)], ['charged', money(row.totalChargedCents)], ['refunded', money(row.refundedCents)],
    ['group', row.group ?? ''], ['donorName', row.donorFullName ?? ''], ['taxId', row.donorTaxId ?? ''], ['province', row.donorProvinceCode ?? ''], ['asGuest', yesNo(row.asGuest)]
  ]));
  section('tickets', data.tickets.map((row) => [['serial', row.serialCode], ['initiative', row.initiative], ['quantity', String(row.quantity)], ['checkedIn', String(row.checkedInCount)], ['raffleNumbers', row.raffleNumbers.join(', ')], ['revoked', date(row.revokedAt)]]));
  section('consents', data.consents.map((row) => [['date', date(row.createdAt)], ['purpose', translated('purposes', row.purpose)], ['granted', yesNo(row.granted)], ['policyVersion', row.policyVersion], ['source', row.source]]));
  section('privacyRequests', data.privacyRequests.map((row) => [['date', date(row.createdAt)], ['type', translated('requestTypes', row.type)], ['status', translated('requestStatuses', row.status)], ['dueAt', date(row.dueAt)], ['completedAt', date(row.completedAt)]]));
  section('memberships', data.memberships.map((row) => [['organization', row.organization], ['role', row.roleLabel ?? row.role], ['date', date(row.since)]]));
  section('ideaSignatures', data.ideaSignatures.map((row) => [['date', date(row.createdAt)], ['idea', row.idea], ['status', row.status], ['accountOrder', String(row.accountOrder)]]));
  section(
    'ideaProposals',
    data.ideaProposals.flatMap((row) => [
      [['date', date(row.createdAt)], ['alias', row.alias], ['idea', row.title], ['message', row.description], ['status', row.phase]] as Array<[string, string]>,
      ...row.messages.map((message): Array<[string, string]> => [['date', date(message.createdAt)], ['sender', message.from], ['message', message.body]])
    ])
  );
  section('devices', data.devices.map((row) => [['firstSeen', date(row.firstSeenAt)], ['lastSeen', date(row.lastSeenAt)], ['accountOrder', String(row.accountOrder)], ['fingerprint', yesNo(row.fingerprintStored)]]));
  section('savedCards', data.savedCards.map((row) => [['card', `${row.brand ?? ''} ${row.last4 ? `•••• ${row.last4}` : ''}`.trim()], ['expires', row.expires ?? ''], ['date', date(row.createdAt)], ['revoked', date(row.revokedAt)]]));
  section('passkeys', data.passkeys.map((row) => [['name', row.name ?? ''], ['date', date(row.createdAt)], ['synced', yesNo(row.synced)]]));
  section('notifications', data.notifications.map((row) => [['date', date(row.createdAt)], ['template', row.template], ['status', translated('emailStatuses', row.status)], ['completedAt', date(row.sentAt)]]));
  section('supportTickets', data.supportTickets.map((row) => [['date', date(row.createdAt)], ['serial', row.ticketCode], ['subject', row.subject], ['message', row.message], ['reply', row.reply ?? ''], ['status', row.status]]));
  section('monthlyPledges', data.monthlyPledges.map((row) => [['organization', row.organization ?? ''], ['monthly', money(row.monthlyAmountCents)], ['pledgeFee', money(row.feePerMonthCents)], ['progress', `${row.executedMonths}/${row.totalMonths}`], ['pledgeCampaign', row.preferredInitiative ?? ''], ['nextCharge', row.nextChargeAt ? date(row.nextChargeAt) : ''], ['status', translated('pledgeStatuses', row.status)]]));
  return lines;
}

export function renderPersonalDataPdf(data: PersonalDataExport, t: ExportTranslator, locale: ExportLocale): Uint8Array {
  return renderLinesPdf(layout(data, t, locale));
}

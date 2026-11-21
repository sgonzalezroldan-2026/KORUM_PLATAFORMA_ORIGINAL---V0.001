import { formatCents } from '@/core/finance/money';
import { renderLinesPdf, wrapPdfText as wrap, type PdfLine as Line } from '@/core/pdf/text-pdf';
import type { PersonalDataExport } from './personal-data-export';

/** «Información sobre el tratamiento» (RGPD art. 15.1, `L-011`; Sprint 5.10b): va al principio de la copia, en JSON y en PDF, en el idioma de la persona. */
export interface ProcessingInfoSection {
  title: string;
  text: string;
}

/** Lo que se entrega: los datos y la información sobre el tratamiento. */
export type PersonalDataFile = PersonalDataExport & { processingInfo: ProcessingInfoSection[] };

/** Apartados de la información, en orden (catálogo `privacy.export.processingInfo.*`): responsable, fines, bases, destinatarios, transferencias, plazos, origen, decisiones automatizadas, derechos y reclamación. */
export const PROCESSING_INFO_KEYS = ['controller', 'purposes', 'legalBases', 'recipients', 'transfers', 'retention', 'source', 'automated', 'rights', 'complaint'] as const;

/** Con el nombre de la empresa y el email de privacidad de la consola (`platform.company`), los mismos que publica la política de privacidad. */
export function processingInfoSections(t: ExportTranslator, company: { legalName: string; privacyEmail: string }): ProcessingInfoSection[] {
  return PROCESSING_INFO_KEYS.map((key) => ({ title: t(`processingInfo.${key}.title`), text: t(`processingInfo.${key}.text`, { company: company.legalName, privacyEmail: company.privacyEmail }) }));
}

/**
 * Versión legible en PDF de la exportación de datos (QA-PRIV01). El escritor de PDF es `core/pdf/text-pdf.ts` (compartido con el informe de
 * medallas del Sprint 4.1). Todos los textos salen del catálogo de traducción (`privacy.export.*`) a través de `t`; aquí solo hay maquetación.
 */

export type ExportTranslator = (key: string, values?: Record<string, string>) => string;
export type ExportLocale = 'es' | 'ca' | 'en';

function layout(data: PersonalDataFile, t: ExportTranslator, locale: ExportLocale): Line[] {
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
  lines.push({ style: 'heading', text: t('sections.processingInfo') });
  for (const info of data.processingInfo) {
    lines.push({ style: 'body', text: info.title });
    for (const text of wrap(info.text)) lines.push({ style: 'body', text });
    lines.push({ style: 'body', text: '' });
  }
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
  section('tickets', data.tickets.map((row) => [['serial', row.serialCode], ['initiative', row.initiative], ['quantity', String(row.quantity)], ['checkedIn', String(row.checkedInCount)], ['revoked', date(row.revokedAt)]]));
  section('consents', data.consents.map((row) => [['date', date(row.createdAt)], ['purpose', translated('purposes', row.purpose)], ['granted', yesNo(row.granted)], ['policyVersion', row.policyLocale ? `${row.policyVersion} (${row.policyLocale})` : row.policyVersion], ['source', row.source]]));
  section('legalAcceptances', data.legalAcceptances.map((row) => [['date', date(row.acceptedAt)], ['document', row.document], ['policyVersion', `${row.version} (${row.locale})`], ['organization', row.organization ?? ''], ['source', row.source]]));
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
  section('resizeVotes', data.resizeVotes.map((row) => [['date', date(row.createdAt)], ['initiative', row.initiative], ['choice', row.wantsRefund ? t('refundChoice') : (row.choice ?? '')]]));
  section('securityTraces', data.securityTraces.map((row) => [['date', date(row.occurredAt)], ['securityEvent', t(row.action === 'auth.sign_in_failed_repeatedly' ? 'securityEvents.signInFailed' : 'securityEvents.accessDenied')], ['reason', row.reason ?? ''], ['failures', row.failures === null ? '' : String(row.failures)]]));
  section('monthlyPledges', data.monthlyPledges.map((row) => [['organization', row.organization ?? ''], ['monthly', money(row.monthlyAmountCents)], ['pledgeFee', money(row.feePerMonthCents)], ['progress', `${row.executedMonths}/${row.totalMonths}`], ['pledgeCampaign', row.preferredInitiative ?? ''], ['nextCharge', row.nextChargeAt ? date(row.nextChargeAt) : ''], ['status', translated('pledgeStatuses', row.status)]]));
  return lines;
}

export function renderPersonalDataPdf(data: PersonalDataFile, t: ExportTranslator, locale: ExportLocale): Uint8Array {
  return renderLinesPdf(layout(data, t, locale));
}

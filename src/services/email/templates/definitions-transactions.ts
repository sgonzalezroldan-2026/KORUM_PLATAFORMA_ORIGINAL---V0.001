import { z } from 'zod';
import { buildPassQrPayload, signPassView } from '@/core/ticketing/qr-signature';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';
import { buildCalendarAttachment, buildQrAttachment } from './ticket-assets';

/**
 * Emails de dinero y de entradas: recibo, entrada o papeleta, reembolso y firma pendiente. Los textos están en `messages/*.json`
 * (espacio `email`); aquí solo se decide qué datos van en cada uno.
 */

const centsSchema = z.number().int().nonnegative();

function requireInitiative(context: TemplateContext, template: string): NonNullable<TemplateContext['initiative']> {
  if (!context.initiative) throw new Error(`La plantilla ${template} necesita una iniciativa.`);
  return context.initiative;
}

function requireOrganization(context: TemplateContext, template: string): NonNullable<TemplateContext['organization']> {
  if (!context.organization) throw new Error(`La plantilla ${template} necesita una entidad.`);
  return context.organization;
}

const receiptPayload = z.object({
  initiativeId: z.number().int().positive(),
  amountCents: centsSchema,
  guaranteeCents: centsSchema,
  totalCents: centsSchema,
  reference: z.string().min(1).max(64),
  groupName: z.string().max(120).nullable().optional(),
  /** La entidad tiene Ley 49/2002 verificada: el recibo habla del certificado fiscal en lugar del justificante nominativo. */
  fiscalCertificate: z.boolean()
});

export const contributionReceipt: TemplateDefinition<z.infer<typeof receiptPayload>> = {
  schema: receiptPayload,
  needs: 'initiative',
  build(payload, context) {
    const { t } = context;
    const initiative = requireInitiative(context, 'contribution.receipt');
    const organization = requireOrganization(context, 'contribution.receipt');
    const facts = [{ label: t('receipt.contribution'), value: context.formatMoney(payload.amountCents) }];
    if (payload.guaranteeCents > 0) facts.push({ label: t('receipt.voluntary'), value: context.formatMoney(payload.guaranteeCents) });
    facts.push({ label: t('receipt.total'), value: context.formatMoney(payload.totalCents) });
    if (payload.groupName) facts.push({ label: t('receipt.group'), value: payload.groupName });
    facts.push({ label: t('receipt.holder'), value: organization.legalName }, { label: t('receipt.reference'), value: payload.reference });
    return {
      subject: t('receipt.subject', { initiative: initiative.title }),
      preheader: t('receipt.preheader'),
      title: t('receipt.title'),
      paragraphs: [t('receipt.body', { amount: context.formatMoney(payload.amountCents), initiative: initiative.title, organization: organization.name }), t('receipt.guarantee'), t(payload.fiscalCertificate ? 'receipt.fiscalCertificate' : 'receipt.fiscalReceipt')],
      facts,
      button: { label: t('receipt.cta'), url: context.url(`/${organization.slug}/iniciativas/${initiative.id}`) },
      footer: 'transactional'
    };
  }
};

const ticketPayload = z.object({
  passUuid: z.uuid(),
  serialCode: z.string().min(1).max(40),
  initiativeId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  raffleNumbers: z.array(z.number().int().positive()).default([])
});

export const ticketPass: TemplateDefinition<z.infer<typeof ticketPayload>> = {
  schema: ticketPayload,
  needs: 'initiative',
  async build(payload, context) {
    const { t } = context;
    const initiative = requireInitiative(context, 'ticket.pass');
    const organization = requireOrganization(context, 'ticket.pass');
    if (!context.qrSecret) throw new Error('La entrada necesita QR_HMAC_SECRET para componer su código QR.');
    const raffle = initiative.ticketSubtype === 'RAFFLE';

    const facts = [{ label: t('ticket.serial'), value: payload.serialCode }, { label: t('ticket.quantity'), value: t('common.quantity', { count: payload.quantity }) }];
    if (raffle && payload.raffleNumbers.length > 0) facts.push({ label: t('ticket.numbers'), value: payload.raffleNumbers.join(', ') });
    if (!raffle) {
      facts.push({ label: t('ticket.date'), value: context.formatDate(initiative.closesAt) });
      if (initiative.ticketVenue) facts.push({ label: t('ticket.venue'), value: initiative.ticketVenue });
    }

    const attachments = [await buildQrAttachment(buildPassQrPayload(context.qrSecret, payload.passUuid), `${payload.serialCode}.png`)];
    if (!raffle) {
      attachments.push(buildCalendarAttachment({ uid: payload.passUuid, summary: initiative.title, location: initiative.ticketVenue, date: initiative.closesAt, stamp: context.createdAt, filename: `${payload.serialCode}.ics` }));
    }

    // Enlace de acceso directo al pase para quien compró como invitado: el identificador y una firma propia de «ver», distinta de la del QR.
    const accessUrl = context.url(`/${organization.slug}/entrada/${payload.passUuid}?sig=${signPassView(context.qrSecret, payload.passUuid)}`);
    return {
      subject: t(raffle ? 'ticket.subjectRaffle' : 'ticket.subjectEvent', { initiative: initiative.title }),
      preheader: t('ticket.preheader'),
      title: t(raffle ? 'ticket.titleRaffle' : 'ticket.titleEvent'),
      paragraphs: [t(raffle ? 'ticket.bodyRaffle' : 'ticket.bodyEvent')],
      facts,
      button: { label: t('ticket.cta'), url: accessUrl },
      footnote: t('ticket.footnote'),
      footer: 'transactional',
      attachments
    };
  }
};

const refundPayload = z.object({ initiativeId: z.number().int().positive(), amountCents: centsSchema });

export const refundIssued: TemplateDefinition<z.infer<typeof refundPayload>> = {
  schema: refundPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const initiative = requireInitiative(context, 'refund.issued');
    const organization = requireOrganization(context, 'refund.issued');
    return {
      subject: t('refund.subject', { initiative: initiative.title }),
      preheader: t('refund.preheader'),
      title: t('refund.title'),
      paragraphs: [t('refund.body', { amount: context.formatMoney(payload.amountCents) }), t('refund.timing')],
      facts: [{ label: t('refund.amount'), value: context.formatMoney(payload.amountCents) }],
      button: { label: t('refund.cta'), url: context.url(`/${organization.slug}`) },
      footer: 'transactional'
    };
  }
};

const doubleCheckPayload = z.object({
  targetType: z.enum(['IDEA_APPROVAL', 'ESCROW_PAYOUT']),
  /** Título de la idea o de la iniciativa cuyos fondos se liberan, tal como estaba al pedir la firma. */
  targetTitle: z.string().min(1).max(200),
  token: z.string().min(20).max(128),
  otp: z.string().regex(/^\d{6}$/),
  expiresAt: z.iso.datetime()
});

export const doubleCheckPending: TemplateDefinition<z.infer<typeof doubleCheckPayload>> = {
  schema: doubleCheckPayload,
  // El enlace y el código son de un solo uso: se borran del mensaje en cuanto se envía o se cancela.
  secretFields: ['token', 'otp'],
  needs: 'organization',
  build(payload, context) {
    const { t } = context;
    const organization = requireOrganization(context, 'doubleCheck.pending');
    const what = t(payload.targetType === 'IDEA_APPROVAL' ? 'doubleCheck.ideaApproval' : 'doubleCheck.payout', { title: payload.targetTitle });
    return {
      subject: t('doubleCheck.subject', { organization: organization.name }),
      preheader: t('doubleCheck.preheader'),
      title: t('doubleCheck.title'),
      paragraphs: [t('doubleCheck.body', { expires: context.formatDateTime(payload.expiresAt) })],
      facts: [{ label: t('doubleCheck.what'), value: what }],
      highlight: { label: t('doubleCheck.codeLabel'), value: payload.otp },
      // El token va en el fragmento (#): el navegador no lo envía al servidor, así que no queda en registros ni en `Referer`.
      button: { label: t('doubleCheck.cta'), url: context.url(`/panel/${organization.slug}/firmar#t=${payload.token}`) },
      footnote: t('doubleCheck.footnote'),
      footer: 'organization'
    };
  }
};

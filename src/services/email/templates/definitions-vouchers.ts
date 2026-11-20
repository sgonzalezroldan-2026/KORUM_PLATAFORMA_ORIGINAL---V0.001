import { z } from 'zod';
import { buildPassQrPayload, signPassView } from '@/core/ticketing/qr-signature';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';
import { buildQrAttachment } from './ticket-assets';

/**
 * Emails de los vales (Sprint 5.14b): el pase con el QR y el saldo (`voucher.pass`) y el recibo de la aportación «sin producto» (`voucher.noProductReceipt`, decisión
 * 64). Los textos están en `messages/*.json` (espacio `email.voucher`); aquí solo se decide qué datos van en cada uno. El QR se compone al enviar a partir del
 * identificador del pase: el mensaje de la bandeja nunca guarda el QR firmado.
 */

const centsSchema = z.number().int().nonnegative();

function requireBoth(context: TemplateContext, template: string) {
  if (!context.initiative || !context.organization) throw new Error(`La plantilla ${template} necesita una iniciativa y su entidad.`);
  return { initiative: context.initiative, organization: context.organization };
}

const passPayload = z.object({
  passUuid: z.uuid(),
  serialCode: z.string().min(1).max(40),
  initiativeId: z.number().int().positive(),
  quantity: z.number().int().positive()
});

export const voucherPass: TemplateDefinition<z.infer<typeof passPayload>> = {
  schema: passPayload,
  needs: 'initiative',
  async build(payload, context) {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.pass');
    if (!context.qrSecret) throw new Error('El pase de vales necesita QR_HMAC_SECRET para componer su código QR.');
    const facts = [
      { label: t('voucher.serial'), value: payload.serialCode },
      { label: t('voucher.quantity'), value: t('voucher.quantityValue', { count: payload.quantity }) }
    ];
    // La validez se lee al enviar: es la fecha que fijó la entidad al publicar la venta.
    if (initiative.voucherValidUntil) facts.push({ label: t('voucher.validUntil'), value: context.formatDate(initiative.voucherValidUntil) });
    facts.push({ label: t('voucher.holder'), value: organization.legalName });
    // Enlace de acceso directo al pase: el identificador y una firma propia de «ver», distinta de la del QR que se lee en el puesto.
    const accessUrl = context.url(`/${organization.slug}/entrada/${payload.passUuid}?sig=${signPassView(context.qrSecret, payload.passUuid)}`);
    return {
      subject: t('voucher.subject', { initiative: initiative.title }),
      preheader: t('voucher.preheader'),
      title: t('voucher.title'),
      paragraphs: [t('voucher.body', { count: payload.quantity, organization: organization.name }), t('voucher.refund')],
      facts,
      button: { label: t('voucher.cta'), url: accessUrl },
      footnote: t('voucher.footnote'),
      footer: 'transactional',
      attachments: [await buildQrAttachment(buildPassQrPayload(context.qrSecret, payload.passUuid), `${payload.serialCode}.png`)]
    };
  }
};

const noProductPayload = z.object({
  initiativeId: z.number().int().positive(),
  /** A cuántos vales equivale la aportación (decisión 64: se mide en vales). */
  equivalentVouchers: z.number().int().positive(),
  /** Lo que llega a la venta de la entidad. */
  amountCents: centsSchema,
  /** Gastos de gestión digital (en `INC`, dentro del importe). */
  feeCents: centsSchema,
  guaranteeCents: centsSchema,
  totalCents: centsSchema,
  reference: z.string().min(1).max(64)
});

export const voucherNoProductReceipt: TemplateDefinition<z.infer<typeof noProductPayload>> = {
  schema: noProductPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.noProductReceipt');
    const facts = [
      { label: t('voucher.noProduct.equivalent'), value: t('voucher.quantityValue', { count: payload.equivalentVouchers }) },
      { label: t('voucher.noProduct.amount'), value: context.formatMoney(payload.amountCents) },
      { label: t('voucher.noProduct.fee'), value: context.formatMoney(payload.feeCents) }
    ];
    if (payload.guaranteeCents > 0) facts.push({ label: t('receipt.voluntary'), value: context.formatMoney(payload.guaranteeCents) });
    facts.push({ label: t('receipt.total'), value: context.formatMoney(payload.totalCents) }, { label: t('receipt.holder'), value: organization.legalName }, { label: t('receipt.reference'), value: payload.reference });
    return {
      subject: t('voucher.noProduct.subject', { initiative: initiative.title }),
      preheader: t('voucher.noProduct.preheader'),
      title: t('voucher.noProduct.title'),
      paragraphs: [t('voucher.noProduct.body', { count: payload.equivalentVouchers, initiative: initiative.title, organization: organization.name }), t('voucher.noProduct.conditions')],
      facts,
      button: { label: t('receipt.cta'), url: context.url(`/${organization.slug}/iniciativas/${initiative.id}`) },
      footer: 'transactional'
    };
  }
};

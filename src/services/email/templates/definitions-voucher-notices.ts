import { z } from 'zod';
import { signPassView } from '@/core/ticketing/qr-signature';
import type { EmailContent, TemplateContext, TemplateDefinition } from './email-content';

/**
 * Avisos de las ventas de vales después de publicarse (Sprint 5.14c). Los textos están en `messages/*.json` (espacio `email.voucher`).
 *
 * A quienes firman por la entidad (pie `organization`):
 * - `voucher.saleClosed`: la venta llegó a su cierre. Con algo vendido, se liquidará por lo vendido cuando pasen los 14 días de devolución; sin nada, se cerró sin
 *   dinero que mover.
 * - `voucher.changed`: una persona firmante la canceló o cambió sus fechas. La otra se entera al momento.
 *
 * A quien tiene vales sin gastar (por lotes, una vez por persona; pie `transactional`):
 * - `voucher.cancelledBuyer`: la entidad canceló la venta (decisiones 49 y 69). Antes de liquidar, la plataforma le devuelve sola lo no gastado (le llega además
 *   «Devolución realizada» por cada devolución); ya liquidada, el dinero está en la entidad y se lo pide a ella desde su página de ayuda.
 * - `voucher.validityChanged`: la entidad cambió hasta cuándo valen. Si la acortó, puede recuperar lo no gastado desde sus vales hasta el final del plazo.
 * - `voucher.expiryReminder`: caducan en 7 días o menos.
 *
 * Los dos últimos van por compra y llevan el enlace a esos vales, firmado al enviar (el mensaje solo guarda el identificador del pase).
 *
 * Sin importes de nadie más ni nombres: el email puede reenviarse. Las fechas de validez salen del mensaje (la que se avisó), no de la venta al enviar.
 */

function requireBoth(context: TemplateContext, template: string) {
  if (!context.initiative || !context.organization) throw new Error(`La plantilla ${template} necesita una iniciativa y su entidad.`);
  return { initiative: context.initiative, organization: context.organization };
}

const counts = z.number().int().min(0);

const saleClosedPayload = z.object({ initiativeId: z.number().int().positive(), walletEscrowId: z.string().max(40).nullish(), outcome: z.enum(['SETTLE', 'CLOSE_EMPTY']), vouchersSold: counts, raisedCents: counts });
export const voucherSaleClosed: TemplateDefinition<z.infer<typeof saleClosedPayload>> = {
  schema: saleClosedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.saleClosed');
    const settle = payload.outcome === 'SETTLE';
    return {
      subject: t(settle ? 'voucher.saleClosed.settleSubject' : 'voucher.saleClosed.emptySubject', { initiative: initiative.title }),
      preheader: t(settle ? 'voucher.saleClosed.settlePreheader' : 'voucher.saleClosed.emptyPreheader'),
      title: t(settle ? 'voucher.saleClosed.settleTitle' : 'voucher.saleClosed.emptyTitle'),
      paragraphs: settle
        ? [t('voucher.saleClosed.settleBody', { initiative: initiative.title, count: payload.vouchersSold }), t('voucher.saleClosed.settleNext')]
        : [t('voucher.saleClosed.emptyBody', { initiative: initiative.title })],
      facts: settle ? [{ label: t('voucher.saleClosed.raised'), value: context.formatMoney(payload.raisedCents) }] : [],
      button: settle ? { label: t('voucher.saleClosed.settleCta'), url: context.url(`/panel/${organization.slug}/liquidaciones`) } : { label: t('voucher.saleClosed.emptyCta'), url: context.url(`/panel/${organization.slug}`) },
      footer: 'organization'
    };
  }
};

const changedPayload = z.object({
  initiativeId: z.number().int().positive(),
  change: z.enum(['CANCELLED', 'DATES']),
  settled: z.boolean().optional(),
  vouchersSold: counts.optional(),
  closesAt: z.iso.datetime().optional(),
  validUntil: z.iso.datetime().optional(),
  validity: z.enum(['EXTENDED', 'SHORTENED']).optional()
});
export const voucherChanged: TemplateDefinition<z.infer<typeof changedPayload>> = {
  schema: changedPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.changed');
    const cancelled = payload.change === 'CANCELLED';
    const paragraphs = cancelled
      ? [t(payload.settled ? 'voucher.changed.cancelledSettledBody' : 'voucher.changed.cancelledBody', { initiative: initiative.title, count: payload.vouchersSold ?? 0 })]
      : [t('voucher.changed.datesBody', { initiative: initiative.title, close: payload.closesAt ? context.formatDate(payload.closesAt) : '', valid: payload.validUntil ? context.formatDate(payload.validUntil) : '' })];
    if (!cancelled && payload.validity) paragraphs.push(t('voucher.changed.datesNotice'));
    return {
      subject: t(cancelled ? 'voucher.changed.cancelledSubject' : 'voucher.changed.datesSubject', { initiative: initiative.title }),
      preheader: t(cancelled ? 'voucher.changed.cancelledPreheader' : 'voucher.changed.datesPreheader'),
      title: t(cancelled ? 'voucher.changed.cancelledTitle' : 'voucher.changed.datesTitle'),
      paragraphs,
      facts: [],
      button: { label: t('voucher.changed.cta'), url: context.url(`/panel/${organization.slug}/taquilla`) },
      footer: 'organization'
    };
  }
};

const buyerPayload = z.object({
  initiativeId: z.number().int().positive(),
  walletEscrowId: z.string().max(40).nullish(),
  validUntil: z.iso.datetime().optional(),
  /** Pase de la compra (avisos por compra): el botón lleva a esos vales. */
  passUuid: z.uuid().optional(),
  /** Validez acortada: hasta cuándo se puede recuperar lo no gastado. */
  refundUntil: z.iso.datetime().optional(),
  /** Cancelación: si la venta ya estaba liquidada (el dinero está en la entidad). */
  settled: z.boolean().optional()
});
type BuyerPayload = z.infer<typeof buyerPayload>;

/** Botón a los vales de la compra (con su firma de «ver») o, sin pase, a la venta. */
function vouchersButton(payload: BuyerPayload, context: TemplateContext, slug: string, initiativeId: number, label: string) {
  if (payload.passUuid && context.qrSecret) return { label, url: context.url(`/${slug}/entrada/${payload.passUuid}?sig=${signPassView(context.qrSecret, payload.passUuid)}`) };
  return { label, url: context.url(`/${slug}/iniciativas/${initiativeId}`) };
}

export const voucherCancelledBuyer: TemplateDefinition<BuyerPayload> = {
  schema: buyerPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.cancelledBuyer');
    // Sin la marca (mensajes de antes del sprint no hay): se trata como liquidada, lo prudente.
    const settled = payload.settled !== false;
    return {
      subject: t('voucher.cancelledBuyer.subject', { initiative: initiative.title, organization: organization.name }),
      preheader: t(settled ? 'voucher.cancelledBuyer.preheader' : 'voucher.cancelledBuyer.preheaderRefund'),
      title: t('voucher.cancelledBuyer.title'),
      paragraphs: [t('voucher.cancelledBuyer.body', { initiative: initiative.title, organization: organization.name }), t(settled ? 'voucher.cancelledBuyer.how' : 'voucher.cancelledBuyer.refund', { organization: organization.name })],
      facts: [{ label: t('voucher.holder'), value: organization.legalName }],
      button: settled ? { label: t('voucher.cancelledBuyer.cta'), url: context.url(`/${organization.slug}/ayuda`) } : { label: t('voucher.cancelledBuyer.ctaRefund'), url: context.url(`/${organization.slug}/iniciativas/${initiative.id}`) },
      footer: 'transactional'
    };
  }
};

export const voucherValidityChanged: TemplateDefinition<BuyerPayload> = {
  schema: buyerPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.validityChanged');
    const validUntil = payload.validUntil ?? initiative.voucherValidUntil?.toISOString();
    const paragraphs = [t('voucher.validityChanged.body', { initiative: initiative.title, organization: organization.name, date: validUntil ? context.formatDate(validUntil) : '' })];
    if (payload.refundUntil) paragraphs.push(t('voucher.validityChanged.refund', { until: context.formatDateTime(payload.refundUntil) }));
    paragraphs.push(t('voucher.validityChanged.where'));
    return {
      subject: t('voucher.validityChanged.subject', { initiative: initiative.title }),
      preheader: t('voucher.validityChanged.preheader'),
      title: t('voucher.validityChanged.title'),
      paragraphs,
      facts: validUntil ? [{ label: t('voucher.validUntil'), value: context.formatDate(validUntil) }] : [],
      button: vouchersButton(payload, context, organization.slug, initiative.id, t('voucher.validityChanged.cta')),
      footer: 'transactional'
    };
  }
};

export const voucherExpiryReminder: TemplateDefinition<BuyerPayload> = {
  schema: buyerPayload,
  needs: 'initiative',
  build(payload, context): EmailContent {
    const { t } = context;
    const { initiative, organization } = requireBoth(context, 'voucher.expiryReminder');
    const validUntil = payload.validUntil ?? initiative.voucherValidUntil?.toISOString();
    return {
      subject: t('voucher.expiryReminder.subject', { initiative: initiative.title }),
      preheader: t('voucher.expiryReminder.preheader'),
      title: t('voucher.expiryReminder.title'),
      paragraphs: [t('voucher.expiryReminder.body', { initiative: initiative.title, organization: organization.name, date: validUntil ? context.formatDate(validUntil) : '' }), t('voucher.expiryReminder.where')],
      facts: validUntil ? [{ label: t('voucher.validUntil'), value: context.formatDate(validUntil) }] : [],
      button: vouchersButton(payload, context, organization.slug, initiative.id, t('voucher.expiryReminder.cta')),
      footer: 'transactional'
    };
  }
};

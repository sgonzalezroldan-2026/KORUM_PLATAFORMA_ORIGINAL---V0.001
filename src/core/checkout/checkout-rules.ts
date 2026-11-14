import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';
import { CHECKOUT_METHODS, DONATION_MAX_CENTS, DONATION_MIN_CENTS, GUARANTEE_MAX_CENTS, MAX_TICKETS_PER_ORDER } from './checkout-limits';

/**
 * Reglas del checkout de familias (Sprint 3.4, QA-F04 · QA-F07 · QA-F10). Funciones puras: lo que el navegador envía se valida aquí y todo
 * importe que no elige la persona (precio de la entrada, gastos de gestión digital, aportación sugerida) sale siempre de la base de datos.
 * Los límites compartidos con el navegador están en `checkout-limits.ts`.
 */

/** Un pago sin confirmar durante más tiempo se da por no completado en la pantalla de resultado (el webhook puede llegar después). */
export const PENDING_CONFIRMATION_MS = 30 * 60_000;

const methodSchema = z.enum(CHECKOUT_METHODS);
const groupSchema = z.string().trim().min(1).max(80).nullable();
const emailSchema = z.email().max(254);
const centsSchema = z.number().int().nonnegative();

const fiscalSchema = z.object({
  taxId: z.string().trim().min(5).max(20),
  /** Apellidos y nombre, en el orden del Modelo 182. */
  fullName: z.string().trim().min(3).max(120),
  provinceCode: z.string().regex(/^\d{2}$/)
});

const common = {
  orgSlug: z.string().min(1).max(80),
  initiativeId: z.number().int().positive(),
  locale: z.enum(['es', 'ca', 'en']),
  method: methodSchema,
  groupName: groupSchema,
  /** Solo sin sesión: con sesión se usa el email de la cuenta, nunca el que envía el navegador. */
  email: emailSchema.nullable()
};

export const checkoutInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('DONATION'),
    ...common,
    amountCents: centsSchema.min(DONATION_MIN_CENTS).max(DONATION_MAX_CENTS),
    guaranteeCents: centsSchema.max(GUARANTEE_MAX_CENTS),
    fiscal: fiscalSchema.nullable()
  }),
  z.object({
    kind: z.literal('TICKET'),
    ...common,
    quantity: z.number().int().min(1).max(MAX_TICKETS_PER_ORDER)
  })
]);

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export type CheckoutFiscal = z.infer<typeof fiscalSchema>;

/** El certificado fiscal (y por tanto pedir el NIF) solo existe si la entidad declara la Ley 49/2002 **y** está acreditada en el KYB. */
export function canIssueTaxCertificate(organization: { ley49: boolean; ley49VerifiedAt: Date | null }): boolean {
  return organization.ley49 && organization.ley49VerifiedAt !== null;
}

/**
 * Importes del selector manual de la aportación voluntaria: los de la consola más el sugerido de la entidad, de menor a mayor, sin repetir,
 * siempre con el `0` y nunca por encima del tope.
 */
export function guaranteeChoices(presetsCents: readonly number[], suggestedCents: number): number[] {
  const values = new Set<number>([0, ...presetsCents, suggestedCents]);
  return [...values].filter((cents) => Number.isSafeInteger(cents) && cents >= 0 && cents <= GUARANTEE_MAX_CENTS).sort((a, b) => a - b);
}

/** El grupo debe ser uno de los de la entidad (si el reto está activo); cualquier otro texto se descarta y la aportación va sin grupo. */
export function acceptedGroup(groupName: string | null, rewardEnabled: boolean, groupNames: readonly string[]): string | null {
  if (!rewardEnabled || groupName === null) return null;
  return groupNames.includes(groupName) ? groupName : null;
}

/** Ejercicio fiscal de una donación: el año natural en la hora de España (una donación del 1 de enero a las 00:30 ya es del año nuevo). */
export function spanishFiscalYear(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric' }).format(date));
}

/** Pedido de una donación: aleatorio, sin email ni NIF (QA del Sprint 2.1). Las entradas usan `KT` (`reserveTickets`) y los patrocinios `KS`. */
export function newDonationOrder(): string {
  return `KD${randomBytes(8).toString('hex').toUpperCase()}`;
}

/** `KD` donación, `KT` entrada, `KS` patrocinio, `KR` su renovación anual y `KH` primer pago de Mi Hucha (que también pasa por la página de pago). */
const ORDER_PATTERN = /^K[DSTHR][0-9A-F]{16}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export const isCheckoutOrder = (value: string): boolean => ORDER_PATTERN.test(value);

/**
 * Firma del enlace de resultado (`/aportar/resultado?pedido=&sig=`): solo quien inició el pago lo recibe, y es lo que le deja ver su recibo y,
 * en taquilla, el enlace a su pase. Otro dominio distinto del simulador: una firma no sirve para la otra.
 */
export const signCheckoutResult = (secret: string, order: string): string => dataHmac(secret, 'checkout-result:v1', order);
export const signPaymentSimulator = (secret: string, order: string): string => dataHmac(secret, 'checkout-simulator:v1', order);

function verify(sign: (secret: string, order: string) => string, secret: string, order: string, signature: string): boolean {
  return isCheckoutOrder(order) && SIGNATURE_PATTERN.test(signature) && safeEqual(sign(secret, order), signature);
}

export const verifyCheckoutResult = (secret: string, order: string, signature: string) => verify(signCheckoutResult, secret, order, signature);
export const verifyPaymentSimulator = (secret: string, order: string, signature: string) => verify(signPaymentSimulator, secret, order, signature);

/**
 * Firma del cartel del escaparate de un comercio (Sprint 4.2b): dominio propio, que **solo** abre el cartel. El cartel es lo que se comparte (WhatsApp,
 * la imprenta): con la firma del pedido abriría también el justificante y la factura, que llevan el CIF o NIF del comercio (auditoría del 4.2b).
 */
export const signSponsorPoster = (secret: string, order: string): string => dataHmac(secret, 'sponsor-poster:v1', order);
export const verifySponsorPoster = (secret: string, order: string, signature: string) => verify(signSponsorPoster, secret, order, signature);

/**
 * La página de pago de Paycomet a la que se envía a la familia. Solo `https` y solo dominios de Paycomet (QA del Sprint 2.1): una respuesta
 * manipulada no puede llevar a nadie a una página falsa que le pida la tarjeta. **A confirmar en el sandbox:** que Bizum no redirige a otro dominio.
 */
export function isTrustedChallengeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && url.username === '' && url.password === '' && (host === 'paycomet.com' || host.endsWith('.paycomet.com'));
  } catch {
    return false;
  }
}

/** Estado que ve la familia al volver de pagar. */
export type CheckoutOutcome = 'CONFIRMED' | 'PENDING' | 'UNCONFIRMED' | 'FAILED' | 'RETURNED';

/** Traduce el estado de la aportación a lo que se le cuenta a la familia. Un pago sin confirmar mucho tiempo no se presenta como «en curso». */
export function checkoutOutcome(status: string, createdAt: Date, now: Date): CheckoutOutcome {
  if (status === 'COMPLETED') return 'CONFIRMED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'PENDING') return now.getTime() - createdAt.getTime() > PENDING_CONFIRMATION_MS ? 'UNCONFIRMED' : 'PENDING';
  // Cobro confirmado con la campaña ya cerrada, reembolso o contracargo: el dinero vuelve (o ha vuelto) a quien pagó.
  return 'RETURNED';
}

/** Estados en que la ficha de una iniciativa es pública (los mismos que `public.repository.ts`): fuera de ellos su URL responde `404`. */
const PUBLIC_INITIATIVE_STATUSES: ReadonlySet<string> = new Set(['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']);
/** Venció sin llegar a la meta y aún se decide (votar seguir con lo recaudado o devolver). */
const DECIDING_STATUSES: ReadonlySet<string> = new Set(['EXPIRED', 'RESIZE_VOTING']);
/** No llegó a la meta (o se canceló) y se devuelve el 100 % a cada persona. */
const REFUNDING_STATUSES: ReadonlySet<string> = new Set(['REFUNDING', 'REFUNDED', 'CANCELLED']);

/** Cómo terminó la campaña, para lo que se le cuenta a quien vuelve de pagar: sigue (`NONE`), se decide (`DECIDING`) o se devuelve (`REFUNDING`). */
export type CampaignEnding = 'NONE' | 'DECIDING' | 'REFUNDING';

/**
 * Qué puede ofrecer la vuelta del pago según el estado **actual** de la campaña (Sprint 5.5, heredado del 4.2f). Quien paga en los minutos en que
 * la campaña se cierra no debe acabar en un `404`: si la ficha ya no es pública, se le lleva a la portada de la entidad y no se le invita a
 * compartirla; solo se ofrece «Probar otra vez» mientras la campaña siga recaudando; y `ended` dice si terminó sin llegar a la meta.
 */
export function resultNavigation(initiativeStatus: string): { showInitiative: boolean; canRetry: boolean; ended: CampaignEnding } {
  const ended: CampaignEnding = DECIDING_STATUSES.has(initiativeStatus) ? 'DECIDING' : REFUNDING_STATUSES.has(initiativeStatus) ? 'REFUNDING' : 'NONE';
  return { showInitiative: PUBLIC_INITIATIVE_STATUSES.has(initiativeStatus), canRetry: initiativeStatus === 'FUNDRAISING', ended };
}

/**
 * Qué se le dice a una familia cuyo pago **ya entró** (`CONFIRMED`) o se le devuelve (`RETURNED`), según cómo está ahora la campaña (auditoría de
 * seguridad del 5.5a, H2): en una campaña que se devuelve nunca «tu aportación ya suma» (las aportaciones siguen `COMPLETED` hasta que les llega su
 * lote de devolución) y el motivo «llegó cuando ya no admitía aportaciones» solo cuando es verdad.
 * - `confirmed`: suma (celebración).
 * - `deciding`: la campaña venció sin la meta y se decide: le escribiremos para votar o para devolverle el 100 %.
 * - `failedCampaign`: no llegó a la meta: se le devuelve el 100 %.
 * - `returnedLate`: llegó con la campaña ya conseguida, cerrada o vencida: se le devuelve entero.
 * - `returnedGeneric`: se le devuelve con la campaña aún abierta (una devolución puntual): sin inventar el motivo.
 * - `chargeback`: su banco anuló el pago (contracargo). El dinero ya volvió por la disputa: no se promete otra devolución ni se da otro motivo
 *   (segunda pasada de la auditoría de seguridad del 5.5a). Va antes que cualquier otra regla.
 */
export type PaidNotice = 'confirmed' | 'deciding' | 'failedCampaign' | 'returnedLate' | 'returnedGeneric' | 'chargeback';

export function paidNotice(outcome: 'CONFIRMED' | 'RETURNED', initiativeStatus: string, contributionStatus: string): PaidNotice {
  if (contributionStatus === 'CHARGEBACK') return 'chargeback';
  const { ended } = resultNavigation(initiativeStatus);
  if (ended === 'REFUNDING') return 'failedCampaign';
  if (outcome === 'CONFIRMED') return ended === 'DECIDING' ? 'deciding' : 'confirmed';
  return initiativeStatus === 'FUNDRAISING' ? 'returnedGeneric' : 'returnedLate';
}

/**
 * Lo que se le dice a un comercio sobre **su dinero** tras pagar (auditoría de seguridad del 5.5a, H1). El dinero de un comercio admitido nunca se
 * le devuelve (Regla 02 §5); solo se devuelve el 100 % si la entidad no lo admite.
 * - `creditPool`: pagó con la campaña ya cerrada y espera la moderación (mismo criterio que `lateCharge` de la moderación).
 * - `moved`: su dinero ya salió de esta campaña (o va a salir, porque ya no es pública) hacia otra campaña o el Fondo de actividades.
 * - `pool`: bolsa Matching 2x de una campaña abierta. `escrow`: suma íntegro a la hucha de la iniciativa.
 * - `notAdmitted`: la entidad no lo admitió (`REJECTED`): se le devuelve el 100 % con su factura rectificativa.
 * - `chargeback`: su banco anuló el pago: ni otra devolución ni rectificativa prometidas.
 * - `returnedGeneric`: se le devuelve por otro motivo (una devolución desde Paycomet, una renovación que ya no procedía), sin inventarlo.
 */
export type SponsorshipNotice = 'creditPool' | 'moved' | 'pool' | 'escrow' | 'notAdmitted' | 'chargeback' | 'returnedGeneric';

export interface SponsorshipFacts {
  status: string;
  renewedFromId: number | null;
  reassignedCents: number;
  isMatchingPool: boolean;
}

export function sponsorshipNotice(outcome: 'CONFIRMED' | 'RETURNED', amountCents: number, sponsor: SponsorshipFacts | null, initiativeStatus: string, contributionStatus: string): SponsorshipNotice {
  if (contributionStatus === 'CHARGEBACK') return 'chargeback';
  if (outcome === 'RETURNED') return sponsor?.status === 'REJECTED' ? 'notAdmitted' : 'returnedGeneric';
  if (!sponsor) return 'escrow';
  if (sponsor.status === 'PENDING' && sponsor.renewedFromId === null && amountCents > 0 && sponsor.reassignedCents >= amountCents) return 'creditPool';
  if (sponsor.reassignedCents > 0 || !resultNavigation(initiativeStatus).showInitiative) return 'moved';
  return sponsor.isMatchingPool ? 'pool' : 'escrow';
}

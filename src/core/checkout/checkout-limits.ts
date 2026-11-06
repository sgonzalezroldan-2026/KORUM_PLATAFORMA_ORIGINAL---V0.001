/**
 * Límites del checkout que necesitan a la vez el servidor (validación) y el navegador (selectores). Sin dependencias: se puede importar
 * desde un componente de cliente sin arrastrar código de servidor.
 */

/** Donación mínima: por debajo, la comisión fija de Paycomet se comería casi todo. */
export const DONATION_MIN_CENTS = 100;
/** Donación máxima en un solo pago (5.000,00 €): una cifra mayor casi siempre es un error al teclear. Por encima se habla con la entidad. */
export const DONATION_MAX_CENTS = 500_000;
/** Tope de la aportación voluntaria a KORUM: evita que un cero de más se cobre sin querer. */
export const GUARANTEE_MAX_CENTS = 5_000;
/** Entradas o papeletas por compra (también lo comprueba `reserveTickets`). */
export const MAX_TICKETS_PER_ORDER = 20;

/**
 * Tarjeta, Apple Pay y Google Pay se pagan en el mismo formulario seguro de Paycomet (`methodId 1`): para quien paga es un solo botón. Bizum
 * va aparte (`methodId 11`). Mi Hucha (`REGULATED_WALLET`) se añade cuando exista el monedero (Sprint 3.7).
 */
export const CHECKOUT_METHODS = ['BIZUM', 'CARD'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];
